import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { PortablePathFlavor } from "../lsp/portable-path.ts";
import { matchesHookIf, matchesHookInput } from "./matcher.ts";
import type {
	CommandHookHandler,
	HookDiagnostic,
	HookDiagnosticCode,
	HookExecutionResult,
	HookExecutionStatus,
	HookHandlerCommon,
	HookInput,
	HookOutputClassification,
	HookRunOptions,
	HookStructuredOutput,
	HttpHookHandler,
	LoadedHookHandler,
} from "./types.ts";

export const DEFAULT_HOOK_TIMEOUT_SECONDS = 600;
export const DEFAULT_USER_PROMPT_HOOK_TIMEOUT_SECONDS = 30;
export const DEFAULT_SESSION_END_HOOK_TIMEOUT_SECONDS = 1.5;
export const MAX_SESSION_END_HOOK_TIMEOUT_SECONDS = 60;
export const DEFAULT_MAX_HOOK_OUTPUT_BYTES = 1024 * 1024;

interface CompletedCommandState {
	stdout: Buffer;
	stderr: Buffer;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	outputLimitExceeded: boolean;
	timedOut: boolean;
	cancelled: boolean;
}

interface BoundedBufferAppendResult {
	value: Buffer;
	truncated: boolean;
}

type WindowsProcessTreeTerminator = (pid: number) => void;

function forceTerminateChildProcess(
	child: ChildProcessWithoutNullStreams,
	platform: NodeJS.Platform,
	terminateWindowsTree: WindowsProcessTreeTerminator,
): void {
	if (child.pid && platform === "win32") {
		terminateWindowsTree(child.pid);
	} else if (child.pid) {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
	} else if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStructuredOutput(value: unknown): value is HookStructuredOutput {
	if (!isObject(value)) return false;
	return (
		(value.continue === undefined || typeof value.continue === "boolean") &&
		(value.stopReason === undefined || typeof value.stopReason === "string") &&
		(value.systemMessage === undefined || typeof value.systemMessage === "string") &&
		(value.decision === undefined || typeof value.decision === "string") &&
		(value.reason === undefined || typeof value.reason === "string") &&
		(value.hookSpecificOutput === undefined || isObject(value.hookSpecificOutput))
	);
}
export function classifyHookOutput(stdout: string): HookOutputClassification {
	if (stdout.length === 0) return { kind: "empty" };
	if (!stdout.trimStart().startsWith("{")) return { kind: "text", text: stdout, malformedJson: false };
	try {
		const value: unknown = JSON.parse(stdout);
		return isStructuredOutput(value) ? { kind: "json", value } : { kind: "text", text: stdout, malformedJson: true };
	} catch {
		return { kind: "text", text: stdout, malformedJson: true };
	}
}

export function defaultHookTimeoutSeconds(input: HookInput): number {
	if (input.hook_event_name === "SessionEnd") return DEFAULT_SESSION_END_HOOK_TIMEOUT_SECONDS;
	if (input.hook_event_name === "UserPromptSubmit") return DEFAULT_USER_PROMPT_HOOK_TIMEOUT_SECONDS;
	return DEFAULT_HOOK_TIMEOUT_SECONDS;
}

function hookTimeoutSeconds(handler: HookHandlerCommon, input: HookInput, options?: HookRunOptions): number {
	if (options?.timeoutSeconds !== undefined) return options.timeoutSeconds;
	const timeout = handler.timeout ?? defaultHookTimeoutSeconds(input);
	return input.hook_event_name === "SessionEnd" ? Math.min(timeout, MAX_SESSION_END_HOOK_TIMEOUT_SECONDS) : timeout;
}
export function sanitizedHookEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (key.startsWith("OTEL_")) continue;
		if (/^PI_.*(?:TOKEN|CREDENTIAL|API_KEY|SECRET|PASSWORD)/i.test(key)) continue;
		result[key] = value;
	}
	return result;
}
function appendBounded(current: Buffer, chunk: Buffer, maximum: number): BoundedBufferAppendResult {
	if (current.length >= maximum) return { value: current, truncated: chunk.length > 0 };
	const remaining = maximum - current.length;
	return { value: Buffer.concat([current, chunk.subarray(0, remaining)]), truncated: chunk.length > remaining };
}
function exitTwoBlocks(input: HookInput): boolean {
	return (
		input.hook_event_name === "PreToolUse" ||
		input.hook_event_name === "UserPromptSubmit" ||
		input.hook_event_name === "Stop" ||
		input.hook_event_name === "PreCompact"
	);
}
function structuredBlockingReason(output: HookOutputClassification, input: HookInput): string | undefined {
	if (output.kind !== "json") return undefined;
	if (output.value.continue === false && typeof output.value.stopReason === "string") return output.value.stopReason;
	if (input.hook_event_name === "PreToolUse") {
		const specific = output.value.hookSpecificOutput;
		if (
			specific?.hookEventName === input.hook_event_name &&
			specific.permissionDecision === "deny" &&
			typeof specific.permissionDecisionReason === "string"
		) {
			return specific.permissionDecisionReason;
		}
	}
	if (output.value.decision === "block" && typeof output.value.reason === "string") return output.value.reason;
	return undefined;
}
function diagnostic(hook: LoadedHookHandler, code: HookDiagnosticCode, message: string): HookDiagnostic {
	return { level: "warning", code, message, source: hook.source, event: hook.event };
}
function resultBase(
	hook: LoadedHookHandler,
	started: number,
	partial: Partial<HookExecutionResult>,
): HookExecutionResult {
	return {
		hook,
		status: "error",
		exitCode: null,
		stdout: "",
		stderr: "",
		stdoutTruncated: false,
		stderrTruncated: false,
		output: { kind: "empty" },
		blocking: false,
		durationMs: performance.now() - started,
		...partial,
	};
}

