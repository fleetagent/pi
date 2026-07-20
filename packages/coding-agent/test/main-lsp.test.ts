import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiAgent } from "../src/core/pi-agent.ts";
import { LocalSessionManager } from "../src/core/session-manager.ts";
import { main } from "../src/main.ts";

const LSP_TOOL_NAMES = [
	"lsp_diagnostics",
	"lsp_hover",
	"lsp_definition",
	"lsp_references",
	"lsp_rename",
	"lsp_code_actions",
] as const;

const originalCwd = process.cwd();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalOffline = process.env.PI_OFFLINE;
const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
const tempDirs: string[] = [];
const runtimes: PiAgent[] = [];

async function createTempDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-main-lsp-"));
	tempDirs.push(directory);
	return directory;
}

async function writeAttachedConfiguration(directory: string, id: string): Promise<string> {
	const path = join(directory, "lsp.json");
	await writeFile(
		path,
		JSON.stringify({
			servers: [
				{
					id,
					selectors: [{ languageId: "typescript", pattern: "**/*.ts" }],
					transport: { type: "connection", id: `${id}-fixture` },
					lifecycle: { type: "attached" },
					workspace: { type: "fixed", path: "." },
				},
			],
		}),
	);
	return path;
}

function expectLspToolAvailability(runtime: PiAgent, available: boolean): void {
	const activeTools = new Set(runtime.session.getActiveToolNames());
	const allTools = new Set(runtime.session.getAllTools().map((tool) => tool.name));
	for (const name of LSP_TOOL_NAMES) {
		expect(activeTools.has(name), `${name} active`).toBe(available);
		expect(allTools.has(name), `${name} registered`).toBe(available);
	}
}

