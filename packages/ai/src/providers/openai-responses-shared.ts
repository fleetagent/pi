import type OpenAI from "openai";
import type {
	Response as OpenAIResponse,
	Tool as OpenAITool,
	ResponseFunctionCallOutputItemList,
	ResponseFunctionToolCall,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputText,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	StopReason,
	TextContent,
	TextSignaturePhase,
	TextSignatureV1,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { transformMessages } from "./transform-messages.ts";

// =============================================================================
// Utilities
// =============================================================================

interface ParsedTextSignature {
	id: string;
	phase?: TextSignaturePhase;
}

function encodeTextSignatureV1(id: string, phase?: TextSignaturePhase): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

function parseTextSignature(signature: string | undefined): ParsedTextSignature | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

export type OpenAIResponseServiceTier = "auto" | "default" | "flex" | "scale" | "priority" | null;

export interface OpenAIResponsesStreamOptions {
	serviceTier?: OpenAIResponseServiceTier;
	resolveServiceTier?: (
		responseServiceTier: OpenAIResponseServiceTier | undefined,
		requestServiceTier: OpenAIResponseServiceTier | undefined,
	) => OpenAIResponseServiceTier | undefined;
	applyServiceTierPricing?: (usage: Usage, serviceTier: OpenAIResponseServiceTier | undefined) => void;
}

export interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean;
}

export interface ConvertResponsesToolsOptions {
	strict?: boolean | null;
}

// =============================================================================
// Message conversion
// =============================================================================

function normalizeResponsesIdPart(part: string): string {
	const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
	const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
	return normalized.replace(/_+$/, "");
}

function buildForeignResponsesItemId(itemId: string): string {
	const normalized = `fc_${shortHash(itemId)}`;
	return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
}

function normalizeResponsesToolCallId<TApi extends Api>(
	id: string,
	model: Model<TApi>,
	source: AssistantMessage,
	allowedToolCallProviders: ReadonlySet<string>,
): string {
	if (!allowedToolCallProviders.has(model.provider)) return normalizeResponsesIdPart(id);
	if (!id.includes("|")) return normalizeResponsesIdPart(id);
	const [callId, itemId] = id.split("|");
	const normalizedCallId = normalizeResponsesIdPart(callId);
	const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
	let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId) : normalizeResponsesIdPart(itemId);
	// OpenAI Responses API requires item IDs to start with "fc".
	if (!normalizedItemId.startsWith("fc_")) normalizedItemId = normalizeResponsesIdPart(`fc_${normalizedItemId}`);
	return `${normalizedCallId}|${normalizedItemId}`;
}

function convertResponsesUserMessage(message: UserMessage): ResponseInput {
	if (typeof message.content === "string") {
		return [
			{
				role: "user",
				content: [{ type: "input_text", text: sanitizeSurrogates(message.content) }],
			},
		];
	}
	const content: ResponseInputContent[] = message.content.map((item): ResponseInputContent => {
		if (item.type === "text") {
			return {
				type: "input_text",
				text: sanitizeSurrogates(item.text),
			} satisfies ResponseInputText;
		}
		return {
			type: "input_image",
			detail: "auto",
			image_url: `data:${item.mimeType};base64,${item.data}`,
		} satisfies ResponseInputImage;
	});
	return content.length === 0 ? [] : [{ role: "user", content }];
}

function resolveResponsesMessageId(
	textBlock: TextContent,
	messageIndex: number,
	textBlockIndex: number,
): ParsedTextSignature {
	const parsedSignature = parseTextSignature(textBlock.textSignature);
	const fallbackId = textBlockIndex === 0 ? `msg_pi_${messageIndex}` : `msg_pi_${messageIndex}_${textBlockIndex}`;
	if (!parsedSignature?.id) return { id: fallbackId };
	return {
		...parsedSignature,
		id: parsedSignature.id.length > 64 ? `msg_${shortHash(parsedSignature.id)}` : parsedSignature.id,
	};
}

function convertResponsesTextBlock(
	block: TextContent,
	messageIndex: number,
	textBlockIndex: number,
): ResponseOutputMessage {
	const signature = resolveResponsesMessageId(block, messageIndex, textBlockIndex);
	return {
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] }],
		status: "completed",
		id: signature.id,
		phase: signature.phase,
	};
}

