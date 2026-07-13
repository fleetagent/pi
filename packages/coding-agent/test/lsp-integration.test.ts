import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Diagnostic } from "vscode-languageserver-protocol";
import { DiagnosticSeverity } from "vscode-languageserver-protocol";
import type { MessageConnection } from "vscode-languageserver-protocol/node.js";
import type { ExtensionAPI, ExtensionContext, ToolDefinition, ToolResultEvent } from "../src/core/extensions/types.ts";
import { LspClient } from "../src/core/lsp/client.ts";
import { createLspDiagnosticsTool, formatAutoDiagnosticsForChangedFile } from "../src/core/lsp/diagnostics.ts";
import { LspFileSync } from "../src/core/lsp/file-sync.ts";
import { type LspRuntimeState, registerLspLifecycleHandlers } from "../src/core/lsp/integration.ts";
import { LspManager } from "../src/core/lsp/manager.ts";
import { createLspDefinitionTool, createLspHoverTool, createLspReferencesTool } from "../src/core/lsp/navigation.ts";
import { createLspCodeActionsTool, createLspRenameTool } from "../src/core/lsp/refactor.ts";
import { PiAgent } from "../src/core/pi-agent.ts";
import { LocalToolOperations } from "../src/core/tools/index.ts";

const tempDirs: string[] = [];

class FakeLspClient extends LspClient {
	private fakeInitialized = false;
	private fakeDisposed = false;
	readonly requests: Array<{ method: string; params: unknown }> = [];
	readonly notifications: Array<{ method: string; params: unknown }> = [];
	private readonly responses = new Map<string, unknown>();
	private readonly fakeDiagnostics = new Map<string, Diagnostic[]>();

	override get isInitialized(): boolean {
		return this.fakeInitialized;
	}

	override get isDisposed(): boolean {
		return this.fakeDisposed;
	}

	setResponse(method: string, response: unknown): void {
		this.responses.set(method, response);
	}

	setDiagnostics(uri: string, diagnostics: Diagnostic[]): void {
		this.fakeDiagnostics.set(uri, diagnostics);
	}

	override async start(): Promise<{ capabilities: Record<string, never> }> {
		this.fakeInitialized = true;
		return { capabilities: {} };
	}

	override async sendRequest<TResult>(method: string, params: unknown): Promise<TResult> {
		this.requests.push({ method, params });
		return this.responses.get(method) as TResult;
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

	override async shutdown(): Promise<void> {
		this.fakeDisposed = true;
		this.fakeInitialized = false;
	}
}

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-lsp-test-"));
	tempDirs.push(dir);
	return dir;
}

function text(result: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
	const content = result.content[0];
	return content?.type === "text" ? content.text : "";
}

function createContext(cwd: string): ExtensionContext {
	return { cwd, toolOperations: new LocalToolOperations(cwd) } as unknown as ExtensionContext;
}

