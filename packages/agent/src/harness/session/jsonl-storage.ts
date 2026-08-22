import {
	FileError,
	type FileSystem,
	type JsonlSessionMetadata,
	type LeafEntry,
	SessionError,
	type SessionStorage,
	type SessionTreeEntry,
	toError,
} from "../types.ts";
import {
	JsonlDecodeError as JsonlDecodeFailure,
	type JsonlErrorPhase,
	JsonlSessionError,
	type JsonlWriteOutcome,
} from "./jsonl-errors.ts";
import { getFileSystemResultOrThrow } from "./repo-utils.ts";
import { uuidv7 } from "./uuid.ts";

type JsonlSessionStorageFileSystem = Pick<
	FileSystem,
	"readBinaryFile" | "readTextLines" | "writeFile" | "appendFile" | "renameFile" | "fileInfo" | "exists" | "remove"
>;
type JsonlSessionMetadataFileSystem = Pick<FileSystem, "readBinaryFile" | "readTextLines">;

interface SessionHeader {
	type: "session";
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

function updateLabelCache(labelsById: Map<string, string>, entry: SessionTreeEntry): void {
	if (entry.type !== "label") return;
	const label = entry.label?.trim();
	if (label) {
		labelsById.set(entry.targetId, label);
	} else {
		labelsById.delete(entry.targetId);
	}
}

function buildLabelsById(entries: SessionTreeEntry[]): Map<string, string> {
	const labelsById = new Map<string, string>();
	for (const entry of entries) {
		updateLabelCache(labelsById, entry);
	}
	return labelsById;
}

function generateEntryId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		// The uuidv7 prefix is timestamp-derived and nearly constant between calls,
		// so short ids must come from the random tail.
		const id = uuidv7().slice(-8);
		if (!byId.has(id)) return id;
	}
	return uuidv7();
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface PhysicalRecord {
	bytes: Uint8Array;
	line: number;
	start: number;
	terminated: boolean;
}

function splitPhysicalRecords(bytes: Uint8Array): PhysicalRecord[] {
	const records: PhysicalRecord[] = [];
	let start = 0;
	let line = 1;
	for (let index = 0; index < bytes.length; index++) {
		if (bytes[index] !== 0x0a) continue;
		records.push({ bytes: bytes.subarray(start, index), line, start, terminated: true });
		start = index + 1;
		line++;
	}
	if (start < bytes.length) records.push({ bytes: bytes.subarray(start), line, start, terminated: false });
	return records;
}

function decodeRecord(record: PhysicalRecord): string {
	let bytes = record.bytes;
	if (bytes.at(-1) === 0x0d) bytes = bytes.subarray(0, bytes.length - 1);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new JsonlDecodeFailure("utf8", "contains invalid UTF-8", toError(error));
	}
}

function parseJsonObject(record: PhysicalRecord): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(decodeRecord(record));
	} catch (error) {
		if (error instanceof JsonlDecodeFailure) throw error;
		throw new JsonlDecodeFailure("syntax", "is not valid JSON", toError(error));
	}
	if (!isRecord(parsed)) throw new JsonlDecodeFailure("schema", "is not a JSON object");
	return parsed;
}

function invalidSession(
	filePath: string,
	message: string,
	cause?: Error,
	phase: JsonlErrorPhase = "open",
): JsonlSessionError {
	const decodeCause = cause instanceof JsonlDecodeFailure ? cause : new JsonlDecodeFailure("schema", message, cause);
	return new JsonlSessionError({
		code: "invalid_session",
		reference: filePath,
		phase,
		line: 1,
		byteOffset: 0,
		decodeKind: decodeCause.decodeKind,
		message: `Invalid JSONL session file ${filePath}: ${message}`,
		cause: decodeCause,
	});
}

function invalidEntry(
	filePath: string,
	lineNumber: number,
	message: string,
	cause?: Error,
	byteOffset?: number,
	phase: JsonlErrorPhase = "open",
): JsonlSessionError {
	const decodeCause = cause instanceof JsonlDecodeFailure ? cause : new JsonlDecodeFailure("state", message, cause);
	return new JsonlSessionError({
		code: "invalid_entry",
		reference: filePath,
		phase,
		line: lineNumber,
		byteOffset,
		decodeKind: decodeCause.decodeKind,
		message: `Invalid JSONL session file ${filePath}: line ${lineNumber} ${message}`,
		cause: decodeCause,
	});
}

