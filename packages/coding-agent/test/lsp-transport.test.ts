import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InitializeParams } from "vscode-languageserver-protocol";
import {
	AbstractMessageWriter,
	createMessageConnection,
	type Message,
	SocketMessageReader,
	SocketMessageWriter,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-languageserver-protocol/node.js";
import { LspClient } from "../src/core/lsp/client.ts";
import { LspManager } from "../src/core/lsp/manager.ts";
import {
	createManagedStdioConnectionFactory,
	createNamedPipeConnectionFactory,
	createTcpConnectionFactory,
	createUnixSocketConnectionFactory,
	type LspConnectionFactory,
	type LspConnectionHandle,
	resolveLspConnectionFactory,
} from "../src/core/lsp/transport.ts";

const tempDirs: string[] = [];
const servers: Server[] = [];
const sockets = new Set<Socket>();
const stdioFixture = join(import.meta.dirname, "fixtures", "lsp-stdio-server.mjs");

async function waitForCondition(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
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

async function createTempDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-lsp-transport-"));
	tempDirs.push(directory);
	return directory;
}

async function listen(server: Server, options: { host: string; port: number } | string): Promise<void> {
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options, () => {
			server.off("error", reject);
			resolve();
		});
	});
	servers.push(server);
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

function registerFauxLsp(socket: Socket, methods: string[]): void {
	const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
	connection.onRequest("initialize", () => {
		methods.push("initialize");
		return { capabilities: { hoverProvider: true } };
	});
	connection.onNotification("initialized", () => methods.push("initialized"));
	connection.onRequest("shutdown", () => {
		methods.push("shutdown");
		return null;
	});
	connection.onNotification("exit", () => {
		methods.push("exit");
		socket.end();
	});
	connection.listen();
}

function inertHandle(onClose: () => void): LspConnectionHandle {
	const input = new PassThrough();
	const output = new PassThrough();
	return {
		reader: new StreamMessageReader(input),
		writer: new StreamMessageWriter(output),
		endpoint: { type: "connection", description: "inert test connection", disposalMode: "disconnect" },
		close: async () => {
			input.destroy();
			output.destroy();
			onClose();
		},
		onClose: () => () => {},
		onError: () => () => {},
	};
}

