import {
	BedrockRuntimeClient,
	type BedrockRuntimeClientConfig,
	BedrockRuntimeServiceException,
	StopReason as BedrockStopReason,
	type Tool as BedrockTool,
	CachePointType,
	CacheTTL,
	type ContentBlock,
	type ContentBlockDeltaEvent,
	type ContentBlockStartEvent,
	type ContentBlockStopEvent,
	ConversationRole,
	ConverseStreamCommand,
	type ConverseStreamCommandInput,
	type ConverseStreamMetadataEvent,
	type ConverseStreamOutput,
	ImageFormat,
	type Message,
	type ReasoningContentBlockDelta,
	type SystemContentBlock,
	type ToolChoice,
	type ToolConfiguration,
	ToolResultStatus,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { BuildMiddleware, DocumentType, MetadataBearer } from "@smithy/types";
import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantContent,
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	Message as PiMessage,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ThinkingLevel,
	Tool,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { createHttpProxyAgentsForTarget } from "../utils/node-http-proxy.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { adjustMaxTokensForThinking, buildBaseOptions, clampReasoning } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

export type BedrockThinkingDisplay = "summarized" | "omitted";
export type BedrockToolSelection = "auto" | "any" | "none" | { type: "tool"; name: string };

type BedrockReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface BedrockOptions extends StreamOptions {
	region?: string;
	profile?: string;
	toolChoice?: BedrockToolSelection;
	/* See https://docs.aws.amazon.com/bedrock/latest/userguide/inference-reasoning.html for supported models. */
	reasoning?: ThinkingLevel;
	/* Custom token budgets per thinking level. Overrides default budgets. */
	thinkingBudgets?: ThinkingBudgets;
	/* Only supported by Claude 4.x models, see https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html#claude-messages-extended-thinking-tool-use-interleaved */
	interleavedThinking?: boolean;
	/**
	 * Controls how Claude's thinking content is returned in responses.
	 * - "summarized": Thinking blocks contain summarized thinking text (default here).
	 * - "omitted": Thinking content is redacted but the signature still travels back
	 *   for multi-turn continuity, reducing time-to-first-text-token.
	 *
	 * Note: Anthropic's API default for Claude Opus 4.7 and Mythos Preview is
	 * "omitted". We default to "summarized" here to keep behavior consistent with
	 * older Claude 4 models. Only applies to Claude models on Bedrock.
	 */
	thinkingDisplay?: BedrockThinkingDisplay;
	/** Key-value pairs attached to the inference request for cost allocation tagging.
	 * Keys: max 64 chars, no `aws:` prefix. Values: max 256 chars. Max 50 pairs.
	 * Tags appear in AWS Cost Explorer split cost allocation data.
	 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html */
	requestMetadata?: Record<string, string>;
	/** Bearer token for Bedrock API key authentication.
	 * When set, bypasses SigV4 signing and sends Authorization: Bearer <token> instead.
	 * Requires `bedrock:CallWithBearerToken` IAM permission on the token's identity.
	 * Set via AWS_BEARER_TOKEN_BEDROCK env var or pass directly.
	 * @see https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrock.html */
	bearerToken?: string;
}

type Block = (TextContent | ThinkingContent | ToolCall) & { index?: number; partialJson?: string };
type CompletedBedrockAssistantMessage = AssistantMessage & { stopReason: "stop" | "length" | "toolUse" };
interface BedrockStreamState {
	blocks: Block[];
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	model: Model<"bedrock-converse-stream">;
}

function configureNodeBedrockRuntime(
	config: BedrockRuntimeClientConfig,
	model: Model<"bedrock-converse-stream">,
	configuredRegion: string | undefined,
	endpointRegion: string | undefined,
	useExplicitEndpoint: boolean,
	hasConfiguredProfile: boolean,
): void {
	if (configuredRegion) config.region = configuredRegion;
	else if (endpointRegion && useExplicitEndpoint) config.region = endpointRegion;
	else if (!hasConfiguredProfile) config.region = "us-east-1";
	if (process.env.AWS_BEDROCK_SKIP_AUTH === "1") {
		config.credentials = { accessKeyId: "dummy-access-key", secretAccessKey: "dummy-secret-key" };
	}
	const proxyAgents = createHttpProxyAgentsForTarget(model.baseUrl);
	if (proxyAgents) config.requestHandler = new NodeHttpHandler(proxyAgents);
	else if (process.env.AWS_BEDROCK_FORCE_HTTP1 === "1") config.requestHandler = new NodeHttpHandler();
}

function createBedrockRuntimeConfig(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): BedrockRuntimeClientConfig {
	const config: BedrockRuntimeClientConfig = { profile: options.profile };
	const configuredRegion = getConfiguredBedrockRegion(options);
	const hasConfiguredProfile = hasConfiguredBedrockProfile();
	const endpointRegion = getStandardBedrockEndpointRegion(model.baseUrl);
	const useExplicitEndpoint = shouldUseExplicitBedrockEndpoint(model.baseUrl, configuredRegion, hasConfiguredProfile);
	if (useExplicitEndpoint) config.endpoint = model.baseUrl;
	if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
		configureNodeBedrockRuntime(
			config,
			model,
			configuredRegion,
			endpointRegion,
			useExplicitEndpoint,
			hasConfiguredProfile,
		);
	} else {
		config.region =
			configuredRegion || (endpointRegion && useExplicitEndpoint ? endpointRegion : undefined) || "us-east-1";
	}
	const bearerToken = options.bearerToken || process.env.AWS_BEARER_TOKEN_BEDROCK || undefined;
	if (bearerToken !== undefined && process.env.AWS_BEDROCK_SKIP_AUTH !== "1") {
		config.token = { token: bearerToken };
		config.authSchemePreference = ["httpBearerAuth"];
	}
	return config;
}

