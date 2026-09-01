import {
	type Candidate,
	type GenerateContentConfig,
	type GenerateContentParameters,
	type GenerateContentResponse,
	GoogleGenAI,
	type HttpOptions,
	type Part,
	ResourceScope,
	type ThinkingConfig,
	ThinkingLevel,
} from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ThinkingLevel as PiThinkingLevel,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
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

export interface GoogleVertexOptions extends StreamOptions {
	toolChoice?: GoogleToolChoice;
	thinking?: GoogleThinkingOptions;
	project?: string;
	location?: string;
}

const API_VERSION = "v1";
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

const THINKING_LEVEL_MAP: Record<GoogleThinkingLevel, ThinkingLevel> = {
	THINKING_LEVEL_UNSPECIFIED: ThinkingLevel.THINKING_LEVEL_UNSPECIFIED,
	MINIMAL: ThinkingLevel.MINIMAL,
	LOW: ThinkingLevel.LOW,
	MEDIUM: ThinkingLevel.MEDIUM,
	HIGH: ThinkingLevel.HIGH,
};

type GoogleVertexStreamState = GoogleStreamState;

function createGoogleVertexOutput(model: Model<"google-vertex">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "google-vertex" as Api,
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

function googleVertexBlockIndex(state: GoogleVertexStreamState): number {
	return state.output.content.length - 1;
}

function endGoogleVertexBlock(state: GoogleVertexStreamState): void {
	const block = state.currentBlock;
	if (!block) return;
	if (block.type === "text") {
		state.stream.push({
			type: "text_end",
			contentIndex: googleVertexBlockIndex(state),
			content: block.text,
			partial: state.output,
		});
	} else {
		state.stream.push({
			type: "thinking_end",
			contentIndex: googleVertexBlockIndex(state),
			content: block.thinking,
			partial: state.output,
		});
	}
	state.currentBlock = null;
}

function ensureGoogleVertexTextBlock(
	state: GoogleVertexStreamState,
	isThinking: boolean,
): TextContent | ThinkingContent {
	const current = state.currentBlock;
	if (current && ((isThinking && current.type === "thinking") || (!isThinking && current.type === "text"))) {
		return current;
	}
	endGoogleVertexBlock(state);
	if (isThinking) {
		const block: ThinkingContent = { type: "thinking", thinking: "", thinkingSignature: undefined };
		state.currentBlock = block;
		state.output.content.push(block);
		state.stream.push({ type: "thinking_start", contentIndex: googleVertexBlockIndex(state), partial: state.output });
		return block;
	}
	const block: TextContent = { type: "text", text: "" };
	state.currentBlock = block;
	state.output.content.push(block);
	state.stream.push({ type: "text_start", contentIndex: googleVertexBlockIndex(state), partial: state.output });
	return block;
}

function appendGoogleVertexTextPart(state: GoogleVertexStreamState, part: Part): void {
	if (part.text === undefined) return;
	const block = ensureGoogleVertexTextBlock(state, isThinkingPart(part));
	if (block.type === "thinking") {
		block.thinking += part.text;
		block.thinkingSignature = retainThoughtSignature(block.thinkingSignature, part.thoughtSignature);
		state.stream.push({
			type: "thinking_delta",
			contentIndex: googleVertexBlockIndex(state),
			delta: part.text,
			partial: state.output,
		});
		return;
	}
	block.text += part.text;
	block.textSignature = retainThoughtSignature(block.textSignature, part.thoughtSignature);
	state.stream.push({
		type: "text_delta",
		contentIndex: googleVertexBlockIndex(state),
		delta: part.text,
		partial: state.output,
	});
}

function appendGoogleVertexToolCall(state: GoogleVertexStreamState, part: Part): void {
	if (!part.functionCall) return;
	endGoogleVertexBlock(state);
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
	state.stream.push({ type: "toolcall_start", contentIndex: googleVertexBlockIndex(state), partial: state.output });
	state.stream.push({
		type: "toolcall_delta",
		contentIndex: googleVertexBlockIndex(state),
		delta: JSON.stringify(toolCall.arguments),
		partial: state.output,
	});
	state.stream.push({
		type: "toolcall_end",
		contentIndex: googleVertexBlockIndex(state),
		toolCall,
		partial: state.output,
	});
}

function applyGoogleVertexFinishReason(output: AssistantMessage, candidate: Candidate | undefined): void {
	if (!candidate?.finishReason) return;
	output.stopReason = mapStopReason(candidate.finishReason);
	if (output.content.some((block) => block.type === "toolCall")) output.stopReason = "toolUse";
}

function applyGoogleVertexUsage(
	output: AssistantMessage,
	chunk: GenerateContentResponse,
	model: Model<"google-vertex">,
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

function processGoogleVertexChunk(
	state: GoogleVertexStreamState,
	chunk: GenerateContentResponse,
	model: Model<"google-vertex">,
): void {
	state.output.responseId ||= chunk.responseId;
	const candidate = chunk.candidates?.[0];
	for (const part of candidate?.content?.parts ?? []) {
		appendGoogleVertexTextPart(state, part);
		appendGoogleVertexToolCall(state, part);
	}
	applyGoogleVertexFinishReason(state.output, candidate);
	applyGoogleVertexUsage(state.output, chunk, model);
}

function completeGoogleVertexStream(state: GoogleVertexStreamState, signal: AbortSignal | undefined): void {
	endGoogleVertexBlock(state);
	if (signal?.aborted) throw new Error("Request was aborted");
	if (state.output.stopReason === "pending") {
		throw new Error("Google Vertex stream ended without a finish reason");
	}
	if (state.output.stopReason === "aborted" || state.output.stopReason === "error") {
		throw new Error("An unknown error occurred");
	}
	state.stream.push({ type: "done", reason: state.output.stopReason, message: state.output });
	state.stream.end();
}

function failGoogleVertexStream(state: GoogleVertexStreamState, error: unknown, signal: AbortSignal | undefined): void {
	for (const block of state.output.content) {
		if ("index" in block) delete (block as { index?: number }).index;
	}
	state.output.stopReason = signal?.aborted ? "aborted" : "error";
	state.output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
	state.stream.push({ type: "error", reason: state.output.stopReason, error: state.output });
	state.stream.end();
}

async function runGoogleVertexStream(
	model: Model<"google-vertex">,
	context: Context,
	options: GoogleVertexOptions | undefined,
	state: GoogleVertexStreamState,
): Promise<void> {
	try {
		const apiKey = resolveApiKey(options);
		const client = apiKey
			? createClientWithApiKey(model, apiKey, options?.headers)
			: createClient(model, resolveProject(options), resolveLocation(options), options?.headers);
		let params = buildParams(model, context, options);
		const nextParams = await options?.onPayload?.(params, model);
		if (nextParams !== undefined) params = nextParams as GenerateContentParameters;
		const googleStream = await retryGoogleRequest(() => client.models.generateContentStream(params), options);
		state.stream.push({ type: "start", partial: state.output });
		for await (const chunk of googleStream) processGoogleVertexChunk(state, chunk, model);
		completeGoogleVertexStream(state, options?.signal);
	} catch (error) {
		failGoogleVertexStream(state, error, options?.signal);
	}
}

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

export const streamGoogleVertex: StreamFunction<"google-vertex", GoogleVertexOptions> = (
	model: Model<"google-vertex">,
	context: Context,
	options?: GoogleVertexOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const state: GoogleVertexStreamState = {
		output: createGoogleVertexOutput(model),
		stream,
		currentBlock: null,
	};
	void runGoogleVertexStream(model, context, options, state);
	return stream;
};

export const streamSimpleGoogleVertex: StreamFunction<"google-vertex", SimpleStreamOptions> = (
	model: Model<"google-vertex">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = buildBaseOptions(model, context, options, undefined);
	if (!options?.reasoning) {
		return streamGoogleVertex(model, context, {
			...base,
			thinking: { enabled: false },
		} satisfies GoogleVertexOptions);
	}

	const clampedReasoning = clampThinkingLevel(model, options.reasoning);
	const effort = (clampedReasoning === "off" ? "high" : clampedReasoning) as ClampedThinkingLevel;
	const geminiModel = model as unknown as Model<"google-generative-ai">;

	if (isGemini3ProModel(geminiModel) || isGemini3FlashModel(geminiModel)) {
		return streamGoogleVertex(model, context, {
			...base,
			thinking: {
				enabled: true,
				level: getGemini3ThinkingLevel(effort, geminiModel),
			},
		} satisfies GoogleVertexOptions);
	}

	return streamGoogleVertex(model, context, {
		...base,
		thinking: {
			enabled: true,
			budgetTokens: getGoogleBudget(geminiModel, effort, options.thinkingBudgets),
		},
	} satisfies GoogleVertexOptions);
};

function createClient(
	model: Model<"google-vertex">,
	project: string,
	location: string,
	optionsHeaders?: ProviderHeaders,
): GoogleGenAI {
	return new GoogleGenAI({
		vertexai: true,
		project,
		location,
		apiVersion: API_VERSION,
		httpOptions: buildHttpOptions(model, optionsHeaders),
	});
}

function createClientWithApiKey(
	model: Model<"google-vertex">,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
): GoogleGenAI {
	return new GoogleGenAI({
		vertexai: true,
		apiKey,
		apiVersion: API_VERSION,
		httpOptions: buildHttpOptions(model, optionsHeaders),
	});
}

function buildHttpOptions(model: Model<"google-vertex">, optionsHeaders?: ProviderHeaders): HttpOptions | undefined {
	const httpOptions: HttpOptions = {};
	const baseUrl = resolveCustomBaseUrl(model.baseUrl);
	if (baseUrl) {
		httpOptions.baseUrl = baseUrl;
		httpOptions.baseUrlResourceScope = ResourceScope.COLLECTION;
		if (baseUrlIncludesApiVersion(baseUrl)) {
			httpOptions.apiVersion = "";
		}
	}

	const headers = providerHeadersToRecord({ ...model.headers, ...optionsHeaders });
	if (headers) {
		httpOptions.headers = headers;
	}

	return Object.keys(httpOptions).length > 0 ? httpOptions : undefined;
}

function resolveCustomBaseUrl(baseUrl: string): string | undefined {
	const trimmed = baseUrl.trim();
	if (!trimmed || trimmed.includes("{location}")) {
		return undefined;
	}
	return trimmed;
}

function baseUrlIncludesApiVersion(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return url.pathname.split("/").some((part) => /^v\d+(?:beta\d*)?$/.test(part));
	} catch {
		return /(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/.test(baseUrl);
	}
}

function resolveApiKey(options?: GoogleVertexOptions): string | undefined {
	const apiKey = options?.apiKey?.trim() || process.env.GOOGLE_CLOUD_API_KEY?.trim();
	if (!apiKey || apiKey === GCP_VERTEX_CREDENTIALS_MARKER || isPlaceholderApiKey(apiKey)) {
		return undefined;
	}
	return apiKey;
}

function isPlaceholderApiKey(apiKey: string): boolean {
	return /^<[^>]+>$/.test(apiKey);
}

function resolveProject(options?: GoogleVertexOptions): string {
	const project = options?.project || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
	if (!project) {
		throw new Error(
			"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
		);
	}
	return project;
}

function resolveLocation(options?: GoogleVertexOptions): string {
	const location = options?.location || process.env.GOOGLE_CLOUD_LOCATION;
	if (!location) {
		throw new Error("Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.");
	}
	return location;
}

function resolveGoogleVertexThinkingConfig(
	model: Model<"google-vertex">,
	thinking: GoogleThinkingOptions | undefined,
): ThinkingConfig | undefined {
	if (thinking?.enabled && model.reasoning) {
		const config: ThinkingConfig = { includeThoughts: true };
		if (thinking.level !== undefined) {
			config.thinkingLevel = THINKING_LEVEL_MAP[thinking.level];
		} else if (thinking.budgetTokens !== undefined) {
			config.thinkingBudget = thinking.budgetTokens;
		}
		return config;
	}
	if (model.reasoning && thinking && !thinking.enabled) return getDisabledThinkingConfig(model);
	return undefined;
}

function buildParams(
	model: Model<"google-vertex">,
	context: Context,
	options: GoogleVertexOptions = {},
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

	const thinkingConfig = resolveGoogleVertexThinkingConfig(model, options.thinking);
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

type ClampedThinkingLevel = Exclude<PiThinkingLevel, "xhigh">;

function isGemini3ProModel(model: Model<"google-generative-ai">): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test(model.id.toLowerCase());
}

function isGemini3FlashModel(model: Model<"google-generative-ai">): boolean {
	return /gemini-3(?:\.\d+)?-flash/.test(model.id.toLowerCase());
}

function getDisabledThinkingConfig(model: Model<"google-vertex">): ThinkingConfig {
	// Google docs: Gemini 3.1 Pro cannot disable thinking, and Gemini 3 Flash / Flash-Lite
	// do not support full thinking-off either. For Gemini 3 models, use the lowest supported
	// thinkingLevel without includeThoughts so hidden thinking remains invisible to pi.
	const geminiModel = model as unknown as Model<"google-generative-ai">;
	if (isGemini3ProModel(geminiModel)) {
		return { thinkingLevel: ThinkingLevel.LOW };
	}
	if (isGemini3FlashModel(geminiModel)) {
		return { thinkingLevel: ThinkingLevel.MINIMAL };
	}

	// Gemini 2.x supports disabling via thinkingBudget = 0.
	return { thinkingBudget: 0 };
}

function getGemini3ThinkingLevel(
	effort: ClampedThinkingLevel,
	model: Model<"google-generative-ai">,
): GoogleThinkingLevel {
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