afterEach(async () => {
	vi.useRealTimers();
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	await Promise.all(servers.splice(0).map(closeServer));
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("LSP transports", () => {
	it("initializes over managed framed stdio and exposes stderr without mixing it into protocol output", async () => {
		const cwd = await createTempDir();
		const client = new LspClient({
			serverId: "stdio",
			rootDir: cwd,
			languageId: "typescript",
			connectionFactory: createManagedStdioConnectionFactory({
				command: process.execPath,
				args: [stdioFixture],
			}),
			connectTimeoutMs: 1000,
			initializeTimeoutMs: 1000,
		});

		const result = await client.start();
		const pidMatch = /pid (\d+)/.exec(result.endpoint.description);
		expect(result.capabilities.hoverProvider).toBe(true);
		expect(result.endpoint).toMatchObject({ type: "spawn", disposalMode: "terminate-process" });
		await waitForCondition(() => client.stderrOutput.includes("faux server ready"));
		expect(client.stderrOutput).toContain("faux server ready");
		await client.shutdown();
		if (!pidMatch) throw new Error("expected managed child pid");
		expect(() => process.kill(Number(pidMatch[1]), 0)).toThrow();
	});

	it("initializes over TCP and disconnects an attached endpoint without protocol shutdown by default", async () => {
		const methods: string[] = [];
		const server = createServer((socket) => registerFauxLsp(socket, methods));
		await listen(server, { host: "127.0.0.1", port: 0 });
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected TCP address");
		const client = new LspClient({
			serverId: "tcp",
			rootDir: await createTempDir(),
			languageId: "typescript",
			connectionFactory: createTcpConnectionFactory("127.0.0.1", address.port),
			shutdownMode: "disconnect",
			connectTimeoutMs: 1000,
			initializeTimeoutMs: 1000,
		});

		const result = await client.start();
		expect(result.endpoint).toMatchObject({ type: "tcp", disposalMode: "disconnect" });
		await client.shutdown();
		expect(methods).toContain("initialize");
		expect(methods).not.toContain("shutdown");
		expect(methods).not.toContain("exit");
		const dedicatedClient = new LspClient({
			serverId: "tcp-dedicated",
			rootDir: await createTempDir(),
			languageId: "typescript",
			connectionFactory: createTcpConnectionFactory("127.0.0.1", address.port),
			ownership: "attached",
			shutdownMode: "protocol",
			connectTimeoutMs: 1000,
			initializeTimeoutMs: 1000,
		});
		await dedicatedClient.start();
		await dedicatedClient.shutdown();
		await waitForCondition(() => methods.includes("exit"));
		expect(methods).toContain("shutdown");
		expect(methods).toContain("exit");
	});
	it("cleans up an attached socket that disconnects while initialization is pending", async () => {
		let acceptedSocket: Socket | undefined;
		const server = createServer((socket) => {
			acceptedSocket = socket;
			const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
			connection.onRequest("initialize", () => {
				socket.destroy();
				return new Promise(() => {});
			});
			connection.listen();
		});
		await listen(server, { host: "127.0.0.1", port: 0 });
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected TCP address");
		const client = new LspClient({
			serverId: "disconnect-during-init",
			rootDir: await createTempDir(),
			languageId: "typescript",
			connectionFactory: createTcpConnectionFactory("127.0.0.1", address.port),
			shutdownMode: "disconnect",
			connectTimeoutMs: 1000,
			initializeTimeoutMs: 1000,
		});

		await expect(client.start()).rejects.toThrow(
			/closed during initialization|Connection is closed|connection got disposed/,
		);
		expect(client.connectionState).toBe("failed");
		expect(client.isInitialized).toBe(false);
		expect(acceptedSocket?.destroyed).toBe(true);
		await client.shutdown();
	});

	it("sends configured initialization metadata, serves settings, and cancels timed-out requests", async () => {
		let initializeParams: InitializeParams | undefined;
		let configurationResult: unknown[] | undefined;
		let workspaceFoldersResult: unknown;
		let changedSettings: unknown;
		let requestCancelled = false;
		let configurationReady: (() => void) | undefined;
		const configurationDone = new Promise<void>((resolve) => {
			configurationReady = resolve;
		});
		const server = createServer((socket) => {
			const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
			connection.onRequest("initialize", (params: InitializeParams) => {
				initializeParams = params;
				return { capabilities: { hoverProvider: true, workspace: { workspaceFolders: { supported: true } } } };
			});
			connection.onNotification("initialized", async () => {
				configurationResult = await connection.sendRequest("workspace/configuration", {
					items: [{ section: "typescript" }, { section: "typescript.format.enable" }, { section: "missing" }, {}],
				});
				workspaceFoldersResult = await connection.sendRequest("workspace/workspaceFolders");
				configurationReady?.();
			});
			connection.onNotification("workspace/didChangeConfiguration", (params: { settings: unknown }) => {
				changedSettings = params.settings;
			});
			connection.onRequest(
				"test/slow",
				(_params, token) =>
					new Promise<void>((resolve) => {
						token.onCancellationRequested(() => {
							requestCancelled = true;
							resolve();
						});
					}),
			);
			connection.onRequest("test/error", () => Promise.reject(new Error("server request failed")));
			connection.listen();
		});
		await listen(server, { host: "127.0.0.1", port: 0 });
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected TCP address");
		const cwd = await createTempDir();
		const settings = { typescript: { format: { enable: true } } };
		const client = new LspClient({
			serverId: "configured",
			rootDir: cwd,
			rootUri: "file:///remote/workspace",
			languageId: "typescript",
			connectionFactory: createTcpConnectionFactory("127.0.0.1", address.port),
			ownership: "attached",
			shutdownMode: "disconnect",
			initializationOptions: { mode: "strict" },
			settings,
			clientInfo: { name: "pi-test", version: "1.2.3" },
			locale: "et-EE",
			trace: "messages",
			connectTimeoutMs: 1000,
			initializeTimeoutMs: 1000,
			requestTimeoutMs: 100,
		});

		await client.start();
		await configurationDone;
		expect(initializeParams).toMatchObject({
			processId: null,
			rootUri: "file:///remote/workspace",
			workspaceFolders: [{ uri: "file:///remote/workspace" }],
			initializationOptions: { mode: "strict" },
			clientInfo: { name: "pi-test", version: "1.2.3" },
			capabilities: {
				textDocument: {
					codeAction: {
						dynamicRegistration: false,
						codeActionLiteralSupport: {
							codeActionKind: {
								valueSet: [
									"",
									"quickfix",
									"refactor",
									"refactor.extract",
									"refactor.inline",
									"refactor.rewrite",
									"source",
									"source.organizeImports",
									"source.fixAll",
								],
							},
						},
						isPreferredSupport: true,
						dataSupport: true,
					},
				},
				workspace: {
					workspaceEdit: {
						documentChanges: true,
						resourceOperations: ["create", "rename", "delete"],
					},
				},
			},
			locale: "et-EE",
			trace: "messages",
		});
		expect(configurationResult).toEqual([settings.typescript, true, null, settings]);
		expect(workspaceFoldersResult).toEqual([{ uri: "file:///remote/workspace", name: cwd.split(/[\\/]/).at(-1) }]);
		expect(changedSettings).toEqual(settings);
		await expect(client.sendRequest("test/error", {})).rejects.toThrow("server request failed");
		expect(client.lastRequestError?.message).toContain("server request failed");
		await expect(client.sendRequest("test/slow", {})).rejects.toThrow("timed out");
		await waitForCondition(() => requestCancelled);
		await client.shutdown();
	});

	it("does not report running when the connection closes during final initialization", async () => {
		const clientInput = new PassThrough();
		const serverInput = new PassThrough();
		const closeListeners = new Set<() => void>();
		const delegate = new StreamMessageWriter(serverInput);
		class ClosingWriter extends AbstractMessageWriter {
			async write(message: Message): Promise<void> {
				await delegate.write(message);
				if ("method" in message && message.method === "initialized") {
					for (const listener of closeListeners) listener();
				}
			}

			end(): void {
				delegate.end();
			}
		}
		const serverConnection = createMessageConnection(
			new StreamMessageReader(serverInput),
			new StreamMessageWriter(clientInput),
		);
		serverConnection.onRequest("initialize", () => ({ capabilities: {} }));
		serverConnection.listen();
		let handleClosed = 0;
		const client = new LspClient({
			serverId: "close-during-init",
			rootDir: await createTempDir(),
			languageId: "typescript",
			connectionFactory: async () => ({
				reader: new StreamMessageReader(clientInput),
				writer: new ClosingWriter(),
				endpoint: { type: "connection", description: "closing connection", disposalMode: "disconnect" },
				close: async () => {
					handleClosed++;
					clientInput.destroy();
					serverInput.destroy();
				},
				onClose: (listener) => {
					closeListeners.add(listener);
					return () => closeListeners.delete(listener);
				},
				onError: () => () => {},
			}),
			initializeTimeoutMs: 1000,
		});
		await expect(client.start()).rejects.toThrow("closed during initialization");
		expect(client.connectionState).toBe("failed");
		expect(client.isInitialized).toBe(false);
		expect(handleClosed).toBe(1);
		serverConnection.dispose();
		clientInput.destroy();
		serverInput.destroy();
	});

	it("exchanges framed JSON-RPC over Unix sockets and named pipes", async () => {
		const directory = await createTempDir();
		const pipePath =
			process.platform === "win32"
				? `\\\\.\\pipe\\pi-lsp-${process.pid}-${Date.now()}`
				: join(directory, "pipe.sock");
		for (const [kind, factory, path] of [
			["unix", createUnixSocketConnectionFactory(join(directory, "unix.sock")), join(directory, "unix.sock")],
			["pipe", createNamedPipeConnectionFactory(pipePath), pipePath],
		] as const) {
			const methods: string[] = [];
			const server = createServer((socket) => registerFauxLsp(socket, methods));
			await listen(server, path);
			const client = new LspClient({
				serverId: kind,
				rootDir: directory,
				languageId: "typescript",
				connectionFactory: factory,
				shutdownMode: "disconnect",
				connectTimeoutMs: 1000,
				initializeTimeoutMs: 1000,
			});
			const result = await client.start();
			expect(result.endpoint).toMatchObject({ type: kind, disposalMode: "disconnect" });
			expect(methods).toContain("initialize");
			await client.shutdown();
			expect(methods).not.toContain("shutdown");
			expect(methods).not.toContain("exit");
			await closeServer(server);
		}
	});

	it("resolves host-registered programmatic factories by ID", () => {
		const factory: LspConnectionFactory = async () => inertHandle(() => {});
		expect(resolveLspConnectionFactory({ type: "connection", id: "host" }, { host: factory })).toBe(factory);
		expect(() => resolveLspConnectionFactory({ type: "connection", id: "missing" }, {})).toThrow(
			"No LSP connection factory is registered",
		);
		expect(() => resolveLspConnectionFactory({ type: "connection", id: "toString" }, {})).toThrow(
			"No LSP connection factory is registered",
		);
	});

	it("deduplicates concurrent client startup", async () => {
		let connections = 0;
		const client = new LspClient({
			serverId: "concurrent",
			rootDir: await createTempDir(),
			languageId: "typescript",
			connectionFactory: async () => {
				connections++;
				return inertHandle(() => {});
			},
			initializeTimeoutMs: 5,
		});
		const first = client.start();
		const second = client.start();
		expect(first).toBe(second);
		await expect(first).rejects.toThrow("Initializing LSP server concurrent timed out");
		await expect(second).rejects.toThrow("Initializing LSP server concurrent timed out");
		expect(connections).toBe(1);
	});

	it("aborts a noncompliant connection factory with no connect deadline and closes its late handle once", async () => {
		let resolveFactory!: (handle: LspConnectionHandle) => void;
		let factoryStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			factoryStarted = resolve;
		});
		const factoryResult = new Promise<LspConnectionHandle>((resolve) => {
			resolveFactory = resolve;
		});
		let closes = 0;
		const client = new LspClient({
			serverId: "noncompliant",
			rootDir: await createTempDir(),
			languageId: "typescript",
			connectionFactory: () => {
				factoryStarted();
				return factoryResult;
			},
			connectTimeoutMs: 0,
		});
		const startup = client.start();
		await started;
		await expect(client.shutdown()).resolves.toBeUndefined();
		expect(await settlesWithin(startup)).toBe(true);
		await expect(startup).rejects.toThrow("aborted");
		resolveFactory(inertHandle(() => closes++));
		await waitForCondition(() => closes === 1);
		expect(closes).toBe(1);
	});

	it("does not let a noncompliant zero-deadline factory block manager reconfiguration", async () => {
		let resolveFactory!: (handle: LspConnectionHandle) => void;
		let markFactoryStarted!: () => void;
		const factoryStarted = new Promise<void>((resolve) => {
			markFactoryStarted = resolve;
		});
		const factoryResult = new Promise<LspConnectionHandle>((resolve) => {
			resolveFactory = resolve;
		});
		let closes = 0;
		const manager = new LspManager(await createTempDir(), {
			configuration: {
				enabled: true,
				servers: [
					{
						id: "host",
						selectors: [{ languageId: "typescript", pattern: "**/*.ts" }],
						transport: { type: "connection", id: "host" },
						lifecycle: { type: "attached" },
						workspace: { type: "session" },
						timeouts: { connectMs: 0, shutdownMs: 20 },
					},
				],
			},
			connectionFactories: {
				host: () => {
					markFactoryStarted();
					return factoryResult;
				},
			},
		});
		const startup = manager.getClientForFile("fixture.ts");
		await factoryStarted;
		const replacement = manager.setConfiguration({ enabled: false, servers: [] });
		expect(await settlesWithin(Promise.all([startup, replacement]))).toBe(true);
		await expect(startup).resolves.toBeUndefined();
		await replacement;
		resolveFactory(inertHandle(() => closes++));
		await waitForCondition(() => closes === 1);
		expect(closes).toBe(1);
		await manager.shutdownAll();
	});

	it.each(["initialized", "workspace/didChangeConfiguration"] as const)(
		"bounds a blocked %s notification within the initialization deadline",
		async (blockedMethod) => {
			const clientInput = new PassThrough();
			const serverInput = new PassThrough();
			const delegate = new StreamMessageWriter(serverInput);
			class BlockingWriter extends AbstractMessageWriter {
				async write(message: Message): Promise<void> {
					if ("method" in message && message.method === blockedMethod) return new Promise(() => {});
					await delegate.write(message);
				}

				end(): void {
					delegate.end();
				}
			}
			const serverConnection = createMessageConnection(
				new StreamMessageReader(serverInput),
				new StreamMessageWriter(clientInput),
			);
			serverConnection.onRequest("initialize", () => ({ capabilities: {} }));
			serverConnection.listen();
			let closes = 0;
			const client = new LspClient({
				serverId: `blocked-${blockedMethod}`,
				rootDir: await createTempDir(),
				languageId: "typescript",
				connectionFactory: async () => ({
					reader: new StreamMessageReader(clientInput),
					writer: new BlockingWriter(),
					endpoint: { type: "connection", description: "blocked writer", disposalMode: "disconnect" },
					close: async () => {
						closes++;
						clientInput.destroy();
						serverInput.destroy();
					},
					onClose: () => () => {},
					onError: () => () => {},
				}),
				settings: blockedMethod === "workspace/didChangeConfiguration" ? { enabled: true } : undefined,
				initializeTimeoutMs: 20,
			});
			await expect(client.start()).rejects.toThrow("Initializing LSP server");
			expect(closes).toBe(1);
			expect(client.connectionState).toBe("failed");
			serverConnection.dispose();
		},
	);

	it("bounds a noncompliant connection handle close during shutdown", async () => {
		const client = new LspClient({
			serverId: "blocked-close",
			rootDir: await createTempDir(),
			languageId: "typescript",
			connectionFactory: async () => inertHandle(() => {}),
			shutdownTimeoutMs: 20,
		});
		const handle = inertHandle(() => {});
		handle.close = () => new Promise(() => {});
		Object.assign(client as unknown as { connectionHandle: LspConnectionHandle }, { connectionHandle: handle });
		const shutdown = client.shutdown();
		expect(await settlesWithin(shutdown)).toBe(true);
		await expect(shutdown).resolves.toBeUndefined();
		expect(client.lastTransportError?.message).toContain("Closing connection");
	});

	it("force-invalidates without protocol shutdown and bounds a zero-timeout handle close", async () => {
		vi.useFakeTimers();
		const client = new LspClient({
			serverId: "invalidated",
			rootDir: await createTempDir(),
			languageId: "typescript",
			connectionFactory: async () => inertHandle(() => {}),
			shutdownTimeoutMs: 0,
		});
		const handle = inertHandle(() => {});
		handle.close = () => new Promise(() => {});
		const sendRequest = vi.fn();
		const sendNotification = vi.fn();
		const dispose = vi.fn();
		Object.assign(
			client as unknown as {
				connectionHandle: LspConnectionHandle;
				connection: {
					sendRequest: typeof sendRequest;
					sendNotification: typeof sendNotification;
					dispose: typeof dispose;
				};
				initialized: boolean;
			},
			{ connectionHandle: handle, connection: { sendRequest, sendNotification, dispose }, initialized: true },
		);

		const invalidation = client.invalidate();
		expect(client.isDisposed).toBe(true);
		expect(client.connectionState).toBe("disposed");
		expect(dispose).toHaveBeenCalledOnce();
		expect(sendRequest).not.toHaveBeenCalled();
		expect(sendNotification).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(3000);
		await expect(invalidation).resolves.toBeUndefined();
		expect(client.lastTransportError?.message).toContain("Invalidating connection");
	});

	it("rejects synchronization notifications after the connection is no longer initialized", async () => {
		const client = new LspClient({
			serverId: "closed",
			rootDir: await createTempDir(),
			languageId: "typescript",
			connectionFactory: async () => inertHandle(() => {}),
		});
		await expect(client.didOpen("file:///fixture.ts", "typescript", 1, "const value = 1;\n")).rejects.toThrow(
			"is not initialized",
		);
	});

	it("rechecks abort state after installing transport and request listeners", async () => {
		let transportAborted = false;
		const racingTransportSignal = {
			get aborted() {
				return transportAborted;
			},
			addEventListener: () => {
				transportAborted = true;
			},
			removeEventListener: () => {},
		} as unknown as AbortSignal;
		const factory = createManagedStdioConnectionFactory({
			command: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
		});
		await expect(
			factory({
				serverId: "abort-race",
				workspaceRoot: await createTempDir(),
				workspaceUri: "file:///workspace",
				signal: racingTransportSignal,
				connectTimeoutMs: 0,
			}),
		).rejects.toThrow("Aborted while connecting");

		const client = new LspClient({
			serverId: "request-abort-race",
			rootDir: await createTempDir(),
			languageId: "typescript",
			connectionFactory: async () => inertHandle(() => {}),
			requestTimeoutMs: 0,
		});
		const connection = {
			sendRequest: () => new Promise(() => {}),
		} as unknown as ReturnType<typeof createMessageConnection>;
		Object.assign(client as unknown as { connection: typeof connection; initialized: boolean }, {
			connection,
			initialized: true,
		});
		let requestAborted = false;
		const racingRequestSignal = {
			get aborted() {
				return requestAborted;
			},
			addEventListener: () => {
				requestAborted = true;
			},
			removeEventListener: () => {},
		} as unknown as AbortSignal;
		const request = client.sendRequest("test/race", {}, racingRequestSignal);
		expect(await settlesWithin(request)).toBe(true);
		await expect(request).rejects.toThrow("aborted");
	});

	it("cleans up failed spawn, refused endpoints, connect timeouts, and partial initialization", async () => {
		const cwd = await createTempDir();
		const context = {
			serverId: "failure",
			workspaceRoot: cwd,
			workspaceUri: "file:///workspace",
			signal: new AbortController().signal,
			connectTimeoutMs: 100,
		};
		await expect(
			createManagedStdioConnectionFactory({ command: join(cwd, "missing-server") })(context),
		).rejects.toThrow("Failed to spawn");

		const temporaryServer = createServer();
		await listen(temporaryServer, { host: "127.0.0.1", port: 0 });
		const address = temporaryServer.address();
		if (!address || typeof address === "string") throw new Error("expected TCP address");
		await closeServer(temporaryServer);
		await expect(createTcpConnectionFactory("127.0.0.1", address.port)(context)).rejects.toThrow(
			/Failed to connect.*ECONNREFUSED/,
		);

		let timeoutClosed = 0;
		let resolveSlowFactory!: (handle: LspConnectionHandle) => void;
		const slowFactoryResult = new Promise<LspConnectionHandle>((resolve) => {
			resolveSlowFactory = resolve;
		});
		const timeoutClient = new LspClient({
			serverId: "timeout",
			rootDir: cwd,
			languageId: "typescript",
			connectionFactory: () => slowFactoryResult,
			connectTimeoutMs: 20,
		});
		await expect(timeoutClient.start()).rejects.toThrow("Connecting to LSP server timeout timed out");
		resolveSlowFactory(inertHandle(() => timeoutClosed++));
		await waitForCondition(() => timeoutClosed === 1);
		expect(timeoutClosed).toBe(1);

		let partialClosed = 0;
		const partialClient = new LspClient({
			serverId: "partial",
			rootDir: cwd,
			languageId: "typescript",
			connectionFactory: async () => inertHandle(() => partialClosed++),
			initializeTimeoutMs: 5,
		});
		await expect(partialClient.start()).rejects.toThrow("Initializing LSP server partial timed out");
		expect(partialClosed).toBe(1);

		let managedHandle: LspConnectionHandle | undefined;
		const managedFactory = createManagedStdioConnectionFactory({
			command: process.execPath,
			args: [stdioFixture, "--no-initialize"],
		});
		const managedPartialClient = new LspClient({
			serverId: "managed-partial",
			rootDir: cwd,
			languageId: "typescript",
			connectionFactory: async (factoryContext) => {
				managedHandle = await managedFactory(factoryContext);
				return managedHandle;
			},
			connectTimeoutMs: 1000,
			initializeTimeoutMs: 5,
		});
		await expect(managedPartialClient.start()).rejects.toThrow("Initializing LSP server managed-partial timed out");
		const pidMatch = /pid (\d+)/.exec(managedHandle?.endpoint.description ?? "");
		if (!pidMatch) throw new Error("expected managed child pid");
		expect(() => process.kill(Number(pidMatch[1]), 0)).toThrow();
	});

	it("marks an unexpected close reconnectable and lazily replaces only that instance", async () => {
		let connections = 0;
		let disconnectFirst: (() => void) | undefined;
		const server = createServer((socket) => {
			connections++;
			const current = connections;
			const connection = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
			connection.onRequest("initialize", () => ({ capabilities: { hoverProvider: true } }));
			connection.onNotification("initialized", () => {
				if (current === 1) disconnectFirst = () => socket.destroy();
			});
			connection.listen();
		});
		await listen(server, { host: "127.0.0.1", port: 0 });
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected TCP address");
		const manager = new LspManager(await createTempDir(), {
			configuration: {
				enabled: true,
				servers: [
					{
						id: "reconnect",
						selectors: [{ languageId: "typescript", pattern: "**/*.ts" }],
						transport: { type: "tcp", host: "127.0.0.1", port: address.port },
						lifecycle: { type: "attached" },
						workspace: { type: "session" },
						timeouts: { connectMs: 1000, initializeMs: 1000 },
					},
				],
			},
		});

		const first = await manager.getClientForFile("fixture.ts");
		if (!first) throw new Error("expected first client");
		await waitForCondition(() => disconnectFirst !== undefined);
		disconnectFirst?.();
		await waitForCondition(() => manager.getStatus()[0]?.state === "closed");
		expect(manager.getStatus()[0]).toMatchObject({
			state: "closed",
			running: false,
			reconnectEligible: true,
			ownership: "attached",
			shutdownMode: "disconnect",
		});
		const second = await manager.getClientForFile("fixture.ts");
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
		expect(connections).toBe(2);
		expect(manager.getStatus()[0]).toMatchObject({ state: "running", capabilities: { hoverProvider: true } });
		await manager.shutdownAll();
	});

	it("reports managed stderr and endpoint failures through manager status", async () => {
		const cwd = await createTempDir();
		const manager = new LspManager(cwd, {
			configuration: {
				enabled: true,
				servers: [
					{
						id: "status",
						selectors: [{ languageId: "typescript", pattern: "**/*.ts" }],
						transport: { type: "spawn", command: process.execPath, args: [stdioFixture] },
						lifecycle: { type: "managed" },
						workspace: { type: "session" },
						timeouts: { connectMs: 1000, initializeMs: 1000, requestMs: 5 },
					},
				],
			},
		});
		const statusClient = await manager.getClientForFile("fixture.ts");
		if (!statusClient) throw new Error("expected status client");
		expect(manager.getStatus()[0]).toMatchObject({
			serverId: "status",
			endpoint: expect.stringContaining("managed LSP process"),
			stderr: expect.stringContaining("faux server ready"),
			running: true,
			state: "running",
			ownership: "managed",
			shutdownMode: "protocol",
			reconnectEligible: true,
			capabilities: { hoverProvider: true },
		});
		await expect(statusClient.sendRequest("test/no-response", {})).rejects.toThrow("timed out");
		expect(manager.getStatus()[0]).toMatchObject({
			state: "running",
			lastRequestError: expect.stringContaining("timed out"),
		});
		expect(manager.getStatus()[0]?.lastError).toBeUndefined();
		await manager.shutdownAll();

		const portServer = createServer();
		await listen(portServer, { host: "127.0.0.1", port: 0 });
		const portAddress = portServer.address();
		if (!portAddress || typeof portAddress === "string") throw new Error("expected TCP address");
		await closeServer(portServer);
		const refusedManager = new LspManager(cwd, {
			configuration: {
				enabled: true,
				servers: [
					{
						id: "refused",
						selectors: [{ languageId: "typescript", pattern: "**/*.ts" }],
						transport: { type: "tcp", host: "127.0.0.1", port: portAddress.port },
						lifecycle: { type: "attached" },
						workspace: { type: "session" },
						timeouts: { connectMs: 100 },
					},
				],
			},
		});
		await refusedManager.getClientForFile("fixture.ts");
		expect(refusedManager.getStatus()[0]).toMatchObject({
			state: "failed",
			running: false,
			reconnectEligible: true,
			ownership: "attached",
		});
		expect(refusedManager.getStatus()[0]?.lastError).toMatch(/Failed to connect|Timed out/);
		await refusedManager.shutdownAll();
	});
});
