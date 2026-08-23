import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@fleetagent/pi-agent-core";
import { getModel, validateToolArguments } from "@fleetagent/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { InMemorySessionManager } from "../src/core/session/in-memory-session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { BashToolDetails } from "../src/core/tools/bash.ts";
import {
	LocalToolOperations,
	type ToolExecOptions,
	type ToolGlobOptions,
	type ToolGrepOptions,
	type ToolGrepResult,
} from "../src/core/tools/operations.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";
import { WORKSPACE_TOOL_NAMES, WorkspaceToolHost } from "../src/core/tools/workspace-tool-host.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;
const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-workspace-host-"));
	temporaryDirectories.push(directory);
	return directory;
}

function createSession(cwd: string, operations: LocalToolOperations): AgentSession {
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	return new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "test",
				tools: [],
				thinkingLevel: "off",
			},
		}),
		session: new InMemorySessionManager(cwd).create(),
		settingsManager: SettingsManager.inMemory(),
		cwd,
		resourceLoader: createTestResourceLoader(),
		toolOperations: operations,
		modelRegistry: ModelRegistry.inMemory(authStorage),
	});
}

class BlockingOperations extends LocalToolOperations {
	disposeCalls = 0;

	async exec(_command: string, options: ToolExecOptions): Promise<{ exitCode: number | null }> {
		options.onData(Buffer.from("started"));
		return new Promise((resolve, reject) => {
			const onAbort = () => reject(new Error("aborted"));
			if (options.signal?.aborted) {
				onAbort();
				return;
			}
			options.signal?.addEventListener("abort", onAbort, { once: true });
			void resolve;
		});
	}

	async dispose(): Promise<void> {
		this.disposeCalls++;
	}
}

class DeterministicOperations extends LocalToolOperations {
	async exec(_command: string, options: ToolExecOptions): Promise<{ exitCode: number | null }> {
		options.onData(Buffer.from("canonical output"));
		return { exitCode: 0 };
	}

	async glob(_pattern: string, cwd: string, _options: ToolGlobOptions): Promise<string[]> {
		return [join(cwd, "sample.txt")];
	}

	async grep(options: ToolGrepOptions): Promise<ToolGrepResult> {
		return {
			isDirectory: true,
			matches: [{ filePath: join(options.path, "sample.txt"), lineNumber: 1, lineText: "needle\n" }],
		};
	}
}

class LargeOutputOperations extends DeterministicOperations {
	async exec(_command: string, options: ToolExecOptions): Promise<{ exitCode: number | null }> {
		options.onData(Buffer.alloc(DEFAULT_MAX_BYTES + 100, "x"));
		return { exitCode: 0 };
	}
}

class OrderedWriteOperations extends DeterministicOperations {
	activeWrites = 0;
	maxActiveWrites = 0;

	async writeFile(path: string, content: string | Buffer): Promise<void> {
		this.activeWrites++;
		this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
		try {
			if (content.toString().startsWith("first")) await new Promise((resolve) => setTimeout(resolve, 20));
			await super.writeFile(path, content);
		} finally {
			this.activeWrites--;
		}
	}
}

class UncooperativeOperations extends BlockingOperations {
	async exec(): Promise<{ exitCode: number | null }> {
		return new Promise(() => undefined);
	}
}

async function executeSessionTool(
	session: AgentSession,
	name: string,
	arguments_: Record<string, unknown>,
	onUpdate?: (update: unknown) => void,
) {
	const tool = session.agent.state.tools.find((candidate) => candidate.name === name)!;
	const prepared = tool.prepareArguments?.(arguments_) ?? arguments_;
	const validated = validateToolArguments(tool, {
		type: "toolCall",
		id: `session-${name}`,
		name,
		arguments: prepared,
	});
	return tool.execute(`session-${name}`, validated, undefined, onUpdate);
}

