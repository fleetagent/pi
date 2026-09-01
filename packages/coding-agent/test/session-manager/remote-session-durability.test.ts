import { describe, expect, it } from "vitest";
import type { FileEntry, SessionHeader } from "../../src/core/session/types.ts";
import {
	JsonlSessionError,
	RemoteSessionClient,
	RemoteSessionClientError,
	RemoteSessionManager,
	RemoteSessionProtocolError,
} from "../../src/index.ts";

interface RemoteSessionSnapshotFixtureOptions {
	id?: string;
	entries?: unknown[];
	etag?: string;
}

function header(id = "session-1"): SessionHeader {
	return {
		type: "session",
		version: 3,
		id,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "/repo",
	};
}

function response(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

function snapshot(options: RemoteSessionSnapshotFixtureOptions = {}): Record<string, unknown> {
	const id = options.id ?? "session-1";
	return {
		reference: `remote:${id}`,
		id,
		entries: options.entries ?? [header(id)],
		...(options.etag === undefined ? {} : { etag: options.etag }),
	};
}

function createManager(fetchImpl: typeof fetch): RemoteSessionManager {
	return new RemoteSessionManager({
		baseUrl: "https://sessions.example.test",
		token: "secret-token",
		cwd: "/repo",
		fetch: fetchImpl,
	});
}

describe("remote session response validation", () => {
	it("rejects malformed JSON and required-body 204 responses with typed protocol errors", async () => {
		const malformed = new RemoteSessionClient({
			baseUrl: "https://sessions.example.test",
			token: "secret-token",
			fetch: async () => new Response("{", { status: 200 }),
		});
		await expect(malformed.openSession("session-1")).rejects.toMatchObject({
			name: "RemoteSessionProtocolError",
			operation: "open",
			cause: expect.any(SyntaxError),
		});

		const empty = new RemoteSessionClient({
			baseUrl: "https://sessions.example.test",
			token: "secret-token",
			fetch: async () => new Response(null, { status: 204 }),
		});
		await expect(empty.replaceSnapshot("session-1", { entries: [header()] })).rejects.toBeInstanceOf(
			RemoteSessionProtocolError,
		);
	});

	it.each([
		["missing entries", { reference: "remote:session-1", id: "session-1" }],
		["mismatched reference", { ...snapshot(), reference: "remote:other" }],
		["mismatched header", snapshot({ entries: [header("other")] })],
		["invalid etag", { ...snapshot(), etag: 42 }],
	] as const)("rejects malformed snapshots before hydration: %s", async (_name, body) => {
		const manager = createManager(async () => response(body));
		await expect(manager.openReference("remote:session-1")).rejects.toBeInstanceOf(RemoteSessionProtocolError);
	});

	it.each([
		["reuses source id", snapshot()],
		["omits parent linkage", snapshot({ id: "forked" })],
	] as const)("rejects inconsistent fork snapshots: %s", async (_name, body) => {
		const client = new RemoteSessionClient({
			baseUrl: "https://sessions.example.test",
			token: "secret-token",
			fetch: async () => response(body),
		});
		await expect(client.forkSession("remote:session-1", { cwd: "/repo" })).rejects.toMatchObject({
			name: "RemoteSessionProtocolError",
			operation: "fork",
		});
	});

	it("rejects structurally invalid snapshot entries with typed sync-safe JSONL context", async () => {
		const invalidEntry = {
			type: "message",
			id: "entry-1",
			parentId: "missing-parent",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: "hello", timestamp: 1 },
		};
		const manager = createManager(async () => response(snapshot({ entries: [header(), invalidEntry] })));
		await expect(manager.openReference("remote:session-1")).rejects.toMatchObject({
			name: "JsonlSessionError",
			code: "invalid_jsonl",
			reference: "remote:session-1",
			phase: "open",
			line: 2,
			decodeKind: "state",
		});
	});

	it.each([
		["invalid dates", { created: "not-a-date" }],
		["negative message count", { messageCount: -1 }],
		["inconsistent reference", { reference: "remote:other" }],
	] as const)("rejects malformed list items atomically: %s", async (_name, override) => {
		const item = {
			reference: "remote:session-1",
			id: "session-1",
			cwd: "/repo",
			created: "2026-01-01T00:00:00.000Z",
			modified: "2026-01-02T00:00:00.000Z",
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
			...override,
		};
		const manager = createManager(async () => response({ sessions: [item] }));
		await expect(manager.list()).rejects.toMatchObject({ name: "RemoteSessionProtocolError", operation: "list" });
	});
});

