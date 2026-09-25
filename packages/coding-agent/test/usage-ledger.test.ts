import { fauxAssistantMessage } from "@fleetagent/pi-ai";
import { describe, expect, it } from "vitest";
import { InMemorySessionManager } from "../src/core/session/in-memory-session-manager.ts";
import { readUsageLedger, USAGE_LEDGER_ENTRY_TYPE } from "../src/core/session/usage-ledger.ts";
import { createHarness } from "./suite/harness.ts";

describe("persistent usage ledger", () => {
	it("checkpoints on agent_end and retains billed usage after branch changes", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage("first")]);
			await harness.session.prompt("first prompt");
			const entries = harness.sessionManager.getEntries();
			const first = readUsageLedger(entries);
			expect(first.requests).toBe(1);
			expect(entries.at(-1)).toMatchObject({ type: "custom", customType: USAGE_LEDGER_ENTRY_TYPE });
			const oldLeaf = harness.sessionManager.getBranch()[0];
			if (!oldLeaf) throw new Error("Missing branch root");
			harness.sessionManager.branch(oldLeaf.id);
			harness.setResponses([fauxAssistantMessage("second")]);
			await harness.session.prompt("second prompt");
			const second = readUsageLedger(harness.sessionManager.getEntries());
			expect(second.requests).toBe(2);
			expect(second.input).toBe(first.input + second.last.input);
			expect(harness.session.getSessionStats().cost).toBe(second.catalogCost);
		} finally {
			await harness.session.dispose();
			harness.cleanup();
		}
	});

	it("bootstraps older entries, skips replayed copies and resumes from the last checkpoint", () => {
		const session = new InMemorySessionManager().create();
		const first = fauxAssistantMessage("first");
		first.usage.input = 123;
		first.usage.cost.total = 0.12;
		const originalId = session.appendMessage(first);
		const baseline = readUsageLedger(session.getEntries());
		expect(baseline).toMatchObject({ input: 123, catalogCost: 0.12, requests: 1, checkpointId: originalId });
		session.appendCustomEntry(USAGE_LEDGER_ENTRY_TYPE, baseline);
		const original = session.getEntry(originalId);
		if (!original) throw new Error("Missing original");
		session.appendReplayedEntry(original, new Map());
		const next = fauxAssistantMessage("next");
		next.usage.output = 10;
		next.usage.cost.total = 0.03;
		session.appendMessage(next);
		const current = readUsageLedger(session.getEntries());
		expect(current).toMatchObject({ input: 123 + next.usage.input, output: baseline.output + 10, requests: 2 });
		expect(current.catalogCost).toBeCloseTo(0.15);
	});
});
