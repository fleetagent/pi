import type * as NodeOs from "node:os";
import type { Tool as OpenAITool, ResponseInput, ResponseStreamEvent } from "openai/resources/responses/responses.js";

type ProcessWithOsBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:os") => typeof NodeOs;
};

function loadNodeOs(): typeof NodeOs | null {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
		return null;
	}
	return (process as ProcessWithOsBuiltinModule).getBuiltinModule?.("node:os") ?? null;
}

// NEVER convert to top-level runtime imports - breaks browser/Vite builds
const _os: typeof NodeOs | null = loadNodeOs();

type DynamicImport = (specifier: string) => Promise<unknown>;

const dynamicImport: DynamicImport = (specifier) => import(specifier);

import { clampThinkingLevel } from "../models.ts";
import { registerSessionResourceCleanup } from "../session-resources.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	Transport,
	Usage,
} from "../types.ts";
import { combineAbortSignals } from "../utils/abort-signals.ts";
import {
	appendAssistantMessageDiagnostic,
	createAssistantMessageDiagnostic,
	formatThrownValue,
} from "../utils/diagnostics.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
	convertResponsesMessages,
	convertResponsesTools,
	type OpenAIResponseServiceTier,
	processResponsesStream,
} from "./openai-responses-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;
const DEFAULT_MAX_RETRIES = 0;
const BASE_DELAY_MS = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_SSE_HEADER_TIMEOUT_MS = 10_000;
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;
const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";

const CODEX_RESPONSE_STATUSES = new Set<CodexResponseStatus>([
	"completed",
	"incomplete",
	"failed",
	"cancelled",
	"queued",
	"in_progress",
]);

// ============================================================================
// Types
// ============================================================================

export type OpenAICodexReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type OpenAICodexReasoningSummary = "auto" | "concise" | "detailed" | "off" | "on";
export type OpenAICodexTextVerbosity = "low" | "medium" | "high";

export interface OpenAICodexResponsesOptions extends StreamOptions {
	reasoningEffort?: OpenAICodexReasoningEffort;
	reasoningSummary?: OpenAICodexReasoningSummary | null;
	serviceTier?: OpenAIResponseServiceTier;
	textVerbosity?: OpenAICodexTextVerbosity;
}

type CodexResponseStatus = "completed" | "incomplete" | "failed" | "cancelled" | "queued" | "in_progress";

interface CodexRequestReasoning {
	effort?: string;
	summary?: string;
}

interface CodexRequestText {
	verbosity?: string;
}

interface CodexFailedResponse {
	error?: CodexEventError;
}

interface CodexFailedResponseEvent {
	response?: CodexFailedResponse;
}

interface CodexCompletedResponse {
	status?: unknown;
}

interface CodexCompletedResponseEvent {
	response?: CodexCompletedResponse;
}

interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	previous_response_id?: string;
	input?: ResponseInput;
	tools?: OpenAITool[];
	tool_choice?: "auto";
	parallel_tool_calls?: boolean;
	temperature?: number;
	reasoning?: CodexRequestReasoning;
	service_tier?: OpenAIResponseServiceTier;
	text?: CodexRequestText;
	include?: string[];
	prompt_cache_key?: string;
	[key: string]: unknown;
}

interface SseHeaderTimeout {
	signal: AbortSignal;
	clear(): void;
	error(): Error | undefined;
}

interface CodexApiErrorOptions {
	code?: string;
	payload?: Record<string, unknown>;
	cause?: unknown;
}

interface CodexProtocolErrorOptions {
	payload?: unknown;
	cause?: unknown;
}

interface CodexEventError {
	code?: string;
	message?: string;
}

interface WebSocketConstructorInit {
	headers?: Record<string, string>;
}

interface WebSocketReleaseOptions {
	keep?: boolean;
}

interface AcquiredWebSocket {
	socket: WebSocketLike;
	entry?: CachedWebSocketConnection;
	reused: boolean;
	release(options?: WebSocketReleaseOptions): void;
}

interface WebSocketCloseErrorOptions {
	code?: number;
	reason?: string;
	wasClean?: boolean;
}

interface CodexErrorResponse {
	message: string;
	friendlyMessage?: string;
}

interface CodexErrorDetails {
	code?: string;
	type?: string;
	message?: string;
	plan_type?: string;
	resets_at?: number;
}

interface CodexErrorPayload {
	error?: CodexErrorDetails;
}

interface PreparedCodexRequest {
	body: RequestBody;
	bodyJson: string;
	sseHeaders: Headers;
	websocketHeaders: Headers;
	idleTimeoutMs: number | undefined;
	websocketConnectTimeoutMs: number | undefined;
	transport: Transport;
	websocketDisabledForSession: boolean;
}

interface CodexStreamExecution {
	model: Model<"openai-codex-responses">;
	options: OpenAICodexResponsesOptions | undefined;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	request: PreparedCodexRequest;
}

type SuccessfulAssistantMessage = AssistantMessage & { stopReason: "stop" | "length" | "toolUse" };

function assertSuccessfulOutput(output: AssistantMessage): asserts output is SuccessfulAssistantMessage {
	if (output.stopReason === "pending") {
		throw new Error("Codex stream ended without a stop reason");
	}
	if (output.stopReason === "error" || output.stopReason === "aborted") {
		throw new Error(output.errorMessage || "An unknown error occurred");
	}
}

// ============================================================================
// Retry Helpers
// ============================================================================

function isTerminalRateLimitError(errorText: string): boolean {
	return /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(
		errorText,
	);
}

function isRetryableError(status: number, errorText: string): boolean {
	if (status === 429 && isTerminalRateLimitError(errorText)) {
		return false;
	}
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
		return true;
	}
	return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

function getRetryAfterDelayMs(headers: Headers): number | undefined {
	const retryAfterMs = headers.get("retry-after-ms");
	if (retryAfterMs !== null) {
		const millis = Number(retryAfterMs);
		if (Number.isFinite(millis)) {
			return Math.max(0, millis);
		}
	}

	const retryAfter = headers.get("retry-after");
	if (!retryAfter) {
		return undefined;
	}

	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds)) {
		return Math.max(0, seconds * 1000);
	}

	const date = Date.parse(retryAfter);
	if (!Number.isNaN(date)) {
		return Math.max(0, date - Date.now());
	}

	return undefined;
}

