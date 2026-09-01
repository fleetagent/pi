import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@fleetagent/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type {
	ToolBackendInfo,
	ToolExecOptions,
	ToolExecResult,
	ToolOperations,
	WorkspaceToolExecutionTarget,
	WorkspaceToolRemoteInvocation,
} from "../src/core/tools/operations.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { WorkspaceToolHost } from "../src/core/tools/workspace-tool-host.ts";
import { createHarness } from "./suite/harness.ts";

class ReadOnlyOperations implements ToolOperations {
	cwd: string;
	backend: ToolBackendInfo;
	readPaths: string[] = [];
	remoteReadPaths: string[] = [];

	constructor(cwd: string, backend: ToolBackendInfo) {
		this.cwd = cwd;
		this.backend = backend;
	}

	async exec(_command: string, _options: ToolExecOptions): Promise<ToolExecResult> {
		return { exitCode: 0 };
	}

	async access(): Promise<void> {}

	async readFile(path: string): Promise<Buffer> {
		this.readPaths.push(path);
		return Buffer.from(`read via ${this.backend.type}`);
	}

	async writeFile(): Promise<void> {}

	async mkdir(): Promise<void> {}

	async stat() {
		return { isDirectory: () => false, isFile: () => true };
	}

	async readdir(): Promise<string[]> {
		return [];
	}

	async detectImageMimeType(): Promise<undefined> {
		return undefined;
	}

	getBackendInfo(): ToolBackendInfo {
		return this.backend;
	}

	resolveWorkspaceToolExecution(): WorkspaceToolExecutionTarget {
		return this.backend.type === "remote" ? "remote" : "local";
	}

	async executeWorkspaceTool(
		name: string,
		invocation: WorkspaceToolRemoteInvocation,
	): Promise<AgentToolResult<unknown>> {
		const path = (invocation.arguments as { path?: unknown }).path;
		if (name === "read" && typeof path === "string") this.remoteReadPaths.push(path);
		return { content: [{ type: "text", text: `read via remote executor: ${String(path)}` }], details: undefined };
	}
}

describe("read tool backend routing", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "read-route-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("uses a path-selected backend for local resource reads", async () => {
		const localPath = join(tempDir, "local-skill", "SKILL.md");
		mkdirSync(join(tempDir, "local-skill"));
		writeFileSync(localPath, "local skill");
		const remoteOps = new ReadOnlyOperations("/workspace", {
			type: "remote",
			cwd: "/workspace",
			url: "ws://127.0.0.1:8787",
			protocol: "ws",
			configured: true,
			workspace: { id: "test-workspace-id", root: "/workspace", pathFlavor: "posix" },
		});
		const localOps = new ReadOnlyOperations(tempDir, { type: "local", cwd: tempDir });
		const definition = createReadToolDefinition(remoteOps, {
			operationsForPath: (path) => (path === localPath ? localOps : undefined),
		});

		const result = await definition.execute(
			"tool-1",
			{ path: localPath },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(result.content).toEqual([
			{ type: "text", text: expect.stringMatching(/^[A-Za-z0-9_-]{3}│read via local$/) },
		]);
		expect(localOps.readPaths).toEqual([localPath]);
		expect(remoteOps.readPaths).toEqual([]);
	});

	it("bypasses remote execution for path-selected host resources", async () => {
		const localPath = join(tempDir, "local-skill", "SKILL.md");
		mkdirSync(join(tempDir, "local-skill"));
		writeFileSync(localPath, "local skill");
		const remoteOps = new ReadOnlyOperations("/workspace", {
			type: "remote",
			cwd: "/workspace",
			url: "ws://127.0.0.1:8787",
			protocol: "ws",
			configured: true,
			workspace: { id: "test-workspace-id", root: "/workspace", pathFlavor: "posix" },
		});
		const localOps = new ReadOnlyOperations(tempDir, { type: "local", cwd: tempDir });
		let selectionCalls = 0;
		const host = new WorkspaceToolHost({
			cwd: remoteOps.cwd,
			operations: remoteOps,
			tools: {
				read: {
					operationsForPath: (path) => {
						selectionCalls++;
						return selectionCalls === 1 && path === localPath ? localOps : undefined;
					},
				},
			},
		});
		const result = await host.execute("read", { toolCallId: "tool-2", arguments: { path: localPath } });

		expect(result.content).toEqual([
			{ type: "text", text: expect.stringMatching(/^[A-Za-z0-9_-]{3}│read via local$/) },
		]);
		expect(localOps.readPaths).toEqual([localPath]);
		expect(selectionCalls).toBe(1);
		expect(remoteOps.remoteReadPaths).toEqual([]);
		const remotePath = "/workspace/project.txt";
		const remoteResult = await host.execute("read", { toolCallId: "tool-3", arguments: { path: remotePath } });
		expect(remoteResult.content).toEqual([{ type: "text", text: `read via remote executor: ${remotePath}` }]);
		expect(remoteOps.remoteReadPaths).toEqual([remotePath]);
		await host.dispose();
	});

	it("keeps a registered host skill readable when AgentSession uses a remote workspace", async () => {
		const hostSkillDir = join(tempDir, "host-skill");
		const hostSkillPath = join(hostSkillDir, "SKILL.md");
		const remoteCwd = join(tempDir, "remote-workspace");
		mkdirSync(hostSkillDir);
		mkdirSync(remoteCwd);
		writeFileSync(hostSkillPath, "host skill instructions");
		const remoteOps = new ReadOnlyOperations(remoteCwd, {
			type: "remote",
			cwd: remoteCwd,
			url: "ws://127.0.0.1:8787",
			protocol: "ws",
			configured: true,
			workspace: { id: "test-workspace-id", root: remoteCwd, pathFlavor: "posix" },
		});
		const harness = await createHarness({ toolOperations: remoteOps });
		try {
			harness.session.registerSessionSkill({
				name: "host-skill",
				description: "Host skill",
				filePath: hostSkillPath,
				disableModelInvocation: false,
			});
			await harness.session.reload();
			const read = harness.session.getToolDefinition("read");
			if (!read) throw new Error("read tool is unavailable");
			const result = await read.execute(
				"tool-4",
				{ path: hostSkillPath },
				undefined,
				undefined,
				{} as ExtensionContext,
			);
			expect(result.content).toEqual([
				{ type: "text", text: expect.stringMatching(/^[A-Za-z0-9_-]{3}│host skill instructions$/) },
			]);
			expect(remoteOps.remoteReadPaths).toEqual([]);
			if (process.platform !== "win32") {
				const outsidePath = join(tempDir, "outside-secret.txt");
				const escapedPath = join(hostSkillDir, "escaped.txt");
				writeFileSync(outsidePath, "outside secret");
				symlinkSync(outsidePath, escapedPath);
				const escapedResult = await read.execute(
					"tool-5",
					{ path: escapedPath },
					undefined,
					undefined,
					{} as ExtensionContext,
				);
				expect(escapedResult.content).toEqual([{ type: "text", text: `read via remote executor: ${escapedPath}` }]);
				expect(remoteOps.remoteReadPaths).toEqual([escapedPath]);
			}
		} finally {
			await harness.session.dispose();
			harness.faux.unregister();
		}
	});
});
