import {
	type Candidate,
	type GenerateContentConfig,
	type GenerateContentParameters,
	type GenerateContentResponse,
	GoogleGenAI,
	type Part,
	type ThinkingConfig,
} from "@google/genai";
import { getEnvApiKey } from "../env-api-keys.ts";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ThinkingLevel,
	ToolCall,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import type {
	GoogleStreamState,
	GoogleThinkingLevel,
	GoogleThinkingOptions,
	GoogleToolChoice,
} from "./google-shared.ts";
import {
	convertMessages,
	convertTools,
	isThinkingPart,
	mapStopReason,
	mapToolChoice,
	retainThoughtSignature,
	retryGoogleRequest,
} from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

export type { GoogleThinkingOptions } from "./google-shared.ts";

export interface GoogleOptions extends StreamOptions {
	toolChoice?: GoogleToolChoice;
	thinking?: GoogleThinkingOptions;
}

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

type GoogleGenerativeStreamState = GoogleStreamState;

function createGoogleOutput(model: Model<"google-generative-ai">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "google-generative-ai" as Api,
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

function googleBlockIndex(state: GoogleGenerativeStreamState): number {
	return state.output.content.length - 1;
}

function endGoogleBlock(state: GoogleGenerativeStreamState): void {
	const block = state.currentBlock;
	if (!block) return;
	if (block.type === "text") {
		state.stream.push({
			type: "text_end",
			contentIndex: googleBlockIndex(state),
			content: block.text,
			partial: state.output,
		});
	} else {
		state.stream.push({
			type: "thinking_end",
			contentIndex: googleBlockIndex(state),
			content: block.thinking,
			partial: state.output,
		});
	}
	state.currentBlock = null;
}

function ensureGoogleTextBlock(state: GoogleGenerativeStreamState, isThinking: boolean): TextContent | ThinkingContent {
	const current = state.currentBlock;
	if (current && ((isThinking && current.type === "thinking") || (!isThinking && current.type === "text"))) {
		return current;
	}
	endGoogleBlock(state);
	if (isThinking) {
		const block: ThinkingContent = { type: "thinking", thinking: "", thinkingSignature: undefined };
		state.currentBlock = block;
		state.output.content.push(block);
		state.stream.push({ type: "thinking_start", contentIndex: googleBlockIndex(state), partial: state.output });
		return block;
	}
	const block: TextContent = { type: "text", text: "" };
	state.currentBlock = block;
	state.output.content.push(block);
	state.stream.push({ type: "text_start", contentIndex: googleBlockIndex(state), partial: state.output });
	return block;
}

function appendGoogleTextPart(state: GoogleGenerativeStreamState, part: Part): void {
	if (part.text === undefined) return;
	const block = ensureGoogleTextBlock(state, isThinkingPart(part));
	if (block.type === "thinking") {
		block.thinking += part.text;
		block.thinkingSignature = retainThoughtSignature(block.thinkingSignature, part.thoughtSignature);
		state.stream.push({
			type: "thinking_delta",
			contentIndex: googleBlockIndex(state),
			delta: part.text,
			partial: state.output,
		});
		return;
	}
	block.text += part.text;
	block.textSignature = retainThoughtSignature(block.textSignature, part.thoughtSignature);
	state.stream.push({
		type: "text_delta",
		contentIndex: googleBlockIndex(state),
		delta: part.text,
		partial: state.output,
	});
}

function appendGoogleToolCall(state: GoogleGenerativeStreamState, part: Part): void {
	if (!part.functionCall) return;
	endGoogleBlock(state);
	const providedId = part.functionCall.id;
	const needsNewId =
		!providedId || state.output.content.some((block) => block.type === "toolCall" && block.id === providedId);
	const toolCall: ToolCall = {
		type: "toolCall",
		id: needsNewId ? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}` : providedId,
		name: part.functionCall.name || "",
		arguments: (part.functionCall.args as Record<string, any>) ?? {},
		...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
	};
	state.output.content.push(toolCall);
	state.stream.push({ type: "toolcall_start", contentIndex: googleBlockIndex(state), partial: state.output });
	state.stream.push({
		type: "toolcall_delta",
		contentIndex: googleBlockIndex(state),
		delta: JSON.stringify(toolCall.arguments),
		partial: state.output,
	});
	state.stream.push({
		type: "toolcall_end",
		contentIndex: googleBlockIndex(state),
		toolCall,
		partial: state.output,
	});
}

function applyGoogleFinishReason(output: AssistantMessage, candidate: Candidate | undefined): void {
	if (!candidate?.finishReason) return;
	output.stopReason = mapStopReason(candidate.finishReason);
	if (output.content.some((block) => block.type === "toolCall")) output.stopReason = "toolUse";
}

function applyGoogleUsage(
	output: AssistantMessage,
	chunk: GenerateContentResponse,
	model: Model<"google-generative-ai">,
): void {
	if (!chunk.usageMetadata) return;
	output.usage = {
		input: (chunk.usageMetadata.promptTokenCount || 0) - (chunk.usageMetadata.cachedContentTokenCount || 0),
		output: (chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0),
		cacheRead: chunk.usageMetadata.cachedContentTokenCount || 0,
		cacheWrite: 0,
		totalTokens: chunk.usageMetadata.totalTokenCount || 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, output.usage);
}

function processGoogleChunk(
	state: GoogleGenerativeStreamState,
	chunk: GenerateContentResponse,
	model: Model<"google-generative-ai">,
): void {
	state.output.responseId ||= chunk.responseId;
	const candidate = chunk.candidates?.[0];
	for (const part of candidate?.content?.parts ?? []) {
		appendGoogleTextPart(state, part);
		appendGoogleToolCall(state, part);
	}
	applyGoogleFinishReason(state.output, candidate);
	applyGoogleUsage(state.output, chunk, model);
}

function completeGoogleStream(state: GoogleGenerativeStreamState, signal: AbortSignal | undefined): void {
	endGoogleBlock(state);
	if (signal?.aborted) throw new Error("Request was aborted");
	if (state.output.stopReason === "pending") throw new Error("Google stream ended without a finish reason");
	if (state.output.stopReason === "aborted" || state.output.stopReason === "error") {
		throw new Error("An unknown error occurred");
	}
	state.stream.push({ type: "done", reason: state.output.stopReason, message: state.output });
	state.stream.end();
}

function failGoogleStream(state: GoogleGenerativeStreamState, error: unknown, signal: AbortSignal | undefined): void {
	for (const block of state.output.content) {
		if ("index" in block) delete (block as { index?: number }).index;
	}
	state.output.stopReason = signal?.aborted ? "aborted" : "error";
	state.output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
	state.stream.push({ type: "error", reason: state.output.stopReason, error: state.output });
	state.stream.end();
}

async function runGoogleStream(
	model: Model<"google-generative-ai">,
	context: Context,
	options: GoogleOptions | undefined,
	state: GoogleGenerativeStreamState,
): Promise<void> {
	try {
		const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
		const client = createClient(model, apiKey, options?.headers);
		let params = buildParams(model, context, options);
		const nextParams = await options?.onPayload?.(params, model);
		if (nextParams !== undefined) params = nextParams as GenerateContentParameters;
		const googleStream = await retryGoogleRequest(() => client.models.generateContentStream(params), options);
		state.stream.push({ type: "start", partial: state.output });
		for await (const chunk of googleStream) processGoogleChunk(state, chunk, model);
		completeGoogleStream(state, options?.signal);
	} catch (error) {
		failGoogleStream(state, error, options?.signal);
	}
}

export const streamGoogle: StreamFunction<"google-generative-ai", GoogleOptions> = (
	model: Model<"google-generative-ai">,
	context: Context,
	options?: GoogleOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const state: GoogleGenerativeStreamState = {
		output: createGoogleOutput(model),
		stream,
		currentBlock: null,
	};
	void runGoogleStream(model, context, options, state);
	return stream;
};

export const streamSimpleGoogle: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
	model: Model<"google-generative-ai">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, context, options, apiKey);
	if (!options?.reasoning) {
		return streamGoogle(model, context, { ...base, thinking: { enabled: false } } satisfies GoogleOptions);
	}

	const clampedReasoning = clampThinkingLevel(model, options.reasoning);
	const effort = (clampedReasoning === "off" ? "high" : clampedReasoning) as ClampedThinkingLevel;
	const googleModel = model as Model<"google-generative-ai">;

	if (isGemini3ProModel(googleModel) || isGemini3FlashModel(googleModel) || isGemma4Model(googleModel)) {
		return streamGoogle(model, context, {
			...base,
			thinking: {
				enabled: true,
				level: getThinkingLevel(effort, googleModel),
			},
		} satisfies GoogleOptions);
	}

	return streamGoogle(model, context, {
		...base,
		thinking: {
			enabled: true,
			budgetTokens: getGoogleBudget(googleModel, effort, options.thinkingBudgets),
		},
	} satisfies GoogleOptions);
};

function createClient(
	model: Model<"google-generative-ai">,
	apiKey?: string,
	optionsHeaders?: ProviderHeaders,
): GoogleGenAI {
	const httpOptions: { baseUrl?: string; apiVersion?: string; headers?: Record<string, string> } = {};
	if (model.baseUrl) {
		httpOptions.baseUrl = model.baseUrl;
		httpOptions.apiVersion = ""; // baseUrl already includes version path, don't append
	}
	const headers = providerHeadersToRecord({ ...model.headers, ...optionsHeaders });
	if (headers) {
		httpOptions.headers = headers;
	}

	return new GoogleGenAI({
		apiKey,
		httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
	});
}

function resolveGoogleThinkingConfig(
	model: Model<"google-generative-ai">,
	thinking: GoogleThinkingOptions | undefined,
): ThinkingConfig | undefined {
	if (thinking?.enabled && model.reasoning) {
		const config: ThinkingConfig = { includeThoughts: true };
		if (thinking.level !== undefined) {
			// Cast to any since our GoogleThinkingLevel mirrors Google's ThinkingLevel enum values
			config.thinkingLevel = thinking.level as any;
		} else if (thinking.budgetTokens !== undefined) {
			config.thinkingBudget = thinking.budgetTokens;
		}
		return config;
	}
	if (model.reasoning && thinking && !thinking.enabled) return getDisabledThinkingConfig(model);
	return undefined;
}

function buildParams(
	model: Model<"google-generative-ai">,
	context: Context,
	options: GoogleOptions = {},
): GenerateContentParameters {
	const contents = convertMessages(model, context);

	const generationConfig: GenerateContentConfig = {};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}

	const config: GenerateContentConfig = {
		...(Object.keys(generationConfig).length > 0 && generationConfig),
		...(context.systemPrompt && { systemInstruction: sanitizeSurrogates(context.systemPrompt) }),
		...(context.tools && context.tools.length > 0 && { tools: convertTools(context.tools) }),
	};

	if (context.tools && context.tools.length > 0 && options.toolChoice) {
		config.toolConfig = {
			functionCallingConfig: {
				mode: mapToolChoice(options.toolChoice),
			},
		};
	} else {
		config.toolConfig = undefined;
	}

	const thinkingConfig = resolveGoogleThinkingConfig(model, options.thinking);
	if (thinkingConfig) config.thinkingConfig = thinkingConfig;

	if (options.signal) {
		if (options.signal.aborted) {
			throw new Error("Request aborted");
		}
		config.abortSignal = options.signal;
	}

	const params: GenerateContentParameters = {
		model: model.id,
		contents,
		config,
	};

	return params;
}

type ClampedThinkingLevel = Exclude<ThinkingLevel, "xhigh">;

function isGemma4Model(model: Model<"google-generative-ai">): boolean {
	return /gemma-?4/.test(model.id.toLowerCase());
}

function isGemini3ProModel(model: Model<"google-generative-ai">): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test(model.id.toLowerCase());
}

function isGemini3FlashModel(model: Model<"google-generative-ai">): boolean {
	return /gemini-3(?:\.\d+)?-flash/.test(model.id.toLowerCase());
}

function getDisabledThinkingConfig(model: Model<"google-generative-ai">): ThinkingConfig {
	// Google docs: Gemini 3.1 Pro cannot disable thinking, and Gemini 3 Flash / Flash-Lite
	// do not support full thinking-off either. For Gemini 3 models, use the lowest supported
	// thinkingLevel without includeThoughts so hidden thinking remains invisible to pi.
	if (isGemini3ProModel(model)) {
		return { thinkingLevel: "LOW" as any };
	}
	if (isGemini3FlashModel(model)) {
		return { thinkingLevel: "MINIMAL" as any };
	}
	if (isGemma4Model(model)) {
		return { thinkingLevel: "MINIMAL" as any };
	}

	// Gemini 2.x supports disabling via thinkingBudget = 0.
	return { thinkingBudget: 0 };
}

function getThinkingLevel(effort: ClampedThinkingLevel, model: Model<"google-generative-ai">): GoogleThinkingLevel {
	if (isGemini3ProModel(model)) {
		switch (effort) {
			case "minimal":
			case "low":
				return "LOW";
			case "medium":
			case "high":
				return "HIGH";
		}
	}
	if (isGemma4Model(model)) {
		switch (effort) {
			case "minimal":
			case "low":
				return "MINIMAL";
			case "medium":
			case "high":
				return "HIGH";
		}
	}
	switch (effort) {
		case "minimal":
			return "MINIMAL";
		case "low":
			return "LOW";
		case "medium":
			return "MEDIUM";
		case "high":
			return "HIGH";
	}
}

function getGoogleBudget(
	model: Model<"google-generative-ai">,
	effort: ClampedThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	if (customBudgets?.[effort] !== undefined) {
		return customBudgets[effort]!;
	}

	if (model.id.includes("2.5-pro")) {
		const budgets: Record<ClampedThinkingLevel, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 32768,
		};
		return budgets[effort];
	}

	if (model.id.includes("2.5-flash-lite")) {
		const budgets: Record<ClampedThinkingLevel, number> = {
			minimal: 512,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[effort];
	}

	if (model.id.includes("2.5-flash")) {
		const budgets: Record<ClampedThinkingLevel, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[effort];
	}

	return -1;
}
