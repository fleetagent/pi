import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { printHelp } from "../src/cli/args.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import * as httpDispatcher from "../src/core/http-dispatcher.ts";
import { PiAgent } from "../src/core/pi-agent.ts";
import {
	DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
	REMOTE_WORKSPACE_CAPABILITIES,
	REMOTE_WORKSPACE_PROTOCOL_VERSIONS,
} from "../src/core/remote-workspace-protocol/index.ts";
import { LocalSessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runDaemonCommand } from "../src/daemon/command.ts";
import { DAEMON_WEBSOCKET_PROTOCOL, type DaemonConfiguration, parseDaemonCommand } from "../src/daemon/config.ts";
import { printDaemonHelp } from "../src/daemon/help.ts";
import { createDaemonServer } from "../src/daemon/server.ts";
import { main } from "../src/main.ts";
import * as migrations from "../src/migrations.ts";
import * as themeRuntime from "../src/modes/interactive/theme/theme.ts";
import * as packageManager from "../src/package-manager-cli.ts";
import * as windowsUpdate from "../src/utils/windows-self-update.ts";

const temporaryDirectories: string[] = [];
const children: ChildProcess[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-remote-daemon-cli-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function createConfiguration(
	workspaceRoot: string,
	overrides: Partial<DaemonConfiguration> = {},
): Promise<DaemonConfiguration> {
	const command = await parseDaemonCommand(
		[
			"--daemon",
			"--daemon-port",
			"12345",
			"--daemon-cwd",
			workspaceRoot,
			...(process.getuid?.() === 0 ? ["--daemon-allow-root"] : []),
		],
		{},
		workspaceRoot,
	);
	return { ...command.configuration!, port: 0, ...overrides };
}

async function openWebSocket(url: string, options?: { authorization?: string; origin?: string }): Promise<WebSocket> {
	const headers: Record<string, string> = {};
	if (options?.authorization) headers.authorization = options.authorization;
	if (options?.origin) headers.origin = options.origin;
	const socket = new WebSocket(url, DAEMON_WEBSOCKET_PROTOCOL, { headers });
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	return socket;
}

async function reservePort(): Promise<number> {
	const server = createHttpServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Failed to reserve a port");
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}

async function waitForOutput(child: ChildProcess, predicate: (output: string) => boolean): Promise<string> {
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		output += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		output += chunk.toString("utf8");
	});
	const deadline = Date.now() + 15_000;
	while (!predicate(output)) {
		if (child.exitCode !== null) throw new Error(`Daemon exited before expected output: ${output}`);
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for daemon output: ${output}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return output;
}