class RetryDelayExceededError extends Error {}

function validateRetryDelayMs(delayMs: number, options?: StreamOptions): number {
	const maxRetryDelayMs = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (maxRetryDelayMs > 0 && delayMs > maxRetryDelayMs) {
		throw new RetryDelayExceededError(
			`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxRetryDelayMs / 1000)}s)`,
		);
	}
	return delayMs;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			reject(new Error("Request was aborted"));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort);
	});
}

function normalizeTimeoutMs(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`Invalid timeoutMs: ${String(value)}`);
	}
	return Math.floor(value);
}

function createSSEHeaderTimeout(): SseHeaderTimeout {
	const controller = new AbortController();
	let error: Error | undefined;
	const timeout = setTimeout(() => {
		error = new Error(`Codex SSE response headers timed out after ${DEFAULT_SSE_HEADER_TIMEOUT_MS}ms`);
		controller.abort(error);
	}, DEFAULT_SSE_HEADER_TIMEOUT_MS);
	return {
		signal: controller.signal,
		clear: () => clearTimeout(timeout),
		error: () => error,
	};
}

function createCodexAssistantMessage(model: Model<"openai-codex-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-codex-responses" as Api,
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

async function prepareCodexRequest(
	model: Model<"openai-codex-responses">,
	context: Context,
	options: OpenAICodexResponsesOptions | undefined,
): Promise<PreparedCodexRequest> {
	const apiKey = options?.apiKey;
	if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);

	const accountId = extractAccountId(apiKey);
	let body = buildRequestBody(model, context, options);
	const nextBody = await options?.onPayload?.(body, model);
	if (nextBody !== undefined) body = nextBody as RequestBody;

	const websocketRequestId = options?.sessionId || createCodexRequestId();
	const sseHeaders = buildSSEHeaders(model.headers, options?.headers, accountId, apiKey, options?.sessionId);
	const websocketHeaders = buildWebSocketHeaders(
		model.headers,
		options?.headers,
		accountId,
		apiKey,
		websocketRequestId,
	);
	const transport = options?.transport || "auto";
	const websocketDisabledForSession = transport !== "sse" && isWebSocketSseFallbackActive(options?.sessionId);
	if (websocketDisabledForSession) recordWebSocketSseFallback(options?.sessionId);

	return {
		body,
		bodyJson: JSON.stringify(body),
		sseHeaders,
		websocketHeaders,
		idleTimeoutMs: normalizeTimeoutMs(options?.timeoutMs),
		websocketConnectTimeoutMs: normalizeTimeoutMs(options?.websocketConnectTimeoutMs),
		transport,
		websocketDisabledForSession,
	};
}

function throwIfCodexRequestAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Request was aborted");
}

function completeCodexStream(output: SuccessfulAssistantMessage, stream: AssistantMessageEventStream): void {
	stream.push({ type: "done", reason: output.stopReason, message: output });
	stream.end();
}

function failCodexStream(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	options: OpenAICodexResponsesOptions | undefined,
	error: unknown,
): void {
	for (const block of output.content) {
		// partialJson is only a streaming scratch buffer; never persist it.
		delete (block as { partialJson?: string }).partialJson;
	}
	output.stopReason = options?.signal?.aborted ? "aborted" : "error";
	output.errorMessage = error instanceof Error ? error.message : String(error);
	stream.push({ type: "error", reason: output.stopReason, error: output });
	stream.end();
}

type CodexWebSocketFailureAction = "retry" | "fallback";

function handleCodexWebSocketFailure(
	execution: CodexStreamExecution,
	error: unknown,
	streamStarted: boolean,
	retriedMissingContinuation: boolean,
): CodexWebSocketFailureAction {
	const { options, output, request } = execution;
	const aborted = options?.signal?.aborted;
	if (!aborted && !streamStarted && isPreviousResponseNotFoundError(error) && !retriedMissingContinuation) {
		return "retry";
	}
	if (aborted || isCodexNonTransportError(error)) throw error;

	appendAssistantMessageDiagnostic(
		output,
		createAssistantMessageDiagnostic("provider_transport_failure", error, {
			configuredTransport: request.transport,
			fallbackTransport: streamStarted ? undefined : "sse",
			eventsEmitted: streamStarted,
			phase: streamStarted ? "after_message_stream_start" : "before_message_stream_start",
			requestBytes: new TextEncoder().encode(request.bodyJson).byteLength,
		}),
	);
	recordWebSocketFailure(options?.sessionId, error);
	if (streamStarted) throw error;
	recordWebSocketSseFallback(options?.sessionId);
	return "fallback";
}

async function tryCodexWebSocketTransport(execution: CodexStreamExecution): Promise<boolean> {
	const { model, options, output, stream, request } = execution;
	if (request.transport === "sse" || request.websocketDisabledForSession) return false;

	let retriedMissingContinuation = false;
	while (true) {
		let streamStarted = false;
		try {
			await processWebSocketStream(
				resolveCodexWebSocketUrl(model.baseUrl),
				request.body,
				request.websocketHeaders,
				output,
				stream,
				model,
				() => {
					streamStarted = true;
				},
				request.idleTimeoutMs,
				request.websocketConnectTimeoutMs,
				options,
			);
			throwIfCodexRequestAborted(options?.signal);
			assertSuccessfulOutput(output);
			completeCodexStream(output, stream);
			return true;
		} catch (error) {
			const action = handleCodexWebSocketFailure(execution, error, streamStarted, retriedMissingContinuation);
			if (action === "retry") {
				retriedMissingContinuation = true;
				continue;
			}
			return false;
		}
	}
}