function createBedrockCommandInput(
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options: BedrockOptions,
): ConverseStreamCommandInput {
	const cacheRetention = resolveCacheRetention(options.cacheRetention);
	const inferenceMaxTokens = options.maxTokens ?? (isAnthropicClaudeModel(model) ? model.maxTokens : undefined);
	return {
		modelId: model.id,
		messages: convertMessages(context, model, cacheRetention),
		system: buildSystemPrompt(context.systemPrompt, model, cacheRetention),
		inferenceConfig: {
			...(inferenceMaxTokens !== undefined && { maxTokens: inferenceMaxTokens }),
			...(options.temperature !== undefined && { temperature: options.temperature }),
		},
		toolConfig: convertToolConfig(context.tools, options.toolChoice),
		additionalModelRequestFields: buildAdditionalModelRequestFields(model, options),
		...(options.requestMetadata !== undefined && { requestMetadata: options.requestMetadata }),
	};
}

function handleBedrockStreamEvent(item: ConverseStreamOutput, state: BedrockStreamState): void {
	if (item.messageStart) {
		if (item.messageStart.role !== ConversationRole.ASSISTANT) {
			throw new Error("Unexpected assistant message start but got user message start instead");
		}
		state.stream.push({ type: "start", partial: state.output });
		return;
	}
	if (item.contentBlockStart) {
		handleContentBlockStart(item.contentBlockStart, state.blocks, state.output, state.stream);
		return;
	}
	if (item.contentBlockDelta) {
		handleContentBlockDelta(item.contentBlockDelta, state);
		return;
	}
	if (item.contentBlockStop) {
		handleContentBlockStop(item.contentBlockStop, state.blocks, state.output, state.stream);
		return;
	}
	if (item.messageStop) {
		state.output.stopReason = mapStopReason(item.messageStop.stopReason);
		return;
	}
	if (item.metadata) {
		handleMetadata(item.metadata, state.model, state.output);
		return;
	}
	const exception =
		item.internalServerException ??
		item.modelStreamErrorException ??
		item.validationException ??
		item.throttlingException ??
		item.serviceUnavailableException;
	if (exception) throw exception;
}

function validateBedrockStreamCompletion(
	output: AssistantMessage,
	signal?: AbortSignal,
): asserts output is CompletedBedrockAssistantMessage {
	if (signal?.aborted) throw new Error("Request was aborted");
	if (output.stopReason === "pending") throw new Error("Bedrock stream ended without a stop reason");
	if (output.stopReason === "error" || output.stopReason === "aborted") throw new Error("An unknown error occurred");
}

