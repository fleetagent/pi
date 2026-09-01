import { Mistral } from "@mistralai/mistralai";
import type { RequestOptions } from "@mistralai/mistralai/lib/sdks.js";
import type {
	ChatCompletionStreamRequest,
	ChatCompletionStreamRequestMessage,
	ChatCompletionStreamRequestToolChoice,
	CompletionChunk,
	CompletionEvent,
	CompletionResponseStreamChoice,
	ContentChunk,
	DeltaMessageContent,
	FunctionName,
	FunctionTool,
	ToolCall as MistralToolCall,
} from "@mistralai/mistralai/models/components";
import { getEnvApiKey } from "../env-api-keys.ts";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	Context,
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
import { shortHash } from "../utils/hash.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { buildBaseOptions } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

const MISTRAL_TOOL_CALL_ID_LENGTH = 9;
const MAX_MISTRAL_ERROR_BODY_CHARS = 4000;

/**
 * Provider-specific options for the Mistral API.
 */
type MistralReasoningEffort = "none" | "high";

export interface MistralFunctionToolChoice {
	type: "function";
	function: FunctionName;
}

export type MistralToolChoice = "auto" | "none" | "any" | "required" | MistralFunctionToolChoice;

export interface MistralOptions extends StreamOptions {
	toolChoice?: MistralToolChoice;
	promptMode?: "reasoning";
	reasoningEffort?: MistralReasoningEffort;
}

/**
 * Stream responses from Mistral using `chat.stream`.
 */
export const streamMistral: StreamFunction<"mistral-conversations", MistralOptions> = (
	model: Model<"mistral-conversations">,
	context: Context,
	options?: MistralOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output = createOutput(model);

		try {
			const mistralStream = await startMistralChatStream(model, context, options);
			stream.push({ type: "start", partial: output });
			await consumeChatStream(model, output, stream, mistralStream);
			finishMistralChatStream(output, stream, options?.signal);
		} catch (error) {
			failMistralChatStream(output, stream, error, options?.signal);
		}
	})();

	return stream;
};

async function startMistralChatStream(
	model: Model<"mistral-conversations">,
	context: Context,
	options?: MistralOptions,
): Promise<AsyncIterable<CompletionEvent>> {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	const mistral = new Mistral({ apiKey, serverURL: model.baseUrl });
	const normalizeMistralToolCallId = createMistralToolCallIdNormalizer();
	const transformedMessages = transformMessages(context.messages, model, normalizeMistralToolCallId);
	let payload = buildChatPayload(model, context, transformedMessages, options);
	const nextPayload = await options?.onPayload?.(payload, model);
	if (nextPayload !== undefined) payload = nextPayload as ChatCompletionStreamRequest;
	return mistral.chat.stream(payload, buildRequestOptions(model, options));
}

function finishMistralChatStream(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	signal?: AbortSignal,
): void {
	if (signal?.aborted) throw new Error("Request was aborted");
	if (output.stopReason === "pending") throw new Error("Mistral stream ended without a finish reason");
	if (output.stopReason === "aborted" || output.stopReason === "error") {
		throw new Error("An unknown error occurred");
	}
	stream.push({ type: "done", reason: output.stopReason, message: output });
	stream.end();
}

function failMistralChatStream(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	error: unknown,
	signal?: AbortSignal,
): void {
	for (const block of output.content) {
		// partialArgs is only a streaming scratch buffer; never persist it.
		delete (block as { partialArgs?: string }).partialArgs;
	}
	output.stopReason = signal?.aborted ? "aborted" : "error";
	output.errorMessage = formatMistralError(error);
	stream.push({ type: "error", reason: output.stopReason, error: output });
	stream.end();
}

/**
 * Maps provider-agnostic `SimpleStreamOptions` to Mistral options.
 */
export const streamSimpleMistral: StreamFunction<"mistral-conversations", SimpleStreamOptions> = (
	model: Model<"mistral-conversations">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, context, options, apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoning = clampedReasoning === "off" ? undefined : clampedReasoning;
	const shouldUseReasoning = model.reasoning && reasoning !== undefined;

	return streamMistral(model, context, {
		...base,
		promptMode: shouldUseReasoning && usesPromptModeReasoning(model) ? "reasoning" : undefined,
		reasoningEffort:
			shouldUseReasoning && usesReasoningEffort(model) ? mapReasoningEffort(model, reasoning) : undefined,
	} satisfies MistralOptions);
};

