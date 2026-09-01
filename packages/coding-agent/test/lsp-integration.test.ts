import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentToolResult } from "@fleetagent/pi-agent-core";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeActionParams, Diagnostic, ServerCapabilities } from "vscode-languageserver-protocol";
import { DiagnosticSeverity, TextDocumentSyncKind } from "vscode-languageserver-protocol";
import type { MessageConnection } from "vscode-languageserver-protocol/node.js";
import type { ExtensionAPI, ExtensionContext, ToolDefinition, ToolResultEvent } from "../src/core/extensions/types.ts";
import { LspClient, type LspClientOptions, type LspClientStartResult } from "../src/core/lsp/client.ts";
import {
	type LspConfiguredServer,
	parseLspConfiguration,
	type ResolvedLspConfiguration,
	resolveLspConfiguration,
} from "../src/core/lsp/config.ts";
import { createLspDiagnosticsTool, formatAutoDiagnosticsForChangedFile } from "../src/core/lsp/diagnostics.ts";
import { LspFileSync } from "../src/core/lsp/file-sync.ts";
import {
	type LspRuntimeState,
	type LspSessionStatus,
	registerLspLifecycleHandlers,
	registerStandaloneLspLifecycleHandlers,
} from "../src/core/lsp/integration.ts";
import { LspPathMapper, LspRouter } from "../src/core/lsp/language-map.ts";
import { LspManager } from "../src/core/lsp/manager.ts";
import { createLspDefinitionTool, createLspHoverTool, createLspReferencesTool } from "../src/core/lsp/navigation.ts";
import { createLspCodeActionsTool, createLspRenameTool } from "../src/core/lsp/refactor.ts";
import type { LspConnectionFactory } from "../src/core/lsp/transport.ts";
import { PiAgent } from "../src/core/pi-agent.ts";
import { LocalSessionManager } from "../src/core/session/local-session-manager.ts";
import { LocalToolOperations, type ToolBackendInfo, type ToolOperations } from "../src/core/tools/operations.ts";

const tempDirs: string[] = [];

function remoteBackendInfo(cwd: string, id = "remote"): ToolBackendInfo {
	return {
		type: "remote",
		cwd,
		url: `ws://${id}.test/pi/workspace`,
		protocol: "ws",
		configured: true,
		workspace: { id, root: cwd, pathFlavor: "posix" },
	};
}

class FakeLspClient extends LspClient {
	private fakeInitialized = false;
	private readonly unexpectedClose: ((error?: Error) => void) | undefined;
	private fakeDisposed = false;
	readonly requests: Array<{ method: string; params: unknown }> = [];
	readonly notifications: Array<{ method: string; params: unknown }> = [];
	private readonly responses = new Map<string, unknown>();
	private readonly responseHandlers = new Map<string, (params: unknown, signal?: AbortSignal) => unknown>();
	private readonly fakeDiagnostics = new Map<string, Diagnostic[]>();
	private fakeCapabilities: ServerCapabilities = {
		textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Full },
		hoverProvider: true,
		definitionProvider: true,
		referencesProvider: true,
		renameProvider: true,
		codeActionProvider: true,
	};

	constructor(options: LspClientOptions) {
		super(options);
		this.unexpectedClose = options.onUnexpectedClose;
	}
	override get isInitialized(): boolean {
		return this.fakeInitialized;
	}

	override get isDisposed(): boolean {
		return this.fakeDisposed;
	}

	override get serverCapabilities(): ServerCapabilities {
		return this.fakeCapabilities;
	}

	setResponse(method: string, response: unknown): void {
		this.responses.set(method, response);
	}

	setResponseHandler(method: string, handler: (params: unknown, signal?: AbortSignal) => unknown): void {
		this.responseHandlers.set(method, handler);
	}

	setCapabilities(capabilities: ServerCapabilities): void {
		this.fakeCapabilities = capabilities;
	}

	setDiagnostics(uri: string, diagnostics: Diagnostic[]): void {
		this.fakeDiagnostics.set(uri, diagnostics);
	}

	disconnectUnexpectedly(): void {
		this.fakeInitialized = false;
		this.unexpectedClose?.(new Error("fake disconnect"));
	}

	override async start(): Promise<LspClientStartResult> {
		this.fakeInitialized = true;
		return {
			capabilities: this.fakeCapabilities,
			endpoint: { type: "connection" as const, description: "fake connection", disposalMode: "disconnect" as const },
		};
	}

	override async sendRequest<TResult>(method: string, params: unknown, signal?: AbortSignal): Promise<TResult> {
		this.requests.push({ method, params });
		const handler = this.responseHandlers.get(method);
		if (handler) return (await handler(params, signal)) as TResult;
		const response = this.responses.get(method);
		if (response instanceof Error) throw response;
		return response as TResult;
	}

	override async sendNotification(method: string, params: unknown): Promise<void> {
		this.notifications.push({ method, params });
	}

	override async didOpen(uri: string, languageId: string, version: number, text: string): Promise<void> {
		this.notifications.push({ method: "textDocument/didOpen", params: { uri, languageId, version, text } });
	}

	override async didChange(uri: string, version: number, text: string): Promise<void> {
		this.notifications.push({ method: "textDocument/didChange", params: { uri, version, text } });
	}

	override getDiagnostics(uri: string): Diagnostic[] {
		return this.fakeDiagnostics.get(uri) ?? [];
	}

	override getAllDiagnostics(): Map<string, Diagnostic[]> {
		return new Map(this.fakeDiagnostics);
	}

	override invalidate(): Promise<void> {
		return this.shutdown();
	}

	override async shutdown(): Promise<void> {
		this.fakeDisposed = true;
		this.fakeInitialized = false;
	}
}

const unusedConnectionFactory: LspConnectionFactory = async () => {
	throw new Error("unused connection factory");
};
async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-lsp-test-"));
	tempDirs.push(dir);
	return dir;
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs = 100): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise.then(
				() => true,
				() => true,
			),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function testServer(overrides: Partial<LspConfiguredServer> = {}): LspConfiguredServer {
	return {
		id: "typescript",
		selectors: [{ languageId: "typescript", pattern: "**/*.ts" }],
		transport: { type: "spawn", command: "fake", args: [] },
		lifecycle: { type: "managed" },
		workspace: { type: "session" },
		...overrides,
	};
}

function text(result: AgentToolResult<unknown>): string {
	const content = result.content[0];
	return content?.type === "text" ? content.text : "";
}

function createContext(cwd: string): ExtensionContext {
	return {
		cwd,
		toolOperations: new LocalToolOperations(cwd),
		getLspStatus: () => ({
			owner: "standalone",
			enabled: false,
			configuration: { enabled: false, servers: [] },
			servers: [],
		}),
	} as unknown as ExtensionContext;
}

interface SingleClientLspTestState {
	cwd: string;
	state: LspRuntimeState;
	client: FakeLspClient;
}

interface MultiClientLspTestState {
	cwd: string;
	state: LspRuntimeState;
	clients: Map<string, FakeLspClient>;
}

async function createStateWithClient(
	responses: Record<string, unknown> = {},
	diagnostics: Record<string, Diagnostic[]> = {},
): Promise<SingleClientLspTestState> {
	const cwd = await createTempDir();
	await writeFile(join(cwd, "fixture.ts"), "const value = 1;\nvalue;\n", "utf8");
	let client: FakeLspClient | undefined;
	const manager = new LspManager(cwd, {
		configuration: { enabled: true, servers: [testServer()] },
		createClient: (options) => {
			client = new FakeLspClient(options);
			for (const [method, response] of Object.entries(responses)) client.setResponse(method, response);
			return client;
		},
	});
	const state = { manager, fileSync: new LspFileSync(manager) };
	const started = await manager.getClientForFile("fixture.ts");
	if (!(started instanceof FakeLspClient)) throw new Error("expected fake client");
	for (const [uri, entries] of Object.entries(diagnostics)) started.setDiagnostics(uri, entries);
	return { cwd, state, client: started };
}

async function createMultiToolState(
	servers: LspConfiguredServer[],
	configure: (client: FakeLspClient) => void,
): Promise<MultiClientLspTestState> {
	const cwd = await createTempDir();
	await writeFile(join(cwd, "fixture.ts"), "const value = 1;\nvalue;\n", "utf8");
	const clients = new Map<string, FakeLspClient>();
	const manager = new LspManager(cwd, {
		configuration: { enabled: true, servers },
		createClient: (options) => {
			const client = new FakeLspClient(options);
			configure(client);
			clients.set(options.serverId, client);
			return client;
		},
	});
	return { cwd, state: { manager, fileSync: new LspFileSync(manager) }, clients };
}