async function fetchCodexSseAttempt(execution: CodexStreamExecution): Promise<Response> {
	const { model, options, request } = execution;
	const headerTimeout = createSSEHeaderTimeout();
	const combinedSignal = combineAbortSignals([options?.signal, headerTimeout.signal]);
	let response: Response;
	try {
		try {
			response = await fetch(resolveCodexUrl(model.baseUrl), {
				method: "POST",
				headers: request.sseHeaders,
				body: request.bodyJson,
				signal: combinedSignal.signal,
			});
		} catch (error) {
			const timeoutError = headerTimeout.error();
			throw timeoutError && !options?.signal?.aborted ? timeoutError : error;
		}
	} finally {
		combinedSignal.cleanup();
		headerTimeout.clear();
	}
	await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
	return response;
}

function normalizeCodexSseError(error: unknown): Error {
	if (error instanceof Error && (error.name === "AbortError" || error.message === "Request was aborted")) {
		return new Error("Request was aborted");
	}
	return error instanceof Error ? error : new Error(String(error));
}

async function handleCodexHttpFailure(
	response: Response,
	attempt: number,
	maxRetries: number,
	options: OpenAICodexResponsesOptions | undefined,
): Promise<void> {
	const errorText = await response.text();
	if (attempt < maxRetries && isRetryableError(response.status, errorText)) {
		const retryAfterDelayMs = getRetryAfterDelayMs(response.headers);
		const delayMs =
			retryAfterDelayMs === undefined
				? BASE_DELAY_MS * 2 ** attempt
				: validateRetryDelayMs(retryAfterDelayMs, options);
		await sleep(delayMs, options?.signal);
		return;
	}

	const fakeResponse = new Response(errorText, {
		status: response.status,
		statusText: response.statusText,
	});
	const info = await parseErrorResponse(fakeResponse);
	throw new Error(info.friendlyMessage || info.message);
}

async function handleCodexSseAttemptError(
	error: unknown,
	attempt: number,
	maxRetries: number,
	options: OpenAICodexResponsesOptions | undefined,
): Promise<void> {
	const requestError = normalizeCodexSseError(error);
	if (requestError.message === "Request was aborted") throw requestError;
	if (
		attempt < maxRetries &&
		!(requestError instanceof RetryDelayExceededError) &&
		!requestError.message.includes("usage limit")
	) {
		await sleep(BASE_DELAY_MS * 2 ** attempt, options?.signal);
		return;
	}
	throw requestError;
}

async function fetchCodexSseResponse(execution: CodexStreamExecution): Promise<Response> {
	const { options } = execution;
	const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		throwIfCodexRequestAborted(options?.signal);
		try {
			const response = await fetchCodexSseAttempt(execution);
			if (response.ok) return response;
			await handleCodexHttpFailure(response, attempt, maxRetries, options);
		} catch (error) {
			await handleCodexSseAttemptError(error, attempt, maxRetries, options);
		}
	}

	throw new Error("Failed after retries");
}

async function processCodexSseTransport(execution: CodexStreamExecution, response: Response): Promise<void> {
	const { model, options, output, stream } = execution;
	if (!response.body) throw new Error("No response body");

	stream.push({ type: "start", partial: output });
	await processStream(response, output, stream, model, options);
	throwIfCodexRequestAborted(options?.signal);
	assertSuccessfulOutput(output);
	completeCodexStream(output, stream);
}

async function runCodexStream(execution: CodexStreamExecution): Promise<void> {
	if (await tryCodexWebSocketTransport(execution)) return;
	const response = await fetchCodexSseResponse(execution);
	await processCodexSseTransport(execution, response);
}

// ============================================================================
// Main Stream Function
// ============================================================================

export const streamOpenAICodexResponses: StreamFunction<"openai-codex-responses", OpenAICodexResponsesOptions> = (
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: OpenAICodexResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const output = createCodexAssistantMessage(model);

	(async () => {
		try {
			const request = await prepareCodexRequest(model, context, options);
			await runCodexStream({ model, options, output, stream, request });
		} catch (error) {
			failCodexStream(output, stream, options, error);
		}
	})();

	return stream;
};

export const streamSimpleOpenAICodexResponses: StreamFunction<"openai-codex-responses", SimpleStreamOptions> = (
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, context, options, apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return streamOpenAICodexResponses(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAICodexResponsesOptions);
};

// ============================================================================
// Request Building
// ============================================================================

function buildRequestBody(
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: OpenAICodexResponsesOptions,
): RequestBody {
	const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: false,
	});

	const body: RequestBody = {
		model: model.id,
		store: false,
		stream: true,
		instructions: context.systemPrompt || "You are a helpful assistant.",
		input: messages,
		text: { verbosity: options?.textVerbosity || "low" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: clampOpenAIPromptCacheKey(options?.sessionId),
		tool_choice: "auto",
		parallel_tool_calls: true,
	};

	if (options?.temperature !== undefined) {
		body.temperature = options.temperature;
	}

	if (options?.serviceTier !== undefined) {
		body.service_tier = options.serviceTier;
	}

	if (context.tools && context.tools.length > 0) {
		body.tools = convertResponsesTools(context.tools, { strict: null });
	}

	if (options?.reasoningEffort !== undefined) {
		const effort =
			options.reasoningEffort === "none"
				? (model.thinkingLevelMap?.off ?? "none")
				: (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort);
		if (effort !== null) {
			body.reasoning = {
				effort,
				summary: options.reasoningSummary ?? "auto",
			};
		}
	}

	return body;
}

function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-codex-responses">, "id">,
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
	model: Pick<Model<"openai-codex-responses">, "id">,
) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function resolveCodexServiceTier(
	responseServiceTier: OpenAIResponseServiceTier | undefined,
	requestServiceTier: OpenAIResponseServiceTier | undefined,
): OpenAIResponseServiceTier | undefined {
	if (responseServiceTier === "default" && (requestServiceTier === "flex" || requestServiceTier === "priority")) {
		return requestServiceTier;
	}
	return responseServiceTier ?? requestServiceTier;
}

function resolveCodexUrl(baseUrl?: string): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function resolveCodexWebSocketUrl(baseUrl?: string): string {
	const url = new URL(resolveCodexUrl(baseUrl));
	if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol === "http:") url.protocol = "ws:";
	return url.toString();
}

