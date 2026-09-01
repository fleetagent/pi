import type { CacheControlEphemeral as OpenAICompatCacheControl } from "@anthropic-ai/sdk/resources/messages.js";
import OpenAI from "openai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionDeveloperMessageParam,
	ChatCompletionMessageParam,
	ChatCompletionNamedToolChoice,
	ChatCompletionSystemMessageParam,
	ChatCompletionToolMessageParam,
	ChatCompletionUserMessageParam,
} from "openai/resources/chat/completions.js";
import { getEnvApiKey } from "../env-api-keys.ts";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	OpenAICompletionsCacheControlFormat,
	OpenAICompletionsCompat,
	OpenAICompletionsThinkingFormat,
	OpenRouterRouting,
	ProviderHeaders,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { headersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./cloudflare.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import { buildBaseOptions } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

/**
 * Check if conversation messages contain tool calls or tool results.
 * This is needed because Anthropic (via proxy) requires the tools param
 * to be present when messages include tool_calls or tool role messages.
 */
function hasToolHistory(messages: Message[]): boolean {
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			return true;
		}
		if (msg.role === "assistant") {
			// This helper reads the original context after conversion, so retain the
			// transform boundary's tolerance for untyped null or missing content.
			if (msg.content?.some((block) => block.type === "toolCall")) {
				return true;
			}
		}
	}
	return false;
}

interface ContentBlockDiscriminant {
	type: string;
}

function isTextContentBlock(block: ContentBlockDiscriminant): block is TextContent {
	return block.type === "text";
}

function isThinkingContentBlock(block: ContentBlockDiscriminant): block is ThinkingContent {
	return block.type === "thinking";
}

function isToolCallBlock(block: ContentBlockDiscriminant): block is ToolCall {
	return block.type === "toolCall";
}

function isImageContentBlock(block: ContentBlockDiscriminant): block is ImageContent {
	return block.type === "image";
}

export type OpenAICompletionsReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type OpenAICompletionsToolChoice = "auto" | "none" | "required" | ChatCompletionNamedToolChoice;

export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: OpenAICompletionsToolChoice;
	reasoningEffort?: OpenAICompletionsReasoningEffort;
}

type ResolvedOpenAICompletionsCompat = Omit<Required<OpenAICompletionsCompat>, "cacheControlFormat"> & {
	cacheControlFormat?: OpenAICompletionsCacheControlFormat;
};

type ChatCompletionInstructionMessageParam = ChatCompletionDeveloperMessageParam | ChatCompletionSystemMessageParam;

type ChatCompletionTextPartWithCacheControl = ChatCompletionContentPartText & {
	cache_control?: OpenAICompatCacheControl;
};

type ChatCompletionToolWithCacheControl = OpenAI.Chat.Completions.ChatCompletionTool & {
	cache_control?: OpenAICompatCacheControl;
};

interface OpenAICompatiblePromptTokenDetails {
	cached_tokens?: number;
	cache_write_tokens?: number;
}

interface OpenAICompatibleChunkUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	prompt_cache_hit_tokens?: number;
	prompt_tokens_details?: OpenAICompatiblePromptTokenDetails;
}

type OpenAICompatibleFinishReason = string | null;

interface StopReasonMapping {
	stopReason: StopReason;
	errorMessage?: string;
}

function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
		return "long";
	}
	return "short";
}

interface StreamingToolCallBlock extends ToolCall {
	partialArgs?: string;
	streamIndex?: number;
}

type StreamingBlock = TextContent | ThinkingContent | StreamingToolCallBlock;
type StreamingToolCallDelta = ChatCompletionChunk.Choice.Delta.ToolCall;

interface OpenAICompletionStreamState {
	model: Model<"openai-completions">;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	blocks: StreamingBlock[];
	textBlock: TextContent | null;
	thinkingBlock: ThinkingContent | null;
	hasFinishReason: boolean;
	toolCallBlocksByIndex: Map<number, StreamingToolCallBlock>;
	toolCallBlocksById: Map<string, StreamingToolCallBlock>;
}

interface OpenAIReasoningDelta {
	delta: string;
	signature: string;
}

interface OpenAIReasoningDetail {
	type?: unknown;
	id?: unknown;
	data?: unknown;
}

interface OpenAICompatibleChoice extends ChatCompletionChunk.Choice {
	usage?: OpenAICompatibleChunkUsage;
}

interface OpenAIProviderRawErrorMetadata {
	raw?: unknown;
}

interface OpenAIProviderErrorDetails {
	metadata?: OpenAIProviderRawErrorMetadata;
}

interface OpenAIProviderErrorMetadata {
	error?: OpenAIProviderErrorDetails;
}

function createOpenAICompletionsOutput(model: Model<"openai-completions">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
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
}

async function startOpenAICompletionsRequest(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAICompletionsOptions | undefined,
): Promise<AsyncIterable<ChatCompletionChunk>> {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
	const compat = getCompat(model);
	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
	const client = createClient(model, context, apiKey, options?.headers, cacheSessionId, compat);
	let params = buildParams(model, context, options, compat, cacheRetention);
	const nextParams = await options?.onPayload?.(params, model);
	if (nextParams !== undefined) params = nextParams as OpenAICompatibleRequestParams;
	const requestOptions = {
		...(options?.signal ? { signal: options.signal } : {}),
		...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
		maxRetries: 0,
	};
	const { data, response } = await retryProviderRequest(
		() =>
			client.chat.completions
				.create(params as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, requestOptions)
				.withResponse(),
		{
			maxRetries: options?.maxRetries,
			maxRetryDelayMs: options?.maxRetryDelayMs,
			signal: options?.signal,
		},
	);
	await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
	return data;
}

