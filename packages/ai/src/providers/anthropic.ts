import Anthropic from "@anthropic-ai/sdk";
import type {
	CacheControlEphemeral,
	ContentBlockParam,
	ImageBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
	RawContentBlockDeltaEvent,
	RawContentBlockStartEvent,
	RawContentBlockStopEvent,
	RawMessageDeltaEvent,
	RawMessageStartEvent,
	RawMessageStreamEvent,
	TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { getEnvApiKey } from "../env-api-keys.ts";
import { calculateCost } from "../models.ts";
import type {
	AnthropicMessagesCompat,
	Api,
	AssistantContent,
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ThinkingLevel,
	Tool,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

import { resolveCloudflareBaseUrl } from "./cloudflare.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { adjustMaxTokensForThinking, buildBaseOptions } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

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

interface ResolvedAnthropicCacheControl {
	retention: CacheRetention;
	cacheControl?: CacheControlEphemeral;
}

function getCacheControl(
	model: Model<"anthropic-messages">,
	cacheRetention?: CacheRetention,
): ResolvedAnthropicCacheControl {
	const retention = resolveCacheRetention(cacheRetention);
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

// Stealth mode: Mimic Claude Code's tool naming exactly
const claudeCodeVersion = "2.1.75";

// Claude Code 2.x tool names (canonical casing)
// Source: https://cchistory.mariozechner.at/data/prompts-2.1.11.md
// To update: https://github.com/badlogic/cchistory
const claudeCodeTools = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];

const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

// Convert tool name to CC canonical casing if it matches (case-insensitive)
const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;
const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
	if (tools && tools.length > 0) {
		const lowerName = name.toLowerCase();
		const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
		if (matchedTool) return matchedTool.name;
	}
	return name;
};

/**
 * Convert content blocks to Anthropic API format
 */
type AnthropicInputContent = string | Array<TextBlockParam | ImageBlockParam>;

function convertContentBlocks(content: (TextContent | ImageContent)[]): AnthropicInputContent {
	// If only text blocks, return as concatenated string for simplicity
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	// If we have images, convert to content block array
	const blocks = content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: sanitizeSurrogates(block.text),
			};
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});

	// If only images (no text), add placeholder text block
	const hasText = blocks.some((b) => b.type === "text");
	if (!hasText) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";
export type AnthropicToolChoice = "auto" | "any" | "none" | { type: "tool"; name: string };

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

function getAnthropicCompat(model: Model<"anthropic-messages">): Required<AnthropicMessagesCompat> {
	// Auto-detect session affinity and cache control support from provider
	const isFireworks = model.provider === "fireworks";
	const isCloudflareAiGatewayAnthropic =
		model.provider === "cloudflare-ai-gateway" && model.baseUrl.includes("anthropic");
	return {
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? !isFireworks,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? !isFireworks,
		sendSessionAffinityHeaders:
			model.compat?.sendSessionAffinityHeaders ?? !!(isFireworks || isCloudflareAiGatewayAnthropic),
		supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? !isFireworks,
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		forceAdaptiveThinking: model.compat?.forceAdaptiveThinking ?? false,
		allowEmptySignature: model.compat?.allowEmptySignature ?? false,
	};
}

