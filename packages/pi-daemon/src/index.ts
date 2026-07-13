#!/usr/bin/env node

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { resolve } from "node:path";

interface JsonRpcMessage {
	id?: unknown;
	method?: unknown;
	params?: unknown;
}

interface UploadState {
	stream: WriteStream;
	bytes: number;
}

interface ClientConnection {
	socket: Socket;
	buffer: Buffer;
	execs: Map<string, ChildProcessWithoutNullStreams>;
	uploads: Map<string, UploadState>;
	requestControllers: Set<AbortController>;
	activeRequests: number;
	closed: boolean;
}

const port = Number(process.env.PORT ?? process.env.PI_DAEMON_PORT ?? "8787");
const host = process.env.HOST ?? process.env.PI_DAEMON_HOST ?? "127.0.0.1";
const cwd = resolve(process.env.PI_DAEMON_CWD ?? process.cwd());
const token = process.env.PI_DAEMON_TOKEN;
const fileTransferChunkSize = 64 * 1024;
const maxFramePayloadBytes = Number(process.env.PI_DAEMON_MAX_FRAME_BYTES ?? 1024 * 1024);
const maxConnectionRequests = Number(process.env.PI_DAEMON_MAX_CONNECTION_REQUESTS ?? 8);
const maxGlobalRequests = Number(process.env.PI_DAEMON_MAX_GLOBAL_REQUESTS ?? 64);
const maxConnectionBufferBytes = maxFramePayloadBytes + 14;
const maxConnectionUploads = Number(process.env.PI_DAEMON_MAX_CONNECTION_UPLOADS ?? 4);
const maxGlobalUploads = Number(process.env.PI_DAEMON_MAX_GLOBAL_UPLOADS ?? 32);
const maxUploadBytes = Number(process.env.PI_DAEMON_MAX_UPLOAD_BYTES ?? 100 * 1024 * 1024);
const maxBufferedProcessOutputBytes = Number(process.env.PI_DAEMON_MAX_BUFFERED_OUTPUT_BYTES ?? 8 * 1024 * 1024);
let activeGlobalRequests = 0;
let activeGlobalUploads = 0;

function createFrame(payload: unknown): Buffer {
	const data = Buffer.from(JSON.stringify(payload));
	let header: Buffer;
	if (data.length < 126) {
		header = Buffer.from([0x81, data.length]);
	} else if (data.length <= 0xffff) {
		header = Buffer.alloc(4);
		header[0] = 0x81;
		header[1] = 126;
		header.writeUInt16BE(data.length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x81;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(data.length), 2);
	}
	return Buffer.concat([header, data]);
}

function sendFrame(socket: Socket, payload: unknown): boolean {
	if (socket.destroyed || !socket.writable) return true;
	return socket.write(createFrame(payload));
}

function waitForSocketDrain(socket: Socket): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const cleanup = () => {
			socket.off("drain", onDrain);
			socket.off("close", onClose);
			socket.off("error", onError);
		};
		const onDrain = () => {
			cleanup();
			resolvePromise();
		};
		const onClose = () => {
			cleanup();
			reject(new Error("Socket closed before write drained"));
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		socket.once("drain", onDrain);
		socket.once("close", onClose);
		socket.once("error", onError);
	});
}

async function sendFrameAsync(socket: Socket, payload: unknown): Promise<void> {
	if (socket.destroyed || !socket.writable) throw new Error("Socket is closed");
	if (!socket.write(createFrame(payload))) await waitForSocketDrain(socket);
}

function sendResult(connection: ClientConnection, id: string, result: unknown): void {
	sendFrame(connection.socket, { id, result });
}