async function executeBedrockStream(
	context: Context,
	options: BedrockOptions,
	state: BedrockStreamState,
): Promise<void> {
	const client = new BedrockRuntimeClient(createBedrockRuntimeConfig(state.model, options));
	const customHeaders = providerHeadersToRecord(options.headers);
	if (customHeaders) addCustomHeadersMiddleware(client, customHeaders);
	let commandInput = createBedrockCommandInput(state.model, context, options);
	const nextCommandInput = await options.onPayload?.(commandInput, state.model);
	if (nextCommandInput !== undefined) commandInput = nextCommandInput as ConverseStreamCommandInput;
	const response = await client.send(new ConverseStreamCommand(commandInput), { abortSignal: options.signal });
	if (response.$metadata.httpStatusCode !== undefined) {
		const responseHeaders: Record<string, string> = {};
		if (response.$metadata.requestId) responseHeaders["x-amzn-requestid"] = response.$metadata.requestId;
		await options.onResponse?.({ status: response.$metadata.httpStatusCode, headers: responseHeaders }, state.model);
	}
	for await (const item of response.stream!) handleBedrockStreamEvent(item, state);
	validateBedrockStreamCompletion(state.output, options.signal);
	state.stream.push({ type: "done", reason: state.output.stopReason, message: state.output });
	state.stream.end();
}

function handleBedrockStreamFailure(error: unknown, options: BedrockOptions, state: BedrockStreamState): void {
	for (const block of state.output.content) {
		delete (block as Block).index;
		delete (block as Block).partialJson;
	}
	state.output.stopReason = options.signal?.aborted ? "aborted" : "error";
	state.output.errorMessage = formatBedrockError(error);
	state.stream.push({ type: "error", reason: state.output.stopReason, error: state.output });
	state.stream.end();
}

export const streamBedrock: StreamFunction<"bedrock-converse-stream", BedrockOptions> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options: BedrockOptions = {},
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "bedrock-converse-stream" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const state: BedrockStreamState = {
			blocks: output.content as Block[],
			output,
			stream,
			model,
		};
		try {
			await executeBedrockStream(context, options, state);
		} catch (error) {
			handleBedrockStreamFailure(error, options, state);
		}
	})();

	return stream;
};

/**
 * Human-readable prefixes for Bedrock SDK exception names.
 * The downstream retry logic in agent-session matches patterns like
 * `server.?error` and `service.?unavailable`, so we preserve the legacy
 * prefix format rather than using the raw SDK exception name.
 */
const BEDROCK_ERROR_PREFIXES: Record<string, string> = {
	InternalServerException: "Internal server error",
	ModelStreamErrorException: "Model stream error",
	ValidationException: "Validation error",
	ThrottlingException: "Throttling error",
	ServiceUnavailableException: "Service unavailable",
};

/**
 * Format a Bedrock error with a human-readable prefix.
 * AWS SDK exceptions (both from `client.send()` and from stream event items)
 * extend BedrockRuntimeServiceException. We map the `.name` to a stable
 * human-readable prefix so downstream consumers (retry logic, context-overflow
 * detection) can distinguish error categories via simple string matching.
 */
function formatBedrockError(error: unknown): string {
	const message = error instanceof Error ? error.message : JSON.stringify(error);
	if (error instanceof BedrockRuntimeServiceException) {
		const prefix = BEDROCK_ERROR_PREFIXES[error.name] ?? error.name;
		return `${prefix}: ${message}`;
	}
	return message;
}

/**
 * Header keys that must never be overwritten by caller-supplied headers.
 * `host` and `x-amz-*` participate in the SigV4 canonical request; `authorization`
 * is owned by SigV4 or the bearer-token path (config.token + authSchemePreference).
 * Compared case-insensitively (caller key is lower-cased before lookup).
 */
const RESERVED_HEADER_EXACT = new Set(["authorization", "host"]);

function isReservedHeader(key: string): boolean {
	const lower = key.toLowerCase();
	return lower.startsWith("x-amz-") || RESERVED_HEADER_EXACT.has(lower);
}

