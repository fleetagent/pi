import { fauxAssistantMessage } from "@fleetagent/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const upstreamRequestBufferError = "Error: exceeded request buffer limit while retrying upstream";

describe("upstream request-buffer retry", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("retries once and recovers from a transient buffer failure", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: upstreamRequestBufferError }),
			fauxAssistantMessage("recovered after buffer retry"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
	});

	it("stops after the configured retry count", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: upstreamRequestBufferError }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: upstreamRequestBufferError }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: upstreamRequestBufferError }),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1, 2]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([false]);
	});
});
