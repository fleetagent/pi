import type { AgentMessage } from "@fleetagent/pi-agent-core";
import type { Message, TextContent } from "@fleetagent/pi-ai";
import {
	appendFileSync,
	closeSync,
	createReadStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	statSync,
	writeFileSync,
} from "fs";
import { readdir, stat } from "fs/promises";
import { join, resolve } from "path";
import { createInterface } from "readline";
import { StringDecoder } from "string_decoder";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../../../config.ts";
import type {
	FileEntry,
	SessionEntry,
	SessionHeader,
	SessionInfo,
	SessionListProgress,
	SessionMessageEntry,
} from "../types.ts";
import { InMemorySessionStore } from "./in-memory-session-store.ts";

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function getMessageActivityTime(entry: SessionMessageEntry): number | undefined {
	const message = entry.message;
	if (!isMessageWithContent(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;

	const msgTimestamp = (message as { timestamp?: number }).timestamp;
	if (typeof msgTimestamp === "number") {
		return msgTimestamp;
	}

	const t = new Date(entry.timestamp).getTime();
	return Number.isNaN(t) ? undefined : t;
}

function parseSessionEntryLine(line: string): FileEntry | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line) as FileEntry;
	} catch {
		return null;
	}
}

function readSessionHeader(filePath: string): SessionHeader | null {
	try {
		const fd = openSync(filePath, "r");
		const buffer = Buffer.alloc(512);
		const bytesRead = readSync(fd, buffer, 0, 512, 0);
		closeSync(fd);
		const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n")[0];
		if (!firstLine) return null;
		const header = JSON.parse(firstLine) as Partial<SessionHeader>;
		if (header.type !== "session" || typeof header.id !== "string") {
			return null;
		}
		return header as SessionHeader;
	} catch {
		return null;
	}
}

function sessionCwdMatches(cwd: string | undefined, resolvedCwd: string): boolean {
	return cwd !== undefined && cwd !== "" && resolve(cwd) === resolvedCwd;
}

async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
	try {
		const stats = await stat(filePath);
		let header: SessionHeader | null = null;
		let messageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let name: string | undefined;
		let lastActivityTime: number | undefined;

		const rl = createInterface({
			input: createReadStream(filePath, { encoding: "utf8" }),
			crlfDelay: Infinity,
		});

		for await (const line of rl) {
			const entry = parseSessionEntryLine(line);
			if (!entry) continue;

			if (!header) {
				if (entry.type !== "session") return null;
				header = entry;
				continue;
			}

			if (entry.type === "session_info") {
				name = entry.name?.trim() || undefined;
			}

			if (entry.type !== "message") continue;
			messageCount++;

			const activityTime = getMessageActivityTime(entry);
			if (typeof activityTime === "number") {
				lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
			}

			const message = entry.message;
			if (!isMessageWithContent(message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;

			const textContent = extractTextContent(message);
			if (!textContent) continue;

			allMessages.push(textContent);
			if (!firstMessage && message.role === "user") {
				firstMessage = textContent;
			}
		}

		if (!header) return null;

		const cwd = typeof header.cwd === "string" ? header.cwd : "";
		const parentSessionPath = header.parentSession;
		const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
		const modified =
			typeof lastActivityTime === "number" && lastActivityTime > 0
				? new Date(lastActivityTime)
				: !Number.isNaN(headerTime)
					? new Date(headerTime)
					: stats.mtime;

		return {
			reference: filePath,
			path: filePath,
			id: header.id,
			cwd,
			name,
			parentSessionPath,
			created: new Date(header.timestamp),
			modified,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.join(" "),
		};
	} catch {
		return null;
	}
}

const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;

export function getSessionDirForReference(reference: string): string {
	return resolve(reference, "..");
}

export function getDefaultSessionDirPath(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const resolvedCwd = resolve(cwd);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(resolve(agentDir), "sessions", safePath);
}

export function getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
	ensureDir(sessionDir);
	return sessionDir;
}

export function getSessionsRoot(): string {
	return getSessionsDir();
}

export function prepareSessionReference(sessionDir: string, sessionId: string, timestamp: string): string {
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	return join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
}

export function exists(path: string): boolean {
	return existsSync(path);
}

export function ensureDir(path: string): void {
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true });
	}
}

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;

export function load(filePath: string): FileEntry[] {
	if (!existsSync(filePath)) return [];

	const entries: FileEntry[] = [];
	const fd = openSync(filePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
		let pending = "";

		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;

			pending += decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				const entry = parseSessionEntryLine(pending.slice(lineStart, newlineIndex));
				if (entry) entries.push(entry);
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}

		pending += decoder.end();
		const finalEntry = parseSessionEntryLine(pending);
		if (finalEntry) entries.push(finalEntry);
	} finally {
		closeSync(fd);
	}

	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as Partial<SessionHeader>).id !== "string") {
		return [];
	}

	return entries;
}

export function append(filePath: string, entry: FileEntry): void {
	appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
}

export function rewrite(filePath: string, entries: FileEntry[]): void {
	const content = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	writeFileSync(filePath, content);
}

