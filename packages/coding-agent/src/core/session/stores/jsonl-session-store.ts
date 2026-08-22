import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@fleetagent/pi-agent-core";
import type { Message, TextContent } from "@fleetagent/pi-ai";
import {
	appendFileSync,
	closeSync,
	createReadStream,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { readdir, stat } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { createInterface } from "readline";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../../../config.ts";
import {
	JsonlDecodeError as JsonlDecodeFailure,
	type JsonlErrorPhase,
	JsonlSessionError,
	type JsonlWriteOutcome,
} from "../jsonl-errors.ts";
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
	if (content == null) {
		return "";
	}
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

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;
const SESSION_HEADER_READ_BUFFER_SIZE = 4096;
/** Bound synchronous header discovery while allowing large cwd and custom metadata fields. */
const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024;
const SAFE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function parseSessionEntryLine(line: string): FileEntry | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line) as FileEntry;
	} catch {
		return null;
	}
}

interface PhysicalRecord {
	bytes: Uint8Array;
	line: number;
	start: number;
	terminated: boolean;
}

function* readPhysicalRecords(filePath: string): Generator<PhysicalRecord> {
	const fd = openSync(filePath, "r");
	const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
	let pending = Buffer.alloc(0);
	let consumedBytes = 0;
	let recordStart = 0;
	let line = 1;
	try {
		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			const chunk = buffer.subarray(0, bytesRead);
			const data = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
			let start = 0;
			let newline = data.indexOf(0x0a, start);
			while (newline !== -1) {
				yield { bytes: data.subarray(start, newline), line, start: recordStart, terminated: true };
				line++;
				start = newline + 1;
				recordStart = consumedBytes + bytesRead - (data.length - start);
				newline = data.indexOf(0x0a, start);
			}
			pending = Buffer.from(data.subarray(start));
			consumedBytes += bytesRead;
		}
		if (pending.length > 0) yield { bytes: pending, line, start: recordStart, terminated: false };
	} finally {
		closeSync(fd);
	}
}

const jsonlEntryLocations = new WeakMap<FileEntry[], ReadonlyArray<{ line: number; byteOffset: number } | undefined>>();

export function getJsonlEntryLocations(
	entries: FileEntry[],
): ReadonlyArray<{ line: number; byteOffset: number } | undefined> | undefined {
	return jsonlEntryLocations.get(entries);
}

function decodePhysicalRecord(record: PhysicalRecord): string {
	let bytes = record.bytes;
	if (bytes.at(-1) === 0x0d) bytes = bytes.subarray(0, bytes.length - 1);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new JsonlDecodeFailure(
			"utf8",
			"contains invalid UTF-8",
			error instanceof Error ? error : new Error(String(error)),
		);
	}
}

function parseJsonObject(record: PhysicalRecord): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(decodePhysicalRecord(record));
	} catch (error) {
		if (error instanceof JsonlDecodeFailure) throw error;
		throw new JsonlDecodeFailure(
			"syntax",
			"is not valid JSON",
			error instanceof Error ? error : new Error(String(error)),
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new JsonlDecodeFailure("schema", "is not a JSON object");
	}
	return parsed as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new JsonlDecodeFailure("schema", `has invalid ${field}`);
	}
	return value;
}

function requireId(value: unknown, field: string): string {
	const id = requireString(value, field);
	if (!SAFE_ID_PATTERN.test(id)) throw new JsonlDecodeFailure("schema", `has invalid ${field}`);
	return id;
}

function requireTimestamp(value: unknown): string {
	const timestamp = requireString(value, "timestamp");
	if (Number.isNaN(Date.parse(timestamp))) throw new JsonlDecodeFailure("schema", "has invalid timestamp");
	return timestamp;
}

const MESSAGE_ROLES = new Set([
	"user",
	"assistant",
	"toolResult",
	"bashExecution",
	"custom",
	"branchSummary",
	"compactionSummary",
	"hookMessage",
]);