export interface AnthropicOptions extends StreamOptions {
	/**
	 * Enable extended thinking.
	 * For Opus 4.6 and Sonnet 4.6: uses adaptive thinking (model decides when/how much to think).
	 * For older models: uses budget-based thinking with thinkingBudgetTokens.
	 */
	thinkingEnabled?: boolean;
	/**
	 * Token budget for extended thinking (older models only).
	 * Ignored for Opus 4.6 and Sonnet 4.6, which use adaptive thinking.
	 */
	thinkingBudgetTokens?: number;
	/**
	 * Effort level for adaptive thinking (Opus 4.6+ and Sonnet 4.6).
	 * Controls how much thinking Claude allocates:
	 * - "max": Always thinks with no constraints (Opus 4.6 only)
	 * - "xhigh": Highest reasoning level (Opus 4.7)
	 * - "high": Always thinks, deep reasoning (default)
	 * - "medium": Moderate thinking, may skip for simple queries
	 * - "low": Minimal thinking, skips for simple tasks
	 * Ignored for older models.
	 */
	effort?: AnthropicEffort;
	/**
	 * Controls how thinking content is returned in API responses.
	 * - "summarized": Thinking blocks contain summarized thinking text (default here).
	 * - "omitted": Thinking blocks return an empty thinking field; the encrypted
	 *   signature still travels back for multi-turn continuity. Use for faster
	 *   time-to-first-text-token when your UI does not surface thinking.
	 *
	 * Note: Anthropic's API default for Claude Opus 4.7 and Claude Mythos Preview
	 * is "omitted". We default to "summarized" here to keep behavior consistent
	 * with older Claude 4 models. Set this explicitly to "omitted" to opt in.
	 */
	thinkingDisplay?: AnthropicThinkingDisplay;
	interleavedThinking?: boolean;
	toolChoice?: AnthropicToolChoice;
	/**
	 * Pre-built Anthropic client instance. When provided, skips internal client
	 * construction entirely. Use this to inject alternative SDK clients such as
	 * `AnthropicVertex` that shares the same messaging API.
	 */
	client?: Anthropic;
}

function mergeHeaders(...headerSources: (ProviderHeaders | undefined)[]): ProviderHeaders {
	const merged: ProviderHeaders = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

interface SseDecoderState {
	event: string | null;
	data: string[];
	raw: string[];
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
	if (!state.event && state.data.length === 0) {
		return null;
	}

	const event: ServerSentEvent = {
		event: state.event,
		data: state.data.join("\n"),
		raw: [...state.raw],
	};
	state.event = null;
	state.data = [];
	state.raw = [];
	return event;
}

function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
	if (line === "") {
		return flushSseEvent(state);
	}

	state.raw.push(line);
	if (line.startsWith(":")) {
		return null;
	}

	const delimiterIndex = line.indexOf(":");
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		state.data.push(value);
	}

	return null;
}

function nextLineBreakIndex(text: string): number {
	const carriageReturnIndex = text.indexOf("\r");
	const newlineIndex = text.indexOf("\n");
	if (carriageReturnIndex === -1) {
		return newlineIndex;
	}
	if (newlineIndex === -1) {
		return carriageReturnIndex;
	}
	return Math.min(carriageReturnIndex, newlineIndex);
}

interface ConsumedSseLine {
	line: string;
	rest: string;
}

function consumeLine(text: string): ConsumedSseLine | null {
	const lineBreakIndex = nextLineBreakIndex(text);
	if (lineBreakIndex === -1) {
		return null;
	}

	let nextIndex = lineBreakIndex + 1;
	if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
		nextIndex += 1;
	}

	return {
		line: text.slice(0, lineBreakIndex),
		rest: text.slice(nextIndex),
	};
}

function* decodeCompleteSseLines(buffer: string, state: SseDecoderState): Generator<ServerSentEvent, string> {
	let consumed = consumeLine(buffer);
	while (consumed) {
		buffer = consumed.rest;
		const event = decodeSseLine(consumed.line, state);
		if (event) yield event;
		consumed = consumeLine(buffer);
	}
	return buffer;
}
async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SseDecoderState = { event: null, data: [], raw: [] };
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}

			const { value, done } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			buffer = yield* decodeCompleteSseLines(buffer, state);
		}

		buffer += decoder.decode();
		buffer = yield* decodeCompleteSseLines(buffer, state);

		if (buffer.length > 0) {
			const event = decodeSseLine(buffer, state);
			if (event) {
				yield event;
			}
		}

		const trailingEvent = flushSseEvent(state);
		if (trailingEvent) {
			yield trailingEvent;
		}
	} finally {
		reader.releaseLock();
	}
}
interface AnthropicMessageLifecycle {
	sawStart: boolean;
	sawEnd: boolean;
}

function* decodeAnthropicSseEvent(
	sse: ServerSentEvent,
	lifecycle: AnthropicMessageLifecycle,
): Generator<RawMessageStreamEvent> {
	try {
		const event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
		if (event.type === "message_start") lifecycle.sawStart = true;
		else if (event.type === "message_stop") lifecycle.sawEnd = true;
		yield event;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
		);
	}
}

