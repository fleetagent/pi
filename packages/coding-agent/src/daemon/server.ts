import { randomBytes } from "node:crypto";
import {
	createServer as createHttpServer,
	type Server as HttpServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import type { RemoteWorkspaceServerMessage } from "../core/remote-workspace-protocol/contract.ts";
import {
	type RemoteWorkspaceProtocolCloseReason,
	type RemoteWorkspaceServerHandler,
	RemoteWorkspaceServerProtocol,
} from "../core/remote-workspace-protocol/session.ts";
import type { DaemonConfiguration } from "./config.ts";
import {
	createDaemonAuthorization,
	rejectDaemonUpgrade,
	validateDaemonNetworkPolicy,
	validateDaemonUpgrade,
} from "./security.ts";
import { createDaemonWorkspaceRuntime } from "./workspace-runtime.ts";

export interface DaemonServerAddress {
	readonly host: string;
	readonly port: number;
	readonly secure: boolean;
	readonly url: string;
	readonly workspaceRoot: string;
	readonly workspaceId: string;
}

export type DaemonServerState = "created" | "listening" | "closing" | "closed";

export interface DaemonServer {
	listen(): Promise<DaemonServerAddress>;
	address(): DaemonServerAddress | undefined;
	state(): DaemonServerState;
	reload(): Promise<void>;
	close(): Promise<void>;
	forceClose(): Promise<void>;
}

interface DaemonConnection {
	readonly websocket: WebSocket;
	readonly protocol: RemoteWorkspaceServerProtocol;
	closed: Promise<void>;
}

function websocketPayload(data: RawData): Uint8Array {
	if (Buffer.isBuffer(data)) return Uint8Array.from(data);
	if (Array.isArray(data)) return Uint8Array.from(Buffer.concat(data));
	return Uint8Array.from(new Uint8Array(data));
}

function websocketCloseCode(code: RemoteWorkspaceProtocolCloseReason["code"]): number {
	switch (code) {
		case "normal":
			return 1000;
		case "protocol_error":
			return 1002;
		case "invalid_payload":
			return 1007;
		case "policy_violation":
			return 1008;
		case "message_too_large":
			return 1009;
	}
}

function waitForWebSocketClose(websocket: WebSocket): Promise<void> {
	if (websocket.readyState === WebSocket.CLOSED) return Promise.resolve();
	return new Promise((resolve) => websocket.once("close", () => resolve()));
}

function waitWithin(promise: Promise<unknown>, timeoutMs: number, forceSignal: AbortSignal): Promise<boolean> {
	if (forceSignal.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			forceSignal.removeEventListener("abort", onForce);
			resolve(value);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		const onForce = () => finish(false);
		forceSignal.addEventListener("abort", onForce, { once: true });
		promise.then(
			() => finish(true),
			() => finish(false),
		);
	});
}

