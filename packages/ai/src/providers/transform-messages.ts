import type {
	Api,
	AssistantContent,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

function downgradeUnsupportedImages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	if (model.input.includes("image")) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
			};
		}

		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			};
		}

		return msg;
	});
}

interface MessageTransformationContext<TApi extends Api> {
	model: Model<TApi>;
	normalizeToolCallId: ((id: string, model: Model<TApi>, source: AssistantMessage) => string) | undefined;
	toolCallIdMap: Map<string, string>;
}

interface ToolFlowRepairState {
	result: Message[];
	pendingToolCalls: ToolCall[];
	existingToolResultIds: Set<string>;
}

function isSameAssistantModel<TApi extends Api>(message: AssistantMessage, model: Model<TApi>): boolean {
	return message.provider === model.provider && message.api === model.api && message.model === model.id;
}

function transformThinkingForModel(
	block: ThinkingContent,
	isSameModel: boolean,
): AssistantContent | AssistantContent[] {
	if (block.redacted) return isSameModel ? block : [];
	if (isSameModel && block.thinkingSignature) return block;
	if (!block.thinking || block.thinking.trim() === "") return [];
	return isSameModel ? block : { type: "text", text: block.thinking };
}

function transformToolCallForModel<TApi extends Api>(
	toolCall: ToolCall,
	message: AssistantMessage,
	isSameModel: boolean,
	context: MessageTransformationContext<TApi>,
): ToolCall {
	let transformed = toolCall;
	if (!isSameModel && toolCall.thoughtSignature) {
		transformed = { ...toolCall };
		delete (transformed as { thoughtSignature?: string }).thoughtSignature;
	}
	if (isSameModel || !context.normalizeToolCallId) return transformed;

	const normalizedId = context.normalizeToolCallId(toolCall.id, context.model, message);
	if (normalizedId === toolCall.id) return transformed;
	context.toolCallIdMap.set(toolCall.id, normalizedId);
	return { ...transformed, id: normalizedId };
}

function transformAssistantContentForModel<TApi extends Api>(
	message: AssistantMessage,
	context: MessageTransformationContext<TApi>,
): AssistantContent[] {
	const isSameModel = isSameAssistantModel(message, context.model);
	return message.content.flatMap((block) => {
		switch (block.type) {
			case "thinking":
				return transformThinkingForModel(block, isSameModel);
			case "text":
				return isSameModel ? block : { type: "text", text: block.text };
			case "toolCall":
				return transformToolCallForModel(block, message, isSameModel, context);
			default:
				return block;
		}
	});
}

function transformMessageForModel<TApi extends Api>(
	message: Message,
	context: MessageTransformationContext<TApi>,
): Message {
	if (message.role === "user") return message;
	if (message.role === "toolResult") {
		const normalizedId = context.toolCallIdMap.get(message.toolCallId);
		return normalizedId && normalizedId !== message.toolCallId ? { ...message, toolCallId: normalizedId } : message;
	}
	return {
		...message,
		content: transformAssistantContentForModel(message, context),
	};
}

function insertSyntheticToolResults(state: ToolFlowRepairState): void {
	if (state.pendingToolCalls.length === 0) return;
	for (const toolCall of state.pendingToolCalls) {
		if (state.existingToolResultIds.has(toolCall.id)) continue;
		state.result.push({
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "No result provided" }],
			isError: true,
			timestamp: Date.now(),
		} as ToolResultMessage);
	}
	state.pendingToolCalls = [];
	state.existingToolResultIds = new Set();
}

function appendRepairedMessage(state: ToolFlowRepairState, message: Message): void {
	if (message.role === "assistant") {
		insertSyntheticToolResults(state);
		if (message.stopReason === "error" || message.stopReason === "aborted") return;
		const toolCalls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
		if (toolCalls.length > 0) {
			state.pendingToolCalls = toolCalls;
			state.existingToolResultIds = new Set();
		}
		state.result.push(message);
		return;
	}
	if (message.role === "toolResult") {
		state.existingToolResultIds.add(message.toolCallId);
		state.result.push(message);
		return;
	}
	if (message.role === "user") insertSyntheticToolResults(state);
	state.result.push(message);
}

function repairOrphanedToolCalls(messages: Message[]): Message[] {
	const state: ToolFlowRepairState = {
		result: [],
		pendingToolCalls: [],
		existingToolResultIds: new Set(),
	};
	for (const message of messages) appendRepairedMessage(state, message);
	insertSyntheticToolResults(state);
	return state.result;
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	const normalizedMessages = messages.map((message) =>
		message.content == null ? { ...message, content: [] } : message,
	);
	const imageAwareMessages = downgradeUnsupportedImages(normalizedMessages, model);
	const context: MessageTransformationContext<TApi> = {
		model,
		normalizeToolCallId,
		toolCallIdMap: new Map(),
	};
	const transformedMessages = imageAwareMessages.map((message) => transformMessageForModel(message, context));
	return repairOrphanedToolCalls(transformedMessages);
}