function diagnostic(message: string, severity = DiagnosticSeverity.Error): Diagnostic {
	return {
		message,
		severity,
		range: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } },
		source: "fake-ts",
	};
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("LSP manager lifecycle", () => {
	it("starts clients lazily and shuts them down", async () => {
		const cwd = await createTempDir();
		const created: FakeLspClient[] = [];
		const manager = new LspManager(cwd, {
			configuration: {
				enabled: true,
				servers: [testServer({ pathMappings: [{ agentRoot: cwd, serverRootUri: "file:///remote/workspace" }] })],
			},
			createClient: (options) => {
				const client = new FakeLspClient(options);
				created.push(client);
				return client;
			},
		});

		const target = await manager.getPrimaryTarget("fixture.ts");
		if (!target) throw new Error("expected route target");
		expect(manager.getRunningClient(target.instanceKey)).toBeUndefined();
		const first = await manager.getClientForFile("fixture.ts");
		const second = await manager.getClientForFile("fixture.ts");

		expect(first).toBe(second);
		expect(created).toHaveLength(1);
		expect(created[0]?.rootUri).toBe("file:///remote/workspace");
		expect(manager.getRunningClient(target.instanceKey)).toBe(first);

		await manager.shutdownAll();
		expect(created[0]?.isDisposed).toBe(true);
		expect(manager.getRunningClient(target.instanceKey)).toBeUndefined();
	});

	it("does not report running after startup replay invalidates the client", async () => {
		const cwd = await createTempDir();
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => new FakeLspClient(options),
		});
		manager.onClientStarted(async ({ target, client }) => {
			await manager.invalidateSynchronizationClient(target, client, new Error("replay failed"), false);
		});

		await expect(manager.getClientForFile("fixture.ts")).resolves.toBeUndefined();
		expect(manager.getStatus()[0]).toMatchObject({ state: "closed", running: false });
		await manager.shutdownAll();
	});

	it("invalidates running instances when configuration changes", async () => {
		const cwd = await createTempDir();
		const created: FakeLspClient[] = [];
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => {
				const client = new FakeLspClient(options);
				created.push(client);
				return client;
			},
		});
		const first = await manager.getClientForFile("fixture.ts");
		await manager.setConfiguration({
			enabled: true,
			servers: [testServer({ transport: { type: "spawn", command: "replacement", args: [] } })],
		});
		const second = await manager.getClientForFile("fixture.ts");

		expect(first?.isDisposed).toBe(true);
		expect(second).not.toBe(first);
		expect(created).toHaveLength(2);
		await manager.shutdownAll();
	});

	it("serializes overlapping reconfiguration and shutdown without retaining a late client", async () => {
		const cwd = await createTempDir();
		let releaseStart: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		class SlowClient extends FakeLspClient {
			override async start(): Promise<LspClientStartResult> {
				markStarted?.();
				await startGate;
				return super.start();
			}

			override async shutdown(): Promise<void> {
				releaseStart?.();
				await super.shutdown();
			}
		}
		let client: SlowClient | undefined;
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => {
				client = new SlowClient(options);
				return client;
			},
		});
		const startup = manager.getClientForFile("fixture.ts");
		await started;
		const reconfigure = manager.setConfiguration({ enabled: true, servers: [testServer()] });
		const shutdown = manager.shutdownAll();
		const [startupResult] = await Promise.all([startup, reconfigure, shutdown]);
		expect(startupResult).toBeUndefined();
		expect(client?.isDisposed).toBe(true);
		expect(manager.getStatus()).toEqual([
			expect.objectContaining({
				serverId: "typescript",
				state: "idle",
				running: false,
				reconnectEligible: false,
			}),
		]);
		await expect(manager.getClientForFile("fixture.ts")).resolves.toBeUndefined();
	});

	it("rejects a startup completion that becomes stale during client-started listener replay", async () => {
		const cwd = await createTempDir();
		let markListenerStarted!: () => void;
		const listenerGate = new Promise<void>(() => {});
		const listenerStarted = new Promise<void>((resolve) => {
			markListenerStarted = resolve;
		});
		let client: FakeLspClient | undefined;
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => {
				client = new FakeLspClient(options);
				return client;
			},
		});
		manager.onClientStarted(async () => {
			markListenerStarted();
			await listenerGate;
		});
		const startup = manager.getClientForFile("fixture.ts");
		await listenerStarted;
		const replacement = manager.setConfiguration({
			enabled: true,
			servers: [testServer({ transport: { type: "spawn", command: "replacement" } })],
		});
		expect(await settlesWithin(Promise.all([startup, replacement]))).toBe(true);
		await expect(startup).resolves.toBeUndefined();
		await replacement;
		expect(manager.getStatus()).toEqual([
			expect.objectContaining({ serverId: "typescript", state: "idle", running: false }),
		]);
		await manager.shutdownAll();
	});

	it("bounds a noncompliant pre-shutdown listener before disposing clients", async () => {
		const cwd = await createTempDir();
		let client: FakeLspClient | undefined;
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer({ timeouts: { shutdownMs: 10 } })] },
			createClient: (options) => {
				client = new FakeLspClient(options);
				return client;
			},
		});
		manager.onClientsWillShutdown(() => new Promise(() => {}));
		await manager.getClientForFile("fixture.ts");
		const shutdown = manager.shutdownAll();
		expect(await settlesWithin(shutdown)).toBe(true);
		await shutdown;
		expect(client?.isDisposed).toBe(true);
	});

	it("rejects a stale route that finishes after reconfiguration", async () => {
		let releasePathCheck: (() => void) | undefined;
		let markPathCheckStarted: (() => void) | undefined;
		const pathCheckGate = new Promise<void>((resolve) => {
			releasePathCheck = resolve;
		});
		const pathCheckStarted = new Promise<void>((resolve) => {
			markPathCheckStarted = resolve;
		});
		let created = 0;
		const oldServer = testServer({ workspace: { type: "markers", markers: ["old-root"], fallback: "session" } });
		const newServer = testServer({ transport: { type: "spawn", command: "new-server" } });
		const manager = new LspManager(await createTempDir(), {
			configuration: { enabled: true, servers: [oldServer] },
			pathExists: async () => {
				markPathCheckStarted?.();
				await pathCheckGate;
				return false;
			},
			createClient: (options) => {
				created++;
				return new FakeLspClient(options);
			},
		});
		const staleRoute = manager.getClientForFile("fixture.ts");
		await pathCheckStarted;
		await manager.setConfiguration({ enabled: true, servers: [newServer] });
		releasePathCheck?.();
		await expect(staleRoute).resolves.toBeUndefined();
		expect(created).toBe(0);
		await expect(manager.getClientForFile("fixture.ts")).resolves.toBeDefined();
		expect(created).toBe(1);
		await manager.shutdownAll();
	});

	it("does not route retained server definitions while runtime configuration is disabled", async () => {
		let created = 0;
		const manager = new LspManager(await createTempDir(), {
			configuration: { enabled: false, servers: [testServer()] },
			createClient: (options) => {
				created++;
				return new FakeLspClient(options);
			},
		});
		expect(await manager.resolveTargets("fixture.ts")).toEqual({ targets: [], failures: [] });
		expect(await manager.getClientForFile("fixture.ts")).toBeUndefined();
		expect(await manager.getUnavailableReason("fixture.ts")).toBe("LSP is disabled.");
		expect(created).toBe(0);
		await manager.shutdownAll();
	});

	it("bounds and records a blocked exit notification during shutdown", async () => {
		const cwd = await createTempDir();
		const client = new LspClient({
			serverId: "fake",
			rootDir: cwd,
			languageId: "typescript",
			connectionFactory: unusedConnectionFactory,
			shutdownTimeoutMs: 5,
		});
		let exitAttempted = false;
		const exitWrite = new Promise<void>(() => {});
		const connection = {
			sendRequest: async () => undefined,
			sendNotification: () => {
				exitAttempted = true;
				return exitWrite;
			},
			dispose: () => {},
		} as unknown as MessageConnection;
		Object.assign(client as unknown as { connection: MessageConnection; initialized: boolean }, {
			connection,
			initialized: true,
		});

		const shutdown = client.shutdown();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(exitAttempted).toBe(true);
		await expect(shutdown).resolves.toBeUndefined();
		expect(client.lastTransportError?.message).toContain("Sending exit");
	});

	it("attempts exit and connection disposal when protocol shutdown blocks", async () => {
		const client = new LspClient({
			serverId: "blocked-shutdown",
			rootDir: await createTempDir(),
			languageId: "typescript",
			connectionFactory: unusedConnectionFactory,
			shutdownTimeoutMs: 10,
		});
		let exitAttempts = 0;
		let disposals = 0;
		const connection = {
			sendRequest: () => new Promise(() => {}),
			sendNotification: async () => {
				exitAttempts++;
			},
			dispose: () => {
				disposals++;
			},
		} as unknown as MessageConnection;
		Object.assign(client as unknown as { connection: MessageConnection; initialized: boolean }, {
			connection,
			initialized: true,
		});
		await expect(client.shutdown()).resolves.toBeUndefined();
		expect(exitAttempts).toBe(1);
		expect(disposals).toBe(1);
		expect(client.connectionState).toBe("disposed");
	});

	it("surfaces notification write failures while active", async () => {
		const cwd = await createTempDir();
		const client = new LspClient({
			serverId: "fake",
			rootDir: cwd,
			languageId: "typescript",
			connectionFactory: unusedConnectionFactory,
		});
		const error = Object.assign(new Error("stream destroyed"), { code: "ERR_STREAM_DESTROYED" });
		const connection = {
			sendNotification: async () => {
				throw error;
			},
		} as unknown as MessageConnection;
		Object.assign(client as unknown as { connection: MessageConnection; initialized: boolean }, {
			connection,
			initialized: true,
		});

		await expect(client.sendNotification("test", {})).rejects.toBe(error);
	});

	it("keeps an explicit core-only tool allowlist closed when LSP is configured", async () => {
		const cwd = await createTempDir();
		const agentDir = await createTempDir();
		let factoryCalls = 0;
		const runtime = await PiAgent.create({
			cwd,
			agentDir,
			tools: ["read", "bash", "edit", "write"],
			lsp: {
				type: "configuration",
				configuration: {
					servers: [
						{
							id: "host",
							selectors: [{ languageId: "typescript", pattern: "**/*.ts" }],
							transport: { type: "connection", id: "test" },
							lifecycle: { type: "attached" },
							workspace: { type: "session" },
						},
					],
				},
			},
			lspConnectionFactories: {
				test: async () => {
					factoryCalls++;
					throw new Error("host-authenticated connection failed");
				},
			},
		});
		const session = await runtime.createAgentSession();

		expect(session.getLspStatus().enabled).toBe(true);
		expect(session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
		expect(session.getToolDefinition("lsp_hover")).toBeUndefined();
		expect(factoryCalls).toBe(0);
		await session.dispose();
	});

	it("does not create or expose the LSP runtime when explicitly disabled", async () => {
		const cwd = await createTempDir();
		const agentDir = await createTempDir();
		const runtime = await PiAgent.create({
			cwd,
			agentDir,
			tools: ["read", "lsp_hover"],
			lsp: { type: "disabled" },
		});
		const session = await runtime.createAgentSession();

		expect(session.getActiveToolNames()).toContain("read");
		expect(session.getActiveToolNames()).not.toContain("lsp_hover");
		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("lsp_hover");
		expect((session as unknown as { _lspRuntimeState?: LspRuntimeState })._lspRuntimeState).toBeUndefined();
		await session.dispose();
	});

	it("exposes controlled session and extension LSP configuration without parallel managers", async () => {
		const cwd = await createTempDir();
		const agentDir = await createTempDir();
		const runtime = await PiAgent.create({ cwd, agentDir, lsp: { type: "disabled" } });
		const session = await runtime.createAgentSession();
		const context = session.extensionRunner.createContext();
		expect(context.getLspStatus()).toEqual({
			owner: "agent-session",
			enabled: false,
			configuration: { enabled: false, servers: [] },
			servers: [],
		});
		const configured = await context.configureLsp({ servers: [testServer({ id: "extension-owned" })] });
		expect(configured).toMatchObject({ enabled: true, servers: [{ id: "extension-owned" }] });
		const state = (session as unknown as { _lspRuntimeState?: LspRuntimeState })._lspRuntimeState;
		expect(state).toBeDefined();
		expect(context.getLspStatus()).toMatchObject({
			enabled: true,
			configuration: { servers: [{ id: "extension-owned" }] },
			servers: [{ serverId: "extension-owned", state: "idle" }],
		});
		expect(session.getToolDefinition("lsp_hover")).toBeDefined();
		const snapshot = session.getLspStatus();
		snapshot.configuration.servers.length = 0;
		expect(session.getLspStatus().configuration.servers).toHaveLength(1);
		await session.configureLsp({ enabled: false });
		expect(session.getLspStatus()).toEqual({
			owner: "agent-session",
			enabled: false,
			configuration: { enabled: false, servers: [] },
			servers: [],
		});
		expect((session as unknown as { _lspRuntimeState?: LspRuntimeState })._lspRuntimeState).toBeUndefined();
		expect(session.getToolDefinition("lsp_hover")).toBeUndefined();
		await runtime.dispose();
	});

	it("delegates the deprecated standalone helper to the AgentSession-owned runtime", async () => {
		const cwd = await createTempDir();
		let getStandaloneState: (() => LspRuntimeState) | undefined;
		const runtime = await PiAgent.create({
			cwd,
			agentDir: await createTempDir(),
			lsp: { type: "configuration", configuration: { servers: [testServer({ id: "built-in" })] } },
			resourceLoaderOptions: {
				extensionFactories: [
					(pi) => {
						getStandaloneState = registerLspLifecycleHandlers(pi, {
							configuration: { enabled: true, servers: [testServer({ id: "parallel" })] },
						});
					},
				],
			},
		});
		const session = await runtime.createAgentSession();
		await session.bindExtensions({});
		expect(session.getLspStatus().configuration.servers.map((server) => server.id)).toEqual(["built-in"]);
		const hoverTools = session.getAllTools().filter((tool) => tool.name === "lsp_hover");
		expect(hoverTools).toHaveLength(1);
		expect(hoverTools[0]?.sourceInfo.path).toBe("<builtin:lsp_hover>");
		expect(() => getStandaloneState?.()).toThrow("AgentSession already owns LSP");
		await runtime.dispose();
	});

	it("keeps LSP runtime enablement independent from the tool allowlist", async () => {
		const cwd = await createTempDir();
		const agentDir = await createTempDir();
		const runtime = await PiAgent.create({
			cwd,
			agentDir,
			tools: ["read"],
			lsp: { type: "configuration", configuration: { servers: [testServer({ id: "background" })] } },
		});
		const session = await runtime.createAgentSession();
		expect(session.getLspStatus()).toMatchObject({ enabled: true, servers: [{ serverId: "background" }] });
		expect((session as unknown as { _lspRuntimeState?: LspRuntimeState })._lspRuntimeState).toBeDefined();
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.getToolDefinition("lsp_hover")).toBeUndefined();
		await runtime.dispose();
	});

	it("re-resolves LSP files on reload and replaces the runtime before disposing the old one", async () => {
		const cwd = await createTempDir();
		const agentDir = await createTempDir();
		const configPath = join(cwd, "lsp.json");
		await writeFile(configPath, JSON.stringify({ servers: [testServer({ id: "before-reload" })] }), "utf8");
		const shutdownServerIds: string[][] = [];
		const staleConfigurationErrors: string[] = [];
		const runtime = await PiAgent.create({
			cwd,
			agentDir,
			lsp: { type: "file", path: configPath },
			resourceLoaderOptions: {
				extensionFactories: [
					(pi) => {
						pi.on("session_shutdown", async (event, ctx) => {
							if (event.reason !== "reload") return;
							shutdownServerIds.push(ctx.getLspStatus().configuration.servers.map((server) => server.id));
							try {
								await ctx.configureLsp({ enabled: false });
							} catch (error) {
								staleConfigurationErrors.push(error instanceof Error ? error.message : String(error));
							}
						});
						pi.on("session_start", async (event, ctx) => {
							if (event.reason === "reload") {
								await ctx.configureLsp({ servers: [testServer({ id: "configured-during-reload" })] });
							}
						});
					},
				],
			},
		});
		const session = await runtime.createAgentSession();
		await session.bindExtensions({ shutdownHandler: () => {} });
		const previous = (session as unknown as { _lspRuntimeState?: LspRuntimeState })._lspRuntimeState;
		if (!previous) throw new Error("expected initial LSP runtime");
		await writeFile(configPath, JSON.stringify({ servers: [testServer({ id: "after-reload" })] }), "utf8");
		await session.reload();
		const next = (session as unknown as { _lspRuntimeState?: LspRuntimeState })._lspRuntimeState;
		expect(next).toBeDefined();
		expect(next).not.toBe(previous);
		expect(session.getLspStatus().configuration.servers.map((server) => server.id)).toEqual([
			"configured-during-reload",
		]);
		expect(shutdownServerIds).toEqual([["before-reload"]]);
		expect(staleConfigurationErrors[0]).toContain("stale after session replacement or reload");
		await expect(previous.manager.getClientForFile("fixture.ts")).resolves.toBeUndefined();
		await runtime.dispose();
	});

	it("reports the superseded runner's latest owned LSP runtime during reload shutdown", async () => {
		const cwd = await createTempDir();
		const agentDir = await createTempDir();
		const configPath = join(cwd, "lsp.json");
		await writeFile(configPath, JSON.stringify({ servers: [testServer({ id: "bind-time" })] }), "utf8");
		const shutdownStatuses: LspSessionStatus[] = [];
		const staleConfigurationErrors: string[] = [];
		const runtime = await PiAgent.create({
			cwd,
			agentDir,
			lsp: { type: "file", path: configPath },
			resourceLoaderOptions: {
				extensionFactories: [
					(pi) => {
						pi.on("session_shutdown", async (event, ctx) => {
							if (event.reason !== "reload") return;
							shutdownStatuses.push(ctx.getLspStatus());
							try {
								await ctx.configureLsp({ enabled: false });
							} catch (error) {
								staleConfigurationErrors.push(error instanceof Error ? error.message : String(error));
							}
						});
					},
				],
			},
		});
		const session = await runtime.createAgentSession();
		await session.bindExtensions({ shutdownHandler: () => {} });
		const previousContext = session.extensionRunner.createContext();
		const bindTime = (session as unknown as { _lspRuntimeState?: LspRuntimeState })._lspRuntimeState;
		if (!bindTime) throw new Error("expected bind-time LSP runtime");
		await previousContext.configureLsp({ servers: [testServer({ id: "intermediate" })] });
		await previousContext.configureLsp({ enabled: false });
		await previousContext.configureLsp({ servers: [testServer({ id: "latest-owned" })] });
		const previous = (session as unknown as { _lspRuntimeState?: LspRuntimeState })._lspRuntimeState;
		if (!previous) throw new Error("expected configured LSP runtime");
		expect(previous).not.toBe(bindTime);
		await expect(bindTime.manager.getClientForFile("fixture.ts")).resolves.toBeUndefined();
		await writeFile(configPath, JSON.stringify({ servers: [testServer({ id: "replacement" })] }), "utf8");
		await session.reload();
		const current = (session as unknown as { _lspRuntimeState?: LspRuntimeState })._lspRuntimeState;
		if (!current) throw new Error("expected replacement LSP runtime");
		expect(current).not.toBe(previous);
		expect(shutdownStatuses).toHaveLength(1);
		expect(shutdownStatuses[0]?.configuration.servers.map((server) => server.id)).toEqual(["latest-owned"]);
		expect(shutdownStatuses[0]?.servers.map((server) => server.serverId)).toEqual(["latest-owned"]);
		expect(
			session.extensionRunner
				.createContext()
				.getLspStatus()
				.configuration.servers.map((server) => server.id),
		).toEqual(["replacement"]);
		expect(staleConfigurationErrors[0]).toContain("stale after session replacement or reload");
		expect(() => previousContext.getLspStatus()).toThrow("stale after session replacement or reload");
		expect(() => previousContext.configureLsp({ enabled: false })).toThrow(
			"stale after session replacement or reload",
		);
		await expect(previous.manager.getClientForFile("fixture.ts")).resolves.toBeUndefined();
		await runtime.dispose();
	});

	it("queues detached reload descendants behind later lifecycle transitions", async () => {
		const cwd = await createTempDir();
		let releaseDetached!: () => void;
		const detachedGate = new Promise<void>((resolve) => {
			releaseDetached = resolve;
		});
		let detachedStarted = false;
		let detachedFinished = false;
		let detachedConfiguration: Promise<void> | undefined;
		const runtime = await PiAgent.create({
			cwd,
			agentDir: await createTempDir(),
			lsp: { type: "configuration", configuration: { servers: [testServer({ id: "initial" })] } },
			resourceLoaderOptions: {
				extensionFactories: [
					(pi) => {
						pi.on("session_start", (event, ctx) => {
							if (event.reason !== "reload") return;
							detachedConfiguration = (async () => {
								await detachedGate;
								detachedStarted = true;
								await ctx.configureLsp({ servers: [testServer({ id: "detached" })] });
								detachedFinished = true;
							})();
						});
					},
				],
			},
		});
		const session = await runtime.createAgentSession();
		await session.bindExtensions({ shutdownHandler: () => {} });
		await session.reload();
		const current = (session as unknown as { _lspRuntimeState?: LspRuntimeState })._lspRuntimeState;
		if (!current) throw new Error("expected reloaded runtime");
		let releaseShutdown!: () => void;
		let markShutdownStarted!: () => void;
		const shutdownGate = new Promise<void>((resolve) => {
			releaseShutdown = resolve;
		});
		const shutdownStarted = new Promise<void>((resolve) => {
			markShutdownStarted = resolve;
		});
		const originalShutdown = current.manager.shutdownAll.bind(current.manager);
		current.manager.shutdownAll = async () => {
			markShutdownStarted();
			await shutdownGate;
			await originalShutdown();
		};
		const disable = session.configureLsp({ enabled: false });
		await shutdownStarted;
		releaseDetached();
		await Promise.resolve();
		await Promise.resolve();
		expect(detachedStarted).toBe(true);
		expect(detachedFinished).toBe(false);
		expect(session.getLspStatus().enabled).toBe(false);
		releaseShutdown();
		await Promise.all([disable, detachedConfiguration]);
		expect(detachedFinished).toBe(true);
		expect(session.getLspStatus().configuration.servers.map((server) => server.id)).toEqual(["detached"]);
		await runtime.dispose();
	});

	it("keeps active detached reentrant transitions inside the owning lifecycle operation", async () => {
		const cwd = await createTempDir();
		let markChildShutdownStarted!: () => void;
		let releaseChildShutdown!: () => void;
		const childShutdownStarted = new Promise<void>((resolve) => {
			markChildShutdownStarted = resolve;
		});
		const childShutdownGate = new Promise<void>((resolve) => {
			releaseChildShutdown = resolve;
		});
		let detachedConfiguration: Promise<unknown> | undefined;
		const runtime = await PiAgent.create({
			cwd,
			agentDir: await createTempDir(),
			lsp: { type: "configuration", configuration: { servers: [testServer({ id: "initial" })] } },
			resourceLoaderOptions: {
				extensionFactories: [
					(pi) => {
						pi.on("session_start", (event, ctx) => {
							if (event.reason !== "reload") return;
							const current = (runtime.session as unknown as { _lspRuntimeState?: LspRuntimeState })
								._lspRuntimeState;
							if (!current) throw new Error("expected current runtime during reload callback");
							const originalShutdown = current.manager.shutdownAll.bind(current.manager);
							current.manager.shutdownAll = async () => {
								markChildShutdownStarted();
								await childShutdownGate;
								await originalShutdown();
							};
							detachedConfiguration = ctx.configureLsp({ enabled: false });
						});
					},
				],
			},
		});
		const session = await runtime.createAgentSession();
		await session.bindExtensions({ shutdownHandler: () => {} });
		let reloadFinished = false;
		const reload = session.reload().then(() => {
			reloadFinished = true;
		});
		await childShutdownStarted;
		let laterFinished = false;
		const later = session.configureLsp({ servers: [testServer({ id: "later" })] }).then(() => {
			laterFinished = true;
		});
		await Promise.resolve();
		expect(reloadFinished).toBe(false);
		expect(laterFinished).toBe(false);
		releaseChildShutdown();
		await Promise.all([reload, detachedConfiguration, later]);
		expect(session.getLspStatus().configuration.servers.map((server) => server.id)).toEqual(["later"]);
		await runtime.dispose();
	});

	it("serializes sibling reentrant LSP configurations within a reload lifecycle operation", async () => {
		const cwd = await createTempDir();
		let releaseFirst!: () => void;
		let markFirstStarted!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		let firstConfiguration: Promise<unknown> | undefined;
		let secondConfiguration: Promise<unknown> | undefined;
		let secondFinished = false;
		const runtime = await PiAgent.create({
			cwd,
			agentDir: await createTempDir(),
			lsp: { type: "configuration", configuration: { servers: [testServer({ id: "initial" })] } },
			resourceLoaderOptions: {
				extensionFactories: [
					(pi) => {
						pi.on("session_start", (event, ctx) => {
							if (event.reason !== "reload") return;
							const current = (runtime.session as unknown as { _lspRuntimeState?: LspRuntimeState })
								._lspRuntimeState;
							if (!current) throw new Error("expected current runtime during reload callback");
							const originalSetConfiguration = current.manager.setConfiguration.bind(current.manager);
							current.manager.setConfiguration = async (configuration) => {
								markFirstStarted();
								await firstGate;
								await originalSetConfiguration(configuration);
							};
							firstConfiguration = ctx.configureLsp({ servers: [testServer({ id: "first" })] });
							secondConfiguration = ctx.configureLsp({ enabled: false }).then(() => {
								secondFinished = true;
							});
						});
					},
				],
			},
		});
		const session = await runtime.createAgentSession();
		await session.bindExtensions({ shutdownHandler: () => {} });
		const reload = session.reload();
		await firstStarted;
		await Promise.resolve();
		expect(secondFinished).toBe(false);
		expect(session.getLspStatus().enabled).toBe(true);
		releaseFirst();
		await Promise.all([reload, firstConfiguration, secondConfiguration]);
		expect(secondFinished).toBe(true);
		expect(session.getLspStatus()).toMatchObject({ enabled: false, configuration: { servers: [] }, servers: [] });
		await runtime.dispose();
	});

	it("serializes controlled LSP updates without leaking an intermediate runtime", async () => {
		const cwd = await createTempDir();
		const runtime = await PiAgent.create({
			cwd,
			agentDir: await createTempDir(),
			lsp: { type: "configuration", configuration: { servers: [testServer({ id: "initial" })] } },
		});
		const session = await runtime.createAgentSession();
		const initial = (session as unknown as { _lspRuntimeState?: LspRuntimeState })._lspRuntimeState;
		if (!initial) throw new Error("expected initial runtime");
		let releaseShutdown!: () => void;
		let shutdownStarted!: () => void;
		const shutdownGate = new Promise<void>((resolve) => {
			releaseShutdown = resolve;
		});
		const sawShutdown = new Promise<void>((resolve) => {
			shutdownStarted = resolve;
		});
		const originalShutdown = initial.manager.shutdownAll.bind(initial.manager);
		initial.manager.shutdownAll = async () => {
			shutdownStarted();
			await shutdownGate;
			await originalShutdown();
		};
		const disable = session.configureLsp({ enabled: false });
		await sawShutdown;
		const enable = session.configureLsp({ servers: [testServer({ id: "replacement" })] });
		await Promise.resolve();
		expect(session.getLspStatus().enabled).toBe(false);
		releaseShutdown();
		await Promise.all([disable, enable]);
		expect(session.getLspStatus()).toMatchObject({ enabled: true, servers: [{ serverId: "replacement" }] });
		await runtime.dispose();
	});

	it("preserves SDK LSP options and factories across cross-cwd session replacement", async () => {
		const firstCwd = await createTempDir();
		const secondCwd = await createTempDir();
		const agentDir = await createTempDir();
		let factoryCalls = 0;
		const runtime = await PiAgent.create({
			cwd: firstCwd,
			agentDir,
			lsp: {
				type: "configuration",
				configuration: {
					servers: [testServer({ id: "preserved", transport: { type: "connection", id: "host" } })],
				},
			},
			lspConnectionFactories: {
				host: async () => {
					factoryCalls++;
					throw new Error("expected connection failure");
				},
			},
		});
		const firstSession = await runtime.createAgentSession();
		const firstHover = firstSession.getToolDefinition("lsp_hover");
		if (!firstHover) throw new Error("expected first hover tool");
		await firstHover.execute(
			"first",
			{ path: "fixture.ts", line: 1, character: 1 },
			undefined,
			undefined,
			createContext(firstCwd),
		);
		expect(firstSession.getLspStatus().servers[0]?.workspaceRoot).toBe(firstCwd);
		const targetSession = new LocalSessionManager({ cwd: secondCwd }).create();
		const targetReference = targetSession.getSessionReference();
		if (!targetReference) throw new Error("expected target session reference");
		await runtime.switchSession(targetReference, { cwdOverride: secondCwd });
		const secondHover = runtime.session.getToolDefinition("lsp_hover");
		if (!secondHover) throw new Error("expected replacement hover tool");
		await secondHover.execute(
			"second",
			{ path: "fixture.ts", line: 1, character: 1 },
			undefined,
			undefined,
			createContext(secondCwd),
		);
		expect(runtime.session.getLspStatus().configuration.servers[0]?.id).toBe("preserved");
		expect(runtime.session.getLspStatus().servers[0]?.workspaceRoot).toBe(secondCwd);
		expect(factoryCalls).toBe(2);
		await runtime.dispose();
	});

	it("replaces standalone runtimes safely and rejects the current remote backend before startup", async () => {
		expect(registerLspLifecycleHandlers).toBe(registerStandaloneLspLifecycleHandlers);
		const cwd = await createTempDir();
		const tools = new Map<string, ToolDefinition>();
		let registrationCount = 0;
		const unregistered: string[] = [];
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>();
		const created: FakeLspClient[] = [];
		const api = {
			registerTool(tool: ToolDefinition) {
				registrationCount++;
				tools.set(tool.name, tool);
			},
			unregisterTool(name: string) {
				unregistered.push(name);
				return tools.delete(name);
			},
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const getState = registerLspLifecycleHandlers(api, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => {
				const client = new FakeLspClient(options);
				created.push(client);
				return client;
			},
		});
		const duplicateGetState = registerLspLifecycleHandlers(api, {
			configuration: { enabled: true, servers: [testServer({ id: "ignored-duplicate" })] },
		});
		expect(duplicateGetState).toBe(getState);
		const localContext = createContext(cwd);
		await handlers.get("session_start")?.({}, localContext);
		await getState().manager.getClientForFile("fixture.ts");
		const firstClient = created[0];
		if (!firstClient) throw new Error("expected first standalone client");

		class RemoteOperations extends LocalToolOperations {
			override getBackendInfo(): ToolBackendInfo {
				return remoteBackendInfo(this.cwd, "example");
			}
		}
		const remoteContext = {
			cwd,
			toolOperations: new RemoteOperations(cwd),
			getLspStatus: () => ({
				owner: "standalone" as const,
				enabled: false,
				configuration: { enabled: false, servers: [] },
				servers: [],
			}),
		} as unknown as ExtensionContext;
		await handlers.get("session_start")?.({}, remoteContext);
		expect(firstClient.isDisposed).toBe(true);
		expect(registrationCount).toBe(6);
		expect(tools.size).toBe(6);
		const hoverTool = tools.get("lsp_hover");
		if (!hoverTool) throw new Error("expected standalone hover tool");
		const result = await hoverTool.execute(
			"hover",
			{ path: "fixture.ts", line: 1, character: 1 },
			undefined,
			undefined,
			remoteContext,
		);
		expect(text(result)).toContain("requires explicit LSP pathMappings");
		expect(created).toHaveLength(1);
		const agentSessionContext = {
			...remoteContext,
			getLspStatus: () => ({
				owner: "agent-session" as const,
				enabled: true,
				configuration: { enabled: true, servers: [testServer({ id: "agent-owned" })] },
				servers: [],
			}),
		} as unknown as ExtensionContext;
		await handlers.get("session_start")?.({}, agentSessionContext);
		expect(tools.size).toBe(0);
		expect(unregistered).toEqual([
			"lsp_diagnostics",
			"lsp_hover",
			"lsp_definition",
			"lsp_references",
			"lsp_rename",
			"lsp_code_actions",
		]);
		expect(registrationCount).toBe(6);
		expect(() => getState()).toThrow("AgentSession already owns LSP");
		await handlers.get("session_shutdown")?.({}, agentSessionContext);
	});
});

