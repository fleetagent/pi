import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import {
	type MessageReader,
	type MessageWriter,
	SocketMessageReader,
	SocketMessageWriter,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-languageserver-protocol/node.js";
import type { LspTransport } from "./config.ts";

export type LspConnectionDisposalMode = "terminate-process" | "disconnect";

export interface LspConnectionEndpoint {
	type: LspTransport["type"];
	description: string;
	disposalMode: LspConnectionDisposalMode;
}

export interface LspConnectionHandle {
	reader: MessageReader;
	writer: MessageWriter;
	endpoint: LspConnectionEndpoint;
	close(): Promise<void>;
	onClose(listener: () => void): () => void;
	onError(listener: (error: Error) => void): () => void;
}

export interface LspConnectionFactoryContext {
	serverId: string;
	workspaceRoot: string;
	workspaceUri: string;
	signal: AbortSignal;
	connectTimeoutMs?: number;
	onStderr?: (text: string) => void;
}

export type LspConnectionFactory = (context: LspConnectionFactoryContext) => Promise<LspConnectionHandle>;
export type LspConnectionFactoryRegistry = Readonly<Record<string, LspConnectionFactory>>;

interface ConnectionEvents {
	emitClose(): void;
	emitError(error: Error): void;
	onClose(listener: () => void): () => void;
	onError(listener: (error: Error) => void): () => void;
}

function createConnectionEvents(): ConnectionEvents {
	const closeListeners = new Set<() => void>();
	const errorListeners = new Set<(error: Error) => void>();
	return {
		emitClose: () => {
			for (const listener of closeListeners) listener();
		},
		emitError: (error) => {
			for (const listener of errorListeners) listener(error);
		},
		onClose: (listener) => {
			closeListeners.add(listener);
			return () => closeListeners.delete(listener);
		},
		onError: (listener) => {
			errorListeners.add(listener);
			return () => errorListeners.delete(listener);
		},
	};
}

function abortError(description: string): Error {
	return new Error(`Aborted while connecting to ${description}`);
}

async function waitForConnection(
	description: string,
	signal: AbortSignal,
	timeoutMs: number | undefined,
	subscribe: (resolve: () => void, reject: (error: Error) => void) => () => void,
): Promise<void> {
	if (signal.aborted) throw abortError(description);
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		let actualUnsubscribe: (() => void) | undefined;
		let unsubscribeRequested = false;
		const unsubscribe = (): void => {
			if (actualUnsubscribe) actualUnsubscribe();
			else unsubscribeRequested = true;
		};
		const cleanup = (): void => {
			if (timer) clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			unsubscribe();
		};
		const succeed = (): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve();
		};
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = (): void => fail(abortError(description));
		actualUnsubscribe = subscribe(succeed, fail);
		if (unsubscribeRequested) actualUnsubscribe();
		if (settled) return;
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
			return;
		}
		if (timeoutMs !== undefined && timeoutMs > 0) {
			timer = setTimeout(
				() => fail(new Error(`Timed out connecting to ${description} after ${timeoutMs}ms`)),
				timeoutMs,
			);
		}
	});
}

function mergeEnvironment(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
	return extra ? { ...process.env, ...extra } : process.env;
}

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill("SIGTERM");
	let timer: NodeJS.Timeout | undefined;
	const exitedGracefully = await Promise.race([
		exited.then(() => true),
		new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), 2000);
			timer.unref();
		}),
	]);
	if (timer) clearTimeout(timer);
	if (exitedGracefully) return;
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	let killTimer: NodeJS.Timeout | undefined;
	await Promise.race([
		exited,
		new Promise<void>((resolve) => {
			killTimer = setTimeout(resolve, 2000);
			killTimer.unref();
		}),
	]);
	if (killTimer) clearTimeout(killTimer);
}