function completedCommandStatus(state: CompletedCommandState): HookExecutionStatus {
	if (state.outputLimitExceeded) return "error";
	if (state.timedOut) return "timeout";
	if (state.cancelled) return "cancelled";
	return "completed";
}

function completedCommandDiagnostic(
	hook: LoadedHookHandler,
	state: CompletedCommandState,
	output: HookOutputClassification,
): HookDiagnostic | undefined {
	if (state.outputLimitExceeded) {
		return diagnostic(hook, "execution", "Hook output exceeded the execution limit");
	}
	if (output.kind !== "text" || !output.malformedJson) return undefined;
	return diagnostic(hook, "malformed-output", "Hook stdout looked like JSON but was malformed; output was ignored");
}

function completedCommandResult(
	hook: LoadedHookHandler,
	started: number,
	input: HookInput,
	exitCode: number | null,
	state: CompletedCommandState,
): HookExecutionResult {
	const stdout = state.stdout.toString("utf8");
	const stderr = state.stderr.toString("utf8");
	const output = state.outputLimitExceeded ? { kind: "empty" as const } : classifyHookOutput(stdout);
	const outputDiagnostic = completedCommandDiagnostic(hook, state, output);
	const blocking =
		!state.timedOut && !state.cancelled && !state.outputLimitExceeded && exitCode === 2 && exitTwoBlocks(input);
	return resultBase(hook, started, {
		status: completedCommandStatus(state),
		exitCode,
		stdout,
		stderr,
		stdoutTruncated: state.stdoutTruncated,
		stderrTruncated: state.stderrTruncated,
		output,
		diagnostic: outputDiagnostic,
		blocking,
		...(blocking
			? { blockingReason: structuredBlockingReason(output, input) ?? (stderr.trim() || "Hook blocked the action") }
			: {}),
	});
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function projectHookUsesWorkspaceBackend(hook: LoadedHookHandler, options: HookRunOptions): boolean {
	if (hook.source.kind !== "project" && hook.source.kind !== "local") return false;
	return options.toolOperations?.getBackendInfo?.()?.type !== "local";
}

const WORKSPACE_HOOK_RUNNER = String.raw`
const { spawn } = require("node:child_process");
const spec = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name.startsWith("OTEL_") || /^PI_.*(?:TOKEN|CREDENTIAL|API_KEY|SECRET|PASSWORD)/i.test(name)) delete env[name];
}
const frame = (stream, data) => process.stdout.write("PIHOOK1 " + stream + " " + Buffer.from(data).toString("base64") + "\n");
let failed = false;
const child = spawn(spec.file, spec.args, { cwd: spec.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
child.stdout.on("data", (data) => frame("stdout", data));
child.stderr.on("data", (data) => frame("stderr", data));
child.on("error", (error) => { failed = true; frame("stderr", Buffer.from(String(error))); process.exitCode = 127; });
child.on("close", (code) => { if (!failed) process.exitCode = code === null ? 1 : code; });
child.stdin.on("error", () => {});
child.stdin.end(Buffer.from(spec.stdinBase64, "base64"));
`;

interface WorkspaceHookPreparation {
	ok: boolean;
	command?: string;
	input: HookInput;
}

interface WorkspaceHookOutputState {
	maximum: number;
	stdout: Buffer;
	stderr: Buffer;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	pending: string;
	outputLimitExceeded: boolean;
	outputController: AbortController;
}

function prepareWorkspaceHook(
	handler: CommandHookHandler,
	input: HookInput,
	cwd: string,
	pathFlavor: PortablePathFlavor,
): WorkspaceHookPreparation {
	const workspaceInput = { ...input, cwd };
	const stdin = Buffer.from(JSON.stringify(workspaceInput));
	if (stdin.byteLength > 256 * 1024) return { ok: false, input: workspaceInput };
	let file = handler.command;
	let args = handler.args ?? [];
	if (handler.args === undefined) {
		if (handler.shell === "powershell" || (handler.shell === undefined && pathFlavor === "windows")) {
			file = pathFlavor === "windows" ? "powershell.exe" : "pwsh";
			args = ["-NoProfile", "-Command", handler.command];
		} else {
			file = handler.shell === "bash" ? "bash" : "/bin/sh";
			args = ["-c", handler.command];
		}
	}
	const spec = Buffer.from(JSON.stringify({ file, args, cwd, stdinBase64: stdin.toString("base64") })).toString(
		"base64",
	);
	return {
		ok: true,
		command: `node -e ${shellQuote(WORKSPACE_HOOK_RUNNER)} ${shellQuote(spec)}`,
		input: workspaceInput,
	};
}

function createWorkspaceHookOutputState(maximum: number): WorkspaceHookOutputState {
	return {
		maximum,
		stdout: Buffer.alloc(0),
		stderr: Buffer.alloc(0),
		stdoutTruncated: false,
		stderrTruncated: false,
		pending: "",
		outputLimitExceeded: false,
		outputController: new AbortController(),
	};
}

function exceedWorkspaceHookOutputLimit(state: WorkspaceHookOutputState): void {
	if (state.outputLimitExceeded) return;
	state.outputLimitExceeded = true;
	state.outputController.abort();
}

function consumeWorkspaceHookLine(state: WorkspaceHookOutputState, line: string): void {
	const match = /^PIHOOK1 (stdout|stderr) ([A-Za-z0-9+/]*={0,2})$/.exec(line);
	if (!match) {
		const next = appendBounded(state.stderr, Buffer.from(`${line}\n`), state.maximum);
		state.stderr = next.value;
		state.stderrTruncated ||= next.truncated;
		if (next.truncated) exceedWorkspaceHookOutputLimit(state);
		return;
	}
	const chunk = Buffer.from(match[2], "base64");
	if (match[1] === "stdout") {
		const next = appendBounded(state.stdout, chunk, state.maximum);
		state.stdout = next.value;
		state.stdoutTruncated ||= next.truncated;
	} else {
		const next = appendBounded(state.stderr, chunk, state.maximum);
		state.stderr = next.value;
		state.stderrTruncated ||= next.truncated;
	}
	if (state.stdoutTruncated || state.stderrTruncated) exceedWorkspaceHookOutputLimit(state);
}

function consumeWorkspaceHookData(state: WorkspaceHookOutputState, data: Buffer): void {
	if (state.outputLimitExceeded) return;
	state.pending += data.toString("utf8");
	const maximumFrameChars = Math.ceil((state.maximum * 4) / 3) + 1024;
	if (state.pending.length > maximumFrameChars) {
		state.pending = state.pending.slice(0, maximumFrameChars);
		state.stderrTruncated = true;
		exceedWorkspaceHookOutputLimit(state);
		return;
	}
	const lines = state.pending.split("\n");
	state.pending = lines.pop() ?? "";
	for (const line of lines) consumeWorkspaceHookLine(state, line.replace(/\r$/, ""));
}

function completeWorkspaceHookOutput(state: WorkspaceHookOutputState): void {
	if (state.pending) consumeWorkspaceHookLine(state, state.pending);
}

function completedWorkspaceHookResult(
	hook: LoadedHookHandler,
	started: number,
	input: HookInput,
	state: WorkspaceHookOutputState,
	exitCode: number | null,
): HookExecutionResult {
	const stdout = state.stdout.toString("utf8");
	const stderr = state.stderr.toString("utf8");
	const output = state.outputLimitExceeded ? { kind: "empty" as const } : classifyHookOutput(stdout);
	let outputDiagnostic: HookDiagnostic | undefined;
	if (output.kind === "text" && output.malformedJson) {
		outputDiagnostic = diagnostic(
			hook,
			"malformed-output",
			"Hook stdout looked like JSON but was malformed; output was ignored",
		);
	} else if (state.outputLimitExceeded) {
		outputDiagnostic = diagnostic(hook, "execution", "Project hook output exceeded the workspace execution limit");
	}
	const blocking = !state.outputLimitExceeded && exitCode === 2 && exitTwoBlocks(input);
	return resultBase(hook, started, {
		status: state.outputLimitExceeded ? "error" : "completed",
		exitCode,
		stdout,
		stderr,
		stdoutTruncated: state.stdoutTruncated,
		stderrTruncated: state.stderrTruncated,
		output,
		diagnostic: outputDiagnostic,
		blocking,
		...(blocking
			? { blockingReason: structuredBlockingReason(output, input) ?? (stderr.trim() || "Hook blocked the action") }
			: {}),
	});
}

function failedWorkspaceHookResult(
	hook: LoadedHookHandler,
	started: number,
	options: HookRunOptions,
	state: WorkspaceHookOutputState,
	error: unknown,
): HookExecutionResult {
	const cancelled = !state.outputLimitExceeded && options.signal?.aborted === true;
	return resultBase(hook, started, {
		status: cancelled ? "cancelled" : "error",
		stdout: state.stdout.toString("utf8"),
		stderr: state.stderr.toString("utf8"),
		stdoutTruncated: state.stdoutTruncated,
		stderrTruncated: state.stderrTruncated,
		diagnostic: state.outputLimitExceeded
			? diagnostic(hook, "execution", "Project hook output exceeded the workspace execution limit")
			: cancelled
				? undefined
				: diagnostic(hook, "execution", `Workspace project hook failed: ${String(error)}`),
	});
}
async function executeWorkspaceCommand(
	hook: LoadedHookHandler,
	handler: CommandHookHandler,
	input: HookInput,
	options: HookRunOptions,
): Promise<HookExecutionResult> {
	const started = performance.now();
	const operations = options.toolOperations;
	const backend = operations?.getBackendInfo?.();
	if (!operations || !backend || backend.type === "local" || (backend.type === "remote" && !backend.configured)) {
		return resultBase(hook, started, {
			diagnostic: diagnostic(
				hook,
				"policy",
				"Project hook was not executed because the workspace backend is unavailable",
			),
		});
	}
	const pathFlavor = backend.type === "remote" && backend.configured ? backend.workspace.pathFlavor : "posix";
	const preparation = prepareWorkspaceHook(handler, input, backend.cwd, pathFlavor);
	if (!preparation.ok || !preparation.command) {
		return resultBase(hook, started, {
			diagnostic: diagnostic(hook, "policy", "Project hook input exceeds the workspace execution limit"),
		});
	}
	const state = createWorkspaceHookOutputState(options.maxOutputBytes ?? DEFAULT_MAX_HOOK_OUTPUT_BYTES);
	const signals = [options.signal, state.outputController.signal].filter(
		(signal): signal is AbortSignal => signal !== undefined,
	);
	const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
	try {
		const result = await operations.exec(preparation.command, {
			cwd: backend.cwd,
			onData: (data) => consumeWorkspaceHookData(state, data),
			signal,
			timeout: hookTimeoutSeconds(handler, preparation.input, options),
		});
		completeWorkspaceHookOutput(state);
		return completedWorkspaceHookResult(hook, started, preparation.input, state, result.exitCode);
	} catch (error) {
		return failedWorkspaceHookResult(hook, started, options, state, error);
	}
}

async function executeCommand(
	hook: LoadedHookHandler,
	handler: CommandHookHandler,
	input: HookInput,
	options: HookRunOptions,
): Promise<HookExecutionResult> {
	if (projectHookUsesWorkspaceBackend(hook, options)) return executeWorkspaceCommand(hook, handler, input, options);
	const started = performance.now();
	const timeoutMs = hookTimeoutSeconds(handler, input, options) * 1000;
	const maximum = options.maxOutputBytes ?? DEFAULT_MAX_HOOK_OUTPUT_BYTES;
	const useExec = handler.args !== undefined;
	let command = handler.command;
	let args = handler.args ?? [];
	if (!useExec) {
		if (handler.shell === "powershell") {
			command = process.platform === "win32" ? "powershell.exe" : "pwsh";
			args = ["-NoProfile", "-Command", handler.command];
		} else if (handler.shell === "bash") {
			command = "bash";
			args = ["-c", handler.command];
		} else if (process.platform === "win32") {
			command = "powershell.exe";
			args = ["-NoProfile", "-Command", handler.command];
		} else {
			command = "/bin/sh";
			args = ["-c", handler.command];
		}
	}
	return await new Promise((resolve) => {
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(command, args, {
				cwd: input.cwd,
				env: sanitizedHookEnvironment(options.env),
				stdio: ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
				windowsHide: true,
			});
		} catch (error) {
			resolve(resultBase(hook, started, { diagnostic: diagnostic(hook, "execution", String(error)) }));
			return;
		}
		let stdout: Buffer = Buffer.alloc(0);
		let stderr: Buffer = Buffer.alloc(0);
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let outputLimitExceeded = false;
		let settled = false;
		let timedOut = false;
		let cancelled = false;
		const platform = options.platform ?? process.platform;
		let windowsTerminationStarted = false;
		const terminateWindowsTree = (pid: number) => {
			if (windowsTerminationStarted) return;
			windowsTerminationStarted = true;
			const fallback = () => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			};
			if (options.terminateWindowsProcessTree) {
				// The abstraction is invoked before any direct-child fallback, matching taskkill ordering.
				if (!options.terminateWindowsProcessTree(pid)) fallback();
				return;
			}
			try {
				const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
					stdio: "ignore",
					windowsHide: true,
				});
				const bound = setTimeout(() => {
					killer.kill();
					fallback();
				}, 1000);
				bound.unref();
				killer.once("close", (code) => {
					clearTimeout(bound);
					if (code !== 0) fallback();
				});
				killer.once("error", () => {
					clearTimeout(bound);
					fallback();
				});
			} catch {
				fallback();
			}
		};
		const terminate = () => {
			if (child.pid && platform === "win32") {
				// taskkill /T /F gets a bounded opportunity before direct-child fallback.
				terminateWindowsTree(child.pid);
			} else if (child.pid) {
				try {
					process.kill(-child.pid, "SIGTERM");
				} catch {
					child.kill("SIGTERM");
				}
			} else child.kill("SIGTERM");
			setTimeout(() => {
				forceTerminateChildProcess(child, platform, terminateWindowsTree);
			}, 250).unref();
		};
		const onAbort = () => {
			cancelled = true;
			terminate();
		};
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => {
			timedOut = true;
			terminate();
		}, timeoutMs);
		child.stdout.on("data", (data: Buffer) => {
			const next = appendBounded(stdout, data, maximum);
			stdout = next.value;
			stdoutTruncated ||= next.truncated;
			if (next.truncated && !outputLimitExceeded) {
				outputLimitExceeded = true;
				terminate();
			}
		});
		child.stderr.on("data", (data: Buffer) => {
			const next = appendBounded(stderr, data, maximum);
			stderr = next.value;
			stderrTruncated ||= next.truncated;
			if (next.truncated && !outputLimitExceeded) {
				outputLimitExceeded = true;
				terminate();
			}
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve(
				resultBase(hook, started, {
					stdout: stdout.toString("utf8"),
					stderr: stderr.toString("utf8"),
					stdoutTruncated,
					stderrTruncated,
					diagnostic: diagnostic(hook, "execution", String(error)),
				}),
			);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve(
				completedCommandResult(hook, started, input, code, {
					stdout,
					stderr,
					stdoutTruncated,
					stderrTruncated,
					outputLimitExceeded,
					timedOut,
					cancelled,
				}),
			);
		});
		child.stdin.on("error", () => undefined);
		child.stdin.end(JSON.stringify(input));
	});
}
function interpolateHeader(value: string, allowed: Set<string>, env: NodeJS.ProcessEnv): string {
	return value.replace(
		/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
		(_match, braced: string | undefined, bare: string | undefined) => {
			const name = braced ?? bare ?? "";
			return allowed.has(name) ? (env[name] ?? "") : "";
		},
	);
}
function httpHookTransportAllowed(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol === "https:") return true;
	if (url.protocol !== "http:") return false;
	const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	return (
		hostname === "localhost" ||
		hostname === "::1" ||
		/^127(?:\.[0-9]{1,3}){3}$/.test(hostname) ||
		/^::ffff:127(?:\.[0-9]{1,3}){3}$/.test(hostname)
	);
}