describe("LSP tool formatting", () => {
	// pi-ignore noExcessiveCollectionIterations: The schema matrix is fixed at 30 primary position checks and 6 code-action range checks.
	function validatePositiveIntegerPositionSchemas(): void {
		const state = (): LspRuntimeState => {
			throw new Error("schema validation must not access runtime state");
		};
		const toolsAndInputs = [
			[createLspHoverTool(state), { path: "fixture.ts", line: 1, character: 1 }],
			[createLspDefinitionTool(state), { path: "fixture.ts", line: 1, character: 1 }],
			[createLspReferencesTool(state), { path: "fixture.ts", line: 1, character: 1 }],
			[createLspRenameTool(state), { path: "fixture.ts", line: 1, character: 1, newName: "renamed" }],
			[createLspCodeActionsTool(state), { path: "fixture.ts", line: 1, character: 1, endLine: 2, endCharacter: 3 }],
		] as const;

		for (const [tool, validInput] of toolsAndInputs) {
			expect(Value.Check(tool.parameters, validInput), `${tool.name} accepts valid positions`).toBe(true);
			for (const invalidValue of [0, -1, 1.5]) {
				expect(
					Value.Check(tool.parameters, { ...validInput, line: invalidValue }),
					`${tool.name} rejects line ${invalidValue}`,
				).toBe(false);
				expect(
					Value.Check(tool.parameters, { ...validInput, character: invalidValue }),
					`${tool.name} rejects character ${invalidValue}`,
				).toBe(false);
			}
		}

		const codeActions = toolsAndInputs.at(-1);
		if (!codeActions) throw new Error("expected code action schema");
		for (const field of ["endLine", "endCharacter"] as const) {
			for (const invalidValue of [0, -1, 1.5]) {
				expect(
					Value.Check(codeActions[0].parameters, { ...codeActions[1], [field]: invalidValue }),
					`lsp_code_actions rejects ${field} ${invalidValue}`,
				).toBe(false);
			}
		}
	}
	it(
		"requires positive integer positions in every position-based tool schema",
		validatePositiveIntegerPositionSchemas,
	);

	it("returns diagnostics from the cache and exposes schema", async () => {
		const { state, client } = await createStateWithClient();
		const target = await state.manager.getPrimaryTarget("fixture.ts");
		if (!target) throw new Error("expected route target");
		const uri = target.serverUri;
		client?.setDiagnostics(uri, [diagnostic("broken")]);
		const tool = createLspDiagnosticsTool(() => state);

		expect(tool.parameters.properties).toHaveProperty("path");
		const result = await tool.execute(
			"tool",
			{ path: "fixture.ts" },
			undefined,
			undefined,
			createContext(state.manager.cwd),
		);

		expect(text(result)).toContain("fixture.ts:2:3 error: broken");
		expect(result.details).toMatchObject({ count: 1, errors: 1, warnings: 0, files: 1 });
		const theme = { fg: (_color: string, value: string) => value };
		const renderOptions = { isPartial: false, expanded: false, showImages: true, isError: false };
		const collapsed = tool.renderResult?.(result, renderOptions, theme as never, {} as never);
		const expanded = tool.renderResult?.(result, { ...renderOptions, expanded: true }, theme as never, {} as never);
		expect(collapsed?.render(120).join("\n")).toContain("1 diagnostic(s)");
		expect(collapsed?.render(120).join("\n")).not.toContain("broken");
		expect(expanded?.render(120).join("\n")).toContain("fixture.ts:2:3 error: broken");
	});

	it("passes every diagnostic overlapping a code-action selection range", async () => {
		const { state, client } = await createStateWithClient();
		const target = await state.manager.getPrimaryTarget("fixture.ts");
		if (!target || !client) throw new Error("expected route target and client");
		client.setDiagnostics(target.serverUri, [diagnostic("overlapping diagnostic")]);
		let contextDiagnostics: Diagnostic[] | undefined;
		client.setResponseHandler("textDocument/codeAction", (params) => {
			contextDiagnostics = (params as CodeActionParams).context.diagnostics;
			return [];
		});

		await createLspCodeActionsTool(() => state).execute(
			"actions",
			{ path: "fixture.ts", line: 1, character: 1, endLine: 3, endCharacter: 1 },
			undefined,
			undefined,
			createContext(state.manager.cwd),
		);

		expect(contextDiagnostics).toEqual([expect.objectContaining({ message: "overlapping diagnostic" })]);
	});

	it("formats hover, definition, and references compactly", async () => {
		const { state, client } = await createStateWithClient({
			"textDocument/hover": { contents: { kind: "markdown", value: "```ts\nconst value: number\n```" } },
		});
		const target = await state.manager.getPrimaryTarget("fixture.ts");
		if (!target) throw new Error("expected route target");
		const definitionResponse = {
			uri: target.serverUri,
			range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
		};
		const referencesResponse = Array.from({ length: 82 }, (_, index) => ({
			uri: target.serverUri,
			range: { start: { line: index, character: 1 }, end: { line: index, character: 6 } },
		}));
		client?.setResponse("textDocument/definition", definitionResponse);
		client?.setResponse("textDocument/references", referencesResponse);

		const ctx = createContext(state.manager.cwd);
		const hover = await createLspHoverTool(() => state).execute(
			"hover",
			{ path: "fixture.ts", line: 2, character: 1 },
			undefined,
			undefined,
			ctx,
		);
		const definition = await createLspDefinitionTool(() => state).execute(
			"definition",
			{ path: "fixture.ts", line: 2, character: 1 },
			undefined,
			undefined,
			ctx,
		);
		const references = await createLspReferencesTool(() => state).execute(
			"references",
			{ path: "fixture.ts", line: 2, character: 1 },
			undefined,
			undefined,
			ctx,
		);

		expect(text(hover)).toContain("const value: number");
		expect(text(definition)).toContain("Definition: fixture.ts:1:7");
		expect(text(references)).toContain("82 reference(s)");
		expect(text(references)).toContain("[Showing 80 of 82 references.]");
	});

	it("canonicalizes LocationLink target selections with equivalent Location results", async () => {
		const { cwd, state, clients } = await createMultiToolState(
			[testServer({ id: "location" }), testServer({ id: "link" })],
			(client) => {
				const uri = pathToFileURL(join(client.rootDir, "fixture.ts")).toString();
				const selection = { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } };
				client.setResponse(
					"textDocument/definition",
					client.serverId === "location"
						? { uri, range: selection }
						: [
								{
									targetUri: uri,
									targetRange: { start: { line: 0, character: 0 }, end: { line: 8, character: 0 } },
									targetSelectionRange: selection,
								},
							],
				);
			},
		);
		const result = await createLspDefinitionTool(() => state).execute(
			"definition",
			{ path: "fixture.ts", line: 1, character: 1 },
			undefined,
			undefined,
			createContext(cwd),
		);
		expect(result.details).toMatchObject({ count: 1 });
		expect(text(result)).toContain("[location, link] fixture.ts:3:5");
		expect(clients.size).toBe(2);
		await state.manager.shutdownAll();
	});
	it("formats rename and code action edit previews without applying changes", async () => {
		const { state, client } = await createStateWithClient();
		const target = await state.manager.getPrimaryTarget("fixture.ts");
		if (!target) throw new Error("expected route target");
		const uri = target.serverUri;
		client?.setResponse("textDocument/rename", {
			changes: {
				[uri]: [
					{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "renamed" },
				],
			},
		});
		client?.setResponse("textDocument/codeAction", [
			{
				title: "Rename value",
				kind: "refactor.rename",
				isPreferred: true,
				edit: {
					changes: {
						[uri]: [
							{
								range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
								newText: "renamed",
							},
						],
					},
				},
			},
			{ title: "Run literal action", command: { title: "Run", command: "literal.run" } },
			{ title: "Run legacy command", command: "legacy.run" },
		]);
		const ctx = createContext(state.manager.cwd);

		const rename = await createLspRenameTool(() => state).execute(
			"rename",
			{ path: "fixture.ts", line: 1, character: 7, newName: "renamed" },
			undefined,
			undefined,
			ctx,
		);
		const actions = await createLspCodeActionsTool(() => state).execute(
			"actions",
			{ path: "fixture.ts", line: 1, character: 7 },
			undefined,
			undefined,
			ctx,
		);

		expect(text(rename)).toContain("No changes were applied.");
		expect(text(rename)).toContain("fixture.ts:");
		expect(text(rename)).toContain('1:7-1:12 -> "renamed"');
		expect(text(actions)).toContain("Rename value [refactor.rename] preferred");
		expect(text(actions)).toContain("Run literal action");
		expect(text(actions)).not.toContain("Run literal action [command-only:");
		expect(text(actions)).toContain("Run legacy command [command-only: legacy.run]");
		expect(text(actions)).toContain("No changes were applied.");
		expect(text(actions)).toContain('1:7-1:12 -> "renamed"');
	});

	it("validates rename document versions without conflating per-client counters", async () => {
		const cwd = await createTempDir();
		const filePath = join(cwd, "fixture.ts");
		await writeFile(filePath, "one\n", "utf8");
		const clients = new Map<string, FakeLspClient>();
		const manager = new LspManager(cwd, {
			configuration: {
				enabled: true,
				servers: [testServer({ id: "a", priority: 20 }), testServer({ id: "b", priority: 10 })],
			},
			createClient: (options) => {
				const client = new FakeLspClient(options);
				clients.set(options.serverId, client);
				return client;
			},
		});
		const fileSync = new LspFileSync(manager);
		const state = { manager, fileSync };
		const ctx = createContext(cwd);
		const operations = ctx.toolOperations;
		await manager.setToolOperations(operations);
		const targets = (await manager.resolveTargets(filePath)).targets;
		const targetA = targets.find((target) => target.serverId === "a");
		if (!targetA) throw new Error("expected primary target");
		await manager.getClientForTarget(targetA);
		await fileSync.handleFileRead(filePath, operations);
		await writeFile(filePath, "two\n", "utf8");
		await fileSync.handleFileRead(filePath, operations);
		const editForVersion = (uri: string, version: number) => ({
			documentChanges: [
				{
					textDocument: { uri, version },
					edits: [
						{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "renamed" },
					],
				},
			],
		});
		clients.get("a")?.setResponse("textDocument/rename", editForVersion(targetA.serverUri, 2));
		const targetB = targets.find((target) => target.serverId === "b");
		if (!targetB) throw new Error("expected secondary target");
		const originalCreate = manager.getClientForTarget(targetB);
		const clientB = await originalCreate;
		if (!(clientB instanceof FakeLspClient)) throw new Error("expected secondary client");
		clientB.setResponse("textDocument/rename", editForVersion(targetB.serverUri, 1));
		const valid = await createLspRenameTool(() => state).execute(
			"rename",
			{ path: "fixture.ts", line: 1, character: 1, newName: "renamed" },
			undefined,
			undefined,
			ctx,
		);
		expect(valid.details).not.toHaveProperty("conflict");
		expect(text(valid)).toContain("Selected provider(s): a, b");
		expect(text(valid)).toContain("fixture.ts (document version 2):");

		clients.get("a")?.setResponse("textDocument/rename", editForVersion(targetA.serverUri, 1));
		clients.get("b")?.setResponse("textDocument/rename", null);
		const stale = await createLspRenameTool(() => state).execute(
			"rename",
			{ path: "fixture.ts", line: 1, character: 1, newName: "stale" },
			undefined,
			undefined,
			ctx,
		);
		expect(stale.details).toMatchObject({ conflict: true });
		expect(text(stale)).toContain("stale document version 1; tracked version is 2");

		const relatedUri = pathToFileURL(join(cwd, "related.ts")).toString();
		clients.get("a")?.setResponse("textDocument/rename", editForVersion(relatedUri, 1));
		const unknown = await createLspRenameTool(() => state).execute(
			"rename",
			{ path: "fixture.ts", line: 1, character: 1, newName: "unknown" },
			undefined,
			undefined,
			ctx,
		);
		expect(unknown.details).toMatchObject({ conflict: true });
		expect(text(unknown)).toContain("unknown tracked version for related.ts");

		clients.get("a")?.setResponse("textDocument/rename", null);
		clients.get("b")?.setResponse("textDocument/rename", editForVersion(targetB.serverUri, 1));
		const emptyConflict = await createLspRenameTool(() => state).execute(
			"rename",
			{ path: "fixture.ts", line: 1, character: 1, newName: "empty-conflict" },
			undefined,
			undefined,
			ctx,
		);
		expect(emptyConflict.details).toMatchObject({ conflict: true });
		expect(text(emptyConflict)).toContain("[a] no edits");
		expect(text(emptyConflict)).toContain("[b] 1 edit(s)");
		await manager.shutdownAll();
	});
	it("skips unsupported providers for every tool and uses the next capable server", async () => {
		const unsupported = testServer({
			id: "unsupported",
			priority: 20,
			features: { diagnostics: false },
		});
		const capable = testServer({ id: "capable", priority: 10 });
		const { cwd, state, clients } = await createMultiToolState([unsupported, capable], (client) => {
			if (client.serverId === "unsupported") {
				client.setCapabilities({ textDocumentSync: TextDocumentSyncKind.Full });
			} else {
				client.setResponse("textDocument/hover", { contents: "capable hover" });
			}
		});
		const ctx = createContext(cwd);
		const hover = await createLspHoverTool(() => state).execute(
			"hover",
			{ path: "fixture.ts", line: 1, character: 1 },
			undefined,
			undefined,
			ctx,
		);
		const capableClient = clients.get("capable");
		const unsupportedClient = clients.get("unsupported");
		if (!capableClient || !unsupportedClient) throw new Error("expected both clients");
		const target = (await state.manager.resolveTargets("fixture.ts")).targets.find(
			(candidate) => candidate.serverId === "capable",
		);
		if (!target) throw new Error("expected capable target");
		const location = {
			uri: target.serverUri,
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
		};
		capableClient.setResponse("textDocument/definition", location);
		capableClient.setResponse("textDocument/references", [location]);
		capableClient.setResponse("textDocument/rename", {
			changes: { [target.serverUri]: [{ range: location.range, newText: "next" }] },
		});
		capableClient.setResponse("textDocument/codeAction", [{ title: "Capable action", kind: "quickfix" }]);
		capableClient.setDiagnostics(target.serverUri, [diagnostic("capable diagnostic")]);
		const definition = await createLspDefinitionTool(() => state).execute(
			"definition",
			{ path: "fixture.ts", line: 1, character: 1 },
			undefined,
			undefined,
			ctx,
		);
		const references = await createLspReferencesTool(() => state).execute(
			"references",
			{ path: "fixture.ts", line: 1, character: 1 },
			undefined,
			undefined,
			ctx,
		);
		const rename = await createLspRenameTool(() => state).execute(
			"rename",
			{ path: "fixture.ts", line: 1, character: 1, newName: "next" },
			undefined,
			undefined,
			ctx,
		);
		const actions = await createLspCodeActionsTool(() => state).execute(
			"actions",
			{ path: "fixture.ts", line: 1, character: 1 },
			undefined,
			undefined,
			ctx,
		);
		const diagnostics = await createLspDiagnosticsTool(() => state).execute(
			"diagnostics",
			{ path: "fixture.ts" },
			undefined,
			undefined,
			ctx,
		);
		expect(text(hover)).toContain("capable hover");
		expect(text(definition)).toContain("fixture.ts:1:1");
		expect(text(references)).toContain("1 reference(s)");
		expect(text(rename)).toContain('Rename preview for "next"');
		expect(text(actions)).toContain("Capable action");
		expect(text(diagnostics)).toContain("capable diagnostic");
		expect(unsupportedClient.requests).toEqual([]);
		expect(text(hover)).toContain("unsupported: server does not advertise hover capability");
		expect(text(diagnostics)).toContain("unsupported: diagnostics is disabled by configuration");
		await state.manager.shutdownAll();
	});

	it("reports a useful reason when no matching server supports each tool", async () => {
		const { cwd, state, clients } = await createMultiToolState(
			[testServer({ id: "unsupported", features: { diagnostics: false } })],
			(client) => client.setCapabilities({ textDocumentSync: TextDocumentSyncKind.Full }),
		);
		const ctx = createContext(cwd);
		const results = await Promise.all([
			createLspHoverTool(() => state).execute(
				"hover",
				{ path: "fixture.ts", line: 1, character: 1 },
				undefined,
				undefined,
				ctx,
			),
			createLspDefinitionTool(() => state).execute(
				"definition",
				{ path: "fixture.ts", line: 1, character: 1 },
				undefined,
				undefined,
				ctx,
			),
			createLspReferencesTool(() => state).execute(
				"references",
				{ path: "fixture.ts", line: 1, character: 1 },
				undefined,
				undefined,
				ctx,
			),
			createLspRenameTool(() => state).execute(
				"rename",
				{ path: "fixture.ts", line: 1, character: 1, newName: "next" },
				undefined,
				undefined,
				ctx,
			),
			createLspCodeActionsTool(() => state).execute(
				"actions",
				{ path: "fixture.ts", line: 1, character: 1 },
				undefined,
				undefined,
				ctx,
			),
			createLspDiagnosticsTool(() => state).execute(
				"diagnostics",
				{ path: "fixture.ts" },
				undefined,
				undefined,
				ctx,
			),
		]);
		for (const result of results) expect(text(result)).toContain("No capable LSP server is available");
		expect(clients.get("unsupported")?.requests).toEqual([]);
		await state.manager.shutdownAll();
	});

	it("deduplicates and attributes aggregate results while preserving partial successes", async () => {
		const servers = [
			testServer({ id: "a", priority: 30 }),
			testServer({ id: "b", priority: 20 }),
			testServer({ id: "failing", priority: 10 }),
		];
		const { cwd, state, clients } = await createMultiToolState(servers, (client) => {
			const uri = new URL(`file://${join(client.rootDir, "fixture.ts")}`).toString();
			const shared = { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } };
			if (client.serverId === "failing") {
				client.setResponse("textDocument/definition", new Error("definition unavailable"));
				client.setResponse("textDocument/references", new Error("references unavailable"));
				client.setResponse("textDocument/codeAction", new Error("actions unavailable"));
				return;
			}
			client.setResponse(
				"textDocument/definition",
				client.serverId === "a"
					? [shared]
					: [shared, { ...shared, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } }],
			);
			client.setResponse("textDocument/references", [shared]);
			client.setResponse("textDocument/codeAction", [
				{ title: "Shared fix", kind: "quickfix" },
				...(client.serverId === "b" ? [{ title: "B-only fix", kind: "refactor" }] : []),
			]);
			client.setDiagnostics(uri, [diagnostic("shared diagnostic")]);
		});
		const ctx = createContext(cwd);
		const definition = await createLspDefinitionTool(() => state).execute(
			"definition",
			{ path: "fixture.ts", line: 1, character: 1 },
			undefined,
			undefined,
			ctx,
		);
		const references = await createLspReferencesTool(() => state).execute(
			"references",
			{ path: "fixture.ts", line: 1, character: 1 },
			undefined,
			undefined,
			ctx,
		);
		const actions = await createLspCodeActionsTool(() => state).execute(
			"actions",
			{ path: "fixture.ts", line: 1, character: 1 },
			undefined,
			undefined,
			ctx,
		);
		const diagnostics = await createLspDiagnosticsTool(() => state).execute(
			"diagnostics",
			{ path: "fixture.ts" },
			undefined,
			undefined,
			ctx,
		);
		expect(definition.details).toMatchObject({ count: 2 });
		expect(text(definition)).toContain("[a, b] fixture.ts:1:1");
		expect(text(definition)).toContain("[b] fixture.ts:2:1");
		expect(text(definition)).toContain("failing: definition unavailable");
		expect(references.details).toMatchObject({ count: 1 });
		expect(text(references)).toContain("[a, b] fixture.ts:1:1");
		expect(text(references)).toContain("failing: references unavailable");
		expect(actions.details).toMatchObject({ count: 2 });
		expect(text(actions)).toContain("[a, b] Shared fix");
		expect(text(actions)).toContain("[b] B-only fix");
		expect(text(actions)).toContain("failing: actions unavailable");
		expect(diagnostics.details).toMatchObject({ count: 1 });
		expect(text(diagnostics)).toContain("{LSP: a, b}");
		const wildcard = await createLspDiagnosticsTool(() => state).execute(
			"workspace",
			{ path: "*" },
			undefined,
			undefined,
			ctx,
		);
		expect(wildcard.details).toMatchObject({ count: 1 });
		expect(text(wildcard)).toContain("server=a root=");
		expect(text(wildcard)).toContain("server=b root=");
		expect(clients.size).toBe(3);
		await state.manager.shutdownAll();
	});

	it("keeps priority order when aggregate responses complete out of order", async () => {
		const { cwd, state } = await createMultiToolState(
			[testServer({ id: "slow-primary", priority: 20 }), testServer({ id: "fast-secondary", priority: 10 })],
			(client) => {
				client.setResponseHandler("textDocument/definition", async () => {
					if (client.serverId === "slow-primary") await new Promise((resolve) => setTimeout(resolve, 20));
					return {
						uri: pathToFileURL(join(client.rootDir, "fixture.ts")).toString(),
						range: {
							start: { line: client.serverId === "slow-primary" ? 0 : 1, character: 0 },
							end: { line: client.serverId === "slow-primary" ? 0 : 1, character: 1 },
						},
					};
				});
				client.setResponseHandler("textDocument/codeAction", async () => {
					if (client.serverId === "slow-primary") await new Promise((resolve) => setTimeout(resolve, 20));
					return [{ title: `${client.serverId} action`, kind: "quickfix" }];
				});
				client.setResponseHandler("textDocument/rename", async () => {
					if (client.serverId === "slow-primary") await new Promise((resolve) => setTimeout(resolve, 20));
					const uri = pathToFileURL(join(client.rootDir, "fixture.ts")).toString();
					return {
						changes: {
							[uri]: [
								{
									range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
									newText: "renamed",
								},
							],
						},
					};
				});
			},
		);
		const ctx = createContext(cwd);
		const result = await createLspDefinitionTool(() => state).execute(
			"definition",
			{ path: "fixture.ts", line: 1, character: 1 },
			undefined,
			undefined,
			ctx,
		);
		const output = text(result);
		expect(output.indexOf("[slow-primary]")).toBeLessThan(output.indexOf("[fast-secondary]"));
		const actions = await createLspCodeActionsTool(() => state).execute(
			"actions",
			{ path: "fixture.ts", line: 1, character: 1 },
			undefined,
			undefined,
			ctx,
		);
		expect(text(actions).indexOf("slow-primary action")).toBeLessThan(text(actions).indexOf("fast-secondary action"));
		const rename = await createLspRenameTool(() => state).execute(
			"rename",
			{ path: "fixture.ts", line: 1, character: 1, newName: "renamed" },
			undefined,
			undefined,
			ctx,
		);
		expect(text(rename)).toContain("Selected provider(s): slow-primary, fast-secondary");
		await state.manager.shutdownAll();
	});

	it("normalizes mapped diagnostic related information and rename resource operations", async () => {
		const cwd = await createTempDir();
		await writeFile(join(cwd, "fixture.ts"), "const value = 1;\n", "utf8");
		const servers = [
			testServer({
				id: "remote-a",
				pathMappings: [{ agentRoot: cwd, serverRootUri: "file:///remote/a" }],
			}),
			testServer({
				id: "remote-b",
				pathMappings: [{ agentRoot: cwd, serverRootUri: "file:///remote/b" }],
			}),
		];
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers },
			createClient: (options) => {
				const client = new FakeLspClient(options);
				const root = options.serverId === "remote-a" ? "file:///remote/a" : "file:///remote/b";
				client.setDiagnostics(`${root}/fixture.ts`, [
					{
						...diagnostic("mapped diagnostic"),
						relatedInformation: [
							{
								message: "related",
								location: {
									uri: `${root}/related.ts`,
									range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
								},
							},
						],
					},
				]);
				client.setResponse("textDocument/rename", {
					documentChanges: [
						{ kind: "create", uri: `${root}/generated.ts` },
						{ kind: "rename", oldUri: `${root}/fixture.ts`, newUri: `${root}/renamed.ts` },
						{ kind: "delete", uri: `${root}/obsolete.ts` },
					],
				});
				return client;
			},
		});
		const state = { manager, fileSync: new LspFileSync(manager) };
		const ctx = createContext(cwd);
		const diagnostics = await createLspDiagnosticsTool(() => state).execute(
			"diagnostics",
			{ path: "fixture.ts" },
			undefined,
			undefined,
			ctx,
		);
		const rename = await createLspRenameTool(() => state).execute(
			"rename",
			{ path: "fixture.ts", line: 1, character: 1, newName: "renamed" },
			undefined,
			undefined,
			ctx,
		);
		expect(diagnostics.details).toMatchObject({ count: 1 });
		expect(text(diagnostics)).toContain("{LSP: remote-a, remote-b}");
		expect(rename.details).not.toHaveProperty("conflict");
		expect(text(rename)).toContain("Selected provider(s): remote-a, remote-b");
		expect(text(rename)).toContain("[workspace create: generated.ts]");
		expect(text(rename)).toContain("[workspace rename: fixture.ts -> renamed.ts]");
		expect(text(rename)).toContain("[workspace delete: obsolete.ts]");
		await manager.shutdownAll();
	});

	it("attributes deduplicated wildcard diagnostics to each server workspace instance", async () => {
		const cwd = await createTempDir();
		const markerPaths = new Set([join(cwd, "a", "root.marker"), join(cwd, "b", "root.marker")]);
		const clients: FakeLspClient[] = [];
		const manager = new LspManager(cwd, {
			configuration: {
				enabled: true,
				servers: [testServer({ workspace: { type: "markers", markers: ["root.marker"], fallback: "none" } })],
			},
			pathExists: async (path) => markerPaths.has(path),
			createClient: (options) => {
				const client = new FakeLspClient(options);
				clients.push(client);
				return client;
			},
		});
		await manager.getClientForFile(join(cwd, "a", "first.ts"));
		await manager.getClientForFile(join(cwd, "b", "second.ts"));
		const sharedUri = pathToFileURL(join(cwd, "shared.ts")).toString();
		for (const client of clients) client.setDiagnostics(sharedUri, [diagnostic("shared instance diagnostic")]);
		const state = { manager, fileSync: new LspFileSync(manager) };
		const wildcard = await createLspDiagnosticsTool(() => state).execute(
			"workspace",
			{ path: "*" },
			undefined,
			undefined,
			createContext(cwd),
		);
		expect(wildcard.details).toMatchObject({ count: 1 });
		expect(text(wildcard)).toContain(`root=${join(cwd, "a")}`);
		expect(text(wildcard)).toContain(`root=${join(cwd, "b")}`);
		expect(text(wildcard).match(/server=typescript/g)).toHaveLength(2);
		await manager.shutdownAll();
	});

	it("orders wildcard providers by configuration and renders unavailable separately from clean", async () => {
		const cwd = await createTempDir();
		const clients = new Map<string, FakeLspClient>();
		const manager = new LspManager(cwd, {
			configuration: {
				enabled: true,
				servers: [testServer({ id: "high", priority: 20 }), testServer({ id: "low", priority: 10 })],
			},
			createClient: (options) => {
				const client = new FakeLspClient(options);
				clients.set(options.serverId, client);
				return client;
			},
		});
		const targets = (await manager.resolveTargets("fixture.ts")).targets;
		const high = targets.find((target) => target.serverId === "high");
		const low = targets.find((target) => target.serverId === "low");
		if (!high || !low) throw new Error("expected wildcard targets");
		await manager.getClientForTarget(low);
		await manager.getClientForTarget(high);
		const uri = pathToFileURL(join(cwd, "fixture.ts")).toString();
		for (const client of clients.values()) client.setDiagnostics(uri, [diagnostic("ordered")]);
		const state = { manager, fileSync: new LspFileSync(manager) };
		const tool = createLspDiagnosticsTool(() => state);
		const ctx = createContext(cwd);
		const wildcard = await tool.execute("workspace", { path: "*" }, undefined, undefined, ctx);
		expect(text(wildcard)).toContain(`{LSP: server=high root=${cwd}, server=low root=${cwd}}`);

		const unavailableManager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => new FakeLspClient(options),
		});
		const unavailableTool = createLspDiagnosticsTool(() => ({
			manager: unavailableManager,
			fileSync: new LspFileSync(unavailableManager),
		}));
		const unavailable = await unavailableTool.execute(
			"workspace",
			{ path: "*" },
			undefined,
			undefined,
			createContext(cwd),
		);
		expect(unavailable.details).toMatchObject({ count: 0, unavailable: true });
		expect(text(unavailable)).toContain("No capable running LSP server");
		const renderOptions = { isPartial: false, expanded: false, showImages: true, isError: false };
		const theme = { fg: (color: string, value: string) => `[${color}]${value}` };
		const unavailableRender = unavailableTool.renderResult?.(unavailable, renderOptions, theme as never, {} as never);
		expect(unavailableRender?.render(80).join("\n")).toContain("[error]LSP unavailable");

		for (const client of clients.values()) client.setDiagnostics(uri, []);
		const clean = await tool.execute("workspace", { path: "*" }, undefined, undefined, ctx);
		expect(clean.details).toMatchObject({ count: 0 });
		expect(clean.details).not.toHaveProperty("unavailable");
		const cleanRender = tool.renderResult?.(clean, renderOptions, theme as never, {} as never);
		expect(cleanRender?.render(80).join("\n")).toContain("[success]No diagnostics");
		await unavailableManager.shutdownAll();
		await manager.shutdownAll();
	});
	it("propagates cancellation without falling back to lower-priority servers", async () => {
		const controller = new AbortController();
		const { cwd, state, clients } = await createMultiToolState(
			[testServer({ id: "primary", priority: 20 }), testServer({ id: "secondary", priority: 10 })],
			(client) => {
				if (client.serverId === "primary") {
					client.setResponseHandler(
						"textDocument/hover",
						(_params, signal) =>
							new Promise((_resolve, reject) => {
								if (signal?.aborted) {
									reject(new Error("hover aborted"));
									return;
								}
								signal?.addEventListener("abort", () => reject(new Error("hover aborted")), { once: true });
							}),
					);
				} else {
					client.setResponse("textDocument/hover", { contents: "must not be returned" });
				}
			},
		);
		const hover = createLspHoverTool(() => state).execute(
			"hover",
			{ path: "fixture.ts", line: 1, character: 1 },
			controller.signal,
			undefined,
			createContext(cwd),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort();
		await expect(hover).rejects.toThrow("aborted");
		expect(clients.get("secondary")?.requests.filter((request) => request.method === "textDocument/hover")).toEqual(
			[],
		);

		const diagnosticsController = new AbortController();
		const diagnostics = createLspDiagnosticsTool(() => state).execute(
			"diagnostics",
			{ path: "fixture.ts" },
			diagnosticsController.signal,
			undefined,
			createContext(cwd),
		);
		diagnosticsController.abort();
		await expect(diagnostics).rejects.toThrow("aborted");
		await state.manager.shutdownAll();
	});

	it("propagates cancellation while resolving an unavailable explanation", async () => {
		const cwd = await createTempDir();
		const manager = new LspManager(cwd, {
			configuration: {
				enabled: true,
				servers: [testServer({ selectors: [{ languageId: "javascript", pattern: "**/*.js" }] })],
			},
			createClient: (options) => new FakeLspClient(options),
		});
		let markUnavailableStarted!: () => void;
		const unavailableStarted = new Promise<void>((resolve) => {
			markUnavailableStarted = resolve;
		});
		let receivedSignal: AbortSignal | undefined;
		manager.getUnavailableReason = async (_path, signal) => {
			receivedSignal = signal;
			markUnavailableStarted();
			await new Promise<void>((_resolve, reject) => {
				if (signal?.aborted) reject(signal.reason);
				else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
			return "unreachable";
		};
		const state = { manager, fileSync: new LspFileSync(manager) };
		const controller = new AbortController();
		const result = createLspHoverTool(() => state).execute(
			"hover",
			{ path: "fixture.ts", line: 1, character: 1 },
			controller.signal,
			undefined,
			createContext(cwd),
		);
		await unavailableStarted;
		controller.abort(new Error("cancel unavailable explanation"));
		await expect(result).rejects.toThrow("cancel unavailable explanation");
		expect(receivedSignal).toBe(controller.signal);
		await manager.shutdownAll();
	});
	it("propagates tool cancellation during startup and synchronization without requests", async () => {
		const cwd = await createTempDir();
		await writeFile(join(cwd, "fixture.ts"), "const value = 1;\n", "utf8");
		let releaseStart!: () => void;
		let markStartStarted!: () => void;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		const startStarted = new Promise<void>((resolve) => {
			markStartStarted = resolve;
		});
		class BlockingToolStartClient extends FakeLspClient {
			override async start(): Promise<LspClientStartResult> {
				markStartStarted();
				await startGate;
				return super.start();
			}

			override async shutdown(): Promise<void> {
				releaseStart();
				await super.shutdown();
			}
		}
		let startupClient: BlockingToolStartClient | undefined;
		const startupManager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => {
				startupClient = new BlockingToolStartClient(options);
				return startupClient;
			},
		});
		const startupState = { manager: startupManager, fileSync: new LspFileSync(startupManager) };
		const startupController = new AbortController();
		const startup = createLspHoverTool(() => startupState).execute(
			"hover",
			{ path: "fixture.ts", line: 1, character: 1 },
			startupController.signal,
			undefined,
			createContext(cwd),
		);
		await startStarted;
		startupController.abort(new Error("cancel tool startup"));
		await expect(startup).rejects.toThrow("cancel tool startup");
		expect(startupClient?.requests).toEqual([]);
		await startupManager.shutdownAll();

		let markReadStarted!: () => void;
		const readStarted = new Promise<void>((resolve) => {
			markReadStarted = resolve;
		});
		const operations = {
			...new LocalToolOperations(cwd),
			cwd,
			readFile: async () => {
				markReadStarted();
				await new Promise(() => {});
				return Buffer.from("");
			},
			getBackendInfo: () => ({ type: "local", cwd }) as const,
		} as unknown as ToolOperations;
		let synchronizationClient: FakeLspClient | undefined;
		const synchronizationManager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => {
				synchronizationClient = new FakeLspClient(options);
				return synchronizationClient;
			},
		});
		const synchronizationState = {
			manager: synchronizationManager,
			fileSync: new LspFileSync(synchronizationManager),
		};
		const synchronizationController = new AbortController();
		const synchronization = createLspHoverTool(() => synchronizationState).execute(
			"hover",
			{ path: "fixture.ts", line: 1, character: 1 },
			synchronizationController.signal,
			undefined,
			{ ...createContext(cwd), toolOperations: operations } as ExtensionContext,
		);
		await readStarted;
		synchronizationController.abort(new Error("cancel tool synchronization"));
		await expect(synchronization).rejects.toThrow("cancel tool synchronization");
		expect(synchronizationClient?.requests).toEqual([]);
		await synchronizationManager.shutdownAll();
	});
	it("uses priority for hover and rejects conflicting rename previews", async () => {
		const { cwd, state, clients } = await createMultiToolState(
			[testServer({ id: "primary", priority: 20 }), testServer({ id: "secondary", priority: 10 })],
			(client) => {
				client.setResponse(
					"textDocument/hover",
					client.serverId === "primary" ? null : { contents: "secondary hover" },
				);
				const uri = new URL(`file://${join(client.rootDir, "fixture.ts")}`).toString();
				client.setResponse("textDocument/rename", {
					changes: {
						[uri]: [
							{
								range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
								newText: client.serverId === "primary" ? "primaryName" : "secondaryName",
							},
						],
					},
				});
			},
		);
		const ctx = createContext(cwd);
		const hover = await createLspHoverTool(() => state).execute(
			"hover",
			{ path: "fixture.ts", line: 1, character: 1 },
			undefined,
			undefined,
			ctx,
		);
		expect(text(hover)).toContain("Hover from secondary:\nsecondary hover");
		clients.get("primary")?.setResponse("textDocument/hover", { contents: "primary hover" });
		const preferredHover = await createLspHoverTool(() => state).execute(
			"hover",
			{ path: "fixture.ts", line: 1, character: 1 },
			undefined,
			undefined,
			ctx,
		);
		expect(text(preferredHover)).toContain("Hover from primary:\nprimary hover");
		const secondaryHoverRequests = clients
			.get("secondary")
			?.requests.filter((request) => request.method === "textDocument/hover");
		expect(secondaryHoverRequests).toHaveLength(1);
		const rename = await createLspRenameTool(() => state).execute(
			"rename",
			{ path: "fixture.ts", line: 1, character: 1, newName: "renamed" },
			undefined,
			undefined,
			ctx,
		);
		expect(rename.details).toMatchObject({ conflict: true });
		expect(text(rename)).toContain("Conflicting rename previews");
		expect(text(rename)).toContain("[primary]");
		expect(text(rename)).toContain("[secondary]");
		expect(text(rename)).toContain("no changes were applied");
		await state.manager.shutdownAll();
	});

	it("excludes a client whose synchronization failed before tool requests", async () => {
		const cwd = await createTempDir();
		await writeFile(join(cwd, "fixture.ts"), "const value = 1;\n", "utf8");
		const clients = new Map<string, FakeLspClient>();
		class FailingToolSyncClient extends FakeLspClient {
			override async didOpen(uri: string, languageId: string, version: number, content: string): Promise<void> {
				if (this.serverId === "a") throw new Error("tool synchronization failure");
				await super.didOpen(uri, languageId, version, content);
			}
		}
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer({ id: "a" }), testServer({ id: "b" })] },
			createClient: (options) => {
				const client = new FailingToolSyncClient(options);
				client.setResponse("textDocument/hover", { contents: `${options.serverId} hover` });
				clients.set(options.serverId, client);
				return client;
			},
		});
		const state = { manager, fileSync: new LspFileSync(manager) };
		const result = await createLspHoverTool(() => state).execute(
			"hover",
			{ path: "fixture.ts", line: 1, character: 1 },
			undefined,
			undefined,
			createContext(cwd),
		);
		expect(text(result)).toContain("b hover");
		expect(text(result)).toContain("a: tool synchronization failure");
		expect(clients.get("a")?.requests).toEqual([]);
		expect(clients.get("b")?.requests).toEqual([expect.objectContaining({ method: "textDocument/hover" })]);
		await manager.shutdownAll();
	});

	it("does not issue tool requests after lifecycle-cancelled synchronization", async () => {
		const cwd = await createTempDir();
		await writeFile(join(cwd, "fixture.ts"), "const value = 1;\n", "utf8");
		let manager!: LspManager;
		let shutdown: Promise<void> | undefined;
		class LifecycleCancellingClient extends FakeLspClient {
			override async didOpen(
				_uri: string,
				_languageId: string,
				_version: number,
				_content: string,
				signal?: AbortSignal,
			): Promise<void> {
				shutdown = manager.shutdownAll();
				await new Promise<void>((_resolve, reject) => {
					if (signal?.aborted) reject(signal.reason);
					else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			}
		}
		let client: LifecycleCancellingClient | undefined;
		manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => {
				client = new LifecycleCancellingClient(options);
				client.setResponse("textDocument/hover", { contents: "stale hover" });
				return client;
			},
		});
		const state = { manager, fileSync: new LspFileSync(manager) };
		const result = await createLspHoverTool(() => state).execute(
			"hover",
			{ path: "fixture.ts", line: 1, character: 1 },
			undefined,
			undefined,
			createContext(cwd),
		);
		expect(text(result)).toContain("synchronization was cancelled by an LSP lifecycle change");
		expect(client?.requests).toEqual([]);
		await shutdown;
	});
});