/**
 * Attach caller-supplied headers to the outgoing Bedrock request via a Smithy
 * `build`-step middleware. The `build` step runs after request serialisation but
 * before SigV4 signing, so injected headers are covered by the signature. Reserved
 * SigV4 / auth headers (`x-amz-*`, `authorization`, `host`) are silently skipped;
 * all other caller headers override any existing same-named header on the request.
 */
function addCustomHeadersMiddleware(client: BedrockRuntimeClient, headers: Record<string, string>): void {
	const middleware: BuildMiddleware<object, MetadataBearer> = (next) => async (args) => {
		const request = args.request;
		if (request && typeof request === "object" && "headers" in request) {
			const requestHeaders = (request as { headers: Record<string, string> }).headers;
			for (const [key, value] of Object.entries(headers)) {
				if (!isReservedHeader(key)) {
					requestHeaders[key] = value;
				}
			}
		}
		return next(args);
	};
	client.middlewareStack.add(middleware, { step: "build", name: "pi-ai-custom-headers", priority: "low" });
}

export const streamSimpleBedrock: StreamFunction<"bedrock-converse-stream", SimpleStreamOptions> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = buildBaseOptions(model, context, options, undefined);
	if (!options?.reasoning) {
		return streamBedrock(model, context, { ...base, reasoning: undefined } satisfies BedrockOptions);
	}

	if (isAnthropicClaudeModel(model)) {
		if (supportsAdaptiveThinking(model.id, model.name)) {
			return streamBedrock(model, context, {
				...base,
				reasoning: options.reasoning,
				thinkingBudgets: options.thinkingBudgets,
			} satisfies BedrockOptions);
		}

		// Undefined means the caller did not request an output cap; let the helper use the model cap.
		// Do not coerce to 0 here, or the thinking budget would become the entire maxTokens value.
		const adjusted = adjustMaxTokensForThinking(
			base.maxTokens,
			model.maxTokens,
			options.reasoning,
			options.thinkingBudgets,
		);

		return streamBedrock(model, context, {
			...base,
			maxTokens: adjusted.maxTokens,
			reasoning: options.reasoning,
			thinkingBudgets: {
				...(options.thinkingBudgets || {}),
				[clampReasoning(options.reasoning)!]: adjusted.thinkingBudget,
			},
		} satisfies BedrockOptions);
	}

	return streamBedrock(model, context, {
		...base,
		reasoning: options.reasoning,
		thinkingBudgets: options.thinkingBudgets,
	} satisfies BedrockOptions);
};

function handleContentBlockStart(
	event: ContentBlockStartEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = event.contentBlockIndex!;
	const start = event.start;

	if (start?.toolUse) {
		const block: Block = {
			type: "toolCall",
			id: start.toolUse.toolUseId || "",
			name: start.toolUse.name || "",
			arguments: {},
			partialJson: "",
			index,
		};
		output.content.push(block);
		stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
	}
}

function handleTextContentDelta(
	text: string,
	contentBlockIndex: number,
	block: Block | undefined,
	index: number,
	state: BedrockStreamState,
): void {
	let textBlock = block;
	let textIndex = index;
	if (!textBlock) {
		const newBlock: Block = { type: "text", text: "", index: contentBlockIndex };
		state.output.content.push(newBlock);
		textIndex = state.blocks.length - 1;
		textBlock = state.blocks[textIndex];
		state.stream.push({ type: "text_start", contentIndex: textIndex, partial: state.output });
	}
	if (textBlock.type !== "text") return;
	textBlock.text += text;
	state.stream.push({ type: "text_delta", contentIndex: textIndex, delta: text, partial: state.output });
}

function handleToolUseContentDelta(input: string, block: Block, index: number, state: BedrockStreamState): void {
	if (block.type !== "toolCall") return;
	block.partialJson = (block.partialJson || "") + input;
	block.arguments = parseStreamingJson(block.partialJson);
	state.stream.push({ type: "toolcall_delta", contentIndex: index, delta: input, partial: state.output });
}

