import { join } from "node:path";
import type { AgentMessage } from "@fleetagent/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	fauxAssistantMessage,
	fauxToolCall,
	type Message,
} from "@fleetagent/pi-ai";
import { setKeybindings, type TUI } from "@fleetagent/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	appendCompressionDetectionEvent,
	readCompressionDetectionLedger,
} from "../src/core/compaction/compression-detection-ledger.ts";
import { CompressionDetector } from "../src/core/compaction/compression-detector.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { LocalSessionManager } from "../src/core/session/local-session-manager.ts";
import { getSuggestedCompressionRangeError } from "../src/core/tools/compress-context.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("background compression detection", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("does not make a second model request when no detection model is configured", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("should remain queued")]);
		await harness.session.prompt("first task");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.messages).toHaveLength(2);
	});

	it("checks on percent increase and advises only the primary model, persisting events outside the context", async () => {
		const harness = await createHarness({
			models: [{ id: "detector-test", contextWindow: 200 }],
			settings: { compaction: { enabled: false } },
		});
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		const contexts: Message[][] = [];
		harness.setResponses([
			fauxAssistantMessage("first answer"),
			(context) => {
				expect(context.systemPrompt).toContain("COMPRESS startEntryId endEntryId urgency=N%");
				const question = context.messages.at(-1);
				expect(JSON.stringify(question)).toContain("Current context usage:");
				expect(JSON.stringify(context.messages.slice(0, -1))).not.toContain("Current context usage:");
				expect(JSON.stringify(context.messages)).toContain("Primary model catalog rates");
				const entries = harness.sessionManager.getBranch();
				return fauxAssistantMessage(`COMPRESS ${entries[0]?.id} ${entries.at(-1)?.id} urgency=85%`);
			},
			(context) => {
				contexts.push(context.messages);
				return fauxAssistantMessage("second answer");
			},
		]);
		await harness.session.prompt("first task");
		expect(harness.eventsOfType("compression_detection_activity").length).toBeGreaterThanOrEqual(2);
		expect(harness.getPendingResponseCount()).toBe(0);
		const advisory = JSON.stringify(contexts[0]);
		expect(advisory).toContain("Background compression detector: COMPRESS (urgency 85%).");
		expect(advisory).toContain("Suggested inclusive range: startEntryId");
		expect(advisory).toContain("Estimated if summary is 25% of range");
		expect(JSON.stringify(harness.session.messages)).toContain("Background compression detector");
		expect(JSON.stringify(harness.sessionManager.getEntries())).not.toContain("Background compression detector");
		const history = readCompressionDetectionLedger(harness.sessionManager.getEntries());
		expect(history.compress).toBe(1);
		expect(history.verdicts[0]?.urgency).toBe(85);
		expect(history.verdicts[0]?.suggestion).toMatchObject({
			startEntryId: harness.sessionManager.getBranch()[0]?.id,
		});
		expect(
			harness.sessionManager
				.buildSessionContext()
				.messages.some(
					(message) => message.role === "custom" && message.customType === "compression_detection_event",
				),
		).toBe(false);
		harness.settingsManager.setCompressionDetectionModel(undefined);
		harness.setResponses([fauxAssistantMessage("third answer")]);
		await harness.session.prompt("third task");
		expect(harness.getPendingResponseCount()).toBe(0);
	});
	it("delivers a verdict as a steering message during an active run without saving it", async () => {
		const harness = await createHarness({
			models: [{ id: "detector-steering-test", contextWindow: 200 }],
			settings: { compaction: { enabled: false } },
		});
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		harness.session.getContextUsage = () => ({ tokens: 100, contextWindow: 200, percent: 50 });
		let finish: ((response: AssistantMessage) => void) | undefined;
		let steeredContext: Message[] | undefined;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })], { stopReason: "toolUse" }),
			() =>
				new Promise<AssistantMessage>((resolve) => {
					finish = resolve;
				}),
			(context) => {
				steeredContext = context.messages;
				return fauxAssistantMessage("done after steering");
			},
		]);
		const run = harness.session.prompt("inspect file");
		await vi.waitFor(() => expect(finish).toBeDefined());
		expect(steeredContext).toBeUndefined();
		expect(harness.getPendingResponseCount()).toBe(1);
		const entries = harness.sessionManager.getBranch();
		finish?.(fauxAssistantMessage(`COMPRESS ${entries[0]?.id} ${entries.at(-1)?.id}`));
		await run;
		expect(harness.session.getCompressionDetectionCounts().compress).toBe(1);
		expect(harness.eventsOfType("compression_detection_result")).toHaveLength(1);
		expect(JSON.stringify(steeredContext)).toContain("Background compression detector: COMPRESS");
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "compression_detection",
			),
		).toHaveLength(1);
		expect(JSON.stringify(steeredContext).match(/Background compression detector: COMPRESS/gu)).toHaveLength(1);
		expect(JSON.stringify(harness.sessionManager.getEntries())).not.toContain("Background compression detector");
	});

	it("waits for an idle-run detector request before the next primary model request", async () => {
		const harness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		let percent = 0;
		harness.session.getContextUsage = () => ({ tokens: percent, contextWindow: 100, percent });
		harness.session.subscribe((event) => {
			if (event.type === "agent_end") percent = 50;
		});
		let finish: ((response: AssistantMessage) => void) | undefined;
		let primaryStarted = false;
		harness.setResponses([
			fauxAssistantMessage("first answer"),
			() =>
				new Promise<AssistantMessage>((resolve) => {
					finish = resolve;
				}),
			() => {
				primaryStarted = true;
				return fauxAssistantMessage("second answer");
			},
		]);
		await harness.session.prompt("first task");
		await vi.waitFor(() => expect(finish).toBeDefined());
		const secondPrompt = harness.session.prompt("second task");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(primaryStarted).toBe(false);
		finish?.(fauxAssistantMessage("CONTINUE"));
		await secondPrompt;
		expect(primaryStarted).toBe(true);
	});

	it("sends the complete active conversation and primary prompt without truncating messages or granting tools", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		const oldestText = `OLD_CONTEXT_${"a".repeat(1200)}`;
		const toolText = `TOOL_OUTPUT_${"b".repeat(3000)}_END`;
		const call = fauxToolCall("read", { path: "example.txt" });
		const messages: AgentMessage[] = [
			...Array.from({ length: 18 }, (_, index) => ({
				role: "user" as const,
				content: index === 0 ? oldestText : `message ${index}`,
				timestamp: Date.now(),
			})),
			fauxAssistantMessage([call], { stopReason: "toolUse" }),
			{
				role: "toolResult",
				toolCallId: call.id,
				toolName: "read",
				content: [
					{ type: "text", text: toolText },
					{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				],
				isError: false,
				timestamp: Date.now(),
			},
		];
		let request: Message[] | undefined;
		harness.setResponses([
			(context) => {
				request = context.messages;
				expect(context.tools).toBeUndefined();
				return fauxAssistantMessage("CONTINUE");
			},
		]);
		const detector = new CompressionDetector(harness.settingsManager, harness.session.modelRegistry);
		detector.check(15, messages, "Primary instructions must remain available");
		await vi.waitFor(() => expect(request).toBeDefined());
		const serialized = JSON.stringify(request);
		expect(request).toHaveLength(messages.length + 2);
		expect(serialized).toContain("Primary instructions must remain available");
		expect(serialized).toContain(oldestText);
		expect(serialized).toContain(toolText);
		expect(serialized).toContain("aW1hZ2U=");
		expect(serialized).toContain(call.id);
	});
	it("accepts a suggested bounded range without making it an automatic compression", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		const startEntryId = harness.sessionManager.appendMessage({ role: "user", content: "older task", timestamp: 1 });
		const endEntryId = harness.sessionManager.appendMessage(fauxAssistantMessage("older result"));
		const branch = harness.sessionManager.getBranch();
		const detector = new CompressionDetector(harness.settingsManager, harness.session.modelRegistry);
		let roster = "";
		harness.setResponses([
			(context) => {
				roster = JSON.stringify(context.messages);
				return fauxAssistantMessage(`COMPRESS ${startEntryId} ${endEntryId}`);
			},
		]);
		detector.check(15, harness.sessionManager.buildSessionContext().messages, "", branch);
		await vi.waitFor(() => expect(detector.suggestedRange).toEqual({ startEntryId, endEntryId }));
		expect(roster).toContain(startEntryId);
		expect(roster).toContain(endEntryId);
		expect(harness.sessionManager.getBranch().map((entry) => entry.id)).toEqual(branch.map((entry) => entry.id));
		expect(detector.counts.compress).toBe(1);
		detector.reset();
		expect(detector.suggestedRange).toBeUndefined();
	});

	it("lets the detector verify session facts through bounded read-only search and entry lookup", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		const start = harness.sessionManager.appendMessage({ role: "user", content: "older task fact", timestamp: 1 });
		const end = harness.sessionManager.appendMessage(fauxAssistantMessage("older answer"));
		const detector = new CompressionDetector(
			harness.settingsManager,
			harness.session.modelRegistry,
			undefined,
			undefined,
			undefined,
			{
				getBranch: () => harness.sessionManager.getBranch(),
				getRangeError: (first, last) => getSuggestedCompressionRangeError(harness.sessionManager, first, last),
				session: harness.sessionManager,
			},
		);
		harness.setResponses([
			(context) => {
				expect(context.tools?.map((tool) => tool.name)).toEqual(["session_search", "session_entry_get"]);
				return fauxAssistantMessage(
					[fauxToolCall("session_search", { pattern: "older task fact", fixedStrings: true })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				expect(JSON.stringify(context.messages.at(-1))).toContain(start);
				return fauxAssistantMessage([fauxToolCall("session_entry_get", { entryId: start })], {
					stopReason: "toolUse",
				});
			},
			(context) => {
				expect(JSON.stringify(context.messages.at(-1))).toContain("older task fact");
				return fauxAssistantMessage(`COMPRESS ${start} ${end}`);
			},
		]);
		detector.check(15, harness.sessionManager.buildSessionContext().messages, "", harness.sessionManager.getBranch());
		await detector.waitForIdle();
		expect(detector.suggestedRange).toEqual({ startEntryId: start, endEntryId: end });
		expect(detector.counts).toEqual({ keep: 0, compress: 1 });
		expect(harness.sessionManager.getBranch()).toHaveLength(2);
	});

	it("limits detector tool calls, rejects unknown tools, and requests a final verdict without tools", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		const detector = new CompressionDetector(
			harness.settingsManager,
			harness.session.modelRegistry,
			undefined,
			undefined,
			undefined,
			{
				getBranch: () => harness.sessionManager.getBranch(),
				getRangeError: (first, last) => getSuggestedCompressionRangeError(harness.sessionManager, first, last),
				session: harness.sessionManager,
			},
		);
		let calls = 0;
		harness.setResponses([
			...Array.from({ length: 4 }, () => (context: Context) => {
				expect(context.messages.at(-1)?.role === "toolResult" || calls === 0).toBe(true);
				calls++;
				return fauxAssistantMessage([fauxToolCall("bash", { command: "printf must-not-run" })], {
					stopReason: "toolUse",
				});
			}),
			(context) => {
				expect(context.tools).toBeUndefined();
				expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", isError: true });
				return fauxAssistantMessage("CONTINUE");
			},
		]);
		detector.check(15, []);
		await detector.waitForIdle();
		expect(calls).toBe(4);
		expect(detector.counts).toEqual({ keep: 1, compress: 0 });
	});

	it("does not execute or forward an oversized batch of detector tool calls", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		const detector = new CompressionDetector(
			harness.settingsManager,
			harness.session.modelRegistry,
			undefined,
			undefined,
			undefined,
			{
				getBranch: () => harness.sessionManager.getBranch(),
				getRangeError: (first, last) => getSuggestedCompressionRangeError(harness.sessionManager, first, last),
				session: harness.sessionManager,
			},
		);
		harness.setResponses([
			fauxAssistantMessage(
				Array.from({ length: 5 }, () => fauxToolCall("session_search", { pattern: "test" })),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("should remain unused"),
		]);
		detector.check(15, []);
		await detector.waitForIdle();
		expect(detector.counts).toEqual({ keep: 0, compress: 0 });
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("ignores unavailable range IDs while keeping a valid COMPRESS verdict", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		const detector = new CompressionDetector(harness.settingsManager, harness.session.modelRegistry);
		harness.setResponses([fauxAssistantMessage("COMPRESS missing-start missing-end")]);
		detector.check(15, [], "", harness.sessionManager.getBranch());
		await vi.waitFor(() => expect(detector.counts.compress).toBe(1));
		expect(detector.shouldCompress).toBe(true);
		expect(detector.suggestedRange).toBeUndefined();
	});
	it("retries a stale range with validation feedback and current IDs before advising the primary agent", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		const start = harness.sessionManager.appendMessage({ role: "user", content: "older task", timestamp: 1 });
		const end = harness.sessionManager.appendMessage(fauxAssistantMessage("older answer"));
		const detector = new CompressionDetector(
			harness.settingsManager,
			harness.session.modelRegistry,
			undefined,
			undefined,
			undefined,
			{
				getBranch: () => harness.sessionManager.getBranch(),
				getRangeError: (first, last) => getSuggestedCompressionRangeError(harness.sessionManager, first, last),
			},
		);
		let retryPrompt = "";
		harness.setResponses([
			fauxAssistantMessage("COMPRESS missing-start missing-end urgency=75%"),
			(context) => {
				retryPrompt = JSON.stringify(context.messages);
				return fauxAssistantMessage(`COMPRESS ${start} ${end} urgency=70%`);
			},
		]);
		detector.check(15, harness.sessionManager.buildSessionContext().messages, "", harness.sessionManager.getBranch());
		await vi.waitFor(() => expect(detector.suggestedRange).toEqual({ startEntryId: start, endEntryId: end }));
		expect(retryPrompt).toContain("startEntryId must be a message in the current model context");
		expect(retryPrompt).toContain(start);
		expect(retryPrompt).toContain(end);
		expect(detector.counts).toEqual({ keep: 0, compress: 1 });
		expect(detector.urgency).toBe(70);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("allows a corrective range retry to inspect entries before advising the main agent", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		const start = harness.sessionManager.appendMessage({
			role: "user",
			content: "original constraint",
			timestamp: 1,
		});
		const end = harness.sessionManager.appendMessage(fauxAssistantMessage("previous work"));
		const detector = new CompressionDetector(
			harness.settingsManager,
			harness.session.modelRegistry,
			undefined,
			undefined,
			undefined,
			{
				getBranch: () => harness.sessionManager.getBranch(),
				getRangeError: (first, last) => getSuggestedCompressionRangeError(harness.sessionManager, first, last),
				session: harness.sessionManager,
			},
		);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("session_search", { pattern: "original constraint", fixedStrings: true })],
				{ stopReason: "toolUse" },
			),
			(context) => {
				expect(JSON.stringify(context.messages.at(-1))).toContain(start);
				return fauxAssistantMessage("COMPRESS missing missing");
			},
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("The proposed range is unusable");
				expect(context.tools?.map((tool) => tool.name)).toEqual(["session_search", "session_entry_get"]);
				return fauxAssistantMessage([fauxToolCall("session_entry_get", { entryId: start })], {
					stopReason: "toolUse",
				});
			},
			(context) => {
				expect(JSON.stringify(context.messages.at(-1))).toContain("original constraint");
				return fauxAssistantMessage(`COMPRESS ${start} ${end}`);
			},
		]);
		detector.check(15, harness.sessionManager.buildSessionContext().messages, "", harness.sessionManager.getBranch());
		await detector.waitForIdle();
		expect(detector.suggestedRange).toEqual({ startEntryId: start, endEntryId: end });
		expect(detector.counts).toEqual({ keep: 0, compress: 1 });
	});

	it("retries a range-free verdict once and drops an invalid retry's IDs", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		const start = harness.sessionManager.appendMessage({ role: "user", content: "older task", timestamp: 1 });
		const end = harness.sessionManager.appendMessage(fauxAssistantMessage("older answer"));
		const detector = new CompressionDetector(
			harness.settingsManager,
			harness.session.modelRegistry,
			undefined,
			undefined,
			undefined,
			{
				getBranch: () => harness.sessionManager.getBranch(),
				getRangeError: (first, last) => getSuggestedCompressionRangeError(harness.sessionManager, first, last),
			},
		);
		harness.setResponses([
			fauxAssistantMessage("COMPRESS urgency=90%"),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("No range was supplied");
				return fauxAssistantMessage(`COMPRESS ${end} ${start}`);
			},
		]);
		detector.check(15, harness.sessionManager.buildSessionContext().messages, "", harness.sessionManager.getBranch());
		await vi.waitFor(() => expect(detector.counts.compress).toBe(1));
		expect(detector.shouldCompress).toBe(true);
		expect(detector.suggestedRange).toBeUndefined();
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(detector.urgency).toBe(90);
	});
	it("does not run the percentage trigger below fifteen percent", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		const detector = new CompressionDetector(harness.settingsManager, harness.session.modelRegistry);
		harness.setResponses([fauxAssistantMessage("CONTINUE")]);
		for (const percent of [5, 10, 14.9]) detector.check(percent, []);
		expect(harness.getPendingResponseCount()).toBe(1);
		detector.check(15, []);
		await detector.waitForIdle();
		expect(detector.counts.keep).toBe(1);
		detector.reset([], 0);
		harness.setResponses([fauxAssistantMessage("CONTINUE")]);
		const tenMessages = Array.from({ length: 10 }, (_, index) => ({
			role: "user" as const,
			content: `task ${index}`,
			timestamp: Date.now(),
		}));
		detector.check(1, tenMessages);
		await detector.waitForIdle();
		expect(detector.counts.keep).toBe(2);
	});
	it("checks after five percentage points or ten user messages/tool results, whichever comes first", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		const detector = new CompressionDetector(harness.settingsManager, harness.session.modelRegistry);
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		harness.setResponses([
			fauxAssistantMessage("COMPRESS"),
			fauxAssistantMessage("CONTINUE"),
			fauxAssistantMessage("COMPRESS"),
		]);
		detector.check(15, []);
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(2));
		expect(detector.shouldCompress).toBe(true);
		expect(detector.counts).toEqual({ keep: 0, compress: 1 });
		detector.check(19.9, []);
		expect(harness.getPendingResponseCount()).toBe(2);
		detector.check(20, []);
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(1));
		expect(detector.shouldCompress).toBe(false);
		expect(detector.counts).toEqual({ keep: 1, compress: 1 });
		const tenMessages = Array.from({ length: 10 }, (_, index) => ({
			role: "user" as const,
			content: `message ${index}`,
			timestamp: Date.now(),
		}));
		detector.check(undefined, tenMessages.slice(0, 9));
		expect(harness.getPendingResponseCount()).toBe(1);
		detector.check(undefined, tenMessages);
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0));
		expect(detector.shouldCompress).toBe(true);
		expect(detector.counts).toEqual({ keep: 1, compress: 2 });
		detector.reset(tenMessages);
		expect(detector.shouldCompress).toBe(false);
		harness.setResponses([fauxAssistantMessage("CONTINUE")]);
		detector.check(undefined, tenMessages);
		expect(harness.getPendingResponseCount()).toBe(1);
		const twentyMessages = [...tenMessages, ...tenMessages];
		detector.check(undefined, twentyMessages.slice(0, 19));
		expect(harness.getPendingResponseCount()).toBe(1);
		detector.check(undefined, twentyMessages);
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0));
		expect(detector.shouldCompress).toBe(false);
		expect(detector.counts).toEqual({ keep: 2, compress: 2 });
	});
	it("ignores assistant responses when counting ten incoming messages and resets from that count", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		const detector = new CompressionDetector(harness.settingsManager, harness.session.modelRegistry);
		harness.setResponses([fauxAssistantMessage("CONTINUE"), fauxAssistantMessage("CONTINUE")]);
		detector.check(15, []);
		await detector.waitForIdle();
		const assistants = Array.from({ length: 12 }, () => fauxAssistantMessage("assistant response"));
		detector.check(undefined, assistants);
		expect(harness.getPendingResponseCount()).toBe(1);
		const toolResults: AgentMessage[] = Array.from({ length: 9 }, (_, index) => ({
			role: "toolResult",
			toolCallId: `call-${index}`,
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: Date.now(),
		}));
		detector.check(undefined, [...assistants, ...toolResults]);
		expect(harness.getPendingResponseCount()).toBe(1);
		const userMessage: AgentMessage = { role: "user", content: "next task", timestamp: Date.now() };
		const messages = [...assistants, ...toolResults, userMessage];
		detector.check(undefined, messages);
		await detector.waitForIdle();
		expect(detector.counts.keep).toBe(2);
		detector.reset(messages);
		harness.setResponses([fauxAssistantMessage("CONTINUE")]);
		detector.check(undefined, [...messages, ...assistants]);
		expect(harness.getPendingResponseCount()).toBe(1);
		detector.check(undefined, [...messages, ...assistants, ...toolResults, userMessage]);
		await detector.waitForIdle();
		expect(detector.counts.keep).toBe(3);
	});
	it("uses the rebuilt context percentage as the post-compression threshold baseline", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		const detector = new CompressionDetector(harness.settingsManager, harness.session.modelRegistry);
		harness.setResponses([
			fauxAssistantMessage("CONTINUE"),
			fauxAssistantMessage("CONTINUE"),
			fauxAssistantMessage("CONTINUE"),
		]);
		detector.check(15, []);
		await detector.waitForIdle();
		detector.reset([], 40);
		detector.check(40, []);
		detector.check(44.9, []);
		expect(harness.getPendingResponseCount()).toBe(2);
		detector.check(45, []);
		await detector.waitForIdle();
		expect(harness.getPendingResponseCount()).toBe(1);

		// Standard compaction reports unknown usage until a post-compaction response arrives.
		detector.reset([], null);
		detector.check(null, []);
		detector.check(32, []);
		detector.check(36.9, []);
		expect(harness.getPendingResponseCount()).toBe(1);
		detector.check(37, []);
		await detector.waitForIdle();
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(detector.counts).toEqual({ keep: 3, compress: 0 });
		const coldDetector = new CompressionDetector(harness.settingsManager, harness.session.modelRegistry);
		coldDetector.reset([], 40);
		coldDetector.check(40, []);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
	it("coalesces progress during an in-flight request and rechecks latest context after it finishes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		let finish: ((response: AssistantMessage) => void) | undefined;
		let secondRequest = "";
		harness.setResponses([
			() =>
				new Promise<AssistantMessage>((resolve) => {
					finish = resolve;
				}),
			(context, options) => {
				secondRequest = JSON.stringify(context);
				expect(options?.maxTokens).toBe(64);
				return fauxAssistantMessage("COMPRESS");
			},
		]);
		const activity: boolean[] = [];
		const detector = new CompressionDetector(harness.settingsManager, harness.session.modelRegistry, (active) => {
			activity.push(active);
		});
		const messages = Array.from({ length: 5 }, (_, index) => ({
			role: "user" as const,
			content: `message ${index}`,
			timestamp: Date.now(),
		}));
		detector.check(15, messages.slice(0, 1));
		await vi.waitFor(() => expect(finish).toBeDefined());
		detector.check(8, messages.slice(0, 2));
		detector.check(10, messages.slice(0, 3));
		detector.check(15, messages, "latest-system-prompt");
		expect(harness.getPendingResponseCount()).toBe(1);
		finish?.(fauxAssistantMessage("CONTINUE"));
		await vi.waitFor(() => expect(activity).toEqual([true, false, true, false]));
		expect(secondRequest).toContain("Current context usage: 15.0%");
		expect(secondRequest).toContain("message 4");
		expect(secondRequest).toContain("latest-system-prompt");
		expect(detector.shouldCompress).toBe(true);
	});
	it("records scored CONTINUE verdicts and rejects out-of-range urgency", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		const detector = new CompressionDetector(
			harness.settingsManager,
			harness.session.modelRegistry,
			undefined,
			undefined,
			undefined,
			{
				getBranch: () => harness.sessionManager.getBranch(),
				getRangeError: () => undefined,
				recordEvent: (event) => appendCompressionDetectionEvent(harness.sessionManager, event),
			},
		);
		harness.setResponses([
			fauxAssistantMessage("CONTINUE urgency=101%"),
			fauxAssistantMessage("CONTINUE urgency=12%"),
		]);
		detector.check(15, []);
		await detector.waitForIdle();
		expect(detector.counts).toEqual({ keep: 0, compress: 0 });
		detector.check(20, []);
		await detector.waitForIdle();
		expect(detector.counts).toEqual({ keep: 1, compress: 0 });
		expect(readCompressionDetectionLedger(harness.sessionManager.getEntries()).verdicts[0]?.urgency).toBe(12);
	});

	it("counts only exact successful verdicts and reports completed results", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		const verdicts: string[] = [];
		const detector = new CompressionDetector(
			harness.settingsManager,
			harness.session.modelRegistry,
			undefined,
			(verdict) => verdicts.push(verdict),
		);
		harness.setResponses([
			fauxAssistantMessage("MAYBE"),
			fauxAssistantMessage("COMPRESS"),
			fauxAssistantMessage("CONTINUE"),
			fauxAssistantMessage("COMPRESS", { stopReason: "error", errorMessage: "provider failed" }),
		]);
		detector.check(15, []);
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(3));
		expect(detector.counts).toEqual({ keep: 0, compress: 0 });
		detector.check(20, []);
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(2));
		detector.check(25, []);
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(1));
		detector.check(30, []);
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0));
		expect(detector.counts).toEqual({ keep: 1, compress: 1 });
		expect(verdicts).toEqual(["COMPRESS", "CONTINUE"]);
	});
	it("discards queued progress when detection is reset", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		let finish: ((response: AssistantMessage) => void) | undefined;
		harness.setResponses([
			() =>
				new Promise<AssistantMessage>((resolve) => {
					finish = resolve;
				}),
			fauxAssistantMessage("should remain queued"),
		]);
		const detector = new CompressionDetector(harness.settingsManager, harness.session.modelRegistry);
		detector.check(15, []);
		await vi.waitFor(() => expect(finish).toBeDefined());
		detector.check(15, []);
		detector.reset();
		finish?.(fauxAssistantMessage("CONTINUE"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(detector.counts).toEqual({ keep: 0, compress: 0 });
	});
	it("releases a waiting turn on abort or reset even if the detector request hangs", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		harness.setResponses([() => new Promise<AssistantMessage>(() => {})]);
		const detector = new CompressionDetector(harness.settingsManager, harness.session.modelRegistry);
		detector.check(15, []);
		const controller = new AbortController();
		let released = false;
		const waiting = detector.waitForIdle(controller.signal).then(() => {
			released = true;
		});
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0));
		expect(released).toBe(false);
		controller.abort();
		await waiting;
		expect(released).toBe(true);
		const waitingForReset = detector.waitForIdle();
		detector.reset();
		await waitingForReset;
	});

	it("emits background activity only while the detection request is in flight", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		let finish: ((response: AssistantMessage) => void) | undefined;
		harness.setResponses([
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		]);
		const activity: boolean[] = [];
		const detector = new CompressionDetector(harness.settingsManager, harness.session.modelRegistry, (active) =>
			activity.push(active),
		);
		detector.check(15, []);
		expect(activity).toEqual([true]);
		await vi.waitFor(() => expect(finish).toBeDefined());
		finish?.(fauxAssistantMessage("CONTINUE"));
		await vi.waitFor(() => expect(activity).toEqual([true, false]));
		// Cancellation must hide the indicator immediately, even if the provider has not returned.
		harness.setResponses([() => new Promise(() => {})]);
		detector.check(20, []);
		expect(activity).toEqual([true, false, true]);
		detector.reset();
		expect(activity).toEqual([true, false, true, false]);
	});

	it("selects a detector model without changing the primary model default", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.settingsManager.setDefaultModelAndProvider("primary", "main");
		setKeybindings(new KeybindingsManager());
		initTheme("dark");
		const model = harness.getModel();
		const selector = new ModelSelectorComponent(
			{ requestRender: () => {} } as unknown as TUI,
			model,
			harness.settingsManager,
			harness.session.modelRegistry,
			[],
			(selected) => harness.settingsManager.setCompressionDetectionModel(`${selected.provider}/${selected.id}`),
			() => {},
			undefined,
			false,
		);
		await vi.waitFor(() => expect(selector.render(120).join("")).toContain(model.id));
		selector.handleInput("\r");
		expect(harness.settingsManager.getCompressionDetectionModel()).toBe(`${model.provider}/${model.id}`);
		expect(harness.settingsManager.getDefaultModel()).toBe("main");
		expect(harness.settingsManager.getDefaultProvider()).toBe("primary");
	});
	it("restores detector cost and suggested verdicts from a reopened JSONL session", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const manager = new LocalSessionManager({ cwd: harness.tempDir, sessionDir: join(harness.tempDir, "sessions") });
		const session = manager.create();
		const start = session.appendMessage({ role: "user", content: "older", timestamp: 1 });
		session.appendMessage(fauxAssistantMessage("older answer"));
		appendCompressionDetectionEvent(session, {
			kind: "response",
			model: "test/detector",
			stopReason: "stop",
			cost: 0.017,
		});
		appendCompressionDetectionEvent(session, {
			kind: "verdict",
			model: "test/detector",
			verdict: "COMPRESS",
			suggestion: { startEntryId: start, endEntryId: start },
		});
		const reference = session.getSessionReference();
		expect(reference).toBeDefined();
		if (!reference) throw new Error("Session reference was not created");
		const reopened = manager.openReference(reference);
		expect(reopened.getEntries()).toEqual(session.getEntries());
		const history = readCompressionDetectionLedger(reopened.getEntries());
		expect(history).toMatchObject({ cost: 0.017, keep: 0, compress: 1 });
		expect(history.verdicts[0]?.suggestion).toEqual({ startEntryId: start, endEntryId: start });
		expect(reopened.buildSessionContext().messages).toHaveLength(2);
	});

	it("deduplicates replayed detector records across branches and retains decisions", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const session = harness.sessionManager;
		const first = session.appendMessage({ role: "user", content: "earlier", timestamp: 1 });
		appendCompressionDetectionEvent(session, {
			kind: "response",
			model: "test/detector",
			stopReason: "stop",
			cost: 0.012,
		});
		appendCompressionDetectionEvent(session, {
			kind: "verdict",
			model: "test/detector",
			verdict: "COMPRESS",
			suggestion: { startEntryId: first, endEntryId: first },
		});
		const replay = session
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "compression_detection_event");
		for (const entry of replay) session.appendReplayedEntry(entry, new Map());
		appendCompressionDetectionEvent(session, { kind: "verdict", model: "test/detector", verdict: "CONTINUE" });
		const history = readCompressionDetectionLedger(session.getEntries());
		expect(history).toMatchObject({ cost: 0.012, keep: 1, compress: 1 });
		expect(history.verdicts.map((event) => event.verdict)).toEqual(["COMPRESS", "CONTINUE"]);
		expect(history.verdicts[0]?.suggestion).toEqual({ startEntryId: first, endEntryId: first });
	});

	it("persists invalid-response cost and verdict totals through detector resets", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		const priced = (text: string, cost: number): AssistantMessage => {
			const response = fauxAssistantMessage(text);
			return { ...response, usage: { ...response.usage, cost: { ...response.usage.cost, total: cost } } };
		};
		const responses = [priced("MAYBE", 0.01), priced("CONTINUE", 0.0025)];
		const detector = new CompressionDetector(
			harness.settingsManager,
			harness.session.modelRegistry,
			undefined,
			undefined,
			async () => {
				const response = responses.shift();
				if (!response) throw new Error("No detector response queued");
				return response;
			},
			{
				getBranch: () => harness.sessionManager.getBranch(),
				getRangeError: () => undefined,
				recordEvent: (event) => appendCompressionDetectionEvent(harness.sessionManager, event),
			},
		);
		detector.check(15, []);
		await detector.waitForIdle();
		expect(harness.session.getCompressionDetectionCost()).toBeCloseTo(0.01);
		expect(harness.session.getCompressionDetectionCounts()).toEqual({ keep: 0, compress: 0 });
		detector.reset();
		detector.check(20, []);
		await detector.waitForIdle();
		expect(harness.session.getCompressionDetectionCost()).toBeCloseTo(0.0125);
		expect(harness.session.getCompressionDetectionCounts()).toEqual({ keep: 1, compress: 0 });
		harness.settingsManager.setCompressionDetectionModel(undefined);
		expect(readCompressionDetectionLedger(harness.sessionManager.getEntries()).verdicts[0]).toMatchObject({
			verdict: "CONTINUE",
		});
	});

	it("tracks detector response cost separately, including invalid verdicts and across resets", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		harness.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		const invalid = fauxAssistantMessage("MAYBE");
		const valid = fauxAssistantMessage("CONTINUE");
		const responses: AssistantMessage[] = [
			{ ...invalid, usage: { ...invalid.usage, cost: { ...invalid.usage.cost, total: 0.01 } } },
			{ ...valid, usage: { ...valid.usage, cost: { ...valid.usage.cost, total: 0.0025 } } },
		];
		const detector = new CompressionDetector(
			harness.settingsManager,
			harness.session.modelRegistry,
			undefined,
			undefined,
			async () => {
				const response = responses.shift();
				if (!response) throw new Error("No detector response queued");
				return response;
			},
		);
		detector.check(15, []);
		await vi.waitFor(() => expect(detector.cost).toBeCloseTo(0.01));
		expect(detector.counts).toEqual({ keep: 0, compress: 0 });
		detector.check(20, []);
		await vi.waitFor(() => expect(detector.counts.keep).toBe(1));
		expect(detector.cost).toBeCloseTo(0.0125);
		detector.reset();
		harness.settingsManager.setCompressionDetectionModel(undefined);
		detector.check(15, []);
		expect(detector.cost).toBeCloseTo(0.0125);
	});
});