async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
): AsyncGenerator<RawMessageStreamEvent> {
	if (!response.body) {
		throw new Error("Attempted to iterate over an Anthropic response with no body");
	}

	const lifecycle: AnthropicMessageLifecycle = { sawStart: false, sawEnd: false };

	for await (const sse of iterateSseMessages(response.body, signal)) {
		if (sse.event === "error") {
			throw new Error(sse.data);
		}

		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			continue;
		}

		yield* decodeAnthropicSseEvent(sse, lifecycle);
	}

	if (lifecycle.sawStart && !lifecycle.sawEnd) {
		throw new Error("Anthropic stream ended before message_stop");
	}
}

type CompletedAnthropicAssistantMessage = AssistantMessage & { stopReason: "stop" | "length" | "toolUse" };
type AnthropicStreamToolCall = ToolCall & { partialJson?: string };
type AnthropicStreamBlock = (ThinkingContent | TextContent | AnthropicStreamToolCall) & { index?: number };

interface AnthropicStreamState {
	output: AssistantMessage;
	blocks: AnthropicStreamBlock[];
	stream: AssistantMessageEventStream;
	model: Model<"anthropic-messages">;
	context: Context;
	isOAuth: boolean;
}

function createAnthropicStreamState(
	model: Model<"anthropic-messages">,
	context: Context,
	stream: AssistantMessageEventStream,
): AnthropicStreamState {
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api as Api,
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
	return { output, blocks: output.content as AnthropicStreamBlock[], stream, model, context, isOAuth: false };
}

function handleAnthropicMessageStart(event: RawMessageStartEvent, state: AnthropicStreamState): void {
	state.output.responseId = event.message.id;
	state.output.usage.input = event.message.usage.input_tokens || 0;
	state.output.usage.output = event.message.usage.output_tokens || 0;
	state.output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
	state.output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
	state.output.usage.totalTokens =
		state.output.usage.input +
		state.output.usage.output +
		state.output.usage.cacheRead +
		state.output.usage.cacheWrite;
	calculateCost(state.model, state.output.usage);
}

function handleAnthropicContentBlockStart(event: RawContentBlockStartEvent, state: AnthropicStreamState): void {
	const contentIndex = state.output.content.length;
	switch (event.content_block.type) {
		case "text": {
			const block: AnthropicStreamBlock = {
				type: "text",
				text: event.content_block.text ?? "",
				index: event.index,
			};
			state.output.content.push(block);
			state.stream.push({ type: "text_start", contentIndex, partial: state.output });
			return;
		}
		case "thinking": {
			const block: AnthropicStreamBlock = {
				type: "thinking",
				thinking: event.content_block.thinking ?? "",
				thinkingSignature: event.content_block.signature ?? "",
				index: event.index,
			};
			state.output.content.push(block);
			state.stream.push({ type: "thinking_start", contentIndex, partial: state.output });
			return;
		}
		case "redacted_thinking": {
			const block: AnthropicStreamBlock = {
				type: "thinking",
				thinking: "[Reasoning redacted]",
				thinkingSignature: event.content_block.data,
				redacted: true,
				index: event.index,
			};
			state.output.content.push(block);
			state.stream.push({ type: "thinking_start", contentIndex, partial: state.output });
			return;
		}
		case "tool_use": {
			const block: AnthropicStreamBlock = {
				type: "toolCall",
				id: event.content_block.id,
				name: state.isOAuth
					? fromClaudeCodeName(event.content_block.name, state.context.tools)
					: event.content_block.name,
				arguments: (event.content_block.input as Record<string, unknown>) ?? {},
				partialJson: "",
				index: event.index,
			};
			state.output.content.push(block);
			state.stream.push({ type: "toolcall_start", contentIndex, partial: state.output });
		}
	}
}

