import { type AssistantMessage, fauxAssistantMessage } from "@fleetagent/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACTIVE_TOOL_NAMES, getDefaultActiveToolNames } from "../../src/core/agent-session.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "./harness.ts";

interface CommandTestMode {
	handleBuiltInEditorCommand(text: string): Promise<boolean>;
}

describe("context compression opt-ins", () => {
	const harnesses: Harness[] = [];
	beforeEach(() => {
		vi.stubEnv("PI_CONTEXT_COMPRESSION", undefined);
		vi.stubEnv("PI_CONTEXT_COMPRESSION_DETECTION", undefined);
	});
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.dispose();
			harness.cleanup();
		}
		vi.unstubAllEnvs();
	});

	async function harness(): Promise<Harness> {
		const created = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(created);
		return created;
	}

	it("disables compression and detection even with a saved detector model", async () => {
		const created = await harness();
		const model = created.getModel();
		created.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		created.session.getContextUsage = () => ({ tokens: 50, contextWindow: 100, percent: 50 });
		expect(DEFAULT_ACTIVE_TOOL_NAMES).not.toContain("compress_context");
		expect(getDefaultActiveToolNames()).not.toContain("compress_context");
		expect(created.session.contextCompressionEnabled).toBe(false);
		expect(created.session.compressionDetectionEnabled).toBe(false);
		expect(created.session.systemPrompt).not.toContain("## State compression");
		created.setResponses([
			(context) => {
				expect(context.tools?.map((tool) => tool.name)).not.toContain("compress_context");
				expect(JSON.stringify(context.messages)).not.toContain("context metadata:");
				return fauxAssistantMessage("done");
			},
			fauxAssistantMessage("unused detector response"),
		]);
		await created.session.prompt("task");
		expect(created.getPendingResponseCount()).toBe(1);
		expect(created.eventsOfType("compression_detection_activity")).toEqual([]);
		expect(created.settingsManager.getCompactionEnabled()).toBe(false);
	});

	it("enables compression alone through the environment", async () => {
		vi.stubEnv("PI_CONTEXT_COMPRESSION", "1");
		const created = await harness();
		expect(getDefaultActiveToolNames()).toContain("compress_context");
		expect(created.session.contextCompressionEnabled).toBe(true);
		expect(created.session.compressionDetectionEnabled).toBe(false);
		const model = created.getModel();
		created.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		created.session.getContextUsage = () => ({ tokens: 50, contextWindow: 100, percent: 50 });
		created.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("unused")]);
		await created.session.prompt("task");
		expect(created.getPendingResponseCount()).toBe(1);
	});

	it("enables detection and its compression tool through the environment", async () => {
		vi.stubEnv("PI_CONTEXT_COMPRESSION_DETECTION", "1");
		const created = await harness();
		const model = created.getModel();
		created.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		created.session.getContextUsage = () => ({ tokens: 50, contextWindow: 100, percent: 50 });
		expect(created.session.contextCompressionEnabled).toBe(true);
		expect(created.session.compressionDetectionEnabled).toBe(true);
		created.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("CONTINUE")]);
		await created.session.prompt("task");
		await vi.waitFor(() => expect(created.session.getCompressionDetectionCounts().keep).toBe(1));
	});

	it.each([undefined, "0", "false", "yes"])("does not opt in with env value %s", (value) => {
		vi.stubEnv("PI_CONTEXT_COMPRESSION", value);
		vi.stubEnv("PI_CONTEXT_COMPRESSION_DETECTION", value);
		expect(getDefaultActiveToolNames()).not.toContain("compress_context");
	});

	it("keeps session toggles across reload without changing future-session defaults", async () => {
		const created = await harness();
		const initialSettings = created.settingsManager.getGlobalSettings();
		created.session.setContextCompressionEnabled(true);
		expect(created.session.systemPrompt).toContain("## State compression");
		await created.session.reload();
		expect(created.session.contextCompressionEnabled).toBe(true);
		created.session.setContextCompressionEnabled(false);
		await created.session.reload();
		expect(created.session.contextCompressionEnabled).toBe(false);
		expect(created.settingsManager.getGlobalSettings()).toEqual(initialSettings);
		expect((await harness()).session.contextCompressionEnabled).toBe(false);
	});

	it("allows session opt-outs to override environment defaults across reload", async () => {
		vi.stubEnv("PI_CONTEXT_COMPRESSION_DETECTION", "1");
		const created = await harness();
		created.session.setCompressionDetectionEnabled(false);
		created.session.setContextCompressionEnabled(false);
		await created.session.reload();
		expect(created.session.contextCompressionEnabled).toBe(false);
		expect(created.session.compressionDetectionEnabled).toBe(false);
		created.session.setActiveToolsByName([...created.session.getActiveToolNames(), "compress_context"]);
		expect(created.session.contextCompressionEnabled).toBe(false);
		expect((await harness()).session.contextCompressionEnabled).toBe(true);
	});

	it("requires a detector model and respects tool restrictions", async () => {
		const created = await harness();
		expect(() => created.session.setCompressionDetectionEnabled(true)).toThrow("Choose a detection model");
		expect(created.session.contextCompressionEnabled).toBe(false);
		const restricted = await createHarness({ tools: [] });
		harnesses.push(restricted);
		expect(() => restricted.session.setContextCompressionEnabled(true)).toThrow("tool restrictions");
		expect(() => restricted.session.setCompressionDetectionModel("test/model")).toThrow("tool restrictions");
		expect(restricted.settingsManager.getCompressionDetectionModel()).toBeUndefined();
	});

	it.each(["compression", "detection"])("cancels an in-flight detector when disabling %s", async (feature) => {
		const created = await harness();
		const model = created.getModel();
		created.session.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		let percent = 0;
		created.session.getContextUsage = () => ({ tokens: percent, contextWindow: 100, percent });
		created.session.subscribe((event) => {
			if (event.type === "agent_end") percent = 50;
		});
		let finish: ((message: AssistantMessage) => void) | undefined;
		created.setResponses([
			fauxAssistantMessage("done"),
			() =>
				new Promise<AssistantMessage>((resolve) => {
					finish = resolve;
				}),
		]);
		await created.session.prompt("first task");
		await vi.waitFor(() => expect(finish).toBeDefined());
		if (feature === "compression") created.session.setContextCompressionEnabled(false);
		else created.session.setCompressionDetectionEnabled(false);
		expect(created.eventsOfType("compression_detection_activity").at(-1)?.active).toBe(false);
		created.setResponses([fauxAssistantMessage("next answer")]);
		await created.session.prompt("next task");
		finish?.(fauxAssistantMessage("COMPRESS urgency=90%"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(created.session.getCompressionDetectionCounts().compress).toBe(0);
		expect(JSON.stringify(created.session.messages)).not.toContain("Background compression detector");
	});

	it("handles session commands, status queries, and invalid arguments without model calls", async () => {
		const created = await harness();
		const status = vi.fn();
		const warning = vi.fn();
		const error = vi.fn();
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: { session: created.session },
			editor: { setText: vi.fn() },
			showStatus: status,
			showWarning: warning,
			showError: error,
		}) as CommandTestMode;
		expect(await mode.handleBuiltInEditorCommand("/context-compression on")).toBe(true);
		expect(created.session.contextCompressionEnabled).toBe(true);
		await mode.handleBuiltInEditorCommand("/context-compression");
		expect(status).toHaveBeenLastCalledWith("Context compression enabled for this session");
		await mode.handleBuiltInEditorCommand("/compress-detection on");
		expect(error).toHaveBeenCalledWith(expect.stringContaining("Choose a detection model"));
		const model = created.getModel();
		created.settingsManager.setCompressionDetectionModel(`${model.provider}/${model.id}`);
		await mode.handleBuiltInEditorCommand("/compress-detection on");
		expect(created.session.compressionDetectionEnabled).toBe(true);
		await mode.handleBuiltInEditorCommand("/compress-detection off");
		expect(created.session.compressionDetectionEnabled).toBe(false);
		expect(created.session.contextCompressionEnabled).toBe(true);
		await mode.handleBuiltInEditorCommand("/context-compression invalid");
		expect(warning).toHaveBeenCalledWith("Usage: /context-compression [on|off]");
		await mode.handleBuiltInEditorCommand("/context-compression off");
		expect(created.session.contextCompressionEnabled).toBe(false);
	});
});
