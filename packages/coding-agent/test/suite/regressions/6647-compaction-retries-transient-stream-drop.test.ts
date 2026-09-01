import type { StreamFn } from "@fleetagent/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
} from "@fleetagent/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("#6647 retries transient compaction and branch-summary failures", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	function createUsage(totalTokens: number) {
		return {
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}

	function appendTurn(harness: Harness, userText: string, assistantText: string, timestamp: number): void {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: userText }],
			timestamp,
		});
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage(assistantText, { timestamp: timestamp + 1 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(100),
		});
	}

	function seedCompactableSession(harness: Harness): void {
		harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		appendTurn(harness, "message to compact", "assistant response to compact", Date.now() - 1000);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	}

	function error(errorMessage: string): AssistantMessage {
		return {
			...fauxAssistantMessage("", { stopReason: "error", errorMessage }),
			usage: createUsage(10),
		};
	}

	function pushScriptedMessageEvent(
		stream: AssistantMessageEventStream,
		model: Model<Api>,
		message: AssistantMessage,
	): void {
		const resolvedMessage = { ...message, api: model.api, provider: model.provider, model: model.id };
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			stream.push({ type: "error", reason: message.stopReason, error: resolvedMessage });
			return;
		}
		stream.push({
			type: "done",
			reason: message.stopReason === "length" ? "length" : message.stopReason === "toolUse" ? "toolUse" : "stop",
			message: resolvedMessage,
		});
	}

	function useScriptedStreamFn(harness: Harness, script: AssistantMessage[]): () => number {
		let callCount = 0;
		const streamFunction: StreamFn = (model) => {
			const message = script[callCount] ?? script[script.length - 1]!;
			callCount++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => pushScriptedMessageEvent(stream, model, message));
			return stream;
		};
		harness.session.agent.streamFn = streamFunction;
		return () => callCount;
	}

	it("retries transient manual compaction without double-compacting and settles once", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 500 } });
		const getCallCount = useScriptedStreamFn(harness, [
			error("terminated"),
			fauxAssistantMessage("recovered summary"),
		]);

		const compactPromise = harness.session.compact();
		await vi.waitFor(() => expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(1));
		let idleResolved = false;
		void harness.session.waitForIdle().then(() => {
			idleResolved = true;
		});
		await expect(harness.session.prompt("must remain blocked")).rejects.toThrow(
			"Cannot submit a prompt while compaction is in progress",
		);
		expect(idleResolved).toBe(false);

		const result = await compactPromise;
		await harness.session.waitForIdle();
		expect(result.summary).toContain("recovered summary");
		expect(getCallCount()).toBe(2);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(harness.eventsOfType("summarization_retry_attempt_start")).toEqual([
			expect.objectContaining({ source: "compaction", reason: "manual" }),
		]);
		expect(harness.eventsOfType("summarization_retry_finished")).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("does not retry disabled or non-retryable compaction failures", async () => {
		for (const [enabled, errorMessage] of [
			[false, "terminated"],
			[true, "insufficient_quota"],
		] as const) {
			const harness = await createHarness({ withConfiguredAuth: false });
			harnesses.push(harness);
			seedCompactableSession(harness);
			harness.settingsManager.applyOverrides({ retry: { enabled, maxRetries: 3, baseDelayMs: 0 } });
			const getCallCount = useScriptedStreamFn(harness, [error(errorMessage)]);

			await expect(harness.session.compact()).rejects.toThrow(errorMessage);
			expect(getCallCount()).toBe(1);
			expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(0);
		}
	});

	it("stops after maxRetries", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } });
		const getCallCount = useScriptedStreamFn(harness, [error("terminated")]);

		await expect(harness.session.compact()).rejects.toThrow("terminated");
		expect(getCallCount()).toBe(3);
		expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(2);
		expect(harness.eventsOfType("summarization_retry_finished")).toHaveLength(1);
	});

	it("aborts retry backoff through abortCompaction", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 5, baseDelayMs: 30_000 } });
		const getCallCount = useScriptedStreamFn(harness, [error("terminated")]);

		const compactPromise = harness.session.compact();
		await vi.waitFor(() => expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(1));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow();
		expect(getCallCount()).toBe(1);
		expect(harness.eventsOfType("summarization_retry_finished")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: true });
	});

	it("retries branch summarization through the custom stream without registry auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		appendTurn(harness, "first", "first answer", Date.now() - 2000);
		appendTurn(harness, "second", "second answer", Date.now() - 1000);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } });
		const getCallCount = useScriptedStreamFn(harness, [
			error("socket hang up"),
			fauxAssistantMessage("branch recovered"),
		]);
		const rootId = harness.sessionManager.getTree()[0]!.entry.id;

		const result = await harness.session.navigateTree(rootId, { summarize: true });
		await harness.session.waitForIdle();

		expect(result.cancelled).toBe(false);
		expect(result.summaryEntry?.summary).toContain("branch recovered");
		expect(getCallCount()).toBe(2);
		expect(harness.eventsOfType("summarization_retry_attempt_start")).toEqual([
			expect.objectContaining({ source: "branchSummary" }),
		]);
		expect(harness.eventsOfType("summarization_retry_finished")).toHaveLength(1);
	});
});
