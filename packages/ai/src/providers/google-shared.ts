/**
 * Shared utilities for Google Generative AI and Google Vertex providers.
 */

import {
	type Content,
	FinishReason,
	FunctionCallingConfigMode,
	type Tool as GoogleTool,
	type Part,
	type Schema,
} from "@google/genai";
import type {
	AssistantContent,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Model,
	StopReason,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolResultMessage,
	UserMessage,
} from "../types.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { transformMessages } from "./transform-messages.ts";

type GoogleApiType = "google-generative-ai" | "google-vertex";

/**
 * Thinking level for Gemini 3 models.
 * Mirrors Google's ThinkingLevel enum values.
 */
export type GoogleThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
export type GoogleToolChoice = "auto" | "none" | "any";

export interface GoogleThinkingOptions {
	enabled: boolean;
	budgetTokens?: number; // -1 for dynamic, 0 to disable
	level?: GoogleThinkingLevel;
}

export interface GoogleStreamState {
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	currentBlock: TextContent | ThinkingContent | null;
}

/**
 * Determines whether a streamed Gemini `Part` should be treated as "thinking".
 *
 * Protocol note (Gemini / Vertex AI thought signatures):
 * - `thought: true` is the definitive marker for thinking content (thought summaries).
 * - `thoughtSignature` is an encrypted representation of the model's internal thought process
 *   used to preserve reasoning context across multi-turn interactions.
 * - `thoughtSignature` can appear on ANY part type (text, functionCall, etc.) - it does NOT
 *   indicate the part itself is thinking content.
 * - For non-functionCall responses, the signature appears on the last part for context replay.
 * - When persisting/replaying model outputs, signature-bearing parts must be preserved as-is;
 *   do not merge/move signatures across parts.
 *
 * See: https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
	return part.thought === true;
}

/**
 * Retain thought signatures during streaming.
 *
 * Some backends only send `thoughtSignature` on the first delta for a given part/block; later deltas may omit it.
 * This helper preserves the last non-empty signature for the current block.
 *
 * Note: this does NOT merge or move signatures across distinct response parts. It only prevents
 * a signature from being overwritten with `undefined` within the same streamed block.
 */
export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}

// Thought signatures must be base64 for Google APIs (TYPE_BYTES).
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidThoughtSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

/**
 * Only keep signatures from the same provider/model and with valid base64.
 */
function resolveThoughtSignature(isSameProviderAndModel: boolean, signature: string | undefined): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

/**
 * Models via Google APIs that require explicit tool call IDs in function calls/responses.
 */
export function requiresToolCallId(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	return (
		modelId.startsWith("claude-") ||
		modelId.startsWith("gpt-oss-") ||
		(geminiMajorVersion !== undefined && geminiMajorVersion >= 3)
	);
}

function getGeminiMajorVersion(modelId: string): number | undefined {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	if (!match) return undefined;
	return Number.parseInt(match[1], 10);
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	if (geminiMajorVersion !== undefined) {
		return geminiMajorVersion >= 3;
	}
	return true;
}

