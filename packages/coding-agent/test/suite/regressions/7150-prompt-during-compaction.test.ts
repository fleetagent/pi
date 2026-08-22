import { fauxAssistantMessage } from "@fleetagent/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";

const COMPACTION_PROMPT_ERROR =
	"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.";

describe("issue #7150: prompt during manual compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("rejects every prompt before extension hooks or message mutation, then accepts prompts after compaction", async () => {
		let markCompactionStarted = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			markCompactionStarted = resolve;
		});
		let releaseCompaction = () => {};
		const compactionReleased = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		let inputRuns = 0;
		let beforeAgentStartRuns = 0;
		let commandRuns = 0;

		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("input", () => {
						inputRuns++;
					});
					pi.on("before_agent_start", () => {
						beforeAgentStartRuns++;
					});
					pi.on("session_before_compact", async (event) => {
						markCompactionStarted();
						await compactionReleased;
						return {
							compaction: {
								summary: "manual compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
					pi.registerCommand("mutate", {
						description: "Must not run during compaction",
						handler: async () => {
							commandRuns++;
						},
					});
				},
			],
		});
		harnesses.push(harness);

		const timestamp = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "old user message" }],
			timestamp: timestamp - 1000,
		});
		harness.sessionManager.appendMessage(
			fauxAssistantMessage("old assistant response", { timestamp: timestamp - 500 }),
		);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("accepted after compaction")]);

		const compactPromise = harness.session.compact();
		const preflightResults: boolean[] = [];
		try {
			await expect(
				harness.session.prompt("PROBE-7150-RPC", {
					source: "rpc",
					preflightResult: (success) => preflightResults.push(success),
				}),
			).rejects.toThrow(COMPACTION_PROMPT_ERROR);
			await expect(harness.session.prompt("/mutate")).rejects.toThrow(COMPACTION_PROMPT_ERROR);
			await expect(harness.session.sendUserMessage("PROBE-7150-EXTENSION")).rejects.toThrow(COMPACTION_PROMPT_ERROR);
			await compactionStarted;
		} finally {
			releaseCompaction();
			await compactPromise;
		}

		const persistedUserTexts = harness.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user" ? [getMessageText(entry.message)] : [],
			);

		expect(preflightResults).toEqual([false]);
		expect(inputRuns).toBe(0);
		expect(beforeAgentStartRuns).toBe(0);
		expect(commandRuns).toBe(0);
		expect(getUserTexts(harness)).not.toContain("PROBE-7150-RPC");
		expect(getUserTexts(harness)).not.toContain("PROBE-7150-EXTENSION");
		expect(persistedUserTexts).not.toContain("PROBE-7150-RPC");
		expect(persistedUserTexts).not.toContain("PROBE-7150-EXTENSION");
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(1);

		await expect(harness.session.prompt("accepted prompt")).resolves.toBeUndefined();
		expect(getUserTexts(harness)).toContain("accepted prompt");
		expect(harness.session.getLastAssistantText()).toBe("accepted after compaction");
	});
});