function sendError(connection: ClientConnection, id: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	sendFrame(connection.socket, { id, error: { message } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string") throw new Error(`Missing string param: ${name}`);
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function accessModeToFsMode(mode: unknown): number {
	switch (mode) {
		case "read":
			return constants.R_OK;
		case "write":
			return constants.W_OK;
		case "readwrite":
			return constants.R_OK | constants.W_OK;
		case "exists":
		case undefined:
			return constants.F_OK;
		default:
			throw new Error(`Invalid access mode: ${String(mode)}`);
	}
}

function buildFdArgs(pattern: string, searchPath: string, limit: number): string[] {
	const args: string[] = ["--glob", "--color=never", "--hidden", "--no-require-git", "--max-results", String(limit)];
	let effectivePattern = pattern;
	if (pattern.includes("/")) {
		args.push("--full-path");
		if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
			effectivePattern = `**/${pattern}`;
		}
	}
	args.push("--", effectivePattern, searchPath);
	return args;
}

function buildRgArgs(params: Record<string, unknown>): string[] {
	const pattern = requireString(params.pattern, "pattern");
	const path = requireString(params.path, "path");
	const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
	if (params.ignoreCase === true) args.push("--ignore-case");
	if (params.literal === true) args.push("--fixed-strings");
	const glob = optionalString(params.glob);
	if (glob) args.push("--glob", glob);
	args.push("--", pattern, path);
	return args;
}

async function runBuffered(command: string, args: string[], runCwd: string, signal?: AbortSignal): Promise<Buffer> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { cwd: runCwd, stdio: ["ignore", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let bufferedBytes = 0;
		let settled = false;
		const finish = (error?: Error, output?: Buffer) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolvePromise(output ?? Buffer.alloc(0));
		};
		const onAbort = () => {
			child.kill();
			finish(new Error("Request cancelled"));
		};
		const collect = (target: Buffer[], data: Buffer) => {
			bufferedBytes += data.length;
			if (bufferedBytes > maxBufferedProcessOutputBytes) {
				child.kill();
				finish(new Error(`Process output exceeds ${maxBufferedProcessOutputBytes} bytes`));
				return;
			}
			target.push(data);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (data: Buffer) => collect(stdout, data));
		child.stderr.on("data", (data: Buffer) => collect(stderr, data));
		child.on("error", (error) => finish(error));
		child.on("close", (code) => {
			if (settled) return;
			if (code === 0) {
				finish(undefined, Buffer.concat(stdout));
				return;
			}
			finish(new Error(Buffer.concat(stderr).toString("utf-8").trim() || `${command} exited with code ${code}`));
		});
	});
}

function removeUpload(connection: ClientConnection, id: string, destroy: boolean): UploadState | undefined {
	const upload = connection.uploads.get(id);
	if (!upload) return undefined;
	connection.uploads.delete(id);
	activeGlobalUploads--;
	if (destroy) upload.stream.destroy();
	return upload;
}

function handleExec(
	connection: ClientConnection,
	id: string,
	params: Record<string, unknown>,
	signal: AbortSignal,
): Promise<void> {
	return new Promise((resolvePromise) => {
		const command = requireString(params.command, "command");
		const runCwd = optionalString(params.cwd) ?? cwd;
		const timeout = optionalNumber(params.timeout);
		const env = isRecord(params.env)
			? Object.fromEntries(
					Object.entries(params.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
				)
			: undefined;
		const child = spawn("bash", ["-lc", command], {
			cwd: runCwd,
			detached: process.platform !== "win32",
			env: env ? { ...process.env, ...env } : process.env,
		});
		connection.execs.set(id, child);
		const kill = () => {
			if (process.platform !== "win32" && child.pid) {
				try {
					process.kill(-child.pid);
				} catch {
					child.kill();
				}
			} else {
				child.kill();
			}
		};
		signal.addEventListener("abort", kill, { once: true });
		let timeoutHandle: NodeJS.Timeout | undefined;
		if (timeout !== undefined && timeout > 0) timeoutHandle = setTimeout(kill, timeout * 1000);
		const cleanup = () => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			signal.removeEventListener("abort", kill);
			resolvePromise();
		};
		let drainPromise: Promise<void> | undefined;
		const pausedStreams = new Set<typeof child.stdout>();
		const sendExecData = (stream: typeof child.stdout, data: Buffer, streamName: "stdout" | "stderr") => {
			const writable = sendFrame(connection.socket, {
				id,
				event: "data",
				stream: streamName,
				dataBase64: data.toString("base64"),
			});
			if (writable) return;
			stream.pause();
			pausedStreams.add(stream);
			if (drainPromise) return;
			drainPromise = waitForSocketDrain(connection.socket);
			void drainPromise
				.then(
					() => {
						for (const pausedStream of pausedStreams) pausedStream.resume();
						pausedStreams.clear();
					},
					() => kill(),
				)
				.finally(() => {
					drainPromise = undefined;
				});
		};
		child.stdout.on("data", (data: Buffer) => sendExecData(child.stdout, data, "stdout"));
		child.stderr.on("data", (data: Buffer) => sendExecData(child.stderr, data, "stderr"));
		child.on("error", (error) => {
			const active = connection.execs.get(id) === child;
			if (active) connection.execs.delete(id);
			if (active) sendFrame(connection.socket, { id, event: "error", error: { message: error.message } });
			cleanup();
		});
		child.on("close", (code) => {
			const active = connection.execs.get(id) === child;
			if (active) connection.execs.delete(id);
			if (active) sendFrame(connection.socket, { id, event: "exit", exitCode: code });
			cleanup();
		});
	});
}