function createOpenAICompletionStreamState(
	model: Model<"openai-completions">,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): OpenAICompletionStreamState {
	return {
		model,
		output,
		stream,
		blocks: output.content as StreamingBlock[],
		textBlock: null,
		thinkingBlock: null,
		hasFinishReason: false,
		toolCallBlocksByIndex: new Map(),
		toolCallBlocksById: new Map(),
	};
}

function openAICompletionContentIndex(state: OpenAICompletionStreamState, block: StreamingBlock): number {
	return state.blocks.indexOf(block);
}

function finishOpenAICompletionBlock(state: OpenAICompletionStreamState, block: StreamingBlock): void {
	const contentIndex = openAICompletionContentIndex(state, block);
	if (contentIndex === -1) return;
	if (block.type === "text") {
		state.stream.push({ type: "text_end", contentIndex, content: block.text, partial: state.output });
		return;
	}
	if (block.type === "thinking") {
		state.stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: state.output });
		return;
	}
	block.arguments = parseStreamingJson(block.partialArgs);
	delete block.partialArgs;
	delete block.streamIndex;
	state.stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: state.output });
}

function appendOpenAITextDelta(state: OpenAICompletionStreamState, delta: string): void {
	if (!state.textBlock) {
		state.textBlock = { type: "text", text: "" };
		state.blocks.push(state.textBlock);
		state.stream.push({
			type: "text_start",
			contentIndex: openAICompletionContentIndex(state, state.textBlock),
			partial: state.output,
		});
	}
	state.textBlock.text += delta;
	state.stream.push({
		type: "text_delta",
		contentIndex: openAICompletionContentIndex(state, state.textBlock),
		delta,
		partial: state.output,
	});
}

function appendOpenAIThinkingDelta(state: OpenAICompletionStreamState, reasoning: OpenAIReasoningDelta): void {
	if (!state.thinkingBlock) {
		state.thinkingBlock = { type: "thinking", thinking: "", thinkingSignature: reasoning.signature };
		state.blocks.push(state.thinkingBlock);
		state.stream.push({
			type: "thinking_start",
			contentIndex: openAICompletionContentIndex(state, state.thinkingBlock),
			partial: state.output,
		});
	}
	state.thinkingBlock.thinking += reasoning.delta;
	state.stream.push({
		type: "thinking_delta",
		contentIndex: openAICompletionContentIndex(state, state.thinkingBlock),
		delta: reasoning.delta,
		partial: state.output,
	});
}

function resolveOpenAIReasoningDelta(
	model: Model<"openai-completions">,
	delta: ChatCompletionChunk.Choice.Delta,
): OpenAIReasoningDelta | undefined {
	const fields = ["reasoning_content", "reasoning", "reasoning_text"];
	const deltaFields = delta as Record<string, unknown>;
	for (const field of fields) {
		const value = deltaFields[field];
		if (typeof value !== "string" || value.length === 0) continue;
		return {
			delta: value,
			signature: model.provider === "opencode-go" && field === "reasoning" ? "reasoning_content" : field,
		};
	}
	return undefined;
}

function ensureOpenAIToolCallBlock(
	state: OpenAICompletionStreamState,
	toolCall: StreamingToolCallDelta,
): StreamingToolCallBlock {
	const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
	let block = streamIndex !== undefined ? state.toolCallBlocksByIndex.get(streamIndex) : undefined;
	if (!block && toolCall.id) block = state.toolCallBlocksById.get(toolCall.id);
	if (!block) {
		block = {
			type: "toolCall",
			id: toolCall.id || "",
			name: toolCall.function?.name || "",
			arguments: {},
			partialArgs: "",
			streamIndex,
		};
		if (streamIndex !== undefined) state.toolCallBlocksByIndex.set(streamIndex, block);
		if (toolCall.id) state.toolCallBlocksById.set(toolCall.id, block);
		state.blocks.push(block);
		state.stream.push({
			type: "toolcall_start",
			contentIndex: openAICompletionContentIndex(state, block),
			partial: state.output,
		});
	}
	if (streamIndex !== undefined && block.streamIndex === undefined) {
		block.streamIndex = streamIndex;
		state.toolCallBlocksByIndex.set(streamIndex, block);
	}
	if (toolCall.id) state.toolCallBlocksById.set(toolCall.id, block);
	return block;
}

function appendOpenAIToolCallDelta(state: OpenAICompletionStreamState, toolCall: StreamingToolCallDelta): void {
	const block = ensureOpenAIToolCallBlock(state, toolCall);
	if (!block.id && toolCall.id) {
		block.id = toolCall.id;
		state.toolCallBlocksById.set(toolCall.id, block);
	}
	if (!block.name && toolCall.function?.name) block.name = toolCall.function.name;
	let delta = "";
	if (toolCall.function?.arguments) {
		delta = toolCall.function.arguments;
		block.partialArgs = (block.partialArgs ?? "") + delta;
		block.arguments = parseStreamingJson(block.partialArgs);
	}
	state.stream.push({
		type: "toolcall_delta",
		contentIndex: openAICompletionContentIndex(state, block),
		delta,
		partial: state.output,
	});
}

function applyOpenAIReasoningDetails(
	state: OpenAICompletionStreamState,
	delta: ChatCompletionChunk.Choice.Delta,
): void {
	const details = (delta as Record<string, unknown>).reasoning_details;
	if (!Array.isArray(details)) return;
	for (const detail of details as OpenAIReasoningDetail[]) {
		if (detail.type !== "reasoning.encrypted" || typeof detail.id !== "string" || !detail.data) continue;
		const matchingToolCall = state.toolCallBlocksById.get(detail.id);
		if (matchingToolCall) matchingToolCall.thoughtSignature = JSON.stringify(detail);
	}
}