export function createManagedStdioConnectionFactory(options: {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}): LspConnectionFactory {
	return async (context) => {
		const cwd = options.cwd ?? context.workspaceRoot;
		const description = `managed LSP process ${JSON.stringify(options.command)}`;
		const child = spawn(options.command, options.args ?? [], {
			cwd,
			env: mergeEnvironment(options.env),
			stdio: "pipe",
		});
		try {
			await waitForConnection(description, context.signal, context.connectTimeoutMs, (resolve, reject) => {
				const onError = (error: Error): void =>
					reject(new Error(`Failed to spawn ${description}: ${error.message}`, { cause: error }));
				child.once("spawn", resolve);
				child.once("error", onError);
				return () => {
					child.off("spawn", resolve);
					child.off("error", onError);
				};
			});
		} catch (error) {
			await terminateChild(child);
			throw error;
		}

		const events = createConnectionEvents();
		let closed = false;
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => context.onStderr?.(chunk));
		child.stdin.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") events.emitError(error);
		});
		child.on("error", (error) => events.emitError(error));
		child.on("exit", () => events.emitClose());
		return {
			reader: new StreamMessageReader(child.stdout),
			writer: new StreamMessageWriter(child.stdin),
			endpoint: {
				type: "spawn",
				description: `${description} (pid ${child.pid ?? "unknown"})`,
				disposalMode: "terminate-process",
			},
			close: async () => {
				if (closed) return;
				closed = true;
				await terminateChild(child);
			},
			onClose: events.onClose,
			onError: events.onError,
		};
	};
}

async function connectSocket(
	description: string,
	endpointType: "tcp" | "unix" | "pipe",
	context: LspConnectionFactoryContext,
	createSocket: () => Socket,
): Promise<LspConnectionHandle> {
	const socket = createSocket();
	try {
		await waitForConnection(description, context.signal, context.connectTimeoutMs, (resolve, reject) => {
			const onError = (error: Error): void =>
				reject(new Error(`Failed to connect to ${description}: ${error.message}`, { cause: error }));
			socket.once("connect", resolve);
			socket.once("error", onError);
			return () => {
				socket.off("connect", resolve);
				socket.off("error", onError);
			};
		});
	} catch (error) {
		socket.destroy();
		throw error;
	}

	const events = createConnectionEvents();
	let closed = false;
	socket.on("error", (error) => events.emitError(error));
	socket.on("close", () => events.emitClose());
	return {
		reader: new SocketMessageReader(socket),
		writer: new SocketMessageWriter(socket),
		endpoint: { type: endpointType, description, disposalMode: "disconnect" },
		close: async () => {
			if (closed) return;
			closed = true;
			if (socket.destroyed) return;
			await new Promise<void>((resolve) => {
				socket.once("close", resolve);
				socket.destroy();
			});
		},
		onClose: events.onClose,
		onError: events.onError,
	};
}

export function createTcpConnectionFactory(host: string, port: number): LspConnectionFactory {
	return (context) =>
		connectSocket(`TCP LSP endpoint ${host}:${port}`, "tcp", context, () => createConnection({ host, port }));
}

export function createUnixSocketConnectionFactory(path: string): LspConnectionFactory {
	return (context) => connectSocket(`Unix LSP socket ${path}`, "unix", context, () => createConnection(path));
}

export function createNamedPipeConnectionFactory(path: string): LspConnectionFactory {
	return (context) => connectSocket(`LSP named pipe ${path}`, "pipe", context, () => createConnection(path));
}

export function resolveLspConnectionFactory(
	transport: LspTransport,
	programmaticFactories: LspConnectionFactoryRegistry = {},
): LspConnectionFactory {
	switch (transport.type) {
		case "spawn":
			return createManagedStdioConnectionFactory(transport);
		case "tcp":
			return createTcpConnectionFactory(transport.host, transport.port);
		case "unix":
			return createUnixSocketConnectionFactory(transport.path);
		case "pipe":
			return createNamedPipeConnectionFactory(transport.path);
		case "connection": {
			const factory = Object.hasOwn(programmaticFactories, transport.id)
				? programmaticFactories[transport.id]
				: undefined;
			if (!factory) throw new Error(`No LSP connection factory is registered for ${JSON.stringify(transport.id)}`);
			return factory;
		}
	}
}
