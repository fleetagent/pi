import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { ToolBackendInfo, ToolExecOptions, ToolOperations } from "../src/core/tools/operations.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

class ReadOnlyOperations implements ToolOperations {
	cwd: string;
	backend: ToolBackendInfo;
	readPaths: string[] = [];

	constructor(cwd: string, backend: ToolBackendInfo) {
		this.cwd = cwd;
		this.backend = backend;
	}

	async exec(_command: string, _options: ToolExecOptions): Promise<{ exitCode: number | null }> {
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

		expect(result.content).toEqual([{ type: "text", text: "read via local" }]);
		expect(localOps.readPaths).toEqual([localPath]);
		expect(remoteOps.readPaths).toEqual([]);
	});
});