function consumeOpenAICompletionDelta(
	state: OpenAICompletionStreamState,
	delta: ChatCompletionChunk.Choice.Delta,
): void {
	if (delta.content !== null && delta.content !== undefined && delta.content.length > 0) {
		appendOpenAITextDelta(state, delta.content);
	}
	const reasoning = resolveOpenAIReasoningDelta(state.model, delta);
	if (reasoning) appendOpenAIThinkingDelta(state, reasoning);
	for (const toolCall of delta.tool_calls ?? []) appendOpenAIToolCallDelta(state, toolCall);
	applyOpenAIReasoningDetails(state, delta);
}

function applyOpenAICompletionFinishReason(
	state: OpenAICompletionStreamState,
	finishReason: OpenAICompatibleFinishReason,
): void {
	if (!finishReason) return;
	const result = mapStopReason(finishReason);
	state.output.stopReason = result.stopReason;
	if (result.errorMessage) state.output.errorMessage = result.errorMessage;
	state.hasFinishReason = true;
}

function consumeOpenAICompletionChunk(state: OpenAICompletionStreamState, chunk: ChatCompletionChunk): void {
	state.output.responseId ||= chunk.id;
	if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== state.model.id) {
		state.output.responseModel ||= chunk.model;
	}
	if (chunk.usage) state.output.usage = parseChunkUsage(chunk.usage, state.model);
	const choice = (Array.isArray(chunk.choices) ? chunk.choices[0] : undefined) as OpenAICompatibleChoice | undefined;
	if (!choice) return;
	if (!chunk.usage && choice.usage) state.output.usage = parseChunkUsage(choice.usage, state.model);
	applyOpenAICompletionFinishReason(state, choice.finish_reason);
	if (choice.delta) consumeOpenAICompletionDelta(state, choice.delta);
}

async function consumeOpenAICompletionStream(
	state: OpenAICompletionStreamState,
	openaiStream: AsyncIterable<ChatCompletionChunk>,
): Promise<void> {
	for await (const chunk of openaiStream) {
		if (chunk && typeof chunk === "object") consumeOpenAICompletionChunk(state, chunk);
	}
}

function finalizeOpenAICompletionStream(
	state: OpenAICompletionStreamState,
	options: OpenAICompletionsOptions | undefined,
): void {
	for (const block of state.blocks) finishOpenAICompletionBlock(state, block);
	if (options?.signal?.aborted || state.output.stopReason === "aborted") throw new Error("Request was aborted");
	if (state.output.stopReason === "error") {
		throw new Error(state.output.errorMessage || "Provider returned an error stop reason");
	}
	if (!state.hasFinishReason || state.output.stopReason === "pending") {
		throw new Error("Stream ended without finish_reason");
	}
	state.stream.push({ type: "done", reason: state.output.stopReason, message: state.output });
	state.stream.end();
}

function failOpenAICompletionStream(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	error: unknown,
	options: OpenAICompletionsOptions | undefined,
): void {
	for (const block of output.content) {
		delete (block as { index?: number }).index;
		delete (block as { partialArgs?: string }).partialArgs;
		delete (block as { streamIndex?: number }).streamIndex;
	}
	output.stopReason = options?.signal?.aborted ? "aborted" : "error";
	output.errorMessage = formatProviderError(normalizeProviderError(error));
	const rawMetadata = (error as OpenAIProviderErrorMetadata)?.error?.metadata?.raw;
	if (typeof rawMetadata === "string" && rawMetadata.length > 0) output.errorMessage += `\n${rawMetadata}`;
	stream.push({ type: "error", reason: output.stopReason, error: output });
	stream.end();
}

async function runOpenAICompletionsStream(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAICompletionsOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const output = createOpenAICompletionsOutput(model);
	try {
		const openaiStream = await startOpenAICompletionsRequest(model, context, options);
		stream.push({ type: "start", partial: output });
		const state = createOpenAICompletionStreamState(model, output, stream);
		await consumeOpenAICompletionStream(state, openaiStream);
		finalizeOpenAICompletionStream(state, options);
	} catch (error) {
		failOpenAICompletionStream(output, stream, error, options);
	}
}

export const streamOpenAICompletions: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	void runOpenAICompletionsStream(model, context, options, stream);
	return stream;
};

export const streamSimpleOpenAICompletions: StreamFunction<"openai-completions", SimpleStreamOptions> = (
	model: Model<"openai-completions">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, context, options, apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
	const toolChoice = (options as OpenAICompletionsOptions | undefined)?.toolChoice;

	return streamOpenAICompletions(model, context, {
		...base,
		reasoningEffort,
		toolChoice,
	} satisfies OpenAICompletionsOptions);
};