// ============================================================================
// Response Processing
// ============================================================================

async function processStream(
	response: Response,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-codex-responses">,
	options?: OpenAICodexResponsesOptions,
): Promise<void> {
	await processResponsesStream(mapCodexEvents(parseSSE(response, options?.signal)), output, stream, model, {
		serviceTier: options?.serviceTier,
		resolveServiceTier: resolveCodexServiceTier,
		applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
	});
}

class CodexApiError extends Error {
	readonly code?: string;
	readonly payload?: Record<string, unknown>;

	constructor(message: string, options?: CodexApiErrorOptions) {
		super(message);
		this.name = "CodexApiError";
		this.code = options?.code;
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

class CodexProtocolError extends Error {
	readonly payload?: unknown;

	constructor(message: string, options?: CodexProtocolErrorOptions) {
		super(message);
		this.name = "CodexProtocolError";
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

function isCodexNonTransportError(error: unknown): boolean {
	return error instanceof CodexApiError || error instanceof CodexProtocolError;
}

function isPreviousResponseNotFoundError(error: unknown): boolean {
	return error instanceof CodexApiError && error.code === PREVIOUS_RESPONSE_NOT_FOUND_CODE;
}

function extractCodexEventError(event: Record<string, unknown>): CodexEventError {
	const nested = event.error && typeof event.error === "object" ? (event.error as Record<string, unknown>) : undefined;
	return {
		code: typeof event.code === "string" ? event.code : typeof nested?.code === "string" ? nested.code : undefined,
		message:
			typeof event.message === "string"
				? event.message
				: typeof nested?.message === "string"
					? nested.message
					: undefined,
	};
}

function throwIfCodexEventFailed(type: string, event: Record<string, unknown>): void {
	if (type === "error") {
		const { code, message } = extractCodexEventError(event);
		throw new CodexApiError(`Codex error: ${message || code || JSON.stringify(event)}`, {
			code,
			payload: event,
		});
	}
	if (type === "response.failed") {
		const response = (event as CodexFailedResponseEvent).response;
		const code = response?.error?.code;
		const message = response?.error?.message;
		throw new CodexApiError(message || "Codex response failed", { code, payload: event });
	}
}

async function* mapCodexEvents(events: AsyncIterable<Record<string, unknown>>): AsyncGenerator<ResponseStreamEvent> {
	for await (const event of events) {
		const type = typeof event.type === "string" ? event.type : undefined;
		if (!type) continue;

		throwIfCodexEventFailed(type, event);

		if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
			const response = (event as CodexCompletedResponseEvent).response;
			const normalizedResponse = response
				? { ...response, status: normalizeCodexStatus(response.status) }
				: response;
			yield { ...event, type: "response.completed", response: normalizedResponse } as ResponseStreamEvent;
			return;
		}

		yield event as unknown as ResponseStreamEvent;
	}
}

function normalizeCodexStatus(status: unknown): CodexResponseStatus | undefined {
	if (typeof status !== "string") return undefined;
	return CODEX_RESPONSE_STATUSES.has(status as CodexResponseStatus) ? (status as CodexResponseStatus) : undefined;
}

// ============================================================================
// SSE Parsing
// ============================================================================

function parseCodexSseFrame(frame: string): Record<string, unknown> | undefined {
	const dataLines = frame
		.split(/\r\n|\r|\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim());
	if (dataLines.length === 0) return undefined;
	const data = dataLines.join("\n").trim();
	if (!data || data === "[DONE]") return undefined;
	try {
		return JSON.parse(data) as Record<string, unknown>;
	} catch (cause) {
		throw new CodexProtocolError(`Invalid Codex SSE JSON: ${formatThrownValue(cause)}`, {
			cause,
			payload: data,
		});
	}
}

function* decodeCodexSseFrames(buffer: string): Generator<Record<string, unknown>, string> {
	const separator = /(?:\r\n|\r|\n)(?:\r\n|\r|\n)/;
	let match = separator.exec(buffer);
	while (match) {
		const frame = buffer.slice(0, match.index);
		buffer = buffer.slice(match.index + match[0].length);
		const event = parseCodexSseFrame(frame);
		if (event) yield event;
		match = separator.exec(buffer);
	}
	return buffer;
}

async function* parseSSE(response: Response, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
	if (!response.body) return;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const onAbort = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			throwIfCodexRequestAborted(signal);
			const { done, value } = await reader.read();
			throwIfCodexRequestAborted(signal);
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			buffer = yield* decodeCodexSseFrames(buffer);
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		try {
			await reader.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}
}

// ============================================================================
// WebSocket Parsing
// ============================================================================

const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;
const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;

type WebSocketEventType = "open" | "message" | "error" | "close";
type WebSocketListener = (event: unknown) => void;

interface WebSocketLike {
	close(code?: number, reason?: string): void;
	send(data: string): void;
	addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
	removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
}

interface CachedWebSocketContinuationState {
	lastRequestBody: RequestBody;
	lastResponseId: string;
	lastResponseItems: ResponseInput;
}

interface CachedWebSocketConnection {
	socket: WebSocketLike;
	busy: boolean;
	createdAt: number;
	idleTimer?: ReturnType<typeof setTimeout>;
	continuation?: CachedWebSocketContinuationState;
}

export interface OpenAICodexWebSocketDebugStats {
	requests: number;
	connectionsCreated: number;
	connectionsReused: number;
	cachedContextRequests: number;
	storeTrueRequests: number;
	fullContextRequests: number;
	deltaRequests: number;
	lastInputItems: number;
	lastDeltaInputItems?: number;
	lastPreviousResponseId?: string;
	websocketFailures: number;
	sseFallbacks: number;
	websocketFallbackActive?: boolean;
	lastWebSocketError?: string;
}

const websocketSessionCache = new Map<string, CachedWebSocketConnection>();
const websocketDebugStats = new Map<string, OpenAICodexWebSocketDebugStats>();
const websocketSseFallbackSessions = new Set<string>();

function getOrCreateWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats {
	let stats = websocketDebugStats.get(sessionId);
	if (!stats) {
		stats = {
			requests: 0,
			connectionsCreated: 0,
			connectionsReused: 0,
			cachedContextRequests: 0,
			storeTrueRequests: 0,
			fullContextRequests: 0,
			deltaRequests: 0,
			lastInputItems: 0,
			websocketFailures: 0,
			sseFallbacks: 0,
		};
		websocketDebugStats.set(sessionId, stats);
	}
	return stats;
}

export function getOpenAICodexWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats | undefined {
	const stats = websocketDebugStats.get(sessionId);
	return stats ? { ...stats } : undefined;
}

export function resetOpenAICodexWebSocketDebugStats(sessionId?: string): void {
	if (sessionId) {
		websocketDebugStats.delete(sessionId);
		websocketSseFallbackSessions.delete(sessionId);
		return;
	}
	websocketDebugStats.clear();
	websocketSseFallbackSessions.clear();
}

export function closeOpenAICodexWebSocketSessions(sessionId?: string): void {
	const closeEntry = (entry: CachedWebSocketConnection) => {
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		closeWebSocketSilently(entry.socket, 1000, "debug_close");
	};
	if (sessionId) {
		const entry = websocketSessionCache.get(sessionId);
		if (entry) closeEntry(entry);
		websocketSessionCache.delete(sessionId);
		resetOpenAICodexWebSocketDebugStats(sessionId);
		return;
	}
	for (const entry of websocketSessionCache.values()) {
		closeEntry(entry);
	}
	websocketSessionCache.clear();
	resetOpenAICodexWebSocketDebugStats();
}

registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);

function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
	return sessionId ? websocketSseFallbackSessions.has(sessionId) : false;
}

function recordWebSocketSseFallback(sessionId: string | undefined): void {
	if (!sessionId) return;
	const stats = getOrCreateWebSocketDebugStats(sessionId);
	stats.sseFallbacks++;
	stats.websocketFallbackActive = isWebSocketSseFallbackActive(sessionId);
}

function recordWebSocketFailure(sessionId: string | undefined, error: unknown): void {
	if (!sessionId) return;
	websocketSseFallbackSessions.add(sessionId);

	const stats = getOrCreateWebSocketDebugStats(sessionId);
	stats.websocketFailures++;
	stats.lastWebSocketError = formatThrownValue(error);
	stats.websocketFallbackActive = true;
}

type WebSocketConstructor = new (
	url: string,
	protocols?: string | string[] | WebSocketConstructorInit,
) => WebSocketLike;

let _cachedWebsocket: WebSocketConstructor | null = null;
async function getWebSocketConstructor(): Promise<WebSocketConstructor | null> {
	if (_cachedWebsocket) return _cachedWebsocket;

	// bun doesn't respect http proxy envs, ref: https://github.com/oven-sh/bun/issues/15489
	// TODO: remove this when bun supports proxy envs in websocket.
	if (
		process?.versions?.bun &&
		(process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy)
	) {
		const m = await dynamicImport("proxy-from-env");
		const getProxyForUrl = (m as { getProxyForUrl: (url: string | object | URL) => string }).getProxyForUrl;

		_cachedWebsocket = class extends WebSocket {
			constructor(url: string | URL, options?: string | string[] | WebSocketConstructorInit) {
				let _opts: Record<string, unknown> = {};
				if (Array.isArray(options) || typeof options === "string") {
					_opts = { protocols: options };
				} else {
					_opts = { ...options };
				}

				const proxy = getProxyForUrl(url.toString().replace(/^wss:/, "https:").replace(/^ws:/, "http:"));
				super(url, { ..._opts, ...(proxy ? { proxy } : {}) } as any);
			}
		};
		return _cachedWebsocket;
	}

	const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
	if (typeof ctor !== "function") return null;
	return ctor as unknown as WebSocketConstructor;
}

class WebSocketCloseError extends Error {
	readonly code?: number;
	readonly reason?: string;
	readonly wasClean?: boolean;