describe("LSP document synchronization", () => {
	it("tracks versions independently across matching clients and replays didOpen after reconnect", async () => {
		const cwd = await createTempDir();
		const filePath = join(cwd, "fixture.ts");
		await writeFile(filePath, "one\n", "utf8");
		const clients = new Map<string, FakeLspClient[]>();
		const manager = new LspManager(cwd, {
			configuration: {
				enabled: true,
				servers: [testServer({ id: "a" }), testServer({ id: "b" })],
			},
			createClient: (options) => {
				const client = new FakeLspClient(options);
				clients.set(options.serverId, [...(clients.get(options.serverId) ?? []), client]);
				return client;
			},
		});
		const fileSync = new LspFileSync(manager);
		const operations = new LocalToolOperations(cwd);
		const targets = (await manager.resolveTargets(filePath)).targets;
		const targetA = targets.find((target) => target.serverId === "a");
		const targetB = targets.find((target) => target.serverId === "b");
		if (!targetA || !targetB) throw new Error("expected both route targets");
		await manager.getClientForTarget(targetA);
		await fileSync.handleFileRead(filePath, operations);
		await writeFile(filePath, "two\n", "utf8");
		await fileSync.handleFileWrite(filePath, operations);
		await manager.getClientForTarget(targetB);
		const firstA = clients.get("a")?.[0];
		const firstB = clients.get("b")?.[0];
		if (!firstA || !firstB) throw new Error("expected both clients");
		expect(firstA.notifications).toEqual([
			expect.objectContaining({ method: "textDocument/didOpen", params: expect.objectContaining({ version: 1 }) }),
			expect.objectContaining({ method: "textDocument/didChange", params: expect.objectContaining({ version: 2 }) }),
		]);
		expect(firstB.notifications).toEqual([
			expect.objectContaining({
				method: "textDocument/didOpen",
				params: expect.objectContaining({ version: 1, text: "two\n" }),
			}),
		]);

		await writeFile(filePath, "three\n", "utf8");
		await fileSync.handleFileWrite(filePath, operations);
		expect(fileSync.getTrackedVersion(targetA.serverUri, targetA.instanceKey)).toBe(3);
		expect(fileSync.getTrackedVersion(targetB.serverUri, targetB.instanceKey)).toBe(2);

		firstA.disconnectUnexpectedly();
		await manager.getClientForTarget(targetA);
		const reconnectedA = clients.get("a")?.[1];
		if (!reconnectedA) throw new Error("expected reconnected client");
		expect(reconnectedA.notifications[0]).toMatchObject({
			method: "textDocument/didOpen",
			params: { version: 1, text: "three\n" },
		});
		await manager.invalidateSynchronizationClient(targetA, firstA, new Error("stale synchronization failure"));
		expect(manager.getRunningClient(targetA.instanceKey)).toBe(reconnectedA);
		expect(manager.getStatus().find((status) => status.serverId === "a")?.synchronizationError).toBeUndefined();
		await writeFile(filePath, "four\n", "utf8");
		await fileSync.handleFileWrite(filePath, operations);
		expect(reconnectedA.notifications[1]).toMatchObject({
			method: "textDocument/didChange",
			params: { version: 2, text: "four\n" },
		});
		await manager.shutdownAll();
	});

	it("emits didChange with the next client-local version when a later read observes external content", async () => {
		const cwd = await createTempDir();
		const filePath = join(cwd, "fixture.ts");
		await writeFile(filePath, "one\n", "utf8");
		let client: FakeLspClient | undefined;
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => {
				client = new FakeLspClient(options);
				return client;
			},
		});
		const fileSync = new LspFileSync(manager);
		const operations = new LocalToolOperations(cwd);
		await manager.getClientForFile(filePath);
		await fileSync.handleFileRead(filePath, operations);
		await writeFile(filePath, "externally changed\n", "utf8");
		await fileSync.handleFileRead(filePath, operations);
		expect(client?.notifications[1]).toMatchObject({
			method: "textDocument/didChange",
			params: { version: 2, text: "externally changed\n" },
		});
		await manager.shutdownAll();
	});

	it("invalidates only a partially synchronized client and replays current content with fresh versions", async () => {
		const cwd = await createTempDir();
		const filePath = join(cwd, "fixture.ts");
		await writeFile(filePath, "one\n", "utf8");
		let failed = false;
		const clients = new Map<string, FakeLspClient[]>();
		class FailingChangeClient extends FakeLspClient {
			override async didChange(uri: string, version: number, content: string): Promise<void> {
				await super.didChange(uri, version, content);
				if (this.serverId === "a" && !failed) {
					failed = true;
					throw new Error("intentional partial change failure");
				}
			}
		}
		const manager = new LspManager(cwd, {
			configuration: {
				enabled: true,
				servers: [testServer({ id: "a" }), testServer({ id: "b" }), testServer({ id: "inactive" })],
			},
			createClient: (options) => {
				const client = new FailingChangeClient(options);
				clients.set(options.serverId, [...(clients.get(options.serverId) ?? []), client]);
				return client;
			},
		});
		const fileSync = new LspFileSync(manager);
		const operations = new LocalToolOperations(cwd);
		const targets = (await manager.resolveTargets(filePath)).targets;
		const targetA = targets.find((target) => target.serverId === "a");
		const targetB = targets.find((target) => target.serverId === "b");
		if (!targetA || !targetB) throw new Error("expected active targets");
		await manager.getClientForTarget(targetA);
		await manager.getClientForTarget(targetB);
		await fileSync.handleFileRead(filePath, operations);
		await writeFile(filePath, "two\n", "utf8");
		await expect(fileSync.handleFileWrite(filePath, operations)).resolves.toBeUndefined();
		await waitForCondition(() => clients.get("a")?.[1]?.notifications.length === 1);

		const firstA = clients.get("a")?.[0];
		const replacementA = clients.get("a")?.[1];
		const firstB = clients.get("b")?.[0];
		expect(firstA?.notifications[1]).toMatchObject({
			method: "textDocument/didChange",
			params: { version: 2, text: "two\n" },
		});
		expect(replacementA?.notifications[0]).toMatchObject({
			method: "textDocument/didOpen",
			params: { version: 1, text: "two\n" },
		});
		expect(firstB?.notifications[1]).toMatchObject({
			method: "textDocument/didChange",
			params: { version: 2, text: "two\n" },
		});
		expect(clients.get("b")).toHaveLength(1);
		expect(clients.get("inactive")).toBeUndefined();
		expect(manager.getStatus().find((status) => status.serverId === "a")?.synchronizationError).toBeUndefined();
		expect((fileSync as unknown as { indeterminateClients: Set<LspClient> }).indeterminateClients.size).toBe(0);

		await writeFile(filePath, "three\n", "utf8");
		await fileSync.handleFileWrite(filePath, operations);
		expect(replacementA?.notifications[1]).toMatchObject({
			method: "textDocument/didChange",
			params: { version: 2, text: "three\n" },
		});
		expect(firstB?.notifications[2]).toMatchObject({
			method: "textDocument/didChange",
			params: { version: 3, text: "three\n" },
		});
		expect(fileSync.getTrackedVersion(targetA.serverUri, targetA.instanceKey)).toBe(2);
		expect(fileSync.getTrackedVersion(targetB.serverUri, targetB.instanceKey)).toBe(3);
		await manager.shutdownAll();
	});

	it("times out a blocked provider notification, continues other providers, and replays on replacement", async () => {
		const cwd = await createTempDir();
		const filePath = join(cwd, "fixture.ts");
		await writeFile(filePath, "one\n", "utf8");
		let blocked = false;
		class BlockingChangeClient extends FakeLspClient {
			override async didChange(uri: string, version: number, content: string): Promise<void> {
				if (this.serverId === "a" && !blocked) {
					blocked = true;
					return new Promise(() => {});
				}
				await super.didChange(uri, version, content);
			}
		}
		const clients = new Map<string, BlockingChangeClient[]>();
		const manager = new LspManager(cwd, {
			configuration: {
				enabled: true,
				servers: [testServer({ id: "a", timeouts: { requestMs: 20 } }), testServer({ id: "b" })],
			},
			createClient: (options) => {
				const client = new BlockingChangeClient(options);
				clients.set(options.serverId, [...(clients.get(options.serverId) ?? []), client]);
				return client;
			},
		});
		const fileSync = new LspFileSync(manager);
		const operations = new LocalToolOperations(cwd);
		for (const target of (await manager.resolveTargets(filePath)).targets) await manager.getClientForTarget(target);
		await fileSync.handleFileRead(filePath, operations);
		await writeFile(filePath, "two\n", "utf8");
		const synchronization = fileSync.handleFileWrite(filePath, operations);
		expect(await settlesWithin(synchronization, 200)).toBe(true);
		await synchronization;
		await waitForCondition(() => clients.get("a")?.[1]?.notifications.length === 1);
		expect(clients.get("a")?.[1]?.notifications[0]).toMatchObject({
			method: "textDocument/didOpen",
			params: expect.objectContaining({ version: 1, text: "two\n" }),
		});
		expect(clients.get("b")?.[0]?.notifications[1]).toMatchObject({
			method: "textDocument/didChange",
			params: expect.objectContaining({ version: 2, text: "two\n" }),
		});
		await manager.shutdownAll();
	});

	it("invalidates timed-out recovery replay even when another waiter keeps startup alive", async () => {
		const cwd = await createTempDir();
		const filePath = join(cwd, "fixture.ts");
		await writeFile(filePath, "one\n", "utf8");
		let releaseReplacement!: () => void;
		let markReplacementStarted!: () => void;
		const replacementGate = new Promise<void>((resolve) => {
			releaseReplacement = resolve;
		});
		const replacementStarted = new Promise<void>((resolve) => {
			markReplacementStarted = resolve;
		});
		const clients: RecoveryTimeoutClient[] = [];
		class RecoveryTimeoutClient extends FakeLspClient {
			private readonly creationIndex: number;

			constructor(options: LspClientOptions) {
				super(options);
				this.creationIndex = clients.length;
			}

			override async start(): Promise<LspClientStartResult> {
				if (this.creationIndex === 1) {
					markReplacementStarted();
					await replacementGate;
				}
				return super.start();
			}

			override async didChange(uri: string, version: number, content: string): Promise<void> {
				if (this.creationIndex === 0) throw new Error("trigger recovery");
				await super.didChange(uri, version, content);
			}
		}
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer({ timeouts: { requestMs: 20 } })] },
			createClient: (options) => {
				const client = new RecoveryTimeoutClient(options);
				clients.push(client);
				return client;
			},
		});
		const fileSync = new LspFileSync(manager);
		const operations = new LocalToolOperations(cwd);
		await manager.getClientForFile(filePath);
		await fileSync.handleFileRead(filePath, operations);
		await writeFile(filePath, "two\n", "utf8");
		await fileSync.handleFileWrite(filePath, operations);
		await replacementStarted;
		const joinedStartup = manager.getClientForFile(filePath);
		await new Promise((resolve) => setTimeout(resolve, 30));
		releaseReplacement();
		await expect(joinedStartup).resolves.toBeUndefined();
		expect(clients[1]?.isDisposed).toBe(true);
		expect(manager.getRunningClients()).toEqual([]);
		const status = manager.getStatus()[0];
		expect(status?.running).toBe(false);
		expect(status?.state).not.toBe("running");
		await manager.shutdownAll();
	});

	it("replaces a client after a partially delivered didSave without reusing its version state", async () => {
		const cwd = await createTempDir();
		const filePath = join(cwd, "fixture.ts");
		await writeFile(filePath, "one\n", "utf8");
		let failSave = true;
		class FailingSaveClient extends FakeLspClient {
			override async didSave(uri: string, content?: string, signal?: AbortSignal): Promise<void> {
				await super.didSave(uri, content, signal);
				if (failSave) {
					failSave = false;
					throw new Error("intentional partial save failure");
				}
			}
		}
		const clients: FailingSaveClient[] = [];
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => {
				const client = new FailingSaveClient(options);
				client.setCapabilities({
					textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Full, save: { includeText: true } },
				});
				clients.push(client);
				return client;
			},
		});
		const fileSync = new LspFileSync(manager);
		const operations = new LocalToolOperations(cwd);
		await manager.getClientForFile(filePath);
		await fileSync.handleFileRead(filePath, operations);
		await writeFile(filePath, "two\n", "utf8");
		await fileSync.handleFileWrite(filePath, operations);
		await waitForCondition(() => (clients[1]?.notifications.length ?? 0) >= 2);

		expect(clients[0]?.notifications.map((notification) => notification.method)).toEqual([
			"textDocument/didOpen",
			"textDocument/didChange",
			"textDocument/didSave",
		]);
		expect(clients[1]?.notifications[0]).toMatchObject({
			method: "textDocument/didOpen",
			params: expect.objectContaining({ version: 1, text: "two\n" }),
		});
		expect(clients[1]?.notifications[1]).toMatchObject({
			method: "textDocument/didSave",
			params: expect.objectContaining({ text: "two\n" }),
		});
		await writeFile(filePath, "three\n", "utf8");
		await fileSync.handleFileWrite(filePath, operations);
		expect(clients[1]?.notifications[2]).toMatchObject({
			method: "textDocument/didChange",
			params: expect.objectContaining({ version: 2, text: "three\n" }),
		});
		await manager.shutdownAll();
	});

	it("continues reconnect replay after a tracked document read fails", async () => {
		const cwd = await createTempDir();
		const missingPath = join(cwd, "missing.ts");
		const healthyPath = join(cwd, "healthy.ts");
		await writeFile(missingPath, "missing\n", "utf8");
		await writeFile(healthyPath, "healthy\n", "utf8");
		let failMissing = false;
		class ReplayOperations extends LocalToolOperations {
			override async readFile(path: string): Promise<Buffer> {
				if (failMissing && path === missingPath) throw new Error("intentional replay read failure");
				return super.readFile(path);
			}
		}
		const clients: FakeLspClient[] = [];
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => {
				const client = new FakeLspClient(options);
				clients.push(client);
				return client;
			},
		});
		const fileSync = new LspFileSync(manager);
		const operations = new ReplayOperations(cwd);
		await manager.getClientForFile(missingPath);
		await fileSync.handleFileRead(missingPath, operations);
		await fileSync.handleFileRead(healthyPath, operations);
		clients[0]?.disconnectUnexpectedly();
		failMissing = true;
		await manager.getClientForFile(healthyPath);
		expect(clients[1]?.notifications).toEqual([
			expect.objectContaining({
				method: "textDocument/didOpen",
				params: expect.objectContaining({ text: "healthy\n" }),
			}),
		]);
		expect(manager.getStatus()[0]?.synchronizationError).toContain("intentional replay read failure");
		await manager.shutdownAll();
	});

	it("honors full, incremental, save, close, eviction, and unsupported synchronization capabilities", async () => {
		const cwd = await createTempDir();
		const firstPath = join(cwd, "first.ts");
		const secondPath = join(cwd, "second.ts");
		await writeFile(firstPath, "alpha\n", "utf8");
		await writeFile(secondPath, "second\n", "utf8");
		const clients = new Map<string, FakeLspClient>();
		const manager = new LspManager(cwd, {
			configuration: {
				enabled: true,
				servers: [testServer({ id: "full" }), testServer({ id: "incremental" }), testServer({ id: "none" })],
			},
			createClient: (options) => {
				const client = new FakeLspClient(options);
				if (options.serverId === "incremental") {
					client.setCapabilities({
						textDocumentSync: {
							openClose: true,
							change: TextDocumentSyncKind.Incremental,
							save: { includeText: true },
						},
					});
				} else if (options.serverId === "none") {
					client.setCapabilities({ textDocumentSync: TextDocumentSyncKind.None });
				}
				clients.set(options.serverId, client);
				return client;
			},
		});
		const fileSync = new LspFileSync(manager, 1);
		const operations = new LocalToolOperations(cwd);
		for (const target of (await manager.resolveTargets(firstPath)).targets) {
			await manager.getClientForTarget(target);
		}
		await fileSync.handleFileRead(firstPath, operations);
		await writeFile(firstPath, "alpha B\n", "utf8");
		await fileSync.handleFileWrite(firstPath, operations);

		const full = clients.get("full");
		const incremental = clients.get("incremental");
		const none = clients.get("none");
		if (!full || !incremental || !none) throw new Error("expected synchronization clients");
		expect(full.notifications[1]).toMatchObject({
			method: "textDocument/didChange",
			params: { version: 2, text: "alpha B\n" },
		});
		expect(incremental.notifications[1]).toMatchObject({
			method: "textDocument/didChange",
			params: {
				textDocument: { version: 2 },
				contentChanges: [
					{ range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } }, text: " B" },
				],
			},
		});
		expect(incremental.notifications[2]).toMatchObject({
			method: "textDocument/didSave",
			params: { text: "alpha B\n" },
		});
		expect(none.notifications).toEqual([]);

		await fileSync.handleFileRead(secondPath, operations);
		expect(full.notifications.filter((notification) => notification.method === "textDocument/didClose")).toHaveLength(
			1,
		);
		expect(
			incremental.notifications.filter((notification) => notification.method === "textDocument/didClose"),
		).toHaveLength(1);
		expect(none.notifications).toEqual([]);
		await manager.shutdownAll();
		expect(full.notifications.filter((notification) => notification.method === "textDocument/didClose")).toHaveLength(
			2,
		);
		expect(
			incremental.notifications.filter((notification) => notification.method === "textDocument/didClose"),
		).toHaveLength(2);
	});

	it("replaces a client after a rejected didOpen while other clients finish eviction", async () => {
		const cwd = await createTempDir();
		const firstPath = join(cwd, "first.ts");
		const secondPath = join(cwd, "second.ts");
		await writeFile(firstPath, "first\n", "utf8");
		await writeFile(secondPath, "second\n", "utf8");
		let failedOpen = false;
		class FailingOpenClient extends FakeLspClient {
			override async didOpen(uri: string, languageId: string, version: number, content: string): Promise<void> {
				await super.didOpen(uri, languageId, version, content);
				if (this.serverId === "a" && uri.endsWith("/second.ts") && !failedOpen) {
					failedOpen = true;
					throw new Error("intentional partial open failure");
				}
			}
		}
		const clients = new Map<string, FakeLspClient[]>();
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer({ id: "a" }), testServer({ id: "b" })] },
			createClient: (options) => {
				const client = new FailingOpenClient(options);
				clients.set(options.serverId, [...(clients.get(options.serverId) ?? []), client]);
				return client;
			},
		});
		const fileSync = new LspFileSync(manager, 1);
		const operations = new LocalToolOperations(cwd);
		for (const target of (await manager.resolveTargets(firstPath)).targets) await manager.getClientForTarget(target);
		await fileSync.handleFileRead(firstPath, operations);
		await expect(fileSync.handleFileRead(secondPath, operations)).resolves.toBeUndefined();
		await waitForCondition(() => clients.get("a")?.[1]?.notifications.length === 1);

		expect(fileSync.trackedCount).toBe(1);
		expect(clients.get("a")?.[0]?.notifications).toEqual([
			expect.objectContaining({
				method: "textDocument/didOpen",
				params: expect.objectContaining({ text: "first\n", version: 1 }),
			}),
			expect.objectContaining({
				method: "textDocument/didOpen",
				params: expect.objectContaining({ text: "second\n", version: 1 }),
			}),
		]);
		expect(clients.get("a")?.[1]?.notifications).toEqual([
			expect.objectContaining({
				method: "textDocument/didOpen",
				params: expect.objectContaining({ text: "second\n", version: 1 }),
			}),
		]);
		expect(clients.get("b")?.[0]?.notifications).toEqual([
			expect.objectContaining({
				method: "textDocument/didOpen",
				params: expect.objectContaining({ text: "first\n" }),
			}),
			expect.objectContaining({
				method: "textDocument/didOpen",
				params: expect.objectContaining({ text: "second\n" }),
			}),
			expect.objectContaining({ method: "textDocument/didClose" }),
		]);
		expect(clients.get("b")).toHaveLength(1);
		await manager.shutdownAll();
	});

	it("invalidates a client after an indeterminate eviction close and replays only current documents", async () => {
		const cwd = await createTempDir();
		const firstPath = join(cwd, "first.ts");
		const secondPath = join(cwd, "second.ts");
		await writeFile(firstPath, "first\n", "utf8");
		await writeFile(secondPath, "second\n", "utf8");
		let failClose = true;
		class FailingCloseClient extends FakeLspClient {
			override async didClose(uri: string, signal?: AbortSignal): Promise<void> {
				await super.didClose(uri, signal);
				if (failClose) {
					failClose = false;
					throw new Error("intentional partial close failure");
				}
			}
		}
		const clients: FailingCloseClient[] = [];
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => {
				const client = new FailingCloseClient(options);
				clients.push(client);
				return client;
			},
		});
		const fileSync = new LspFileSync(manager, 1);
		const operations = new LocalToolOperations(cwd);
		await manager.getClientForFile(firstPath);
		await fileSync.handleFileRead(firstPath, operations);
		await fileSync.handleFileRead(secondPath, operations);
		await waitForCondition(() => clients[1]?.notifications.length === 1);

		expect(clients[0]?.notifications.map((notification) => notification.method)).toEqual([
			"textDocument/didOpen",
			"textDocument/didOpen",
			"textDocument/didClose",
		]);
		expect(clients[1]?.notifications[0]).toMatchObject({
			method: "textDocument/didOpen",
			params: expect.objectContaining({ text: "second\n", version: 1 }),
		});
		await fileSync.handleFileRead(firstPath, operations);
		expect(clients[1]?.notifications.map((notification) => notification.method)).toEqual([
			"textDocument/didOpen",
			"textDocument/didOpen",
			"textDocument/didClose",
		]);
		await manager.shutdownAll();
	});
	it("lets caller cancellation leave the shared synchronization queue usable", async () => {
		const cwd = await createTempDir();
		const filePath = join(cwd, "fixture.ts");
		await writeFile(filePath, "one\n", "utf8");
		let releaseRead!: () => void;
		let markReadStarted!: () => void;
		let blockNextRead = true;
		const readGate = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		const readStarted = new Promise<void>((resolve) => {
			markReadStarted = resolve;
		});
		class BlockingReadOperations extends LocalToolOperations {
			override async readFile(path: string): Promise<Buffer> {
				if (blockNextRead) {
					blockNextRead = false;
					markReadStarted();
					await readGate;
				}
				return super.readFile(path);
			}
		}
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => new FakeLspClient(options),
		});
		const fileSync = new LspFileSync(manager);
		const operations = new BlockingReadOperations(cwd);
		await manager.getClientForFile(filePath);
		const first = fileSync.handleFileRead(filePath, operations);
		await readStarted;
		const controller = new AbortController();
		const cancelled = fileSync.handleFileRead(filePath, operations, controller.signal);
		controller.abort(new Error("cancel synchronization"));
		expect(await settlesWithin(cancelled)).toBe(true);
		await expect(cancelled).rejects.toThrow("cancel synchronization");
		releaseRead();
		await first;
		await expect(fileSync.handleFileRead(filePath, operations)).resolves.toBeUndefined();
		expect(fileSync.trackedCount).toBe(1);
		await manager.shutdownAll();
	});

	it.each(["open", "change", "save"] as const)(
		"cancels a blocked did%s notification, invalidates the client, and replays on a fresh client",
		async (blockedMethod) => {
			const cwd = await createTempDir();
			const filePath = join(cwd, "fixture.ts");
			await writeFile(filePath, "one\n", "utf8");
			let block: typeof blockedMethod | undefined;
			let markNotificationStarted!: () => void;
			const notificationStarted = new Promise<void>((resolve) => {
				markNotificationStarted = resolve;
			});
			class BlockingNotificationClient extends FakeLspClient {
				private async waitForCancellation(signal: AbortSignal | undefined): Promise<void> {
					markNotificationStarted();
					await new Promise<void>((_resolve, reject) => {
						if (signal?.aborted) {
							reject(signal.reason);
							return;
						}
						signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
				}

				override async didOpen(
					uri: string,
					languageId: string,
					version: number,
					content: string,
					signal?: AbortSignal,
				): Promise<void> {
					if (block === "open") await this.waitForCancellation(signal);
					await super.didOpen(uri, languageId, version, content);
				}

				override async didChange(
					uri: string,
					version: number,
					content: string,
					signal?: AbortSignal,
				): Promise<void> {
					if (block === "change") await this.waitForCancellation(signal);
					await super.didChange(uri, version, content);
				}

				override async didSave(uri: string, content?: string, signal?: AbortSignal): Promise<void> {
					if (block === "save") await this.waitForCancellation(signal);
					await super.didSave(uri, content, signal);
				}
			}
			const clients: BlockingNotificationClient[] = [];
			const manager = new LspManager(cwd, {
				configuration: { enabled: true, servers: [testServer()] },
				createClient: (options) => {
					const client = new BlockingNotificationClient(options);
					client.setCapabilities({
						textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Full, save: true },
					});
					clients.push(client);
					return client;
				},
			});
			const fileSync = new LspFileSync(manager);
			const operations = new LocalToolOperations(cwd);
			await manager.getClientForFile(filePath);
			if (blockedMethod === "open") {
				block = "open";
			} else {
				await fileSync.handleFileRead(filePath, operations);
				await writeFile(filePath, "two\n", "utf8");
				block = blockedMethod;
			}
			const controller = new AbortController();
			const synchronization =
				blockedMethod === "open"
					? fileSync.handleFileRead(filePath, operations, controller.signal)
					: fileSync.handleFileWrite(filePath, operations, controller.signal);
			await notificationStarted;
			controller.abort(new Error(`cancel ${blockedMethod}`));
			await expect(synchronization).rejects.toThrow(`cancel ${blockedMethod}`);
			block = undefined;
			await waitForCondition(() => (clients[1]?.notifications.length ?? 0) >= 1);
			expect(clients).toHaveLength(2);
			expect(clients[1]?.notifications[0]).toMatchObject({
				method: "textDocument/didOpen",
				params: expect.objectContaining({ text: blockedMethod === "open" ? "one\n" : "two\n", version: 1 }),
			});
			await manager.shutdownAll();
		},
	);

	it("keeps shared startup registered across one cancelled waiter and aborts an orphaned startup", async () => {
		const cwd = await createTempDir();
		let releaseStart!: () => void;
		let markStartStarted!: () => void;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		const startStarted = new Promise<void>((resolve) => {
			markStartStarted = resolve;
		});
		const clients: FakeLspClient[] = [];
		class BlockingStartClient extends FakeLspClient {
			override async start(): Promise<LspClientStartResult> {
				markStartStarted();
				await startGate;
				return super.start();
			}
		}
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => {
				const client = new BlockingStartClient(options);
				clients.push(client);
				return client;
			},
		});
		const controller = new AbortController();
		const cancelled = manager.getClientForFile("fixture.ts", controller.signal);
		await startStarted;
		const shared = manager.getClientForFile("fixture.ts");
		await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort(new Error("cancel one startup waiter"));
		await expect(cancelled).rejects.toThrow("cancel one startup waiter");
		expect(manager.isStarting((await manager.getPrimaryTarget("fixture.ts"))?.instanceKey ?? "")).toBe(true);
		releaseStart();
		await expect(shared).resolves.toBe(clients[0]);
		expect(clients).toHaveLength(1);
		await manager.shutdownAll();

		let releaseOrphan!: () => void;
		let markOrphanStarted!: () => void;
		let orphanStarts = 0;
		const orphanGate = new Promise<void>((resolve) => {
			releaseOrphan = resolve;
		});
		const orphanStarted = new Promise<void>((resolve) => {
			markOrphanStarted = resolve;
		});
		class OrphanStartClient extends FakeLspClient {
			override async start(): Promise<LspClientStartResult> {
				orphanStarts++;
				markOrphanStarted();
				await orphanGate;
				return super.start();
			}

			override async shutdown(): Promise<void> {
				releaseOrphan();
				await super.shutdown();
			}
		}
		const orphanManager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => new OrphanStartClient(options),
		});
		const orphanController = new AbortController();
		const orphaned = orphanManager.getClientForFile("fixture.ts", orphanController.signal);
		await orphanStarted;
		orphanController.abort(new Error("cancel sole startup waiter"));
		await expect(orphaned).rejects.toThrow("cancel sole startup waiter");
		await new Promise((resolve) => setTimeout(resolve, 0));
		await orphanManager.getClientForFile("fixture.ts");
		expect(orphanStarts).toBe(2);
		await orphanManager.shutdownAll();
	});

	it("aborts an in-flight notification before shutdown cleanup and emits nothing afterward", async () => {
		const cwd = await createTempDir();
		const filePath = join(cwd, "fixture.ts");
		await writeFile(filePath, "one\n", "utf8");
		let blockChange = false;
		let markChangeStarted!: () => void;
		const changeStarted = new Promise<void>((resolve) => {
			markChangeStarted = resolve;
		});
		class BlockingChangeClient extends FakeLspClient {
			override async didChange(uri: string, version: number, content: string, signal?: AbortSignal): Promise<void> {
				if (blockChange) {
					markChangeStarted();
					await new Promise<void>((_resolve, reject) => {
						if (signal?.aborted) reject(signal.reason);
						else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
				}
				await super.didChange(uri, version, content);
			}
		}
		let client: BlockingChangeClient | undefined;
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => {
				client = new BlockingChangeClient(options);
				return client;
			},
		});
		const fileSync = new LspFileSync(manager);
		const operations = new LocalToolOperations(cwd);
		await manager.getClientForFile(filePath);
		await fileSync.handleFileRead(filePath, operations);
		await writeFile(filePath, "two\n", "utf8");
		blockChange = true;
		const synchronization = fileSync.handleFileRead(filePath, operations);
		await changeStarted;
		await manager.shutdownAll();
		await expect(synchronization).resolves.toBeUndefined();
		expect(client?.notifications.map((notification) => notification.method)).toEqual(["textDocument/didOpen"]);
		expect(fileSync.trackedCount).toBe(0);
	});

	it("aborts a blocked read during shutdown and cannot recreate late document state", async () => {
		const cwd = await createTempDir();
		const filePath = join(cwd, "fixture.ts");
		await writeFile(filePath, "one\n", "utf8");
		let releaseRead!: () => void;
		let markReadStarted!: () => void;
		let blockRead = false;
		const readGate = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		const readStarted = new Promise<void>((resolve) => {
			markReadStarted = resolve;
		});
		class BlockingReadOperations extends LocalToolOperations {
			override async readFile(path: string): Promise<Buffer> {
				if (blockRead) {
					markReadStarted();
					await readGate;
				}
				return super.readFile(path);
			}
		}
		let client: FakeLspClient | undefined;
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer({ timeouts: { shutdownMs: 50 } })] },
			createClient: (options) => {
				client = new FakeLspClient(options);
				return client;
			},
		});
		const fileSync = new LspFileSync(manager);
		const operations = new BlockingReadOperations(cwd);
		await manager.getClientForFile(filePath);
		await fileSync.handleFileRead(filePath, operations);
		blockRead = true;
		const blocked = fileSync.handleFileRead(filePath, operations);
		await readStarted;
		expect(await settlesWithin(manager.shutdownAll())).toBe(true);
		await expect(blocked).resolves.toBeUndefined();
		expect(fileSync.trackedCount).toBe(0);
		const notificationCount = client?.notifications.length;
		releaseRead();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(client?.notifications).toHaveLength(notificationCount ?? 0);
	});
	it("bounds an unreleased shutdown close so replacement replay and synchronization can continue", async () => {
		const cwd = await createTempDir();
		const filePath = join(cwd, "fixture.ts");
		await writeFile(filePath, "before\n", "utf8");
		let blockClose = true;
		let markCloseStarted!: () => void;
		const closeStarted = new Promise<void>((resolve) => {
			markCloseStarted = resolve;
		});
		class BlockingCloseClient extends FakeLspClient {
			override async didClose(uri: string, signal?: AbortSignal): Promise<void> {
				if (blockClose) {
					blockClose = false;
					markCloseStarted();
					return new Promise(() => {});
				}
				await super.didClose(uri, signal);
			}
		}
		const server = testServer({ timeouts: { shutdownMs: 20 } });
		const configuration: ResolvedLspConfiguration = { enabled: true, servers: [server] };
		const clients: BlockingCloseClient[] = [];
		const manager = new LspManager(cwd, {
			configuration,
			createClient: (options) => {
				const client = new BlockingCloseClient(options);
				clients.push(client);
				return client;
			},
		});
		const fileSync = new LspFileSync(manager);
		const operations = new LocalToolOperations(cwd);
		await manager.getClientForFile(filePath);
		await fileSync.handleFileRead(filePath, operations);
		const replacement = manager.setConfiguration(configuration);
		await closeStarted;
		expect(await settlesWithin(replacement, 200)).toBe(true);
		await replacement;
		const replacementStartup = manager.getClientForFile(filePath);
		expect(await settlesWithin(replacementStartup, 200)).toBe(true);
		await replacementStartup;
		await fileSync.handleFileRead(filePath, operations);
		expect(clients).toHaveLength(2);
		expect(clients[1]?.notifications[0]).toMatchObject({ method: "textDocument/didOpen" });
		await manager.shutdownAll();
	});

	it("does not reopen a document after shutdown synchronization begins", async () => {
		const cwd = await createTempDir();
		const filePath = join(cwd, "fixture.ts");
		await writeFile(filePath, "before\n", "utf8");
		let releaseClose: (() => void) | undefined;
		let markCloseStarted: (() => void) | undefined;
		const closeGate = new Promise<void>((resolve) => {
			releaseClose = resolve;
		});
		const closeStarted = new Promise<void>((resolve) => {
			markCloseStarted = resolve;
		});
		class BlockingCloseClient extends FakeLspClient {
			override async didClose(uri: string): Promise<void> {
				markCloseStarted?.();
				await closeGate;
				await super.didClose(uri);
			}
		}
		let client: BlockingCloseClient | undefined;
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => {
				client = new BlockingCloseClient(options);
				return client;
			},
		});
		const fileSync = new LspFileSync(manager);
		const operations = new LocalToolOperations(cwd);
		await manager.getClientForFile(filePath);
		await fileSync.handleFileRead(filePath, operations);
		const shutdown = manager.shutdownAll();
		await closeStarted;
		await writeFile(filePath, "after\n", "utf8");
		await fileSync.handleFileWrite(filePath, operations);
		releaseClose?.();
		await shutdown;
		expect(client?.notifications.map((notification) => notification.method)).toEqual([
			"textDocument/didOpen",
			"textDocument/didClose",
		]);
	});

	it("does not replay documents when a pending reconnect finishes during shutdown", async () => {
		const cwd = await createTempDir();
		const filePath = join(cwd, "fixture.ts");
		await writeFile(filePath, "before\n", "utf8");
		let releaseReconnect: (() => void) | undefined;
		let markReconnectStarted: (() => void) | undefined;
		const reconnectGate = new Promise<void>((resolve) => {
			releaseReconnect = resolve;
		});
		const reconnectStarted = new Promise<void>((resolve) => {
			markReconnectStarted = resolve;
		});
		let creationCount = 0;
		class PendingReconnectClient extends FakeLspClient {
			override async start(): Promise<LspClientStartResult> {
				if (creationCount > 1) {
					markReconnectStarted?.();
					await reconnectGate;
				}
				return super.start();
			}

			override async shutdown(): Promise<void> {
				releaseReconnect?.();
				await super.shutdown();
			}
		}
		const clients: PendingReconnectClient[] = [];
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => {
				creationCount++;
				const client = new PendingReconnectClient(options);
				clients.push(client);
				return client;
			},
		});
		const fileSync = new LspFileSync(manager);
		const operations = new LocalToolOperations(cwd);
		const target = await manager.getPrimaryTarget(filePath);
		if (!target) throw new Error("expected reconnect target");
		await manager.getClientForTarget(target);
		await fileSync.handleFileRead(filePath, operations);
		clients[0]?.disconnectUnexpectedly();
		const reconnect = manager.getClientForTarget(target);
		await reconnectStarted;
		const shutdown = manager.shutdownAll();
		await Promise.all([reconnect, shutdown]);
		expect(clients[1]?.notifications).toEqual([]);
		await fileSync.handleFileWrite(filePath, operations);
		expect(clients[1]?.notifications).toEqual([]);
	});

	it("cancels tool preflight during route acquisition without starting an inactive server", async () => {
		const cwd = await createTempDir();
		await writeFile(join(cwd, "fixture.ts"), "const value = 1;\n", "utf8");
		let releaseAccess!: () => void;
		let markAccessStarted!: () => void;
		const accessGate = new Promise<void>((resolve) => {
			releaseAccess = resolve;
		});
		const accessStarted = new Promise<void>((resolve) => {
			markAccessStarted = resolve;
		});
		const operations = {
			...new LocalToolOperations(cwd),
			cwd,
			access: async () => {
				markAccessStarted();
				await accessGate;
			},
			getBackendInfo: () => ({ type: "local", cwd }) as const,
		} as unknown as ToolOperations;
		let starts = 0;
		const manager = new LspManager(cwd, {
			configuration: {
				enabled: true,
				servers: [testServer({ workspace: { type: "markers", markers: ["package.json"], fallback: "session" } })],
			},
			createClient: (options) => {
				starts++;
				return new FakeLspClient(options);
			},
		});
		const state = { manager, fileSync: new LspFileSync(manager) };
		const ctx = { ...createContext(cwd), toolOperations: operations } as ExtensionContext;
		const controller = new AbortController();
		const preflight = createLspHoverTool(() => state).execute(
			"hover",
			{ path: "fixture.ts", line: 1, character: 1 },
			controller.signal,
			undefined,
			ctx,
		);
		await accessStarted;
		controller.abort(new Error("cancel preflight"));
		expect(await settlesWithin(preflight)).toBe(true);
		await expect(preflight).rejects.toThrow("cancel preflight");
		releaseAccess();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(starts).toBe(0);
		await manager.shutdownAll();
	});
	it("keeps read and write hooks lazy when no matching server instance is active", async () => {
		const cwd = await createTempDir();
		await writeFile(join(cwd, "fixture.ts"), "const value = 1;\n", "utf8");
		let starts = 0;
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => {
				starts++;
				return new FakeLspClient(options);
			},
		});
		const fileSync = new LspFileSync(manager);
		const operations = new LocalToolOperations(cwd);
		await fileSync.handleFileRead("fixture.ts", operations);
		await fileSync.handleFileWrite("fixture.ts", operations);
		expect(starts).toBe(0);
		expect(fileSync.trackedCount).toBe(0);
		await manager.shutdownAll();
	});

	it("does not deadlock backend replacement behind file synchronization when shutdown timeout is disabled", async () => {
		let releaseRead!: () => void;
		let markReadStarted!: () => void;
		const readGate = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		const readStarted = new Promise<void>((resolve) => {
			markReadStarted = resolve;
		});
		const server = testServer({
			pathMappings: [{ agentRoot: "/repo", serverRootUri: "file:///srv/repo" }],
			timeouts: { shutdownMs: 0 },
		});
		const manager = new LspManager("/repo", {
			configuration: { enabled: true, servers: [server] },
			createClient: (options) => new FakeLspClient(options),
		});
		const fileSync = new LspFileSync(manager);
		const createOperations = (remote: string, blockRead: boolean): ToolOperations =>
			({
				cwd: "/repo",
				access: async () => {},
				readFile: async () => {
					if (blockRead) {
						markReadStarted();
						await readGate;
					}
					return Buffer.from("const value = 1;\n");
				},
				getBackendInfo: () => remoteBackendInfo("/repo", remote),
			}) as unknown as ToolOperations;
		const first = createOperations("first", true);
		await manager.setToolOperations(first);
		await manager.getClientForFile("fixture.ts");
		const firstRead = fileSync.handleFileRead("fixture.ts", first);
		await readStarted;
		const replacement = fileSync.handleFileRead("fixture.ts", createOperations("second", false));
		releaseRead();
		expect(await settlesWithin(Promise.all([firstRead, replacement]))).toBe(true);
		await Promise.all([firstRead, replacement]);
		await manager.shutdownAll();
	});

	it("uses case-folded Windows document identity while preserving the first URI spelling", async () => {
		let client: FakeLspClient | undefined;
		const manager = new LspManager("C:\\Repo", {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => {
				client = new FakeLspClient(options);
				return client;
			},
		});
		const operations = {
			cwd: "C:\\Repo",
			access: async () => {},
			readFile: async () => Buffer.from("const value = 1;\n"),
			getBackendInfo: () => ({ type: "local", cwd: "C:\\Repo" }) as const,
		} as unknown as ToolOperations;
		await manager.setToolOperations(operations);
		await manager.getClientForFile("C:\\Repo\\Src\\File.ts");
		const fileSync = new LspFileSync(manager);
		await fileSync.handleFileRead("C:\\Repo\\Src\\File.ts", operations);
		await fileSync.handleFileRead("c:\\repo\\src\\file.ts", operations);
		expect(fileSync.trackedCount).toBe(1);
		expect(client?.notifications.filter((entry) => entry.method === "textDocument/didOpen")).toHaveLength(1);
		expect(client?.notifications[0]).toMatchObject({
			params: { uri: "file:///C:/Repo/Src/File.ts" },
		});
		await manager.shutdownAll();
	});

	it("reports remote backends without usable path mappings as explicitly unavailable", async () => {
		const cwd = await createTempDir();
		let starts = 0;
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer()] },
			getToolBackendInfo: () => remoteBackendInfo(cwd, "example"),
			createClient: (options) => {
				starts++;
				return new FakeLspClient(options);
			},
		});
		await expect(manager.getClientForFile("fixture.ts")).resolves.toBeUndefined();
		expect(await manager.getUnavailableReason("fixture.ts")).toContain("requires explicit LSP pathMappings");
		expect(manager.getStatus()[0]).toMatchObject({
			serverId: "typescript",
			synchronizationError: expect.stringContaining("requires explicit LSP pathMappings"),
		});
		expect(starts).toBe(0);

		const incompatible = new LspManager(cwd, {
			configuration: {
				enabled: true,
				servers: [
					testServer({ pathMappings: [{ agentRoot: join(cwd, "other"), serverRootUri: "file:///server/other" }] }),
				],
			},
			getToolBackendInfo: () => remoteBackendInfo(cwd, "example"),
		});
		expect(await incompatible.getUnavailableReason("fixture.ts")).toContain(
			"outside all configured agent path mappings",
		);
		await manager.shutdownAll();
		await incompatible.shutdownAll();
	});
});

