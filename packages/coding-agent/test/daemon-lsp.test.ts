import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDaemonCommand } from "../src/daemon/config.ts";
import { loadDaemonLspConfiguration } from "../src/daemon/lsp-config.ts";
import { createDaemonWorkspaceRuntime } from "../src/daemon/workspace-runtime.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-remote-daemon-lsp-"));
	temporaryDirectories.push(path);
	return path;
}
interface DaemonLspConfigurationOptions {
	allowProcessExec?: boolean;
	trustProjectLsp?: boolean;
	lspConfigPath?: string;
}

async function daemonConfiguration(workspaceRoot: string, options: DaemonLspConfigurationOptions = {}) {
	const command = await parseDaemonCommand(
		[
			"--daemon",
			"--daemon-cwd",
			workspaceRoot,
			"--daemon-port",
			"8787",
			"--daemon-allow-root",
			...(options.allowProcessExec ? ["--daemon-allow-process-exec"] : []),
			...(options.trustProjectLsp ? ["--daemon-trust-project-lsp"] : []),
			...(options.lspConfigPath ? ["--daemon-lsp-config", options.lspConfigPath] : []),
		],
		{},
		workspaceRoot,
	);
	if (!command.configuration) throw new Error("Missing daemon configuration");
	return command.configuration;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("daemon LSP ownership", () => {
	it("loads only explicit operator and trusted project layers", async () => {
		const workspaceRoot = await temporaryDirectory();
		await mkdir(join(workspaceRoot, ".pi"), { recursive: true });
		await writeFile(
			join(workspaceRoot, ".pi", "settings.json"),
			JSON.stringify({
				lsp: {
					servers: [
						{
							id: "project",
							selectors: [{ languageId: "typescript", pattern: "**/*.ts" }],
							transport: { type: "tcp", host: "127.0.0.1", port: 9257 },
							lifecycle: { type: "attached" },
							workspace: { type: "session" },
						},
					],
				},
			}),
		);
		expect(loadDaemonLspConfiguration(await daemonConfiguration(workspaceRoot))).toEqual({
			enabled: false,
			servers: [],
		});
		expect(
			loadDaemonLspConfiguration(await daemonConfiguration(workspaceRoot, { trustProjectLsp: true })),
		).toMatchObject({ enabled: true, servers: [{ id: "project", transport: { type: "tcp" } }] });
	});

	it("rejects host factories and requires a separate process-execution grant for managed servers", async () => {
		const workspaceRoot = await temporaryDirectory();
		const configPath = join(workspaceRoot, "lsp.json");
		const server = (transport: object, lifecycle: object) => ({
			id: "fixture",
			selectors: [{ languageId: "typescript", pattern: "**/*.ts" }],
			transport,
			lifecycle,
			workspace: { type: "session" },
		});
		await writeFile(
			configPath,
			JSON.stringify({ servers: [server({ type: "connection", id: "host" }, { type: "attached" })] }),
		);
		const hostFactoryConfiguration = await daemonConfiguration(workspaceRoot, { lspConfigPath: configPath });
		expect(() => loadDaemonLspConfiguration(hostFactoryConfiguration)).toThrow(
			"cannot use a host-provided connection transport",
		);

		await writeFile(
			configPath,
			JSON.stringify({ servers: [server({ type: "spawn", command: "node" }, { type: "managed" })] }),
		);
		const deniedSpawnConfiguration = await daemonConfiguration(workspaceRoot, { lspConfigPath: configPath });
		expect(() => loadDaemonLspConfiguration(deniedSpawnConfiguration)).toThrow(
			"requires --daemon-allow-process-exec",
		);
		expect(
			loadDaemonLspConfiguration(
				await daemonConfiguration(workspaceRoot, { lspConfigPath: configPath, allowProcessExec: true }),
			),
		).toMatchObject({ enabled: true, servers: [{ id: "fixture", transport: { type: "spawn" } }] });
	});

	it("rejects daemon LSP paths whose existing symlink target escapes the workspace", async () => {
		const workspaceRoot = await temporaryDirectory();
		const outside = await temporaryDirectory();
		const linkedRoot = join(workspaceRoot, "linked-root");
		await symlink(outside, linkedRoot, "dir");
		const configPath = join(workspaceRoot, "lsp-symlink.json");
		await writeFile(
			configPath,
			JSON.stringify({
				servers: [
					{
						id: "attached",
						selectors: [{ languageId: "typescript", pattern: "**/*.ts" }],
						transport: { type: "tcp", host: "127.0.0.1", port: 9257 },
						lifecycle: { type: "attached" },
						workspace: { type: "fixed", path: linkedRoot },
					},
				],
			}),
		);
		const configuration = await daemonConfiguration(workspaceRoot, { lspConfigPath: configPath });
		expect(() => loadDaemonLspConfiguration(configuration)).toThrow("escapes the daemon workspace");
		await unlink(linkedRoot);
		await symlink(join(outside, "future-root"), linkedRoot, "dir");
		expect(() => loadDaemonLspConfiguration(configuration)).toThrow("uses a broken symbolic link");
	});

	it("applies the final daemon secret filter to LSP child environments", async () => {
		const workspaceRoot = await temporaryDirectory();
		const runtime = createDaemonWorkspaceRuntime(await daemonConfiguration(workspaceRoot));
		const environment = runtime.operations.createChildEnvironment({
			SAFE_VALUE: "ok",
			LC_API_KEY: "secret",
			PI_REMOTE_TOKEN: "secret",
			PI_DAEMON_TLS_KEY: "secret",
		});
		expect(environment).toEqual(expect.objectContaining({ SAFE_VALUE: "ok" }));
		expect(environment).not.toHaveProperty("LC_API_KEY");
		expect(environment).not.toHaveProperty("PI_REMOTE_TOKEN");
		expect(environment).not.toHaveProperty("PI_DAEMON_TLS_KEY");
		await runtime.dispose();
	});
});