function withJsonlPhase(error: JsonlSessionError, phase: JsonlErrorPhase): JsonlSessionError {
	return new JsonlSessionError({
		code: error.code,
		reference: error.reference,
		phase,
		line: error.line,
		byteOffset: error.byteOffset,
		decodeKind: error.decodeKind,
		outcome: error.outcome,
		message: error.message,
		cause: error.cause instanceof Error ? error.cause : undefined,
	});
}

function jsonlStorageError(
	reference: string,
	phase: JsonlErrorPhase,
	message: string,
	cause: Error,
	outcome?: JsonlWriteOutcome,
): JsonlSessionError {
	if (cause instanceof JsonlSessionError) return withJsonlPhase(cause, phase);
	return new JsonlSessionError({
		code: cause instanceof SessionError ? cause.code : "storage",
		reference,
		phase,
		message: message.includes(cause.message) ? message : `${message}: ${cause.message}`,
		outcome,
		cause,
	});
}

function parseHeaderRecord(record: PhysicalRecord, filePath: string): SessionHeader {
	let parsed: Record<string, unknown>;
	try {
		parsed = parseJsonObject(record);
	} catch (error) {
		throw invalidSession(filePath, "first line is not a valid session header", toError(error));
	}
	if (parsed.type !== "session") throw invalidSession(filePath, "first line is not a valid session header");
	if (parsed.version !== 3) throw invalidSession(filePath, "unsupported session version");
	if (typeof parsed.id !== "string" || !SAFE_ID_PATTERN.test(parsed.id)) {
		throw invalidSession(filePath, "session header has invalid id");
	}
	if (typeof parsed.timestamp !== "string" || Number.isNaN(Date.parse(parsed.timestamp))) {
		throw invalidSession(filePath, "session header has invalid timestamp");
	}
	if (typeof parsed.cwd !== "string" || !parsed.cwd) throw invalidSession(filePath, "session header is missing cwd");
	if (parsed.parentSession !== undefined && typeof parsed.parentSession !== "string") {
		throw invalidSession(filePath, "session header parentSession must be a string");
	}
	return {
		type: "session",
		version: 3,
		id: parsed.id,
		timestamp: parsed.timestamp,
		cwd: parsed.cwd,
		parentSession: parsed.parentSession,
	};
}

const ENTRY_TYPES = new Set<SessionTreeEntry["type"]>([
	"message",
	"thinking_level_change",
	"model_change",
	"compaction",
	"branch_summary",
	"custom",
	"custom_message",
	"label",
	"session_info",
	"leaf",
]);

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
	if (!isRecord(value)) throw new JsonlDecodeFailure("schema", "has invalid message");
	const role = requireString(value.role, "message role");
	if (!MESSAGE_ROLES.has(role)) throw new JsonlDecodeFailure("schema", `has unknown message role ${role}`);
	if (typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) {
		throw new JsonlDecodeFailure("schema", "has invalid message timestamp");
	}
	if (value.content != null && typeof value.content !== "string" && !Array.isArray(value.content)) {
		throw new JsonlDecodeFailure("schema", "has invalid message content");
	}
	if (role === "toolResult") {
		requireString(value.toolCallId, "toolCallId");
		requireString(value.toolName, "toolName");
		if (typeof value.isError !== "boolean") throw new JsonlDecodeFailure("schema", "has invalid isError");
	} else if (role === "custom" || role === "hookMessage") {
		requireString(value.customType, "customType");
		if (typeof value.display !== "boolean") throw new JsonlDecodeFailure("schema", "has invalid display");
	} else if (role === "bashExecution") {
		requireString(value.command, "command");
		if (typeof value.output !== "string") throw new JsonlDecodeFailure("schema", "has invalid output");
		if (typeof value.cancelled !== "boolean" || typeof value.truncated !== "boolean") {
			throw new JsonlDecodeFailure("schema", "has invalid bash state");
		}
	} else if (role === "branchSummary" || role === "compactionSummary") {
		requireString(value.summary, "summary");
	}
}

