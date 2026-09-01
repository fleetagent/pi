import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	aggregateHookResults,
	executeHook,
	executeMatchingHooks,
	type HookHandler,
	type HookInput,
	type HookSettingsSource,
	type LoadedHookHandler,
	sanitizedHookEnvironment,
} from "../../src/core/hooks/index.ts";
import { LocalToolOperations, type ToolExecOptions } from "../../src/core/tools/operations.ts";

const servers: ReturnType<typeof createServer>[] = [];
type HookInputFixtureEvent = "PreToolUse" | "UserPromptSubmit";

afterEach(async () =>
	Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))),
);

function input(cwd: string, event: HookInputFixtureEvent = "PreToolUse"): HookInput {
	const common = { session_id: "session", transcript_path: join(cwd, "transcript.jsonl"), cwd };
	return event === "PreToolUse"
		? {
				...common,
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "echo hi" },
				tool_use_id: "tool-1",
			}
		: { ...common, hook_event_name: "UserPromptSubmit", prompt: "hello" };
}
function loaded(
	handler: HookHandler,
	order = 0,
	source: HookSettingsSource = { kind: "host", path: "host-injected" },
): LoadedHookHandler {
	return { event: "PreToolUse", matcher: "Bash", handler, source, order };
}

const jsonSystemMessageScript =
	"let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({systemMessage:'host-'+JSON.parse(s).hook_event_name})))";

