import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LspConfigurationLayer, LspConfiguredServer } from "../src/core/lsp/config.ts";
import { loadLspConfiguration, resolveLspConfigurationLayerPaths } from "../src/core/lsp/config-loader.ts";
import { isFatalPiAgentDiagnostic, PiAgent } from "../src/core/pi-agent.ts";
import { LocalSessionManager } from "../src/core/session-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-lsp-config-"));
	tempDirs.push(directory);
	return directory;
}

function attachedServer(id: string, priority: number): LspConfiguredServer {
	return {
		id,
		selectors: [{ languageId: "typescript", pattern: "**/*.ts" }],
		transport: { type: "connection", id: `${id}-connection` },
		lifecycle: { type: "attached" },
		workspace: { type: "session" },
		priority,
	};
}

function createSettingsManager(globalLsp?: unknown, projectLsp?: unknown): SettingsManager {
	const storage = new InMemorySettingsStorage();
	if (globalLsp !== undefined) storage.withLock("global", () => JSON.stringify({ lsp: globalLsp }));
	if (projectLsp !== undefined) storage.withLock("project", () => JSON.stringify({ lsp: projectLsp }));
	return SettingsManager.fromStorage(storage);
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("LSP configuration loading", () => {
	it("resolves global, project, CLI, and host layers in documented precedence order", async () => {
		const cwd = await createTempDir();
		const agentDir = await createTempDir();
		const cliDir = await createTempDir();
		const globalLayer: LspConfigurationLayer = { servers: [attachedServer("shared", 1)] };
		const projectLayer: LspConfigurationLayer = { servers: [attachedServer("shared", 2)] };
		const cliLayer: LspConfigurationLayer = { servers: [attachedServer("shared", 3)] };
		await writeFile(join(cliDir, "lsp.json"), JSON.stringify(cliLayer));
		const settingsManager = createSettingsManager(globalLayer, projectLayer);

		const result = await loadLspConfiguration({
			settingsManager,
			cwd,
			agentDir,
			inputs: [
				{ type: "configuration", configuration: { servers: [attachedServer("shared", 4)] } },
				{ type: "file", path: join(cliDir, "lsp.json"), scope: "cli" },
			],
			trustProjectLspTransports: true,
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.configuration).toMatchObject({ enabled: true, servers: [{ id: "shared", priority: 4 }] });
	});

	it("resolves relative commands, sockets, roots, and mappings against each source file", async () => {
		const cwd = await createTempDir();
		const agentDir = await createTempDir();
		const configDir = await createTempDir();
		await writeFile(
			join(configDir, "lsp.json"),
			JSON.stringify({
				servers: [
					{
						id: "spawned",
						selectors: [{ languageId: "typescript", pattern: "**/*.ts" }],
						transport: { type: "spawn", command: "./bin/server", cwd: "work" },
						lifecycle: { type: "managed" },
						workspace: { type: "fixed", path: "workspace" },
						pathMappings: [{ agentRoot: ".", serverRootUri: "file:///srv/project" }],
					},
					{
						id: "socket",
						selectors: [{ languageId: "rust", pattern: "**/*.rs" }],
						transport: { type: "unix", path: "run/server.sock" },
						lifecycle: { type: "attached" },
						workspace: { type: "markers", markers: ["Cargo.toml"], stopAt: ".." },
					},
				],
			}),
		);

		const result = await loadLspConfiguration({
			settingsManager: createSettingsManager(),
			cwd,
			agentDir,
			inputs: [{ type: "file", path: join(configDir, "lsp.json"), scope: "cli" }],
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.configuration.servers).toMatchObject([
			{
				transport: { command: join(configDir, "bin", "server"), cwd: join(configDir, "work") },
				workspace: { path: join(configDir, "workspace") },
				pathMappings: [{ agentRoot: configDir }],
			},
			{
				transport: { path: join(configDir, "run", "server.sock") },
				workspace: { stopAt: join(configDir, "..") },
			},
		]);
	});

	it("resolves Windows source-relative paths without host-native path mangling", () => {
		const server = attachedServer("windows", 1);
		server.transport = { type: "spawn", command: ".\\bin\\server.exe", cwd: "work" };
		server.lifecycle = { type: "managed" };
		server.workspace = { type: "fixed", path: "workspace" };
		server.pathMappings = [{ agentRoot: ".", serverRootUri: "file:///srv/project" }];
		const resolved = resolveLspConfigurationLayerPaths({ servers: [server] }, "C:\\Config\\Lsp");
		expect(resolved.servers?.[0]).toMatchObject({
			transport: {
				command: "C:\\Config\\Lsp\\bin\\server.exe",
				cwd: "C:\\Config\\Lsp\\work",
			},
			workspace: { path: "C:\\Config\\Lsp\\workspace" },
			pathMappings: [{ agentRoot: "C:\\Config\\Lsp" }],
		});
	});

	it("preserves backslashes as POSIX filename characters during source-relative resolution", () => {
		const server = attachedServer("posix", 1);
		server.workspace = { type: "fixed", path: "workspace\\literal" };
		server.pathMappings = [{ agentRoot: "mapping\\literal", serverRootUri: "file:///srv/project" }];
		const resolved = resolveLspConfigurationLayerPaths({ servers: [server] }, "/config");
		expect(resolved.servers?.[0]).toMatchObject({
			workspace: { path: "/config/workspace\\literal" },
			pathMappings: [{ agentRoot: "/config/mapping\\literal" }],
		});
	});

	it("blocks every active project-origin transport unless the host grants trust", async () => {
		const cwd = await createTempDir();
		const agentDir = await createTempDir();
		const transports: Array<{
			id: string;
			transport: LspConfiguredServer["transport"];
			lifecycle: LspConfiguredServer["lifecycle"];
		}> = [
			{ id: "spawn", transport: { type: "spawn", command: "./bin/server" }, lifecycle: { type: "managed" } },
			{ id: "tcp", transport: { type: "tcp", host: "127.0.0.1", port: 9000 }, lifecycle: { type: "attached" } },
			{ id: "unix", transport: { type: "unix", path: "run/server.sock" }, lifecycle: { type: "attached" } },
			{ id: "pipe", transport: { type: "pipe", path: "\\\\.\\pipe\\project-lsp" }, lifecycle: { type: "attached" } },
			{
				id: "connection",
				transport: { type: "connection", id: "project-factory" },
				lifecycle: { type: "attached" },
			},
		];
		const projectLayer: LspConfigurationLayer = {
			servers: transports.map(({ id, transport, lifecycle }) => ({
				id,
				selectors: [{ languageId: "typescript", pattern: "**/*.ts" }],
				transport,
				lifecycle,
				workspace: { type: "session" },
			})),
		};
		const settingsManager = createSettingsManager(undefined, projectLayer);

		const blocked = await loadLspConfiguration({ settingsManager, cwd, agentDir });
		expect(blocked.configuration.servers).toEqual([]);
		expect(blocked.diagnostics).toHaveLength(transports.length);
		for (const [index, transport] of transports.entries()) {
			expect(blocked.diagnostics[index]).toEqual({
				severity: "warning",
				source: join(cwd, ".pi", "settings.json"),
				path: `$.servers[${index}].transport`,
				message: expect.stringContaining(`trustProjectLspTransports`),
			});
			expect(blocked.diagnostics[index]?.message).toContain(transport.id);
			expect(blocked.diagnostics[index]?.message).toContain(transport.transport.type);
		}

		const trusted = await loadLspConfiguration({
			settingsManager,
			cwd,
			agentDir,
			trustProjectLspTransports: true,
		});
		expect(trusted.diagnostics).toEqual([]);
		expect(trusted.configuration.servers).toHaveLength(transports.length);
		expect(trusted.configuration.servers.find((server) => server.id === "spawn")?.transport).toMatchObject({
			command: join(cwd, ".pi", "bin", "server"),
		});
		expect(trusted.configuration.servers.find((server) => server.id === "unix")?.transport).toMatchObject({
			path: join(cwd, ".pi", "run", "server.sock"),
		});
	});

	it("blocks untrusted project enabled:true from activating inherited transports", async () => {
		const cwd = await createTempDir();
		const agentDir = await createTempDir();
		const inheritedServers: LspConfiguredServer[] = [
			{
				...attachedServer("spawn", 1),
				transport: { type: "spawn", command: "typescript-language-server" },
				lifecycle: { type: "managed" },
			},
			{ ...attachedServer("tcp", 1), transport: { type: "tcp", host: "127.0.0.1", port: 9000 } },
			{ ...attachedServer("unix", 1), transport: { type: "unix", path: "/tmp/lsp.sock" } },
			{ ...attachedServer("pipe", 1), transport: { type: "pipe", path: "\\\\.\\pipe\\lsp" } },
			attachedServer("connection", 1),
		];
		const settingsManager = createSettingsManager({ enabled: false, servers: inheritedServers }, { enabled: true });

		const blocked = await loadLspConfiguration({ settingsManager, cwd, agentDir });
		expect(blocked.configuration).toEqual({ enabled: false, servers: inheritedServers });
		expect(blocked.diagnostics).toEqual([
			expect.objectContaining({
				severity: "warning",
				source: join(cwd, ".pi", "settings.json"),
				path: "$.enabled",
				message: expect.stringContaining("trustProjectLspTransports"),
			}),
		]);

		const trusted = await loadLspConfiguration({
			settingsManager,
			cwd,
			agentDir,
			trustProjectLspTransports: true,
		});
		expect(trusted.configuration).toEqual({ enabled: true, servers: inheritedServers });
		expect(trusted.diagnostics).toEqual([]);
	});

	it("preserves untrusted project disablement", async () => {
		const cwd = await createTempDir();
		const agentDir = await createTempDir();
		const globalServer = attachedServer("global", 1);
		const result = await loadLspConfiguration({
			settingsManager: createSettingsManager({ servers: [globalServer] }, { enabled: false }),
			cwd,
			agentDir,
		});

		expect(result.configuration).toEqual({ enabled: false, servers: [globalServer] });
		expect(result.diagnostics).toEqual([]);
	});
	it("preserves inherited trusted servers when blocking overrides but applies safe project removal entries", async () => {
		const cwd = await createTempDir();
		const agentDir = await createTempDir();
		const globalServer = attachedServer("shared", 1);
		const blockedOverride = attachedServer("shared", 2);
		blockedOverride.transport = { type: "tcp", host: "127.0.0.1", port: 9000 };
		const blocked = await loadLspConfiguration({
			settingsManager: createSettingsManager({ servers: [globalServer] }, { servers: [blockedOverride] }),
			cwd,
			agentDir,
		});
		expect(blocked.configuration.servers).toEqual([globalServer]);
		expect(blocked.diagnostics).toHaveLength(1);

		const removed = await loadLspConfiguration({
			settingsManager: createSettingsManager(
				{ servers: [globalServer] },
				{ servers: [{ id: "shared", enabled: false }] },
			),
			cwd,
			agentDir,
		});
		expect(removed.configuration).toEqual({ enabled: true, servers: [] });
		expect(removed.diagnostics).toEqual([]);

		const replaced = await loadLspConfiguration({
			settingsManager: createSettingsManager(
				{ servers: [globalServer] },
				{ mode: "replace", servers: [attachedServer("blocked", 2)] },
			),
			cwd,
			agentDir,
		});
		expect(replaced.configuration).toEqual({ enabled: true, servers: [] });
		expect(replaced.diagnostics).toHaveLength(1);
	});

	it("reports file and schema errors as PiAgent diagnostics", async () => {
		const cwd = await createTempDir();
		const agentDir = await createTempDir();
		const configPath = join(cwd, "invalid-lsp.json");
		await writeFile(configPath, JSON.stringify({ servers: [{ id: "broken" }] }));
		const runtime = await PiAgent.create({
			cwd,
			agentDir,
			lsp: { type: "file", path: configPath, scope: "cli" },
		});

		await runtime.createAgentSession();

		expect(runtime.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "error",
					fatal: false,
					message: expect.stringContaining(`${configPath}) $.servers[0].selectors`),
				}),
			]),
		);
		expect(runtime.diagnostics.some(isFatalPiAgentDiagnostic)).toBe(false);
		expect(isFatalPiAgentDiagnostic({ type: "error", message: "unrelated application error" })).toBe(true);
		await runtime.dispose();
	});

	it("fails closed instead of falling back when a higher-precedence layer is invalid", async () => {
		const cwd = await createTempDir();
		const agentDir = await createTempDir();
		const invalidPath = join(cwd, "invalid.json");
		await writeFile(invalidPath, JSON.stringify({ enabled: "yes" }));
		const result = await loadLspConfiguration({
			settingsManager: createSettingsManager({ servers: [attachedServer("global", 1)] }),
			cwd,
			agentDir,
			inputs: [{ type: "file", path: invalidPath, scope: "cli" }],
		});

		expect(result.configuration).toEqual({ enabled: false, servers: [] });
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ source: invalidPath, path: "$.enabled", severity: "error" }),
			]),
		);
	});

	it("keeps --no-lsp recoverable when a lower-precedence source is malformed", async () => {
		const cwd = await createTempDir();
		const agentDir = await createTempDir();
		const runtime = await PiAgent.create({
			cwd,
			agentDir,
			settingsManager: createSettingsManager(false),
			lsp: [
				{ type: "file", path: join(cwd, "missing-lsp.json"), scope: "cli" },
				{ type: "disabled", source: "--no-lsp", scope: "cli" },
			],
		});
		await runtime.createAgentSession();

		expect(runtime.session.getLspStatus()).toMatchObject({ enabled: false, configuration: { servers: [] } });
		expect(runtime.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "error",
					fatal: false,
					message: expect.stringContaining("LSP configuration"),
				}),
				expect.objectContaining({
					type: "error",
					fatal: false,
					message: expect.stringContaining("failed to read file"),
				}),
			]),
		);
		await runtime.dispose();
	});
	it("validates malformed falsy LSP settings instead of treating them as absent", async () => {
		const agentDir = await createTempDir();
		const result = await loadLspConfiguration({
			settingsManager: createSettingsManager(false),
			cwd: await createTempDir(),
			agentDir,
		});

		expect(result.configuration).toEqual({ enabled: false, servers: [] });
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ source: join(agentDir, "settings.json"), path: "$", severity: "error" }),
			]),
		);
	});

	it("fails closed when settings-backed configuration becomes invalid during reload", async () => {
		const cwd = await createTempDir();
		const agentDir = await createTempDir();
		const settingsPath = join(agentDir, "settings.json");
		await writeFile(settingsPath, JSON.stringify({ lsp: { servers: [attachedServer("global", 1)] } }));
		const runtime = await PiAgent.create({ cwd, agentDir });
		const session = await runtime.createAgentSession();
		expect(session.getAllTools().map((tool) => tool.name)).toContain("lsp_hover");

		await writeFile(settingsPath, "{ invalid json");
		const reloadResult = await session.reload();

		expect(reloadResult.lsp?.configuration).toEqual({ enabled: false, servers: [] });
		expect(reloadResult.lsp?.diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ source: settingsPath, path: "$", severity: "warning" })]),
		);
		expect(runtime.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "warning",
					message: expect.stringContaining(`LSP configuration (${settingsPath}) $`),
				}),
			]),
		);
		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("lsp_hover");
		await runtime.dispose();
	});

	it("accepts project transports only through the PiAgent host trust contract", async () => {
		const cwd = await createTempDir();
		const agentDir = await createTempDir();
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({
				trustProjectLspTransports: true,
				lsp: { servers: [attachedServer("project", 1)] },
			}),
		);

		const blockedRuntime = await PiAgent.create({ cwd, agentDir });
		await blockedRuntime.createAgentSession();
		expect(blockedRuntime.session.getLspStatus().servers).toEqual([]);
		expect(blockedRuntime.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ message: expect.stringContaining("trustProjectLspTransports") }),
			]),
		);
		await blockedRuntime.dispose();

		const trustedRuntime = await PiAgent.create({
			cwd,
			agentDir,
			trustProjectLspTransports: true,
		});
		await trustedRuntime.createAgentSession();
		expect(trustedRuntime.diagnostics).toEqual([]);
		expect(trustedRuntime.session.getLspStatus()).toMatchObject({
			enabled: true,
			servers: [{ serverId: "project" }],
		});
		await trustedRuntime.dispose();
	});

	it("replaces PiAgent diagnostics with destination-attributed fail-closed diagnostics", async () => {
		const firstCwd = await createTempDir();
		const secondCwd = await createTempDir();
		const agentDir = await createTempDir();
		await mkdir(join(secondCwd, ".pi"), { recursive: true });
		const destinationSettingsPath = join(secondCwd, ".pi", "settings.json");
		await writeFile(destinationSettingsPath, JSON.stringify({ lsp: { servers: [{ id: "broken" }] } }));

		const targetSession = await new LocalSessionManager({ cwd: secondCwd }).create();
		targetSession.appendMessage({
			role: "user",
			content: [{ type: "text", text: "destination" }],
			timestamp: Date.now(),
		});
		const targetReference = targetSession.getSessionReference();
		if (!targetReference) throw new Error("expected destination session reference");

		const runtime = await PiAgent.create({
			cwd: firstCwd,
			agentDir,
			sessionManager: new LocalSessionManager({ cwd: firstCwd }),
		});
		await runtime.createAgentSession();
		expect(runtime.diagnostics).toEqual([]);
		await runtime.switchSession(targetReference, { cwdOverride: secondCwd });
		expect(runtime.cwd).toBe(secondCwd);
		expect(runtime.services.settingsManager.getProjectLspConfiguration()).toEqual({ servers: [{ id: "broken" }] });

		expect(runtime.session.getLspStatus()).toMatchObject({ enabled: false, servers: [] });
		expect(runtime.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "error",
					fatal: false,
					message: expect.stringContaining(
						`LSP configuration (${destinationSettingsPath}) $.servers[0].selectors`,
					),
				}),
			]),
		);
		await runtime.dispose();
	});

	it("revalidates mapping overlaps after source-relative roots are resolved", async () => {
		const cwd = await createTempDir();
		const server = attachedServer("mapped", 1);
		server.pathMappings = [
			{ agentRoot: ".", serverRootUri: "file:///server/root" },
			{ agentRoot: join(cwd, "pkg"), serverRootUri: "file:///different/root" },
		];
		const result = await loadLspConfiguration({
			settingsManager: createSettingsManager(),
			cwd,
			agentDir: await createTempDir(),
			inputs: [{ type: "configuration", configuration: { servers: [server] }, baseDir: cwd }],
		});

		expect(result.configuration).toEqual({ enabled: false, servers: [] });
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: "$.servers[0].pathMappings[1].agentRoot",
					message: expect.stringContaining("overlaps mapping 0"),
				}),
			]),
		);
	});

	it("applies an explicit disable independently of tool options", async () => {
		const result = await loadLspConfiguration({
			settingsManager: createSettingsManager({ servers: [attachedServer("global", 1)] }),
			cwd: await createTempDir(),
			agentDir: await createTempDir(),
			inputs: [{ type: "disabled", scope: "cli", source: "--no-lsp" }],
		});

		expect(result.configuration).toMatchObject({ enabled: false, servers: [{ id: "global" }] });
	});
});