describe("LSP auto diagnostics", () => {
	it("does not start a client when no server is running", async () => {
		const cwd = await createTempDir();
		let starts = 0;
		const manager = new LspManager(cwd, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => {
				starts++;
				return new FakeLspClient(options);
			},
		});
		const output = await formatAutoDiagnosticsForChangedFile(
			{ manager, fileSync: new LspFileSync(manager) },
			"fixture.ts",
		);

		expect(output).toBeUndefined();
		expect(starts).toBe(0);
	});

	it("appends diagnostics after write/edit through lifecycle hooks", async () => {
		const cwd = await createTempDir();
		await writeFile(join(cwd, "fixture.ts"), "const value = 1;\n", "utf8");
		let client: FakeLspClient | undefined;
		const tools: ToolDefinition[] = [];
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>();
		const api = {
			registerTool(tool: ToolDefinition) {
				tools.push(tool);
			},
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI;
		const getState = registerLspLifecycleHandlers(api, {
			configuration: { enabled: true, servers: [testServer()] },
			createClient: (options) => {
				client = new FakeLspClient(options);
				return client;
			},
		});
		const ctx = createContext(cwd);
		handlers.get("session_start")?.({}, ctx);
		await getState().manager.getClientForFile("fixture.ts");
		const target = await getState().manager.getPrimaryTarget("fixture.ts");
		if (!target) throw new Error("expected route target");
		const uri = target.serverUri;
		client?.setDiagnostics(uri, [diagnostic("auto broken")]);
		const event = {
			toolName: "write",
			input: { path: "fixture.ts" },
			isError: false,
			content: [{ type: "text", text: "Wrote fixture.ts" }],
		} as unknown as ToolResultEvent;

		const result = await handlers.get("tool_result")?.(event, ctx);

		expect(tools.map((tool) => tool.name)).toEqual([
			"lsp_diagnostics",
			"lsp_hover",
			"lsp_definition",
			"lsp_references",
			"lsp_rename",
			"lsp_code_actions",
		]);
		expect(result).toMatchObject({
			content: [
				{ type: "text", text: "Wrote fixture.ts" },
				{ type: "text", text: expect.stringContaining("LSP: 1 error(s) in fixture.ts") },
			],
		});
	});
});