describe("hook execution", () => {
	it("uses direct argv when args is present, sends JSON stdin, bounds output, and strips credentials", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-hook-exec-"));
		const script =
			"let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(s).tool_name+'|'+process.argv[1]+'|'+process.env.OTEL_TOKEN+'|'+process.env.PI_AUTH_TOKEN+'|xxxxxxxx'))";
		const result = await executeHook(
			loaded({ type: "command", command: process.execPath, args: ["-e", script, "a;echo-not-run"] }),
			input(cwd),
			{
				env: { ...process.env, OTEL_TOKEN: "otel", PI_AUTH_TOKEN: "secret" },
				maxOutputBytes: 42,
			},
		);
		expect(result).toMatchObject({ status: "error", exitCode: null });
		expect(result.stdout).toContain("Bash|a;echo-not-run|undefined|undefined|");
		expect(result.stdoutTruncated).toBe(true);
	});

	it("routes project command hooks through the active sandbox backend with backend stdin and cwd", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-hook-workspace-"));
		let decodedInput: HookInput | undefined;
		const exec = vi.fn(async (command: string, options: ToolExecOptions) => {
			const encoded = /'([A-Za-z0-9+/=]+)'$/.exec(command)?.[1];
			if (!encoded) throw new Error("missing workspace hook process specification");
			const spec = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
				file: string;
				args: string[];
				cwd: string;
				stdinBase64: string;
			};
			expect(spec).toMatchObject({ file: "node", args: ["arg;not-shell"], cwd: "/workspace" });
			decodedInput = JSON.parse(Buffer.from(spec.stdinBase64, "base64").toString("utf8")) as HookInput;
			options.onData(Buffer.from(`PIHOOK1 stdout ${Buffer.from("{}").toString("base64")}\n`));
			return { exitCode: 0 };
		});
		const result = await executeHook(
			loaded({ type: "command", command: "node", args: ["arg;not-shell"] }, 0, {
				kind: "project",
				path: `${cwd}/.pi/settings.json`,
			}),
			input(cwd),
			{
				toolOperations: {
					cwd: "/workspace",
					exec,
					getBackendInfo: () => ({
						type: "remote" as const,
						cwd: "/workspace",
						configured: true as const,
						url: "ws://sandbox",
						protocol: "ws" as const,
						workspace: { id: "sandbox", root: "/workspace", pathFlavor: "posix" as const },
					}),
				},
			},
		);

		expect(exec).toHaveBeenCalledOnce();
		expect(decodedInput?.cwd).toBe("/workspace");
		expect(result).toMatchObject({ status: "completed", exitCode: 0, stdout: "{}" });
	});

	it("executes the workspace wrapper with backend cwd, stdin, streams, and sanitized environment", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-hook-workspace-wrapper-"));
		const backendOperations = new LocalToolOperations(cwd);
		const previousSecret = process.env.PI_WORKSPACE_TEST_TOKEN;
		process.env.PI_WORKSPACE_TEST_TOKEN = "secret";
		try {
			const script =
				"let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const i=JSON.parse(s);process.stdout.write(i.cwd+'|'+process.cwd()+'|'+process.env.PI_WORKSPACE_TEST_TOKEN);process.stderr.write('backend-stderr')})";
			const result = await executeHook(
				loaded({ type: "command", command: "node", args: ["-e", script] }, 0, {
					kind: "project",
					path: `${cwd}/.pi/settings.json`,
				}),
				input("/host/workspace"),
				{
					toolOperations: {
						cwd,
						exec: backendOperations.exec.bind(backendOperations),
						getBackendInfo: () => ({
							type: "remote" as const,
							cwd,
							configured: true as const,
							url: "ws://sandbox",
							protocol: "ws" as const,
							workspace: { id: "sandbox", root: cwd, pathFlavor: "posix" as const },
						}),
					},
				},
			);

			expect(result).toMatchObject({
				status: "completed",
				exitCode: 0,
				stdout: `${cwd}|${cwd}|undefined`,
				stderr: "backend-stderr",
			});
		} finally {
			if (previousSecret === undefined) delete process.env.PI_WORKSPACE_TEST_TOKEN;
			else process.env.PI_WORKSPACE_TEST_TOKEN = previousSecret;
		}
	});

	it("aborts bounded workspace execution on oversized unframed backend output", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-hook-workspace-unframed-"));
		const result = await executeHook(
			loaded({ type: "command", command: "node", args: ["hook.js"] }, 0, {
				kind: "project",
				path: "/settings.json",
			}),
			input(cwd),
			{
				maxOutputBytes: 16,
				toolOperations: {
					cwd: "/workspace",
					exec: async (_command, options) => {
						options.onData(Buffer.alloc(2048, "x"));
						if (options.signal?.aborted) throw new Error("aborted");
						await new Promise<void>((_resolve, reject) => {
							options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
						});
						return { exitCode: 0 };
					},
					getBackendInfo: () => ({
						type: "remote" as const,
						cwd: "/workspace",
						configured: true as const,
						url: "ws://sandbox",
						protocol: "ws" as const,
						workspace: { id: "sandbox", root: "/workspace", pathFlavor: "posix" as const },
					}),
				},
			},
		);

		expect(result).toMatchObject({ status: "error", stderrTruncated: true });
		expect(result.diagnostic?.message).toContain("output exceeded");
	});

	it("blocks project HTTP hooks on sandbox backends without using host fetch", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-hook-workspace-http-"));
		const fetch = vi.fn<typeof globalThis.fetch>();
		const result = await executeHook(
			loaded({ type: "http", url: "https://example.test/hook" }, 0, { kind: "project", path: "/settings.json" }),
			input(cwd),
			{
				fetch,
				toolOperations: {
					cwd: "/workspace",
					exec: async () => ({ exitCode: 0 }),
					getBackendInfo: () => ({ type: "remote" as const, cwd: "/workspace", configured: false as const }),
				},
			},
		);

		expect(fetch).not.toHaveBeenCalled();
		expect(result.diagnostic).toMatchObject({ code: "policy" });
	});

	it("runs matching handlers in parallel and treats timeout as fail-open", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-hook-timeout-"));
		const hooks = [0, 1].map((order) =>
			loaded(
				{ type: "command", command: process.execPath, args: ["-e", "setTimeout(()=>{},1000)"], timeout: 0.05 },
				order,
			),
		);
		const started = Date.now();
		const results = await executeMatchingHooks(hooks, input(cwd));
		expect(Date.now() - started).toBeLessThan(500);
		expect(results.map((item) => item.status)).toEqual(["timeout", "timeout"]);
		expect(aggregateHookResults(input(cwd), results).blocked).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"kills the process group when the direct child exits but a descendant holds stdio",
		async () => {
			const cwd = await mkdtemp(join(tmpdir(), "pi-hook-descendant-"));
			const script =
				"const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{stdio:'inherit'});c.unref()";
			const started = Date.now();
			const result = await executeHook(
				loaded({ type: "command", command: process.execPath, args: ["-e", script], timeout: 0.05 }),
				input(cwd),
			);
			expect(result.status).toBe("timeout");
			expect(Date.now() - started).toBeLessThan(750);
		},
	);

	it("posts JSON to HTTP hooks and aggregates a structured deny", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-hook-http-"));
		let body = "";
		const server = createServer((request, response) => {
			request.on("data", (chunk) => {
				body += String(chunk);
			});
			request.on("end", () => {
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({
						hookSpecificOutput: {
							hookEventName: "PreToolUse",
							permissionDecision: "deny",
							permissionDecisionReason: "policy",
						},
					}),
				);
			});
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("Missing server address");
		const eventInput = input(cwd);
		const result = await executeHook(loaded({ type: "http", url: `http://127.0.0.1:${address.port}` }), eventInput);
		const aggregate = aggregateHookResults(eventInput, [result]);
		expect(JSON.parse(body)).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Bash" });
		expect(aggregate).toMatchObject({ blocked: true, permissionDecision: "deny", reason: "policy" });
	});

	it("classifies exit 2 by event and never executes unsupported handlers", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-hook-exit-"));
		const blocked = await executeHook(
			loaded({
				type: "command",
				command: process.execPath,
				args: ["-e", "process.stderr.write('no');process.exit(2)"],
			}),
			input(cwd),
		);
		expect(blocked).toMatchObject({ blocking: true, blockingReason: "no" });
		const unsupported = await executeHook(loaded({ type: "agent" }), input(cwd));
		expect(unsupported).toMatchObject({ status: "unsupported", exitCode: null });
	});

	it("ignores actionable structured output from failed commands", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-hook-failed-output-"));
		const eventInput = input(cwd);
		const failed = await executeHook(
			loaded({
				type: "command",
				command: process.execPath,
				args: [
					"-e",
					`process.stdout.write(${JSON.stringify(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "partial" } }))});process.exit(1)`,
				],
			}),
			eventInput,
		);

		expect(failed).toMatchObject({ status: "completed", exitCode: 1 });
		expect(aggregateHookResults(eventInput, [failed])).toMatchObject({ blocked: false });
	});

	it("never applies structured output retained from truncated command or HTTP responses", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-hook-truncated-output-"));
		const eventInput = input(cwd);
		const actionable = JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: "must-not-apply",
			},
		});
		const command = await executeHook(
			loaded({
				type: "command",
				command: process.execPath,
				args: ["-e", `process.stdout.write(${JSON.stringify(`${actionable}${" ".repeat(1000)}`)})`],
			}),
			eventInput,
			{ maxOutputBytes: Buffer.byteLength(actionable) },
		);
		const http = await executeHook(loaded({ type: "http", url: "https://example.test/hook" }), eventInput, {
			maxOutputBytes: Buffer.byteLength(actionable),
			fetch: async () => new Response(`${actionable}${" ".repeat(1000)}`),
		});

		expect(command).toMatchObject({ status: "error", stdoutTruncated: true });
		expect(http).toMatchObject({ status: "error", stdoutTruncated: true });
		expect(aggregateHookResults(eventInput, [command, http])).toMatchObject({ blocked: false });
	});

	it("does not spawn pre-aborted commands and enforces host HTTP URL restrictions", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-hook-abort-"));
		const marker = join(cwd, "spawned");
		const controller = new AbortController();
		controller.abort();
		const cancelled = await executeHook(
			loaded({
				type: "command",
				command: process.execPath,
				args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`],
			}),
			input(cwd),
			{ signal: controller.signal },
		);
		expect(cancelled.status).toBe("cancelled");
		expect(existsSync(marker)).toBe(false);

		let fetched = false;
		const denied = await executeHook(loaded({ type: "http", url: "https://denied.example/hook" }), input(cwd), {
			allowedHttpHookUrls: ["https://allowed.example/*"],
			fetch: async () => {
				fetched = true;
				return new Response();
			},
		});
		expect(fetched).toBe(false);
		expect(denied.diagnostic?.code).toBe("policy");

		const plaintextFetch = vi.fn<typeof globalThis.fetch>();
		const plaintext = await executeHook(loaded({ type: "http", url: "http://example.com/hook" }), input(cwd), {
			fetch: plaintextFetch,
		});
		expect(plaintextFetch).not.toHaveBeenCalled();
		expect(plaintext.diagnostic?.message).toContain("requires HTTPS");

		let bodyCancelled = false;
		const streamed = await executeHook(loaded({ type: "http", url: "https://allowed.example/hook" }), input(cwd), {
			maxOutputBytes: 8,
			fetch: async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("abcdefghijklmnopqrstuvwxyz"));
						},
						cancel() {
							bodyCancelled = true;
						},
					}),
				),
		});
		expect(streamed.stdout).toBe("abcdefgh");
		expect(streamed.stdoutTruncated).toBe(true);
		expect(bodyCancelled).toBe(true);
	});

	it("treats aggregate termination separately from Stop continuation and ignores malformed object output", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-hook-aggregate-"));
		const stopInput: HookInput = {
			session_id: "s",
			transcript_path: "",
			cwd,
			hook_event_name: "Stop",
			stop_hook_active: false,
			last_assistant_message: "done",
		};
		const terminated = await executeHook(
			{
				...loaded({
					type: "command",
					command: process.execPath,
					args: ["-e", "console.log(JSON.stringify({continue:false,stopReason:'settle'}))"],
				}),
				event: "Stop",
			},
			stopInput,
		);
		expect(aggregateHookResults(stopInput, [terminated])).toMatchObject({
			continue: false,
			blocked: false,
			reason: "settle",
		});

		const malformedInput = input(cwd, "UserPromptSubmit");
		const malformed = await executeHook(
			loaded({ type: "command", command: process.execPath, args: ["-e", "process.stdout.write('{broken')"] }),
			malformedInput,
		);
		expect(malformed.diagnostic?.code).toBe("malformed-output");
		expect(aggregateHookResults(malformedInput, [malformed]).additionalContext).toEqual([]);
	});
	it("aggregates nonnegative Stop continuation progress", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-hook-stop-progress-"));
		const stopInput: HookInput = {
			session_id: "s",
			transcript_path: "",
			cwd,
			hook_event_name: "Stop",
			stop_hook_active: true,
			last_assistant_message: "done",
		};
		const progressValues = [7, 5];
		const results = await Promise.all(
			progressValues.map((continuationProgress, order) =>
				executeHook(
					{
						...loaded(
							{
								type: "command",
								command: process.execPath,
								args: [
									"-e",
									`console.log(JSON.stringify({decision:'block',hookSpecificOutput:{hookEventName:'Stop',continuationProgress:${continuationProgress}}}))`,
								],
							},
							order,
						),
						event: "Stop",
					},
					stopInput,
				),
			),
		);
		expect(aggregateHookResults(stopInput, results).stopContinuationProgress).toBe(12);
	});

	it("applies one longest-explicit SessionEnd budget to every matching handler", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-hook-session-end-"));
		const endInput: HookInput = {
			session_id: "s",
			transcript_path: "",
			cwd,
			hook_event_name: "SessionEnd",
			reason: "other",
		};
		const handlers = [0.03, 0.2].map((timeout, order) => ({
			...loaded(
				{
					type: "command" as const,
					command: process.execPath,
					args: ["-e", "setTimeout(()=>{},80)"],
					timeout,
				},
				order,
			),
			event: "SessionEnd" as const,
			matcher: undefined,
		}));
		const results = await executeMatchingHooks(handlers, endInput);
		expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
	});

	it("aggregates systemMessage for lifecycle events that cannot add model context", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-hook-system-message-"));
		const eventInputs: HookInput[] = [
			{ session_id: "s", transcript_path: "", cwd, hook_event_name: "StopFailure", error: "failed" },
			{
				session_id: "s",
				transcript_path: "",
				cwd,
				hook_event_name: "PreCompact",
				trigger: "manual",
				custom_instructions: "",
			},
			{
				session_id: "s",
				transcript_path: "",
				cwd,
				hook_event_name: "PostCompact",
				trigger: "manual",
				compact_summary: "summary",
			},
			{ session_id: "s", transcript_path: "", cwd, hook_event_name: "SessionEnd", reason: "other" },
		];
		for (const eventInput of eventInputs) {
			const handler = {
				...loaded({ type: "command", command: process.execPath, args: ["-e", jsonSystemMessageScript] }),
				event: eventInput.hook_event_name,
				matcher: undefined,
			};
			const result = await executeHook(handler, eventInput);
			expect(aggregateHookResults(eventInput, [result]).systemMessages).toEqual([
				`host-${eventInput.hook_event_name}`,
			]);
		}
	});

	it("uses bounded Windows taskkill process-tree fallback", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-hook-windows-kill-"));
		const pids: number[] = [];
		const result = await executeHook(
			loaded({ type: "command", command: process.execPath, args: ["-e", "setTimeout(()=>{},1000)"], timeout: 0.02 }),
			input(cwd),
			{
				platform: "win32",
				terminateWindowsProcessTree: (pid) => {
					pids.push(pid);
					return false;
				},
			},
		);
		expect(result.status).toBe("timeout");
		expect(pids.length).toBeGreaterThan(0);
	});

	it("rejects redirects and ignores HTTP 2xx plain text", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-hook-http-safe-"));
		const promptInput = input(cwd, "UserPromptSubmit");
		let redirectMode: RequestRedirect | undefined;
		const redirect = await executeHook(
			loaded({ type: "http", url: "https://origin.example/hook", headers: { authorization: "secret" } }),
			promptInput,
			{
				fetch: async (_url, init) => {
					redirectMode = init?.redirect;
					return new Response(null, { status: 302, headers: { location: "https://other.example/steal" } });
				},
			},
		);
		expect(redirectMode).toBe("error");
		expect(redirect.diagnostic).toMatchObject({ code: "policy" });
		expect(aggregateHookResults(promptInput, [redirect]).additionalContext).toEqual([]);

		const plain = await executeHook(loaded({ type: "http", url: "https://origin.example/hook" }), promptInput, {
			fetch: async () => new Response("do not inject", { status: 200 }),
		});
		expect(plain.diagnostic).toMatchObject({ code: "malformed-output" });
		expect(aggregateHookResults(promptInput, [plain]).additionalContext).toEqual([]);
	});

	it("requires matching hookSpecificOutput event names and caps each model-visible field", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-hook-output-safety-"));
		const eventInput = input(cwd);
		const mismatch = await executeHook(
			loaded({
				type: "command",
				command: process.execPath,
				args: [
					"-e",
					`process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',permissionDecision:'deny',additionalContext:'bad'}}))`,
				],
			}),
			eventInput,
		);
		const ignored = aggregateHookResults(eventInput, [mismatch]);
		expect(ignored).toMatchObject({ blocked: false, additionalContext: [] });
		expect(mismatch.diagnostic?.code).toBe("malformed-output");

		const huge = "x".repeat(20_000);
		const capped = await executeHook(
			loaded({
				type: "command",
				command: process.execPath,
				args: [
					"-e",
					`process.stdout.write(${JSON.stringify(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: huge, additionalContext: huge } }))})`,
				],
			}),
			eventInput,
		);
		const aggregate = aggregateHookResults(eventInput, [capped]);
		expect(aggregate.reason).toHaveLength(10_000);
		expect(aggregate.additionalContext[0]).toHaveLength(10_000);
	});

	it("only accepts updatedMCPToolOutput for mcp__ tools", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-hook-mcp-output-"));
		const makeInput = (toolName: string): HookInput => ({
			session_id: "s",
			transcript_path: "",
			cwd,
			hook_event_name: "PostToolUse",
			tool_name: toolName,
			tool_input: {},
			tool_use_id: "id",
			tool_response: "original",
		});
		const handler = {
			...loaded({
				type: "command" as const,
				command: process.execPath,
				args: [
					"-e",
					`process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',updatedMCPToolOutput:'replacement'}}))`,
				],
			}),
			event: "PostToolUse" as const,
			matcher: undefined,
		};
		const builtInInput = makeInput("Read");
		const builtInResult = await executeHook(handler, builtInInput);
		expect(aggregateHookResults(builtInInput, [builtInResult]).updatedToolOutput).toBeUndefined();
		expect(builtInResult.diagnostic?.code).toBe("unsupported-update");
		const mcpInput = makeInput("mcp__server__tool");
		expect(aggregateHookResults(mcpInput, [await executeHook(handler, mcpInput)]).updatedToolOutput).toBe(
			"replacement",
		);
	});

	it("sanitizes only telemetry and Pi credential variables", () => {
		expect(sanitizedHookEnvironment({ OTEL_EXPORTER: "x", PI_API_KEY: "y", PI_THEME: "dark", PATH: "/bin" })).toEqual(
			{ PI_THEME: "dark", PATH: "/bin" },
		);
	});
});
