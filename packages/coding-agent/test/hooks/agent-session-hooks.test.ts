import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@fleetagent/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@fleetagent/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	adaptFileToolInputForClaudeHook,
	adaptFileToolUpdatedInputFromClaudeHook,
	classifyStopFailure,
} from "../../src/core/agent-session.ts";
import type {
	HookEventName,
	HookExecutionNotice,
	HookInput,
	HookSettingsSource,
	LoadedHooks,
} from "../../src/core/hooks/types.ts";
import type { ToolExecOptions, ToolOperations } from "../../src/core/tools/operations.ts";
import { createHarness, getMessageText, type Harness } from "../suite/harness.ts";

interface HookScriptEntry {
	event: HookEventName;
	script: string;
	matcher?: string;
	if?: string;
}
const source = { kind: "host" as const, path: "host-injected" };
const projectSource = { kind: "project" as const, path: "/test/.pi/settings.json" };

function hooks(entries: HookScriptEntry[], hookSource: HookSettingsSource = source): LoadedHooks {
	return Object.freeze({
		handlers: Object.freeze(
			entries.map((entry, order) =>
				Object.freeze({
					event: entry.event,
					matcher: entry.matcher,
					handler: Object.freeze({
						type: "command" as const,
						command: process.execPath,
						args: ["-e", entry.script],
						if: entry.if,
					}),
					source: hookSource,
					order,
				}),
			),
		),
		diagnostics: Object.freeze([]),
		sources: Object.freeze([hookSource]),
	});
}

function jsonScript(value: unknown): string {
	return `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify(value))}))`;
}

describe("hook path and failure adaptation", () => {
	it.each([
		["posix", "/workspace/project", "src/../README.md", "/workspace/project/README.md"],
		["posix", "/workspace/project", "../../shared/file", "/shared/file"],
		["windows", "C:\\work\\project", "src\\..\\README.md", "C:\\work\\project\\README.md"],
		["windows", "D:\\remote\\project", "..\\shared\\file", "D:\\remote\\shared\\file"],
	] as const)("resolves %s file_path lexically", (flavor, cwd, path, expected) => {
		const adapted = adaptFileToolInputForClaudeHook("read", { path, offset: 2 }, cwd, flavor);
		expect(adapted).toEqual({ file_path: expected, offset: 2 });
		expect(adaptFileToolUpdatedInputFromClaudeHook("read", adapted, cwd, flavor)).toEqual({
			path: expected,
			offset: 2,
		});
	});

	it("expands local POSIX ~ paths from the host home and rejects unknown backend homes in both directions", () => {
		expect(adaptFileToolInputForClaudeHook("read", { path: "~/notes.txt" }, "/workspace", "posix")).toEqual({
			file_path: join(homedir(), "notes.txt"),
		});
		expect(() => adaptFileToolInputForClaudeHook("read", { path: "~/notes.txt" }, "/remote", "posix", null)).toThrow(
			"without a known POSIX backend home",
		);
		expect(() =>
			adaptFileToolUpdatedInputFromClaudeHook(
				"write",
				{ file_path: "~/notes.txt", content: "x" },
				"/remote",
				"posix",
				null,
			),
		).toThrow("without a known POSIX backend home");
	});

	it("rejects ambiguous reverse file mappings", () => {
		expect(() =>
			adaptFileToolUpdatedInputFromClaudeHook(
				"write",
				{ path: "escape", file_path: "/safe/file", content: "x" },
				"/safe",
				"posix",
			),
		).toThrow("must not contain path");
	});

	it.each([
		["429 too many requests", "rate_limit"],
		["403 billing credit exhausted", "billing_error"],
		["unknown model returned 404", "model_not_found"],
		["context length exceeds window (400)", "invalid_request"],
		["gateway connection timeout 502", "server_error"],
		["something novel", "unknown"],
	])("classifies StopFailure %s", (message, category) => {
		expect(classifyStopFailure(message)).toBe(category);
	});
});