function cancelExec(connection: ClientConnection, id: string): void {
	const child = connection.execs.get(id);
	if (!child) return;
	connection.execs.delete(id);
	if (process.platform !== "win32" && child.pid) {
		try {
			process.kill(-child.pid);
		} catch {
			child.kill();
		}
	} else {
		child.kill();
	}
	sendFrame(connection.socket, { id, event: "exit", exitCode: null, cancelled: true });
}

async function handleDownloadFile(
	connection: ClientConnection,
	id: string,
	path: string,
	signal: AbortSignal,
): Promise<void> {
	try {
		const readStream = createReadStream(path, { highWaterMark: fileTransferChunkSize });
		const cancel = () => readStream.destroy(new Error("Request cancelled"));
		signal.addEventListener("abort", cancel, { once: true });
		try {
			for await (const chunk of readStream) {
				const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
				await sendFrameAsync(connection.socket, { id, event: "fileData", dataBase64: buffer.toString("base64") });
			}
			await sendFrameAsync(connection.socket, { id, event: "fileEnd" });
		} finally {
			signal.removeEventListener("abort", cancel);
		}
	} catch (error) {
		sendFrame(connection.socket, {
			id,
			event: "fileError",
			error: { message: error instanceof Error ? error.message : String(error) },
		});
	}
}

function writeUploadChunk(stream: WriteStream, chunk: Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			stream.off("error", onError);
			reject(error);
		};
		stream.once("error", onError);
		stream.write(chunk, (error) => {
			stream.off("error", onError);
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

function closeUploadStream(stream: WriteStream): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			stream.off("error", onError);
			reject(error);
		};
		stream.once("error", onError);
		stream.end(() => {
			stream.off("error", onError);
			resolve();
		});
	});
}