function handleReasoningContentDelta(
	reasoningContent: ReasoningContentBlockDelta,
	contentBlockIndex: number,
	block: Block | undefined,
	index: number,
	state: BedrockStreamState,
): void {
	let thinkingBlock = block;
	let thinkingIndex = index;
	if (!thinkingBlock) {
		const newBlock: Block = { type: "thinking", thinking: "", thinkingSignature: "", index: contentBlockIndex };
		state.output.content.push(newBlock);
		thinkingIndex = state.blocks.length - 1;
		thinkingBlock = state.blocks[thinkingIndex];
		state.stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: state.output });
	}
	if (thinkingBlock?.type !== "thinking") return;
	if (reasoningContent.text) {
		thinkingBlock.thinking += reasoningContent.text;
		state.stream.push({
			type: "thinking_delta",
			contentIndex: thinkingIndex,
			delta: reasoningContent.text,
			partial: state.output,
		});
	}
	if (reasoningContent.signature) {
		thinkingBlock.thinkingSignature = (thinkingBlock.thinkingSignature || "") + reasoningContent.signature;
	}
}

function handleContentBlockDelta(event: ContentBlockDeltaEvent, state: BedrockStreamState): void {
	const contentBlockIndex = event.contentBlockIndex!;
	const delta = event.delta;
	if (!delta) return;
	const index = state.blocks.findIndex((block) => block.index === contentBlockIndex);
	const block = state.blocks[index];

	if (delta.text !== undefined) {
		handleTextContentDelta(delta.text, contentBlockIndex, block, index, state);
		return;
	}
	if (delta.toolUse && block?.type === "toolCall") {
		handleToolUseContentDelta(delta.toolUse.input || "", block, index, state);
		return;
	}
	if (delta.reasoningContent) {
		handleReasoningContentDelta(delta.reasoningContent, contentBlockIndex, block, index, state);
	}
}

function handleMetadata(
	event: ConverseStreamMetadataEvent,
	model: Model<"bedrock-converse-stream">,
	output: AssistantMessage,
): void {
	if (event.usage) {
		output.usage.input = event.usage.inputTokens || 0;
		output.usage.output = event.usage.outputTokens || 0;
		output.usage.cacheRead = event.usage.cacheReadInputTokens || 0;
		output.usage.cacheWrite = event.usage.cacheWriteInputTokens || 0;
		output.usage.totalTokens = event.usage.totalTokens || output.usage.input + output.usage.output;
		calculateCost(model, output.usage);
	}
}

function handleContentBlockStop(
	event: ContentBlockStopEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = blocks.findIndex((b) => b.index === event.contentBlockIndex);
	const block = blocks[index];
	if (!block) return;
	delete (block as Block).index;

	switch (block.type) {
		case "text":
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
			break;
		case "thinking":
			stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
			break;
		case "toolCall":
			block.arguments = parseStreamingJson(block.partialJson);
			// Finalize in-place and strip the scratch buffer so replay only
			// carries parsed arguments.
			delete (block as Block).partialJson;
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
			break;
	}
}

/**
 * Check if the model supports adaptive thinking (Opus 4.6+, Sonnet 4.6).
 * Checks both model ID and model name to support application inference profiles
 * whose ARNs don't contain the model name.
 */
function getModelMatchCandidates(modelId: string, modelName?: string): string[] {
	const values = modelName ? [modelId, modelName] : [modelId];
	return values.flatMap((value) => {
		const lower = value.toLowerCase();
		return [lower, lower.replace(/[\s_.:]+/g, "-")];
	});
}

function supportsAdaptiveThinking(modelId: string, modelName?: string): boolean {
	const candidates = getModelMatchCandidates(modelId, modelName);
	return candidates.some((s) => s.includes("opus-4-6") || s.includes("opus-4-7") || s.includes("sonnet-4-6"));
}

function supportsNativeXhighEffort(model: Model<"bedrock-converse-stream">): boolean {
	const candidates = getModelMatchCandidates(model.id, model.name);
	return candidates.some((s) => s.includes("opus-4-7"));
}

function mapThinkingLevelToEffort(
	model: Model<"bedrock-converse-stream">,
	level: ThinkingLevel | undefined,
): BedrockReasoningEffort {
	if (level === "xhigh" && supportsNativeXhighEffort(model)) return "xhigh";

	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as BedrockReasoningEffort;

	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		default:
			return "high";
	}
}

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
		return "long";
	}
	return "short";
}