function convertResponsesToolCall(block: ToolCall, isDifferentModel: boolean): ResponseFunctionToolCall {
	const [callId, rawItemId] = block.id.split("|");
	const itemId = isDifferentModel && rawItemId?.startsWith("fc_") ? undefined : rawItemId;
	return {
		type: "function_call",
		id: itemId,
		call_id: callId,
		name: block.name,
		arguments: JSON.stringify(block.arguments),
	};
}

function convertResponsesAssistantMessage<TApi extends Api>(
	message: AssistantMessage,
	model: Model<TApi>,
	messageIndex: number,
): ResponseInput {
	const output: ResponseInput = [];
	const isDifferentModel =
		message.model !== model.id && message.provider === model.provider && message.api === model.api;
	let textBlockIndex = 0;
	for (const block of message.content) {
		if (block.type === "thinking") {
			if (block.thinkingSignature) output.push(JSON.parse(block.thinkingSignature) as ResponseReasoningItem);
			continue;
		}
		if (block.type === "text") {
			output.push(convertResponsesTextBlock(block, messageIndex, textBlockIndex));
			textBlockIndex++;
			continue;
		}
		if (block.type === "toolCall") output.push(convertResponsesToolCall(block, isDifferentModel));
	}
	return output;
}

function buildResponsesToolOutput(
	message: ToolResultMessage,
	supportsImages: boolean,
): string | ResponseFunctionCallOutputItemList {
	const textResult = message.content
		.filter((content): content is TextContent => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	const hasImages = message.content.some((content): content is ImageContent => content.type === "image");
	const hasText = textResult.length > 0;
	if (!hasImages || !supportsImages) {
		return sanitizeSurrogates(hasText ? textResult : hasImages ? "(see attached image)" : "(no tool output)");
	}
	const contentParts: ResponseFunctionCallOutputItemList = [];
	if (hasText) contentParts.push({ type: "input_text", text: sanitizeSurrogates(textResult) });
	for (const block of message.content) {
		if (block.type !== "image") continue;
		contentParts.push({
			type: "input_image",
			detail: "auto",
			image_url: `data:${block.mimeType};base64,${block.data}`,
		});
	}
	return contentParts;
}

function convertResponsesToolResult<TApi extends Api>(message: ToolResultMessage, model: Model<TApi>): ResponseInput {
	const [callId] = message.toolCallId.split("|");
	return [
		{
			type: "function_call_output",
			call_id: callId,
			output: buildResponsesToolOutput(message, model.input.includes("image")),
		},
	];
}

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const messages: ResponseInput = [];
	const normalizeToolCallId = (id: string, _targetModel: Model<TApi>, source: AssistantMessage): string =>
		normalizeResponsesToolCallId(id, model, source, allowedToolCallProviders);
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
	if ((options?.includeSystemPrompt ?? true) && context.systemPrompt) {
		messages.push({
			role: model.reasoning ? "developer" : "system",
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}
	let messageIndex = 0;
	for (const message of transformedMessages) {
		let converted: ResponseInput;
		if (message.role === "user") converted = convertResponsesUserMessage(message);
		else if (message.role === "assistant") converted = convertResponsesAssistantMessage(message, model, messageIndex);
		else converted = convertResponsesToolResult(message, model);
		if (converted.length === 0) continue;
		messages.push(...converted);
		messageIndex++;
	}
	return messages;
}

// =============================================================================
// Tool conversion
// =============================================================================

export function convertResponsesTools(tools: Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[] {
	const strict = options?.strict === undefined ? false : options.strict;
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as any, // TypeBox already generates JSON Schema
		strict,
	}));
}

// =============================================================================
// Stream processing
// =============================================================================
type StreamingToolCall = ToolCall & { partialJson: string };

interface ResponsesThinkingOutputSlot {
	type: "thinking";
	block: ThinkingContent;
	contentIndex: number;
}

interface ResponsesTextOutputSlot {
	type: "text";
	block: TextContent;
	contentIndex: number;
}