describe("AgentSession Claude-compatible hooks", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("blocks an unpersisted prompt and injects accepted context exactly once", async () => {
		const blocked = await createHarness({
			loadedHooks: hooks([
				{ event: "UserPromptSubmit", script: jsonScript({ decision: "block", reason: "policy" }) },
			]),
		});
		harnesses.push(blocked);
		blocked.setResponses([fauxAssistantMessage("unused")]);
		await expect(blocked.session.prompt("secret")).rejects.toThrow("policy");
		expect(blocked.session.messages).toHaveLength(0);
		expect(blocked.sessionManager.getEntries()).toHaveLength(0);
		expect(blocked.getPendingResponseCount()).toBe(1);

		let contextCount = 0;
		const accepted = await createHarness({
			loadedHooks: hooks([
				{
					event: "UserPromptSubmit",
					script: jsonScript({
						hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "hook-context" },
					}),
				},
			]),
		});
		harnesses.push(accepted);
		accepted.setResponses([
			(context) => {
				contextCount = context.messages.filter((message) => getMessageText(message) === "hook-context").length;
				return fauxAssistantMessage("ok");
			},
		]);
		await accepted.session.prompt("hello");
		expect(contextCount).toBe(1);
		expect(accepted.session.messages.filter((message) => getMessageText(message) === "hook-context")).toHaveLength(1);
	});

	it("publishes matching hook executions to UI observers without creating display messages", async () => {
		const harness = await createHarness({
			loadedHooks: hooks([
				{
					event: "UserPromptSubmit",
					script: jsonScript({
						hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "visible-to-model" },
					}),
				},
				{ event: "PreToolUse", matcher: "unused", script: jsonScript({}) },
			]),
		});
		harnesses.push(harness);
		const notices: HookExecutionNotice[] = [];
		const unsubscribe = harness.session.subscribeToHookExecutions((notice) => notices.push(notice));
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("hello");
		unsubscribe();

		expect(notices).toHaveLength(1);
		expect(notices[0].event).toBe("UserPromptSubmit");
		expect(notices[0].returnedPrompts).toEqual(["visible-to-model"]);
		expect(notices[0].calls).toHaveLength(1);
		expect(notices[0].calls[0]).not.toHaveProperty("stdout");
		expect(harness.session.messages.some((message) => message.role === "custom" && message.display)).toBe(false);
	});

	it("disables subsequent hooks without cancelling an active execution", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hook-toggle-"));
		const started = join(cwd, "started");
		const gate = join(cwd, "gate");
		const runs = join(cwd, "runs");
		const script = `const fs=require('fs');process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(started)},'started');fs.appendFileSync(${JSON.stringify(runs)},'run\\n');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);process.stdout.write('{}')}},5)})`;
		const harness = await createHarness({ loadedHooks: hooks([{ event: "UserPromptSubmit", script }]) });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
			fauxAssistantMessage("third"),
		]);

		const firstPrompt = harness.session.prompt("first");
		const deadline = Date.now() + 2000;
		while (!existsSync(started) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
		expect(existsSync(started)).toBe(true);

		harness.session.setHooksEnabled(false);
		expect(harness.session.hooksEnabled).toBe(false);
		writeFileSync(gate, "continue");
		await firstPrompt;
		await harness.session.prompt("second");
		expect(readFileSync(runs, "utf8")).toBe("run\n");

		harness.session.setHooksEnabled(true);
		expect(harness.session.hooksEnabled).toBe(true);
		await harness.session.prompt("third");
		expect(readFileSync(runs, "utf8")).toBe("run\nrun\n");
		rmSync(cwd, { recursive: true, force: true });
	});

	it("does not expose raw blocking stderr in hook execution notices", async () => {
		const harness = await createHarness({
			loadedHooks: hooks([
				{
					event: "UserPromptSubmit",
					script:
						"process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({reason:'private stderr'}));process.stderr.write('private stderr');process.exitCode=2})",
				},
			]),
		});
		harnesses.push(harness);
		const notices: HookExecutionNotice[] = [];
		harness.session.subscribeToHookExecutions((notice) => notices.push(notice));

		await expect(harness.session.prompt("blocked")).rejects.toThrow("private stderr");

		expect(notices).toHaveLength(1);
		expect(notices[0].returnedPrompts).toEqual([]);
		expect(notices[0].calls[0]).not.toHaveProperty("stderr");
	});

	it("routes approved project hooks into the sandbox after a backend switch", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-hook-backend-transition-"));
		const log = join(cwd, `pi-hook-backend-transition-${Date.now()}-${Math.random()}.log`);
		let backend: "local" | "remote" = "local";
		let workspaceInput: HookInput | undefined;
		const exec = vi.fn(async (command: string, options: ToolExecOptions) => {
			const encoded = /'([A-Za-z0-9+/=]+)'$/.exec(command)?.[1];
			if (!encoded) throw new Error("missing workspace hook specification");
			const spec = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as { stdinBase64: string };
			workspaceInput = JSON.parse(Buffer.from(spec.stdinBase64, "base64").toString("utf8")) as HookInput;
			options.onData(Buffer.from(`PIHOOK1 stdout ${Buffer.from("{}").toString("base64")}\n`));
			return { exitCode: 0 };
		});
		const toolOperations = {
			cwd,
			exec,
			getBackendInfo: () =>
				backend === "local"
					? { type: "local" as const, cwd }
					: {
							type: "remote" as const,
							cwd: "/workspace",
							configured: true as const,
							workspace: { id: "remote", root: "/workspace", pathFlavor: "posix" as const },
						},
		} as unknown as ToolOperations;
		const script = `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const i=JSON.parse(s);require('fs').appendFileSync(${JSON.stringify(log)},i.prompt+'|'+i.cwd+'\\n')})`;
		const harness = await createHarness({
			toolOperations,
			loadedHooks: hooks([{ event: "UserPromptSubmit", script }], projectSource),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("local"), fauxAssistantMessage("remote")]);

		await harness.session.prompt("first");
		expect(readFileSync(log, "utf8")).toBe(`first|${cwd}\n`);
		backend = "remote";
		await harness.session.prompt("second");
		expect(readFileSync(log, "utf8")).toBe(`first|${cwd}\n`);
		expect(exec).toHaveBeenCalledOnce();
		expect(workspaceInput).toMatchObject({ prompt: "second", cwd: "/workspace" });
		rmSync(log, { force: true });
	});

	it("admits one first prompt before a gated SessionStart and cannot bypass termination", async () => {
		const prefix = join(tmpdir(), `pi-hook-session-start-gate-${Date.now()}-${Math.random()}`);
		const started = `${prefix}.started`;
		const gate = `${prefix}.gate`;
		const script = `const fs=require('fs');process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(started)},'started');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);process.stdout.write(JSON.stringify({continue:false,stopReason:'session-stop'}))}},5)})`;
		const harness = await createHarness({ loadedHooks: hooks([{ event: "SessionStart", script }]) });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must-not-run")]);
		const first = harness.session.prompt("first");
		const deadline = Date.now() + 2000;
		while (!existsSync(started) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
		expect(existsSync(started)).toBe(true);
		await expect(harness.session.prompt("second")).rejects.toThrow("prompt admission");
		writeFileSync(gate, "open");
		await expect(first).rejects.toThrow("session-stop");
		expect(harness.session.messages).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("retains SessionStart context across a blocked prompt and settles Stop continue:false", async () => {
		const promptPolicy =
			"let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const i=JSON.parse(s);if(i.prompt==='blocked')process.stdout.write(JSON.stringify({decision:'block',reason:'policy'}))})";
		const harness = await createHarness({
			loadedHooks: hooks([
				{
					event: "SessionStart",
					script: "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('start-context'))",
				},
				{ event: "UserPromptSubmit", script: promptPolicy },
				{ event: "Stop", script: jsonScript({ continue: false, stopReason: "settle" }) },
			]),
		});
		harnesses.push(harness);
		await expect(harness.session.prompt("blocked")).rejects.toThrow("policy");
		let startContexts = 0;
		harness.setResponses([
			(context) => {
				startContexts = context.messages.filter((message) => getMessageText(message) === "start-context").length;
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("accepted");
		expect(startContexts).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.messages.filter((message) => getMessageText(message) === "start-context")).toHaveLength(1);
	});

	it("adapts tool updates, retains deny context, and rejects unsafe built-in output shapes", async () => {
		const runs: string[] = [];
		const echo: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "echo",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id, params) => {
				const text = (params as { text: string }).text;
				runs.push(text);
				return { content: [{ type: "text", text: `tool:${text}` }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [echo],
			loadedHooks: hooks([
				{
					event: "PreToolUse",
					matcher: "echo",
					script: jsonScript({
						hookSpecificOutput: {
							hookEventName: "PreToolUse",
							updatedInput: { text: "updated" },
							additionalContext: "pre-context",
						},
					}),
				},
				{
					event: "PostToolUse",
					matcher: "echo",
					script: jsonScript({
						hookSpecificOutput: {
							hookEventName: "PostToolUse",
							updatedToolOutput: "replacement",
							additionalContext: "post-context",
						},
					}),
				},
			]),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "original" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run");
		expect(runs).toEqual(["updated"]);
		const resultText = getMessageText(harness.session.messages.find((message) => message.role === "toolResult"));
		expect(resultText).toContain("replacement");
		expect(resultText.match(/pre-context/g)).toHaveLength(1);
		expect(resultText.match(/post-context/g)).toHaveLength(1);

		const denied = await createHarness({
			tools: [echo],
			loadedHooks: hooks([
				{
					event: "PreToolUse",
					matcher: "echo",
					script: jsonScript({
						hookSpecificOutput: {
							hookEventName: "PreToolUse",
							permissionDecision: "deny",
							permissionDecisionReason: "no",
							additionalContext: "deny-context",
						},
					}),
				},
			]),
		});
		harnesses.push(denied);
		denied.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "denied" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("after deny"),
		]);
		await denied.session.prompt("deny");
		const deniedText = getMessageText(denied.session.messages.find((message) => message.role === "toolResult"));
		expect(deniedText.match(/deny-context/g)).toHaveLength(1);
		expect(runs).toEqual(["updated"]);
	});

	it.each([
		["ask", "requested permission"],
		["defer", "deferred permission"],
	] as const)("fails closed for unsupported PreToolUse permissionDecision %s", async (decision, reason) => {
		let executed = false;
		const diagnostics: string[] = [];
		const echo: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "echo",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				executed = true;
				return { content: [{ type: "text", text: "executed" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [echo],
			loadedHooks: hooks([
				{
					event: "PreToolUse",
					matcher: "echo",
					script: jsonScript({
						hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision },
					}),
				},
			]),
			onHookDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "no" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt(decision);
		expect(executed).toBe(false);
		const toolResult = getMessageText(harness.session.messages.find((message) => message.role === "toolResult"));
		expect(toolResult).toContain(reason);
		expect(diagnostics.some((message) => message.includes(`permissionDecision: ${decision}`))).toBe(true);
	});

	it("retains original built-in output for unsupported object replacement shapes", async () => {
		const readLike: AgentTool = {
			name: "read",
			label: "Read",
			description: "read",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "original-read" }], details: {} }),
		};
		const diagnostics: string[] = [];
		const harness = await createHarness({
			tools: [readLike],
			loadedHooks: hooks([
				{
					event: "PostToolUse",
					matcher: "Read",
					script: jsonScript({
						hookSpecificOutput: {
							hookEventName: "PostToolUse",
							updatedToolOutput: { content: [{ type: "text", text: "unsafe" }] },
						},
					}),
				},
			]),
			onHookDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "file" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("read");
		const text = getMessageText(harness.session.messages.find((message) => message.role === "toolResult"));
		expect(text).toContain("original-read");
		expect(text).not.toContain("unsafe");
		expect(diagnostics.some((message) => message.includes("built-in tool output"))).toBe(true);
	});

	it("cancels session-owned hook work on disposal", async () => {
		const harness = await createHarness({
			loadedHooks: hooks([
				{
					event: "UserPromptSubmit",
					script: "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{},5000))",
				},
			]),
		});
		harnesses.push(harness);
		const prompt = harness.session.prompt("slow");
		await new Promise((resolve) => setTimeout(resolve, 50));
		const started = Date.now();
		await harness.session.dispose();
		expect(Date.now() - started).toBeLessThan(750);
		await expect(prompt).rejects.toThrow("disposed");
	});

	it("skips Stop lifecycle hooks for user-aborted runs and sends accurate StopFailure input", async () => {
		const abortLog = join(tmpdir(), `pi-hook-abort-${Date.now()}-${Math.random()}`);
		const appendScript = `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>require('fs').appendFileSync(${JSON.stringify(abortLog)},s+'\\n'))`;
		const aborted = await createHarness({
			loadedHooks: hooks([
				{ event: "Stop", script: appendScript },
				{ event: "StopFailure", script: appendScript },
			]),
		});
		harnesses.push(aborted);
		aborted.setResponses([fauxAssistantMessage("partial", { stopReason: "aborted" })]);
		await aborted.session.prompt("cancel");
		expect(existsSync(abortLog)).toBe(false);

		const failureLog = join(tmpdir(), `pi-hook-failure-${Date.now()}-${Math.random()}`);
		const failureScript = `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>require('fs').writeFileSync(${JSON.stringify(failureLog)},s))`;
		const failed = await createHarness({ loadedHooks: hooks([{ event: "StopFailure", script: failureScript }]) });
		harnesses.push(failed);
		failed.setResponses([
			fauxAssistantMessage("assistant partial text", {
				stopReason: "error",
				errorMessage: "403 billing credit exhausted",
			}),
		]);
		await failed.session.prompt("fail");
		const failureInput = JSON.parse(readFileSync(failureLog, "utf8"));
		expect(failureInput).toMatchObject({
			error: "billing_error",
			error_details: "403 billing credit exhausted",
			last_assistant_message: "assistant partial text",
		});
	});

	it("continues Stop with model-visible custom feedback and caps at eight", async () => {
		const harness = await createHarness({
			loadedHooks: hooks([
				{
					event: "Stop",
					script: jsonScript({
						decision: "block",
						reason: "continue please",
						hookSpecificOutput: { hookEventName: "Stop", additionalContext: "continue please" },
					}),
				},
			]),
		});
		harnesses.push(harness);
		let activeFeedback = 0;
		harness.setResponses(
			Array.from({ length: 9 }, (_, index) =>
				index === 0
					? fauxAssistantMessage("answer-0")
					: (context) => {
							activeFeedback = context.messages.filter((message) =>
								getMessageText(message).includes("continue please"),
							).length;
							return fauxAssistantMessage(`answer-${index}`);
						},
			),
		);
		await harness.session.prompt("start");
		expect(activeFeedback).toBe(8);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(9);
		expect(harness.session.messages.filter((message) => message.role === "custom")).toHaveLength(8);
		expect(
			harness.session.messages
				.filter((message) => message.role === "custom")
				.every((message) => getMessageText(message).match(/continue please/g)?.length === 1),
		).toBe(true);
	});
	it("continues beyond eight Stop calls while reported work makes progress", async () => {
		const progressPath = join(tmpdir(), `pi-hook-progress-${Date.now()}-${Math.random()}`);
		const progressValues = [12, 11, 10, 13, 9, 8, 10, 7, 6, 8, 5];
		const script = `let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const fs=require('node:fs');const path=${JSON.stringify(progressPath)};const count=fs.existsSync(path)?Number(fs.readFileSync(path,'utf8')):0;fs.writeFileSync(path,String(count+1));const values=${JSON.stringify(progressValues)};const progress=values[count];const output=progress===undefined?{}:{decision:'block',reason:'continue progress',hookSpecificOutput:{hookEventName:'Stop',additionalContext:'continue progress',continuationProgress:progress}};process.stdout.write(JSON.stringify(output));})`;
		const harness = await createHarness({ loadedHooks: hooks([{ event: "Stop", script }]) });
		harnesses.push(harness);
		harness.setResponses(
			Array.from({ length: progressValues.length + 1 }, (_, index) => fauxAssistantMessage(`answer-${index}`)),
		);
		await harness.session.prompt("start");
		expect(Number(readFileSync(progressPath, "utf8"))).toBe(progressValues.length + 1);
		expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(
			progressValues.length + 1,
		);
		expect(harness.session.messages.filter((message) => message.role === "custom")).toHaveLength(
			progressValues.length,
		);
		rmSync(progressPath, { force: true });
	});

	it("keeps the eight-call cap when reported Stop progress stalls", async () => {
		const harness = await createHarness({
			loadedHooks: hooks([
				{
					event: "Stop",
					script: jsonScript({
						decision: "block",
						reason: "stalled",
						hookSpecificOutput: {
							hookEventName: "Stop",
							additionalContext: "stalled",
							continuationProgress: 5,
						},
					}),
				},
			]),
		});
		harnesses.push(harness);
		harness.setResponses(Array.from({ length: 9 }, (_, index) => fauxAssistantMessage(`answer-${index}`)));
		await harness.session.prompt("start");
		expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(9);
		expect(harness.session.messages.filter((message) => message.role === "custom")).toHaveLength(8);
	});

	it.each([
		["read", { path: "~/notes.txt" }, "disabled", undefined],
		["read", { path: "~/notes.txt" }, "empty", hooks([])],
		[
			"read",
			{ path: "~/notes.txt" },
			"unrelated",
			hooks([
				{ event: "PostToolUse", matcher: "Bash", script: jsonScript({}) },
				{ event: "PreToolUse", matcher: "Bash", script: jsonScript({}) },
			]),
		],
		[
			"read",
			{ path: "~/notes.txt" },
			"excluded-by-if",
			hooks([{ event: "PreToolUse", matcher: "Read", if: "Bash(*)", script: jsonScript({}) }]),
		],
		[
			"edit",
			{ path: "~/notes.txt", oldText: "a", newText: "b" },
			"unrelated",
			hooks([
				{ event: "PostToolUse", matcher: "Bash", script: jsonScript({}) },
				{ event: "PreToolUse", matcher: "Bash", script: jsonScript({}) },
			]),
		],
		[
			"write",
			{ path: "~/notes.txt", content: "x" },
			"unrelated",
			hooks([
				{ event: "PostToolUse", matcher: "Bash", script: jsonScript({}) },
				{ event: "PreToolUse", matcher: "Bash", script: jsonScript({}) },
			]),
		],
	] as const)(
		"does not adapt remote ~ %s input with %s pre/post hooks",
		async (toolName, args, _hookState, loadedHooks) => {
			const cwd = join(tmpdir(), `pi-hook-remote-${toolName}-${Date.now()}-${Math.random()}`);
			const toolOperations = {
				cwd,
				getBackendInfo: () => ({
					type: "remote" as const,
					cwd,
					configured: true as const,
					workspace: { id: "remote", root: cwd, pathFlavor: "posix" as const },
				}),
			} as unknown as ToolOperations;
			const harness = await createHarness({ toolOperations, loadedHooks });
			harnesses.push(harness);

			const toolCall = fauxToolCall(toolName, args);
			const before = harness.session.agent.beforeToolCall;
			const after = harness.session.agent.afterToolCall;
			expect(before).toBeDefined();
			expect(after).toBeDefined();
			await expect(
				before!({ toolCall, args: { ...args }, context: { tools: [] } } as never),
			).resolves.toBeUndefined();
			await expect(
				after!({
					toolCall,
					args: { ...args },
					result: { content: [{ type: "text", text: "ok" }], details: {} },
					isError: false,
					context: { tools: [] },
				} as never),
			).resolves.toMatchObject({ isError: false });
			await expect(
				after!({
					toolCall: { ...toolCall, id: `${toolCall.id}-failure` },
					args: { ...args },
					result: { content: [{ type: "text", text: "failed" }], details: {} },
					isError: true,
					context: { tools: [] },
				} as never),
			).resolves.toMatchObject({ isError: true });
		},
	);

	it("preserves a successful remote file result when an unresolved ~ path skips PostToolUse", async () => {
		const diagnostics: string[] = [];
		const cwd = join(tmpdir(), `pi-hook-remote-read-${Date.now()}-${Math.random()}`);
		const toolOperations = {
			cwd,
			getBackendInfo: () => ({
				type: "remote" as const,
				cwd,
				configured: true as const,
				workspace: { id: "remote", root: cwd, pathFlavor: "posix" as const },
			}),
		} as unknown as ToolOperations;
		const harness = await createHarness({
			toolOperations,
			loadedHooks: hooks([
				{
					event: "PostToolUse",
					matcher: "Read",
					script: jsonScript({
						hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: "hook-output" },
					}),
				},
			]),
			onHookDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
		});
		harnesses.push(harness);

		const after = harness.session.agent.afterToolCall;
		expect(after).toBeDefined();
		const result = await after!({
			toolCall: fauxToolCall("read", { path: "~/notes.txt" }),
			args: { path: "~/notes.txt" },
			result: { content: [{ type: "text", text: "original" }], details: {} },
			isError: false,
			context: { tools: [] },
		} as never);

		expect(result).toEqual({ content: [{ type: "text", text: "original" }], details: {}, isError: false });
		expect(diagnostics).toContain(
			"Skipped PostToolUse for read: cannot resolve a ~ path without a known POSIX backend home",
		);
	});

	it("clears unfinished tool hook state when an aborted agent run ends", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const state = harness.session as unknown as {
			_toolStartedAt: Map<string, number>;
			_preToolHookContext: Map<string, string[]>;
		};
		state._toolStartedAt.set("skipped-after", Date.now());
		state._preToolHookContext.set("skipped-after", ["stale context"]);
		harness.setResponses([fauxAssistantMessage("partial", { stopReason: "aborted" })]);

		await harness.session.prompt("abort");

		expect(state._toolStartedAt.size).toBe(0);
		expect(state._preToolHookContext.size).toBe(0);
	});
});