function handleAnthropicContentBlockDelta(event: RawContentBlockDeltaEvent, state: AnthropicStreamState): void {
	const index = state.blocks.findIndex((block) => block.index === event.index);
	const block = state.blocks[index];
	if (!block) return;

	switch (event.delta.type) {
		case "text_delta":
			if (block.type === "text") {
				block.text += event.delta.text;
				state.stream.push({
					type: "text_delta",
					contentIndex: index,
					delta: event.delta.text,
					partial: state.output,
				});
			}
			return;
		case "thinking_delta":
			if (block.type === "thinking") {
				block.thinking += event.delta.thinking;
				state.stream.push({
					type: "thinking_delta",
					contentIndex: index,
					delta: event.delta.thinking,
					partial: state.output,
				});
			}
			return;
		case "input_json_delta":
			if (block.type === "toolCall") {
				block.partialJson = (block.partialJson ?? "") + event.delta.partial_json;
				block.arguments = parseStreamingJson(block.partialJson);
				state.stream.push({
					type: "toolcall_delta",
					contentIndex: index,
					delta: event.delta.partial_json,
					partial: state.output,
				});
			}
			return;
		case "signature_delta":
			if (block.type === "thinking") {
				block.thinkingSignature = (block.thinkingSignature || "") + event.delta.signature;
			}
	}
}

function handleAnthropicContentBlockStop(event: RawContentBlockStopEvent, state: AnthropicStreamState): void {
	const index = state.blocks.findIndex((block) => block.index === event.index);
	const block = state.blocks[index];
	if (!block) return;
	delete block.index;

	switch (block.type) {
		case "text":
			state.stream.push({
				type: "text_end",
				contentIndex: index,
				content: block.text,
				partial: state.output,
			});
			return;
		case "thinking":
			state.stream.push({
				type: "thinking_end",
				contentIndex: index,
				content: block.thinking,
				partial: state.output,
			});
			return;
		case "toolCall":
			block.arguments = parseStreamingJson(block.partialJson ?? "");
			delete block.partialJson;
			state.stream.push({
				type: "toolcall_end",
				contentIndex: index,
				toolCall: block,
				partial: state.output,
			});
	}
}

function handleAnthropicMessageDelta(event: RawMessageDeltaEvent, state: AnthropicStreamState): void {
	if (event.delta.stop_reason) state.output.stopReason = mapStopReason(event.delta.stop_reason);
	if (event.usage.input_tokens != null) state.output.usage.input = event.usage.input_tokens;
	if (event.usage.output_tokens != null) state.output.usage.output = event.usage.output_tokens;
	if (event.usage.cache_read_input_tokens != null) {
		state.output.usage.cacheRead = event.usage.cache_read_input_tokens;
	}
	if (event.usage.cache_creation_input_tokens != null) {
		state.output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
	}
	state.output.usage.totalTokens =
		state.output.usage.input +
		state.output.usage.output +
		state.output.usage.cacheRead +
		state.output.usage.cacheWrite;
	calculateCost(state.model, state.output.usage);
}

function handleAnthropicStreamEvent(event: RawMessageStreamEvent, state: AnthropicStreamState): void {
	switch (event.type) {
		case "message_start":
			handleAnthropicMessageStart(event, state);
			return;
		case "content_block_start":
			handleAnthropicContentBlockStart(event, state);
			return;
		case "content_block_delta":
			handleAnthropicContentBlockDelta(event, state);
			return;
		case "content_block_stop":
			handleAnthropicContentBlockStop(event, state);
			return;
		case "message_delta":
			handleAnthropicMessageDelta(event, state);
	}
}

function resolveAnthropicStreamClient(
	model: Model<"anthropic-messages">,
	context: Context,
	options: AnthropicOptions | undefined,
): ConfiguredAnthropicClient {
	if (options?.client) return { client: options.client, isOAuthToken: false };
	const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
	const copilotDynamicHeaders =
		model.provider === "github-copilot"
			? buildCopilotDynamicHeaders({
					messages: context.messages,
					hasImages: hasCopilotVisionInput(context.messages),
				})
			: undefined;
	const cacheRetention = options?.cacheRetention ?? resolveCacheRetention();
	const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
	return createClient(
		model,
		apiKey,
		options?.interleavedThinking ?? true,
		shouldUseFineGrainedToolStreamingBeta(model, context),
		options?.headers,
		copilotDynamicHeaders,
		cacheSessionId,
	);
}

function validateAnthropicStreamCompletion(
	output: AssistantMessage,
	signal?: AbortSignal,
): asserts output is CompletedAnthropicAssistantMessage {
	if (signal?.aborted) throw new Error("Request was aborted");
	if (output.stopReason === "pending") throw new Error("Anthropic stream ended without a stop reason");
	if (output.stopReason === "aborted" || output.stopReason === "error") throw new Error("An unknown error occurred");
}