function validatePersistedMessage(value: unknown): void {
	if (typeof value !== "object" || value === null) throw new JsonlDecodeFailure("schema", "has invalid message");
	const message = value as Record<string, unknown>;
	const role = requireString(message.role, "message role");
	if (!MESSAGE_ROLES.has(role)) throw new JsonlDecodeFailure("schema", `has unknown message role ${role}`);
	if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) {
		throw new JsonlDecodeFailure("schema", "has invalid message timestamp");
	}
	if (message.content != null && typeof message.content !== "string" && !Array.isArray(message.content)) {
		throw new JsonlDecodeFailure("schema", "has invalid message content");
	}
	if (role === "toolResult") {
		requireString(message.toolCallId, "toolCallId");
		requireString(message.toolName, "toolName");
		if (typeof message.isError !== "boolean") throw new JsonlDecodeFailure("schema", "has invalid isError");
	} else if (role === "custom" || role === "hookMessage") {
		requireString(message.customType, "customType");
		if (typeof message.display !== "boolean") throw new JsonlDecodeFailure("schema", "has invalid display");
	} else if (role === "bashExecution") {
		requireString(message.command, "command");
		if (typeof message.output !== "string") throw new JsonlDecodeFailure("schema", "has invalid output");
		if (typeof message.cancelled !== "boolean" || typeof message.truncated !== "boolean") {
			throw new JsonlDecodeFailure("schema", "has invalid bash state");
		}
	} else if (role === "branchSummary" || role === "compactionSummary") {
		requireString(message.summary, "summary");
	}
}

const SESSION_ENTRY_TYPES = new Set<SessionEntry["type"]>([
	"message",
	"thinking_level_change",
	"model_change",
	"compaction",
	"branch_summary",
	"custom",
	"custom_message",
	"label",
	"session_info",
]);

function parseStrictHeader(record: PhysicalRecord): SessionHeader {
	const value = parseJsonObject(record);
	if (value.type !== "session") throw new JsonlDecodeFailure("schema", "is not a session header");
	const version = value.version ?? 1;
	if (version !== 1 && version !== 2 && version !== 3) {
		throw new JsonlDecodeFailure("schema", "has unsupported session version");
	}
	requireId(value.id, "session id");
	requireTimestamp(value.timestamp);
	requireString(value.cwd, "cwd");
	if (value.parentSession !== undefined && typeof value.parentSession !== "string") {
		throw new JsonlDecodeFailure("schema", "has invalid parentSession");
	}
	return value as unknown as SessionHeader;
}

function parseStrictEntry(record: PhysicalRecord, version: number): SessionEntry {
	const value = parseJsonObject(record);
	const type = requireString(value.type, "entry type");
	if (!SESSION_ENTRY_TYPES.has(type as SessionEntry["type"])) {
		throw new JsonlDecodeFailure("schema", `has unknown entry type ${type}`);
	}
	requireTimestamp(value.timestamp);
	if (version >= 2) {
		requireId(value.id, "entry id");
		if (value.parentId !== null && (typeof value.parentId !== "string" || !SAFE_ID_PATTERN.test(value.parentId))) {
			throw new JsonlDecodeFailure("schema", "has invalid parentId");
		}
	}
	switch (type) {
		case "message":
			validatePersistedMessage(value.message);
			break;
		case "thinking_level_change":
			requireString(value.thinkingLevel, "thinkingLevel");
			break;
		case "model_change":
			requireString(value.provider, "provider");
			requireString(value.modelId, "modelId");
			break;
		case "compaction":
			requireString(value.summary, "summary");
			if (version === 1) {
				if (value.firstKeptEntryId === undefined && !Number.isInteger(value.firstKeptEntryIndex)) {
					throw new JsonlDecodeFailure("schema", "has invalid compaction target");
				}
			} else requireId(value.firstKeptEntryId, "firstKeptEntryId");
			if (typeof value.tokensBefore !== "number" || !Number.isFinite(value.tokensBefore)) {
				throw new JsonlDecodeFailure("schema", "has invalid tokensBefore");
			}
			break;
		case "branch_summary":
			requireId(value.fromId, "fromId");
			requireString(value.summary, "summary");
			break;
		case "custom":
			requireString(value.customType, "customType");
			break;
		case "custom_message":
			requireString(value.customType, "customType");
			if (value.content != null && typeof value.content !== "string" && !Array.isArray(value.content)) {
				throw new JsonlDecodeFailure("schema", "has invalid content");
			}
			if (typeof value.display !== "boolean") throw new JsonlDecodeFailure("schema", "has invalid display");
			break;
		case "label":
			requireId(value.targetId, "targetId");
			if (value.label !== undefined && typeof value.label !== "string") {
				throw new JsonlDecodeFailure("schema", "has invalid label");
			}
			break;
		case "session_info":
			if (value.name !== undefined && typeof value.name !== "string") {
				throw new JsonlDecodeFailure("schema", "has invalid name");
			}
			break;
	}
	return value as unknown as SessionEntry;
}

