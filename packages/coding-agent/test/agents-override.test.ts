import { constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import type { ToolAccessMode, ToolBackendInfo, ToolExecOptions, ToolOperations } from "../src/core/tools/operations.ts";

class FilesystemSshOperations implements ToolOperations {
	cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	async exec(_command: string, _options: ToolExecOptions): Promise<{ exitCode: number | null }> {
		return { exitCode: 0 };
	}

	async access(path: string, mode?: ToolAccessMode): Promise<void> {
		if (!existsSync(path)) throw new Error(`missing path: ${path}`);
		if (mode === "read" && !(statSync(path).mode & constants.S_IRUSR)) throw new Error(`unreadable path: ${path}`);
	}

	async readFile(path: string): Promise<Buffer> {
		return readFileSync(path);
	}

	async writeFile(): Promise<void> {}

	async mkdir(): Promise<void> {}

	async stat(path: string) {
		return statSync(path);
	}

	async readdir(path: string): Promise<string[]> {
		return readdirSync(path);
	}

	getBackendInfo(): ToolBackendInfo {
		return { type: "ssh", cwd: this.cwd, remote: "test@example", configured: true };
	}
}

class PermissiveDirectorySshOperations extends FilesystemSshOperations {
	override async readFile(path: string): Promise<Buffer> {
		return statSync(path).isDirectory() ? Buffer.from("directory content") : super.readFile(path);
	}
}

class FilesystemDaemonOperations extends FilesystemSshOperations {
	async readResource(path: string): Promise<Buffer> {
		if (path !== "SANDBOX.md") throw new Error(`missing resource: ${path}`);
		return Buffer.from("Sandbox instructions.", "utf8");
	}

	override getBackendInfo(): ToolBackendInfo {
		return {
			type: "remote",
			cwd: this.cwd,
			url: "ws://daemon.test/pi/workspace",
			protocol: "ws",
			configured: true,
			workspace: { id: "workspace", root: this.cwd, pathFlavor: "posix" },
		};
	}
}

describe("AGENTS.override.md", () => {
	let tempDir: string;
	let agentDir: string;
	let localProject: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `agents-override-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		localProject = join(tempDir, "local-project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(localProject, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("prefers the override within each local directory while preserving ancestor layering", async () => {
		const serviceDir = join(localProject, "service");
		mkdirSync(serviceDir);
		writeFileSync(join(agentDir, "AGENTS.md"), "global instructions");
		writeFileSync(join(agentDir, "AGENTS.override.md"), "global override");
		writeFileSync(join(localProject, "AGENTS.md"), "project instructions");
		writeFileSync(join(localProject, "CLAUDE.md"), "lower-priority project instructions");
		writeFileSync(join(serviceDir, "AGENTS.md"), "service instructions");
		writeFileSync(join(serviceDir, "AGENTS.override.md"), "service override");

		const loader = new DefaultResourceLoader({ cwd: serviceDir, agentDir });
		await loader.reload();

		expect(loader.getAgentsFiles().agentsFiles).toEqual([
			{ path: join(agentDir, "AGENTS.override.md"), content: "global override" },
			{ path: join(localProject, "AGENTS.md"), content: "project instructions" },
			{ path: join(serviceDir, "AGENTS.override.md"), content: "service override" },
		]);
	});

	it("applies the same per-directory selection through SSH ToolOperations", async () => {
		const remoteRoot = join(tempDir, "remote-project");
		const remoteService = join(remoteRoot, "service");
		mkdirSync(remoteService, { recursive: true });
		writeFileSync(join(agentDir, "AGENTS.md"), "local global instructions");
		writeFileSync(join(agentDir, "AGENTS.override.md"), "local global override");
		writeFileSync(join(localProject, "AGENTS.override.md"), "local project must not load");
		writeFileSync(join(remoteRoot, "AGENTS.md"), "remote project instructions");
		writeFileSync(join(remoteService, "AGENTS.md"), "remote service instructions");
		writeFileSync(join(remoteService, "AGENTS.override.md"), "remote service override");

		const loader = new DefaultResourceLoader({
			cwd: localProject,
			agentDir,
			toolOperations: new FilesystemSshOperations(remoteService),
		});
		await loader.reload();

		expect(loader.getAgentsFiles().agentsFiles.map(({ path, content }) => ({ path, content }))).toEqual([
			{ path: join(agentDir, "AGENTS.override.md"), content: "local global override" },
			{ path: join(remoteRoot, "AGENTS.md"), content: "remote project instructions" },
			{ path: join(remoteService, "AGENTS.override.md"), content: "remote service override" },
		]);
		expect(
			loader
				.getAgentsFiles()
				.agentsFiles.slice(1)
				.every((file) => file.sourceInfo?.source === "ssh"),
		).toBe(true);
	});

	it("honors daemon workspace confinement and keeps synthetic sandbox instructions", async () => {
		const daemonRoot = join(tempDir, "daemon-project");
		mkdirSync(daemonRoot);
		writeFileSync(join(tempDir, "AGENTS.override.md"), "outside daemon root");
		writeFileSync(join(daemonRoot, "AGENTS.md"), "daemon base instructions");
		writeFileSync(join(daemonRoot, "AGENTS.override.md"), "daemon override");

		const loader = new DefaultResourceLoader({
			cwd: localProject,
			agentDir,
			toolOperations: new FilesystemDaemonOperations(daemonRoot),
		});
		await loader.reload();

		expect(loader.getAgentsFiles().agentsFiles.map((file) => file.content)).toEqual([
			"daemon override",
			"Sandbox instructions.",
		]);
		expect(loader.getAgentsFiles().agentsFiles[0]?.sourceInfo).toMatchObject({
			source: "remote",
			workspace: { id: "workspace", root: daemonRoot },
		});
	});

	it("silently skips directory candidates and falls back to the next file", async () => {
		mkdirSync(join(localProject, "AGENTS.override.md"));
		mkdirSync(join(localProject, "AGENTS.md"));
		writeFileSync(join(localProject, "CLAUDE.md"), "fallback instructions");
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		const loader = new DefaultResourceLoader({ cwd: localProject, agentDir });
		await loader.reload();

		expect(loader.getAgentsFiles().agentsFiles).toContainEqual({
			path: join(localProject, "CLAUDE.md"),
			content: "fallback instructions",
		});
		expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining(join(localProject, "AGENTS.override.md")));
		expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining(join(localProject, "AGENTS.md")));
		consoleError.mockRestore();
	});

	it("skips ToolOperations directory candidates even when the backend can read them", async () => {
		const remoteProject = join(tempDir, "remote-directory-candidates");
		mkdirSync(join(remoteProject, "AGENTS.override.md"), { recursive: true });
		mkdirSync(join(remoteProject, "AGENTS.md"));
		writeFileSync(join(remoteProject, "CLAUDE.md"), "remote fallback instructions");

		const loader = new DefaultResourceLoader({
			cwd: localProject,
			agentDir,
			toolOperations: new PermissiveDirectorySshOperations(remoteProject),
		});
		await loader.reload();

		expect(loader.getAgentsFiles().agentsFiles.map((file) => file.content)).toEqual(["remote fallback instructions"]);
	});

	it("updates override selection on reload and disables all candidates with noContextFiles", async () => {
		const basePath = join(localProject, "AGENTS.md");
		const overridePath = join(localProject, "AGENTS.override.md");
		writeFileSync(basePath, "base instructions");
		const loader = new DefaultResourceLoader({ cwd: localProject, agentDir });
		await loader.reload();
		expect(loader.getAgentsFiles().agentsFiles).toContainEqual({ path: basePath, content: "base instructions" });

		writeFileSync(overridePath, "override instructions");
		await loader.reload();
		expect(loader.getAgentsFiles().agentsFiles).toContainEqual({
			path: overridePath,
			content: "override instructions",
		});
		expect(loader.getAgentsFiles().agentsFiles).not.toContainEqual(expect.objectContaining({ path: basePath }));

		const disabledLoader = new DefaultResourceLoader({ cwd: localProject, agentDir, noContextFiles: true });
		await disabledLoader.reload();
		expect(disabledLoader.getAgentsFiles().agentsFiles).toEqual([]);
	});
});
