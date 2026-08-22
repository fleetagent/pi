import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type ProviderHeaders, registerFauxProvider } from "@fleetagent/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { PiAgent } from "../src/core/pi-agent.ts";
import { InMemorySessionManager, LocalSessionManager } from "../src/core/session-manager.ts";
import {
	borrowToolOperations,
	createRemoteToolOperations,
	DeferredRemoteToolOperations,
} from "../src/core/tools/operations.ts";
import { WorkspaceToolHost } from "../src/core/tools/workspace-tool-host.ts";
import { parseDaemonCommand } from "../src/daemon/config.ts";
import { createDaemonServer } from "../src/daemon/server.ts";
import { createHarness } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-remote-routing-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function reservePort(): Promise<number> {
	const server = createHttpServer();
	server.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Unable to reserve test port");
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}

async function createServer(
	workspaceRoot: string,
	allowProcessExec = true,
	token?: string,
	lspConfigPath?: string,
	temporaryRoot?: string,
) {
	const port = await reservePort();
	const command = await parseDaemonCommand(
		[
			"--daemon",
			"--daemon-cwd",
			workspaceRoot,
			"--daemon-port",
			String(port),
			"--daemon-allow-root",
			...(lspConfigPath ? ["--daemon-lsp-config", lspConfigPath] : []),
			...(allowProcessExec ? ["--daemon-allow-process-exec"] : []),
		],
		{
			...(token ? { PI_DAEMON_TOKEN: token } : {}),
			...(temporaryRoot ? { PI_DAEMON_TEMP_ROOT: temporaryRoot } : {}),
		},
		workspaceRoot,
	);
	if (!command.configuration) throw new Error("Missing daemon configuration");
	const server = createDaemonServer(command.configuration);
	const address = await server.listen();
	return { server, address };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((entry) => entry.type === "text")
		.map((entry) => entry.text ?? "")
		.join("\n");
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("remote canonical workspace tool routing", () => {
	it("executes all seven canonical tools once through the daemon host with updates and details", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const { server, address } = await createServer(workspaceRoot);
		const operations = await createRemoteToolOperations(address.url);
		const host = new WorkspaceToolHost({
			cwd: operations.cwd,
			operations,
			tools: { bash: { commandPrefix: "printf prefix;" } },
		});

		expect([...host.getDefinitions().keys()]).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
		await host.execute("write", {
			toolCallId: "write-1",
			arguments: { path: "sample.txt", content: "alpha\nbeta\n" },
		});
		expect(await readFile(join(workspaceRoot, "sample.txt"), "utf8")).toBe("alpha\nbeta\n");

		const readResult = await host.execute("read", {
			toolCallId: "read-1",
			arguments: { path: "sample.txt" },
		});
		const readText = text(readResult);
		expect(readText).toContain("alpha");
		const hashLines = readText.split("\n").filter((line) => line.includes("│"));
		const firstHash = hashLines[0]?.slice(0, 3);
		if (!firstHash) throw new Error("Read result did not contain a hashline anchor");

		const editResult = await host.execute("edit", {
			toolCallId: "edit-1",
			arguments: {
				file_path: "sample.txt",
				changes: [{ hash_range_inclusive: [firstHash, firstHash], content_lines: ["changed"] }],
			},
		});
		expect(editResult.details).toMatchObject({ firstChangedLine: 1 });
		expect(await readFile(join(workspaceRoot, "sample.txt"), "utf8")).toBe("changed\nbeta\n");

		expect(text(await host.execute("ls", { toolCallId: "ls-1", arguments: {} }))).toContain("sample.txt");
		expect(text(await host.execute("find", { toolCallId: "find-1", arguments: { pattern: "*.txt" } }))).toContain(
			"sample.txt",
		);
		expect(text(await host.execute("grep", { toolCallId: "grep-1", arguments: { pattern: "changed" } }))).toContain(
			"sample.txt:1: changed",
		);

		const updates: string[] = [];
		const bashResult = await host.execute("bash", {
			toolCallId: "bash-1",
			arguments: { command: "printf routed" },
			onUpdate: (update) => updates.push(text(update)),
		});
		expect(text(bashResult)).toBe("prefixrouted");
		expect(updates.some((update) => update.includes("prefixrouted"))).toBe(true);

		await host.dispose();
		await operations.dispose();
		await server.close();
	});

	it("hosts configured LSP beside the daemon workspace without a local AgentSession manager", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const configPath = join(workspaceRoot, "daemon-lsp.json");
		const exitMarker = join(workspaceRoot, "lsp-exited.txt");
		const fixture = fileURLToPath(new URL("./fixtures/lsp-stdio-server.mjs", import.meta.url));
		await writeFile(
			configPath,
			JSON.stringify({
				servers: [
					{
						id: "fixture",
						selectors: [{ languageId: "typescript", pattern: "**/*.ts" }],
						transport: { type: "spawn", command: "node", args: [fixture, `--exit-marker=${exitMarker}`] },
						lifecycle: { type: "managed" },
						workspace: { type: "session" },
					},
				],
			}),
		);
		await writeFile(join(workspaceRoot, "sample.ts"), "const value = 1;\n");
		const { server, address } = await createServer(workspaceRoot, true, undefined, configPath);
		const operations = await createRemoteToolOperations(address.url);
		const harness = await createHarness({ toolOperations: operations });
		expect(harness.session.getLspStatus()).toMatchObject({
			owner: "daemon",
			enabled: true,
			servers: [expect.objectContaining({ serverId: "fixture", state: "idle", running: false })],
		});
		expect(harness.session.getAllTools().some((tool) => tool.name === "lsp_hover")).toBe(true);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("lsp_hover", { path: "sample.ts", line: 1, character: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("inspect hover");
		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "lsp_hover",
		);
		expect(result?.role === "toolResult" ? result.content[0] : undefined).toMatchObject({
			type: "text",
			text: "fixture hover: const value = 1;",
		});
		expect(harness.session.getLspStatus()).toMatchObject({
			owner: "daemon",
			servers: [expect.objectContaining({ serverId: "fixture", state: "running", ownership: "managed" })],
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "sample.ts", content: "const changed = 2;\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("lsp_hover", { path: "sample.ts", line: 1, character: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("change and inspect hover");
		const hoverResults = harness.session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "lsp_hover",
		);
		const synchronizedHover = hoverResults.at(-1);
		expect(synchronizedHover?.role === "toolResult" ? synchronizedHover.content[0] : undefined).toMatchObject({
			type: "text",
			text: "fixture hover: const changed = 2;",
		});
		await harness.session.dispose();
		await operations.dispose();
		await server.close();
		await vi.waitFor(async () => expect(await readFile(exitMarker, "utf8")).toBe("exited"));
	});

	it("propagates cancellation to daemon-owned LSP requests", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const configPath = join(workspaceRoot, "daemon-lsp-cancel.json");
		const fixture = fileURLToPath(new URL("./fixtures/lsp-stdio-server.mjs", import.meta.url));
		await writeFile(
			configPath,
			JSON.stringify({
				servers: [
					{
						id: "fixture",
						selectors: [{ languageId: "typescript", pattern: "**/*.ts" }],
						transport: { type: "spawn", command: "node", args: [fixture, "--hang-hover"] },
						lifecycle: { type: "managed" },
						workspace: { type: "session" },
					},
				],
			}),
		);
		await writeFile(join(workspaceRoot, "sample.ts"), "const value = 1;\n");
		const { server, address } = await createServer(workspaceRoot, true, undefined, configPath);
		const operations = await createRemoteToolOperations(address.url);
		const harness = await createHarness({ toolOperations: operations });
		const controller = new AbortController();
		const invocation = operations.executeWorkspaceTool("lsp_hover", {
			toolCallId: "cancel-lsp",
			arguments: { path: "sample.ts", line: 1, character: 1 },
			signal: controller.signal,
			executionOptions: {},
		});
		setTimeout(() => controller.abort(), 50);
		await expect(invocation).rejects.toThrow(/cancel|abort/iu);
		await harness.session.dispose();
		await operations.dispose();
		await server.close();
	});

	it("keeps AgentSession as the sole lifecycle and extension-policy owner", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const { server, address } = await createServer(workspaceRoot, false);
		const operations = await createRemoteToolOperations(address.url);
		let toolCalls = 0;
		let toolResults = 0;
		let originalToolError: string | undefined;
		const harness = await createHarness({
			toolOperations: operations,
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async () => {
						toolCalls++;
					});
					pi.on("tool_result", async (event) => {
						if (event.isError) {
							originalToolError = event.content
								.filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
								.map((entry) => entry.text)
								.join("\n");
						}
						toolResults++;
						return { content: [{ type: "text", text: "local result middleware" }] };
					});
				},
			],
		});
		await server.reload();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "agent.txt", content: "agent" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("write remotely");
		expect(originalToolError).toBeUndefined();
		const persistedToolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(
			persistedToolResult?.role === "toolResult"
				? persistedToolResult.content.find((entry) => entry.type === "text")?.text
				: undefined,
		).toBe("local result middleware");
		expect(await readFile(join(workspaceRoot, "agent.txt"), "utf8")).toBe("agent");
		expect(toolCalls).toBe(1);
		expect(toolResults).toBe(1);
		expect(harness.eventsOfType("tool_execution_start")).toHaveLength(1);
		expect(harness.eventsOfType("tool_execution_end")).toHaveLength(1);
		await harness.session.dispose();
		const replacement = new WorkspaceToolHost({ cwd: operations.cwd, operations });
		expect(
			text(await replacement.execute("read", { toolCallId: "replacement", arguments: { path: "agent.txt" } })),
		).toContain("agent");
		await replacement.dispose();
		await operations.dispose();
		await server.close();
		harness.cleanup();
	});

	it("preserves cancellation, canonical errors, confinement, and mutation ordering", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const outside = await createTemporaryDirectory();
		const temporaryRoot = await createTemporaryDirectory();
		const { server, address } = await createServer(workspaceRoot, true, undefined, undefined, temporaryRoot);
		const operations = await createRemoteToolOperations(address.url);
		const host = new WorkspaceToolHost({ cwd: operations.cwd, operations });
		const temporaryFile = join(temporaryRoot, "scratch.txt");
		await host.execute("write", {
			toolCallId: "temporary-write",
			arguments: { path: temporaryFile, content: "temporary" },
		});
		expect(await readFile(temporaryFile, "utf8")).toBe("temporary");
		expect(
			text(await host.execute("read", { toolCallId: "temporary-read", arguments: { path: temporaryFile } })),
		).toContain("temporary");

		await expect(
			host.execute("read", { toolCallId: "escape", arguments: { path: join(outside, "secret.txt") } }),
		).rejects.toThrow("Path escapes the daemon workspace");
		await writeFile(join(outside, "secret.txt"), "secret");
		await symlink(outside, join(temporaryRoot, "outside-link"));
		await expect(
			host.execute("read", {
				toolCallId: "temporary-symlink-read",
				arguments: { path: join(temporaryRoot, "outside-link", "secret.txt") },
			}),
		).rejects.toThrow("Path escapes the daemon workspace");
		await symlink(outside, join(workspaceRoot, "outside-link"));
		await expect(
			host.execute("read", { toolCallId: "dotdot-escape", arguments: { path: "../secret.txt" } }),
		).rejects.toThrow("Path escapes the daemon workspace");
		await expect(
			host.execute("read", { toolCallId: "symlink-read", arguments: { path: "outside-link/secret.txt" } }),
		).rejects.toThrow("Path escapes the daemon workspace");
		await expect(
			host.execute("write", {
				toolCallId: "symlink-write",
				arguments: { path: "outside-link/modified.txt", content: "escaped" },
			}),
		).rejects.toThrow("Path escapes the daemon workspace");
		await expect(readFile(join(outside, "modified.txt"), "utf8")).rejects.toThrow();
		await symlink(join(outside, "future.txt"), join(workspaceRoot, "broken-link"));
		await expect(
			host.execute("write", {
				toolCallId: "broken-symlink-write",
				arguments: { path: "broken-link", content: "escaped" },
			}),
		).rejects.toThrow("broken symbolic link");
		await expect(readFile(join(outside, "future.txt"), "utf8")).rejects.toThrow();

		const first = host.execute("write", {
			toolCallId: "ordered-1",
			arguments: { path: "ordered.txt", content: "first" },
		});
		const second = host.execute("write", {
			toolCallId: "ordered-2",
			arguments: { path: "ordered.txt", content: "second" },
		});
		await Promise.all([first, second]);
		expect(await readFile(join(workspaceRoot, "ordered.txt"), "utf8")).toBe("second");

		await expect(
			host.execute("bash", { toolCallId: "failure", arguments: { command: "printf failure; exit 3" } }),
		).rejects.toThrow("Command exited with code 3");

		const controller = new AbortController();
		const running = host.execute("bash", {
			toolCallId: "cancel",
			arguments: { command: "sleep 5" },
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 50);
		await expect(running).rejects.toThrow(/cancel|abort/iu);

		await operations.dispose();
		await server.close();
	});

	it("uses typed client credentials and rejects deferred workspace identity drift", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const otherRoot = await createTemporaryDirectory();
		const token = "remote-routing-token-0123456789abcdef";
		const { server, address } = await createServer(workspaceRoot, false, token);
		await expect(
			createRemoteToolOperations(address.url, { token: "wrong-token-that-is-at-least-32-bytes" }),
		).rejects.toThrow("Failed to connect remote workspace");
		const authenticated = await createRemoteToolOperations(address.url, { token });
		expect(authenticated.cwd).toBe(workspaceRoot);
		await authenticated.dispose();
		const deferred = new DeferredRemoteToolOperations(otherRoot);
		await expect(deferred.configureRemote(address.url, { token })).rejects.toThrow("workspace root mismatch");
		const sandboxExpected = new DeferredRemoteToolOperations(otherRoot);
		await sandboxExpected.configureRemote(address.url, { token, expectedCwd: workspaceRoot });
		expect(sandboxExpected.getBackendInfo()).toMatchObject({ type: "remote", cwd: workspaceRoot, configured: true });
		await sandboxExpected.dispose();
		await server.close();
	});
	it("does not expose an authenticated daemon bearer token to provider header hooks", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const token = "provider-header-secret-0123456789abcdef";
		const { server, address } = await createServer(workspaceRoot, false, token);
		const operations = await createRemoteToolOperations(address.url, { token });
		const faux = registerFauxProvider();
		const model = faux.getModel();
		let observedHeaders: ProviderHeaders | undefined;
		let providerHeaders: ProviderHeaders | undefined;
		faux.setResponses([
			(_context, options) => {
				providerHeaders = { ...options?.headers };
				return fauxAssistantMessage("done");
			},
		]);
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) => {
					pi.on("before_provider_headers", (event) => {
						observedHeaders = { ...event.headers };
						event.headers["x-correlation-id"] = "daemon-safe";
					});
				},
			],
			workspaceRoot,
		);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "model-provider-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const pi = await PiAgent.create({
			cwd: workspaceRoot,
			model,
			authStorage,
			modelRegistry,
			sessionManager: new InMemorySessionManager(workspaceRoot),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			toolOperations: operations,
		});

		try {
			const session = await pi.createAgentSession();
			await session.prompt("trace safely");
			await session.waitForIdle();
			const serializedHeaders = JSON.stringify({ observedHeaders, providerHeaders });
			expect(serializedHeaders).not.toContain(token);
			expect(observedHeaders).not.toHaveProperty("authorization");
			expect(providerHeaders).toMatchObject({ "x-correlation-id": "daemon-safe" });
		} finally {
			await pi.dispose();
			await operations.dispose();
			await server.close();
			faux.unregister();
		}
	});

	it("keeps deferred daemon connections owned across host replacement and disposes them once", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		await writeFile(join(workspaceRoot, "deferred.txt"), "deferred");
		const { server, address } = await createServer(workspaceRoot, false);
		const operations = new DeferredRemoteToolOperations(workspaceRoot);
		await operations.configureRemote(address.url);
		const firstHost = new WorkspaceToolHost({ cwd: operations.cwd, operations });
		expect(firstHost.getDefinition("bash")).toBeUndefined();
		expect(
			text(await firstHost.execute("read", { toolCallId: "deferred-1", arguments: { path: "deferred.txt" } })),
		).toContain("deferred");
		await firstHost.dispose();
		await server.close();
		const replacementServer = await createServer(workspaceRoot, false);
		await operations.configureRemote(replacementServer.address.url);
		const replacementHost = new WorkspaceToolHost({ cwd: operations.cwd, operations });
		expect(
			text(await replacementHost.execute("read", { toolCallId: "deferred-2", arguments: { path: "deferred.txt" } })),
		).toContain("deferred");
		await replacementHost.dispose();
		await operations.dispose();
		await operations.dispose();
		await replacementServer.server.close();
	});

	it("lets the top-level PiAgent own one remote runtime while sessions remain borrowers", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const { server, address } = await createServer(workspaceRoot, false);
		const operations = await createRemoteToolOperations(address.url);
		const borrowed = borrowToolOperations(operations);
		expect("dispose" in borrowed).toBe(false);
		expect((borrowed as { dispose?: unknown }).dispose).toBeUndefined();
		const disposeRemote = operations.dispose.bind(operations);
		let disposeCalls = 0;
		operations.dispose = async () => {
			disposeCalls++;
			await disposeRemote();
		};
		const piAgent = await PiAgent.create({
			cwd: workspaceRoot,
			toolOperations: operations,
			ownsToolOperations: true,
		});
		await Promise.all([piAgent.dispose(), piAgent.dispose()]);
		expect(disposeCalls).toBe(1);
		await server.close();
	});
	it("keeps JSONL sessions local while daemon tools mutate only the remote workspace", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const localSessionDir = await createTemporaryDirectory();
		const { server, address } = await createServer(workspaceRoot, false);
		const operations = await createRemoteToolOperations(address.url);
		const faux = registerFauxProvider();
		const model = faux.getModel();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "daemon-only.txt", content: "remote" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "model-provider-key");
		const pi = await PiAgent.create({
			cwd: workspaceRoot,
			model,
			authStorage,
			modelRegistry: ModelRegistry.inMemory(authStorage),
			sessionManager: new LocalSessionManager({ cwd: workspaceRoot, sessionDir: localSessionDir }),
			resourceLoader: createTestResourceLoader(),
			toolOperations: operations,
		});
		try {
			const session = await pi.createAgentSession();
			await session.prompt("write through daemon");
			await session.waitForIdle();
			expect(await readFile(join(workspaceRoot, "daemon-only.txt"), "utf8")).toBe("remote");
			const localFiles = await readdir(localSessionDir);
			expect(localFiles.filter((file) => file.endsWith(".jsonl"))).toHaveLength(1);
			expect((await readdir(workspaceRoot)).some((file) => file.endsWith(".jsonl"))).toBe(false);
		} finally {
			await pi.dispose();
			await operations.dispose();
			await server.close();
			faux.unregister();
		}
	});
});