function normalizeGoogleToolCallId(modelId: string, id: string): string {
	if (!requiresToolCallId(modelId)) return id;
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertGoogleUserMessage(message: UserMessage): Content | undefined {
	const parts: Part[] =
		typeof message.content === "string"
			? [{ text: sanitizeSurrogates(message.content) }]
			: message.content.map((item) =>
					item.type === "text"
						? { text: sanitizeSurrogates(item.text) }
						: { inlineData: { mimeType: item.mimeType, data: item.data } },
				);
	if (parts.length === 0) return undefined;
	return { role: "user", parts };
}

function convertGoogleThinkingBlock(block: ThinkingContent, isSameProviderAndModel: boolean): Part | undefined {
	if (isSameProviderAndModel) {
		const thoughtSignature = resolveThoughtSignature(true, block.thinkingSignature);
		if ((!block.thinking || block.thinking.trim() === "") && !thoughtSignature) return undefined;
		return {
			thought: true,
			text: sanitizeSurrogates(block.thinking),
			...(thoughtSignature && { thoughtSignature }),
		};
	}
	if (!block.thinking || block.thinking.trim() === "") return undefined;
	return { text: sanitizeSurrogates(block.thinking) };
}

function convertGoogleAssistantBlock(
	block: AssistantContent,
	model: Model<GoogleApiType>,
	isSameProviderAndModel: boolean,
): Part | undefined {
	if (block.type === "text") {
		const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
		if ((!block.text || block.text.trim() === "") && !thoughtSignature) return undefined;
		return {
			text: sanitizeSurrogates(block.text),
			...(thoughtSignature && { thoughtSignature }),
		};
	}
	if (block.type === "thinking") return convertGoogleThinkingBlock(block, isSameProviderAndModel);
	const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
	return {
		functionCall: {
			name: block.name,
			args: block.arguments ?? {},
			...(requiresToolCallId(model.id) ? { id: block.id } : {}),
		},
		...(thoughtSignature && { thoughtSignature }),
	};
}

function convertGoogleAssistantMessage(message: AssistantMessage, model: Model<GoogleApiType>): Content | undefined {
	const isSameProviderAndModel = message.provider === model.provider && message.model === model.id;
	const parts: Part[] = [];
	for (const block of message.content) {
		const part = convertGoogleAssistantBlock(block, model, isSameProviderAndModel);
		if (part) parts.push(part);
	}
	return parts.length > 0 ? { role: "model", parts } : undefined;
}

function appendGoogleToolResult(contents: Content[], message: ToolResultMessage, model: Model<GoogleApiType>): void {
	const textResult = message.content
		.filter((content): content is TextContent => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	const imageContent = model.input.includes("image")
		? message.content.filter((content): content is ImageContent => content.type === "image")
		: [];
	const hasImages = imageContent.length > 0;
	const supportsMultimodalResponse = supportsMultimodalFunctionResponse(model.id);
	const responseValue =
		textResult.length > 0 ? sanitizeSurrogates(textResult) : hasImages ? "(see attached image)" : "";
	const imageParts: Part[] = imageContent.map((imageBlock) => ({
		inlineData: { mimeType: imageBlock.mimeType, data: imageBlock.data },
	}));
	const functionResponsePart: Part = {
		functionResponse: {
			name: message.toolName,
			response: message.isError ? { error: responseValue } : { output: responseValue },
			...(hasImages && supportsMultimodalResponse && { parts: imageParts }),
			...(requiresToolCallId(model.id) ? { id: message.toolCallId } : {}),
		},
	};
	const lastContent = contents[contents.length - 1];
	if (lastContent?.role === "user" && lastContent.parts?.some((part) => part.functionResponse)) {
		lastContent.parts.push(functionResponsePart);
	} else {
		contents.push({ role: "user", parts: [functionResponsePart] });
	}
	if (hasImages && !supportsMultimodalResponse) {
		contents.push({ role: "user", parts: [{ text: "Tool result image:" }, ...imageParts] });
	}
}

/**
 * Convert internal messages to Gemini Content[] format.
 */
export function convertMessages<T extends GoogleApiType>(model: Model<T>, context: Context): Content[] {
	const contents: Content[] = [];
	const transformedMessages = transformMessages(context.messages, model, (id) =>
		normalizeGoogleToolCallId(model.id, id),
	);
	for (const message of transformedMessages) {
		if (message.role === "user") {
			const content = convertGoogleUserMessage(message);
			if (content) contents.push(content);
		} else if (message.role === "assistant") {
			const content = convertGoogleAssistantMessage(message, model);
			if (content) contents.push(content);
		} else if (message.role === "toolResult") {
			appendGoogleToolResult(contents, message, model);
		}
	}
	return contents;
}

const JSON_SCHEMA_META_DECLARATIONS = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$dynamicAnchor",
	"$vocabulary",
	"$comment",
	"$defs",
	"definitions", // pre-draft-2019-09 equivalent of $defs
]);