function formatHostForUrl(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function createDaemonServer(configuration: DaemonConfiguration): DaemonServer {
	validateDaemonNetworkPolicy(configuration);
	const authorization = createDaemonAuthorization(configuration.token);
	const workspaceId = randomBytes(18).toString("base64url");
	const workspace = Object.freeze({
		id: workspaceId,
		root: configuration.workspaceRoot,
		pathFlavor: process.platform === "win32" ? ("windows" as const) : ("posix" as const),
	});
	let runtime = createDaemonWorkspaceRuntime(configuration);
	let runtimeHandler = runtime.createHandler(workspace);
	const handler: RemoteWorkspaceServerHandler = {
		handleRequest: (request, context) => runtimeHandler.handleRequest(request, context),
		validateToolArguments: (toolName, value) => runtimeHandler.validateToolArguments(toolName, value),
	};
	const requestListener = (_request: IncomingMessage, response: ServerResponse) => {
		response.writeHead(404, { "content-type": "text/plain" });
		response.end("Not found\n");
	};
	const server: HttpServer = configuration.tls
		? createHttpsServer(
				{
					cert: configuration.tls.cert,
					key: configuration.tls.key,
					passphrase: configuration.tls.passphrase,
					minVersion: "TLSv1.2",
				},
				requestListener,
			)
		: createHttpServer(requestListener);
	const websocketServer = new WebSocketServer({
		noServer: true,
		clientTracking: false,
		maxPayload: configuration.protocolLimits.maxMessageBytes,
		perMessageDeflate: false,
		allowSynchronousEvents: false,
		skipUTF8Validation: false,
	});
	const sockets = new Set<Socket>();
	const pendingSockets = new Set<Socket>();
	const pendingSocketTimers = new Map<Socket, NodeJS.Timeout>();
	const pendingSocketDeadlines = new Map<Socket, number>();
	const connections = new Set<DaemonConnection>();
	let catalog = runtime.catalog;
	let reloadQueue: Promise<void> = Promise.resolve();
	const forceController = new AbortController();
	let currentAddress: DaemonServerAddress | undefined;
	let listenPromise: Promise<DaemonServerAddress> | undefined;
	let rejectListen: ((error: Error) => void) | undefined;
	let closePromise: Promise<void> | undefined;
	let serverState: DaemonServerState = "created";

	const stopListener = (): Promise<void> => {
		if (!server.listening && !listenPromise) return Promise.resolve();
		return new Promise((resolve) => {
			let settled = false;
			const cleanup = () => {
				server.off("listening", onListening);
				server.off("error", onError);
				server.off("close", onClose);
			};
			const finish = () => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve();
			};
			const closeListener = () => server.close(() => finish());
			const onListening = () => closeListener();
			const onError = () => finish();
			const onClose = () => finish();
			server.once("error", onError);
			server.once("close", onClose);
			if (server.listening) closeListener();
			else server.once("listening", onListening);
		});
	};

	server.on("connection", (socket: Socket) => {
		if (serverState !== "listening" || pendingSockets.size >= configuration.maxPendingConnections) {
			socket.destroy();
			return;
		}
		sockets.add(socket);
		pendingSockets.add(socket);
		const pendingTimer = setTimeout(() => socket.destroy(), configuration.handshakeTimeoutMs);
		pendingTimer.unref?.();
		pendingSocketTimers.set(socket, pendingTimer);
		pendingSocketDeadlines.set(socket, performance.now() + configuration.handshakeTimeoutMs);
		socket.once("close", () => {
			sockets.delete(socket);
			pendingSockets.delete(socket);
			const timer = pendingSocketTimers.get(socket);
			if (timer) clearTimeout(timer);
			pendingSocketTimers.delete(socket);
			pendingSocketDeadlines.delete(socket);
		});
	});

	server.on("upgrade", (request, socket, head) => {
		const netSocket = socket as Socket;
		const decision = validateDaemonUpgrade(request, configuration, authorization);
		if (!decision.accepted) {
			rejectDaemonUpgrade(netSocket, decision);
			return;
		}
		if (serverState !== "listening" || connections.size >= configuration.maxConnections) {
			rejectDaemonUpgrade(netSocket, { accepted: false, status: 503, message: "Service unavailable" });
			return;
		}
		const handshakeDeadline = pendingSocketDeadlines.get(netSocket) ?? performance.now();
		pendingSockets.delete(netSocket);
		const pendingTimer = pendingSocketTimers.get(netSocket);
		if (pendingTimer) clearTimeout(pendingTimer);
		pendingSocketTimers.delete(netSocket);
		pendingSocketDeadlines.delete(netSocket);
		websocketServer.handleUpgrade(request, socket, head, (websocket) => {
			if (serverState !== "listening") {
				websocket.terminate();
				return;
			}
			const remainingHandshakeMs = Math.max(0, handshakeDeadline - performance.now());
			const handshakeTimer = setTimeout(() => {
				websocket.terminate();
			}, remainingHandshakeMs);
			handshakeTimer.unref?.();
			let protocol: RemoteWorkspaceServerProtocol;
			const transport = {
				send(message: RemoteWorkspaceServerMessage): Promise<void> {
					if (websocket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("WebSocket is not open"));
					const serialized = JSON.stringify(message);
					const bytes = Buffer.byteLength(serialized, "utf8");
					if (websocket.bufferedAmount + bytes > configuration.protocolLimits.maxPendingOutboundBytes) {
						return Promise.reject(new Error("WebSocket outbound buffer exceeds daemon limits"));
					}
					return new Promise((resolve, reject) => {
						websocket.send(serialized, { binary: false, compress: false }, (error) => {
							if (error) reject(error);
							else resolve();
						});
					});
				},
				close(reason: RemoteWorkspaceProtocolCloseReason): Promise<void> {
					if (websocket.readyState === WebSocket.CLOSED) return Promise.resolve();
					websocket.close(websocketCloseCode(reason.code), reason.message);
					return waitForWebSocketClose(websocket);
				},
			};
			protocol = new RemoteWorkspaceServerProtocol(transport, handler, {
				workspace,
				catalog,
				capabilities: runtime.capabilities,
				limits: configuration.protocolLimits,
				backendLabel: "pi-workspace-daemon",
			});
			const connection: DaemonConnection = {
				websocket,
				protocol,
				closed: Promise.resolve(),
			};
			connection.closed = waitForWebSocketClose(websocket).then(async () => {
				clearTimeout(handshakeTimer);
				connections.delete(connection);
				await protocol.disconnect().catch(() => undefined);
			});
			connections.add(connection);
			websocket.on("message", (data, isBinary) => {
				if (isBinary) {
					websocket.close(1003, "Text protocol required");
					return;
				}
				void protocol
					.receive(websocketPayload(data))
					.then(() => {
						if (protocol.handshakeComplete) clearTimeout(handshakeTimer);
					})
					.catch(() => undefined);
			});
			websocket.on("error", () => undefined);
		});
	});

	const api: DaemonServer = {
		listen(): Promise<DaemonServerAddress> {
			if (serverState === "closing" || serverState === "closed")
				return Promise.reject(new Error("Daemon server is closing"));
			if (currentAddress) return Promise.resolve(currentAddress);
			if (listenPromise) return listenPromise;
			listenPromise = new Promise((resolve, reject) => {
				rejectListen = reject;
				const onError = (error: Error) => {
					server.off("listening", onListening);
					listenPromise = undefined;
					rejectListen = undefined;
					reject(error);
				};
				const onListening = () => {
					server.off("error", onError);
					if (serverState !== "created") {
						rejectListen = undefined;
						reject(new Error("Daemon server closed before listening completed"));
						return;
					}
					const address = server.address();
					if (!address || typeof address === "string") {
						rejectListen = undefined;
						reject(new Error("Daemon listener did not return a TCP address"));
						return;
					}
					serverState = "listening";
					const port = (address as AddressInfo).port;
					currentAddress = Object.freeze({
						host: configuration.host,
						port,
						secure: configuration.tls !== undefined,
						url: `${configuration.tls ? "wss" : "ws"}://${formatHostForUrl(configuration.host)}:${port}/pi/workspace`,
						workspaceRoot: configuration.workspaceRoot,
						workspaceId,
					});
					rejectListen = undefined;
					resolve(currentAddress);
				};
				server.once("error", onError);
				server.once("listening", onListening);
				server.listen(configuration.port, configuration.host);
			});
			return listenPromise;
		},
		address(): DaemonServerAddress | undefined {
			return currentAddress ? { ...currentAddress } : undefined;
		},
		state(): DaemonServerState {
			return serverState;
		},
		reload(): Promise<void> {
			if (serverState !== "listening") return Promise.reject(new Error("Daemon server is not listening"));
			reloadQueue = reloadQueue.then(async () => {
				if (serverState !== "listening") throw new Error("Daemon server is not listening");
				const candidate = createDaemonWorkspaceRuntime(configuration);
				const candidateCatalog = { ...candidate.catalog, generation: catalog.generation + 1 };
				const previous = runtime;
				const previousCatalog = catalog;
				runtime = candidate;
				runtimeHandler = candidate.createHandler(workspace);
				catalog = candidateCatalog;
				try {
					await Promise.all([...connections].map((connection) => connection.protocol.publishCatalog(catalog)));
				} catch (error) {
					runtime = previous;
					runtimeHandler = previous.createHandler(workspace);
					catalog = previousCatalog;
					await Promise.allSettled([...connections].map((connection) => connection.protocol.disconnect()));
					await candidate.dispose();
					throw error;
				}
				await previous.retire();
			});
			return reloadQueue;
		},
		close(): Promise<void> {
			if (closePromise) return closePromise;
			serverState = "closing";
			rejectListen?.(new Error("Daemon server closed before listening completed"));
			rejectListen = undefined;
			const deadline = performance.now() + configuration.shutdownTimeoutMs;
			const remainingMs = () => Math.max(0, deadline - performance.now());
			closePromise = (async () => {
				const listenerClose = stopListener();
				const snapshot = [...connections];
				await waitWithin(
					reloadQueue.catch(() => undefined),
					remainingMs(),
					forceController.signal,
				);
				const hostDisposal = runtime.dispose();
				const drained = await waitWithin(
					Promise.allSettled([
						...snapshot.map((connection) => connection.protocol.beginDrain()),
						hostDisposal,
					]).then(() => undefined),
					remainingMs(),
					forceController.signal,
				);
				if (!drained) for (const connection of snapshot) connection.websocket.terminate();
				await waitWithin(
					Promise.allSettled(snapshot.map((connection) => connection.protocol.disconnect())).then(() => undefined),
					remainingMs(),
					forceController.signal,
				);
				for (const connection of snapshot) {
					if (connection.websocket.readyState === WebSocket.OPEN)
						connection.websocket.close(1001, "Daemon shutting down");
				}
				const socketsClosed = await waitWithin(
					Promise.allSettled(snapshot.map((connection) => connection.closed)).then(() => undefined),
					remainingMs(),
					forceController.signal,
				);
				if (!socketsClosed) for (const connection of snapshot) connection.websocket.terminate();
				for (const socket of sockets) socket.destroy();
				await listenerClose;
				connections.clear();
			})().finally(() => {
				for (const connection of connections) connection.websocket.terminate();
				for (const socket of sockets) socket.destroy();
				for (const timer of pendingSocketTimers.values()) clearTimeout(timer);
				pendingSocketTimers.clear();
				pendingSocketDeadlines.clear();
				pendingSockets.clear();
				connections.clear();
				currentAddress = undefined;
				serverState = "closed";
			});
			return closePromise;
		},
		forceClose(): Promise<void> {
			if (serverState === "closed") return closePromise ?? Promise.resolve();
			serverState = "closing";
			forceController.abort();
			currentAddress = undefined;
			for (const connection of connections) connection.websocket.terminate();
			for (const socket of sockets) socket.destroy();
			return api.close();
		},
	};
	return api;
}