function invalidJsonl(
	filePath: string,
	record: PhysicalRecord,
	failure: Error,
	phase: JsonlErrorPhase,
): JsonlSessionError {
	const decodeFailure =
		failure instanceof JsonlDecodeFailure ? failure : new JsonlDecodeFailure("state", failure.message, failure);
	return new JsonlSessionError({
		code: "invalid_jsonl",
		reference: filePath,
		phase,
		line: record.line,
		byteOffset: record.start,
		decodeKind: decodeFailure.decodeKind,
		message: `Invalid JSONL session file ${filePath}: line ${record.line} ${failure.message}`,
		cause: decodeFailure,
	});
}

function jsonlStorageError(
	reference: string,
	phase: JsonlErrorPhase,
	message: string,
	cause: Error,
	outcome?: JsonlWriteOutcome,
): JsonlSessionError {
	if (cause instanceof JsonlSessionError && cause.phase === phase) return cause;
	return new JsonlSessionError({
		code: cause instanceof JsonlSessionError ? cause.code : "storage",
		reference,
		phase,
		line: cause instanceof JsonlSessionError ? cause.line : undefined,
		byteOffset: cause instanceof JsonlSessionError ? cause.byteOffset : undefined,
		decodeKind: cause instanceof JsonlSessionError ? cause.decodeKind : undefined,
		message,
		outcome: outcome ?? (cause instanceof JsonlSessionError ? cause.outcome : undefined),
		cause,
	});
}

export class SessionHeaderScanLimitError extends Error {
	constructor(filePath: string) {
		super(`Session header exceeds ${MAX_SESSION_HEADER_SCAN_BYTES}-byte scan limit: ${filePath}`);
		this.name = "SessionHeaderScanLimitError";
	}
}

/**
 * Inspect a physical line while searching for the first parsed session entry.
 * Blank lines are skipped; a malformed non-blank candidate quarantines the file.
 */
function parseSessionHeaderCandidate(line: string): SessionHeader | null | undefined {
	if (!line.trim()) return undefined;
	try {
		const bytes = new TextEncoder().encode(line);
		return parseStrictHeader({ bytes, line: 1, start: 0, terminated: true });
	} catch {
		return null;
	}
}

function parseSessionHeaderBytes(bytes: Uint8Array): SessionHeader | null | undefined {
	try {
		return parseSessionHeaderCandidate(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return null;
	}
}

export function readSessionHeader(filePath: string): SessionHeader | null {
	const fd = openSync(filePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_BUFFER_SIZE);
		let pending = Buffer.alloc(0);
		let scannedBytes = 0;
		while (scannedBytes < MAX_SESSION_HEADER_SCAN_BYTES) {
			const readLength = Math.min(buffer.length, MAX_SESSION_HEADER_SCAN_BYTES - scannedBytes);
			const bytesRead = readSync(fd, buffer, 0, readLength, null);
			if (bytesRead === 0) return parseSessionHeaderBytes(pending) ?? null;
			scannedBytes += bytesRead;
			const data =
				pending.length === 0
					? buffer.subarray(0, bytesRead)
					: Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
			let lineStart = 0;
			let newlineIndex = data.indexOf(0x0a, lineStart);
			while (newlineIndex !== -1) {
				const header = parseSessionHeaderBytes(data.subarray(lineStart, newlineIndex));
				if (header !== undefined) return header;
				lineStart = newlineIndex + 1;
				newlineIndex = data.indexOf(0x0a, lineStart);
			}
			pending = Buffer.from(data.subarray(lineStart));
		}
		const probe = Buffer.allocUnsafe(1);
		if (readSync(fd, probe, 0, probe.length, null) === 0) return parseSessionHeaderBytes(pending) ?? null;
		throw new SessionHeaderScanLimitError(filePath);
	} finally {
		closeSync(fd);
	}
}

function readSessionHeaderForDiscovery(filePath: string): SessionHeader | null {
	try {
		return readSessionHeader(filePath);
	} catch (error) {
		if (error instanceof SessionHeaderScanLimitError) return null;
		throw error;
	}
}

function getSessionHeaderCwd(header: SessionHeader): string | undefined {
	const cwd = (header as { cwd?: unknown }).cwd;
	return typeof cwd === "string" ? cwd : undefined;
}