function parseEntryRecord(record: PhysicalRecord): SessionTreeEntry {
	const parsed = parseJsonObject(record);
	const type = requireString(parsed.type, "entry type");
	if (!ENTRY_TYPES.has(type as SessionTreeEntry["type"])) {
		throw new JsonlDecodeFailure("schema", `has unknown entry type ${type}`);
	}
	requireId(parsed.id, "entry id");
	if (parsed.parentId !== null && (typeof parsed.parentId !== "string" || !SAFE_ID_PATTERN.test(parsed.parentId))) {
		throw new JsonlDecodeFailure("schema", "has invalid parentId");
	}
	requireTimestamp(parsed.timestamp);
	switch (type) {
		case "message":
			validatePersistedMessage(parsed.message);
			break;
		case "thinking_level_change":
			requireString(parsed.thinkingLevel, "thinkingLevel");
			break;
		case "model_change":
			requireString(parsed.provider, "provider");
			requireString(parsed.modelId, "modelId");
			break;
		case "compaction":
			requireString(parsed.summary, "summary");
			requireId(parsed.firstKeptEntryId, "firstKeptEntryId");
			if (typeof parsed.tokensBefore !== "number" || !Number.isFinite(parsed.tokensBefore)) {
				throw new JsonlDecodeFailure("schema", "has invalid tokensBefore");
			}
			break;
		case "branch_summary":
			requireId(parsed.fromId, "fromId");
			requireString(parsed.summary, "summary");
			break;
		case "custom":
			requireString(parsed.customType, "customType");
			break;
		case "custom_message":
			requireString(parsed.customType, "customType");
			if (parsed.content != null && typeof parsed.content !== "string" && !Array.isArray(parsed.content)) {
				throw new JsonlDecodeFailure("schema", "has invalid content");
			}
			if (typeof parsed.display !== "boolean") throw new JsonlDecodeFailure("schema", "has invalid display");
			break;
		case "label":
			requireId(parsed.targetId, "targetId");
			if (parsed.label !== undefined && typeof parsed.label !== "string") {
				throw new JsonlDecodeFailure("schema", "has invalid label");
			}
			break;
		case "session_info":
			if (parsed.name !== undefined && typeof parsed.name !== "string") {
				throw new JsonlDecodeFailure("schema", "has invalid name");
			}
			break;
		case "leaf":
			if (
				parsed.targetId !== null &&
				(typeof parsed.targetId !== "string" || !SAFE_ID_PATTERN.test(parsed.targetId))
			) {
				throw new JsonlDecodeFailure("schema", "has invalid targetId");
			}
			break;
	}
	return parsed as unknown as SessionTreeEntry;
}

function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
	return entry.type === "leaf" ? entry.targetId : entry.id;
}

function leafIdAfterEntries(entries: SessionTreeEntry[]): string | null {
	let leafId: string | null = null;
	for (const entry of entries) leafId = leafIdAfterEntry(entry);
	return leafId;
}

function isDefinitelyNotWritten(error: unknown): boolean {
	const cause = error instanceof SessionError ? error.cause : error;
	return cause instanceof FileError && cause.code !== "unknown" && cause.code !== "aborted";
}