	constructor(message: string, options?: WebSocketCloseErrorOptions) {
		super(message);
		this.name = "WebSocketCloseError";
		this.code = options?.code;
		this.reason = options?.reason;
		this.wasClean = options?.wasClean;
	}
}

function getWebSocketReadyState(socket: WebSocketLike): number | undefined {
	const readyState = (socket as { readyState?: unknown }).readyState;
	return typeof readyState === "number" ? readyState : undefined;
}

function isWebSocketReusable(socket: WebSocketLike): boolean {
	const readyState = getWebSocketReadyState(socket);
	// If readyState is unavailable, assume the runtime keeps it open/reusable.
	return readyState === undefined || readyState === 1;
}

function isWebSocketSessionExpired(entry: CachedWebSocketConnection): boolean {
	return Date.now() - entry.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
}

function closeWebSocketSilently(socket: WebSocketLike, code = 1000, reason = "done"): void {
	try {
		socket.close(code, reason);
	} catch {}
}

function scheduleSessionWebSocketExpiry(sessionId: string, entry: CachedWebSocketConnection): void {
	if (entry.idleTimer) {
		clearTimeout(entry.idleTimer);
	}
	entry.idleTimer = setTimeout(() => {
		if (entry.busy) return;
		closeWebSocketSilently(entry.socket, 1000, "idle_timeout");
		websocketSessionCache.delete(sessionId);
	}, SESSION_WEBSOCKET_CACHE_TTL_MS);
}

async function connectWebSocket(
	url: string,
	headers: Headers,
	signal?: AbortSignal,
	connectTimeoutMs = DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS,
): Promise<WebSocketLike> {
	const WebSocketCtor = await getWebSocketConstructor();
	if (!WebSocketCtor) {
		throw new Error("WebSocket transport is not available in this runtime");
	}

	const wsHeaders = headersToRecord(headers);
	delete wsHeaders["OpenAI-Beta"];

	return new Promise<WebSocketLike>((resolve, reject) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let socket: WebSocketLike;

		try {
			socket = new WebSocketCtor(url, { headers: wsHeaders });
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		const cleanup = () => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error: Error, closeReason?: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (closeReason) {
				closeWebSocketSilently(socket, 1000, closeReason);
			}
			reject(error);
		};
		const onOpen: WebSocketListener = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(socket);
		};
		const onError: WebSocketListener = (event) => {
			fail(extractWebSocketError(event));
		};
		const onClose: WebSocketListener = (event) => {
			fail(extractWebSocketCloseError(event));
		};
		const onAbort = () => {
			fail(new Error("Request was aborted"), "aborted");
		};

		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		signal?.addEventListener("abort", onAbort);

		if (connectTimeoutMs > 0) {
			timeout = setTimeout(() => {
				fail(new Error(`WebSocket connect timeout after ${connectTimeoutMs}ms`), "connect_timeout");
			}, connectTimeoutMs);
		}
		if (signal?.aborted) {
			onAbort();
		}
	});
}

