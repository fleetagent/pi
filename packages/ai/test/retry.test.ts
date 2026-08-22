import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { isRetryableAssistantError, retryAssistantCall } from "../src/utils/retry.ts";

const bunFetchSocketClosedMessage =
	"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
const nvidiaNIMResourceExhaustedMessage = "ResourceExhausted: Worker local total request limit reached (288/48)";
const wrappedDnsLookupError =
	"The pending stream has been canceled (caused by: getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com)";

describe("provider retry classification", () => {
	it("matches Bun fetch socket drop wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: bunFetchSocketClosedMessage }),
			),
		).toBe(true);
	});

	it("keeps provider limit errors non-retryable even when they contain Bun socket-drop wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: `429 quota exceeded: ${bunFetchSocketClosedMessage}`,
				}),
			),
		).toBe(false);
	});

	it("does not broaden socket-drop matching beyond the upstream Bun wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "The socket was closed unexpectedly" }),
			),
		).toBe(false);
	});

	it("matches upstream request buffer exhaustion wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Error: exceeded request buffer limit while retrying upstream",
				}),
			),
		).toBe(true);
	});

	it("does not broaden matching to other request-buffer wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Error: request buffer limit exceeded while retrying downstream",
				}),
			),
		).toBe(false);
	});

	it("matches transient gRPC ResourceExhausted wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: nvidiaNIMResourceExhaustedMessage }),
			),
		).toBe(true);
	});

	it.each([
		wrappedDnsLookupError,
		"connect ENOTFOUND api.example.com",
		"EAI_AGAIN api.example.com",
		"getaddrinfo failed for api.example.com",
	])("matches DNS transport failure wording: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it("does not broaden DNS matching beyond the selected transport wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Name resolution failed for api.example.com",
				}),
			),
		).toBe(false);
	});

	it("keeps durable provider quota exhaustion non-retryable", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "ResourceExhausted: quota exceeded for this billing account",
				}),
			),
		).toBe(false);
	});
});

describe("retryAssistantCall", () => {
	afterEach(() => vi.useRealTimers());

	it("retries transient errors with the configured bound and ordered lifecycle callbacks", async () => {
		const responses = [
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "socket hang up" }),
			fauxAssistantMessage("recovered"),
		];
		const events: string[] = [];
		let calls = 0;
		const result = await retryAssistantCall(
			async () => responses[calls++]!,
			{ enabled: true, maxRetries: 3, baseDelayMs: 0 },
			undefined,
			{
				onRetryScheduled: (attempt, maxAttempts) => {
					events.push(`scheduled:${attempt}/${maxAttempts}`);
				},
				onRetryAttemptStart: () => {
					events.push("attempt");
				},
				onRetryFinished: (success, attempt) => {
					events.push(`finished:${success}:${attempt}`);
				},
			},
		);

		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(calls).toBe(3);
		expect(events).toEqual(["scheduled:1/3", "attempt", "scheduled:2/3", "attempt", "finished:true:2"]);
	});

	it("does not retry disabled or non-retryable failures", async () => {
		for (const [enabled, errorMessage] of [
			[false, "terminated"],
			[true, "insufficient_quota"],
		] as const) {
			let calls = 0;
			const result = await retryAssistantCall(
				async () => {
					calls++;
					return fauxAssistantMessage("", { stopReason: "error", errorMessage });
				},
				{ enabled, maxRetries: 3, baseDelayMs: 0 },
				undefined,
			);
			expect(result.errorMessage).toBe(errorMessage);
			expect(calls).toBe(1);
		}
	});

	it("reports exhaustion after exactly maxRetries additional calls", async () => {
		let calls = 0;
		const finished = vi.fn();
		const result = await retryAssistantCall(
			async () => {
				calls++;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" });
			},
			{ enabled: true, maxRetries: 2, baseDelayMs: 0 },
			undefined,
			{ onRetryFinished: finished },
		);

		expect(result.stopReason).toBe("error");
		expect(calls).toBe(3);
		expect(finished).toHaveBeenCalledWith(false, 2, "terminated");
	});

	it("normalizes cancellation during backoff and reports it as unsuccessful", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const finished = vi.fn();
		let calls = 0;
		const resultPromise = retryAssistantCall(
			async () => {
				calls++;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" });
			},
			{ enabled: true, maxRetries: 3, baseDelayMs: 30_000 },
			controller.signal,
			{ onRetryFinished: finished },
		);
		await Promise.resolve();
		controller.abort();
		const result = await resultPromise;

		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBeUndefined();
		expect(calls).toBe(1);
		expect(finished).toHaveBeenCalledWith(false, 1, "terminated");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reports an aborted retried call as unsuccessful", async () => {
		const finished = vi.fn();
		let calls = 0;
		const result = await retryAssistantCall(
			async () => {
				calls++;
				return calls === 1
					? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
					: fauxAssistantMessage("", { stopReason: "aborted" });
			},
			{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
			undefined,
			{ onRetryFinished: finished },
		);

		expect(result.stopReason).toBe("aborted");
		expect(finished).toHaveBeenCalledWith(false, 1);
	});
});