function sessionCwdMatches(cwd: string | undefined, resolvedCwd: string): boolean {
	return cwd !== undefined && cwd !== "" && resolve(cwd) === resolvedCwd;
}

async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
	try {
		const stats = await stat(filePath);
		const header = readSessionHeaderForDiscovery(filePath);
		if (!header) return null;
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

			if (entry.type === "session") continue;

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
export interface JsonlValidationContext {
	phase?: JsonlErrorPhase;
	locations?: ReadonlyArray<{ line: number; byteOffset: number } | undefined>;
}

export function validateCurrentSessionEntries(
	entries: FileEntry[],
	filePath = "session",
	context: JsonlValidationContext = {},
): void {
	const phase = context.phase ?? "open";
	const fail = (index: number, failure: JsonlDecodeFailure): never => {
		const location = context.locations?.[index];
		throw new JsonlSessionError({
			code: "invalid_jsonl",
			reference: filePath,
			phase,
			line: location?.line ?? index + 1,
			byteOffset: location?.byteOffset,
			decodeKind: failure.decodeKind,
			message: `Invalid JSONL session file ${filePath}: line ${location?.line ?? index + 1} ${failure.message}`,
			cause: failure,
		});
	};
	const header = entries[0];
	if (header?.type !== "session" || header.version !== 3) {
		fail(0, new JsonlDecodeFailure("state", "does not have a current version-3 header"));
	}
	try {
		const encodedHeader = new TextEncoder().encode(JSON.stringify(header));
		parseStrictHeader({ bytes: encodedHeader, line: 1, start: 0, terminated: true });
	} catch (error) {
		if (error instanceof JsonlDecodeFailure) fail(0, error);
		throw error;
	}
	const byId = new Map<string, SessionEntry>();
	for (let index = 1; index < entries.length; index++) {
		const entry = entries[index];
		if (!entry || entry.type === "session") {
			fail(index, new JsonlDecodeFailure("state", `has an unexpected session header at logical entry ${index + 1}`));
			continue;
		}
		try {
			const encodedEntry = new TextEncoder().encode(JSON.stringify(entry));
			parseStrictEntry({ bytes: encodedEntry, line: index + 1, start: 0, terminated: true }, 3);
		} catch (error) {
			if (error instanceof JsonlDecodeFailure) fail(index, error);
			throw error;
		}
		if (byId.has(entry.id)) fail(index, new JsonlDecodeFailure("state", `duplicates entry id ${entry.id}`));
		if (entry.parentId !== null && !byId.has(entry.parentId)) {
			fail(index, new JsonlDecodeFailure("state", `references missing parent ${entry.parentId}`));
		}
		const targetId =
			entry.type === "label"
				? entry.targetId
				: entry.type === "compaction"
					? entry.firstKeptEntryId
					: entry.type === "branch_summary"
						? entry.fromId
						: undefined;
		if (targetId !== undefined && !byId.has(targetId)) {
			fail(index, new JsonlDecodeFailure("state", `references missing target ${targetId}`));
		}
		byId.set(entry.id, entry);
	}
}

function loadJsonlSession(
	filePath: string,
	publicationOptions: JsonlAtomicPublicationOptions = {},
	repair = true,
	phase: JsonlErrorPhase = "open",
): FileEntry[] {
	if (!existsSync(filePath)) return [];
	if (lstatSync(filePath).size === 0) return [];
	const entries: FileEntry[] = [];
	const locations: Array<{ line: number; byteOffset: number }> = [];
	let header: SessionHeader | undefined;
	let headerRecord: PhysicalRecord | undefined;
	let finalRecord: PhysicalRecord | undefined;

	for (const record of readPhysicalRecords(filePath)) {
		finalRecord = record;
		let line: string;
		try {
			line = decodePhysicalRecord(record);
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			if (repair && header && !record.terminated && failure instanceof JsonlDecodeFailure) {
				publishJsonlContentAtomically(filePath, readFileSync(filePath).subarray(0, record.start), {
					...publicationOptions,
					phase: "repair",
				});
				break;
			}
			throw invalidJsonl(filePath, record, failure, phase);
		}
		if (!line.trim()) continue;
		try {
			if (!header) {
				header = parseStrictHeader(record);
				headerRecord = record;
				entries.push(header);
				locations.push({ line: record.line, byteOffset: record.start });
				continue;
			}
			entries.push(parseStrictEntry(record, header.version ?? 1));
			locations.push({ line: record.line, byteOffset: record.start });
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			if (
				repair &&
				header &&
				!record.terminated &&
				failure instanceof JsonlDecodeFailure &&
				failure.kind === "syntax"
			) {
				publishJsonlContentAtomically(filePath, readFileSync(filePath).subarray(0, record.start), {
					...publicationOptions,
					phase: "repair",
				});
				break;
			}
			throw invalidJsonl(filePath, record, failure, phase);
		}
	}

	if (!header || !headerRecord) {
		const failure = new JsonlDecodeFailure("schema", "does not contain a session header");
		throw new JsonlSessionError({
			code: "invalid_jsonl",
			reference: filePath,
			phase,
			line: finalRecord?.line ?? 1,
			byteOffset: finalRecord?.start ?? 0,
			decodeKind: failure.decodeKind,
			message: `Session file is not a valid pi session: ${filePath}`,
			cause: failure,
		});
	}
	if (repair && finalRecord?.terminated === false && entries.at(-1) !== undefined) {
		const original = readFileSync(filePath);
		if (original.length > 0 && original.at(-1) !== 0x0a) {
			const repaired = Buffer.allocUnsafe(original.length + 1);
			original.copy(repaired);
			repaired[original.length] = 0x0a;
			publishJsonlContentAtomically(filePath, repaired, { ...publicationOptions, phase: "repair" });
		}
	}
	if ((header.version ?? 1) >= 2) {
		if (header.version === 2) {
			// Version 2 has current tree fields; validate via a non-mutating header projection.
			validateCurrentSessionEntries([{ ...header, version: 3 }, ...entries.slice(1)], filePath, {
				phase,
				locations,
			});
		} else validateCurrentSessionEntries(entries, filePath, { phase, locations });
	}
	jsonlEntryLocations.set(entries, locations);
	return entries;
}

export function load(
	filePath: string,
	publicationOptions: JsonlAtomicPublicationOptions = {},
	repair = true,
	phase: JsonlErrorPhase = "open",
): FileEntry[] {
	try {
		return loadJsonlSession(filePath, publicationOptions, repair, phase);
	} catch (error) {
		if (error instanceof JsonlSessionError) throw error;
		const cause = error instanceof Error ? error : new Error(String(error));
		throw jsonlStorageError(filePath, phase, `Failed to ${phase} JSONL session ${filePath}: ${cause.message}`, cause);
	}
}

function getNextAppendPosition(bytes: Uint8Array): { line: number; byteOffset: number } {
	let line = 1;
	for (const byte of bytes) {
		if (byte === 0x0a) line++;
	}
	return { line, byteOffset: bytes.length };
}

function serializeJsonlEntries(entries: FileEntry[]): string {
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

export function append(filePath: string, entry: FileEntry): void {
	appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
}

export interface JsonlAtomicPublicationOptions {
	rename?: (source: string, destination: string) => void;
	remove?: (path: string) => void;
	platform?: NodeJS.Platform;
	phase?: JsonlErrorPhase;
}

function isWindowsRenameSharingError(error: unknown): boolean {
	if (!(error instanceof Error) || !("code" in error)) return false;
	const code = (error as NodeJS.ErrnoException).code;
	return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function renameWithRetry(
	source: string,
	destination: string,
	rename: (source: string, destination: string) => void,
	platform: NodeJS.Platform,
): void {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			rename(source, destination);
			return;
		} catch (error) {
			if (platform !== "win32" || !isWindowsRenameSharingError(error) || attempt === 4) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 2 ** attempt);
		}
	}
}

