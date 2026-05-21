import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, TextContent } from "@earendil-works/pi-ai";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
	writeFileSync,
} from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { join, resolve } from "path";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../../../config.ts";
import type {
	FileEntry,
	SessionEntry,
	SessionEntryBase,
	SessionHeader,
	SessionInfo,
	SessionInfoEntry,
	SessionListProgress,
	SessionMessageEntry,
} from "../types.ts";
import { InMemorySessionStore } from "./in-memory-session-store.ts";
import type { SessionOpenResult } from "./session-store.ts";

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

function getLastActivityTime(entries: FileEntry[]): number | undefined {
	let lastActivityTime: number | undefined;

	for (const entry of entries) {
		if (entry.type !== "message") continue;

		const message = (entry as SessionMessageEntry).message;
		if (!isMessageWithContent(message)) continue;
		if (message.role !== "user" && message.role !== "assistant") continue;

		const msgTimestamp = (message as { timestamp?: number }).timestamp;
		if (typeof msgTimestamp === "number") {
			lastActivityTime = Math.max(lastActivityTime ?? 0, msgTimestamp);
			continue;
		}

		const entryTimestamp = (entry as SessionEntryBase).timestamp;
		if (typeof entryTimestamp === "string") {
			const t = new Date(entryTimestamp).getTime();
			if (!Number.isNaN(t)) {
				lastActivityTime = Math.max(lastActivityTime ?? 0, t);
			}
		}
	}

	return lastActivityTime;
}

function getSessionModifiedDate(entries: FileEntry[], header: SessionHeader, statsMtime: Date): Date {
	const lastActivityTime = getLastActivityTime(entries);
	if (typeof lastActivityTime === "number" && lastActivityTime > 0) {
		return new Date(lastActivityTime);
	}

	const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
	return !Number.isNaN(headerTime) ? new Date(headerTime) : statsMtime;
}

function isValidSessionFile(filePath: string): boolean {
	try {
		const fd = openSync(filePath, "r");
		const buffer = Buffer.alloc(512);
		const bytesRead = readSync(fd, buffer, 0, 512, 0);
		closeSync(fd);
		const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n")[0];
		if (!firstLine) return false;
		const header = JSON.parse(firstLine) as Partial<SessionHeader>;
		return header.type === "session" && typeof header.id === "string";
	} catch {
		return false;
	}
}