async function executeAnthropicStream(
	state: AnthropicStreamState,
	options: AnthropicOptions | undefined,
): Promise<void> {
	const configuredClient = resolveAnthropicStreamClient(state.model, state.context, options);
	state.isOAuth = configuredClient.isOAuthToken;
	let params = buildParams(state.model, state.context, state.isOAuth, options);
	const nextParams = await options?.onPayload?.(params, state.model);
	if (nextParams !== undefined) params = nextParams as MessageCreateParamsStreaming;
	const requestOptions = {
		...(options?.signal ? { signal: options.signal } : {}),
		...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
		maxRetries: 0,
	};
	const response = await retryProviderRequest(
		() => configuredClient.client.messages.create({ ...params, stream: true }, requestOptions).asResponse(),
		{
			maxRetries: options?.maxRetries,
			maxRetryDelayMs: options?.maxRetryDelayMs,
			signal: options?.signal,
		},
	);
	await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, state.model);
	state.stream.push({ type: "start", partial: state.output });
	for await (const event of iterateAnthropicEvents(response, options?.signal)) {
		handleAnthropicStreamEvent(event, state);
	}
	validateAnthropicStreamCompletion(state.output, options?.signal);
	state.stream.push({ type: "done", reason: state.output.stopReason, message: state.output });
	state.stream.end();
}

function handleAnthropicStreamFailure(
	error: unknown,
	options: AnthropicOptions | undefined,
	state: AnthropicStreamState,
): void {
	for (const block of state.blocks) {
		delete block.index;
		if (block.type === "toolCall") delete block.partialJson;
	}
	state.output.stopReason = options?.signal?.aborted ? "aborted" : "error";
	state.output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
	state.stream.push({ type: "error", reason: state.output.stopReason, error: state.output });
	state.stream.end();
}

export const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const state = createAnthropicStreamState(model, context, stream);
	(async () => {
		try {
			await executeAnthropicStream(state, options);
		} catch (error) {
			handleAnthropicStreamFailure(error, options, state);
		}
	})();
	return stream;
};

/**
 * Check if a model supports adaptive thinking (Opus 4.6+, Sonnet 4.6)
 */
function supportsAdaptiveThinking(modelId: string): boolean {
	// Adaptive-thinking model IDs (with or without date suffix)
	return (
		modelId.includes("opus-4-6") ||
		modelId.includes("opus-4.6") ||
		modelId.includes("opus-4-7") ||
		modelId.includes("opus-4.7") ||
		modelId.includes("sonnet-4-6") ||
		modelId.includes("sonnet-4.6")
	);
}

/**
 * Map ThinkingLevel to Anthropic effort levels for adaptive thinking.
 * Note: effort "max" is only valid on Opus 4.6, while Opus 4.7 supports "xhigh".
 */
function mapThinkingLevelToEffort(
	model: Model<"anthropic-messages">,
	level: ThinkingLevel | undefined,
): AnthropicEffort {
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as AnthropicEffort;

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

export const streamSimpleAnthropic: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, context, options, apiKey);
	if (!options?.reasoning) {
		return streamAnthropic(model, context, { ...base, thinkingEnabled: false } satisfies AnthropicOptions);
	}

	// For Opus 4.6 and Sonnet 4.6: use adaptive thinking with effort level
	// For older models: use budget-based thinking
	if (supportsAdaptiveThinking(model.id)) {
		const effort = mapThinkingLevelToEffort(model, options.reasoning);
		return streamAnthropic(model, context, {
			...base,
			thinkingEnabled: true,
			effort,
		} satisfies AnthropicOptions);
	}

	// Undefined means the caller did not request an output cap; let the helper use the model cap.
	// Do not coerce to 0 here, or the thinking budget would become the entire max_tokens value.
	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	return streamAnthropic(model, context, {
		...base,
		maxTokens: adjusted.maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: adjusted.thinkingBudget,
	} satisfies AnthropicOptions);
};

function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

