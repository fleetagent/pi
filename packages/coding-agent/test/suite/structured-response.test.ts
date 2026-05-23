import { fauxAssistantMessage, fauxToolCall, Type } from "@fleetagent/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

const AnalysisSchema = Type.Object({
	summary: Type.String(),
	risk: Type.Number(),
});

describe("AgentSession.getStructuredResponse", () => {
	it("returns valid JSON from the latest assistant response without another model call", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"ok","risk":2}')]);

			await harness.session.prompt("analyze");
			const result = await harness.session.getStructuredResponse({ schema: AnalysisSchema });

			expect(result.output).toEqual({ summary: "ok", risk: 2 });
			expect(result.source).toBe("json");
			expect(result.attempts).toBe(0);
			expect(harness.faux.state.callCount).toBe(1);
		} finally {
			harness.cleanup();
		}
	});

	it("extracts a structured response with a hidden internal tool call", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([
				fauxAssistantMessage("The code is mostly safe."),
				fauxAssistantMessage(fauxToolCall("structured_output", { summary: "mostly safe", risk: 1 })),
			]);

			await harness.session.prompt("analyze");
			const result = await harness.session.getStructuredResponse({ schema: AnalysisSchema });

			expect(result.output).toEqual({ summary: "mostly safe", risk: 1 });
			expect(result.source).toBe("tool");
			expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "custom_message")).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("runs correction calls when structured tool arguments are invalid", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([
				fauxAssistantMessage("The result is safe."),
				fauxAssistantMessage(fauxToolCall("structured_output", { summary: "safe", risk: "low" })),
				fauxAssistantMessage(fauxToolCall("structured_output", { summary: "safe", risk: 0 })),
			]);

			await harness.session.prompt("analyze");
			const result = await harness.session.getStructuredResponse({ schema: AnalysisSchema, maxCorrections: 1 });

			expect(result.output).toEqual({ summary: "safe", risk: 0 });
			expect(result.attempts).toBe(2);
			expect(harness.faux.state.callCount).toBe(3);
		} finally {
			harness.cleanup();
		}
	});
});
