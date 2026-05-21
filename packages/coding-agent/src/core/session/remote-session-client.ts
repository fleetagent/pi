import type { FileEntry, SessionInfo } from "./types.ts";

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

export interface ListRemoteSessionsResponse {
	sessions: SessionInfo[];
}

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
		return this.request("POST", "/v1/sessions", request);
	}

	openSession(sessionIdOrReference: string): Promise<RemoteSessionSnapshot> {
		return this.request("GET", `/v1/sessions/${encodeURIComponent(parseRemoteSessionId(sessionIdOrReference))}`);
	}

	appendEntries(
		sessionIdOrReference: string,
		request: AppendRemoteSessionEntriesRequest,
	): Promise<AppendRemoteSessionEntriesResponse> {
		return this.request(
			"POST",
			`/v1/sessions/${encodeURIComponent(parseRemoteSessionId(sessionIdOrReference))}/entries`,
			request,
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
		);
	}

	listSessions(): Promise<ListRemoteSessionsResponse> {
		return this.request("GET", "/v1/sessions");
	}

	getRecentSession(): Promise<RemoteSessionSnapshot> {
		return this.request("GET", "/v1/sessions/recent");
	}

	forkSession(sessionIdOrReference: string, request: ForkRemoteSessionRequest): Promise<RemoteSessionSnapshot> {
		return this.request(
			"POST",
			`/v1/sessions/${encodeURIComponent(parseRemoteSessionId(sessionIdOrReference))}/fork`,
			request,
		);
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
			return undefined as T;
		}

		return (await response.json()) as T;
	}
}

export function parseRemoteSessionId(reference: string): string {
	return reference.startsWith("remote:") ? reference.slice("remote:".length) : reference;
}

export function formatRemoteSessionReference(sessionId: string): string {
	return sessionId.startsWith("remote:") ? sessionId : `remote:${sessionId}`;
}
