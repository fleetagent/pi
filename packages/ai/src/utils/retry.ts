import type { AssistantMessage } from "../types.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	"GoUsageLimitError",
	"FreeUsageLimitError",
	"Monthly usage limit reached",
	"available balance",
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	"overloaded",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",
	"provider.?returned.?error",
	"exceeded request buffer limit while retrying upstream",
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",
	"websocket.?closed",
	"websocket.?error",
	"ended without",
	"stream ended before message_stop",
	"http2 request did not get a response",
	"retry delay",
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// gRPC based providers (e.g. NVIDIA NIM)
	"ResourceExhausted",
]);

export interface RetryPolicy {
	enabled: boolean;
	/** Maximum retry attempts; the initial call is not counted. */
	maxRetries: number;
	/** Base delay in milliseconds. Delay is doubled for each retry attempt. */
	baseDelayMs: number;
}

export interface RetryCallbacks {
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	onRetryAttemptStart?: () => void | Promise<void>;
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			reject(new RetrySleepAbortError());
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

interface ScheduledAssistantRetry {
	attempt: number;
	errorMessage: string;
	delayMs: number;
}

async function finishAssistantRetry(
	retry: ScheduledAssistantRetry | undefined,
	callbacks: RetryCallbacks | undefined,
	success: boolean,
	finalError?: string,
): Promise<void> {
	if (!retry || !callbacks?.onRetryFinished) return;
	if (finalError === undefined) await callbacks.onRetryFinished(success, retry.attempt);
	else await callbacks.onRetryFinished(success, retry.attempt, finalError);
}

async function waitForScheduledAssistantRetry(
	response: AssistantMessage,
	retry: ScheduledAssistantRetry,
	signal: AbortSignal | undefined,
	callbacks: RetryCallbacks | undefined,
): Promise<AssistantMessage | undefined> {
	try {
		await sleep(retry.delayMs, signal);
		return undefined;
	} catch (error) {
		await finishAssistantRetry(retry, callbacks, false, retry.errorMessage);
		if (error instanceof RetrySleepAbortError) {
			return { ...response, stopReason: "aborted", errorMessage: undefined };
		}
		throw error;
	}
}

/** Run an assistant-producing call with bounded retries for transient failures. */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const maxAttempts = policy?.enabled ? policy.maxRetries : 0;
	const baseDelayMs = policy?.baseDelayMs ?? 0;
	let attempt = 0;
	let lastRetry: ScheduledAssistantRetry | undefined;

	for (;;) {
		const response = await produce();
		if (response.stopReason === "aborted") {
			await finishAssistantRetry(lastRetry, callbacks, false);
			return response;
		}
		if (response.stopReason !== "error") {
			await finishAssistantRetry(lastRetry, callbacks, true);
			return response;
		}
		if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {
			await finishAssistantRetry(lastRetry, callbacks, false, response.errorMessage);
			return response;
		}

		attempt++;
		lastRetry = {
			attempt,
			errorMessage: response.errorMessage || "Unknown error",
			delayMs: baseDelayMs * 2 ** (attempt - 1),
		};
		await callbacks?.onRetryScheduled?.(attempt, maxAttempts, lastRetry.delayMs, lastRetry.errorMessage);
		const abortedResponse = await waitForScheduledAssistantRetry(response, lastRetry, signal, callbacks);
		if (abortedResponse) return abortedResponse;
		await callbacks?.onRetryAttemptStart?.();
	}
}
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const errorMessage = message.errorMessage;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}