/**
 * Check if the model is an Anthropic Claude model on Bedrock.
 * Checks both model ID and model name to support application inference profiles
 * whose ARNs don't contain the model name.
 */
function isAnthropicClaudeModel(model: Model<"bedrock-converse-stream">): boolean {
	const id = model.id.toLowerCase();
	const name = model.name?.toLowerCase() ?? "";
	return (
		id.includes("anthropic.claude") ||
		id.includes("anthropic/claude") ||
		name.includes("anthropic.claude") ||
		name.includes("anthropic/claude") ||
		name.includes("claude")
	);
}

/**
 * Check if the model supports prompt caching.
 * Supported: Claude 3.5 Haiku, Claude 3.7 Sonnet, Claude 4.x models, Claude 5 models
 *
 * For base models and system-defined inference profiles the model ID / ARN
 * contains the model name, so we can decide locally.
 *
 * For application inference profiles (whose ARNs don't contain the model name),
 * also checks model.name which is user-controlled via models.json or registerProvider.
 * As a last resort, set AWS_BEDROCK_FORCE_CACHE=1 to enable cache points.
 * Amazon Nova models have automatic caching and don't need explicit cache points.
 */
function supportsPromptCaching(model: Model<"bedrock-converse-stream">): boolean {
	const candidates = getModelMatchCandidates(model.id, model.name);

	const hasClaudeRef = candidates.some((s) => s.includes("claude"));
	if (!hasClaudeRef) {
		// Application inference profiles don't contain the model name in the ARN.
		// Allow users to force cache points via environment variable.
		if (typeof process !== "undefined" && process.env.AWS_BEDROCK_FORCE_CACHE === "1") return true;
		return false;
	}
	// Claude 5 models (fable-5, sonnet-5)
	if (candidates.some((s) => s.includes("fable-5") || s.includes("sonnet-5"))) return true;
	// Claude 4.x models (opus-4, sonnet-4, haiku-4)
	if (candidates.some((s) => s.includes("-4-"))) return true;
	// Claude 3.7 Sonnet
	if (candidates.some((s) => s.includes("claude-3-7-sonnet"))) return true;
	// Claude 3.5 Haiku
	if (candidates.some((s) => s.includes("claude-3-5-haiku"))) return true;
	return false;
}

/**
 * Check if the model supports thinking signatures in reasoningContent.
 * Only Anthropic Claude models support the signature field.
 * Other models (OpenAI, Qwen, Minimax, Moonshot, etc.) reject it with:
 * "This model doesn't support the reasoningContent.reasoningText.signature field"
 *
 * Checks both model ID and model name to support application inference profiles.
 */
function supportsThinkingSignature(model: Model<"bedrock-converse-stream">): boolean {
	return isAnthropicClaudeModel(model);
}

function buildSystemPrompt(
	systemPrompt: string | undefined,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
): SystemContentBlock[] | undefined {
	if (!systemPrompt) return undefined;

	const blocks: SystemContentBlock[] = [{ text: sanitizeSurrogates(systemPrompt) }];

	// Add cache point for supported Claude models when caching is enabled
	if (cacheRetention !== "none" && supportsPromptCaching(model)) {
		blocks.push({
			cachePoint: { type: CachePointType.DEFAULT, ...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}) },
		});
	}

	return blocks;
}

function normalizeToolCallId(id: string): string {
	const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}

function convertUserMessage(message: UserMessage): Message | undefined {
	const content: ContentBlock[] = [];
	if (typeof message.content === "string") {
		content.push({ text: sanitizeSurrogates(message.content) });
	} else {
		for (const block of message.content) {
			switch (block.type) {
				case "text":
					content.push({ text: sanitizeSurrogates(block.text) });
					break;
				case "image":
					content.push({ image: createImageBlock(block.mimeType, block.data) });
					break;
			}
		}
	}
	return content.length > 0 ? { role: ConversationRole.USER, content } : undefined;
}