export function forkSession(sessionDir: string, header: SessionHeader, sourceEntries: FileEntry[]): string {
	const reference = prepareSessionReference(sessionDir, header.id, header.timestamp);
	append(reference, header);
	for (const entry of sourceEntries) {
		if (entry.type !== "session") {
			append(reference, entry);
		}
	}
	return reference;
}

export function findMostRecent(sessionDir: string, cwd?: string): string | null {
	const resolvedCwd = cwd ? resolve(cwd) : undefined;
	try {
		const files = readdirSync(sessionDir)
			.filter((file) => file.endsWith(".jsonl"))
			.map((file) => join(sessionDir, file))
			.map((path) => ({ path, header: readSessionHeader(path) }))
			.filter(
				(file): file is { path: string; header: SessionHeader } =>
					file.header !== null && (!resolvedCwd || sessionCwdMatches(file.header.cwd, resolvedCwd)),
			)
			.map(({ path }) => ({ path, mtime: statSync(path).mtime }))
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		return files[0]?.path || null;
	} catch {
		return null;
	}
}

export async function list(dir: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	if (!existsSync(dir)) {
		return sessions;
	}

	try {
		const dirEntries = await readdir(dir);
		const files = dirEntries.filter((file) => file.endsWith(".jsonl")).map((file) => join(dir, file));
		let loaded = 0;
		const results = await buildSessionInfosWithConcurrency(files, () => {
			loaded++;
			onProgress?.(loaded, files.length);
		});
		for (const info of results) {
			if (info) {
				sessions.push(info);
			}
		}
	} catch {
		// Return empty list on error
	}

	return sessions;
}

export async function listAll(sessionsDir: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
	try {
		if (!existsSync(sessionsDir)) {
			return [];
		}
		const entries = await readdir(sessionsDir, { withFileTypes: true });
		const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => join(sessionsDir, entry.name));

		let totalFiles = 0;
		const dirFiles: string[][] = [];
		for (const dir of dirs) {
			try {
				const files = (await readdir(dir)).filter((file) => file.endsWith(".jsonl"));
				dirFiles.push(files.map((file) => join(dir, file)));
				totalFiles += files.length;
			} catch {
				dirFiles.push([]);
			}
		}

		let loaded = 0;
		const sessions: SessionInfo[] = [];
		const allFiles = dirFiles.flat();
		const results = await buildSessionInfosWithConcurrency(allFiles, () => {
			loaded++;
			onProgress?.(loaded, totalFiles);
		});

		for (const info of results) {
			if (info) {
				sessions.push(info);
			}
		}

		return sessions;
	} catch {
		return [];
	}
}

async function buildSessionInfosWithConcurrency(
	files: string[],
	onLoaded: () => void,
): Promise<(SessionInfo | null)[]> {
	const results: (SessionInfo | null)[] = new Array(files.length).fill(null);
	const inFlight = new Set<Promise<void>>();
	let nextIndex = 0;

	const startNext = (): void => {
		const index = nextIndex++;
		const file = files[index];
		if (!file) return;

		let task: Promise<void>;
		task = buildSessionInfo(file)
			.then((info) => {
				results[index] = info;
			})
			.catch(() => {
				results[index] = null;
			})
			.finally(() => {
				inFlight.delete(task);
				onLoaded();
			});
		inFlight.add(task);
	};

	while (nextIndex < files.length || inFlight.size > 0) {
		while (nextIndex < files.length && inFlight.size < MAX_CONCURRENT_SESSION_INFO_LOADS) {
			startNext();
		}
		if (inFlight.size > 0) {
			await Promise.race(inFlight);
		}
	}

	return results;
}

export class JsonlSessionStore extends InMemorySessionStore {
	private reference: string | undefined;
	private flushed = false;

	isPersisted(): boolean {
		return true;
	}

	getSessionReference(): string | undefined {
		return this.reference;
	}

	setSessionReference(reference: string): void {
		this.reference = resolve(reference);
		this.flushed = false;
	}

	exists(path: string): boolean {
		return exists(path);
	}

	ensureDir(path: string): void {
		ensureDir(path);
	}

	load(filePath: string): FileEntry[] {
		if (!exists(filePath)) return [];
		this.flushed = true;
		return load(filePath);
	}

	appendEntry(entry: SessionEntry): void {
		super.appendEntry(entry);
		this.persistAppendedEntry(entry);
	}

	private persistAppendedEntry(entry: SessionEntry): void {
		if (!this.reference) return;

		if (!this.hasAssistantMessage()) {
			this.flushed = false;
			return;
		}

		if (!this.flushed) {
			for (const fileEntry of this.getFileEntries()) {
				append(this.reference, fileEntry);
			}
			this.flushed = true;
		} else {
			append(this.reference, entry);
		}
	}

	saveSnapshot(): void {
		if (!this.reference) return;
		rewrite(this.reference, this.getFileEntries());
		this.flushed = true;
	}

	commitSnapshot(): void {
		if (!this.hasAssistantMessage()) {
			this.flushed = false;
			return;
		}
		this.saveSnapshot();
	}
}