async function acquireWebSocket(
	url: string,
	headers: Headers,
	sessionId: string | undefined,
	signal?: AbortSignal,
	connectTimeoutMs?: number,
): Promise<AcquiredWebSocket> {
	if (!sessionId) {
		const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs);
		return {
			socket,
			reused: false,
			release: () => closeWebSocketSilently(socket),
		};
	}

	const cached = websocketSessionCache.get(sessionId);
	if (cached) {
		if (cached.idleTimer) {
			clearTimeout(cached.idleTimer);
			cached.idleTimer = undefined;
		}
		if (!cached.busy && isWebSocketSessionExpired(cached)) {
			closeWebSocketSilently(cached.socket, 1000, "connection_age_limit");
			websocketSessionCache.delete(sessionId);
		} else if (!cached.busy && isWebSocketReusable(cached.socket)) {
			cached.busy = true;
			return {
				socket: cached.socket,
				entry: cached,
				reused: true,
				release: ({ keep } = {}) => {
					if (websocketSessionCache.get(sessionId) !== cached) {
						closeWebSocketSilently(cached.socket);
						return;
					}
					if (!keep || !isWebSocketReusable(cached.socket)) {
						closeWebSocketSilently(cached.socket);
						websocketSessionCache.delete(sessionId);
						return;
					}
					cached.busy = false;
					scheduleSessionWebSocketExpiry(sessionId, cached);
				},
			};
		}
		if (cached.busy) {
			const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs);
			return {
				socket,
				reused: false,
				release: () => {
					closeWebSocketSilently(socket);
				},
			};
		}
		if (!isWebSocketReusable(cached.socket)) {
			closeWebSocketSilently(cached.socket);
			websocketSessionCache.delete(sessionId);
		}
	}

	const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs);
	const entry: CachedWebSocketConnection = { socket, busy: true, createdAt: Date.now() };
	websocketSessionCache.set(sessionId, entry);
	return {
		socket,
		entry,
		reused: false,
		release: ({ keep } = {}) => {
			if (websocketSessionCache.get(sessionId) !== entry) {
				closeWebSocketSilently(entry.socket);
				if (entry.idleTimer) clearTimeout(entry.idleTimer);
				return;
			}
			if (!keep || !isWebSocketReusable(entry.socket)) {
				closeWebSocketSilently(entry.socket);
				if (entry.idleTimer) clearTimeout(entry.idleTimer);
				if (websocketSessionCache.get(sessionId) === entry) {
					websocketSessionCache.delete(sessionId);
				}
				return;
			}
			entry.busy = false;
			scheduleSessionWebSocketExpiry(sessionId, entry);
		},
	};
}

function extractNonemptyErrorMessage(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || !("message" in value)) return undefined;
	const message = (value as { message?: unknown }).message;
	return typeof message === "string" && message.length > 0 ? message : undefined;
}

function extractWebSocketError(event: unknown): Error {
	const message = extractNonemptyErrorMessage(event);
	if (message) return new Error(message);
	if (!event || typeof event !== "object" || !("error" in event)) return new Error("WebSocket error");

	const nestedError = (event as { error?: unknown }).error;
	if (nestedError instanceof Error && nestedError.message.length > 0) return nestedError;
	const nestedMessage = extractNonemptyErrorMessage(nestedError);
	return nestedMessage ? new Error(nestedMessage) : new Error("WebSocket error");
}

function readWebSocketCloseErrorOptions(event: object): WebSocketCloseErrorOptions {
	const code = "code" in event ? (event as { code?: unknown }).code : undefined;
	const reason = "reason" in event ? (event as { reason?: unknown }).reason : undefined;
	const wasClean = "wasClean" in event ? (event as { wasClean?: unknown }).wasClean : undefined;
	return {
		code: typeof code === "number" ? code : undefined,
		reason: typeof reason === "string" && reason.length > 0 ? reason : undefined,
		wasClean: typeof wasClean === "boolean" ? wasClean : undefined,
	};
}

function formatWebSocketCloseReason(options: WebSocketCloseErrorOptions): string {
	if (options.reason) return ` ${options.reason}`;
	return options.code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE ? " message too big" : "";
}

function extractWebSocketCloseError(event: unknown): Error {
	if (!event || typeof event !== "object") return new Error("WebSocket closed");
	const options = readWebSocketCloseErrorOptions(event);
	const codeText = options.code === undefined ? "" : ` ${options.code}`;
	const reasonText = formatWebSocketCloseReason(options);
	return new WebSocketCloseError(`WebSocket closed${codeText}${reasonText}`.trim(), options);
}

async function decodeWebSocketData(data: unknown): Promise<string | null> {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) {
		return new TextDecoder().decode(new Uint8Array(data));
	}
	if (ArrayBuffer.isView(data)) {
		const view = data as ArrayBufferView;
		return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
	}
	if (data && typeof data === "object" && "arrayBuffer" in data) {
		const blobLike = data as { arrayBuffer: () => Promise<ArrayBuffer> };
		const arrayBuffer = await blobLike.arrayBuffer();
		return new TextDecoder().decode(new Uint8Array(arrayBuffer));
	}
	return null;
}

interface WebSocketParserState {
	queue: Record<string, unknown>[];
	pending: (() => void) | null;
	done: boolean;
	failed: Error | null;
	sawCompletion: boolean;
	processing: Promise<void>;
}