function createOutput(model: Model<"mistral-conversations">): AssistantMessage {
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

function createMistralToolCallIdNormalizer(): (id: string) => string {
	const idMap = new Map<string, string>();
	const reverseMap = new Map<string, string>();

	return (id: string): string => {
		const existing = idMap.get(id);
		if (existing) return existing;

		let attempt = 0;
		while (true) {
			const candidate = deriveMistralToolCallId(id, attempt);
			const owner = reverseMap.get(candidate);
			if (!owner || owner === id) {
				idMap.set(id, candidate);
				reverseMap.set(candidate, id);
				return candidate;
			}
			attempt++;
		}
	};
}

function deriveMistralToolCallId(id: string, attempt: number): string {
	const normalized = id.replace(/[^a-zA-Z0-9]/g, "");
	if (attempt === 0 && normalized.length === MISTRAL_TOOL_CALL_ID_LENGTH) return normalized;
	const seedBase = normalized || id;
	const seed = attempt === 0 ? seedBase : `${seedBase}:${attempt}`;
	return shortHash(seed)
		.replace(/[^a-zA-Z0-9]/g, "")
		.slice(0, MISTRAL_TOOL_CALL_ID_LENGTH);
}

function formatMistralError(error: unknown): string {
	if (error instanceof Error) {
		const sdkError = error as Error & { statusCode?: unknown; body?: unknown };
		const statusCode = typeof sdkError.statusCode === "number" ? sdkError.statusCode : undefined;
		const bodyText = typeof sdkError.body === "string" ? sdkError.body.trim() : undefined;
		if (statusCode !== undefined && bodyText) {
			return `Mistral API error (${statusCode}): ${truncateErrorText(bodyText, MAX_MISTRAL_ERROR_BODY_CHARS)}`;
		}
		if (statusCode !== undefined) return `Mistral API error (${statusCode}): ${error.message}`;
		return error.message;
	}
	return safeJsonStringify(error);
}

function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}

function buildRequestOptions(model: Model<"mistral-conversations">, options?: MistralOptions): RequestOptions {
	const requestOptions: RequestOptions = {
		retries: { strategy: "none" },
	};
	if (options?.signal) requestOptions.signal = options.signal;

	const explicitHeaders: ProviderHeaders = { ...model.headers, ...options?.headers };
	const hasExplicitAffinity = Object.keys(explicitHeaders).some((name) => name.toLowerCase() === "x-affinity");
	const headers = providerHeadersToRecord(explicitHeaders) ?? {};

	// Mistral infrastructure uses `x-affinity` for KV-cache reuse (prefix caching).
	// Respect explicit caller-provided header values.
	if (options?.sessionId && !hasExplicitAffinity) {
		headers["x-affinity"] = options.sessionId;
	}

	if (Object.keys(headers).length > 0) {
		requestOptions.headers = headers;
	}

	return requestOptions;
}

