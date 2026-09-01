import { validateSessionId } from "./ids.ts";
import type { FileEntry, SessionInfo } from "./types.ts";

export type RemoteSessionInfo = Omit<SessionInfo, "path" | "created" | "modified"> & {
	path?: string;
	created: Date | string;
	modified: Date | string;
};

export interface RemoteSessionClientOptions {
	baseUrl: string;
	token: string;
	fetch?: typeof fetch;
}

export interface RemoteSessionSnapshot {
	reference: string;
	id: string;
	version?: number;
	entries: FileEntry[];
	etag?: string;
}

export interface CreateRemoteSessionRequest {
	id?: string;
	cwd: string;
	projectId?: string;
	parentSession?: string;
	metadata?: Record<string, unknown>;
}

export interface AppendRemoteSessionEntriesRequest {
	baseEtag?: string;
	entries: FileEntry[];
}

export interface AppendRemoteSessionEntriesResponse {
	etag?: string;
	accepted: number;
}

// pi-ignore noNearIdenticalDataStructures: Snapshot replacement atomically rewrites complete state, while append applies incremental entries; their endpoint validation and concurrency contracts evolve independently.
export interface ReplaceRemoteSessionSnapshotRequest {
	baseEtag?: string;
	entries: FileEntry[];
}

export interface ReplaceRemoteSessionSnapshotResponse {
	etag?: string;
}

export interface ForkRemoteSessionRequest {
	cwd: string;
	projectId?: string;
	leafId?: string;
}

export interface ImportRemoteSessionJsonlRequest {
	cwd: string;
	projectId?: string;
	sourceName?: string;
	entries: FileEntry[];
	metadata?: Record<string, unknown>;
}

export interface ListRemoteSessionsResponse {
	sessions: RemoteSessionInfo[];
}

export type RemoteSessionOperation = "create" | "open" | "recent" | "fork" | "import" | "list" | "append" | "replace";

export class RemoteSessionClientError extends Error {
	readonly status: number;
	readonly responseText: string;

	constructor(status: number, responseText: string) {
		super(`Remote session request failed with status ${status}: ${responseText}`);
		this.name = "RemoteSessionClientError";
		this.status = status;
		this.responseText = responseText;
	}
}

export class RemoteSessionProtocolError extends Error {
	readonly operation: RemoteSessionOperation;

	constructor(operation: RemoteSessionOperation, message: string, cause?: unknown) {
		super(`Invalid remote session ${operation} response: ${message}`, { cause });
		this.name = "RemoteSessionProtocolError";
		this.operation = operation;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string, operation: RemoteSessionOperation): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new RemoteSessionProtocolError(operation, `${key} must be a non-empty string`);
	}
	return value;
}

function stringValue(record: Record<string, unknown>, key: string, operation: RemoteSessionOperation): string {
	const value = record[key];
	if (typeof value !== "string") {
		throw new RemoteSessionProtocolError(operation, `${key} must be a string`);
	}
	return value;
}

function requiredSessionId(record: Record<string, unknown>, operation: RemoteSessionOperation): string {
	const id = requiredString(record, "id", operation);
	try {
		validateSessionId(id);
	} catch (error) {
		throw new RemoteSessionProtocolError(operation, "id is not a valid session id", error);
	}
	return id;
}

function optionalString(
	record: Record<string, unknown>,
	key: string,
	operation: RemoteSessionOperation,
): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0) {
		throw new RemoteSessionProtocolError(operation, `${key} must be a non-empty string when present`);
	}
	return value;
}