async function handleRequest(
	connection: ClientConnection,
	message: JsonRpcMessage,
	signal: AbortSignal,
): Promise<void> {
	const id = requireString(message.id, "id");
	const method = requireString(message.method, "method");
	const params = isRecord(message.params) ? message.params : {};
	try {
		if (method === "cancel") {
			cancelExec(connection, id);
			return;
		}
		if (method === "exec") {
			await handleExec(connection, id, params, signal);
			return;
		}
		if (method === "capabilities") {
			sendResult(connection, id, {
				cwd,
				features: {
					exec: true,
					files: true,
					fileTransfer: true,
					glob: true,
					grep: true,
					instructions: false,
				},
			});
			return;
		}
		if (method === "access") {
			await access(requireString(params.path, "path"), accessModeToFsMode(params.mode));
			sendResult(connection, id, {});
			return;
		}
		if (method === "readFile") {
			const content = await readFile(requireString(params.path, "path"));
			sendResult(connection, id, { contentBase64: content.toString("base64") });
			return;
		}
		if (method === "writeFile") {
			await writeFile(
				requireString(params.path, "path"),
				Buffer.from(requireString(params.contentBase64, "contentBase64"), "base64"),
			);
			sendResult(connection, id, {});
			return;
		}
		if (method === "downloadFile") {
			await handleDownloadFile(connection, id, requireString(params.path, "path"), signal);
			return;
		}
		if (method === "uploadFileStart") {
			if (connection.uploads.has(id)) throw new Error(`Upload already exists: ${id}`);
			if (connection.uploads.size >= maxConnectionUploads) {
				throw new Error(`Too many concurrent uploads for this connection (max ${maxConnectionUploads})`);
			}
			if (activeGlobalUploads >= maxGlobalUploads) {
				throw new Error(`Too many concurrent daemon uploads (max ${maxGlobalUploads})`);
			}
			const path = requireString(params.path, "path");
			const stream = createWriteStream(path);
			const upload: UploadState = { stream, bytes: 0 };
			connection.uploads.set(id, upload);
			activeGlobalUploads++;
			stream.once("error", () => removeUpload(connection, id, false));
			sendResult(connection, id, {});
			return;
		}
		if (method === "uploadFileChunk") {
			const uploadId = requireString(params.uploadId, "uploadId");
			const upload = connection.uploads.get(uploadId);
			if (!upload) throw new Error(`Unknown upload: ${uploadId}`);
			const chunk = Buffer.from(requireString(params.dataBase64, "dataBase64"), "base64");
			if (upload.bytes + chunk.length > maxUploadBytes) {
				removeUpload(connection, uploadId, true);
				throw new Error(`Upload exceeds ${maxUploadBytes} bytes`);
			}
			upload.bytes += chunk.length;
			await writeUploadChunk(upload.stream, chunk);
			sendResult(connection, id, {});
			return;
		}
		if (method === "uploadFileEnd") {
			const uploadId = requireString(params.uploadId, "uploadId");
			const upload = removeUpload(connection, uploadId, false);
			if (!upload) throw new Error(`Unknown upload: ${uploadId}`);
			await closeUploadStream(upload.stream);
			sendResult(connection, id, {});
			return;
		}
		if (method === "uploadFileCancel") {
			const uploadId = requireString(params.uploadId, "uploadId");
			removeUpload(connection, uploadId, true);
			sendResult(connection, id, {});
			return;
		}
		if (method === "mkdir") {
			await mkdir(requireString(params.path, "path"), { recursive: params.recursive === true });
			sendResult(connection, id, {});
			return;
		}
		if (method === "stat") {
			const result = await stat(requireString(params.path, "path"));
			sendResult(connection, id, { isDirectory: result.isDirectory(), isFile: result.isFile() });
			return;
		}
		if (method === "readdir") {
			sendResult(connection, id, { entries: await readdir(requireString(params.path, "path")) });
			return;
		}
		if (method === "glob") {
			const pattern = requireString(params.pattern, "pattern");
			const runCwd = requireString(params.cwd, "cwd");
			const limit = optionalNumber(params.limit) ?? 1000;
			const output = await runBuffered("fd", buildFdArgs(pattern, runCwd, limit), runCwd, signal);
			sendResult(connection, id, { matches: output.toString("utf-8").split("\n").filter(Boolean) });
			return;
		}
		if (method === "grep") {
			const pathParam = requireString(params.path, "path");
			const isDirectory = (await stat(pathParam)).isDirectory();
			const output = await runBuffered("rg", buildRgArgs(params), cwd, signal);
			const matches = output
				.toString("utf-8")
				.split("\n")
				.filter(Boolean)
				.flatMap((line) => {
					try {
						const data = JSON.parse(line) as unknown;
						if (!isRecord(data) || data.type !== "match" || !isRecord(data.data)) return [];
						const filePath = isRecord(data.data.path) ? optionalString(data.data.path.text) : undefined;
						const lineNumber = optionalNumber(data.data.line_number);
						const lineText = isRecord(data.data.lines) ? optionalString(data.data.lines.text) : undefined;
						return filePath && lineNumber !== undefined ? [{ filePath, lineNumber, lineText }] : [];
					} catch {
						return [];
					}
				});
			sendResult(connection, id, { isDirectory, matches });
			return;
		}
		if (method === "detectImageMimeType") {
			const output = await runBuffered(
				"file",
				["--mime-type", "-b", requireString(params.path, "path")],
				cwd,
				signal,
			);
			const mimeType = output.toString("utf-8").trim();
			sendResult(connection, id, {
				mimeType: ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType) ? mimeType : null,
			});
			return;
		}
		throw new Error(`Unknown method: ${method}`);
	} catch (error) {
		sendError(connection, id, error);
	}
}