afterEach(async () => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill("SIGKILL");
		if (child.exitCode === null) await once(child, "exit");
	}
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe.sequential("pi --daemon CLI and lifecycle", () => {
	it("dispatches before normal Pi initialization", async () => {
		const runner = vi.fn(async () => undefined);
		const setupStdio = vi.spyOn(PiAgent, "setupStdio");
		const createAgent = vi.spyOn(PiAgent, "create");
		const createSettings = vi.spyOn(SettingsManager, "create");
		const createAuth = vi.spyOn(AuthStorage, "create");
		const configureDispatcher = vi.spyOn(httpDispatcher, "configureHttpDispatcher");
		const runMigration = vi.spyOn(migrations, "runMigrations");
		const packageCommand = vi.spyOn(packageManager, "handlePackageCommand");
		const configCommand = vi.spyOn(packageManager, "handleConfigCommand");
		const initTheme = vi.spyOn(themeRuntime, "initTheme");
		const windowsCleanup = vi.spyOn(windowsUpdate, "cleanupWindowsSelfUpdateQuarantine");
		const createSession = vi.spyOn(LocalSessionManager.prototype, "create");
		const listSessions = vi.spyOn(LocalSessionManager.prototype, "list");
		const originalOffline = process.env.PI_OFFLINE;
		delete process.env.PI_OFFLINE;
		try {
			await main(["--daemon", "--provider", "must-not-parse"], { daemonRunner: runner });
		} finally {
			if (originalOffline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = originalOffline;
		}
		expect(runner).toHaveBeenCalledWith(["--daemon", "--provider", "must-not-parse"]);
		expect(setupStdio).not.toHaveBeenCalled();
		expect(createAgent).not.toHaveBeenCalled();
		expect(createSettings).not.toHaveBeenCalled();
		expect(createAuth).not.toHaveBeenCalled();
		expect(configureDispatcher).not.toHaveBeenCalled();
		expect(runMigration).not.toHaveBeenCalled();
		expect(packageCommand).not.toHaveBeenCalled();
		expect(configCommand).not.toHaveBeenCalled();
		expect(initTheme).not.toHaveBeenCalled();
		expect(windowsCleanup).not.toHaveBeenCalled();
		expect(createSession).not.toHaveBeenCalled();
		expect(listSessions).not.toHaveBeenCalled();
	});

	it("recognizes daemon mode in normal and dedicated help", async () => {
		const normalOutput = vi.spyOn(console, "log").mockImplementation(() => undefined);
		printHelp();
		expect(normalOutput.mock.calls.flat().join("\n")).toContain("pi --daemon [options]");
		normalOutput.mockClear();
		await main(["--daemon", "--help"], { daemonRunner: async () => printDaemonHelp() });
		expect(normalOutput.mock.calls.flat().join("\n")).toContain("remote workspace runtime");
	});

	it("guards Bun-only normal runtime initialization before loading the shared CLI", async () => {
		const source = await readFile(new URL("../src/bun/cli.ts", import.meta.url), "utf8");
		const guard = source.indexOf('if (process.argv[2] !== "--daemon")');
		const sandboxInitialization = source.indexOf("restoreSandboxEnv()");
		const providerInitialization = source.indexOf('import("./register-bedrock.ts")', guard);
		const guardClose = source.indexOf("\n}", guard);
		const sharedCli = source.indexOf('import("../cli.ts")');
		expect(guard).toBeGreaterThan(-1);
		expect(sandboxInitialization).toBeGreaterThan(-1);
		expect(sandboxInitialization).toBeLessThan(guard);
		expect(providerInitialization).toBeGreaterThan(guard);
		expect(providerInitialization).toBeLessThan(guardClose);
		expect(source.match(/register-bedrock\.ts/g)).toHaveLength(1);
		expect(sharedCli).toBeGreaterThan(providerInitialization);
	});

	it("validates dedicated CLI and environment configuration without HOST/PORT aliases", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const command = await parseDaemonCommand(
			[
				"--daemon",
				"--daemon-host",
				"127.0.0.1",
				"--daemon-port",
				"9123",
				"--daemon-cwd",
				workspaceRoot,
				"--daemon-origin",
				"https://example.test",
				...(process.getuid?.() === 0 ? ["--daemon-allow-root"] : []),
			],
			{ HOST: "0.0.0.0", PORT: "1", PI_DAEMON_PORT: "8123" },
			workspaceRoot,
		);
		expect(command.configuration).toMatchObject({
			host: "127.0.0.1",
			port: 9123,
			workspaceRoot,
			allowedOrigins: ["https://example.test"],
		});
		await expect(parseDaemonCommand(["--daemon", "--provider", "x"], {}, workspaceRoot)).rejects.toThrow(
			"Unknown or incompatible option",
		);
		await expect(parseDaemonCommand(["--daemon"], { PI_DAEMON_PORT: "NaN" }, workspaceRoot)).rejects.toThrow(
			"decimal integer",
		);
		await expect(parseDaemonCommand(["--daemon"], { PI_DAEMON_TOKEN: "short" }, workspaceRoot)).rejects.toThrow(
			"32 to 1024 UTF-8 bytes",
		);
		await expect(
			parseDaemonCommand(
				["--daemon"],
				{ PI_DAEMON_MAX_CONNECTION_REQUESTS: "5", PI_DAEMON_MAX_GLOBAL_REQUESTS: "4" },
				workspaceRoot,
			),
		).rejects.toThrow("must be at least");
	});

	it("requires explicit root-process acknowledgement", async () => {
		if (process.getuid?.() !== 0) return;
		const workspaceRoot = await createTemporaryDirectory();
		await expect(parseDaemonCommand(["--daemon", "--daemon-cwd", workspaceRoot], {}, workspaceRoot)).rejects.toThrow(
			"Refusing to run the workspace daemon as root",
		);
		await expect(
			parseDaemonCommand(["--daemon", "--daemon-cwd", workspaceRoot, "--daemon-allow-root"], {}, workspaceRoot),
		).resolves.toMatchObject({ configuration: { allowRoot: true } });
	});

	it("redacts configured secrets even when validation fails before server creation", async () => {
		const secret = "daemon-secret-0123456789-abcdef";
		const originalToken = process.env.PI_DAEMON_TOKEN;
		const originalCwd = process.env.PI_DAEMON_CWD;
		process.env.PI_DAEMON_TOKEN = secret;
		process.env.PI_DAEMON_CWD = join(tmpdir(), secret);
		const errors: string[] = [];
		try {
			await runDaemonCommand(["--daemon", ...(process.getuid?.() === 0 ? ["--daemon-allow-root"] : [])], {
				stderr: (message) => errors.push(message),
			});
		} finally {
			if (originalToken === undefined) delete process.env.PI_DAEMON_TOKEN;
			else process.env.PI_DAEMON_TOKEN = originalToken;
			if (originalCwd === undefined) delete process.env.PI_DAEMON_CWD;
			else process.env.PI_DAEMON_CWD = originalCwd;
		}
		expect(errors.join("\n")).toContain("[REDACTED]");
		expect(errors.join("\n")).not.toContain(secret);
	});

	it("is import-safe and exposes explicit listen, address, and idempotent close handles", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const server = createDaemonServer(await createConfiguration(workspaceRoot));
		expect(server.address()).toBeUndefined();
		expect(server.state()).toBe("created");
		const address = await server.listen();
		expect(server.address()).toEqual(address);
		expect(server.state()).toBe("listening");
		expect(address.url).toBe(`ws://127.0.0.1:${address.port}/pi/workspace`);
		await Promise.all([server.close(), server.close()]);
		expect(server.address()).toBeUndefined();
		expect(server.state()).toBe("closed");
	});

	it("does not regress state when close races listen or force repeats after closure", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const port = await reservePort();
		const racingServer = createDaemonServer(await createConfiguration(workspaceRoot, { port }));
		const listening = racingServer.listen();
		const closing = racingServer.forceClose();
		await expect(listening).rejects.toThrow("closed before listening");
		await closing;
		expect(racingServer.state()).toBe("closed");
		await racingServer.forceClose();
		expect(racingServer.state()).toBe("closed");
		const probe = createHttpServer();
		probe.listen(port, "127.0.0.1");
		await once(probe, "listening");
		await new Promise<void>((resolve) => probe.close(() => resolve()));
	});

	it("makes forced close join the same lifecycle and prevents relistening", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const server = createDaemonServer(await createConfiguration(workspaceRoot));
		const address = await server.listen();
		const socket = await openWebSocket(address.url);
		const gracefulClose = server.close();
		const forcedClose = server.forceClose();
		await Promise.all([gracefulClose, forcedClose]);
		if (socket.readyState !== WebSocket.CLOSED) await once(socket, "close");
		expect(socket.readyState).toBe(WebSocket.CLOSED);
		expect(server.address()).toBeUndefined();
		expect(server.state()).toBe("closed");
		await expect(server.listen()).rejects.toThrow("closing");
		await server.forceClose();
		expect(server.state()).toBe("closed");
	});

	it("bounds unauthenticated TCP sockets before WebSocket allocation", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const server = createDaemonServer(await createConfiguration(workspaceRoot, { maxPendingConnections: 1 }));
		const address = await server.listen();
		const first = connect(address.port, "127.0.0.1");
		await once(first, "connect");
		const second = connect(address.port, "127.0.0.1");
		await once(second, "connect");
		await Promise.race([
			once(second, "close"),
			new Promise((_, reject) => setTimeout(() => reject(new Error("Second pre-auth socket was not closed")), 1000)),
		]);
		first.destroy();
		await server.close();
	});

	it("closes upgraded clients that do not send the protocol handshake", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const server = createDaemonServer(await createConfiguration(workspaceRoot, { handshakeTimeoutMs: 100 }));
		const address = await server.listen();
		const socket = await openWebSocket(address.url);
		const [code] = (await once(socket, "close")) as [number, Buffer];
		expect(code).toBe(1006);
		await server.close();
	});

	it("keeps the protocol handshake deadline after a malformed first message", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const server = createDaemonServer(await createConfiguration(workspaceRoot, { handshakeTimeoutMs: 150 }));
		const address = await server.listen();
		const socket = await openWebSocket(address.url);
		socket.send(JSON.stringify({ type: "request", id: "malformed-before-handshake" }));
		await once(socket, "message");
		const [code] = (await once(socket, "close")) as [number, Buffer];
		expect(code).toBe(1006);
		await server.close();
	});

	it("serves the canonical workspace catalog and drains clients", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const server = createDaemonServer(await createConfiguration(workspaceRoot));
		const address = await server.listen();
		const socket = await openWebSocket(address.url);
		const response = new Promise<Record<string, unknown>>((resolve, reject) => {
			socket.once("message", (data) => {
				try {
					resolve(JSON.parse(data.toString()) as Record<string, unknown>);
				} catch (error) {
					reject(error);
				}
			});
		});
		socket.send(
			JSON.stringify({
				type: "handshake",
				id: "handshake-1",
				versions: REMOTE_WORKSPACE_PROTOCOL_VERSIONS,
				requiredCapabilities: [],
				optionalCapabilities: REMOTE_WORKSPACE_CAPABILITIES,
				receiveLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
			}),
		);
		await expect(response).resolves.toMatchObject({
			type: "handshake_ack",
			id: "handshake-1",
			workspace: { root: workspaceRoot },
			catalog: {
				generation: 1,
				tools: expect.arrayContaining([
					expect.objectContaining({ name: "read", executionMode: "read" }),
					expect.objectContaining({ name: "write", executionMode: "mutation" }),
				]),
				operations: expect.arrayContaining(["workspace.read", "workspace.write"]),
			},
		});
		await server.close();
		expect(socket.readyState).toBe(WebSocket.CLOSED);
	});

	it("enforces fixed path, bearer authentication, and exact Origin before allocating a connection", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const token = "daemon-test-token-0123456789abcdef";
		const server = createDaemonServer(
			await createConfiguration(workspaceRoot, {
				token,
				allowedOrigins: ["https://allowed.example"],
			}),
		);
		const address = await server.listen();
		const rejectedStatus = (url: string, headers: Record<string, string> = {}) =>
			new Promise<number>((resolve, reject) => {
				const socket = new WebSocket(url, DAEMON_WEBSOCKET_PROTOCOL, { headers });
				socket.once("unexpected-response", (_request, response) => {
					response.resume();
					resolve(response.statusCode ?? 0);
				});
				socket.once("error", () => undefined);
				socket.once("open", () => reject(new Error("Expected upgrade rejection")));
			});
		await expect(rejectedStatus(`${address.url}?token=${token}`)).resolves.toBe(404);
		await expect(rejectedStatus(address.url)).resolves.toBe(401);
		await expect(
			rejectedStatus(address.url, { authorization: `Bearer ${token}`, origin: "https://denied.example" }),
		).resolves.toBe(403);
		const socket = await openWebSocket(address.url, {
			authorization: `Bearer ${token}`,
			origin: "https://allowed.example",
		});
		socket.close();
		await once(socket, "close");
		await server.close();
	});

	it("rejects unsafe non-loopback policy before listening", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const base = await createConfiguration(workspaceRoot);
		expect(() => createDaemonServer({ ...base, host: "0.0.0.0" })).toThrow("requires PI_DAEMON_TOKEN");
		expect(() => createDaemonServer({ ...base, host: "0.0.0.0", token: "x".repeat(32) })).toThrow("requires TLS");
		const server = createDaemonServer({
			...base,
			host: "0.0.0.0",
			token: "x".repeat(32),
			allowInsecureTransport: true,
		});
		await server.close();
	});

	it("starts and shuts down the Node source CLI without model, key, session, extension, or endpoint setup", async () => {
		const workspaceRoot = await createTemporaryDirectory();
		const isolatedHome = await createTemporaryDirectory();
		const port = await reservePort();
		const daemonToken = "source-daemon-token-0123456789abcdef";
		const args = [
			"--import",
			"tsx",
			"src/cli.ts",
			"--daemon",
			"--daemon-port",
			String(port),
			"--daemon-cwd",
			workspaceRoot,
			...(process.getuid?.() === 0 ? ["--daemon-allow-root"] : []),
		];
		const child = spawn(process.execPath, args, {
			cwd: new URL("..", import.meta.url),
			env: {
				PATH: process.env.PATH,
				HOME: isolatedHome,
				PI_CODING_AGENT_DIR: join(isolatedHome, ".pi-agent"),
				TMPDIR: process.env.TMPDIR,
				NODE_NO_WARNINGS: "1",
				PI_DAEMON_TOKEN: daemonToken,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.push(child);
		const output = await waitForOutput(child, (value) => value.includes("pi daemon ready"));
		expect(output.match(/pi daemon ready/g)).toHaveLength(1);
		expect(output).not.toContain("API_KEY");
		expect(output).not.toContain(daemonToken);
		child.kill("SIGTERM");
		await once(child, "exit");
		expect(child.exitCode).toBe(0);
	});
});