interface ResponsesToolCallOutputSlot {
	type: "toolCall";
	block: StreamingToolCall;
	contentIndex: number;
}

type ResponsesOutputSlot = ResponsesThinkingOutputSlot | ResponsesTextOutputSlot | ResponsesToolCallOutputSlot;

interface ResponsesStreamState<TApi extends Api> {
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	model: Model<TApi>;
	options: OpenAIResponsesStreamOptions | undefined;
	sawTerminalResponseEvent: boolean;
	outputSlots: Map<number, ResponsesOutputSlot>;
	reasoningBlocksById: Map<string, ThinkingContent>;
}

function applyResponsesMessagePhaseStopReason(output: AssistantMessage, item: ResponseOutputItem): void {
	if (item.type === "message" && item.phase === "final_answer") output.stopReason = "stop";
}

function getResponsesThinkingSlot<TApi extends Api>(
	state: ResponsesStreamState<TApi>,
	outputIndex: number,
): ResponsesThinkingOutputSlot | undefined {
	const slot = state.outputSlots.get(outputIndex);
	return slot?.type === "thinking" ? slot : undefined;
}

function getResponsesTextSlot<TApi extends Api>(
	state: ResponsesStreamState<TApi>,
	outputIndex: number,
): ResponsesTextOutputSlot | undefined {
	const slot = state.outputSlots.get(outputIndex);
	return slot?.type === "text" ? slot : undefined;
}

function getResponsesToolCallSlot<TApi extends Api>(
	state: ResponsesStreamState<TApi>,
	outputIndex: number,
): ResponsesToolCallOutputSlot | undefined {
	const slot = state.outputSlots.get(outputIndex);
	return slot?.type === "toolCall" ? slot : undefined;
}

function createResponsesOutputSlot<TApi extends Api>(
	state: ResponsesStreamState<TApi>,
	outputIndex: number,
	item: ResponseOutputItem,
): ResponsesOutputSlot | undefined {
	switch (item.type) {
		case "reasoning": {
			const block: ThinkingContent = { type: "thinking", thinking: "" };
			state.output.content.push(block);
			const slot: ResponsesThinkingOutputSlot = {
				type: "thinking",
				block,
				contentIndex: state.output.content.length - 1,
			};
			state.outputSlots.set(outputIndex, slot);
			state.stream.push({ type: "thinking_start", contentIndex: slot.contentIndex, partial: state.output });
			return slot;
		}
		case "message": {
			applyResponsesMessagePhaseStopReason(state.output, item);
			const block: TextContent = { type: "text", text: "" };
			state.output.content.push(block);
			const slot: ResponsesTextOutputSlot = {
				type: "text",
				block,
				contentIndex: state.output.content.length - 1,
			};
			state.outputSlots.set(outputIndex, slot);
			state.stream.push({ type: "text_start", contentIndex: slot.contentIndex, partial: state.output });
			return slot;
		}
		case "function_call": {
			const block: StreamingToolCall = {
				type: "toolCall",
				id: `${item.call_id}|${item.id}`,
				name: item.name,
				arguments: {},
				partialJson: item.arguments || "",
			};
			state.output.content.push(block);
			const slot: ResponsesToolCallOutputSlot = {
				type: "toolCall",
				block,
				contentIndex: state.output.content.length - 1,
			};
			state.outputSlots.set(outputIndex, slot);
			state.stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: state.output });
			return slot;
		}
		default:
			return undefined;
	}
}

function getOrCreateResponsesOutputSlot<TApi extends Api>(
	state: ResponsesStreamState<TApi>,
	outputIndex: number,
	item: ResponseOutputItem,
): ResponsesOutputSlot | undefined {
	return state.outputSlots.get(outputIndex) ?? createResponsesOutputSlot(state, outputIndex, item);
}

function backfillResponsesReasoningSignatures<TApi extends Api>(
	state: ResponsesStreamState<TApi>,
	responseOutput: ResponseOutputItem[],
): void {
	for (const item of responseOutput) {
		if (item.type !== "reasoning" || !item.encrypted_content) continue;
		const block = state.reasoningBlocksById.get(item.id);
		if (!block?.thinkingSignature) continue;
		const storedItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
		if (storedItem.encrypted_content) continue;
		block.thinkingSignature = JSON.stringify({ ...storedItem, encrypted_content: item.encrypted_content });
	}
}