function getIncomingDeclaredPayloadLength(buffer: Buffer, chunk: Buffer): bigint | undefined {
	const header = Buffer.concat([buffer.subarray(0, 10), chunk.subarray(0, Math.max(0, 10 - buffer.length))]);
	if (header.length < 2) return undefined;
	const marker = header[1] & 0x7f;
	if (marker < 126) return BigInt(marker);
	if (marker === 126) return header.length >= 4 ? BigInt(header.readUInt16BE(2)) : undefined;
	return header.length >= 10 ? header.readBigUInt64BE(2) : undefined;
}

function dispatchRequest(connection: ClientConnection, message: JsonRpcMessage): void {
	const id = typeof message.id === "string" ? message.id : "unknown";
	if (message.method === "cancel") {
		cancelExec(connection, id);
		return;
	}
	if (connection.activeRequests >= maxConnectionRequests) {
		sendError(
			connection,
			id,
			new Error(`Too many concurrent requests for this connection (max ${maxConnectionRequests})`),
		);
		return;
	}
	if (activeGlobalRequests >= maxGlobalRequests) {
		sendError(connection, id, new Error(`Too many concurrent daemon requests (max ${maxGlobalRequests})`));
		return;
	}
	const controller = new AbortController();
	connection.requestControllers.add(controller);
	connection.activeRequests++;
	activeGlobalRequests++;
	void handleRequest(connection, message, controller.signal)
		.catch((error: unknown) => sendError(connection, id, error))
		.finally(() => {
			connection.requestControllers.delete(controller);
			connection.activeRequests--;
			activeGlobalRequests--;
		});
}

function parseFrames(connection: ClientConnection): void {
	while (connection.buffer.length >= 2) {
		const first = connection.buffer[0];
		const second = connection.buffer[1];
		const reservedBits = first & 0x70;
		if (reservedBits !== 0) {
			connection.socket.destroy(new Error("WebSocket reserved bits require a negotiated extension"));
			return;
		}
		const opcode = first & 0x0f;
		const final = (first & 0x80) !== 0;
		const masked = (second & 0x80) !== 0;
		let payloadLength = second & 0x7f;
		let offset = 2;
		if (payloadLength === 126) {
			if (connection.buffer.length < offset + 2) return;
			payloadLength = connection.buffer.readUInt16BE(offset);
			offset += 2;
		} else if (payloadLength === 127) {
			if (connection.buffer.length < offset + 8) return;
			const largeLength = connection.buffer.readBigUInt64BE(offset);
			if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) {
				connection.socket.destroy(new Error("WebSocket frame too large"));
				return;
			}
			payloadLength = Number(largeLength);
			offset += 8;
		}
		if (payloadLength > maxFramePayloadBytes) {
			connection.socket.destroy(new Error(`WebSocket frame exceeds ${maxFramePayloadBytes} bytes`));
			return;
		}
		if (!final && (opcode === 0x0 || opcode === 0x1 || opcode === 0x2)) {
			connection.socket.destroy(new Error("Fragmented WebSocket messages are not supported"));
			return;
		}
		if (opcode >= 0x8 && (!final || payloadLength > 125)) {
			connection.socket.destroy(new Error("Invalid WebSocket control frame"));
			return;
		}
		if (opcode !== 0x1 && opcode !== 0x8) {
			connection.socket.destroy(new Error(`Unsupported WebSocket opcode: ${opcode}`));
			return;
		}
		if (!masked) {
			connection.socket.destroy(new Error("Client WebSocket frames must be masked"));
			return;
		}
		if (connection.buffer.length < offset + 4 + payloadLength) return;
		const mask = connection.buffer.subarray(offset, offset + 4);
		offset += 4;
		const payload = Buffer.from(connection.buffer.subarray(offset, offset + payloadLength));
		connection.buffer = connection.buffer.subarray(offset + payloadLength);
		for (let index = 0; index < payload.length; index++) {
			payload[index] ^= mask[index % 4];
		}
		if (opcode === 0x8) {
			connection.socket.end();
			return;
		}
		if (opcode !== 0x1) continue;
		let message: unknown;
		try {
			message = JSON.parse(payload.toString("utf-8"));
		} catch {
			continue;
		}
		if (isRecord(message) && message.type === "ping") {
			sendFrame(connection.socket, { type: "pong", timestamp: message.timestamp });
			continue;
		}
		dispatchRequest(connection, message as JsonRpcMessage);
	}
}