function publishJsonlContentAtomicallyUnsafe(
	filePath: string,
	content: string | Uint8Array,
	options: JsonlAtomicPublicationOptions = {},
): void {
	try {
		const destinationInfo = lstatSync(filePath);
		if (!destinationInfo.isFile()) throw new Error(`Refusing to replace non-file session path: ${filePath}`);
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}
	const parentDir = dirname(filePath);
	ensureDir(parentDir);
	let tempPath: string | undefined;
	for (let attempt = 0; attempt < 100; attempt++) {
		const candidate = join(parentDir, `.${basename(filePath)}.tmp-${randomUUID()}`);
		if (!existsSync(candidate)) {
			tempPath = candidate;
			break;
		}
	}
	if (!tempPath) throw new Error(`Failed to allocate staging path for session: ${filePath}`);
	let published = false;
	try {
		try {
			writeFileSync(tempPath, content);
		} catch (error) {
			const cause = error instanceof Error ? error : new Error(String(error));
			throw jsonlStorageError(
				filePath,
				options.phase ?? "replace",
				`Failed to stage JSONL session ${filePath}: ${cause.message}`,
				cause,
				"not_written",
			);
		}
		try {
			renameWithRetry(tempPath, filePath, options.rename ?? renameSync, options.platform ?? process.platform);
		} catch (error) {
			const cause = error instanceof Error ? error : new Error(String(error));
			throw jsonlStorageError(
				filePath,
				options.phase ?? "replace",
				`Failed to publish JSONL session ${filePath}: ${cause.message}`,
				cause,
				"unknown",
			);
		}
		published = true;
	} finally {
		if (!published) {
			try {
				(options.remove ?? ((path) => rmSync(path, { force: true })))(tempPath);
			} catch {
				// Preserve the staging or rename failure; stale temps are undiscoverable.
			}
		}
	}
}