function createClient(
	model: Model<"openai-completions">,
	context: Context,
	apiKey?: string,
	optionsHeaders?: ProviderHeaders,
	sessionId?: string,
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
) {
	if (!apiKey) {
		if (!process.env.OPENAI_API_KEY) {
			throw new Error(
				"OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = process.env.OPENAI_API_KEY;
	}

	const headers: ProviderHeaders = { ...model.headers };
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

	if (sessionId && compat.sendSessionAffinityHeaders) {
		headers.session_id = sessionId;
		headers["x-client-request-id"] = sessionId;
		headers["x-session-affinity"] = sessionId;
	}

	if (model.provider === "cloudflare-ai-gateway") {
		if (!("Authorization" in headers)) headers.Authorization = null;
		if (!("cf-aig-authorization" in headers)) headers["cf-aig-authorization"] = `Bearer ${apiKey}`;
	}

	// Merge options headers last so they can override or suppress defaults.
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	return new OpenAI({
		apiKey,
		baseURL: isCloudflareProvider(model.provider) ? resolveCloudflareBaseUrl(model) : model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders: headers,
	});
}

type OpenAICompatibleThinkingState = "enabled" | "disabled";

interface OpenAICompatibleStreamOptions {
	include_usage: boolean;
}

interface OpenAICompatibleThinkingOptions {
	type: OpenAICompatibleThinkingState;
	clear_thinking?: boolean;
}

interface OpenAICompatibleChatTemplateKwargs {
	enable_thinking: boolean;
	preserve_thinking: boolean;
}

interface OpenAICompatibleReasoningOptions {
	effort?: string;
	enabled?: boolean;
}

interface VercelGatewayProviderOptions {
	gateway: Record<string, string[]>;
}

interface OpenAICompatibleRequestExtensions {
	stream_options?: OpenAICompatibleStreamOptions;
	max_tokens?: number;
	tool_stream?: boolean;
	thinking?: OpenAICompatibleThinkingOptions | string;
	reasoning_effort?: string;
	enable_thinking?: boolean;
	chat_template_kwargs?: OpenAICompatibleChatTemplateKwargs;
	reasoning?: OpenAICompatibleReasoningOptions;
	provider?: OpenRouterRouting;
	providerOptions?: VercelGatewayProviderOptions;
}

type OpenAICompatibleRequestParams = Omit<
	OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
	keyof OpenAICompatibleRequestExtensions
> &
	OpenAICompatibleRequestExtensions;

function configureOpenAIRequestFields(
	params: OpenAICompatibleRequestParams,
	options: OpenAICompletionsOptions | undefined,
	compat: ResolvedOpenAICompletionsCompat,
): void {
	if (compat.supportsUsageInStreaming !== false) params.stream_options = { include_usage: true };
	if (compat.supportsStore) params.store = false;
	if (options?.maxTokens) {
		if (compat.maxTokensField === "max_tokens") params.max_tokens = options.maxTokens;
		else params.max_completion_tokens = options.maxTokens;
	}
	if (options?.temperature !== undefined) params.temperature = options.temperature;
}

function configureOpenAIRequestTools(
	params: OpenAICompatibleRequestParams,
	context: Context,
	compat: ResolvedOpenAICompletionsCompat,
	cacheControl: OpenAICompatCacheControl | undefined,
): void {
	if (context.tools && context.tools.length > 0) {
		params.tools = convertTools(context.tools, compat);
		if (compat.zaiToolStream) params.tool_stream = true;
	} else if (hasToolHistory(context.messages)) {
		// Anthropic-compatible proxies require tools when conversation history contains tool calls or results.
		params.tools = [];
	}
	if (cacheControl) applyAnthropicCacheControl(params.messages, params.tools, cacheControl);
}

function resolveOpenAIReasoningEffort(
	model: Model<"openai-completions">,
	effort: OpenAICompletionsReasoningEffort,
): string {
	return model.thinkingLevelMap?.[effort] ?? effort;
}

function configureZaiReasoning(
	params: OpenAICompatibleRequestParams,
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	compat: ResolvedOpenAICompletionsCompat,
): void {
	params.thinking = options?.reasoningEffort ? { type: "enabled", clear_thinking: false } : { type: "disabled" };
	if (!options?.reasoningEffort || !compat.supportsReasoningEffort) return;
	const mappedEffort = model.thinkingLevelMap?.[options.reasoningEffort];
	const effort = mappedEffort === undefined ? options.reasoningEffort : mappedEffort;
	if (typeof effort === "string") params.reasoning_effort = effort;
}

function configureDeepSeekReasoning(
	params: OpenAICompatibleRequestParams,
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	compat: ResolvedOpenAICompletionsCompat,
): void {
	params.thinking = { type: options?.reasoningEffort ? "enabled" : "disabled" };
	if (!options?.reasoningEffort || !compat.supportsReasoningEffort) return;
	params.reasoning_effort = resolveOpenAIReasoningEffort(model, options.reasoningEffort);
}

function configureOpenRouterReasoning(
	params: OpenAICompatibleRequestParams,
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
): void {
	if (options?.reasoningEffort) {
		params.reasoning = { effort: resolveOpenAIReasoningEffort(model, options.reasoningEffort) };
	} else if (model.thinkingLevelMap?.off !== null) {
		params.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
	}
}

function configureTogetherReasoning(
	params: OpenAICompatibleRequestParams,
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	compat: ResolvedOpenAICompletionsCompat,
): void {
	params.reasoning = { enabled: !!options?.reasoningEffort };
	if (!options?.reasoningEffort || !compat.supportsReasoningEffort) return;
	params.reasoning_effort = resolveOpenAIReasoningEffort(model, options.reasoningEffort);
}

function configureStringThinking(
	params: OpenAICompatibleRequestParams,
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
): void {
	if (options?.reasoningEffort) {
		params.thinking = resolveOpenAIReasoningEffort(model, options.reasoningEffort);
	} else if (model.thinkingLevelMap?.off !== null) {
		params.thinking = model.thinkingLevelMap?.off ?? "none";
	}
}

function configureStandardOpenAIReasoning(
	params: OpenAICompatibleRequestParams,
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	compat: ResolvedOpenAICompletionsCompat,
): void {
	if (!compat.supportsReasoningEffort) return;
	if (options?.reasoningEffort) {
		params.reasoning_effort = resolveOpenAIReasoningEffort(model, options.reasoningEffort);
		return;
	}
	const offValue = model.thinkingLevelMap?.off;
	if (typeof offValue === "string") params.reasoning_effort = offValue;
}

function configureOpenAIReasoning(
	params: OpenAICompatibleRequestParams,
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	compat: ResolvedOpenAICompletionsCompat,
): void {
	if (!model.reasoning) return;
	switch (compat.thinkingFormat) {
		case "zai":
			configureZaiReasoning(params, model, options, compat);
			return;
		case "qwen":
			params.enable_thinking = !!options?.reasoningEffort;
			return;
		case "qwen-chat-template":
			params.chat_template_kwargs = {
				enable_thinking: !!options?.reasoningEffort,
				preserve_thinking: true,
			};
			return;
		case "deepseek":
			configureDeepSeekReasoning(params, model, options, compat);
			return;
		case "openrouter":
			configureOpenRouterReasoning(params, model, options);
			return;
		case "together":
			configureTogetherReasoning(params, model, options, compat);
			return;
		case "string-thinking":
			configureStringThinking(params, model, options);
			return;
		default:
			configureStandardOpenAIReasoning(params, model, options, compat);
	}
}

function configureOpenAIProviderRouting(
	params: OpenAICompatibleRequestParams,
	model: Model<"openai-completions">,
): void {
	if (model.baseUrl.includes("openrouter.ai") && model.compat?.openRouterRouting) {
		params.provider = model.compat.openRouterRouting;
	}
	if (!model.baseUrl.includes("ai-gateway.vercel.sh") || !model.compat?.vercelGatewayRouting) return;
	const routing = model.compat.vercelGatewayRouting;
	if (!routing.only && !routing.order) return;
	const gatewayOptions: Record<string, string[]> = {};
	if (routing.only) gatewayOptions.only = routing.only;
	if (routing.order) gatewayOptions.order = routing.order;
	params.providerOptions = { gateway: gatewayOptions };
}

function buildParams(
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
	cacheRetention: CacheRetention = resolveCacheRetention(options?.cacheRetention),
): OpenAICompatibleRequestParams {
	const messages = convertMessages(model, context, compat);
	const cacheControl = getCompatCacheControl(compat, cacheRetention);
	const params: OpenAICompatibleRequestParams = {
		model: model.id,
		messages,
		stream: true,
		prompt_cache_key:
			(model.baseUrl.includes("api.openai.com") && cacheRetention !== "none") ||
			(cacheRetention === "long" && compat.supportsLongCacheRetention)
				? clampOpenAIPromptCacheKey(options?.sessionId)
				: undefined,
		prompt_cache_retention: cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined,
	};
	configureOpenAIRequestFields(params, options, compat);
	configureOpenAIRequestTools(params, context, compat, cacheControl);
	if (options?.toolChoice) params.tool_choice = options.toolChoice;
	configureOpenAIReasoning(params, model, options, compat);
	configureOpenAIProviderRouting(params, model);
	return params;
}

function getCompatCacheControl(
	compat: ResolvedOpenAICompletionsCompat,
	cacheRetention: CacheRetention,
): OpenAICompatCacheControl | undefined {
	if (compat.cacheControlFormat !== "anthropic" || cacheRetention === "none") {
		return undefined;
	}

	const ttl = cacheRetention === "long" && compat.supportsLongCacheRetention ? "1h" : undefined;
	return { type: "ephemeral", ...(ttl ? { ttl } : {}) };
}

function applyAnthropicCacheControl(
	messages: ChatCompletionMessageParam[],
	tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
	cacheControl: OpenAICompatCacheControl,
): void {
	addCacheControlToSystemPrompt(messages, cacheControl);
	addCacheControlToLastTool(tools, cacheControl);
	addCacheControlToLastConversationMessage(messages, cacheControl);
}

function addCacheControlToSystemPrompt(
	messages: ChatCompletionMessageParam[],
	cacheControl: OpenAICompatCacheControl,
): void {
	for (const message of messages) {
		if (message.role === "system" || message.role === "developer") {
			addCacheControlToInstructionMessage(message, cacheControl);
			return;
		}
	}
}

function addCacheControlToLastConversationMessage(
	messages: ChatCompletionMessageParam[],
	cacheControl: OpenAICompatCacheControl,
): void {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" || message.role === "assistant") {
			if (addCacheControlToMessage(message, cacheControl)) {
				return;
			}
		}
	}
}