interface HttpHookResponseBody {
	stdout: string;
	truncated: boolean;
}

function createHttpHookHeaders(
	hook: LoadedHookHandler,
	handler: HttpHookHandler,
	options: HookRunOptions,
	env: NodeJS.ProcessEnv,
): Record<string, string> {
	const settingsAllowed = new Set(hook.httpHookAllowedEnvVars ?? handler.allowedEnvVars ?? []);
	const hostAllowed = options.httpHookAllowedEnvVars ? new Set(options.httpHookAllowedEnvVars) : undefined;
	const allowed = new Set([...settingsAllowed].filter((name) => !hostAllowed || hostAllowed.has(name)));
	const headers: Record<string, string> = { "content-type": "application/json" };
	for (const [key, value] of Object.entries(handler.headers ?? {})) {
		headers[key] = interpolateHeader(value, allowed, env);
	}
	return headers;
}

async function readHttpHookResponseBody(response: Response, maximum: number): Promise<HttpHookResponseBody> {
	let raw: Buffer = Buffer.alloc(0);
	let truncated = false;
	if (!response.body) return { stdout: "", truncated };

	const reader = response.body.getReader();
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			const bounded = appendBounded(raw, Buffer.from(next.value), maximum);
			raw = bounded.value;
			truncated ||= bounded.truncated;
			if (!truncated) continue;
			await reader.cancel();
			break;
		}
	} finally {
		reader.releaseLock();
	}
	return { stdout: raw.toString("utf8"), truncated };
}