function serializeJsonlSession(header: SessionHeader, entries: SessionTreeEntry[]): string {
	return `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function publishJsonlContentAtomicallyUnsafe(
	fs: JsonlSessionStorageFileSystem,
	filePath: string,
	content: string | Uint8Array,
	allowReplace: boolean,
): Promise<void> {
	const destinationInfo = await fs.fileInfo(filePath);
	if (destinationInfo.ok) {
		if (!allowReplace) throw new SessionError("already_exists", `Session already exists: ${filePath}`);
		if (destinationInfo.value.kind !== "file") {
			throw new SessionError("storage", `Refusing to replace non-file session path: ${filePath}`);
		}
	} else if (destinationInfo.error.code !== "not_found") {
		getFileSystemResultOrThrow(destinationInfo, `Failed to inspect session destination ${filePath}`);
	}

	let tempPath: string | undefined;
	for (let attempt = 0; attempt < 100; attempt++) {
		const candidate = `${filePath}.${uuidv7()}.tmp`;
		if (
			!getFileSystemResultOrThrow(await fs.exists(candidate), `Failed to inspect session staging path ${candidate}`)
		) {
			tempPath = candidate;
			break;
		}
	}
	if (!tempPath) throw new SessionError("storage", `Failed to allocate staging path for session ${filePath}`);

	let published = false;
	try {
		try {
			getFileSystemResultOrThrow(await fs.writeFile(tempPath, content), `Failed to stage session ${filePath}`);
		} catch (error) {
			throw jsonlStorageError(
				filePath,
				"replace",
				`Failed to stage session ${filePath}`,
				toError(error),
				"not_written",
			);
		}
		try {
			getFileSystemResultOrThrow(await fs.renameFile(tempPath, filePath), `Failed to publish session ${filePath}`);
		} catch (error) {
			throw jsonlStorageError(
				filePath,
				"replace",
				`Failed to publish session ${filePath}`,
				toError(error),
				"unknown",
			);
		}
		published = true;
	} finally {
		if (!published) await fs.remove(tempPath, { force: true });
	}
}

async function publishJsonlContentAtomically(
	fs: JsonlSessionStorageFileSystem,
	filePath: string,
	content: string | Uint8Array,
	allowReplace: boolean,
	phase: JsonlErrorPhase = "replace",
): Promise<void> {
	try {
		await publishJsonlContentAtomicallyUnsafe(fs, filePath, content, allowReplace);
	} catch (error) {
		const cause = toError(error);
		if (cause instanceof JsonlSessionError) {
			throw new JsonlSessionError({
				code: cause.code,
				reference: cause.reference,
				phase,
				message: cause.message,
				outcome: cause.outcome,
				cause: cause.cause instanceof Error ? cause.cause : cause,
			});
		}
		throw jsonlStorageError(filePath, phase, cause.message, cause, "not_written");
	}
}

function headerToSessionMetadata(header: SessionHeader, path: string): JsonlSessionMetadata {
	return {
		id: header.id,
		createdAt: header.timestamp,
		cwd: header.cwd,
		path,
		parentSessionPath: header.parentSession,
	};
}

export async function loadJsonlSessionMetadata(
	fs: JsonlSessionMetadataFileSystem,
	filePath: string,
): Promise<JsonlSessionMetadata> {
	let firstLine: string;
	try {
		const lines = getFileSystemResultOrThrow(
			await fs.readTextLines(filePath, { maxLines: 1 }),
			`Failed to read session header ${filePath}`,
		);
		firstLine = lines[0] ?? "";
	} catch (error) {
		throw jsonlStorageError(filePath, "list", `Failed to read session header ${filePath}`, toError(error));
	}
	if (!firstLine) throw invalidSession(filePath, "missing session header", undefined, "list");
	let headerBytes: Uint8Array = new TextEncoder().encode(firstLine);
	if (firstLine.includes("\uFFFD")) {
		let bytes: Uint8Array;
		try {
			bytes = getFileSystemResultOrThrow(
				await fs.readBinaryFile(filePath),
				`Failed to verify session header encoding ${filePath}`,
			);
		} catch (error) {
			throw jsonlStorageError(
				filePath,
				"list",
				`Failed to verify session header encoding ${filePath}`,
				toError(error),
			);
		}
		const newline = bytes.indexOf(0x0a);
		headerBytes = newline === -1 ? bytes : bytes.subarray(0, newline);
	}
	try {
		return headerToSessionMetadata(
			parseHeaderRecord({ bytes: headerBytes, line: 1, start: 0, terminated: true }, filePath),
			filePath,
		);
	} catch (error) {
		if (error instanceof JsonlSessionError) throw withJsonlPhase(error, "list");
		throw error;
	}
}

function validateEntryState(
	entry: SessionTreeEntry,
	entriesById: Map<string, SessionTreeEntry>,
	filePath: string,
	line: number,
	byteOffset?: number,
	phase: JsonlErrorPhase = "open",
): void {
	if (entriesById.has(entry.id)) {
		throw invalidEntry(filePath, line, `duplicates entry id ${entry.id}`, undefined, byteOffset, phase);
	}
	if (entry.parentId !== null && !entriesById.has(entry.parentId)) {
		throw invalidEntry(filePath, line, `references missing parent ${entry.parentId}`, undefined, byteOffset, phase);
	}
	const targetId =
		entry.type === "label"
			? entry.targetId
			: entry.type === "compaction"
				? entry.firstKeptEntryId
				: entry.type === "branch_summary"
					? entry.fromId
					: entry.type === "leaf"
						? entry.targetId
						: undefined;
	if (targetId !== undefined && targetId !== null && !entriesById.has(targetId)) {
		throw invalidEntry(filePath, line, `references missing target ${targetId}`, undefined, byteOffset, phase);
	}
	entriesById.set(entry.id, entry);
}
function getNextAppendPosition(bytes: Uint8Array): { nextLine: number; nextOffset: number } {
	let nextLine = 1;
	for (const byte of bytes) {
		if (byte === 0x0a) nextLine++;
	}
	return { nextLine, nextOffset: bytes.length };
}

async function loadJsonlStorage(
	fs: JsonlSessionStorageFileSystem,
	filePath: string,
	phase: "open" | "fork" = "open",
): Promise<{
	header: SessionHeader;
	entries: SessionTreeEntry[];
	leafId: string | null;
	nextLine: number;
	nextOffset: number;
}> {
	let bytes: Uint8Array;
	try {
		bytes = getFileSystemResultOrThrow(await fs.readBinaryFile(filePath), `Failed to read session ${filePath}`);
	} catch (error) {
		throw jsonlStorageError(filePath, phase, `Failed to read session ${filePath}`, toError(error));
	}
	const records = splitPhysicalRecords(bytes);
	if (records.length === 0) throw invalidSession(filePath, "missing session header", undefined, phase);
	let header: SessionHeader;
	try {
		header = parseHeaderRecord(records[0]!, filePath);
	} catch (error) {
		if (error instanceof JsonlSessionError) throw withJsonlPhase(error, phase);
		throw error;
	}
	const entries: SessionTreeEntry[] = [];
	const entriesById = new Map<string, SessionTreeEntry>();
	let leafId: string | null = null;

	for (let index = 1; index < records.length; index++) {
		const record = records[index]!;
		let line: string;
		try {
			line = decodeRecord(record);
		} catch (error) {
			const failure = toError(error);
			if (!record.terminated && index === records.length - 1 && failure instanceof JsonlDecodeFailure) {
				await publishJsonlContentAtomically(fs, filePath, bytes.subarray(0, record.start), true, "repair");
				return { header, entries, leafId, ...getNextAppendPosition(bytes.subarray(0, record.start)) };
			}
			throw invalidEntry(filePath, record.line, failure.message, failure, record.start, phase);
		}
		if (!line.trim()) continue;
		let entry: SessionTreeEntry;
		try {
			entry = parseEntryRecord(record);
		} catch (error) {
			const failure = toError(error);
			if (
				!record.terminated &&
				index === records.length - 1 &&
				failure instanceof JsonlDecodeFailure &&
				failure.kind === "syntax"
			) {
				await publishJsonlContentAtomically(fs, filePath, bytes.subarray(0, record.start), true, "repair");
				return { header, entries, leafId, ...getNextAppendPosition(bytes.subarray(0, record.start)) };
			}
			throw invalidEntry(filePath, record.line, failure.message, failure, record.start, phase);
		}
		validateEntryState(entry, entriesById, filePath, record.line, record.start, phase);
		entries.push(entry);
		leafId = leafIdAfterEntry(entry);
	}

	if (records.at(-1)?.terminated === false) {
		const repaired = new Uint8Array(bytes.length + 1);
		repaired.set(bytes);
		repaired[bytes.length] = 0x0a;
		await publishJsonlContentAtomically(fs, filePath, repaired, true, "repair");
	}
	const position = getNextAppendPosition(bytes);
	if (records.at(-1)?.terminated === false) {
		position.nextLine++;
		position.nextOffset++;
	}
	return { header, entries, leafId, ...position };
}

export class JsonlSessionStorage implements SessionStorage<JsonlSessionMetadata> {
	private readonly fs: JsonlSessionStorageFileSystem;
	private readonly filePath: string;
	private readonly metadata: JsonlSessionMetadata;
	private entries: SessionTreeEntry[];
	private byId: Map<string, SessionTreeEntry>;
	private labelsById: Map<string, string>;
	private currentLeafId: string | null;
	private appendQueue: Promise<void> = Promise.resolve();
	private writeFence: JsonlSessionError | undefined;
	private nextAppendLine: number;
	private nextAppendOffset: number;

	private constructor(
		fs: JsonlSessionStorageFileSystem,
		filePath: string,
		header: SessionHeader,
		entries: SessionTreeEntry[],
		leafId: string | null,
		nextAppendLine: number,
		nextAppendOffset: number,
	) {
		this.fs = fs;
		this.filePath = filePath;
		this.metadata = headerToSessionMetadata(header, this.filePath);
		this.entries = entries;
		this.byId = new Map(entries.map((entry) => [entry.id, entry]));
		this.labelsById = buildLabelsById(entries);
		this.currentLeafId = leafId;
		this.nextAppendLine = nextAppendLine;
		this.nextAppendOffset = nextAppendOffset;
	}

	static async open(
		fs: JsonlSessionStorageFileSystem,
		filePath: string,
		phase: "open" | "fork" = "open",
	): Promise<JsonlSessionStorage> {
		const loaded = await loadJsonlStorage(fs, filePath, phase);
		return new JsonlSessionStorage(
			fs,
			filePath,
			loaded.header,
			loaded.entries,
			loaded.leafId,
			loaded.nextLine,
			loaded.nextOffset,
		);
	}

	static async create(
		fs: JsonlSessionStorageFileSystem,
		filePath: string,
		options: {
			cwd: string;
			sessionId: string;
			parentSessionPath?: string;
			entries?: SessionTreeEntry[];
			phase?: "create" | "fork";
		},
	): Promise<JsonlSessionStorage> {
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: options.sessionId,
			timestamp: new Date().toISOString(),
			cwd: options.cwd,
			parentSession: options.parentSessionPath,
		};
		const entries = [...(options.entries ?? [])];
		const serialized = serializeJsonlSession(header, entries);
		await publishJsonlContentAtomically(fs, filePath, serialized, false, options.phase ?? "create");
		const position = getNextAppendPosition(new TextEncoder().encode(serialized));
		return new JsonlSessionStorage(
			fs,
			filePath,
			header,
			entries,
			leafIdAfterEntries(entries),
			position.nextLine,
			position.nextOffset,
		);
	}

	async getMetadata(): Promise<JsonlSessionMetadata> {
		return this.metadata;
	}

	async getLeafId(): Promise<string | null> {
		if (this.currentLeafId !== null && !this.byId.has(this.currentLeafId)) {
			throw new SessionError("invalid_session", `Entry ${this.currentLeafId} not found`);
		}
		return this.currentLeafId;
	}

	async setLeafId(leafId: string | null): Promise<void> {
		if (leafId !== null && !this.byId.has(leafId)) {
			throw new SessionError("not_found", `Entry ${leafId} not found`);
		}
		const entry: LeafEntry = {
			type: "leaf",
			id: generateEntryId(this.byId),
			parentId: this.currentLeafId,
			timestamp: new Date().toISOString(),
			targetId: leafId,
		};
		await this.appendSerializedEntry(entry, `Failed to append session leaf ${entry.id}`, () => {
			this.entries.push(entry);
			this.byId.set(entry.id, entry);
			this.currentLeafId = leafId;
		});
	}

	async createEntryId(): Promise<string> {
		return generateEntryId(this.byId);
	}

	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		await this.appendSerializedEntry(entry, `Failed to append session entry ${entry.id}`, () => {
			this.entries.push(entry);
			this.byId.set(entry.id, entry);
			updateLabelCache(this.labelsById, entry);
			this.currentLeafId = leafIdAfterEntry(entry);
		});
	}

	private async appendSerializedEntry(entry: SessionTreeEntry, message: string, commit: () => void): Promise<void> {
		const serialized = `${JSON.stringify(entry)}\n`;
		const serializedLength = new TextEncoder().encode(serialized).length;
		const operation = this.appendQueue.then(async () => {
			validateEntryState(
				entry,
				new Map(this.byId),
				this.filePath,
				this.nextAppendLine,
				this.nextAppendOffset,
				"append",
			);
			if (this.writeFence) {
				throw new JsonlSessionError({
					code: "storage",
					reference: this.filePath,
					phase: "append",
					message: `Session writes are fenced after an ambiguous append failure: ${this.filePath}`,
					outcome: "unknown",
					cause: this.writeFence,
				});
			}
			try {
				getFileSystemResultOrThrow(await this.fs.appendFile(this.filePath, serialized), message);
			} catch (error) {
				const cause = toError(error);
				if (isDefinitelyNotWritten(error)) {
					throw jsonlStorageError(this.filePath, "append", message, cause, "not_written");
				}
				this.writeFence = jsonlStorageError(this.filePath, "append", message, cause, "unknown");
				throw this.writeFence;
			}
			commit();
			this.nextAppendLine++;
			this.nextAppendOffset += serializedLength;
		});
		this.appendQueue = operation.catch(() => {});
		await operation;
	}

	async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return this.byId.get(id);
	}

	async findEntries<TType extends SessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
		return this.entries.filter((entry): entry is Extract<SessionTreeEntry, { type: TType }> => entry.type === type);
	}

	async getLabel(id: string): Promise<string | undefined> {
		return this.labelsById.get(id);
	}

	async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
		if (leafId === null) return [];
		const path: SessionTreeEntry[] = [];
		let current = this.byId.get(leafId);
		if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
		while (current) {
			path.unshift(current);
			if (!current.parentId) break;
			const parent = this.byId.get(current.parentId);
			if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
			current = parent;
		}
		return path;
	}

	async getEntries(): Promise<SessionTreeEntry[]> {
		return [...this.entries];
	}
}