async function createStateWithClient(
	responses: Record<string, unknown> = {},
	diagnostics: Record<string, Diagnostic[]> = {},
): Promise<{ cwd: string; state: LspRuntimeState; client: FakeLspClient }> {
	const cwd = await createTempDir();
	await writeFile(join(cwd, "fixture.ts"), "const value = 1;\nvalue;\n", "utf8");
	let client: FakeLspClient | undefined;
	const manager = new LspManager(cwd, {
		serverConfigs: { typescript: { command: "fake", args: [] } },
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
			serverConfigs: { typescript: { command: "fake", args: [] } },
			createClient: (options) => {
				const client = new FakeLspClient(options);
				created.push(client);
				return client;
			},
		});

		expect(manager.getRunningClient("typescript")).toBeUndefined();
		const first = await manager.getClientForFile("fixture.ts");
		const second = await manager.getClientForFile("fixture.ts");

		expect(first).toBe(second);
		expect(created).toHaveLength(1);
		expect(manager.getRunningClient("typescript")).toBe(first);

		await manager.shutdownAll();
		expect(created[0]?.isDisposed).toBe(true);
		expect(manager.getRunningClient("typescript")).toBeUndefined();
	});

	it("awaits and contains a failed exit notification during shutdown", async () => {
		const cwd = await createTempDir();
		const client = new LspClient({ command: "fake", args: [], rootDir: cwd, languageId: "typescript" });
		let rejectExit!: (reason: Error) => void;
		let exitAttempted = false;
		const exitWrite = new Promise<void>((_resolve, reject) => {
			rejectExit = reject;
		});
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

		let settled = false;
		const shutdown = client.shutdown();
		void shutdown.then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(exitAttempted).toBe(true);
		expect(settled).toBe(false);
		rejectExit(Object.assign(new Error("stream destroyed"), { code: "ERR_STREAM_DESTROYED" }));
		await expect(shutdown).resolves.toBeUndefined();
	});

	it("surfaces notification write failures while active", async () => {
		const cwd = await createTempDir();
		const client = new LspClient({ command: "fake", args: [], rootDir: cwd, languageId: "typescript" });
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

	it("keeps current default tools active when a resumed session provides the core default tool list", async () => {
		const cwd = await createTempDir();
		const agentDir = await createTempDir();
		const runtime = await PiAgent.create({
			cwd,
			agentDir,
			tools: ["read", "bash", "edit", "write"],
		});
		const session = await runtime.createAgentSession();

		expect(session.getActiveToolNames()).toEqual(
			expect.arrayContaining([
				"read",
				"bash",
				"edit",
				"write",
				"lsp_diagnostics",
				"lsp_hover",
				"lsp_definition",
				"lsp_references",
				"lsp_rename",
				"lsp_code_actions",
			]),
		);

		session.dispose();
	});
});

describe("LSP tool formatting", () => {
	it("returns diagnostics from the cache and exposes schema", async () => {
		const { state } = await createStateWithClient();
		const uri = state.manager.getFileUri("fixture.ts");
		const client = state.manager.getRunningClient("typescript") as FakeLspClient | undefined;
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
	});

	it("formats hover, definition, and references compactly", async () => {
		const { state } = await createStateWithClient({
			"textDocument/hover": { contents: { kind: "markdown", value: "```ts\nconst value: number\n```" } },
			"textDocument/definition": {
				uri: stateUriPlaceholder("fixture.ts"),
				range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
			},
			"textDocument/references": Array.from({ length: 82 }, (_, index) => ({
				uri: stateUriPlaceholder("fixture.ts"),
				range: { start: { line: index, character: 1 }, end: { line: index, character: 6 } },
			})),
		});
		const definitionResponse = {
			uri: state.manager.getFileUri("fixture.ts"),
			range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
		};
		const referencesResponse = Array.from({ length: 82 }, (_, index) => ({
			uri: state.manager.getFileUri("fixture.ts"),
			range: { start: { line: index, character: 1 }, end: { line: index, character: 6 } },
		}));
		const client = state.manager.getRunningClient("typescript") as FakeLspClient | undefined;
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

	it("formats rename and code action edit previews without applying changes", async () => {
		const { state } = await createStateWithClient();
		const uri = state.manager.getFileUri("fixture.ts");
		const client = state.manager.getRunningClient("typescript") as FakeLspClient | undefined;
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
		expect(text(actions)).toContain("No changes were applied.");
		expect(text(actions)).toContain('1:7-1:12 -> "renamed"');
	});
});

describe("LSP auto diagnostics", () => {
	it("does not start a client when no server is running", async () => {
		const cwd = await createTempDir();
		let starts = 0;
		const manager = new LspManager(cwd, {
			serverConfigs: { typescript: { command: "fake", args: [] } },
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
			serverConfigs: { typescript: { command: "fake", args: [] } },
			createClient: (options) => {
				client = new FakeLspClient(options);
				return client;
			},
		});
		const ctx = createContext(cwd);
		handlers.get("session_start")?.({}, ctx);
		await getState().manager.getClientForFile("fixture.ts");
		const uri = getState().manager.getFileUri("fixture.ts");
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

function stateUriPlaceholder(path: string): string {
	return `file:///placeholder/${path}`;
}