function buildChatPayload(
	model: Model<"mistral-conversations">,
	context: Context,
	messages: Message[],
	options?: MistralOptions,
): ChatCompletionStreamRequest {
	const payload: ChatCompletionStreamRequest = {
		model: model.id,
		stream: true,
		messages: toChatMessages(messages, model.input.includes("image")),
	};

	if (context.tools?.length) payload.tools = toFunctionTools(context.tools);
	if (options?.temperature !== undefined) payload.temperature = options.temperature;
	if (options?.maxTokens !== undefined) payload.maxTokens = options.maxTokens;
	if (options?.toolChoice) payload.toolChoice = mapToolChoice(options.toolChoice);
	if (options?.promptMode) payload.promptMode = options.promptMode;
	if (options?.reasoningEffort) payload.reasoningEffort = options.reasoningEffort;

	if (context.systemPrompt) {
		payload.messages.unshift({
			role: "system",
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	return payload;
}

type MistralContentBlock = TextContent | ThinkingContent;

type StreamingMistralToolBlock = ToolCall & {
	partialArgs?: string;
};

interface MistralChatStreamState {
	model: Model<"mistral-conversations">;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	currentBlock: MistralContentBlock | null;
	toolBlocksByKey: Map<string, number>;
}

interface ResolvedMistralToolBlock {
	block: StreamingMistralToolBlock;
	index: number;
}

function currentMistralBlockIndex(state: MistralChatStreamState): number {
	return state.output.content.length - 1;
}

function finishCurrentMistralBlock(state: MistralChatStreamState): void {
	const block = state.currentBlock;
	if (!block) return;
	if (block.type === "text") {
		state.stream.push({
			type: "text_end",
			contentIndex: currentMistralBlockIndex(state),
			content: block.text,
			partial: state.output,
		});
	} else {
		state.stream.push({
			type: "thinking_end",
			contentIndex: currentMistralBlockIndex(state),
			content: block.thinking,
			partial: state.output,
		});
	}
	state.currentBlock = null;
}

function appendMistralTextDelta(state: MistralChatStreamState, delta: string): void {
	let block = state.currentBlock;
	if (block?.type !== "text") {
		finishCurrentMistralBlock(state);
		block = { type: "text", text: "" };
		state.currentBlock = block;
		state.output.content.push(block);
		state.stream.push({
			type: "text_start",
			contentIndex: currentMistralBlockIndex(state),
			partial: state.output,
		});
	}
	block.text += delta;
	state.stream.push({
		type: "text_delta",
		contentIndex: currentMistralBlockIndex(state),
		delta,
		partial: state.output,
	});
}

function appendMistralThinkingDelta(state: MistralChatStreamState, delta: string): void {
	let block = state.currentBlock;
	if (block?.type !== "thinking") {
		finishCurrentMistralBlock(state);
		block = { type: "thinking", thinking: "" };
		state.currentBlock = block;
		state.output.content.push(block);
		state.stream.push({
			type: "thinking_start",
			contentIndex: currentMistralBlockIndex(state),
			partial: state.output,
		});
	}
	block.thinking += delta;
	state.stream.push({
		type: "thinking_delta",
		contentIndex: currentMistralBlockIndex(state),
		delta,
		partial: state.output,
	});
}

function consumeMistralContentDelta(
	state: MistralChatStreamState,
	content: DeltaMessageContent | null | undefined,
): void {
	if (content === null || content === undefined) return;
	const items = typeof content === "string" ? [content] : content;
	for (const item of items) {
		if (typeof item === "string") {
			appendMistralTextDelta(state, sanitizeSurrogates(item));
			continue;
		}
		if (item.type === "thinking") {
			const delta = item.thinking
				.map((part) => ("text" in part ? part.text : ""))
				.filter((text) => text.length > 0)
				.join("");
			const sanitized = sanitizeSurrogates(delta);
			if (sanitized) appendMistralThinkingDelta(state, sanitized);
			continue;
		}
		if (item.type === "text") appendMistralTextDelta(state, sanitizeSurrogates(item.text));
	}
}

function updateMistralChunkMetadata(state: MistralChatStreamState, chunk: CompletionChunk): void {
	state.output.responseId ||= chunk.id;
	if (!chunk.usage) return;
	state.output.usage.input = chunk.usage.promptTokens || 0;
	state.output.usage.output = chunk.usage.completionTokens || 0;
	state.output.usage.cacheRead = 0;
	state.output.usage.cacheWrite = 0;
	state.output.usage.totalTokens = chunk.usage.totalTokens || state.output.usage.input + state.output.usage.output;
	calculateCost(state.model, state.output.usage);
}

function resolveMistralToolBlock(state: MistralChatStreamState, toolCall: MistralToolCall): ResolvedMistralToolBlock {
	const callId =
		toolCall.id && toolCall.id !== "null"
			? toolCall.id
			: deriveMistralToolCallId(`toolcall:${toolCall.index ?? 0}`, 0);
	const key = `${callId}:${toolCall.index || 0}`;
	const existingIndex = state.toolBlocksByKey.get(key);
	if (existingIndex !== undefined) {
		const existing = state.output.content[existingIndex];
		if (existing?.type === "toolCall") {
			return { block: existing as StreamingMistralToolBlock, index: existingIndex };
		}
	}
	const block: StreamingMistralToolBlock = {
		type: "toolCall",
		id: callId,
		name: toolCall.function.name,
		arguments: {},
		partialArgs: "",
	};
	state.output.content.push(block);
	const index = state.output.content.length - 1;
	state.toolBlocksByKey.set(key, index);
	state.stream.push({ type: "toolcall_start", contentIndex: index, partial: state.output });
	return { block, index };
}

function consumeMistralToolCall(state: MistralChatStreamState, toolCall: MistralToolCall): void {
	finishCurrentMistralBlock(state);
	const { block, index } = resolveMistralToolBlock(state, toolCall);
	const argsDelta =
		typeof toolCall.function.arguments === "string"
			? toolCall.function.arguments
			: JSON.stringify(toolCall.function.arguments || {});
	block.partialArgs = (block.partialArgs || "") + argsDelta;
	block.arguments = parseStreamingJson<Record<string, unknown>>(block.partialArgs);
	state.stream.push({
		type: "toolcall_delta",
		contentIndex: index,
		delta: argsDelta,
		partial: state.output,
	});
}

function consumeMistralChoice(state: MistralChatStreamState, choice: CompletionResponseStreamChoice): void {
	if (choice.finishReason) state.output.stopReason = mapChatStopReason(choice.finishReason);
	consumeMistralContentDelta(state, choice.delta.content);
	for (const toolCall of choice.delta.toolCalls || []) consumeMistralToolCall(state, toolCall);
}

function finalizeMistralToolCalls(state: MistralChatStreamState): void {
	for (const index of state.toolBlocksByKey.values()) {
		const block = state.output.content[index];
		if (block.type !== "toolCall") continue;
		const toolBlock = block as StreamingMistralToolBlock;
		toolBlock.arguments = parseStreamingJson<Record<string, unknown>>(toolBlock.partialArgs);
		delete toolBlock.partialArgs;
		state.stream.push({
			type: "toolcall_end",
			contentIndex: index,
			toolCall: toolBlock,
			partial: state.output,
		});
	}
}

async function consumeChatStream(
	model: Model<"mistral-conversations">,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	mistralStream: AsyncIterable<CompletionEvent>,
): Promise<void> {
	const state: MistralChatStreamState = {
		model,
		output,
		stream,
		currentBlock: null,
		toolBlocksByKey: new Map(),
	};
	for await (const event of mistralStream) {
		const chunk = event.data;
		updateMistralChunkMetadata(state, chunk);
		const choice = chunk.choices[0];
		if (choice) consumeMistralChoice(state, choice);
	}
	finishCurrentMistralBlock(state);
	finalizeMistralToolCalls(state);
}

function toFunctionTools(tools: Tool[]): FunctionTool[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: stripSymbolKeys(tool.parameters) as Record<string, unknown>,
			strict: false,
		},
	}));
}

function stripSymbolKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => stripSymbolKeys(item));
	}

	if (value && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			result[key] = stripSymbolKeys(entry);
		}
		return result;
	}

	return value;
}

function convertMistralUserMessage(
	message: UserMessage,
	supportsImages: boolean,
): ChatCompletionStreamRequestMessage | undefined {
	if (typeof message.content === "string") {
		return { role: "user", content: sanitizeSurrogates(message.content) };
	}
	const hadImages = message.content.some((item) => item.type === "image");
	const content: ContentChunk[] = message.content
		.filter((item) => item.type === "text" || supportsImages)
		.map((item) => {
			if (item.type === "text") return { type: "text", text: sanitizeSurrogates(item.text) };
			return { type: "image_url", imageUrl: `data:${item.mimeType};base64,${item.data}` };
		});
	if (content.length > 0) return { role: "user", content };
	return hadImages && !supportsImages
		? { role: "user", content: "(image omitted: model does not support images)" }
		: undefined;
}

function convertMistralAssistantMessage(message: AssistantMessage): ChatCompletionStreamRequestMessage | undefined {
	const contentParts: ContentChunk[] = [];
	const toolCalls: MistralToolCall[] = [];
	for (const block of message.content) {
		switch (block.type) {
			case "text":
				if (block.text.trim().length > 0) {
					contentParts.push({ type: "text", text: sanitizeSurrogates(block.text) });
				}
				break;
			case "thinking":
				if (block.thinking.trim().length > 0) {
					contentParts.push({
						type: "thinking",
						thinking: [{ type: "text", text: sanitizeSurrogates(block.thinking) }],
					});
				}
				break;
			case "toolCall":
				toolCalls.push({
					id: block.id,
					type: "function",
					function: { name: block.name, arguments: JSON.stringify(block.arguments || {}) },
				});
				break;
		}
	}

	const assistantMessage: ChatCompletionStreamRequestMessage = { role: "assistant" };
	if (contentParts.length > 0) assistantMessage.content = contentParts;
	if (toolCalls.length > 0) assistantMessage.toolCalls = toolCalls;
	return contentParts.length > 0 || toolCalls.length > 0 ? assistantMessage : undefined;
}

