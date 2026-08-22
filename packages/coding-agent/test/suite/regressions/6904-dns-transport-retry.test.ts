import { fauxAssistantMessage } from "@fleetagent/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "../harness.ts";

const wrappedDnsLookupError =
	"The pending stream has been canceled (caused by: getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com)";

describe("issue #6904 DNS transport failure retry", () => {
	it("retries a transient DNS lookup failure", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		try {
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: wrappedDnsLookupError }),
				fauxAssistantMessage("recovered after DNS retry"),
			]);

			await harness.session.prompt("test");

			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.eventsOfType("auto_retry_start").map((event) => event.errorMessage)).toEqual([
				wrappedDnsLookupError,
			]);
			expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
		} finally {
			harness.cleanup();
		}
	});

	it("allows DNS retry backoff to be aborted", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 10_000 } },
		});
		try {
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: wrappedDnsLookupError }),
				fauxAssistantMessage("must not be requested"),
			]);
			const retryStarted = new Promise<void>((resolve) => {
				const unsubscribe = harness.session.subscribe((event) => {
					if (event.type === "auto_retry_start") {
						unsubscribe();
						resolve();
					}
				});
			});

			const prompt = harness.session.prompt("test");
			await retryStarted;
			harness.session.abortRetry();
			await prompt;

			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.session.isRetrying).toBe(false);
			expect(harness.eventsOfType("auto_retry_end").map((event) => event.finalError)).toContain("Retry cancelled");
		} finally {
			harness.cleanup();
		}
	});
});