describe("remote synchronization fencing", () => {
	it.each([
		["zero", { accepted: 0 }],
		["negative", { accepted: -1 }],
		["oversized", { accepted: 2 }],
		["fractional", { accepted: 0.5 }],
		["invalid etag", { accepted: 1, etag: 42 }],
	] as const)("fences invalid append acknowledgement: %s", async (_name, acknowledgement) => {
		let appendRequests = 0;
		const manager = createManager(async (_input, init) => {
			if (init?.method === "GET") return response(snapshot({ etag: "v1" }));
			appendRequests++;
			return response(acknowledgement);
		});
		const session = await manager.openReference("remote:session-1");
		session.appendMessage({ role: "user", content: "one", timestamp: 1 });
		await expect(session.flushPendingSync()).rejects.toMatchObject({
			name: "JsonlSessionError",
			code: "fenced",
			reference: "remote:session-1",
			phase: "sync",
			outcome: "unknown",
		});
		session.appendMessage({ role: "user", content: "two", timestamp: 2 });
		await expect(session.flushPendingSync()).rejects.toBeInstanceOf(JsonlSessionError);
		expect(appendRequests).toBe(1);
	});

	it("retains the dirty suffix and fences partial acceptance without an ETag", async () => {
		const bodies: Array<{ baseEtag?: string; entries: FileEntry[] }> = [];
		const manager = createManager(async (_input, init) => {
			if (init?.method === "GET") return response(snapshot({ etag: "v1" }));
			bodies.push(JSON.parse(String(init?.body)) as { baseEtag?: string; entries: FileEntry[] });
			return response({ accepted: 1 });
		});
		const session = await manager.openReference("remote:session-1");
		session.appendMessage({ role: "user", content: "one", timestamp: 1 });
		session.appendMessage({ role: "user", content: "two", timestamp: 2 });
		await expect(session.flushPendingSync()).rejects.toThrow(
			"partially accepted entries without returning an updated ETag",
		);
		session.appendMessage({ role: "user", content: "three", timestamp: 3 });
		await expect(session.flushPendingSync()).rejects.toBeInstanceOf(JsonlSessionError);
		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.entries).toHaveLength(2);
	});

	it.each([409, 412])("retains dirty entries and propagates ETag conflict status %s", async (status) => {
		const bodies: Array<{ baseEtag?: string }> = [];
		const manager = createManager(async (_input, init) => {
			if (init?.method === "GET") return response(snapshot({ etag: "v1" }));
			bodies.push(JSON.parse(String(init?.body)) as { baseEtag?: string });
			return new Response("ETag conflict", { status });
		});
		const session = await manager.openReference("remote:session-1");
		session.appendMessage({ role: "user", content: "unsaved", timestamp: 1 });
		await expect(session.flushPendingSync()).rejects.toMatchObject({
			name: "JsonlSessionError",
			cause: expect.objectContaining({ name: "RemoteSessionClientError", status }),
		});
		expect((session.getLastSyncError() as Error).cause).toBeInstanceOf(RemoteSessionClientError);
		session.appendMessage({ role: "user", content: "still-unsaved", timestamp: 2 });
		await expect(session.flushPendingSync()).rejects.toBeInstanceOf(JsonlSessionError);
		expect(bodies.map((body) => body.baseEtag)).toEqual(["v1"]);
	});

	it("drops a stale ETag when a full successful response omits revisions", async () => {
		const bodies: Array<{ baseEtag?: string }> = [];
		const manager = createManager(async (_input, init) => {
			if (init?.method === "GET") return response(snapshot({ etag: "v1" }));
			const body = JSON.parse(String(init?.body)) as { baseEtag?: string; entries: FileEntry[] };
			bodies.push(body);
			return response({ accepted: body.entries.length });
		});
		const session = await manager.openReference("remote:session-1");
		session.appendMessage({ role: "user", content: "one", timestamp: 1 });
		await session.flushPendingSync();
		session.appendMessage({ role: "user", content: "two", timestamp: 2 });
		await session.flushPendingSync();
		expect(bodies.map((body) => body.baseEtag)).toEqual(["v1", undefined]);
	});

	it("does not let snapshot replacement erase a prior synchronization failure", async () => {
		let appendRequests = 0;
		let replaceRequests = 0;
		const manager = createManager(async (_input, init) => {
			if (init?.method === "GET") return response(snapshot({ etag: "v1" }));
			if (init?.method === "PUT") {
				replaceRequests++;
				return response({ etag: "v2" });
			}
			appendRequests++;
			return response({ accepted: 0 });
		});
		const session = await manager.openReference("remote:session-1");
		session.appendMessage({ role: "user", content: "unsaved", timestamp: 1 });
		await expect(session.flushPendingSync()).rejects.toBeInstanceOf(JsonlSessionError);
		const originalError = session.getLastSyncError();
		session.newSession({ id: "replacement" });
		await expect(session.flushPendingSync()).rejects.toBe(originalError);
		expect(appendRequests).toBe(1);
		expect(replaceRequests).toBe(0);
	});

	it("fences malformed replacement acknowledgements before clearing synchronization state", async () => {
		let replaceRequests = 0;
		const manager = createManager(async (_input, init) => {
			if (init?.method === "POST") return response(snapshot({ etag: "v1" }));
			replaceRequests++;
			return response([]);
		});
		const session = await manager.create();
		session.newSession({ id: "replacement" });
		await expect(session.flushPendingSync()).rejects.toMatchObject({
			name: "JsonlSessionError",
			phase: "sync",
			cause: expect.objectContaining({ name: "RemoteSessionProtocolError", operation: "replace" }),
		});
		expect(replaceRequests).toBe(1);
	});
});