function convertMistralToolResultMessage(
	message: ToolResultMessage,
	supportsImages: boolean,
): ChatCompletionStreamRequestMessage {
	const toolContent: ContentChunk[] = [];
	const textResult = message.content
		.filter((part) => part.type === "text")
		.map((part) => (part.type === "text" ? sanitizeSurrogates(part.text) : ""))
		.join("\n");
	const hasImages = message.content.some((part) => part.type === "image");
	const toolText = buildToolResultText(textResult, hasImages, supportsImages, message.isError);
	toolContent.push({ type: "text", text: toolText });
	for (const part of message.content) {
		if (!supportsImages) continue;
		if (part.type !== "image") continue;
		toolContent.push({
			type: "image_url",
			imageUrl: `data:${part.mimeType};base64,${part.data}`,
		});
	}
	return {
		role: "tool",
		toolCallId: message.toolCallId,
		name: message.toolName,
		content: toolContent,
	};
}

function toChatMessages(messages: Message[], supportsImages: boolean): ChatCompletionStreamRequestMessage[] {
	const result: ChatCompletionStreamRequestMessage[] = [];
	for (const message of messages) {
		const converted =
			message.role === "user"
				? convertMistralUserMessage(message, supportsImages)
				: message.role === "assistant"
					? convertMistralAssistantMessage(message)
					: convertMistralToolResultMessage(message, supportsImages);
		if (converted) result.push(converted);
	}
	return result;
}

function buildToolResultText(text: string, hasImages: boolean, supportsImages: boolean, isError: boolean): string {
	const trimmed = text.trim();
	const errorPrefix = isError ? "[tool error] " : "";

	if (trimmed.length > 0) {
		const imageSuffix = hasImages && !supportsImages ? "\n[tool image omitted: model does not support images]" : "";
		return `${errorPrefix}${trimmed}${imageSuffix}`;
	}

	if (hasImages) {
		if (supportsImages) {
			return isError ? "[tool error] (see attached image)" : "(see attached image)";
		}
		return isError
			? "[tool error] (image omitted: model does not support images)"
			: "(image omitted: model does not support images)";
	}

	return isError ? "[tool error] (no tool output)" : "(no tool output)";
}

function usesReasoningEffort(model: Model<"mistral-conversations">): boolean {
	return model.id === "mistral-small-2603" || model.id === "mistral-small-latest" || model.id === "mistral-medium-3.5";
}

function usesPromptModeReasoning(model: Model<"mistral-conversations">): boolean {
	return model.reasoning && !usesReasoningEffort(model);
}

function mapReasoningEffort(model: Model<"mistral-conversations">, level: ThinkingLevel): MistralReasoningEffort {
	return (model.thinkingLevelMap?.[level] ?? "high") as MistralReasoningEffort;
}

function mapToolChoice(choice: MistralToolChoice | undefined): ChatCompletionStreamRequestToolChoice | undefined {
	if (!choice) return undefined;
	if (choice === "auto" || choice === "none" || choice === "any" || choice === "required") {
		return choice;
	}
	return {
		type: "function",
		function: { name: choice.function.name },
	};
}

function mapChatStopReason(reason: string | null): StopReason {
	if (reason === null) return "stop";
	switch (reason) {
		case "stop":
			return "stop";
		case "length":
		case "model_length":
			return "length";
		case "tool_calls":
			return "toolUse";
		case "error":
			return "error";
		default:
			return "stop";
	}
}