function finalizeResponsesResponse<TApi extends Api>(
	state: ResponsesStreamState<TApi>,
	response: OpenAIResponse,
): void {
	state.sawTerminalResponseEvent = true;
	backfillResponsesReasoningSignatures(state, response.output ?? []);
	if (response.id) state.output.responseId = response.id;
	if (response.usage) {
		const inputDetails = response.usage.input_tokens_details as
			| { cached_tokens?: number; cache_write_tokens?: number }
			| undefined;
		const cachedTokens = inputDetails?.cached_tokens || 0;
		const cacheWriteTokens = inputDetails?.cache_write_tokens || 0;
		state.output.usage = {
			input: Math.max(0, (response.usage.input_tokens || 0) - cachedTokens - cacheWriteTokens),
			output: response.usage.output_tokens || 0,
			cacheRead: cachedTokens,
			cacheWrite: cacheWriteTokens,
			reasoning: response.usage.output_tokens_details?.reasoning_tokens || 0,
			totalTokens: response.usage.total_tokens || 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}
	calculateCost(state.model, state.output.usage);
	if (state.options?.applyServiceTierPricing) {
		const serviceTier = state.options.resolveServiceTier
			? state.options.resolveServiceTier(response.service_tier, state.options.serviceTier)
			: (response.service_tier ?? state.options.serviceTier);
		state.options.applyServiceTierPricing(state.output.usage, serviceTier);
	}
	state.output.rawStopReason = response.status;
	state.output.stopReason = mapStopReason(response.status);
	if (state.output.content.some((block) => block.type === "toolCall") && state.output.stopReason === "stop") {
		state.output.stopReason = "toolUse";
	}
}

function appendResponsesThinkingDelta<TApi extends Api>(
	state: ResponsesStreamState<TApi>,
	outputIndex: number,
	delta: string,
): void {
	const slot = getResponsesThinkingSlot(state, outputIndex);
	if (!slot) return;
	slot.block.thinking += delta;
	state.stream.push({
		type: "thinking_delta",
		contentIndex: slot.contentIndex,
		delta,
		partial: state.output,
	});
}

function appendResponsesTextDelta<TApi extends Api>(
	state: ResponsesStreamState<TApi>,
	outputIndex: number,
	delta: string,
): void {
	const slot = getResponsesTextSlot(state, outputIndex);
	if (!slot) return;
	slot.block.text += delta;
	state.stream.push({ type: "text_delta", contentIndex: slot.contentIndex, delta, partial: state.output });
}

function appendResponsesToolCallDelta<TApi extends Api>(
	state: ResponsesStreamState<TApi>,
	outputIndex: number,
	delta: string,
): void {
	const slot = getResponsesToolCallSlot(state, outputIndex);
	if (!slot) return;
	slot.block.partialJson += delta;
	slot.block.arguments = parseStreamingJson(slot.block.partialJson);
	state.stream.push({ type: "toolcall_delta", contentIndex: slot.contentIndex, delta, partial: state.output });
}

function completeResponsesToolCallArguments<TApi extends Api>(
	state: ResponsesStreamState<TApi>,
	outputIndex: number,
	argumentsJson: string,
): void {
	const slot = getResponsesToolCallSlot(state, outputIndex);
	if (!slot) return;
	const previousPartialJson = slot.block.partialJson;
	slot.block.partialJson = argumentsJson;
	slot.block.arguments = parseStreamingJson(slot.block.partialJson);
	if (!argumentsJson.startsWith(previousPartialJson)) return;
	const delta = argumentsJson.slice(previousPartialJson.length);
	if (delta.length > 0) {
		state.stream.push({ type: "toolcall_delta", contentIndex: slot.contentIndex, delta, partial: state.output });
	}
}

function finalizeResponsesOutputItem<TApi extends Api>(
	state: ResponsesStreamState<TApi>,
	outputIndex: number,
	item: ResponseOutputItem,
): void {
	applyResponsesMessagePhaseStopReason(state.output, item);
	const slot = getOrCreateResponsesOutputSlot(state, outputIndex, item);
	switch (item.type) {
		case "reasoning":
			if (slot?.type !== "thinking") return;
			slot.block.thinking =
				item.summary?.map((summary) => summary.text).join("\n\n") ||
				item.content?.map((content) => content.text).join("\n\n") ||
				slot.block.thinking;
			slot.block.thinkingSignature = JSON.stringify(item);
			state.reasoningBlocksById.set(item.id, slot.block);
			state.stream.push({
				type: "thinking_end",
				contentIndex: slot.contentIndex,
				content: slot.block.thinking,
				partial: state.output,
			});
			state.outputSlots.delete(outputIndex);
			return;
		case "message":
			if (slot?.type !== "text") return;
			slot.block.text =
				item.content
					?.map((content) => (content.type === "output_text" ? content.text : content.refusal))
					.join("") || "";
			slot.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
			state.stream.push({
				type: "text_end",
				contentIndex: slot.contentIndex,
				content: slot.block.text,
				partial: state.output,
			});
			state.outputSlots.delete(outputIndex);
			return;
		case "function_call":
			if (slot?.type !== "toolCall") return;
			slot.block.arguments = parseStreamingJson(item.arguments || slot.block.partialJson || "{}");
			delete (slot.block as { partialJson?: string }).partialJson;
			state.stream.push({
				type: "toolcall_end",
				contentIndex: slot.contentIndex,
				toolCall: slot.block,
				partial: state.output,
			});
			state.outputSlots.delete(outputIndex);
			return;
		default:
			return;
	}
}

function failResponsesStream<TApi extends Api>(
	state: ResponsesStreamState<TApi>,
	response: OpenAIResponse | undefined,
): never {
	state.sawTerminalResponseEvent = true;
	state.output.rawStopReason = response?.status;
	const error = response?.error;
	const details = response?.incomplete_details;
	const message = error
		? `${error.code || "unknown"}: ${error.message || "no message"}`
		: details?.reason
			? `incomplete: ${details.reason}`
			: "Unknown error (no error details in response)";
	throw new Error(message);
}

function processResponsesStreamEvent<TApi extends Api>(
	state: ResponsesStreamState<TApi>,
	event: ResponseStreamEvent,
): void {
	switch (event.type) {
		case "response.created":
			state.output.responseId = event.response.id;
			break;
		case "response.output_item.added":
			createResponsesOutputSlot(state, event.output_index, event.item);
			break;
		case "response.reasoning_summary_text.delta":
		case "response.reasoning_text.delta":
			appendResponsesThinkingDelta(state, event.output_index, event.delta);
			break;
		case "response.reasoning_summary_part.done":
			appendResponsesThinkingDelta(state, event.output_index, "\n\n");
			break;
		case "response.output_text.delta":
		case "response.refusal.delta":
			appendResponsesTextDelta(state, event.output_index, event.delta);
			break;
		case "response.function_call_arguments.delta":
			appendResponsesToolCallDelta(state, event.output_index, event.delta);
			break;
		case "response.function_call_arguments.done":
			completeResponsesToolCallArguments(state, event.output_index, event.arguments);
			break;
		case "response.output_item.done":
			finalizeResponsesOutputItem(state, event.output_index, event.item);
			break;
		case "response.completed":
		case "response.incomplete":
			finalizeResponsesResponse(state, event.response);
			break;
		case "error":
			throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
		case "response.failed":
			failResponsesStream(state, event.response);
	}
}

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<void> {
	const state: ResponsesStreamState<TApi> = {
		output,
		stream,
		model,
		options,
		sawTerminalResponseEvent: false,
		outputSlots: new Map(),
		reasoningBlocksById: new Map(),
	};
	for await (const event of openaiStream) processResponsesStreamEvent(state, event);
	if (!state.sawTerminalResponseEvent) {
		throw new Error("OpenAI Responses stream ended before a terminal response event");
	}
}

function mapStopReason(status: OpenAI.Responses.ResponseStatus | undefined): StopReason {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		// These two are wonky ...
		case "in_progress":
		case "queued":
			return "stop";
		default: {
			const _exhaustive: never = status;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}
