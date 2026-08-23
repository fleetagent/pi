import type { AgentMessage } from "@fleetagent/pi-agent-core";
import type { AssistantMessage, Model } from "@fleetagent/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CompactionPreparation,
	compact,
	completeSummarization,
	generateSummary,
} from "../src/core/compaction/compaction.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@fleetagent/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@fleetagent/pi-ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(reasoning: boolean, maxTokens = 8192): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens,
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

describe("generateSummary reasoning options", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("uses the provided thinking level for reasoning-capable models", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			reasoning: "medium",
			apiKey: "test-key",
		});
	});

	it("does not set reasoning when thinking is off", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("clamps compaction summary maxTokens to the model output cap", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 600000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		await compact(preparation, createModel(false, 128000), "test-key");

		expect(completeSimpleMock.mock.calls.map((call) => call[2]?.maxTokens)).toEqual([128000, 128000]);
	});

	it("isolates one summary operation while preserving request options across retries", async () => {
		const transient = { ...mockSummaryResponse, stopReason: "error" as const, errorMessage: "terminated" };
		completeSimpleMock.mockResolvedValueOnce(transient).mockResolvedValueOnce(mockSummaryResponse);
		const controller = new AbortController();
		const context = {
			systemPrompt: "summary",
			messages: [
				{ role: "user" as const, content: [{ type: "text" as const, text: "summarize" }], timestamp: Date.now() },
			],
		};

		await completeSummarization(
			createModel(false),
			context,
			{
				apiKey: "test-key",
				headers: { "x-test": "preserved" },
				signal: controller.signal,
				maxTokens: 1234,
				reasoning: "low",
			},
			undefined,
			{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		const firstOptions = completeSimpleMock.mock.calls[0][2];
		const secondOptions = completeSimpleMock.mock.calls[1][2];
		expect(firstOptions).toMatchObject({
			apiKey: "test-key",
			headers: { "x-test": "preserved" },
			signal: controller.signal,
			maxTokens: 1234,
			reasoning: "low",
			cacheRetention: "none",
		});
		expect(firstOptions.sessionId).toMatch(/^[0-9a-f-]+$/);
		expect(secondOptions).toEqual(firstOptions);
	});
});