function completedHttpHookResult(
	hook: LoadedHookHandler,
	started: number,
	response: Response,
	body: HttpHookResponseBody,
): HookExecutionResult {
	let output: HookOutputClassification = { kind: "empty" };
	let responseDiagnostic: HookDiagnostic | undefined;
	if (body.truncated) {
		responseDiagnostic = diagnostic(hook, "execution", "HTTP hook output exceeded the execution limit");
	} else if (response.status >= 300 && response.status < 400) {
		responseDiagnostic = diagnostic(hook, "policy", "HTTP hook redirects are rejected");
	} else if (!response.ok) {
		responseDiagnostic = diagnostic(hook, "execution", `HTTP hook returned ${response.status}`);
	} else {
		const classified = classifyHookOutput(body.stdout);
		if (classified.kind === "json" || classified.kind === "empty") output = classified;
		else {
			responseDiagnostic = diagnostic(
				hook,
				"malformed-output",
				"HTTP hook 2xx response was not structured JSON; response was ignored",
			);
		}
	}
	return resultBase(hook, started, {
		status: body.truncated ? "error" : "completed",
		exitCode: response.ok && !body.truncated ? 0 : 1,
		stdout: body.stdout,
		stderr: "",
		stdoutTruncated: body.truncated,
		output,
		diagnostic: responseDiagnostic,
	});
}

