import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

const children: ChildProcess[] = [];
const sockets: WebSocket[] = [];

async function reservePort(): Promise<number> {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Could not reserve a port");
	server.close();
	await once(server, "close");
	return address.port;
}

async function startDaemon(port: number): Promise<ChildProcess> {
	const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
		cwd: new URL("..", import.meta.url),
		env: {
			...process.env,
			PI_DAEMON_PORT: String(port),
			PI_DAEMON_MAX_FRAME_BYTES: "1024",
			PI_DAEMON_MAX_CONNECTION_REQUESTS: "2",
			PI_DAEMON_MAX_GLOBAL_REQUESTS: "3",
			PI_DAEMON_MAX_CONNECTION_UPLOADS: "2",
			PI_DAEMON_MAX_GLOBAL_UPLOADS: "3",
			PI_DAEMON_MAX_UPLOAD_BYTES: "128",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	const deadline = Date.now() + 10_000;
	while (!output.includes("pi-daemon listening")) {
		if (child.exitCode !== null) throw new Error(`Daemon exited early: ${output}`);
		if (Date.now() > deadline) throw new Error(`Daemon did not start: ${output}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return child;
}

async function openWebSocket(port: number): Promise<{ socket: WebSocket; messages: unknown[] }> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}`);
	sockets.push(socket);
	const messages: unknown[] = [];
	socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
	});
	return { socket, messages };
}