function wakeWebSocketParser(state: WebSocketParserState): void {
	if (!state.pending) return;
	const resolve = state.pending;
	state.pending = null;
	resolve();
}

function enqueueWebSocketEvent(state: WebSocketParserState, processEvent: () => void | Promise<void>): void {
	state.processing = state.processing.then(processEvent).catch((cause) => {
		state.failed =
			cause instanceof CodexProtocolError
				? cause
				: new CodexProtocolError(`Invalid Codex WebSocket JSON: ${formatThrownValue(cause)}`, { cause });
		state.done = true;
		wakeWebSocketParser(state);
	});
}

function parseWebSocketMessageJson(text: string): Record<string, unknown> {
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch (cause) {
		throw new CodexProtocolError(`Invalid Codex WebSocket JSON: ${formatThrownValue(cause)}`, {
			cause,
			payload: text,
		});
	}
}

async function processWebSocketMessage(event: unknown, state: WebSocketParserState): Promise<void> {
	if (!event || typeof event !== "object" || !("data" in event)) return;
	const text = await decodeWebSocketData((event as { data?: unknown }).data);
	if (!text) return;
	const parsed = parseWebSocketMessageJson(text);
	const type = typeof parsed.type === "string" ? parsed.type : "";
	if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
		state.sawCompletion = true;
		state.done = true;
	}
	state.queue.push(parsed);
	wakeWebSocketParser(state);
}

function processWebSocketError(event: unknown, state: WebSocketParserState): void {
	state.failed = extractWebSocketError(event);
	state.done = true;
	wakeWebSocketParser(state);
}

function processWebSocketClose(event: unknown, state: WebSocketParserState): void {
	if (state.sawCompletion) {
		state.done = true;
		wakeWebSocketParser(state);
		return;
	}
	if (!state.failed) state.failed = extractWebSocketCloseError(event);
	state.done = true;
	wakeWebSocketParser(state);
}

function abortWebSocketParsing(state: WebSocketParserState): void {
	state.failed = new Error("Request was aborted");
	state.done = true;
	wakeWebSocketParser(state);
}

async function waitForWebSocketActivity(
	socket: WebSocketLike,
	state: WebSocketParserState,
	idleTimeoutMs: number | undefined,
): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	await new Promise<void>((resolve, reject) => {
		state.pending = resolve;
		if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
			timeout = setTimeout(() => {
				const error = new Error(`WebSocket idle timeout after ${idleTimeoutMs}ms`);
				state.failed = error;
				state.done = true;
				state.pending = null;
				closeWebSocketSilently(socket, 1000, "idle_timeout");
				reject(error);
			}, idleTimeoutMs);
		}
	}).finally(() => {
		if (timeout) clearTimeout(timeout);
	});
}

async function* parseWebSocket(
	socket: WebSocketLike,
	signal?: AbortSignal,
	idleTimeoutMs?: number,
): AsyncGenerator<Record<string, unknown>> {
	const state: WebSocketParserState = {
		queue: [],
		pending: null,
		done: false,
		failed: null,
		sawCompletion: false,
		processing: Promise.resolve(),
	};
	const onMessage: WebSocketListener = (event) => {
		enqueueWebSocketEvent(state, () => processWebSocketMessage(event, state));
	};
	const onError: WebSocketListener = (event) => {
		enqueueWebSocketEvent(state, () => processWebSocketError(event, state));
	};
	const onClose: WebSocketListener = (event) => {
		enqueueWebSocketEvent(state, () => processWebSocketClose(event, state));
	};
	const onAbort = () => abortWebSocketParsing(state);

	socket.addEventListener("message", onMessage);
	socket.addEventListener("error", onError);
	socket.addEventListener("close", onClose);
	signal?.addEventListener("abort", onAbort);

	try {
		while (true) {
			if (signal?.aborted) throw new Error("Request was aborted");
			if (state.queue.length > 0) {
				yield* state.queue.splice(0, 1);
				continue;
			}
			if (state.done) break;
			await waitForWebSocketActivity(socket, state, idleTimeoutMs);
		}
		if (state.failed) throw state.failed;
		if (!state.sawCompletion) throw new Error("WebSocket stream closed before response.completed");
	} finally {
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("error", onError);
		socket.removeEventListener("close", onClose);
		signal?.removeEventListener("abort", onAbort);
	}
}

function requestBodyWithoutInput(body: RequestBody): RequestBody {
	const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
	return rest;
}

function responseInputsEqual(a: ResponseInput | undefined, b: ResponseInput | undefined): boolean {
	return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function requestBodiesMatchExceptInput(a: RequestBody, b: RequestBody): boolean {
	return JSON.stringify(requestBodyWithoutInput(a)) === JSON.stringify(requestBodyWithoutInput(b));
}

function getCachedWebSocketInputDelta(
	body: RequestBody,
	continuation: CachedWebSocketContinuationState,
): ResponseInput | undefined {
	if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
		return undefined;
	}

	const currentInput = body.input ?? [];
	const baseline = [...(continuation.lastRequestBody.input ?? []), ...continuation.lastResponseItems];
	if (currentInput.length < baseline.length) {
		return undefined;
	}

	const prefix = currentInput.slice(0, baseline.length);
	if (!responseInputsEqual(prefix, baseline)) {
		return undefined;
	}

	return currentInput.slice(baseline.length);
}

function buildCachedWebSocketRequestBody(entry: CachedWebSocketConnection, body: RequestBody): RequestBody {
	const continuation = entry.continuation;
	if (!continuation) {
		return body;
	}

	const delta = getCachedWebSocketInputDelta(body, continuation);
	if (!delta || !continuation.lastResponseId) {
		entry.continuation = undefined;
		return body;
	}

	return {
		...body,
		previous_response_id: continuation.lastResponseId,
		input: delta,
	};
}

async function* startWebSocketOutputOnFirstEvent(
	events: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	onStart: () => void,
): AsyncGenerator<ResponseStreamEvent> {
	let started = false;
	for await (const event of events) {
		if (!started) {
			started = true;
			onStart();
			stream.push({ type: "start", partial: output });
		}
		yield event;
	}
}

