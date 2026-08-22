import type { AgentTool } from "@fleetagent/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@fleetagent/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

function createNoopTool(): AgentTool {
	return {
		name: "noop",
		label: "No-op",
		description: "Return immediately",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
	};
}

describe("issue #7253: manual compaction during an active response", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("keeps persistence, extensions, and subscribers connected while running only manual compaction", async () => {
		let markSecondResponseStarted = () => {};
		const secondResponseStarted = new Promise<void>((resolve) => {
			markSecondResponseStarted = resolve;
		});
		let releaseSecondResponse = () => {};
		const secondResponseReleased = new Promise<void>((resolve) => {
			releaseSecondResponse = resolve;
		});
		const extensionAssistantStops: AssistantMessage["stopReason"][] = [];

		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 999, keepRecentTokens: 2 } },
			tools: [createNoopTool()],
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role === "assistant") {
							extensionAssistantStops.push(event.message.stopReason);
						}
					});
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "manual summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
			async () => {
				markSecondResponseStarted();
				await secondResponseReleased;
				return fauxAssistantMessage("second response");
			},
		]);

		const subscriberAssistantStops: AssistantMessage["stopReason"][] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				subscriberAssistantStops.push(event.message.stopReason);
			}
		});

		const promptPromise = harness.session.prompt("Run the tool, then continue responding.");
		await secondResponseStarted;

		const compactPromise = harness.session.compact();
		const compactExpectation = expect(compactPromise).resolves.toMatchObject({ summary: "manual summary" });
		await Promise.resolve();
		expect(harness.session.agent.signal?.aborted).toBe(true);
		releaseSecondResponse();
		await Promise.all([promptPromise, compactExpectation]);

		const persistedMessages = harness.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		const persistedAssistantStops = persistedMessages
			.filter((message) => message.role === "assistant")
			.map((message) => message.stopReason);
		const observedMessageTexts = harness.eventsOfType("message_end").map((event) => getMessageText(event.message));

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["manual"]);
		expect(harness.eventsOfType("compaction_end").map((event) => event.reason)).toEqual(["manual"]);
		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		expect(subscriberAssistantStops).toEqual(["toolUse", "aborted"]);
		expect(extensionAssistantStops).toEqual(["toolUse", "aborted"]);
		expect(persistedAssistantStops).toEqual(["toolUse", "aborted"]);
		expect(observedMessageTexts).not.toContain("manual summary");
		expect(persistedMessages.map(getMessageText)).not.toContain("manual summary");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});
});