beforeEach(async () => {
	const agentDir = await createTempDir();
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	process.env.PI_SKIP_VERSION_CHECK = "1";

	const create = PiAgent.create.bind(PiAgent);
	vi.spyOn(PiAgent, "setupStdio").mockImplementation(() => {});
	vi.spyOn(PiAgent, "create").mockImplementation(async (options) => {
		const runtime = await create(options);
		runtimes.push(runtime);
		return runtime;
	});
	vi.spyOn(PiAgent.prototype, "readPipedStdin").mockResolvedValue(undefined);
	vi.spyOn(PiAgent.prototype, "runMode").mockResolvedValue(undefined);
});

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
	vi.restoreAllMocks();
	process.chdir(originalCwd);
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (originalOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = originalOffline;
	if (originalSkipVersionCheck === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
	else process.env.PI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe.sequential("main LSP wiring", () => {
	it("resolves --lsp-config from the startup cwd and registers conditional LSP tools", async () => {
		const startupCwd = await createTempDir();
		const configDir = join(startupCwd, "config");
		await mkdir(configDir, { recursive: true });
		await writeAttachedConfiguration(configDir, "cli-relative");
		process.chdir(startupCwd);

		await main(["--offline", "--print", "--no-session", "--lsp-config", "config/lsp.json"]);
		const runtime = runtimes.at(-1);
		if (!runtime) throw new Error("Expected main runtime");

		expect(runtime.cwd).toBe(startupCwd);
		expect(runtime.session.getLspStatus()).toMatchObject({
			enabled: true,
			configuration: {
				servers: [{ id: "cli-relative", workspace: { type: "fixed", path: configDir } }],
			},
			servers: [{ serverId: "cli-relative" }],
		});
		expectLspToolAvailability(runtime, true);
	});

	it("does not expand an explicit CLI tool allowlist when LSP is configured", async () => {
		const startupCwd = await createTempDir();
		await writeAttachedConfiguration(startupCwd, "allowlisted");
		process.chdir(startupCwd);

		await main([
			"--offline",
			"--print",
			"--no-session",
			"--lsp-config",
			"lsp.json",
			"--tools",
			"read,bash,edit,write",
		]);
		const runtime = runtimes.at(-1);
		if (!runtime) throw new Error("Expected main runtime");

		expect(runtime.session.getLspStatus().enabled).toBe(true);
		expect(runtime.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
		expectLspToolAvailability(runtime, false);
	});

	it("keeps conditional LSP tools unregistered when no configuration exists", async () => {
		const startupCwd = await createTempDir();
		process.chdir(startupCwd);

		await main(["--offline", "--print", "--no-session"]);
		const runtime = runtimes.at(-1);
		if (!runtime) throw new Error("Expected main runtime");

		expect(runtime.session.getLspStatus()).toMatchObject({
			enabled: false,
			configuration: { servers: [] },
			servers: [],
		});
		expectLspToolAvailability(runtime, false);
	});

	it("renders malformed source diagnostics, fails closed, and continues startup", async () => {
		const startupCwd = await createTempDir();
		const malformedPath = join(startupCwd, "malformed.json");
		await writeFile(malformedPath, JSON.stringify({ enabled: "yes" }));
		process.chdir(startupCwd);
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

		await main(["--offline", "--print", "--no-session", "--lsp-config", "malformed.json"]);
		const runtime = runtimes.at(-1);
		if (!runtime) throw new Error("Expected main runtime");

		expect(runtime.session.getLspStatus()).toMatchObject({
			enabled: false,
			configuration: { servers: [] },
			servers: [],
		});
		expectLspToolAvailability(runtime, false);
		expect(stderr.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			`LSP configuration (${malformedPath}) $.enabled`,
		);
		expect(PiAgent.prototype.runMode).toHaveBeenCalledOnce();
	});

	it("delegates recoverable startup diagnostics to interactive rendering without console replay", async () => {
		const startupCwd = await createTempDir();
		const malformedPath = join(startupCwd, "malformed.json");
		await writeFile(malformedPath, JSON.stringify({ enabled: "yes" }));
		process.chdir(startupCwd);
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

		try {
			await main(["--offline", "--no-session", "--lsp-config", "malformed.json"]);
		} finally {
			delete (process.stdin as { isTTY?: boolean }).isTTY;
		}

		const runtime = runtimes.at(-1);
		if (!runtime) throw new Error("Expected main runtime");
		expect(runtime.mode).toBe("interactive");
		expect(runtime.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "error",
					fatal: false,
					message: expect.stringContaining(`LSP configuration (${malformedPath}) $.enabled`),
				}),
			]),
		);
		expect(stderr).not.toHaveBeenCalled();
		expect(PiAgent.prototype.runMode).toHaveBeenCalledOnce();
	});

	it("gives --no-lsp precedence over a valid enabled CLI configuration", async () => {
		const startupCwd = await createTempDir();
		await writeAttachedConfiguration(startupCwd, "disabled-by-flag");
		process.chdir(startupCwd);

		await main(["--offline", "--print", "--no-session", "--lsp-config", "lsp.json", "--no-lsp"]);
		const runtime = runtimes.at(-1);
		if (!runtime) throw new Error("Expected main runtime");

		expect(runtime.session.getLspStatus()).toMatchObject({
			enabled: false,
			configuration: { servers: [{ id: "disabled-by-flag" }] },
			servers: [],
		});
		expectLspToolAvailability(runtime, false);
		expect(PiAgent.prototype.runMode).toHaveBeenCalledOnce();
	});

	it("resumes a cross-cwd session without rebasing the CLI config path to the session cwd", async () => {
		const startupCwd = await createTempDir();
		const sessionCwd = await createTempDir();
		const sessionDir = await createTempDir();
		const configDir = join(startupCwd, "cli-config");
		await mkdir(configDir, { recursive: true });
		await writeAttachedConfiguration(configDir, "cross-cwd");
		const session = new LocalSessionManager({ cwd: sessionCwd, sessionDir }).create();
		session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "persisted" }],
			timestamp: Date.now(),
		});
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "persisted reply" }],
			api: "anthropic-messages",
			provider: "fixture",
			model: "fixture",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const sessionReference = session.getSessionReference();
		if (!sessionReference) throw new Error("Expected local session reference");
		process.chdir(startupCwd);

		await main([
			"--offline",
			"--print",
			"--session",
			sessionReference,
			"--session-dir",
			sessionDir,
			"--lsp-config",
			"cli-config/lsp.json",
		]);
		const runtime = runtimes.at(-1);
		if (!runtime) throw new Error("Expected main runtime");

		expect(runtime.cwd).toBe(sessionCwd);
		expect(runtime.session.getLspStatus()).toMatchObject({
			enabled: true,
			configuration: {
				servers: [{ id: "cross-cwd", workspace: { type: "fixed", path: configDir } }],
			},
		});
		expectLspToolAvailability(runtime, true);
	});
});