function decodeSnapshot(value: unknown, operation: RemoteSessionOperation, expectedId?: string): RemoteSessionSnapshot {
	if (!isRecord(value)) throw new RemoteSessionProtocolError(operation, "snapshot must be an object");
	const id = requiredSessionId(value, operation);
	const reference = requiredString(value, "reference", operation);
	if (parseRemoteSessionId(reference) !== id) {
		throw new RemoteSessionProtocolError(operation, `reference ${reference} does not identify snapshot id ${id}`);
	}
	if (expectedId !== undefined && id !== expectedId) {
		throw new RemoteSessionProtocolError(operation, `snapshot id ${id} does not match requested id ${expectedId}`);
	}
	if (!Array.isArray(value.entries) || value.entries.length === 0 || value.entries.some((entry) => !isRecord(entry))) {
		throw new RemoteSessionProtocolError(operation, "entries must be a non-empty array of objects");
	}
	const header = value.entries[0];
	if (
		!isRecord(header) ||
		header.type !== "session" ||
		header.id !== id ||
		typeof header.cwd !== "string" ||
		typeof header.timestamp !== "string"
	) {
		throw new RemoteSessionProtocolError(operation, "entries must begin with a matching session header");
	}
	const version = value.version;
	if (
		version !== undefined &&
		(typeof version !== "number" || !Number.isInteger(version) || version < 1 || version !== header.version)
	) {
		throw new RemoteSessionProtocolError(operation, "version must be a positive integer matching the session header");
	}
	return {
		reference,
		id,
		version: version as number | undefined,
		entries: value.entries as FileEntry[],
		etag: optionalString(value, "etag", operation),
	};
}

function decodeForkSnapshot(value: unknown, sourceId: string): RemoteSessionSnapshot {
	const snapshot = decodeSnapshot(value, "fork");
	if (snapshot.id === sourceId) {
		throw new RemoteSessionProtocolError("fork", "fork snapshot must have a new session id");
	}
	const header = snapshot.entries[0];
	if (header?.type !== "session" || !header.parentSession || parseRemoteSessionId(header.parentSession) !== sourceId) {
		throw new RemoteSessionProtocolError("fork", `fork header must reference source session ${sourceId}`);
	}
	return snapshot;
}

function decodeAppendResponse(value: unknown): AppendRemoteSessionEntriesResponse {
	const operation = "append";
	if (!isRecord(value)) throw new RemoteSessionProtocolError(operation, "response must be an object");
	if (!Number.isInteger(value.accepted)) {
		throw new RemoteSessionProtocolError(operation, "accepted must be an integer");
	}
	return { accepted: value.accepted as number, etag: optionalString(value, "etag", operation) };
}

function decodeReplaceResponse(value: unknown): ReplaceRemoteSessionSnapshotResponse {
	const operation = "replace";
	if (!isRecord(value)) throw new RemoteSessionProtocolError(operation, "response must be an object");
	return { etag: optionalString(value, "etag", operation) };
}

function decodeSessionInfo(value: unknown): RemoteSessionInfo {
	const operation = "list";
	if (!isRecord(value)) throw new RemoteSessionProtocolError(operation, "each session must be an object");
	const id = requiredSessionId(value, operation);
	const reference = optionalString(value, "reference", operation);
	const path = optionalString(value, "path", operation);
	for (const candidate of [reference, path]) {
		if (candidate !== undefined && parseRemoteSessionId(candidate) !== id) {
			throw new RemoteSessionProtocolError(operation, `reference ${candidate} does not identify session id ${id}`);
		}
	}
	const created = requiredString(value, "created", operation);
	const modified = requiredString(value, "modified", operation);
	if (!Number.isFinite(Date.parse(created)) || !Number.isFinite(Date.parse(modified))) {
		throw new RemoteSessionProtocolError(operation, "created and modified must be valid date strings");
	}
	if (!Number.isInteger(value.messageCount) || (value.messageCount as number) < 0) {
		throw new RemoteSessionProtocolError(operation, "messageCount must be a non-negative integer");
	}
	return {
		reference,
		path,
		id,
		cwd: stringValue(value, "cwd", operation),
		name: optionalString(value, "name", operation),
		parentSessionPath: optionalString(value, "parentSessionPath", operation),
		created,
		modified,
		messageCount: value.messageCount as number,
		firstMessage: stringValue(value, "firstMessage", operation),
		allMessagesText: stringValue(value, "allMessagesText", operation),
	};
}