interface ConfiguredAnthropicClient {
	client: Anthropic;
	isOAuthToken: boolean;
}

function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string,
	interleavedThinking: boolean,
	useFineGrainedToolStreamingBeta: boolean,
	optionsHeaders?: ProviderHeaders,
	dynamicHeaders?: Record<string, string>,
	sessionId?: string,
): ConfiguredAnthropicClient {
	// Adaptive thinking models (Opus 4.6, Sonnet 4.6) have interleaved thinking built-in.
	// The beta header is deprecated on Opus 4.6 and redundant on Sonnet 4.6, so skip it.
	const needsInterleavedBeta = interleavedThinking && !supportsAdaptiveThinking(model.id);
	const betaFeatures: string[] = [];
	if (useFineGrainedToolStreamingBeta) {
		betaFeatures.push(FINE_GRAINED_TOOL_STREAMING_BETA);
	}
	if (needsInterleavedBeta) {
		betaFeatures.push(INTERLEAVED_THINKING_BETA);
	}

	if (model.provider === "cloudflare-ai-gateway") {
		const client = new Anthropic({
			apiKey: null,
			authToken: null,
			baseURL: resolveCloudflareBaseUrl(model),
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"cf-aig-authorization": `Bearer ${apiKey}`,
					"x-api-key": null,
					Authorization: null,
					...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	// Copilot: Bearer auth, selective betas.
	if (model.provider === "github-copilot") {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
				},
				model.headers,
				dynamicHeaders,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	// OAuth: Bearer auth, Claude Code identity headers
	if (isOAuthToken(apiKey)) {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"anthropic-beta": ["claude-code-20250219", "oauth-2025-04-20", ...betaFeatures].join(","),
					"user-agent": `claude-cli/${claudeCodeVersion}`,
					"x-app": "cli",
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: true };
	}

	// API key auth
	const sessionAffinityHeaders: Record<string, string | null> =
		sessionId && getAnthropicCompat(model).sendSessionAffinityHeaders ? { "x-session-affinity": sessionId } : {};
	const client = new Anthropic({
		apiKey,
		authToken: null,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders: mergeHeaders(
			{
				accept: "application/json",
				"anthropic-dangerous-direct-browser-access": "true",
				...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
			},
			sessionAffinityHeaders,
			model.headers,
			optionsHeaders,
		),
	});

	return { client, isOAuthToken: false };
}

function applyAnthropicSystemPrompt(
	params: MessageCreateParamsStreaming,
	context: Context,
	isOAuthToken: boolean,
	cacheControl: CacheControlEphemeral | undefined,
): void {
	if (isOAuthToken) {
		params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
		if (context.systemPrompt) {
			params.system.push({
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			});
		}
		return;
	}
	if (!context.systemPrompt) return;
	params.system = [
		{
			type: "text",
			text: sanitizeSurrogates(context.systemPrompt),
			...(cacheControl ? { cache_control: cacheControl } : {}),
		},
	];
}

function applyAnthropicTemperature(
	params: MessageCreateParamsStreaming,
	options: AnthropicOptions | undefined,
	compat: Required<AnthropicMessagesCompat>,
): void {
	if (options?.temperature !== undefined && !options.thinkingEnabled && compat.supportsTemperature) {
		params.temperature = options.temperature;
	}
}

function applyAnthropicTools(
	params: MessageCreateParamsStreaming,
	context: Context,
	isOAuthToken: boolean,
	cacheControl: CacheControlEphemeral | undefined,
	compat: Required<AnthropicMessagesCompat>,
): void {
	if (!context.tools || context.tools.length === 0) return;
	params.tools = convertTools(
		context.tools,
		isOAuthToken,
		compat.supportsEagerToolInputStreaming,
		compat.supportsCacheControlOnTools ? cacheControl : undefined,
	);
}

function applyAdaptiveThinkingEffort(params: MessageCreateParamsStreaming, effort: AnthropicEffort | undefined): void {
	if (!effort) return;
	// The Anthropic SDK types can lag newly supported effort values such as "xhigh".
	params.output_config =
		effort === "xhigh"
			? ({ effort } as unknown as NonNullable<MessageCreateParamsStreaming["output_config"]>)
			: { effort };
}

function applyEnabledAnthropicThinking(
	params: MessageCreateParamsStreaming,
	model: Model<"anthropic-messages">,
	options: AnthropicOptions,
): void {
	const display: AnthropicThinkingDisplay = options.thinkingDisplay ?? "summarized";
	if (supportsAdaptiveThinking(model.id)) {
		params.thinking = { type: "adaptive", display };
		applyAdaptiveThinkingEffort(params, options.effort);
		return;
	}
	params.thinking = {
		type: "enabled",
		budget_tokens: options.thinkingBudgetTokens || 1024,
		display,
	};
}

function applyAnthropicThinking(
	params: MessageCreateParamsStreaming,
	model: Model<"anthropic-messages">,
	options: AnthropicOptions | undefined,
): void {
	if (!model.reasoning) return;
	if (options?.thinkingEnabled) {
		applyEnabledAnthropicThinking(params, model, options);
		return;
	}
	if (options?.thinkingEnabled === false) params.thinking = { type: "disabled" };
}

function applyAnthropicMetadata(params: MessageCreateParamsStreaming, options: AnthropicOptions | undefined): void {
	const userId = options?.metadata?.user_id;
	if (typeof userId === "string") params.metadata = { user_id: userId };
}

function applyAnthropicToolChoice(params: MessageCreateParamsStreaming, options: AnthropicOptions | undefined): void {
	if (!options?.toolChoice) return;
	params.tool_choice = typeof options.toolChoice === "string" ? { type: options.toolChoice } : options.toolChoice;
}

function buildParams(
	model: Model<"anthropic-messages">,
	context: Context,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
): MessageCreateParamsStreaming {
	const { cacheControl } = getCacheControl(model, options?.cacheRetention);
	const compat = getAnthropicCompat(model);
	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages: convertMessages(context.messages, model, isOAuthToken, cacheControl, compat.allowEmptySignature),
		max_tokens: options?.maxTokens ?? model.maxTokens,
		stream: true,
	};
	applyAnthropicSystemPrompt(params, context, isOAuthToken, cacheControl);
	applyAnthropicTemperature(params, options, compat);
	applyAnthropicTools(params, context, isOAuthToken, cacheControl, compat);
	applyAnthropicThinking(params, model, options);
	applyAnthropicMetadata(params, options);
	applyAnthropicToolChoice(params, options);
	return params;
}

// Normalize tool call IDs to match Anthropic's required pattern and length
function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertAnthropicUserMessage(message: UserMessage): MessageParam | undefined {
	if (typeof message.content === "string") {
		return message.content.trim().length > 0
			? { role: "user", content: sanitizeSurrogates(message.content) }
			: undefined;
	}
	const content: ContentBlockParam[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			if (block.text.trim().length > 0) content.push({ type: "text", text: sanitizeSurrogates(block.text) });
		} else {
			content.push({
				type: "image",
				source: {
					type: "base64",
					media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
					data: block.data,
				},
			});
		}
	}
	return content.length > 0 ? { role: "user", content } : undefined;
}

