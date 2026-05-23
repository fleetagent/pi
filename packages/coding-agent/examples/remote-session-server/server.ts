import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	type SessionEntry,
	type SessionHeader,
	type SessionInfo,
} from "@fleetagent/pi-coding-agent";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

interface CreateSessionRequest {
	id?: string;
	cwd: string;
	projectId?: string;
	parentSession?: string;
	metadata?: Record<string, unknown>;
}

interface AppendEntriesRequest {
	baseEtag?: string;
	entries: FileEntry[];
}

interface ReplaceSnapshotRequest {
	baseEtag?: string;
	entries: FileEntry[];
}

interface ForkSessionRequest {
	cwd: string;
	projectId?: string;
	leafId?: string;
}

interface ImportJsonlRequest {
	cwd: string;
	projectId?: string;
	sourceName?: string;
	entries: FileEntry[];
	metadata?: Record<string, unknown>;
}

interface RemoteSessionSnapshot {
	reference: string;
	id: string;
	version?: number;
	entries: FileEntry[];
	etag: string;
}

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const token = process.env.PI_REMOTE_SESSION_TOKEN ?? "dev-token";
const dataDir = process.env.PI_REMOTE_SESSION_DIR ?? join(process.cwd(), ".pi-remote-sessions");
const app = new Hono();

