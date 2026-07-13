import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileEntry, RemoteSessionInfo, SessionHeader } from "../../src/core/session-manager.ts";
import {
	formatRemoteSessionReference,
	parseRemoteSessionId,
	RemoteSessionClient,
	RemoteSessionManager,
} from "../../src/core/session-manager.ts";

function header(id: string): SessionHeader {
	return {
		type: "session",
		version: 3,
		id,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "/repo",
	};
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

describe("RemoteSessionClient", () => {
	it("uses bearer auth and remote session paths", async () => {
		const requests: Array<{ url: string; init: RequestInit }> = [];
		const client = new RemoteSessionClient({
			baseUrl: "https://sessions.example.test/",
			token: "secret-token",
			fetch: async (input, init) => {
				requests.push({ url: String(input), init: init ?? {} });
				return jsonResponse({ reference: "remote:session-1", id: "session-1", entries: [header("session-1")] });
			},
		});

		await client.openSession("remote:session-1");

		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe("https://sessions.example.test/v1/sessions/session-1");
		expect(requests[0].init.method).toBe("GET");
		expect(requests[0].init.headers).toMatchObject({
			Authorization: "Bearer secret-token",
			Accept: "application/json",
		});
	});

	it("throws typed errors for failed requests", async () => {
		const client = new RemoteSessionClient({
			baseUrl: "https://sessions.example.test",
			token: "secret-token",
			fetch: async () => new Response("nope", { status: 409 }),
		});

		await expect(client.openSession("session-1")).rejects.toMatchObject({
			name: "RemoteSessionClientError",
			status: 409,
			responseText: "nope",
		});
	});

	it("formats and parses remote references", () => {
		expect(parseRemoteSessionId("remote:abc")).toBe("abc");
		expect(parseRemoteSessionId("abc")).toBe("abc");
		expect(formatRemoteSessionReference("abc")).toBe("remote:abc");
		expect(formatRemoteSessionReference("remote:abc")).toBe("remote:abc");
	});
});

describe("RemoteSessionManager", () => {
	it("hydrates opened snapshots and appends new entries remotely", async () => {
		const entries: FileEntry[] = [header("session-1")];
		const requests: Array<{ url: string; init: RequestInit; body: unknown }> = [];
		const manager = new RemoteSessionManager({
			baseUrl: "https://sessions.example.test",
			token: "secret-token",
			cwd: "/repo",
			fetch: async (input, init) => {
				const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
				requests.push({ url: String(input), init: init ?? {}, body });
				if (init?.method === "GET") {
					return jsonResponse({ reference: "remote:session-1", id: "session-1", entries, etag: "v1" });
				}
				return jsonResponse({ accepted: body.entries.length, etag: "v2" });
			},
		});

		const session = await manager.openReference("remote:session-1");
		expect(session.getSessionId()).toBe("session-1");
		expect(session.getHeader()).toEqual(header("session-1"));
		expect(session.getSessionReference()).toBe("remote:session-1");

		const entryId = session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: 1,
		});
		await session.flushPendingSync();

		expect(requests[1].url).toBe("https://sessions.example.test/v1/sessions/session-1/entries");
		expect(requests[1].init.method).toBe("POST");
		expect(requests[1].body).toMatchObject({
			baseEtag: "v1",
			entries: [{ type: "message", id: entryId }],
		});
	});

	it("retries partially accepted appends until every dirty entry is saved", async () => {
		const appendRequests: Array<{ baseEtag?: string; entries: FileEntry[] }> = [];
		const manager = new RemoteSessionManager({
			baseUrl: "https://sessions.example.test",
			token: "secret-token",
			cwd: "/repo",
			fetch: async (_input, init) => {
				if (init?.method === "GET") {
					return jsonResponse({
						reference: "remote:session-1",
						id: "session-1",
						entries: [header("session-1")],
						etag: "v1",
					});
				}
				const body = JSON.parse(String(init?.body)) as { baseEtag?: string; entries: FileEntry[] };
				appendRequests.push(body);
				return jsonResponse({
					accepted: appendRequests.length === 1 ? 1 : body.entries.length,
					etag: `v${appendRequests.length + 1}`,
				});
			},
		});
		const session = await manager.openReference("remote:session-1");
		session.appendMessage({ role: "user", content: "one", timestamp: 1 });
		session.appendMessage({ role: "user", content: "two", timestamp: 2 });

		await expect(session.flushPendingSync()).resolves.toBeUndefined();

		expect(appendRequests.map((request) => request.entries.length)).toEqual([2, 1]);
		expect(appendRequests.map((request) => request.baseEtag)).toEqual(["v1", "v2"]);
		expect(session.getLastSyncError()).toBeUndefined();
	});

	it("includes entries queued while a flush is in flight", async () => {
		let releaseFirstAppend: (() => void) | undefined;
		let markFirstAppendStarted: (() => void) | undefined;
		const firstAppendGate = new Promise<void>((resolve) => {
			releaseFirstAppend = resolve;
		});
		const firstAppendStarted = new Promise<void>((resolve) => {
			markFirstAppendStarted = resolve;
		});
		const appendRequests: Array<{ baseEtag?: string; entries: FileEntry[] }> = [];
		const manager = new RemoteSessionManager({
			baseUrl: "https://sessions.example.test",
			token: "secret-token",
			cwd: "/repo",
			fetch: async (_input, init) => {
				if (init?.method === "GET") {
					return jsonResponse({
						reference: "remote:session-1",
						id: "session-1",
						entries: [header("session-1")],
						etag: "v1",
					});
				}
				const body = JSON.parse(String(init?.body)) as { baseEtag?: string; entries: FileEntry[] };
				appendRequests.push(body);
				if (appendRequests.length === 1) {
					markFirstAppendStarted?.();
					await firstAppendGate;
				}
				return jsonResponse({ accepted: body.entries.length, etag: `v${appendRequests.length + 1}` });
			},
		});
		const session = await manager.openReference("remote:session-1");
		session.appendMessage({ role: "user", content: "one", timestamp: 1 });
		const flush = session.flushPendingSync();
		await firstAppendStarted;
		session.appendMessage({ role: "user", content: "two", timestamp: 2 });
		releaseFirstAppend?.();

		await expect(flush).resolves.toBeUndefined();

		expect(appendRequests.map((request) => request.entries.length)).toEqual([1, 1]);
		expect(appendRequests.map((request) => request.baseEtag)).toEqual(["v1", "v2"]);
	});

	it("rejects flushes when append acceptance makes no progress", async () => {
		let appendRequests = 0;
		const manager = new RemoteSessionManager({
			baseUrl: "https://sessions.example.test",
			token: "secret-token",
			cwd: "/repo",
			fetch: async (_input, init) => {
				if (init?.method === "GET") {
					return jsonResponse({
						reference: "remote:session-1",
						id: "session-1",
						entries: [header("session-1")],
						etag: "v1",
					});
				}
				appendRequests++;
				return jsonResponse({ accepted: 0, etag: "v1" });
			},
		});
		const session = await manager.openReference("remote:session-1");
		session.appendMessage({ role: "user", content: "unsaved", timestamp: 1 });

		await expect(session.flushPendingSync()).rejects.toThrow(
			"Remote session append accepted 0 of 1 entries without valid progress",
		);
		expect(appendRequests).toBe(1);
		expect(session.getLastSyncError()).toBeInstanceOf(Error);
	});

	it("normalizes listed sessions from JSON responses", async () => {
		const listedSession: RemoteSessionInfo = {
			reference: "remote:session-1",
			id: "session-1",
			cwd: "/repo",
			created: "2026-01-01T00:00:00.000Z",
			modified: "2026-01-02T00:00:00.000Z",
			messageCount: 1,
			firstMessage: "hello",
			allMessagesText: "hello",
		};
		const manager = new RemoteSessionManager({
			baseUrl: "https://sessions.example.test",
			token: "secret-token",
			cwd: "/repo",
			fetch: async () => jsonResponse({ sessions: [listedSession] }),
		});

		const sessions = await manager.list();

		expect(sessions[0]).toMatchObject({ reference: "remote:session-1", path: "remote:session-1" });
		expect(sessions[0]!.created).toBeInstanceOf(Date);
		expect(sessions[0]!.modified).toBeInstanceOf(Date);
	});

	it("sends explicit ids when creating remote sessions", async () => {
		const requests: Array<{ url: string; init: RequestInit; body: unknown }> = [];
		const manager = new RemoteSessionManager({
			baseUrl: "https://sessions.example.test",
			token: "secret-token",
			cwd: "/repo",
			projectId: "project-1",
			fetch: async (input, init) => {
				const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
				requests.push({ url: String(input), init: init ?? {}, body });
				return jsonResponse({
					reference: "remote:client-session",
					id: "client-session",
					entries: [header("client-session")],
				});
			},
		});

		const session = await manager.create({ id: "client-session", parentSession: "remote:parent-session" });

		expect(session.getSessionId()).toBe("client-session");
		expect(requests[0].url).toBe("https://sessions.example.test/v1/sessions");
		expect(requests[0].init.method).toBe("POST");
		expect(requests[0].body).toEqual({
			id: "client-session",
			cwd: "/repo",
			projectId: "project-1",
			parentSession: "remote:parent-session",
		});
	});

	it("replaces snapshots after local newSession calls", async () => {
		const requests: Array<{ url: string; init: RequestInit; body: unknown }> = [];
		const manager = new RemoteSessionManager({
			baseUrl: "https://sessions.example.test",
			token: "secret-token",
			cwd: "/repo",
			fetch: async (input, init) => {
				const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
				requests.push({ url: String(input), init: init ?? {}, body });
				return jsonResponse({
					reference: "remote:server-session",
					id: "server-session",
					entries: [header("server-session")],
					etag: "v1",
				});
			},
		});

		const session = await manager.create();
		session.newSession({ id: "client-session" });
		await session.flushPendingSync();

		expect(requests[1].url).toBe("https://sessions.example.test/v1/sessions/server-session/snapshot");
		expect(requests[1].init.method).toBe("PUT");
		expect(requests[1].body).toMatchObject({
			baseEtag: "v1",
			entries: [{ type: "session", id: "client-session" }],
		});
	});

	it("uploads JSONL entries when importing remote sessions", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-remote-session-import-"));
		const inputPath = join(tempDir, "import.jsonl");
		writeFileSync(inputPath, `${JSON.stringify(header("imported"))}\n`);

		const requests: Array<{ url: string; init: RequestInit; body: unknown }> = [];
		const manager = new RemoteSessionManager({
			baseUrl: "https://sessions.example.test",
			token: "secret-token",
			cwd: "/repo",
			projectId: "project-1",
			fetch: async (input, init) => {
				const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
				requests.push({ url: String(input), init: init ?? {}, body });
				return jsonResponse({ reference: "remote:imported", id: "imported", entries: body.entries, etag: "v1" });
			},
		});

		const session = await manager.importJsonl(inputPath);

		expect(session.getSessionReference()).toBe("remote:imported");
		expect(session.getSessionId()).toBe("imported");
		expect(requests[0].url).toBe("https://sessions.example.test/v1/sessions/import-jsonl");
		expect(requests[0].init.method).toBe("POST");
		expect(requests[0].body).toEqual({
			cwd: "/repo",
			projectId: "project-1",
			sourceName: "import.jsonl",
			entries: [header("imported")],
		});
	});

	it("passes target leaf ids when forking sessions", async () => {
		const requests: Array<{ url: string; init: RequestInit; body: unknown }> = [];
		const manager = new RemoteSessionManager({
			baseUrl: "https://sessions.example.test",
			token: "secret-token",
			cwd: "/repo",
			projectId: "project-1",
			fetch: async (input, init) => {
				const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
				requests.push({ url: String(input), init: init ?? {}, body });
				return jsonResponse({ reference: "remote:forked", id: "forked", entries: [header("forked")] });
			},
		});
		const source = await manager.create();

		await manager.forkSession(source, "leaf-1");

		expect(requests[1].url).toBe("https://sessions.example.test/v1/sessions/forked/fork");
		expect(requests[1].body).toEqual({ cwd: "/repo", projectId: "project-1", leafId: "leaf-1" });
	});
});