function convertAssistantContentBlock(
	block: AssistantContent,
	model: Model<"bedrock-converse-stream">,
): ContentBlock | undefined {
	switch (block.type) {
		case "text":
			return block.text.trim().length > 0 ? { text: sanitizeSurrogates(block.text) } : undefined;
		case "toolCall":
			return { toolUse: { toolUseId: block.id, name: block.name, input: block.arguments } };
		case "thinking":
			if (block.thinking.trim().length === 0) return undefined;
			if (!supportsThinkingSignature(model)) {
				return { reasoningContent: { reasoningText: { text: sanitizeSurrogates(block.thinking) } } };
			}
			if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
				return { text: sanitizeSurrogates(block.thinking) };
			}
			return {
				reasoningContent: {
					reasoningText: {
						text: sanitizeSurrogates(block.thinking),
						signature: block.thinkingSignature,
					},
				},
			};
	}
}

function convertAssistantMessage(
	message: AssistantMessage,
	model: Model<"bedrock-converse-stream">,
): Message | undefined {
	if (message.content.length === 0) return undefined;
	const content: ContentBlock[] = [];
	for (const block of message.content) {
		const converted = convertAssistantContentBlock(block, model);
		if (converted) content.push(converted);
	}
	return content.length > 0 ? { role: ConversationRole.ASSISTANT, content } : undefined;
}

function convertToolResult(message: ToolResultMessage): ContentBlock.ToolResultMember {
	return {
		toolResult: {
			toolUseId: message.toolCallId,
			content: message.content.map((block) =>
				block.type === "image"
					? { image: createImageBlock(block.mimeType, block.data) }
					: { text: sanitizeSurrogates(block.text) },
			),
			status: message.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
		},
	};
}

interface BedrockToolResultBatch {
	content: ContentBlock.ToolResultMember[];
	lastIndex: number;
}

function collectToolResultBatch(messages: PiMessage[], startIndex: number): BedrockToolResultBatch {
	const content: ContentBlock.ToolResultMember[] = [];
	let lastIndex = startIndex;
	for (let index = startIndex; index < messages.length; index++) {
		const message = messages[index];
		if (message.role !== "toolResult") break;
		content.push(convertToolResult(message));
		lastIndex = index;
	}
	return { content, lastIndex };
}

function appendPromptCachePoint(
	messages: Message[],
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
): void {
	if (cacheRetention === "none" || !supportsPromptCaching(model) || messages.length === 0) return;
	const lastMessage = messages[messages.length - 1];
	if (lastMessage.role !== ConversationRole.USER || !lastMessage.content) return;
	(lastMessage.content as ContentBlock[]).push({
		cachePoint: {
			type: CachePointType.DEFAULT,
			...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}),
		},
	});
}

function convertMessages(
	context: Context,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
): Message[] {
	const result: Message[] = [];
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
	for (let index = 0; index < transformedMessages.length; index++) {
		const message = transformedMessages[index];
		switch (message.role) {
			case "user": {
				const converted = convertUserMessage(message);
				if (converted) result.push(converted);
				break;
			}
			case "assistant": {
				const converted = convertAssistantMessage(message, model);
				if (converted) result.push(converted);
				break;
			}
			case "toolResult": {
				const batch = collectToolResultBatch(transformedMessages, index);
				result.push({ role: ConversationRole.USER, content: batch.content });
				index = batch.lastIndex;
				break;
			}
		}
	}
	appendPromptCachePoint(result, model, cacheRetention);
	return result;
}

function convertToolConfig(
	tools: Tool[] | undefined,
	toolChoice: BedrockToolSelection | undefined,
): ToolConfiguration | undefined {
	if (!tools?.length || toolChoice === "none") return undefined;

	const bedrockTools: BedrockTool[] = tools.map((tool) => ({
		toolSpec: {
			name: tool.name,
			description: tool.description,
			inputSchema: { json: tool.parameters as unknown as DocumentType },
		},
	}));

	let bedrockToolChoice: ToolChoice | undefined;
	switch (toolChoice) {
		case "auto":
			bedrockToolChoice = { auto: {} };
			break;
		case "any":
			bedrockToolChoice = { any: {} };
			break;
		default:
			if (toolChoice?.type === "tool") {
				bedrockToolChoice = { tool: { name: toolChoice.name } };
			}
	}

	return { tools: bedrockTools, toolChoice: bedrockToolChoice };
}