async function waitForMessage(messages: unknown[], predicate: (message: Record<string, unknown>) => boolean) {
	const deadline = Date.now() + 5_000;
	while (Date.now() <= deadline) {
		const match = messages.find(
			(message) => typeof message === "object" && message !== null && predicate(message as Record<string, unknown>),
		);
		if (match) return match as Record<string, unknown>;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for message: ${JSON.stringify(messages)}`);
}

function createMaskedFrame(payload: string): Buffer {
	const data = Buffer.from(payload);
	const mask = Buffer.from([1, 2, 3, 4]);
	const header =
		data.length < 126
			? Buffer.from([0x81, 0x80 | data.length])
			: Buffer.from([0x81, 0xfe, data.length >> 8, data.length & 0xff]);
	const masked = Buffer.from(data);
	for (let index = 0; index < masked.length; index++) masked[index] ^= mask[index % 4];
	return Buffer.concat([header, mask, masked]);
}

async function openRawWebSocket(port: number) {
	const socket = connect(port, "127.0.0.1");
	socket.write(
		[
			"GET / HTTP/1.1",
			`Host: 127.0.0.1:${port}`,
			"Upgrade: websocket",
			"Connection: Upgrade",
			"Sec-WebSocket-Version: 13",
			"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
			"",
			"",
		].join("\r\n"),
	);
	await once(socket, "data");
	return socket;
}

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.close();
	for (const child of children.splice(0)) {
		child.kill();
		if (child.exitCode === null) await once(child, "exit");
	}
});

describe("pi-daemon WebSocket resource limits", () => {
	it("rejects an oversized declared frame before receiving its payload", async () => {
		const port = await reservePort();
		await startDaemon(port);
		const socket = await openRawWebSocket(port);
		const oversizedHeader = Buffer.from([0x81, 0xfe, 0x08, 0x00, 1, 2, 3, 4]);
		socket.write(oversizedHeader);
		await Promise.race([
			once(socket, "close"),
			new Promise((_, reject) => setTimeout(() => reject(new Error("Oversized frame was not rejected")), 2_000)),
		]);
		const client = await openWebSocket(port);
		client.socket.send(JSON.stringify({ id: "survived", method: "capabilities" }));
		const response = await waitForMessage(client.messages, (message) => message.id === "survived");
		expect(response).toHaveProperty("result");
	});

	it("accepts valid coalesced frames larger than the single-frame limit in aggregate", async () => {
		const port = await reservePort();
		await startDaemon(port);
		const socket = await openRawWebSocket(port);
		const responses: Buffer[] = [];
		socket.on("data", (chunk) => responses.push(chunk));
		const padding = "x".repeat(600);
		socket.write(
			Buffer.concat([
				createMaskedFrame(JSON.stringify({ id: "first", method: "capabilities", params: { padding } })),
				createMaskedFrame(JSON.stringify({ id: "second", method: "capabilities", params: { padding } })),
			]),
		);
		const deadline = Date.now() + 2_000;
		while (!Buffer.concat(responses).toString().includes('"id":"second"')) {
			if (Date.now() > deadline)
				throw new Error(`Missing coalesced response: ${Buffer.concat(responses).toString()}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(socket.destroyed).toBe(false);
		socket.destroy();
	});

	it("bounds per-connection and global requests and releases slots on disconnect", async () => {
		const port = await reservePort();
		await startDaemon(port);
		const first = await openWebSocket(port);
		const second = await openWebSocket(port);
		first.socket.send(JSON.stringify({ id: "a", method: "exec", params: { command: "sleep 5" } }));
		first.socket.send(JSON.stringify({ id: "b", method: "exec", params: { command: "sleep 5" } }));
		first.socket.send(JSON.stringify({ id: "per-limit", method: "capabilities" }));
		const perLimit = await waitForMessage(first.messages, (message) => message.id === "per-limit");
		expect(JSON.stringify(perLimit)).toContain("Too many concurrent requests for this connection");

		second.socket.send(JSON.stringify({ id: "c", method: "exec", params: { command: "sleep 5" } }));
		second.socket.send(JSON.stringify({ id: "global-limit", method: "capabilities" }));
		const globalLimit = await waitForMessage(second.messages, (message) => message.id === "global-limit");
		expect(JSON.stringify(globalLimit)).toContain("Too many concurrent daemon requests");

		first.socket.close();
		await new Promise((resolve) => setTimeout(resolve, 100));
		second.socket.send(JSON.stringify({ id: "released", method: "capabilities" }));
		const released = await waitForMessage(second.messages, (message) => message.id === "released");
		expect(released).toHaveProperty("result");
	});

	it("cancels a backpressured streaming exec when its connection closes", async () => {
		const port = await reservePort();
		await startDaemon(port);
		const socket = await openRawWebSocket(port);
		socket.write(createMaskedFrame(JSON.stringify({ id: "noisy", method: "exec", params: { command: "yes" } })));
		socket.pause();
		await new Promise((resolve) => setTimeout(resolve, 100));
		socket.destroy();
		await new Promise((resolve) => setTimeout(resolve, 100));

		const client = await openWebSocket(port);
		client.socket.send(JSON.stringify({ id: "after-close", method: "capabilities" }));
		const response = await waitForMessage(client.messages, (message) => message.id === "after-close");
		expect(response).toHaveProperty("result");
	});

	it("bounds persistent uploads and cumulative upload bytes", async () => {
		const port = await reservePort();
		await startDaemon(port);
		const client = await openWebSocket(port);
		client.socket.send(JSON.stringify({ id: "upload-a", method: "uploadFileStart", params: { path: "/tmp/a" } }));
		await waitForMessage(client.messages, (message) => message.id === "upload-a");
		client.socket.send(JSON.stringify({ id: "upload-b", method: "uploadFileStart", params: { path: "/tmp/b" } }));
		await waitForMessage(client.messages, (message) => message.id === "upload-b");
		client.socket.send(JSON.stringify({ id: "upload-limit", method: "uploadFileStart", params: { path: "/tmp/c" } }));
		const limit = await waitForMessage(client.messages, (message) => message.id === "upload-limit");
		expect(JSON.stringify(limit)).toContain("Too many concurrent uploads");

		client.socket.send(
			JSON.stringify({
				id: "oversized-chunk",
				method: "uploadFileChunk",
				params: { uploadId: "upload-a", dataBase64: Buffer.alloc(129).toString("base64") },
			}),
		);
		const oversized = await waitForMessage(client.messages, (message) => message.id === "oversized-chunk");
		expect(JSON.stringify(oversized)).toContain("Upload exceeds 128 bytes");
	});
});