function convertAnthropicThinkingBlock(
	block: ThinkingContent,
	allowEmptySignature: boolean,
): ContentBlockParam | undefined {
	if (block.redacted) return { type: "redacted_thinking", data: block.thinkingSignature! };
	if (block.thinking.trim().length === 0) return undefined;
	if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
		return allowEmptySignature
			? { type: "thinking", thinking: sanitizeSurrogates(block.thinking), signature: "" }
			: { type: "text", text: sanitizeSurrogates(block.thinking) };
	}
	return {
		type: "thinking",
		thinking: sanitizeSurrogates(block.thinking),
		signature: block.thinkingSignature,
	};
}

function convertAnthropicAssistantBlock(
	block: AssistantContent,
	isOAuthToken: boolean,
	allowEmptySignature: boolean,
): ContentBlockParam | undefined {
	switch (block.type) {
		case "text":
			return block.text.trim().length > 0 ? { type: "text", text: sanitizeSurrogates(block.text) } : undefined;
		case "thinking":
			return convertAnthropicThinkingBlock(block, allowEmptySignature);
		case "toolCall":
			return {
				type: "tool_use",
				id: block.id,
				name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
				input: block.arguments ?? {},
			};
	}
}

function convertAnthropicAssistantMessage(
	message: AssistantMessage,
	isOAuthToken: boolean,
	allowEmptySignature: boolean,
): MessageParam | undefined {
	const content: ContentBlockParam[] = [];
	for (const block of message.content) {
		const converted = convertAnthropicAssistantBlock(block, isOAuthToken, allowEmptySignature);
		if (converted) content.push(converted);
	}
	return content.length > 0 ? { role: "assistant", content } : undefined;
}