function mapStopReason(reason: string | undefined): StopReason {
	switch (reason) {
		case BedrockStopReason.END_TURN:
		case BedrockStopReason.STOP_SEQUENCE:
			return "stop";
		case BedrockStopReason.MAX_TOKENS:
		case BedrockStopReason.MODEL_CONTEXT_WINDOW_EXCEEDED:
			return "length";
		case BedrockStopReason.TOOL_USE:
			return "toolUse";
		default:
			return "error";
	}
}

function getConfiguredBedrockRegion(options: BedrockOptions): string | undefined {
	if (typeof process === "undefined") {
		return options.region;
	}

	return options.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || undefined;
}

function hasConfiguredBedrockProfile(): boolean {
	if (typeof process === "undefined") {
		return false;
	}

	return Boolean(process.env.AWS_PROFILE);
}

function getStandardBedrockEndpointRegion(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) {
		return undefined;
	}

	try {
		const { hostname } = new URL(baseUrl);
		const match = hostname.toLowerCase().match(/^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/);
		return match?.[1];
	} catch {
		return undefined;
	}
}

function shouldUseExplicitBedrockEndpoint(
	baseUrl: string,
	configuredRegion: string | undefined,
	hasConfiguredProfile: boolean,
): boolean {
	const endpointRegion = getStandardBedrockEndpointRegion(baseUrl);
	if (!endpointRegion) {
		return true;
	}

	return !configuredRegion && !hasConfiguredProfile;
}

function isGovCloudBedrockTarget(model: Model<"bedrock-converse-stream">, options: BedrockOptions): boolean {
	const region = getConfiguredBedrockRegion(options);
	if (region?.toLowerCase().startsWith("us-gov-")) {
		return true;
	}

	const modelId = model.id.toLowerCase();
	return modelId.startsWith("us-gov.") || modelId.startsWith("arn:aws-us-gov:");
}

function buildAdditionalModelRequestFields(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): Record<string, any> | undefined {
	if (!options.reasoning || !model.reasoning) {
		return undefined;
	}

	if (isAnthropicClaudeModel(model)) {
		// GovCloud Bedrock currently rejects the Claude thinking.display field.
		// Omit it there until the GovCloud Converse schema catches up.
		const display = isGovCloudBedrockTarget(model, options) ? undefined : (options.thinkingDisplay ?? "summarized");
		const result: Record<string, any> = supportsAdaptiveThinking(model.id, model.name)
			? {
					thinking: { type: "adaptive", ...(display !== undefined ? { display } : {}) },
					output_config: { effort: mapThinkingLevelToEffort(model, options.reasoning) },
				}
			: (() => {
					const defaultBudgets: Record<ThinkingLevel, number> = {
						minimal: 1024,
						low: 2048,
						medium: 8192,
						high: 16384,
						xhigh: 16384, // Claude doesn't support xhigh, clamp to high
					};

					// Custom budgets override defaults (xhigh not in ThinkingBudgets, use high)
					const level = options.reasoning === "xhigh" ? "high" : options.reasoning;
					const budget = options.thinkingBudgets?.[level] ?? defaultBudgets[options.reasoning];

					return {
						thinking: {
							type: "enabled",
							budget_tokens: budget,
							...(display !== undefined ? { display } : {}),
						},
					};
				})();

		if (!supportsAdaptiveThinking(model.id, model.name) && (options.interleavedThinking ?? true)) {
			result.anthropic_beta = ["interleaved-thinking-2025-05-14"];
		}

		return result;
	}

	return undefined;
}

function createImageBlock(mimeType: string, data: string) {
	let format: ImageFormat;
	switch (mimeType) {
		case "image/jpeg":
		case "image/jpg":
			format = ImageFormat.JPEG;
			break;
		case "image/png":
			format = ImageFormat.PNG;
			break;
		case "image/gif":
			format = ImageFormat.GIF;
			break;
		case "image/webp":
			format = ImageFormat.WEBP;
			break;
		default:
			throw new Error(`Unknown image type: ${mimeType}`);
	}

	const binaryString = atob(data);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}

	return { source: { bytes }, format };
}