function decodeListResponse(value: unknown): ListRemoteSessionsResponse {
	if (!isRecord(value) || !Array.isArray(value.sessions)) {
		throw new RemoteSessionProtocolError("list", "sessions must be an array");
	}
	return { sessions: value.sessions.map((session) => decodeSessionInfo(session)) };
}

export class RemoteSessionClient {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: RemoteSessionClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.token = options.token;
		this.fetchImpl = options.fetch ?? fetch;
	}

	createSession(request: CreateRemoteSessionRequest): Promise<RemoteSessionSnapshot> {
		return this.request("POST", "/v1/sessions", request, "create", (value) =>
			decodeSnapshot(value, "create", request.id),
		);
	}

	openSession(sessionIdOrReference: string): Promise<RemoteSessionSnapshot> {
		const id = parseRemoteSessionId(sessionIdOrReference);
		return this.request("GET", `/v1/sessions/${encodeURIComponent(id)}`, undefined, "open", (value) =>
			decodeSnapshot(value, "open", id),
		);
	}

	appendEntries(
		sessionIdOrReference: string,
		request: AppendRemoteSessionEntriesRequest,
	): Promise<AppendRemoteSessionEntriesResponse> {
		return this.request(
			"POST",
			`/v1/sessions/${encodeURIComponent(parseRemoteSessionId(sessionIdOrReference))}/entries`,
			request,
			"append",
			decodeAppendResponse,
		);
	}

	replaceSnapshot(
		sessionIdOrReference: string,
		request: ReplaceRemoteSessionSnapshotRequest,
	): Promise<ReplaceRemoteSessionSnapshotResponse> {
		return this.request(
			"PUT",
			`/v1/sessions/${encodeURIComponent(parseRemoteSessionId(sessionIdOrReference))}/snapshot`,
			request,
			"replace",
			decodeReplaceResponse,
		);
	}

	listSessions(): Promise<ListRemoteSessionsResponse> {
		return this.request("GET", "/v1/sessions", undefined, "list", decodeListResponse);
	}

	getRecentSession(): Promise<RemoteSessionSnapshot> {
		return this.request("GET", "/v1/sessions/recent", undefined, "recent", (value) =>
			decodeSnapshot(value, "recent"),
		);
	}

	forkSession(sessionIdOrReference: string, request: ForkRemoteSessionRequest): Promise<RemoteSessionSnapshot> {
		const sourceId = parseRemoteSessionId(sessionIdOrReference);
		return this.request("POST", `/v1/sessions/${encodeURIComponent(sourceId)}/fork`, request, "fork", (value) =>
			decodeForkSnapshot(value, sourceId),
		);
	}

	importJsonl(request: ImportRemoteSessionJsonlRequest): Promise<RemoteSessionSnapshot> {
		return this.request("POST", "/v1/sessions/import-jsonl", request, "import", (value) =>
			decodeSnapshot(value, "import"),
		);
	}

	private async request<T>(
		method: string,
		path: string,
		body: unknown,
		operation: RemoteSessionOperation,
		decode: (value: unknown) => T,
	): Promise<T> {
		const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.token}`,
				Accept: "application/json",
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});

		if (!response.ok) {
			throw new RemoteSessionClientError(response.status, await response.text());
		}
		if (response.status === 204) {
			throw new RemoteSessionProtocolError(operation, "response body is required");
		}

		let value: unknown;
		try {
			value = await response.json();
		} catch (error) {
			throw new RemoteSessionProtocolError(operation, "body is not valid JSON", error);
		}
		return decode(value);
	}
}

export function parseRemoteSessionId(reference: string): string {
	return reference.startsWith("remote:") ? reference.slice("remote:".length) : reference;
}

export function formatRemoteSessionReference(sessionId: string): string {
	return sessionId.startsWith("remote:") ? sessionId : `remote:${sessionId}`;
}