function failedHttpHookResult(
	hook: LoadedHookHandler,
	started: number,
	timedOut: boolean,
	cancelled: boolean,
	error: unknown,
): HookExecutionResult {
	return resultBase(hook, started, {
		status: timedOut ? "timeout" : cancelled ? "cancelled" : "error",
		diagnostic:
			timedOut || cancelled ? undefined : diagnostic(hook, "execution", `HTTP hook failed: ${String(error)}`),
	});
}

async function executeHttp(
	hook: LoadedHookHandler,
	handler: HttpHookHandler,
	input: HookInput,
	options: HookRunOptions,
): Promise<HookExecutionResult> {
	const started = performance.now();
	if (!httpHookTransportAllowed(handler.url)) {
		return resultBase(hook, started, {
			diagnostic: diagnostic(hook, "policy", `HTTP hook requires HTTPS unless it targets loopback: ${handler.url}`),
		});
	}
	if (projectHookUsesWorkspaceBackend(hook, options)) {
		return resultBase(hook, started, {
			diagnostic: diagnostic(
				hook,
				"policy",
				"Project HTTP hooks are disabled on non-local workspace backends to prevent host-network escape",
			),
		});
	}

	const controller = new AbortController();
	const timeoutMs = hookTimeoutSeconds(handler, input, options) * 1000;
	let timedOut = false;
	let cancelled = false;
	const onAbort = () => {
		cancelled = true;
		controller.abort();
	};
	if (options.signal?.aborted) onAbort();
	else options.signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	try {
		const env = sanitizedHookEnvironment(options.env);
		if (options.allowedHttpHookUrls && !urlAllowed(handler.url, options.allowedHttpHookUrls)) {
			return resultBase(hook, started, {
				diagnostic: diagnostic(hook, "policy", `HTTP hook URL is blocked by the host: ${handler.url}`),
			});
		}
		const headers = createHttpHookHeaders(hook, handler, options, env);
		const response = await (options.fetch ?? globalThis.fetch)(handler.url, {
			method: "POST",
			headers,
			body: JSON.stringify(input),
			signal: controller.signal,
			redirect: "error",
		});
		const body = await readHttpHookResponseBody(response, options.maxOutputBytes ?? DEFAULT_MAX_HOOK_OUTPUT_BYTES);
		return completedHttpHookResult(hook, started, response, body);
	} catch (error) {
		return failedHttpHookResult(hook, started, timedOut, cancelled, error);
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

function urlAllowed(url: string, allowlist: readonly string[]): boolean {
	return allowlist.some((pattern) => {
		if (pattern === url) return true;
		const expression = pattern
			.split("*")
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*");
		return new RegExp(`^${expression}$`).test(url);
	});
}

export async function executeHook(
	hook: LoadedHookHandler,
	input: HookInput,
	options: HookRunOptions = {},
): Promise<HookExecutionResult> {
	const started = performance.now();
	if (options.signal?.aborted) return resultBase(hook, started, { status: "cancelled" });
	if (hook.handler.type === "prompt" || hook.handler.type === "agent" || hook.handler.type === "mcp_tool") {
		return resultBase(hook, started, {
			status: "unsupported",
			diagnostic: diagnostic(hook, "unsupported-handler", `${hook.handler.type} handlers are unsupported`),
		});
	}
	if (hook.handler.type === "command") return executeCommand(hook, hook.handler, input, options);
	if (hook.handler.type === "http") return executeHttp(hook, hook.handler, input, options);
	return resultBase(hook, started, { status: "unsupported" });
}

export async function executeMatchingHooks(
	hooks: readonly LoadedHookHandler[],
	input: HookInput,
	options: HookRunOptions = {},
): Promise<HookExecutionResult[]> {
	const matching = hooks.filter(
		(hook) =>
			hook.event === input.hook_event_name &&
			matchesHookInput(hook.matcher, input).matches &&
			matchesHookIf(hook.handler.if, input).matches,
	);
	const runOptions =
		input.hook_event_name === "SessionEnd"
			? {
					...options,
					timeoutSeconds: Math.min(
						MAX_SESSION_END_HOOK_TIMEOUT_SECONDS,
						Math.max(
							DEFAULT_SESSION_END_HOOK_TIMEOUT_SECONDS,
							...matching.map((hook) => hook.handler.timeout ?? DEFAULT_SESSION_END_HOOK_TIMEOUT_SECONDS),
						),
					),
				}
			: options;
	return Promise.all(matching.map((hook) => executeHook(hook, input, runOptions)));
}