/**
 * Strip meta-declarations from a schema obj
 */
function sanitizeForOpenApi(schema: unknown): unknown {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		return schema;
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (JSON_SCHEMA_META_DECLARATIONS.has(key)) continue;
		result[key] = sanitizeForOpenApi(value);
	}
	return result;
}

/**
 * Convert tools to Gemini function declarations format.
 *
 * By default uses `parametersJsonSchema` which supports full JSON Schema (including
 * anyOf, oneOf, const, etc.). Set `useParameters` to true to use the legacy `parameters`
 * field instead (OpenAPI 3.03 Schema). This is needed for Cloud Code Assist with Claude
 * models, where the API translates `parameters` into Anthropic's `input_schema`.
 */
export function convertTools(tools: Tool[], useParameters = false): GoogleTool[] | undefined {
	if (tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				...(useParameters
					? { parameters: sanitizeForOpenApi(tool.parameters as unknown) as Schema }
					: { parametersJsonSchema: tool.parameters }),
			})),
		},
	];
}

/**
 * Map tool choice string to Gemini FunctionCallingConfigMode.
 */
export function mapToolChoice(choice: string): FunctionCallingConfigMode {
	switch (choice) {
		case "auto":
			return FunctionCallingConfigMode.AUTO;
		case "none":
			return FunctionCallingConfigMode.NONE;
		case "any":
			return FunctionCallingConfigMode.ANY;
		default:
			return FunctionCallingConfigMode.AUTO;
	}
}

/**
 * Map Gemini FinishReason to our StopReason.
 */
export function mapStopReason(reason: FinishReason): StopReason {
	switch (reason) {
		case FinishReason.STOP:
			return "stop";
		case FinishReason.MAX_TOKENS:
			return "length";
		case FinishReason.BLOCKLIST:
		case FinishReason.PROHIBITED_CONTENT:
		case FinishReason.SPII:
		case FinishReason.SAFETY:
		case FinishReason.IMAGE_SAFETY:
		case FinishReason.IMAGE_PROHIBITED_CONTENT:
		case FinishReason.IMAGE_RECITATION:
		case FinishReason.IMAGE_OTHER:
		case FinishReason.RECITATION:
		case FinishReason.FINISH_REASON_UNSPECIFIED:
		case FinishReason.OTHER:
		case FinishReason.LANGUAGE:
		case FinishReason.MALFORMED_FUNCTION_CALL:
		case FinishReason.UNEXPECTED_TOOL_CALL:
		case FinishReason.NO_IMAGE:
			return "error";
		default: {
			const _exhaustive: never = reason;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}

/**
 * Map string finish reason to our StopReason (for raw API responses).
 */
export function mapStopReasonString(reason: string): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}

/**
 * Run a Google GenAI SDK request with the shared provider retry policy
 * (408/409/429/5xx with backoff, honoring retry-after), mirroring how the
 * Anthropic and OpenAI adapters wrap their initial request in
 * retryProviderRequest. The SDK's ApiError has a `status` property but no
 * `headers` property, and retryProviderRequest only retries errors that carry
 * both, so normalize the error by adding the missing `headers` before
 * rethrowing.
 */
export function retryGoogleRequest<T>(
	request: () => Promise<T>,
	options?: Pick<StreamOptions, "maxRetries" | "maxRetryDelayMs" | "signal">,
): Promise<T> {
	return retryProviderRequest(
		async () => {
			try {
				return await request();
			} catch (error) {
				if (error instanceof Error && "status" in error && !("headers" in error)) {
					(error as { headers?: Headers }).headers = undefined;
				}
				throw error;
			}
		},
		{
			maxRetries: options?.maxRetries,
			maxRetryDelayMs: options?.maxRetryDelayMs,
			signal: options?.signal,
		},
	);
}