function log(message: string, details?: Record<string, unknown>): void {
	const suffix = details ? ` ${JSON.stringify(details)}` : "";
	console.log(`[${new Date().toISOString()}] ${message}${suffix}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionId(value: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(value);
}

function stripRemotePrefix(reference: string): string {
	return reference.startsWith("remote:") ? reference.slice("remote:".length) : reference;
}

function assertSessionId(value: string): string {
	const id = stripRemotePrefix(value);
	if (!isSessionId(id)) {
		throw new Error(`Invalid session id: ${value}`);
	}
	return id;
}

function createSessionId(): string {
	return randomUUID();
}

function sessionPath(sessionId: string): string {
	return join(dataDir, `${assertSessionId(sessionId)}.jsonl`);
}

function referenceFor(sessionId: string): string {
	return `remote:${sessionId}`;
}

function etagFor(entries: FileEntry[]): string {
	return createHash("sha256")
		.update(entries.map((entry) => JSON.stringify(entry)).join("\n"))
		.digest("hex");
}

function writeJsonl(entries: FileEntry[]): string {
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function parseJsonl(content: string): FileEntry[] {
	const entries: FileEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		entries.push(JSON.parse(line) as FileEntry);
	}
	return entries;
}

async function loadEntries(sessionId: string): Promise<FileEntry[]> {
	return parseJsonl(await readFile(sessionPath(sessionId), "utf8"));
}

async function saveEntries(sessionId: string, entries: FileEntry[]): Promise<void> {
	await mkdir(dataDir, { recursive: true });
	await writeFile(sessionPath(sessionId), writeJsonl(entries), "utf8");
}

function snapshotFor(sessionId: string, entries: FileEntry[]): RemoteSessionSnapshot {
	const header = entries[0];
	return {
		reference: referenceFor(sessionId),
		id: sessionId,
		version: header?.type === "session" ? header.version : undefined,
		entries,
		etag: etagFor(entries),
	};
}

function validateBaseEtag(entries: FileEntry[], baseEtag: string | undefined): boolean {
	return baseEtag === undefined || baseEtag === etagFor(entries);
}

function makeHeader(id: string, cwd: string, parentSession?: string): SessionHeader {
	return {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: new Date().toISOString(),
		cwd,
		parentSession,
	};
}

function getBranch(entries: FileEntry[], leafId: string | undefined): SessionEntry[] {
	const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
	if (leafId === undefined) {
		return sessionEntries.filter((entry) => entry.type !== "label");
	}

	const byId = new Map(sessionEntries.map((entry) => [entry.id, entry]));
	const path: SessionEntry[] = [];
	let current: string | null | undefined = leafId;
	while (current) {
		const entry = byId.get(current);
		if (!entry) {
			throw new Error(`Entry ${leafId} not found`);
		}
		path.unshift(entry);
		current = entry.parentId;
	}
	return path.filter((entry) => entry.type !== "label");
}

function forkEntries(sourceEntries: FileEntry[], header: SessionHeader, leafId: string | undefined): FileEntry[] {
	const path = getBranch(sourceEntries, leafId);
	const pathIds = new Set(path.map((entry) => entry.id));
	const labelEntries = sourceEntries.filter(
		(entry): entry is SessionEntry & { type: "label"; targetId: string } =>
			entry.type === "label" && pathIds.has(entry.targetId),
	);
	return [header, ...structuredClone(path), ...structuredClone(labelEntries)];
}

function isMessageWithContent(value: unknown): value is { role?: string; content?: unknown } {
	return isRecord(value) && "content" in value;
}

function extractText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.filter(
			(part): part is { type: string; text: string } =>
				isRecord(part) && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join(" ");
}

function sessionInfo(sessionId: string, entries: FileEntry[], modified: Date): SessionInfo | null {
	const header = entries[0];
	if (!header || header.type !== "session") return null;

	let name: string | undefined;
	let messageCount = 0;
	let firstMessage = "";
	const allMessages: string[] = [];
	for (const entry of entries) {
		if (entry.type === "session_info") {
			name = entry.name?.trim() || undefined;
		}
		if (entry.type !== "message") continue;
		messageCount++;
		const message = entry.message;
		if (!isMessageWithContent(message)) continue;
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = extractText(message.content);
		if (!text) continue;
		allMessages.push(text);
		if (!firstMessage && message.role === "user") {
			firstMessage = text;
		}
	}

	return {
		reference: referenceFor(sessionId),
		path: referenceFor(sessionId),
		id: sessionId,
		cwd: header.cwd,
		name,
		parentSessionPath: header.parentSession,
		created: new Date(header.timestamp),
		modified,
		messageCount,
		firstMessage: firstMessage || "(no messages)",
		allMessagesText: allMessages.join(" "),
	};
}

function authorized(authHeader: string | undefined): boolean {
	const prefix = "Bearer ";
	if (!authHeader?.startsWith(prefix)) return false;
	const received = Buffer.from(authHeader.slice(prefix.length));
	const expected = Buffer.from(token);
	return received.length === expected.length && timingSafeEqual(received, expected);
}

app.use("/v1/*", async (ctx, next) => {
	const started = Date.now();
	const method = ctx.req.method;
	const path = new URL(ctx.req.url).pathname;
	log("request", { method, path });

	if (!authorized(ctx.req.header("Authorization"))) {
		log("response", { method, path, status: 401, durationMs: Date.now() - started });
		return ctx.text("Unauthorized", 401);
	}

	await next();
	log("response", { method, path, status: ctx.res.status, durationMs: Date.now() - started });
});

app.get("/health", (ctx) => ctx.json({ ok: true, dataDir }));

app.post("/v1/sessions", async (ctx) => {
	const body = (await ctx.req.json()) as CreateSessionRequest;
	const id = assertSessionId(body.id ?? createSessionId());
	const entries: FileEntry[] = [makeHeader(id, body.cwd, body.parentSession)];
	log("create session", { id, cwd: body.cwd, parentSession: body.parentSession, projectId: body.projectId });
	await saveEntries(id, entries);
	return ctx.json(snapshotFor(id, entries));
});

app.get("/v1/sessions", async (ctx) => {
	await mkdir(dataDir, { recursive: true });
	const files = (await readdir(dataDir)).filter((file) => file.endsWith(".jsonl"));
	const sessions: SessionInfo[] = [];
	for (const file of files) {
		const id = file.slice(0, -".jsonl".length);
		const path = sessionPath(id);
		const entries = parseJsonl(await readFile(path, "utf8"));
		const info = sessionInfo(id, entries, (await stat(path)).mtime);
		if (info) sessions.push(info);
	}
	log("list sessions", { count: sessions.length });
	return ctx.json({ sessions: sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime()) });
});

app.get("/v1/sessions/recent", async (ctx) => {
	await mkdir(dataDir, { recursive: true });
	const files = (await readdir(dataDir)).filter((file) => file.endsWith(".jsonl"));
	let recent: { id: string; modified: Date } | undefined;
	for (const file of files) {
		const id = file.slice(0, -".jsonl".length);
		const modified = (await stat(sessionPath(id))).mtime;
		if (!recent || modified > recent.modified) {
			recent = { id, modified };
		}
	}
	if (!recent) return ctx.text("No sessions", 404);
	const entries = await loadEntries(recent.id);
	log("recent session", { id: recent.id, entries: entries.length });
	return ctx.json(snapshotFor(recent.id, entries));
});

app.get("/v1/sessions/:id", async (ctx) => {
	const id = assertSessionId(ctx.req.param("id"));
	const entries = await loadEntries(id);
	log("open session", { id, entries: entries.length });
	return ctx.json(snapshotFor(id, entries));
});

app.post("/v1/sessions/:id/entries", async (ctx) => {
	const id = assertSessionId(ctx.req.param("id"));
	const body = (await ctx.req.json()) as AppendEntriesRequest;
	const entries = await loadEntries(id);
	if (!validateBaseEtag(entries, body.baseEtag)) return ctx.text("ETag mismatch", 409);
	const nextEntries = [...entries, ...body.entries];
	log("append entries", {
		id,
		entries: body.entries.length,
		totalEntries: nextEntries.length,
		baseEtag: body.baseEtag,
	});
	await saveEntries(id, nextEntries);
	return ctx.json({ accepted: body.entries.length, etag: etagFor(nextEntries) });
});

app.put("/v1/sessions/:id/snapshot", async (ctx) => {
	const id = assertSessionId(ctx.req.param("id"));
	const body = (await ctx.req.json()) as ReplaceSnapshotRequest;
	const entries = await loadEntries(id);
	if (!validateBaseEtag(entries, body.baseEtag)) return ctx.text("ETag mismatch", 409);
	log("replace snapshot", { id, entries: body.entries.length, baseEtag: body.baseEtag });
	await saveEntries(id, body.entries);
	return ctx.json({ etag: etagFor(body.entries) });
});

app.post("/v1/sessions/:id/fork", async (ctx) => {
	const sourceId = assertSessionId(ctx.req.param("id"));
	const body = (await ctx.req.json()) as ForkSessionRequest;
	const forkId = createSessionId();
	const sourceEntries = await loadEntries(sourceId);
	const entries = forkEntries(sourceEntries, makeHeader(forkId, body.cwd, referenceFor(sourceId)), body.leafId);
	log("fork session", { sourceId, forkId, leafId: body.leafId, entries: entries.length, projectId: body.projectId });
	await saveEntries(forkId, entries);
	return ctx.json(snapshotFor(forkId, entries));
});

app.post("/v1/sessions/import-jsonl", async (ctx) => {
	const body = (await ctx.req.json()) as ImportJsonlRequest;
	const id = assertSessionId(body.entries[0]?.type === "session" ? body.entries[0].id : createSessionId());
	const entries = body.entries[0]?.type === "session" ? body.entries : [makeHeader(id, body.cwd), ...body.entries];
	log("import jsonl", { id, sourceName: body.sourceName, entries: entries.length, projectId: body.projectId });
	await saveEntries(id, entries);
	return ctx.json(snapshotFor(id, entries));
});

serve({ fetch: app.fetch, port }, (info) => {
	console.log(`Remote session server listening on http://localhost:${info.port}`);
	console.log(`Data directory: ${dataDir}`);
	console.log(`Bearer token: ${token}`);
});