function addCacheControlToLastTool(
	tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
	cacheControl: OpenAICompatCacheControl,
): void {
	if (!tools || tools.length === 0) {
		return;
	}

	const lastTool = tools[tools.length - 1] as ChatCompletionToolWithCacheControl;
	lastTool.cache_control = cacheControl;
}

function addCacheControlToInstructionMessage(
	message: ChatCompletionInstructionMessageParam,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	return addCacheControlToTextContent(message, cacheControl);
}

function addCacheControlToMessage(
	message: ChatCompletionMessageParam,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	if (message.role === "user" || message.role === "assistant") {
		return addCacheControlToTextContent(message, cacheControl);
	}
	return false;
}

function addCacheControlToTextContent(
	message:
		| ChatCompletionInstructionMessageParam
		| ChatCompletionAssistantMessageParam
		| ChatCompletionUserMessageParam,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	const content = message.content;
	if (typeof content === "string") {
		if (content.length === 0) {
			return false;
		}
		message.content = [
			{
				type: "text",
				text: content,
				cache_control: cacheControl,
			},
		] as ChatCompletionTextPartWithCacheControl[];
		return true;
	}

	if (!Array.isArray(content)) {
		return false;
	}

	for (let i = content.length - 1; i >= 0; i--) {
		const part = content[i];
		if (part?.type === "text") {
			const textPart = part as ChatCompletionTextPartWithCacheControl;
			textPart.cache_control = cacheControl;
			return true;
		}
	}

	return false;
}

function normalizeOpenAICompletionsToolCallId(model: Model<"openai-completions">, id: string): string {
	if (id.includes("|")) {
		const separatorIndex = id.indexOf("|");
		const callId = id.slice(0, separatorIndex).replace(/[^a-zA-Z0-9_-]/g, "_");
		const itemId = id.slice(separatorIndex + 1).replace(/[^a-zA-Z0-9_-]/g, "_");
		const combinedId = itemId.length > 0 ? `${callId}_${itemId}` : callId;
		if (combinedId.length <= 40) return combinedId;
		const hash = shortHash(id).slice(0, 8);
		const prefix = callId.slice(0, Math.max(1, 40 - hash.length - 1));
		return `${prefix}_${hash}`;
	}
	if (model.provider === "openai") return id.length > 40 ? id.slice(0, 40) : id;
	return id;
}

