import OpenAI from "openai";
import type { ResponseCreateParamsStreaming, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { getEnvApiKey } from "../env-api-keys.ts";
import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	OpenAIResponsesCompat,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	Usage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./cloudflare.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
	convertResponsesMessages,
	convertResponsesTools,
	type OpenAIResponseServiceTier,
	processResponsesStream,
} from "./openai-responses-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
// OpenAI Responses rejects max_output_tokens below 16: https://github.com/fleetagent/pi/issues/6265
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

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

function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	return {
		supportsReasoningEffort: model.compat?.supportsReasoningEffort ?? true,
		sendSessionIdHeader: model.compat?.sendSessionIdHeader ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
	};
}

function getPromptCacheRetention(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined;
}

function formatOpenAIResponsesError(error: unknown): string {
	return formatProviderError(normalizeProviderError(error), "OpenAI API error");
}

// OpenAI Responses-specific options
export type OpenAIResponsesReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type OpenAIResponsesReasoningSummary = "auto" | "detailed" | "concise";
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: OpenAIResponsesReasoningEffort;
	reasoningSummary?: OpenAIResponsesReasoningSummary | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
}

type CompletedOpenAIResponsesMessage = AssistantMessage & { stopReason: "stop" | "length" | "toolUse" };

function createOpenAIResponsesOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
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
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

async function startOpenAIResponsesRequest(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions | undefined,
): Promise<AsyncIterable<ResponseStreamEvent>> {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
	const client = createClient(model, context, apiKey, options?.headers, cacheSessionId);
	let params = buildParams(model, context, options);
	const nextParams = await options?.onPayload?.(params, model);
	if (nextParams !== undefined) params = nextParams as ResponseCreateParamsStreaming;
	const requestOptions = {
		...(options?.signal ? { signal: options.signal } : {}),
		...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
		maxRetries: 0,
	};
	const { data, response } = await retryProviderRequest(
		() => client.responses.create(params, requestOptions).withResponse(),
		{
			maxRetries: options?.maxRetries,
			maxRetryDelayMs: options?.maxRetryDelayMs,
			signal: options?.signal,
		},
	);
	await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
	return data;
}

function validateOpenAIResponsesCompletion(
	output: AssistantMessage,
	signal?: AbortSignal,
): asserts output is CompletedOpenAIResponsesMessage {
	if (signal?.aborted) throw new Error("Request was aborted");
	if (output.stopReason === "pending") throw new Error("OpenAI Responses stream ended without a stop reason");
	if (output.stopReason === "aborted" || output.stopReason === "error") throw new Error("An unknown error occurred");
}

async function executeOpenAIResponsesStream(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions | undefined,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
): Promise<void> {
	const openaiStream = await startOpenAIResponsesRequest(model, context, options);
	stream.push({ type: "start", partial: output });
	await processResponsesStream(openaiStream, output, stream, model, {
		serviceTier: options?.serviceTier,
		applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
	});
	validateOpenAIResponsesCompletion(output, options?.signal);
	stream.push({ type: "done", reason: output.stopReason, message: output });
	stream.end();
}

function failOpenAIResponsesStream(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	error: unknown,
	options: OpenAIResponsesOptions | undefined,
): void {
	for (const block of output.content) {
		delete (block as { index?: number }).index;
		// partialJson is only a streaming scratch buffer; never persist it.
		delete (block as { partialJson?: string }).partialJson;
	}
	output.stopReason = options?.signal?.aborted ? "aborted" : "error";
	output.errorMessage = formatOpenAIResponsesError(error);
	stream.push({ type: "error", reason: output.stopReason, error: output });
	stream.end();
}

async function runOpenAIResponsesStream(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const output = createOpenAIResponsesOutput(model);
	try {
		await executeOpenAIResponsesStream(model, context, options, stream, output);
	} catch (error) {
		failOpenAIResponsesStream(output, stream, error, options);
	}
}

/** Generate a stream using the OpenAI Responses API. */
export const streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	void runOpenAIResponsesStream(model, context, options, stream);
	return stream;
};

export const streamSimpleOpenAIResponses: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
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

	return streamOpenAIResponses(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAIResponsesOptions);
};

function resolveOpenAIResponsesApiKey(apiKey?: string): string {
	if (apiKey) return apiKey;
	const environmentApiKey = process.env.OPENAI_API_KEY;
	if (environmentApiKey) return environmentApiKey;
	throw new Error("OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.");
}

function buildOpenAIResponsesHeaders(
	model: Model<"openai-responses">,
	context: Context,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	sessionId?: string,
): ProviderHeaders {
	const compat = getCompat(model);
	const headers: ProviderHeaders = { ...model.headers };
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		Object.assign(
			headers,
			buildCopilotDynamicHeaders({
				messages: context.messages,
				hasImages,
			}),
		);
	}

	if (sessionId) {
		if (compat.sendSessionIdHeader) headers.session_id = sessionId;
		headers["x-client-request-id"] = sessionId;
	}

	if (model.provider === "cloudflare-ai-gateway") {
		if (!("Authorization" in headers)) headers.Authorization = null;
		if (!("cf-aig-authorization" in headers)) headers["cf-aig-authorization"] = `Bearer ${apiKey}`;
	}

	// Merge options headers last so they can override or suppress defaults.
	if (optionsHeaders) Object.assign(headers, optionsHeaders);
	return headers;
}

function createClient(
	model: Model<"openai-responses">,
	context: Context,
	apiKey?: string,
	optionsHeaders?: ProviderHeaders,
	sessionId?: string,
) {
	const resolvedApiKey = resolveOpenAIResponsesApiKey(apiKey);
	const headers = buildOpenAIResponsesHeaders(model, context, resolvedApiKey, optionsHeaders, sessionId);
	return new OpenAI({
		apiKey: resolvedApiKey,
		baseURL: isCloudflareProvider(model.provider) ? resolveCloudflareBaseUrl(model) : model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders: headers,
	});
}

function applyOpenAIResponsesReasoning(
	params: ResponseCreateParamsStreaming,
	model: Model<"openai-responses">,
	compat: Required<OpenAIResponsesCompat>,
	options?: OpenAIResponsesOptions,
): void {
	if (!model.reasoning || !compat.supportsReasoningEffort) return;
	if (options?.reasoningEffort || options?.reasoningSummary) {
		const effort = options.reasoningEffort
			? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
			: "medium";
		params.reasoning = {
			effort: effort as NonNullable<typeof params.reasoning>["effort"],
			summary: options.reasoningSummary || "auto",
		};
		params.include = ["reasoning.encrypted_content"];
		return;
	}
	if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
		params.reasoning = {
			effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
		};
	}
}

function buildParams(model: Model<"openai-responses">, context: Context, options?: OpenAIResponsesOptions) {
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS);

	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	const compat = getCompat(model);
	const params: ResponseCreateParamsStreaming = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
		prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
		store: false,
	};

	if (options?.maxTokens) {
		params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (options?.serviceTier !== undefined) {
		params.service_tier = options.serviceTier;
	}

	if (context.tools && context.tools.length > 0) {
		params.tools = convertResponsesTools(context.tools);
	}
	applyOpenAIResponsesReasoning(params, model, compat, options);

	return params;
}

function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-responses">, "id">,
	serviceTier: OpenAIResponseServiceTier | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

function applyServiceTierPricing(
	usage: Usage,
	serviceTier: OpenAIResponseServiceTier | undefined,
	model: Pick<Model<"openai-responses">, "id">,
) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