function convertAnthropicToolResult(message: ToolResultMessage): ContentBlockParam {
	return {
		type: "tool_result",
		tool_use_id: message.toolCallId,
		content: convertContentBlocks(message.content),
		is_error: message.isError,
	};
}

interface AnthropicToolResultBatch {
	content: ContentBlockParam[];
	lastIndex: number;
}

function collectAnthropicToolResultBatch(messages: Message[], startIndex: number): AnthropicToolResultBatch {
	const content: ContentBlockParam[] = [];
	let lastIndex = startIndex;
	for (let index = startIndex; index < messages.length; index++) {
		const message = messages[index];
		if (message.role !== "toolResult") break;
		content.push(convertAnthropicToolResult(message));
		lastIndex = index;
	}
	return { content, lastIndex };
}

function applyAnthropicConversationCacheControl(
	params: MessageParam[],
	cacheControl: CacheControlEphemeral | undefined,
): void {
	if (!cacheControl || params.length === 0) return;
	const lastMessage = params[params.length - 1];
	if (lastMessage.role !== "user") return;
	if (Array.isArray(lastMessage.content)) {
		const lastBlock = lastMessage.content[lastMessage.content.length - 1];
		if (lastBlock && (lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")) {
			(lastBlock as any).cache_control = cacheControl;
		}
		return;
	}
	if (typeof lastMessage.content === "string") {
		lastMessage.content = [{ type: "text", text: lastMessage.content, cache_control: cacheControl }] as any;
	}
}

function convertMessages(
	messages: Message[],
	model: Model<"anthropic-messages">,
	isOAuthToken: boolean,
	cacheControl?: CacheControlEphemeral,
	allowEmptySignature = false,
): MessageParam[] {
	const params: MessageParam[] = [];
	const transformedMessages = transformMessages(messages, model, normalizeToolCallId);
	for (let index = 0; index < transformedMessages.length; index++) {
		const message = transformedMessages[index];
		switch (message.role) {
			case "user": {
				const converted = convertAnthropicUserMessage(message);
				if (converted) params.push(converted);
				break;
			}
			case "assistant": {
				const converted = convertAnthropicAssistantMessage(message, isOAuthToken, allowEmptySignature);
				if (converted) params.push(converted);
				break;
			}
			case "toolResult": {
				const batch = collectAnthropicToolResultBatch(transformedMessages, index);
				params.push({ role: "user", content: batch.content });
				index = batch.lastIndex;
				break;
			}
		}
	}
	applyAnthropicConversationCacheControl(params, cacheControl);
	return params;
}

function shouldUseFineGrainedToolStreamingBeta(model: Model<"anthropic-messages">, context: Context): boolean {
	return !!context.tools?.length && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}

function convertTools(
	tools: Tool[],
	isOAuthToken: boolean,
	supportsEagerToolInputStreaming: boolean,
	cacheControl?: CacheControlEphemeral,
): Anthropic.Messages.Tool[] {
	if (!tools) return [];

	return tools.map((tool, index) => {
		const schema = tool.parameters as { properties?: unknown; required?: string[] };

		return {
			name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
			description: tool.description,
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			input_schema: {
				type: "object",
				properties: schema.properties ?? {},
				required: schema.required ?? [],
			},
			...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
		};
	});
}

function mapStopReason(reason: Anthropic.Messages.StopReason | string): StopReason {
	switch (reason) {
		case "end_turn":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		case "refusal":
			return "error";
		case "pause_turn": // Stop is good enough -> resubmit
			return "stop";
		case "stop_sequence":
			return "stop"; // We don't supply stop sequences, so this should never happen
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return "error";
		default:
			// Handle unknown stop reasons gracefully (API may add new values)
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}