function convertOpenAIUserMessage(message: UserMessage): ChatCompletionUserMessageParam | undefined {
	if (typeof message.content === "string") {
		return { role: "user", content: sanitizeSurrogates(message.content) };
	}
	const content: ChatCompletionContentPart[] = message.content.map((item): ChatCompletionContentPart => {
		if (item.type === "text") {
			return { type: "text", text: sanitizeSurrogates(item.text) } satisfies ChatCompletionContentPartText;
		}
		return {
			type: "image_url",
			image_url: { url: `data:${item.mimeType};base64,${item.data}` },
		} satisfies ChatCompletionContentPartImage;
	});
	return content.length > 0 ? { role: "user", content } : undefined;
}

interface OpenAIAssistantConversion {
	model: Model<"openai-completions">;
	compat: ResolvedOpenAICompletionsCompat;
	source: AssistantMessage;
	output: ChatCompletionAssistantMessageParam;
	textParts: ChatCompletionContentPartText[];
	text: string;
}

function createOpenAIAssistantConversion(
	message: AssistantMessage,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompletionsCompat,
): OpenAIAssistantConversion {
	const textParts = message.content
		.filter((block): block is TextContent => isTextContentBlock(block) && block.text.trim().length > 0)
		.map((block) => ({ type: "text", text: sanitizeSurrogates(block.text) }) satisfies ChatCompletionContentPartText);
	return {
		model,
		compat,
		source: message,
		output: { role: "assistant", content: compat.requiresAssistantAfterToolResult ? "" : null },
		textParts,
		text: textParts.map((part) => part.text).join(""),
	};
}

function applyOpenAIAssistantThinking(conversion: OpenAIAssistantConversion): void {
	const thinkingBlocks = conversion.source.content.filter(
		(block): block is ThinkingContent => isThinkingContentBlock(block) && block.thinking.trim().length > 0,
	);
	if (thinkingBlocks.length === 0) {
		if (conversion.text.length > 0) conversion.output.content = conversion.text;
		return;
	}
	if (conversion.compat.requiresThinkingAsText) {
		const thinkingText = thinkingBlocks.map((block) => sanitizeSurrogates(block.thinking)).join("\n\n");
		conversion.output.content = [{ type: "text", text: thinkingText }, ...conversion.textParts];
		return;
	}
	if (conversion.text.length > 0) conversion.output.content = conversion.text;
	let signature = thinkingBlocks[0].thinkingSignature;
	if (conversion.model.provider === "opencode-go" && signature === "reasoning") signature = "reasoning_content";
	if (signature && signature.length > 0) {
		(conversion.output as any)[signature] = thinkingBlocks.map((block) => block.thinking).join("\n");
	}
}

function applyOpenAIAssistantToolCalls(conversion: OpenAIAssistantConversion): void {
	const toolCalls = conversion.source.content.filter(isToolCallBlock);
	if (toolCalls.length === 0) return;
	conversion.output.tool_calls = toolCalls.map((toolCall) => ({
		id: toolCall.id,
		type: "function" as const,
		function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
	}));
	const reasoningDetails = toolCalls
		.filter((toolCall) => toolCall.thoughtSignature)
		.map((toolCall) => {
			try {
				return JSON.parse(toolCall.thoughtSignature!);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
	if (reasoningDetails.length > 0) (conversion.output as any).reasoning_details = reasoningDetails;
}

function ensureOpenAIAssistantReasoningContent(conversion: OpenAIAssistantConversion): void {
	if (
		conversion.compat.requiresReasoningContentOnAssistantMessages &&
		conversion.model.reasoning &&
		(conversion.output as { reasoning_content?: string }).reasoning_content === undefined
	) {
		(conversion.output as { reasoning_content?: string }).reasoning_content = "";
	}
}

function hasOpenAIAssistantOutput(message: ChatCompletionAssistantMessageParam): boolean {
	const content = message.content;
	const hasContent =
		content !== null &&
		content !== undefined &&
		(typeof content === "string" ? content.length > 0 : content.length > 0);
	return hasContent || message.tool_calls !== undefined;
}

function convertOpenAIAssistantMessage(
	message: AssistantMessage,
	model: Model<"openai-completions">,
	compat: ResolvedOpenAICompletionsCompat,
): ChatCompletionAssistantMessageParam | undefined {
	const conversion = createOpenAIAssistantConversion(message, model, compat);
	applyOpenAIAssistantThinking(conversion);
	applyOpenAIAssistantToolCalls(conversion);
	ensureOpenAIAssistantReasoningContent(conversion);
	return hasOpenAIAssistantOutput(conversion.output) ? conversion.output : undefined;
}

function convertOpenAIToolResultMessage(
	message: ToolResultMessage,
	compat: ResolvedOpenAICompletionsCompat,
): ChatCompletionToolMessageParam {
	const textResult = message.content
		.filter(isTextContentBlock)
		.map((block) => block.text)
		.join("\n");
	const hasImages = message.content.some((content) => content.type === "image");
	const toolResultText = textResult.length > 0 ? textResult : hasImages ? "(see attached image)" : "(no tool output)";
	const result: ChatCompletionToolMessageParam = {
		role: "tool",
		content: sanitizeSurrogates(toolResultText),
		tool_call_id: message.toolCallId,
	};
	if (compat.requiresToolResultName && message.toolName) (result as any).name = message.toolName;
	return result;
}

function collectOpenAIToolResultImages(
	message: ToolResultMessage,
	model: Model<"openai-completions">,
): ChatCompletionContentPartImage[] {
	if (!model.input.includes("image")) return [];
	return message.content.filter(isImageContentBlock).map((block) => ({
		type: "image_url",
		image_url: { url: `data:${block.mimeType};base64,${block.data}` },
	}));
}

interface OpenAIMessageConversionState {
	model: Model<"openai-completions">;
	compat: ResolvedOpenAICompletionsCompat;
	messages: Message[];
	params: ChatCompletionMessageParam[];
	lastRole: string | null;
}

function appendOpenAIToolResultBatch(state: OpenAIMessageConversionState, startIndex: number): number {
	const imageBlocks: ChatCompletionContentPartImage[] = [];
	let index = startIndex;
	for (; index < state.messages.length && state.messages[index].role === "toolResult"; index++) {
		const message = state.messages[index] as ToolResultMessage;
		state.params.push(convertOpenAIToolResultMessage(message, state.compat));
		imageBlocks.push(...collectOpenAIToolResultImages(message, state.model));
	}
	if (imageBlocks.length === 0) {
		state.lastRole = "toolResult";
		return index - 1;
	}
	if (state.compat.requiresAssistantAfterToolResult) {
		state.params.push({ role: "assistant", content: "I have processed the tool results." });
	}
	state.params.push({
		role: "user",
		content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...imageBlocks],
	});
	state.lastRole = "user";
	return index - 1;
}

function appendAssistantAfterToolResultBridge(state: OpenAIMessageConversionState, message: Message): void {
	if (state.compat.requiresAssistantAfterToolResult && state.lastRole === "toolResult" && message.role === "user") {
		state.params.push({ role: "assistant", content: "I have processed the tool results." });
	}
}

type OpenAINonToolMessage = UserMessage | AssistantMessage;

function convertOpenAINonToolMessage(
	message: OpenAINonToolMessage,
	state: OpenAIMessageConversionState,
): ChatCompletionUserMessageParam | ChatCompletionAssistantMessageParam | undefined {
	return message.role === "user"
		? convertOpenAIUserMessage(message)
		: convertOpenAIAssistantMessage(message, state.model, state.compat);
}

export function convertMessages(
	model: Model<"openai-completions">,
	context: Context,
	compat: ResolvedOpenAICompletionsCompat,
): ChatCompletionMessageParam[] {
	const params: ChatCompletionMessageParam[] = [];
	const transformedMessages = transformMessages(context.messages, model, (id) =>
		normalizeOpenAICompletionsToolCallId(model, id),
	);
	if (context.systemPrompt) {
		const role = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";
		params.push({ role, content: sanitizeSurrogates(context.systemPrompt) });
	}
	const state: OpenAIMessageConversionState = { model, compat, messages: transformedMessages, params, lastRole: null };
	for (let index = 0; index < transformedMessages.length; index++) {
		const message = transformedMessages[index];
		appendAssistantAfterToolResultBridge(state, message);
		if (message.role === "toolResult") {
			index = appendOpenAIToolResultBatch(state, index);
			continue;
		}
		const converted = convertOpenAINonToolMessage(message, state);
		if (!converted) continue;
		params.push(converted);
		state.lastRole = message.role;
	}
	return params;
}

function convertTools(
	tools: Tool[],
	compat: ResolvedOpenAICompletionsCompat,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as any, // TypeBox already generates JSON Schema
			// Only include strict if provider supports it. Some reject unknown fields.
			...(compat.supportsStrictMode !== false && { strict: false }),
		},
	}));
}