function receiveSocketData(connection: ClientConnection, chunk: Buffer): void {
	let remaining = chunk;
	while (remaining.length > 0 && !connection.socket.destroyed) {
		const available = maxConnectionBufferBytes - connection.buffer.length;
		if (available <= 0) {
			connection.socket.destroy(new Error(`WebSocket receive buffer exceeds ${maxConnectionBufferBytes} bytes`));
			return;
		}
		const next = remaining.subarray(0, available);
		const declaredPayloadLength = getIncomingDeclaredPayloadLength(connection.buffer, next);
		if (declaredPayloadLength !== undefined && declaredPayloadLength > BigInt(maxFramePayloadBytes)) {
			connection.socket.destroy(new Error(`WebSocket frame exceeds ${maxFramePayloadBytes} bytes`));
			return;
		}
		connection.buffer = Buffer.concat([connection.buffer, next]);
		remaining = remaining.subarray(next.length);
		const bufferedBeforeParse = connection.buffer.length;
		parseFrames(connection);
		if (remaining.length > 0 && connection.buffer.length === bufferedBeforeParse) {
			connection.socket.destroy(new Error(`WebSocket receive buffer exceeds ${maxConnectionBufferBytes} bytes`));
			return;
		}
	}
}

function isAuthorized(request: IncomingMessage): boolean {
	if (!token) return true;
	if (request.headers.authorization === `Bearer ${token}`) return true;
	try {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		return url.searchParams.get("token") === token;
	} catch {
		return false;
	}
}

const server = createServer((_request, response) => {
	response.writeHead(404);
	response.end("pi-daemon only serves WebSocket remote commander connections\n");
});

server.on("upgrade", (request, socket) => {
	const netSocket = socket as Socket;
	if (!isAuthorized(request)) {
		netSocket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
		netSocket.destroy();
		return;
	}
	const key = request.headers["sec-websocket-key"];
	if (typeof key !== "string") {
		netSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
		netSocket.destroy();
		return;
	}
	const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
	netSocket.write(
		[
			"HTTP/1.1 101 Switching Protocols",
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Accept: ${accept}`,
			"",
			"",
		].join("\r\n"),
	);
	const connection: ClientConnection = {
		socket: netSocket,
		buffer: Buffer.alloc(0),
		execs: new Map(),
		uploads: new Map(),
		requestControllers: new Set(),
		activeRequests: 0,
		closed: false,
	};
	netSocket.on("error", () => undefined);
	netSocket.on("data", (chunk: Buffer) => receiveSocketData(connection, chunk));
	netSocket.on("close", () => {
		connection.closed = true;
		for (const controller of connection.requestControllers) controller.abort();
		connection.requestControllers.clear();
		for (const child of connection.execs.values()) {
			child.kill();
		}
		connection.execs.clear();
		for (const uploadId of Array.from(connection.uploads.keys())) {
			removeUpload(connection, uploadId, true);
		}
	});
});

server.listen(port, host, () => {
	console.log(`pi-daemon listening on ws://${host}:${port} cwd=${cwd}`);
});