function recordWebSocketRequestStats(
	stats: OpenAICodexWebSocketDebugStats | undefined,
	reused: boolean,
	useCachedContext: boolean,
	requestBody: RequestBody,
): void {
	if (!stats) return;
	stats.requests++;
	if (reused) stats.connectionsReused++;
	else stats.connectionsCreated++;
	if (useCachedContext) stats.cachedContextRequests++;
	if (requestBody.store === true) stats.storeTrueRequests++;
	stats.lastInputItems = requestBody.input?.length ?? 0;
	if (requestBody.previous_response_id) {
		stats.deltaRequests++;
		stats.lastDeltaInputItems = requestBody.input?.length ?? 0;
		stats.lastPreviousResponseId = requestBody.previous_response_id;
		return;
	}
	stats.fullContextRequests++;
	stats.lastDeltaInputItems = undefined;
	stats.lastPreviousResponseId = undefined;
}

function finishWebSocketRequest(
	entry: CachedWebSocketConnection | undefined,
	fullBody: RequestBody,
	output: AssistantMessage,
	model: Model<"openai-codex-responses">,
	useCachedContext: boolean,
	signal: AbortSignal | undefined,
): boolean {
	if (signal?.aborted) return false;
	if (!useCachedContext || !entry || !output.responseId) return true;
	const responseItems = convertResponsesMessages(model, { messages: [output] }, CODEX_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: false,
	}).filter((item) => item.type !== "function_call_output");
	entry.continuation = {
		lastRequestBody: fullBody,
		lastResponseId: output.responseId,
		lastResponseItems: responseItems,
	};
	return true;
}

async function processWebSocketStream(
	url: string,
	body: RequestBody,
	headers: Headers,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-codex-responses">,
	onStart: () => void,
	idleTimeoutMs: number | undefined,
	websocketConnectTimeoutMs: number | undefined,
	options?: OpenAICodexResponsesOptions,
): Promise<void> {
	const { socket, entry, reused, release } = await acquireWebSocket(
		url,
		headers,
		options?.sessionId,
		options?.signal,
		websocketConnectTimeoutMs,
	);
	let keepConnection = true;
	const useCachedContext = options?.transport === "websocket-cached" || options?.transport === "auto";
	// ChatGPT Codex Responses rejects `store: true` ("Store must be set to false").
	// WebSocket continuation still works via connection-scoped previous_response_id state.
	const fullBody = body;
	const requestBody = useCachedContext && entry ? buildCachedWebSocketRequestBody(entry, fullBody) : fullBody;
	const stats = options?.sessionId ? getOrCreateWebSocketDebugStats(options.sessionId) : undefined;
	recordWebSocketRequestStats(stats, reused, useCachedContext, requestBody);
	try {
		socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
		await processResponsesStream(
			startWebSocketOutputOnFirstEvent(
				mapCodexEvents(parseWebSocket(socket, options?.signal, idleTimeoutMs)),
				output,
				stream,
				onStart,
			),
			output,
			stream,
			model,
			{
				serviceTier: options?.serviceTier,
				resolveServiceTier: resolveCodexServiceTier,
				applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
			},
		);
		keepConnection = finishWebSocketRequest(entry, fullBody, output, model, useCachedContext, options?.signal);
	} catch (error) {
		if (entry) {
			entry.continuation = undefined;
		}
		keepConnection = false;
		throw error;
	} finally {
		release({ keep: keepConnection });
	}
}

// ============================================================================
// Error Handling
// ============================================================================

function describeCodexApiError(error: CodexErrorDetails, status: number, fallbackMessage: string): CodexErrorResponse {
	const code = error.code || error.type || "";
	if (!/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) && status !== 429) {
		return { message: error.message || fallbackMessage };
	}

	const plan = error.plan_type ? ` (${error.plan_type.toLowerCase()} plan)` : "";
	const minutesUntilReset = error.resets_at
		? Math.max(0, Math.round((error.resets_at * 1000 - Date.now()) / 60000))
		: undefined;
	const retryMessage = minutesUntilReset !== undefined ? ` Try again in ~${minutesUntilReset} min.` : "";
	const friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${retryMessage}`.trim();
	return { message: error.message || friendlyMessage, friendlyMessage };
}

async function parseErrorResponse(response: Response): Promise<CodexErrorResponse> {
	const raw = await response.text();
	const fallbackMessage = raw || response.statusText || "Request failed";

	try {
		const error = (JSON.parse(raw) as CodexErrorPayload).error;
		if (error) return describeCodexApiError(error, response.status, fallbackMessage);
	} catch {}

	return { message: fallbackMessage };
}

// ============================================================================
// Auth & Headers
// ============================================================================

function extractAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		const payload = JSON.parse(atob(parts[1]));
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		if (!accountId) throw new Error("No account ID in token");
		return accountId;
	} catch {
		throw new Error("Failed to extract accountId from token");
	}
}

function createCodexRequestId(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}
	return `codex_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildBaseCodexHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
): Headers {
	const headers = new Headers(initHeaders);
	for (const [key, value] of Object.entries(additionalHeaders || {})) {
		if (value === null) headers.delete(key);
		else headers.set(key, value);
	}
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "pi");
	const userAgent = _os ? `pi (${_os.platform()} ${_os.release()}; ${_os.arch()})` : "pi (browser)";
	headers.set("User-Agent", userAgent);
	return headers;
}

function buildSSEHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
	sessionId?: string,
): Headers {
	const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");

	if (sessionId) {
		headers.set("session-id", sessionId);
		headers.set("x-client-request-id", sessionId);
	}

	return headers;
}

function buildWebSocketHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
	requestId: string,
): Headers {
	const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
	headers.delete("accept");
	headers.delete("content-type");
	headers.delete("OpenAI-Beta");
	headers.delete("openai-beta");
	headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
	headers.set("x-client-request-id", requestId);
	headers.set("session-id", requestId);
	return headers;
}