function parseChunkUsage(rawUsage: OpenAICompatibleChunkUsage, model: Model<"openai-completions">): Usage {
	const promptTokens = rawUsage.prompt_tokens || 0;
	const cacheReadTokens = rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? 0;
	const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;

	// Follow documented OpenAI/OpenRouter semantics: cached_tokens is cache-read
	// tokens (hits). OpenAI does not document or emit cache_write_tokens, but
	// OpenRouter-compatible providers can include it as a separate write count.
	// OpenRouter's own provider/tests affirm the separate mapping:
	// https://github.com/OpenRouterTeam/ai-sdk-provider/pull/409
	// Do not subtract writes from cached_tokens, otherwise spec-compliant
	// providers are under-reported. DS4 mirrors this contract too:
	// https://github.com/antirez/ds4/pull/29
	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	// OpenAI completion_tokens already includes reasoning_tokens.
	const outputTokens = rawUsage.completion_tokens || 0;
	const usage: Usage = {
		input,
		output: outputTokens,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

function mapStopReason(reason: OpenAICompatibleFinishReason): StopReasonMapping {
	if (reason === null) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
		case "network_error":
			return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
		default:
			return {
				stopReason: "error",
				errorMessage: `Provider finish_reason: ${reason}`,
			};
	}
}

/**
 * Detect compatibility settings from provider and baseUrl for known providers.
 * Provider takes precedence over URL-based detection since it's explicitly configured.
 * Returns a fully resolved OpenAICompletionsCompat object with all fields set.
 */
function matchesOpenAICompatibilityFamily(
	provider: string,
	baseUrl: string,
	providers: readonly string[],
	baseUrlFragments: readonly string[],
): boolean {
	return providers.includes(provider) || baseUrlFragments.some((fragment) => baseUrl.includes(fragment));
}

function detectOpenAIThinkingFormat(
	isDeepSeek: boolean,
	isZai: boolean,
	isTogether: boolean,
	isOpenRouter: boolean,
): OpenAICompletionsThinkingFormat {
	if (isDeepSeek) return "deepseek";
	if (isZai) return "zai";
	if (isTogether) return "together";
	return isOpenRouter ? "openrouter" : "openai";
}
function detectCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	const provider = model.provider;
	const baseUrl = model.baseUrl;
	const isZai = matchesOpenAICompatibilityFamily(
		provider,
		baseUrl,
		["zai", "zai-coding-cn"],
		["api.z.ai", "open.bigmodel.cn"],
	);
	const isTogether = matchesOpenAICompatibilityFamily(
		provider,
		baseUrl,
		["together"],
		["api.together.ai", "api.together.xyz"],
	);
	const isMoonshot = matchesOpenAICompatibilityFamily(
		provider,
		baseUrl,
		["moonshotai", "moonshotai-cn"],
		["api.moonshot."],
	);
	const isOpenRouter = matchesOpenAICompatibilityFamily(provider, baseUrl, ["openrouter"], ["openrouter.ai"]);
	const isCloudflareWorkersAI = matchesOpenAICompatibilityFamily(
		provider,
		baseUrl,
		["cloudflare-workers-ai"],
		["api.cloudflare.com"],
	);
	const isCloudflareAiGateway = matchesOpenAICompatibilityFamily(
		provider,
		baseUrl,
		["cloudflare-ai-gateway"],
		["gateway.ai.cloudflare.com"],
	);
	const isNonStandard = matchesOpenAICompatibilityFamily(
		provider,
		baseUrl,
		[
			"cerebras",
			"xai",
			"together",
			"zai",
			"zai-coding-cn",
			"moonshotai",
			"moonshotai-cn",
			"opencode",
			"cloudflare-workers-ai",
			"cloudflare-ai-gateway",
		],
		[
			"cerebras.ai",
			"api.x.ai",
			"api.together.ai",
			"api.together.xyz",
			"chutes.ai",
			"deepseek.com",
			"api.z.ai",
			"open.bigmodel.cn",
			"api.moonshot.",
			"opencode.ai",
			"api.cloudflare.com",
			"gateway.ai.cloudflare.com",
		],
	);
	const isDeepSeek = matchesOpenAICompatibilityFamily(provider, baseUrl, ["deepseek"], ["deepseek.com"]);
	const useMaxTokens = [
		baseUrl.includes("chutes.ai"),
		isDeepSeek,
		isZai,
		isMoonshot,
		isCloudflareAiGateway,
		isTogether,
	].some(Boolean);
	const isGrok = matchesOpenAICompatibilityFamily(provider, baseUrl, ["xai"], ["api.x.ai"]);
	const cacheControlFormat = provider === "openrouter" && model.id.startsWith("anthropic/") ? "anthropic" : undefined;

	return {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: ![isNonStandard, isOpenRouter].some(Boolean),
		supportsReasoningEffort: ![isGrok, isZai, isMoonshot, isTogether, isCloudflareAiGateway].some(Boolean),
		supportsUsageInStreaming: true,
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		requiresReasoningContentOnAssistantMessages: isDeepSeek,
		thinkingFormat: detectOpenAIThinkingFormat(isDeepSeek, isZai, isTogether, isOpenRouter),
		openRouterRouting: {},
		vercelGatewayRouting: {},
		zaiToolStream: false,
		supportsStrictMode: ![isMoonshot, isTogether, isCloudflareAiGateway].some(Boolean),
		cacheControlFormat,
		sendSessionAffinityHeaders: false,
		supportsLongCacheRetention: ![isTogether, isCloudflareWorkersAI, isCloudflareAiGateway].some(Boolean),
	};
}