function publishJsonlContentAtomically(
	filePath: string,
	content: string | Uint8Array,
	options: JsonlAtomicPublicationOptions = {},
): void {
	try {
		publishJsonlContentAtomicallyUnsafe(filePath, content, options);
	} catch (error) {
		if (error instanceof JsonlSessionError) throw error;
		const cause = error instanceof Error ? error : new Error(String(error));
		throw jsonlStorageError(
			filePath,
			options.phase ?? "replace",
			`Failed to publish JSONL session ${filePath}: ${cause.message}`,
			cause,
			"not_written",
		);
	}
}

export function publishJsonlAtomically(
	filePath: string,
	entries: FileEntry[],
	options: JsonlAtomicPublicationOptions = {},
): void {
	publishJsonlContentAtomically(filePath, serializeJsonlEntries(entries), options);
}

export function rewrite(filePath: string, entries: FileEntry[]): void {
	publishJsonlAtomically(filePath, entries);
}

export function forkSession(sessionDir: string, header: SessionHeader, sourceEntries: FileEntry[]): string {
	const reference = prepareSessionReference(sessionDir, header.id, header.timestamp);
	publishJsonlAtomically(reference, [header, ...sourceEntries.filter((entry) => entry.type !== "session")], {
		phase: "fork",
	});
	return reference;
}

export function findMostRecent(sessionDir: string, cwd?: string): string | null {
	const resolvedCwd = cwd ? resolve(cwd) : undefined;
	let names: string[];
	try {
		names = readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl"));
	} catch (error) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const files: Array<{ path: string; mtime: Date }> = [];
	for (const name of names) {
		const path = join(sessionDir, name);
		try {
			const header = readSessionHeaderForDiscovery(path);
			if (!header) continue;
			if (resolvedCwd && !sessionCwdMatches(getSessionHeaderCwd(header), resolvedCwd)) continue;
			files.push({ path, mtime: statSync(path).mtime });
		} catch {
			// Quarantine a candidate that disappeared or became unreadable without hiding valid siblings.
		}
	}
	files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
	return files[0]?.path ?? null;
}

export async function list(dir: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	if (!existsSync(dir)) {
		return sessions;
	}

	const dirEntries = await readdir(dir);
	const files = dirEntries.filter((file) => file.endsWith(".jsonl")).map((file) => join(dir, file));
	let loaded = 0;
	const results = await buildSessionInfosWithConcurrency(files, () => {
		loaded++;
		onProgress?.(loaded, files.length);
	});
	for (const info of results) {
		if (info) sessions.push(info);
	}

	return sessions;
}

export async function listAll(sessionsDir: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
	if (!existsSync(sessionsDir)) return [];
	const entries = await readdir(sessionsDir, { withFileTypes: true });
	const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => join(sessionsDir, entry.name));
	let totalFiles = 0;
	const dirFiles: string[][] = [];
	for (const dir of dirs) {
		const files = (await readdir(dir)).filter((file) => file.endsWith(".jsonl"));
		dirFiles.push(files.map((file) => join(dir, file)));
		totalFiles += files.length;
	}
	let loaded = 0;
	const sessions: SessionInfo[] = [];
	const results = await buildSessionInfosWithConcurrency(dirFiles.flat(), () => {
		loaded++;
		onProgress?.(loaded, totalFiles);
	});
	for (const info of results) {
		if (info) sessions.push(info);
	}
	return sessions;
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