describe("LSP selector routing and URI mapping", () => {
	it("routes overlapping custom selectors deterministically and shares one server workspace instance", async () => {
		const sessionRoot = "/repo";
		const markers = new Set(["/repo/package.json", "/repo/packages/app/package.json"]);
		const languageServer = testServer({
			id: "languages",
			priority: 10,
			selectors: [
				{ languageId: "javascript", pattern: "**/*.js" },
				{ languageId: "javascriptreact", pattern: "**/*.jsx" },
				{ languageId: "typescript", pattern: "**/*.ts" },
				{ languageId: "typescriptreact", pattern: "**/*.tsx" },
			],
			workspace: { type: "markers", markers: ["package.json"], fallback: "session" },
		});
		const router = new LspRouter(
			sessionRoot,
			{
				enabled: true,
				servers: [
					testServer({ id: "secondary", priority: 20 }),
					languageServer,
					testServer({ id: "custom", selectors: [{ languageId: "gleam", pattern: "**/*.gleam" }] }),
				],
			},
			{ pathExists: async (path) => markers.has(path) },
		);

		const typescript = await router.routeFile("/repo/packages/app/src/index.ts");
		const javascript = await router.routeFile("/repo/packages/app/src/index.js");
		const custom = await router.routeFile("/repo/lib/main.gleam");
		const unmatched = await router.routeFile("/repo/README.md");

		expect(typescript.targets.map((target) => target.serverId)).toEqual(["secondary", "languages"]);
		expect(typescript.targets[1]).toMatchObject({
			languageId: "typescript",
			workspaceRoot: "/repo/packages/app",
		});
		expect(javascript.targets[0]).toMatchObject({ languageId: "javascript", workspaceRoot: "/repo/packages/app" });
		expect(javascript.targets[0]?.instanceKey).toBe(typescript.targets[1]?.instanceKey);
		expect(custom.targets).toHaveLength(1);
		expect(custom.targets[0]).toMatchObject({ serverId: "custom", languageId: "gleam", workspaceRoot: "/repo" });
		expect(unmatched).toEqual({ targets: [], failures: [] });
	});

	it("chooses the nearest marker root, honors fallback, and clears cached discovery", async () => {
		const markers = new Set(["/repo/package.json", "/repo/packages/app/package.json"]);
		const server = testServer({ workspace: { type: "markers", markers: ["package.json"], fallback: "session" } });
		const router = new LspRouter(
			"/repo",
			{ enabled: true, servers: [server] },
			{ pathExists: async (path) => markers.has(path) },
		);

		expect((await router.routeFile("/repo/packages/app/src/index.ts")).targets[0]?.workspaceRoot).toBe(
			"/repo/packages/app",
		);
		markers.delete("/repo/packages/app/package.json");
		expect((await router.routeFile("/repo/packages/app/src/index.ts")).targets[0]?.workspaceRoot).toBe(
			"/repo/packages/app",
		);
		router.clearCache();
		expect((await router.routeFile("/repo/packages/app/src/index.ts")).targets[0]?.workspaceRoot).toBe("/repo");

		const noFallback = new LspRouter("/repo", {
			enabled: true,
			servers: [testServer({ workspace: { type: "markers", markers: ["missing"], fallback: "none" } })],
		});
		expect((await noFallback.routeFile("/repo/src/index.ts")).targets).toEqual([]);
	});

	it("rejects marker discovery that finishes after explicit cache invalidation", async () => {
		let releaseAccess!: () => void;
		let markAccessStarted!: () => void;
		let blockAccess = true;
		const accessGate = new Promise<void>((resolve) => {
			releaseAccess = resolve;
		});
		const accessStarted = new Promise<void>((resolve) => {
			markAccessStarted = resolve;
		});
		const router = new LspRouter(
			"/repo",
			{
				enabled: true,
				servers: [testServer({ workspace: { type: "markers", markers: ["package.json"], fallback: "session" } })],
			},
			{
				pathExists: async () => {
					if (!blockAccess) return false;
					markAccessStarted();
					await accessGate;
					return true;
				},
			},
		);
		const stale = router.routeFile("/repo/pkg/src/index.ts");
		await accessStarted;
		router.clearCache();
		blockAccess = false;
		releaseAccess();
		await expect(stale).resolves.toEqual({ targets: [], failures: [] });
		expect((await router.routeFile("/repo/pkg/src/index.ts")).targets[0]?.workspaceRoot).toBe("/repo");
	});

	it("canonicalizes Windows workspace identity case-insensitively without changing path case", async () => {
		const router = new LspRouter("C:\\Repo", { enabled: true, servers: [testServer()] });
		const upper = await router.routeFile("C:\\Repo\\Src\\Index.ts");
		const lower = await router.routeFile("c:\\repo\\src\\other.ts");
		expect(upper.targets[0]?.instanceKey).toBe(lower.targets[0]?.instanceKey);
		expect(upper.targets[0]).toMatchObject({
			workspaceRoot: "C:\\Repo",
			serverUri: "file:///C:/Repo/Src/Index.ts",
		});
	});

	it("treats backslashes in POSIX paths as filename characters when matching selectors", async () => {
		const router = new LspRouter("/repo", {
			enabled: true,
			servers: [testServer({ selectors: [{ languageId: "typescript", pattern: "**/a/b.ts" }] })],
		});
		expect((await router.routeFile("/repo/a/b.ts")).targets).toHaveLength(1);
		expect((await router.routeFile("/repo/a\\b.ts")).targets).toEqual([]);
	});

	it("round-trips mapped POSIX, Windows drive, and UNC paths with percent encoding", () => {
		const posixMapper = new LspPathMapper([
			{ agentRoot: "/agent/work tree", serverRootUri: "file:///srv/project root" },
		]);
		const posixUri = posixMapper.agentPathToServerUri("/agent/work tree/src/a #.ts");
		expect(posixUri).toEqual({ ok: true, value: "file:///srv/project%20root/src/a%20%23.ts" });
		expect(posixUri.ok && posixMapper.serverUriToAgentPath(posixUri.value)).toEqual({
			ok: true,
			value: "/agent/work tree/src/a #.ts",
		});
		const posixBackslashUri = posixMapper.agentPathToServerUri("/agent/work tree/src/a\\b.ts");
		expect(posixBackslashUri).toEqual({
			ok: true,
			value: "file:///srv/project%20root/src/a%5Cb.ts",
		});
		expect(posixBackslashUri.ok && posixMapper.serverUriToAgentPath(posixBackslashUri.value)).toEqual({
			ok: true,
			value: "/agent/work tree/src/a\\b.ts",
		});

		const windowsMapper = new LspPathMapper([{ agentRoot: "C:\\Work Tree", serverRootUri: "file:///D:/srv/code" }]);
		const windowsUri = windowsMapper.agentPathToServerUri("c:\\work tree\\Src\\HTTP #.ts");
		expect(windowsUri).toEqual({ ok: true, value: "file:///D:/srv/code/Src/HTTP%20%23.ts" });
		expect(windowsUri.ok && windowsMapper.serverUriToAgentPath(windowsUri.value)).toEqual({
			ok: true,
			value: "C:\\Work Tree\\Src\\HTTP #.ts",
		});

		const uncMapper = new LspPathMapper([
			{ agentRoot: "\\\\Host\\Share\\Repo", serverRootUri: "file://daemon/workspace" },
		]);
		const uncUri = uncMapper.agentPathToServerUri("\\\\host\\share\\repo\\Src\\Main.ts");
		expect(uncUri).toEqual({ ok: true, value: "file://daemon/workspace/Src/Main.ts" });
		expect(uncUri.ok && uncMapper.serverUriToAgentPath(uncUri.value)).toEqual({
			ok: true,
			value: "\\\\Host\\Share\\Repo\\Src\\Main.ts",
		});
		expect(uncMapper.serverUriToAgentPath("file://DAEMON/WORKSPACE/src/MAIN.ts")).toEqual({
			ok: true,
			value: "\\\\Host\\Share\\Repo\\src\\MAIN.ts",
		});

		const slashUncMapper = new LspPathMapper([
			{ agentRoot: "//Host/Share/Repo", serverRootUri: "file://daemon/slash-workspace" },
		]);
		const slashUncUri = slashUncMapper.agentPathToServerUri("//host/share/repo/Src/Main.ts");
		expect(slashUncUri).toEqual({ ok: true, value: "file://daemon/slash-workspace/Src/Main.ts" });
		expect(slashUncUri.ok && slashUncMapper.serverUriToAgentPath(slashUncUri.value)).toEqual({
			ok: true,
			value: "\\\\Host\\Share\\Repo\\Src\\Main.ts",
		});
	});

	it("discovers markers through the active backend and invalidates cache on backend replacement", async () => {
		const accesses: string[][] = [[], []];
		const createOperations = (index: number, marker: string, cwd = "/repo"): ToolOperations =>
			({
				cwd,
				access: async (path: string) => {
					accesses[index]?.push(path);
					if (path !== marker) throw new Error("missing");
				},
				getBackendInfo: () => remoteBackendInfo(cwd, `backend-${index}`),
			}) as unknown as ToolOperations;
		const server = testServer({
			workspace: { type: "markers", markers: ["package.json"], fallback: "session" },
			pathMappings: [{ agentRoot: "/repo", serverRootUri: "file:///srv/repo" }],
		});
		const manager = new LspManager("/local-host-path", { configuration: { enabled: true, servers: [server] } });
		const first = createOperations(0, "/repo/pkg/package.json");
		await manager.setToolOperations(first);
		expect((await manager.getPrimaryTarget("/repo/pkg/src/index.ts"))?.workspaceRoot).toBe("/repo/pkg");
		expect(accesses[0]).toContain("/repo/pkg/package.json");

		const second = createOperations(1, "/repo/package.json");
		await manager.setToolOperations(second);
		expect((await manager.getPrimaryTarget("/repo/pkg/src/index.ts"))?.workspaceRoot).toBe("/repo");
		expect(accesses[1]).toContain("/repo/package.json");
		await manager.shutdownAll();
	});

	it("rejects marker discovery that finishes after backend replacement", async () => {
		let releaseAccess!: () => void;
		let markAccessStarted!: () => void;
		const accessGate = new Promise<void>((resolve) => {
			releaseAccess = resolve;
		});
		const accessStarted = new Promise<void>((resolve) => {
			markAccessStarted = resolve;
		});
		const server = testServer({
			workspace: { type: "markers", markers: ["package.json"], fallback: "session" },
			pathMappings: [{ agentRoot: "/repo", serverRootUri: "file:///srv/repo" }],
		});
		const manager = new LspManager("/local", { configuration: { enabled: true, servers: [server] } });
		const first = {
			cwd: "/repo",
			access: async () => {
				markAccessStarted();
				await accessGate;
			},
			getBackendInfo: () => remoteBackendInfo("/repo", "first"),
		} as unknown as ToolOperations;
		const second = {
			cwd: "/repo",
			access: async () => {
				throw new Error("missing");
			},
			getBackendInfo: () => remoteBackendInfo("/repo", "second"),
		} as unknown as ToolOperations;
		await manager.setToolOperations(first);
		const stale = manager.getPrimaryTarget("/repo/pkg/src/index.ts");
		await accessStarted;
		await manager.setToolOperations(second);
		releaseAccess();
		await expect(stale).resolves.toBeUndefined();
		expect((await manager.getPrimaryTarget("/repo/pkg/src/index.ts"))?.workspaceRoot).toBe("/repo");
		await manager.shutdownAll();
	});

	it("uses a replacement backend cwd as the session fallback root", async () => {
		const manager = new LspManager("/local", {
			configuration: {
				enabled: true,
				servers: [
					testServer({
						workspace: { type: "markers", markers: ["missing"], fallback: "session" },
						pathMappings: [{ agentRoot: "/remote", serverRootUri: "file:///srv/remote" }],
					}),
				],
			},
		});
		const operations = {
			cwd: "/remote",
			access: async () => {
				throw new Error("missing");
			},
			getBackendInfo: () => remoteBackendInfo("/remote", "backend"),
		} as unknown as ToolOperations;
		await manager.setToolOperations(operations);
		expect((await manager.getPrimaryTarget("src/index.ts"))?.workspaceRoot).toBe("/remote");
		await manager.shutdownAll();
	});

	it("disposes stale clients when the active backend identity and cwd change", async () => {
		const clients: FakeLspClient[] = [];
		const server = testServer({
			pathMappings: [
				{ agentRoot: "/first", serverRootUri: "file:///srv/first" },
				{ agentRoot: "/second", serverRootUri: "file:///srv/second" },
			],
		});
		const manager = new LspManager("/local", {
			configuration: { enabled: true, servers: [server] },
			createClient: (options) => {
				const client = new FakeLspClient(options);
				clients.push(client);
				return client;
			},
		});
		const operations = (cwd: string, remote: string) =>
			({
				cwd,
				access: async () => {},
				getBackendInfo: () => remoteBackendInfo(cwd, remote),
			}) as unknown as ToolOperations;
		await manager.setToolOperations(operations("/first", "first"));
		const firstClient = await manager.getClientForFile("src/index.ts");
		expect(firstClient).toBe(clients[0]);
		await manager.setToolOperations(operations("/second", "second"));
		expect(clients[0]?.isDisposed).toBe(true);
		expect(manager.cwd).toBe("/second");
		expect((await manager.getPrimaryTarget("src/index.ts"))?.workspaceRoot).toBe("/second");
		await manager.shutdownAll();
	});

	it("rejects paths and URIs outside mappings and non-file server URIs", () => {
		const mapper = new LspPathMapper([{ agentRoot: "/agent/project", serverRootUri: "file:///server/project" }]);
		expect(mapper.agentPathToServerUri("/agent/other/file.ts")).toMatchObject({
			ok: false,
			reason: expect.stringContaining("outside all configured agent path mappings"),
		});
		expect(mapper.serverUriToAgentPath("file:///server/other/file.ts")).toMatchObject({
			ok: false,
			reason: expect.stringContaining("outside all configured server path mappings"),
		});
		expect(mapper.serverUriToAgentPath("untitled:buffer")).toMatchObject({
			ok: false,
			reason: expect.stringContaining("not a file URI"),
		});
		const unmapped = new LspPathMapper();
		for (const malformed of ["file:relative", "file:///C:", "file://host/"]) {
			expect(unmapped.serverUriToAgentPath(malformed)).toMatchObject({ ok: false });
		}
		expect(unmapped.serverUriToAgentPath("file:///C:/")).toEqual({ ok: true, value: "C:\\" });
	});
});

