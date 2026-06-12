#!/usr/bin/env node

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
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

interface ClientConnection {
	socket: Socket;
	buffer: Buffer;
	execs: Map<string, ChildProcessWithoutNullStreams>;
	uploads: Map<string, WriteStream>;
}

const port = Number(process.env.PORT ?? process.env.PI_DAEMON_PORT ?? "8787");
const host = process.env.HOST ?? process.env.PI_DAEMON_HOST ?? "127.0.0.1";
const cwd = resolve(process.env.PI_DAEMON_CWD ?? process.cwd());
const token = process.env.PI_DAEMON_TOKEN;
const fileTransferChunkSize = 64 * 1024;

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

function sendFrame(socket: Socket, payload: unknown): void {
	socket.write(createFrame(payload));
}

async function sendFrameAsync(socket: Socket, payload: unknown): Promise<void> {
	if (!socket.write(createFrame(payload))) {
		await once(socket, "drain");
	}
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

async function runBuffered(command: string, args: string[], runCwd: string): Promise<Buffer> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { cwd: runCwd, stdio: ["ignore", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (data: Buffer) => stdout.push(data));
		child.stderr.on("data", (data: Buffer) => stderr.push(data));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolvePromise(Buffer.concat(stdout));
				return;
			}
			reject(new Error(Buffer.concat(stderr).toString("utf-8").trim() || `${command} exited with code ${code}`));
		});
	});
}

function handleExec(connection: ClientConnection, id: string, params: Record<string, unknown>): void {
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
	let timeoutHandle: NodeJS.Timeout | undefined;
	if (timeout !== undefined && timeout > 0) {
		timeoutHandle = setTimeout(() => {
			if (process.platform !== "win32" && child.pid) {
				try {
					process.kill(-child.pid);
				} catch {
					child.kill();
				}
			} else {
				child.kill();
			}
		}, timeout * 1000);
	}
	child.stdout.on("data", (data: Buffer) => {
		sendFrame(connection.socket, { id, event: "data", stream: "stdout", dataBase64: data.toString("base64") });
	});
	child.stderr.on("data", (data: Buffer) => {
		sendFrame(connection.socket, { id, event: "data", stream: "stderr", dataBase64: data.toString("base64") });
	});
	child.on("error", (error) => {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		connection.execs.delete(id);
		sendFrame(connection.socket, { id, event: "error", error: { message: error.message } });
	});
	child.on("close", (code) => {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		connection.execs.delete(id);
		sendFrame(connection.socket, { id, event: "exit", exitCode: code });
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

async function handleDownloadFile(connection: ClientConnection, id: string, path: string): Promise<void> {
	try {
		for await (const chunk of createReadStream(path, { highWaterMark: fileTransferChunkSize })) {
			const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			await sendFrameAsync(connection.socket, { id, event: "fileData", dataBase64: buffer.toString("base64") });
		}
		await sendFrameAsync(connection.socket, { id, event: "fileEnd" });
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

async function handleRequest(connection: ClientConnection, message: JsonRpcMessage): Promise<void> {
	const id = requireString(message.id, "id");
	const method = requireString(message.method, "method");
	const params = isRecord(message.params) ? message.params : {};
	try {
		if (method === "cancel") {
			cancelExec(connection, id);
			return;
		}
		if (method === "exec") {
			handleExec(connection, id, params);
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
			await handleDownloadFile(connection, id, requireString(params.path, "path"));
			return;
		}
		if (method === "uploadFileStart") {
			const path = requireString(params.path, "path");
			const stream = createWriteStream(path);
			stream.on("error", () => undefined);
			connection.uploads.set(id, stream);
			sendResult(connection, id, {});
			return;
		}
		if (method === "uploadFileChunk") {
			const uploadId = requireString(params.uploadId, "uploadId");
			const stream = connection.uploads.get(uploadId);
			if (!stream) throw new Error(`Unknown upload: ${uploadId}`);
			await writeUploadChunk(stream, Buffer.from(requireString(params.dataBase64, "dataBase64"), "base64"));
			sendResult(connection, id, {});
			return;
		}
		if (method === "uploadFileEnd") {
			const uploadId = requireString(params.uploadId, "uploadId");
			const stream = connection.uploads.get(uploadId);
			if (!stream) throw new Error(`Unknown upload: ${uploadId}`);
			connection.uploads.delete(uploadId);
			await closeUploadStream(stream);
			sendResult(connection, id, {});
			return;
		}
		if (method === "uploadFileCancel") {
			const uploadId = requireString(params.uploadId, "uploadId");
			const stream = connection.uploads.get(uploadId);
			if (stream) {
				connection.uploads.delete(uploadId);
				stream.destroy();
			}
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
			const output = await runBuffered("fd", buildFdArgs(pattern, runCwd, limit), runCwd);
			sendResult(connection, id, { matches: output.toString("utf-8").split("\n").filter(Boolean) });
			return;
		}
		if (method === "grep") {
			const pathParam = requireString(params.path, "path");
			const isDirectory = (await stat(pathParam)).isDirectory();
			const output = await runBuffered("rg", buildRgArgs(params), cwd);
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
			const output = await runBuffered("file", ["--mime-type", "-b", requireString(params.path, "path")], cwd);
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

function parseFrames(connection: ClientConnection): void {
	while (connection.buffer.length >= 2) {
		const first = connection.buffer[0];
		const second = connection.buffer[1];
		const opcode = first & 0x0f;
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
		void handleRequest(connection, message as JsonRpcMessage);
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
	};
	netSocket.on("data", (chunk: Buffer) => {
		connection.buffer = Buffer.concat([connection.buffer, chunk]);
		parseFrames(connection);
	});
	netSocket.on("close", () => {
		for (const child of connection.execs.values()) {
			child.kill();
		}
		connection.execs.clear();
		for (const stream of connection.uploads.values()) {
			stream.destroy();
		}
		connection.uploads.clear();
	});
});

server.listen(port, host, () => {
	console.log(`pi-daemon listening on ws://${host}:${port} cwd=${cwd}`);
});