interface PreloadedSessionEntries {
	reference: string;
	entries: FileEntry[];
}

export interface JsonlStoreWriteOperations {
	append(filePath: string, serializedEntry: string): void;
	publish(filePath: string, entries: FileEntry[], options?: JsonlAtomicPublicationOptions): void;
}

export interface JsonlFirstPublicationCoordinator {
	publish(
		filePath: string,
		entries: FileEntry[],
		operation: () => void,
		options: { allowExistingEmptyFile: boolean; phase: "create" | "fork" | "import" },
	): void;
}

export class SessionAlreadyExistsError extends Error {
	readonly code = "already_exists";
	readonly reference: string;
	readonly path: string;
	readonly phase: "create" | "fork" | "import";
	readonly outcome = "not_written";

	constructor(reference: string, sessionId: string, phase: "create" | "fork" | "import" = "create") {
		super(`Session already exists: ${sessionId}`);
		this.name = "SessionAlreadyExistsError";
		this.reference = reference;
		this.path = reference;
		this.phase = phase;
	}
}

function isDefinitelyNotWritten(error: unknown): boolean {
	if (!(error instanceof Error) || !("code" in error)) return false;
	return new Set(["ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR", "EINVAL", "EROFS"]).has(
		String((error as NodeJS.ErrnoException).code),
	);
}

function getFirstPublicationPhase(entries: FileEntry[]): "create" | "fork" {
	const header = entries[0];
	return header?.type === "session" && header.parentSession ? "fork" : "create";
}

const defaultWriteOperations: JsonlStoreWriteOperations = {
	append: appendFileSync,
	publish: publishJsonlAtomically,
};

export class JsonlSessionStore extends InMemorySessionStore {
	private reference: string | undefined;
	private flushed = false;
	private preloaded: PreloadedSessionEntries | undefined;
	private allowExistingEmptyFile = false;
	private readonly writeOperations: JsonlStoreWriteOperations;
	private readonly firstPublicationCoordinator: JsonlFirstPublicationCoordinator | undefined;
	private writeFence: Error | undefined;
	private nextAppendLine = 1;
	private nextAppendOffset = 0;

	constructor(
		preloaded?: PreloadedSessionEntries,
		writeOperations: JsonlStoreWriteOperations = defaultWriteOperations,
		firstPublicationCoordinator?: JsonlFirstPublicationCoordinator,
	) {
		super();
		this.preloaded = preloaded ? { ...preloaded, reference: resolve(preloaded.reference) } : undefined;
		this.writeOperations = writeOperations;
		this.firstPublicationCoordinator = firstPublicationCoordinator;
	}
	isPersisted(): boolean {
		return true;
	}

	getSessionReference(): string | undefined {
		return this.reference;
	}

	setSessionReference(reference: string, options: { allowExistingEmptyFile?: boolean } = {}): void {
		const resolvedReference = resolve(reference);
		if (this.reference !== resolvedReference) {
			this.writeFence = undefined;
			this.allowExistingEmptyFile = false;
		}
		this.reference = resolvedReference;
		if (options.allowExistingEmptyFile) this.allowExistingEmptyFile = true;
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
		const info = lstatSync(filePath);
		this.allowExistingEmptyFile = info.isFile() && info.size === 0;
		this.flushed = true;
		const resolvedFilePath = resolve(filePath);
		if (!this.writeFence && this.preloaded?.reference === resolvedFilePath) {
			const entries = this.preloaded.entries;
			this.preloaded = undefined;
			this.updateNextAppendPosition(resolvedFilePath);
			return entries;
		}
		const entries = load(resolvedFilePath);
		this.updateNextAppendPosition(resolvedFilePath);
		this.writeFence = undefined;
		this.preloaded = undefined;
		return entries;
	}

	private updateNextAppendPosition(filePath: string): void {
		const position = getNextAppendPosition(readFileSync(filePath));
		this.nextAppendLine = position.line;
		this.nextAppendOffset = position.byteOffset;
	}