describe("external LSP configuration", () => {
	const baseServer = {
		id: "typescript",
		selectors: [
			{ languageId: "typescript", pattern: "**/*.ts" },
			{ languageId: "typescriptreact", pattern: "**/*.tsx" },
		],
		transport: { type: "spawn", command: "typescript-language-server", args: ["--stdio"] },
		lifecycle: { type: "managed" },
		workspace: { type: "markers", markers: ["tsconfig.json", "package.json"], fallback: "session" },
		pathMappings: [{ agentRoot: ".", serverRootUri: "file:///workspace/project" }],
		initializationOptions: { preferences: { includePackageJsonAutoImports: "on" } },
		settings: { typescript: { format: { enable: true } } },
		clientInfo: { name: "pi", version: "1.2.3" },
		locale: "en-US",
		trace: "messages",
		features: { diagnostics: true, hover: true, rename: false },
		priority: 10,
		timeouts: { connectMs: 5000, initializeMs: 10000, requestMs: 30000, shutdownMs: 3000 },
	};

	it("parses server IDs independently from selectors and all supported transport kinds", () => {
		const input = {
			servers: [
				baseServer,
				{
					...baseServer,
					id: "eslint",
					selectors: [{ languageId: "javascript", pattern: "**/*.js" }],
					transport: { type: "tcp", host: "127.0.0.1", port: 2089 },
					lifecycle: { type: "attached", shutdown: "disconnect" },
					workspace: { type: "session" },
				},
				{
					...baseServer,
					id: "rust",
					selectors: [{ languageId: "rust", pattern: "**/*.rs" }],
					transport: { type: "unix", path: "/run/lsp/rust.sock" },
					lifecycle: { type: "attached", shutdown: "protocol" },
					workspace: { type: "fixed", path: "../rust" },
				},
				{
					...baseServer,
					id: "csharp",
					selectors: [{ languageId: "csharp", pattern: "**/*.cs" }],
					transport: { type: "pipe", path: "\\\\.\\pipe\\csharp-lsp" },
					lifecycle: { type: "attached" },
				},
				{
					...baseServer,
					id: "host",
					selectors: [{ languageId: "custom", pattern: "**/*.custom", scheme: "file" }],
					transport: { type: "connection", id: "host-lsp" },
					lifecycle: { type: "attached" },
				},
			],
		};

		const result = parseLspConfiguration(input);

		expect(result.diagnostics).toEqual([]);
		expect(result.configuration?.servers).toHaveLength(5);
		expect(result.configuration?.servers?.[0]).toMatchObject({
			id: "typescript",
			selectors: [{ languageId: "typescript" }, { languageId: "typescriptreact" }],
			priority: 10,
			clientInfo: { name: "pi", version: "1.2.3" },
			locale: "en-US",
			trace: "messages",
		});
	});

	it("returns path-specific diagnostics for invalid and ambiguous input", () => {
		const result = parseLspConfiguration({
			servers: [
				{
					...baseServer,
					selectors: [
						{ languageId: "typescript", pattern: "**/*.ts" },
						{ languageId: "javascript", pattern: "**/*.ts" },
					],
					transport: { type: "tcp", host: "localhost", port: 70000 },
					lifecycle: { type: "managed" },
					pathMappings: [
						{ agentRoot: ".", serverRootUri: "workspace/project" },
						{ agentRoot: ".", serverRootUri: "file:///other" },
					],
				},
				baseServer,
			],
		});

		expect(result.configuration).toBeUndefined();
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: "$.servers[0].selectors[1]",
					message: expect.stringContaining("ambiguous"),
				}),
				expect.objectContaining({ path: "$.servers[0].transport.port", message: expect.stringContaining("65535") }),
				expect.objectContaining({
					path: "$.servers[0].lifecycle.type",
					message: expect.stringContaining("attached"),
				}),
				expect.objectContaining({ path: "$.servers[0].pathMappings[0].serverRootUri" }),
				expect.objectContaining({
					path: "$.servers[0].pathMappings[1].agentRoot",
					message: expect.stringContaining("duplicates"),
				}),
				expect.objectContaining({ path: "$.servers[1].id", message: expect.stringContaining("duplicates") }),
			]),
		);
	});

	it("rejects drive-relative and incomplete authority file URI mapping roots", () => {
		for (const serverRootUri of ["file:relative", "file:///C:", "file://host/"]) {
			const result = parseLspConfiguration({
				servers: [
					{
						...baseServer,
						pathMappings: [{ agentRoot: "/agent", serverRootUri }],
					},
				],
			});
			expect(result.configuration).toBeUndefined();
			expect(result.diagnostics).toEqual(
				expect.arrayContaining([expect.objectContaining({ path: "$.servers[0].pathMappings[0].serverRootUri" })]),
			);
		}
	});

	it("rejects unsafe relative endpoint paths and non-JSON options", () => {
		const circular: { self?: unknown } = {};
		circular.self = circular;
		const result = parseLspConfiguration({
			servers: [
				{
					...baseServer,
					transport: { type: "unix", path: "../run/lsp.sock" },
					lifecycle: { type: "attached" },
					initializationOptions: circular,
				},
				{
					...baseServer,
					id: "empty-pipe",
					transport: { type: "pipe", path: "\\\\.\\pipe\\" },
					lifecycle: { type: "attached" },
				},
			],
		});

		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: "$.servers[0].transport.path",
					message: expect.stringContaining("absolute"),
				}),
				expect.objectContaining({
					path: "$.servers[0].initializationOptions.self",
					message: expect.stringContaining("circular"),
				}),
				expect.objectContaining({
					path: "$.servers[1].transport.path",
					message: expect.stringContaining("absolute"),
				}),
			]),
		);
	});

	it("rejects equivalent path mappings after syntactic normalization", () => {
		const result = parseLspConfiguration({
			servers: [
				{
					...baseServer,
					pathMappings: [
						{ agentRoot: ".", serverRootUri: "file:///workspace/project/" },
						{ agentRoot: "./", serverRootUri: "file:/workspace/project" },
					],
				},
			],
		});

		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "$.servers[0].pathMappings[1].agentRoot" }),
				expect.objectContaining({ path: "$.servers[0].pathMappings[1].serverRootUri" }),
			]),
		);
	});

	it("rejects non-reversible overlapping path mappings and accepts isomorphic overlaps", () => {
		const invalid = parseLspConfiguration({
			servers: [
				{
					...baseServer,
					pathMappings: [
						{ agentRoot: "/agent", serverRootUri: "file:///srv" },
						{ agentRoot: "/agent/pkg", serverRootUri: "file:///other" },
					],
				},
			],
		});
		const valid = parseLspConfiguration({
			servers: [
				{
					...baseServer,
					pathMappings: [
						{ agentRoot: "/agent", serverRootUri: "file:///srv" },
						{ agentRoot: "/agent/pkg", serverRootUri: "file:///srv/pkg" },
					],
				},
			],
		});
		const validUncCaseVariants = parseLspConfiguration({
			servers: [
				{
					...baseServer,
					pathMappings: [
						{ agentRoot: "\\\\Host\\Share", serverRootUri: "file://Daemon/Workspace" },
						{ agentRoot: "\\\\host\\share\\Pkg", serverRootUri: "file://daemon/WORKSPACE/pkg" },
					],
				},
			],
		});
		const invalidMixedCaseSemantics = parseLspConfiguration({
			servers: [
				{
					...baseServer,
					pathMappings: [
						{ agentRoot: "/repo", serverRootUri: "file://daemon/workspace" },
						{ agentRoot: "/repo/Pkg", serverRootUri: "file://daemon/workspace/pkg" },
					],
				},
			],
		});
		const distinctPosixBackslashes = parseLspConfiguration({
			servers: [
				{
					...baseServer,
					pathMappings: [
						{ agentRoot: "/repo/a\\b", serverRootUri: "file:///server/backslash" },
						{ agentRoot: "/repo/a/b", serverRootUri: "file:///server/slash" },
					],
				},
			],
		});

		expect(invalid.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: "$.servers[0].pathMappings[1].agentRoot",
					message: expect.stringContaining("overlaps mapping 0"),
				}),
			]),
		);
		expect(valid.diagnostics).toEqual([]);
		expect(validUncCaseVariants.diagnostics).toEqual([]);
		expect(invalidMixedCaseSemantics.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: "$.servers[0].pathMappings[1].agentRoot",
					message: expect.stringContaining("overlaps mapping 0"),
				}),
			]),
		);
		expect(distinctPosixBackslashes.diagnostics).toEqual([]);
	});

	it("resolves absence, merge, replacement, server disablement, and runtime disablement", () => {
		const parsedBase = parseLspConfiguration({ servers: [baseServer] }).configuration;
		const parsedMerge = parseLspConfiguration({
			servers: [
				{ ...baseServer, priority: 50 },
				{ ...baseServer, id: "eslint", selectors: [{ languageId: "javascript", pattern: "**/*.js" }] },
			],
		}).configuration;
		const parsedDisable = parseLspConfiguration({ servers: [{ id: "typescript", enabled: false }] }).configuration;
		const parsedReplace = parseLspConfiguration({
			mode: "replace",
			enabled: false,
			servers: [baseServer],
		}).configuration;

		expect(resolveLspConfiguration([])).toEqual({ enabled: false, servers: [] });
		expect(resolveLspConfiguration([undefined, parsedBase, parsedMerge])).toMatchObject({
			enabled: true,
			servers: [{ id: "typescript", priority: 50 }, { id: "eslint" }],
		});
		expect(resolveLspConfiguration([parsedBase, parsedDisable])).toEqual({ enabled: true, servers: [] });
		expect(resolveLspConfiguration([parsedMerge, parsedReplace])).toMatchObject({
			enabled: false,
			servers: [{ id: "typescript" }],
		});
	});
});