function normalizePaths(value: unknown, paths: string[]): unknown {
	let serialized = JSON.stringify(value);
	for (const path of paths) serialized = serialized.replaceAll(path, "<path>");
	return JSON.parse(serialized);
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("WorkspaceToolHost", () => {
	it("catalogs only canonical workspace tools without an agent or session runtime", async () => {
		const cwd = await createTemporaryDirectory();
		const host = new WorkspaceToolHost({ cwd });
		try {
			expect(host.getCatalog().map((entry) => entry.name)).toEqual(WORKSPACE_TOOL_NAMES);
			expect(host.getDefinition("subagent")).toBeUndefined();
			expect(host.getDefinition("load_tool")).toBeUndefined();
			expect(host.getDefinition("session_search")).toBeUndefined();
			expect(host.getDefinition("session_entry_get")).toBeUndefined();
			expect(host.getDefinition("lsp_diagnostics")).toBeUndefined();
			expect(() => host.prepareArguments("subagent", {})).toThrow("Unknown or non-workspace tool");
		} finally {
			await host.dispose();
		}
	});

	it("enforces a closed tool surface, immutable catalog authority, and workspace identity", async () => {
		const cwd = await createTemporaryDirectory();
		const operations = new LocalToolOperations(cwd);
		const independentReadDefinition = createReadToolDefinition(operations);
		const host = new WorkspaceToolHost({ cwd, operations, toolNames: ["read"] });
		try {
			expect(Object.isFrozen(WORKSPACE_TOOL_NAMES)).toBe(true);
			expect(() => (WORKSPACE_TOOL_NAMES as unknown as string[]).push("subagent")).toThrow();
			expect(host.getCatalog().map((entry) => entry.name)).toEqual(["read"]);
			expect(host.getDefinition("bash")).toBeUndefined();
			const exposedDefinitions = host.getDefinitions() as Map<string, unknown>;
			exposedDefinitions.clear();
			expect(host.getDefinition("read")).toBeDefined();
			expect(Object.isFrozen(host.getDefinition("read"))).toBe(true);
			expect(Object.isFrozen(host.getDefinition("read")?.parameters)).toBe(true);
			expect(Object.isFrozen(host.getDefinition("read")?.promptGuidelines)).toBe(true);
			expect(Object.isFrozen(independentReadDefinition.parameters)).toBe(false);
			expect(() => new WorkspaceToolHost({ cwd: join(cwd, "other"), operations })).toThrow(
				"does not match operations cwd",
			);
		} finally {
			await host.dispose();
		}
	});

	it("matches AgentSession definitions and execution for every workspace tool", async () => {
		const cwd = await createTemporaryDirectory();
		const filePath = join(cwd, "sample.txt");
		await writeFile(filePath, "needle\n", "utf8");
		const operations = new DeterministicOperations(cwd);
		const host = new WorkspaceToolHost({ cwd, operations });
		const session = createSession(cwd, operations);
		session.setActiveToolsByName([...WORKSPACE_TOOL_NAMES]);
		try {
			for (const name of WORKSPACE_TOOL_NAMES) {
				const hostDefinition = host.getDefinition(name)!;
				const sessionDefinition = session.getToolDefinition(name)!;
				expect(sessionDefinition.parameters).toEqual(hostDefinition.parameters);
				expect(sessionDefinition.label).toBe(hostDefinition.label);
				expect(sessionDefinition.description).toBe(hostDefinition.description);
				expect(typeof sessionDefinition.prepareArguments).toBe(typeof hostDefinition.prepareArguments);
				expect(sessionDefinition.executionMode).toBe(hostDefinition.executionMode);
				expect(typeof sessionDefinition.renderCall).toBe(typeof hostDefinition.renderCall);
				expect(typeof sessionDefinition.renderResult).toBe(typeof hostDefinition.renderResult);
			}

			const sharedCases: Array<[string, Record<string, unknown>]> = [
				["read", { path: filePath }],
				["bash", { command: "ignored" }],
				["grep", { pattern: "needle", path: cwd }],
				["find", { pattern: "*.txt", path: cwd }],
				["ls", { path: cwd }],
			];
			for (const [name, arguments_] of sharedCases) {
				const hostUpdates: unknown[] = [];
				const sessionUpdates: unknown[] = [];
				const hostResult = await host.execute(name, {
					toolCallId: `host-${name}`,
					arguments: arguments_,
					onUpdate: (update) => hostUpdates.push(update),
				});
				const sessionResult = await executeSessionTool(session, name, arguments_, (update) =>
					sessionUpdates.push(update),
				);
				expect(sessionResult).toEqual(hostResult);
				expect(sessionUpdates).toEqual(hostUpdates);
			}

			const hostWritePath = join(cwd, "host-write.txt");
			const sessionWritePath = join(cwd, "session-write.txt");
			const hostWrite = await host.execute("write", {
				toolCallId: "host-write",
				arguments: { path: hostWritePath, content: "before\n" },
			});
			const sessionWrite = await executeSessionTool(session, "write", {
				path: sessionWritePath,
				content: "before\n",
			});
			expect(normalizePaths(sessionWrite, [sessionWritePath])).toEqual(normalizePaths(hostWrite, [hostWritePath]));

			const beforeEdit = await host.execute("read", {
				toolCallId: "hash-edit",
				arguments: { path: hostWritePath },
			});
			const readText = beforeEdit.content.find((content) => content.type === "text")?.text ?? "";
			const lineHash = readText.match(/^([A-Za-z0-9_-]{3})│before$/m)?.[1];
			expect(lineHash).toBeDefined();
			const change = [{ hash_range_inclusive: [lineHash!, lineHash!], content_lines: ["after"] }];
			const hostEdit = await host.execute("edit", {
				toolCallId: "host-edit",
				arguments: { path: hostWritePath, changes: change },
			});
			const sessionEdit = await executeSessionTool(session, "edit", { path: sessionWritePath, changes: change });
			expect(normalizePaths(sessionEdit, [sessionWritePath])).toEqual(normalizePaths(hostEdit, [hostWritePath]));
		} finally {
			await session.dispose();
			await host.dispose();
		}
	});

	it("preserves truncation and full-output artifact semantics through AgentSession", async () => {
		const cwd = await createTemporaryDirectory();
		const operations = new LargeOutputOperations(cwd);
		const host = new WorkspaceToolHost({ cwd, operations });
		const session = createSession(cwd, operations);
		let hostOutputPath: string | undefined;
		let sessionOutputPath: string | undefined;
		try {
			const hostResult = await host.execute("bash", { toolCallId: "host-large", arguments: { command: "large" } });
			const sessionResult = await executeSessionTool(session, "bash", { command: "large" });
			const hostDetails = hostResult.details as BashToolDetails;
			const sessionDetails = sessionResult.details as BashToolDetails;
			hostOutputPath = hostDetails.fullOutputPath;
			sessionOutputPath = sessionDetails.fullOutputPath;
			expect(hostDetails.truncation).toEqual(sessionDetails.truncation);
			expect(hostDetails.truncation?.truncated).toBe(true);
			expect(hostOutputPath).toBeDefined();
			expect(sessionOutputPath).toBeDefined();
			expect(await readFile(hostOutputPath!)).toEqual(await readFile(sessionOutputPath!));
			expect(normalizePaths(sessionResult, [sessionOutputPath!])).toEqual(
				normalizePaths(hostResult, [hostOutputPath!]),
			);
		} finally {
			await session.dispose();
			await host.dispose();
			if (hostOutputPath) await rm(hostOutputPath, { force: true });
			if (sessionOutputPath) await rm(sessionOutputPath, { force: true });
		}
	});

	it("shares canonical same-path mutation ordering with AgentSession", async () => {
		const cwd = await createTemporaryDirectory();
		const filePath = join(cwd, "ordered.txt");
		const operations = new OrderedWriteOperations(cwd);
		const host = new WorkspaceToolHost({ cwd, operations });
		const session = createSession(cwd, operations);
		try {
			const first = host.execute("write", {
				toolCallId: "host-first",
				arguments: { path: filePath, content: "first\n" },
			});
			const second = executeSessionTool(session, "write", { path: filePath, content: "second\n" });
			await Promise.all([first, second]);
			expect(operations.maxActiveWrites).toBe(1);
			expect(await readFile(filePath, "utf8")).toBe("second\n");
		} finally {
			await session.dispose();
			await host.dispose();
		}
	});

	it("restores the previous hosted runtime when a reload build fails", async () => {
		const cwd = await createTemporaryDirectory();
		const filePath = join(cwd, "reload.txt");
		await writeFile(filePath, "still available\n", "utf8");
		const operations = new LocalToolOperations(cwd);
		const session = createSession(cwd, operations);
		const previousReadDefinition = session.getToolDefinition("read");
		const internals = session as unknown as { _refreshToolRegistry: () => void };
		const refreshToolRegistry = internals._refreshToolRegistry.bind(session);
		internals._refreshToolRegistry = () => {
			throw new Error("injected registry failure");
		};
		try {
			await expect(session.reload()).rejects.toThrow("injected registry failure");
			internals._refreshToolRegistry = refreshToolRegistry;
			expect(session.getToolDefinition("read")).toBe(previousReadDefinition);
			const result = await executeSessionTool(session, "read", { path: filePath });
			expect(result.content.find((content) => content.type === "text")?.text).toContain("still available");
		} finally {
			internals._refreshToolRegistry = refreshToolRegistry;
			await session.dispose();
		}
	});

	it("prepares raw arguments once and validates already-prepared invocations", async () => {
		const cwd = await createTemporaryDirectory();
		const filePath = join(cwd, "edit.txt");
		await writeFile(filePath, "before\n", "utf8");
		const host = new WorkspaceToolHost({ cwd });
		const readResult = await host.execute("read", { toolCallId: "read-before-edit", arguments: { path: filePath } });
		const readText = readResult.content.find((content) => content.type === "text")?.text ?? "";
		const lineHash = readText.match(/^([A-Za-z0-9_-]{3})│before$/m)?.[1];
		expect(lineHash).toBeDefined();
		const legacyArguments = {
			file_path: filePath,
			changes: [{ hash_range_inclusive: [lineHash!, lineHash!], content_lines: ["after"] }],
		};
		try {
			await expect(
				host.executePrepared("edit", { toolCallId: "unprepared", arguments: legacyArguments }),
			).rejects.toThrow('Validation failed for tool "edit"');
			await host.execute("edit", { toolCallId: "prepared", arguments: legacyArguments });
			expect(await readFile(filePath, "utf8")).toBe("after\n");
			await expect(host.execute("read", { toolCallId: "invalid", arguments: {} })).rejects.toThrow(
				'Validation failed for tool "read"',
			);
		} finally {
			await host.dispose();
		}
	});

	it("streams updates, propagates cancellation, and does not dispose borrowed operations", async () => {
		const cwd = await createTemporaryDirectory();
		const operations = new BlockingOperations(cwd);
		const host = new WorkspaceToolHost({ cwd, operations });
		const updates: unknown[] = [];
		const execution = host.execute("bash", {
			toolCallId: "blocking-bash",
			arguments: { command: "blocked" },
			onUpdate: (update) => updates.push(update),
		});
		const disposal = host.dispose();
		await expect(execution).rejects.toThrow("aborted");
		await disposal;
		expect(updates.length).toBeGreaterThan(0);
		expect(operations.disposeCalls).toBe(0);
		await host.dispose();
		expect(operations.disposeCalls).toBe(0);
		await expect(host.execute("read", { toolCallId: "late", arguments: { path: "x" } })).rejects.toThrow(
			"Workspace tool host is disposed",
		);
	});

	it("disposes explicitly owned operations exactly once", async () => {
		const cwd = await createTemporaryDirectory();
		const operations = new BlockingOperations(cwd);
		const host = new WorkspaceToolHost({ cwd, operations, ownsOperations: true });
		await Promise.all([host.dispose(), host.dispose()]);
		expect(operations.disposeCalls).toBe(1);
	});

	it("bounds disposal when an invocation ignores cancellation", async () => {
		const cwd = await createTemporaryDirectory();
		const operations = new UncooperativeOperations(cwd);
		const host = new WorkspaceToolHost({
			cwd,
			operations,
			ownsOperations: true,
			disposeTimeoutMs: 10,
		});
		void host.execute("bash", { toolCallId: "uncooperative", arguments: { command: "blocked" } });
		await host.dispose();
		expect(operations.disposeCalls).toBe(1);
	});
});