function resolveOpenAICompatibilityValue<T>(configuredValue: T | null | undefined, detectedValue: T): T {
	return configuredValue ?? detectedValue;
}

/**
 * Get resolved compatibility settings for a model.
 * Uses explicit model.compat if provided, otherwise auto-detects from provider/URL.
 */
function getCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	const detected = detectCompat(model);
	const configured = model.compat;
	if (!configured) return detected;

	return {
		supportsStore: resolveOpenAICompatibilityValue(configured.supportsStore, detected.supportsStore),
		supportsDeveloperRole: resolveOpenAICompatibilityValue(
			configured.supportsDeveloperRole,
			detected.supportsDeveloperRole,
		),
		supportsReasoningEffort: resolveOpenAICompatibilityValue(
			configured.supportsReasoningEffort,
			detected.supportsReasoningEffort,
		),
		supportsUsageInStreaming: resolveOpenAICompatibilityValue(
			configured.supportsUsageInStreaming,
			detected.supportsUsageInStreaming,
		),
		maxTokensField: resolveOpenAICompatibilityValue(configured.maxTokensField, detected.maxTokensField),
		requiresToolResultName: resolveOpenAICompatibilityValue(
			configured.requiresToolResultName,
			detected.requiresToolResultName,
		),
		requiresAssistantAfterToolResult: resolveOpenAICompatibilityValue(
			configured.requiresAssistantAfterToolResult,
			detected.requiresAssistantAfterToolResult,
		),
		requiresThinkingAsText: resolveOpenAICompatibilityValue(
			configured.requiresThinkingAsText,
			detected.requiresThinkingAsText,
		),
		requiresReasoningContentOnAssistantMessages: resolveOpenAICompatibilityValue(
			configured.requiresReasoningContentOnAssistantMessages,
			detected.requiresReasoningContentOnAssistantMessages,
		),
		thinkingFormat: resolveOpenAICompatibilityValue(configured.thinkingFormat, detected.thinkingFormat),
		openRouterRouting: resolveOpenAICompatibilityValue(configured.openRouterRouting, {}),
		vercelGatewayRouting: resolveOpenAICompatibilityValue(
			configured.vercelGatewayRouting,
			detected.vercelGatewayRouting,
		),
		zaiToolStream: resolveOpenAICompatibilityValue(configured.zaiToolStream, detected.zaiToolStream),
		supportsStrictMode: resolveOpenAICompatibilityValue(configured.supportsStrictMode, detected.supportsStrictMode),
		cacheControlFormat: resolveOpenAICompatibilityValue(configured.cacheControlFormat, detected.cacheControlFormat),
		sendSessionAffinityHeaders: resolveOpenAICompatibilityValue(
			configured.sendSessionAffinityHeaders,
			detected.sendSessionAffinityHeaders,
		),
		supportsLongCacheRetention: resolveOpenAICompatibilityValue(
			configured.supportsLongCacheRetention,
			detected.supportsLongCacheRetention,
		),
	};
}