async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
	try {
		const content = await readFile(filePath, "utf8");
		const entries: FileEntry[] = [];
		const lines = content.trim().split("\n");

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				entries.push(JSON.parse(line) as FileEntry);
			} catch {
				// Skip malformed lines
			}
		}

		if (entries.length === 0) return null;
		const header = entries[0];
		if (header.type !== "session") return null;

		const stats = await stat(filePath);
		let messageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let name: string | undefined;

		for (const entry of entries) {
			if (entry.type === "session_info") {
				const infoEntry = entry as SessionInfoEntry;
				name = infoEntry.name?.trim() || undefined;
			}

			if (entry.type !== "message") continue;
			messageCount++;

			const message = (entry as SessionMessageEntry).message;
			if (!isMessageWithContent(message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;

			const textContent = extractTextContent(message);
			if (!textContent) continue;

			allMessages.push(textContent);
			if (!firstMessage && message.role === "user") {
				firstMessage = textContent;
			}
		}

		const sessionHeader = header as SessionHeader;
		const cwd = typeof sessionHeader.cwd === "string" ? sessionHeader.cwd : "";
		const parentSessionPath = sessionHeader.parentSession;
		const modified = getSessionModifiedDate(entries, sessionHeader, stats.mtime);

		return {
			reference: filePath,
			path: filePath,
			id: sessionHeader.id,
			cwd,
			name,
			parentSessionPath,
			created: new Date(sessionHeader.timestamp),
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
	private sessionReference: string | undefined;
	private flushed = false;

	isPersisted(): boolean {
		return true;
	}

	getSessionReference(): string | undefined {
		return this.sessionReference;
	}

	setSessionReference(reference: string): void {
		this.sessionReference = resolve(reference);
		this.flushed = false;
	}

	openSession(reference: string): SessionOpenResult {
		this.setSessionReference(reference);
		const currentReference = this.sessionReference!;
		const fileExists = this.exists(currentReference);
		return {
			reference: currentReference,
			exists: fileExists,
			entries: fileExists ? this.load(currentReference) : [],
		};
	}

	getSessionDirForReference(reference: string): string {
		return resolve(reference, "..");
	}

	getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
		const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const sessionDir = join(agentDir, "sessions", safePath);
		this.ensureDir(sessionDir);
		return sessionDir;
	}

	getSessionsRoot(): string {
		return getSessionsDir();
	}

	prepareSessionReference(sessionDir: string, sessionId: string, timestamp: string): string | undefined {
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		this.sessionReference = join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
		this.flushed = false;
		return this.sessionReference;
	}

	getParentSessionReference(): string | undefined {
		return this.sessionReference;
	}

	exists(path: string): boolean {
		return existsSync(path);
	}

	ensureDir(path: string): void {
		if (!existsSync(path)) {
			mkdirSync(path, { recursive: true });
		}
	}

	load(filePath: string): FileEntry[] {
		if (!existsSync(filePath)) return [];
		this.flushed = true;

		const content = readFileSync(filePath, "utf8");
		const entries: FileEntry[] = [];
		const lines = content.trim().split("\n");

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as FileEntry;
				entries.push(entry);
			} catch {
				// Skip malformed lines
			}
		}

		if (entries.length === 0) return entries;
		const header = entries[0];
		if (header.type !== "session" || typeof (header as Partial<SessionHeader>).id !== "string") {
			return [];
		}

		return entries;
	}

	append(filePath: string, entry: FileEntry): void {
		appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
	}

	rewrite(filePath: string, entries: FileEntry[]): void {
		const content = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		writeFileSync(filePath, content);
	}

	appendEntry(entry: SessionEntry): void {
		super.appendEntry(entry);
		this.persistAppendedEntry(entry);
	}

	private persistAppendedEntry(entry: SessionEntry): void {
		if (!this.sessionReference) return;

		if (!this.hasAssistantMessage()) {
			this.flushed = false;
			return;
		}

		if (!this.flushed) {
			for (const fileEntry of this.getFileEntries()) {
				this.append(this.sessionReference, fileEntry);
			}
			this.flushed = true;
		} else {
			this.append(this.sessionReference, entry);
		}
	}

	saveSnapshot(): void {
		if (!this.sessionReference) return;
		this.rewrite(this.sessionReference, this.getFileEntries());
		this.flushed = true;
	}

	commitSnapshot(): void {
		if (!this.hasAssistantMessage()) {
			this.flushed = false;
			return;
		}
		this.saveSnapshot();
	}

	forkSession(sessionDir: string, header: SessionHeader, sourceEntries: FileEntry[]): string {
		this.prepareSessionReference(sessionDir, header.id, header.timestamp);
		const reference = this.getSessionReference();
		if (!reference) {
			throw new Error("Failed to prepare forked session reference");
		}
		this.append(reference, header);
		for (const entry of sourceEntries) {
			if (entry.type !== "session") {
				this.append(reference, entry);
			}
		}
		this.flushed = true;
		return reference;
	}

	findMostRecent(sessionDir: string): string | null {
		try {
			const files = readdirSync(sessionDir)
				.filter((file) => file.endsWith(".jsonl"))
				.map((file) => join(sessionDir, file))
				.filter(isValidSessionFile)
				.map((path) => ({ path, mtime: statSync(path).mtime }))
				.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

			return files[0]?.path || null;
		} catch {
			return null;
		}
	}

	async list(dir: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
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

	async listAll(sessionsDir: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
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
}
