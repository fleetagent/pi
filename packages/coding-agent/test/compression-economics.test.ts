import { fauxAssistantMessage } from "@fleetagent/pi-ai";
import { describe, expect, it } from "vitest";
import {
	COMPRESSION_ECONOMICS_ENTRY_TYPE,
	estimateCompressionCatchUp,
	estimateCompressionEconomics,
	estimateCompressionSavings,
} from "../src/core/compaction/compression-economics.ts";
import { createHarness } from "./suite/harness.ts";

describe("compression economics", () => {
	it("estimates a candidate using catalog rates without treating it as realized savings", async () => {
		const harness = await createHarness();
		try {
			const model = { ...harness.getModel(), cost: { input: 4, output: 20, cacheRead: 1, cacheWrite: 5 } };
			harness.sessionManager.appendMessage({ role: "user", content: "retained prefix ".repeat(200), timestamp: 0 });
			const start = harness.sessionManager.appendMessage({
				role: "user",
				content: "older research ".repeat(200),
				timestamp: 1,
			});
			const end = harness.sessionManager.appendMessage(fauxAssistantMessage("conclusion"));
			const suffix = harness.sessionManager.appendMessage({
				role: "user",
				content: "retained suffix ".repeat(200),
				timestamp: 2,
			});
			const branch = harness.sessionManager.getBranch();
			const estimate = estimateCompressionEconomics(branch, start, end, model);
			const noPrefix = estimateCompressionEconomics(branch.slice(1), start, end, model);
			const noSuffix = estimateCompressionEconomics(branch.slice(0, -1), start, end, model);
			expect(estimate?.sourceTokens).toBeGreaterThan(500);
			expect(estimate?.summaryTokens).toBe(Math.ceil((estimate?.sourceTokens ?? 0) / 4));
			expect(estimate?.removedTokens).toBeGreaterThan(0);
			expect(estimate?.breakEvenRequests).toBeGreaterThan(0);
			expect(estimate?.oneTimeCost).toBe(noPrefix?.oneTimeCost);
			expect(estimate?.oneTimeCost).toBeGreaterThan(noSuffix?.oneTimeCost ?? 0);
			expect(noSuffix?.oneTimeCost).toBe(
				((estimate?.summaryTokens ?? 0) * (model.cost.input + model.cost.output)) / 1_000_000,
			);
			expect(branch.at(-1)?.id).toBe(suffix);
			const subscription = estimateCompressionEconomics(
				harness.sessionManager.getBranch(),
				start,
				end,
				model,
				undefined,
				true,
			);
			expect(subscription).toMatchObject({ readRate: 0, oneTimeCost: null, breakEvenRequests: null });
			expect(estimateCompressionSavings(harness.sessionManager.getBranch()).avoidedCost).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("persists branch-local estimates, skips replayed/different-model replies and stops after compaction", async () => {
		const harness = await createHarness();
		try {
			const model = { ...harness.getModel(), cost: { input: 4, output: 20, cacheRead: 1, cacheWrite: 5 } };
			const start = harness.sessionManager.appendMessage({
				role: "user",
				content: "old ".repeat(200),
				timestamp: 1,
			});
			const end = harness.sessionManager.appendMessage(fauxAssistantMessage("old response"));
			const estimate = estimateCompressionEconomics(
				harness.sessionManager.getBranch(),
				start,
				end,
				model,
				"summary",
			);
			if (!estimate) throw new Error("Missing economics estimate");
			const summaryEntryId = harness.sessionManager.appendCustomMessageEntry("compress_context", "summary", true);
			harness.sessionManager.appendCustomEntry(COMPRESSION_ECONOMICS_ENTRY_TYPE, {
				...estimate,
				version: 1,
				summaryEntryId,
			});
			const catchUp = estimateCompressionCatchUp(harness.sessionManager.getBranch(), model, false);
			expect(catchUp.cachedTurns).toBeGreaterThanOrEqual(catchUp.newInputTurns ?? 0);
			expect(catchUp.newInputTurns).toBeGreaterThan(0);
			expect(estimateCompressionCatchUp(harness.sessionManager.getBranch(), model, true)).toEqual({
				cachedTurns: null,
				newInputTurns: null,
			});
			const reply = fauxAssistantMessage("next response");
			const replyId = harness.sessionManager.appendMessage(reply);
			const beforeCompaction = estimateCompressionSavings(harness.sessionManager.getBranch());
			expect(beforeCompaction.liveRemovedTokens).toBe(estimate.removedTokens);
			if (estimate.readRate > 0) {
				expect(beforeCompaction.pricedRequests).toBe(1);
				expect(beforeCompaction.avoidedCost).toBeCloseTo((estimate.removedTokens * estimate.readRate) / 1_000_000);
			}
			const replyEntry = harness.sessionManager.getEntry(replyId);
			if (!replyEntry) throw new Error("Missing reply entry");
			harness.sessionManager.appendReplayedEntry(replyEntry, new Map());
			harness.sessionManager.appendMessage({ ...fauxAssistantMessage("other model"), model: "different-model" });
			expect(estimateCompressionSavings(harness.sessionManager.getBranch())).toEqual(beforeCompaction);
			harness.sessionManager.appendCompaction("new context", end, 100);
			harness.sessionManager.appendMessage(fauxAssistantMessage("after compaction"));
			expect(estimateCompressionSavings(harness.sessionManager.getBranch())).toEqual({
				...beforeCompaction,
				liveRemovedTokens: 0,
			});
		} finally {
			harness.cleanup();
		}
	});
	it("projects different cached and uncached recovery horizons", async () => {
		const harness = await createHarness();
		try {
			const model = { ...harness.getModel(), cost: { input: 4, output: 20, cacheRead: 1, cacheWrite: 5 } };
			const summaryEntryId = harness.sessionManager.appendCustomMessageEntry("compress_context", "short", true);
			harness.sessionManager.appendCustomEntry(COMPRESSION_ECONOMICS_ENTRY_TYPE, {
				version: 1,
				summaryEntryId,
				provider: model.provider,
				modelId: model.id,
				sourceTokens: 1300,
				summaryTokens: 100,
				removedTokens: 1200,
				readRate: 1,
				oneTimeCost: 0.02,
				breakEvenRequests: 17,
			});
			expect(estimateCompressionCatchUp(harness.sessionManager.getBranch(), model, false)).toEqual({
				cachedTurns: 17,
				newInputTurns: 5,
			});
		} finally {
			harness.cleanup();
		}
	});
});