	appendEntry(entry: SessionEntry): void {
		if (!this.reference) {
			super.appendEntry(entry);
			return;
		}
		this.assertWritable();
		const prospectiveEntries = [...this.getFileEntries(), entry];
		const wasFlushed = this.flushed;
		const appendPosition = wasFlushed
			? { line: this.nextAppendLine, byteOffset: this.nextAppendOffset }
			: getNextAppendPosition(new TextEncoder().encode(serializeJsonlEntries(this.getFileEntries())));
		const locations: Array<{ line: number; byteOffset: number } | undefined> = [];
		locations[prospectiveEntries.length - 1] = appendPosition;
		validateCurrentSessionEntries(prospectiveEntries, this.reference, { phase: "append", locations });
		const hasAssistantMessage = prospectiveEntries.some(
			(fileEntry) => fileEntry.type === "message" && fileEntry.message.role === "assistant",
		);
		if (!hasAssistantMessage) {
			super.appendEntry(entry);
			this.flushed = false;
			return;
		}

		if (!this.flushed) serializeJsonlEntries(prospectiveEntries);
		const serializedEntry = this.flushed ? `${JSON.stringify(entry)}\n` : undefined;
		try {
			if (!this.flushed) {
				this.publishFirstSnapshot(prospectiveEntries);
			} else {
				this.writeOperations.append(this.reference, serializedEntry!);
			}
		} catch (error) {
			if (error instanceof SessionAlreadyExistsError) throw error;
			const cause = error instanceof Error ? error : new Error(String(error));
			if (this.flushed && isDefinitelyNotWritten(error)) {
				throw jsonlStorageError(this.reference, "append", cause.message, cause, "not_written");
			}
			this.writeFence = jsonlStorageError(
				this.reference,
				this.flushed ? "append" : getFirstPublicationPhase(prospectiveEntries),
				cause.message,
				cause,
				cause instanceof JsonlSessionError ? undefined : "unknown",
			);
			throw this.writeFence;
		}
		super.appendEntry(entry);
		if (wasFlushed) {
			this.nextAppendLine++;
			this.nextAppendOffset += Buffer.byteLength(serializedEntry!);
		} else {
			const position = getNextAppendPosition(new TextEncoder().encode(serializeJsonlEntries(prospectiveEntries)));
			this.nextAppendLine = position.line;
			this.nextAppendOffset = position.byteOffset;
		}
		this.flushed = true;
		this.allowExistingEmptyFile = false;
	}

	private assertWritable(): void {
		if (this.writeFence) {
			throw new JsonlSessionError({
				code: "fenced",
				reference: this.reference ?? "",
				phase: "append",
				message: `Session writes are fenced after a persistence failure: ${this.reference}`,
				outcome: "unknown",
				cause: this.writeFence,
			});
		}
	}
	private publishFirstSnapshot(entries: FileEntry[]): void {
		if (!this.reference) return;
		const phase = getFirstPublicationPhase(entries);
		const operation = () => this.writeOperations.publish(this.reference!, entries, { phase });
		if (this.firstPublicationCoordinator) {
			this.firstPublicationCoordinator.publish(this.reference, entries, operation, {
				allowExistingEmptyFile: this.allowExistingEmptyFile,
				phase,
			});
		} else {
			operation();
		}
	}

	saveSnapshot(options: { phase?: JsonlErrorPhase } = {}): void {
		if (!this.reference) return;
		this.assertWritable();
		serializeJsonlEntries(this.getFileEntries());
		try {
			if (this.flushed) {
				this.writeOperations.publish(this.reference, this.getFileEntries(), {
					phase: options.phase ?? "replace",
				});
			} else this.publishFirstSnapshot(this.getFileEntries());
		} catch (error) {
			if (error instanceof SessionAlreadyExistsError) throw error;
			const cause = error instanceof Error ? error : new Error(String(error));
			this.writeFence = jsonlStorageError(
				this.reference,
				options.phase ?? (this.flushed ? "replace" : getFirstPublicationPhase(this.getFileEntries())),
				cause.message,
				cause,
				cause instanceof JsonlSessionError ? undefined : "unknown",
			);
			throw this.writeFence;
		}
		const position = getNextAppendPosition(new TextEncoder().encode(serializeJsonlEntries(this.getFileEntries())));
		this.nextAppendLine = position.line;
		this.nextAppendOffset = position.byteOffset;
		this.flushed = true;
		this.allowExistingEmptyFile = false;
	}

	commitSnapshot(): void {
		if (!this.hasAssistantMessage()) {
			this.flushed = false;
			return;
		}
		this.saveSnapshot();
	}
}
