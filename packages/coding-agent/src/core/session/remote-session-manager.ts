import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { JsonlErrorPhase } from "./jsonl-errors.ts";
import { createJsonlSessionDecodeError } from "./jsonl-errors.ts";
import { loadEntriesFromFile } from "./jsonl-helpers.ts";
import { migrateToCurrentVersion } from "./migrations.ts";
import { RemoteSession } from "./remote-session.ts";
import type { RemoteSessionInfo, RemoteSessionSnapshot } from "./remote-session-client.ts";
import { RemoteSessionClient } from "./remote-session-client.ts";
import type { Session } from "./session.ts";
import type { OpenSessionOptions, SessionManager } from "./session-manager.ts";
import { getJsonlEntryLocations, validateCurrentSessionEntries } from "./stores/jsonl-session-store.ts";
import type { NewSessionOptions, SessionHeader, SessionInfo, SessionListProgress } from "./types.ts";

export interface RemoteSessionManagerOptions {
	baseUrl: string;
	token: string;
	cwd: string;
	projectId?: string;
	fetch?: typeof fetch;
}

function getSnapshotCwd(snapshot: RemoteSessionSnapshot, fallback: string): string {
	const header = snapshot.entries.find((entry) => entry.type === "session") as SessionHeader | undefined;
	return typeof header?.cwd === "string" ? header.cwd : fallback;
}

function validateRemoteSnapshot(snapshot: RemoteSessionSnapshot, phase: JsonlErrorPhase): RemoteSessionSnapshot {
	validateCurrentSessionEntries(snapshot.entries, snapshot.reference, { phase });
	return snapshot;
}

function normalizeRemoteSessionInfo(session: RemoteSessionInfo): SessionInfo {
	const reference = session.reference ?? session.path;
	return {
		...session,
		reference,
		path: session.path ?? reference ?? session.id,
		created: session.created instanceof Date ? session.created : new Date(session.created),
		modified: session.modified instanceof Date ? session.modified : new Date(session.modified),
	};
}

/**
 * Remote session manager skeleton.
 *
 * Lifecycle methods are async-compatible through SessionManager so this backend
 * can fetch/create snapshots before returning an active Session.
 */
export class RemoteSessionManager implements SessionManager {
	private readonly client: RemoteSessionClient;
	private readonly cwd: string;
	private readonly projectId: string | undefined;

	constructor(options: RemoteSessionManagerOptions) {
		this.client = new RemoteSessionClient({ baseUrl: options.baseUrl, token: options.token, fetch: options.fetch });
		this.cwd = options.cwd;
		this.projectId = options.projectId;
	}

	async create(options?: NewSessionOptions): Promise<RemoteSession> {
		const snapshot = validateRemoteSnapshot(
			await this.client.createSession({
				id: options?.id,
				cwd: this.cwd,
				projectId: this.projectId,
				parentSession: options?.parentSession,
			}),
			"create",
		);
		return new RemoteSession({ client: this.client, cwd: this.cwd, snapshot, sessionManager: this });
	}

	async openReference(reference: string, options?: OpenSessionOptions): Promise<RemoteSession> {
		const snapshot = validateRemoteSnapshot(await this.client.openSession(reference), "open");
		return new RemoteSession({
			client: this.client,
			cwd: options?.cwdOverride ?? getSnapshotCwd(snapshot, this.cwd),
			snapshot,
			sessionManager: this,
		});
	}

	async continueRecent(): Promise<RemoteSession> {
		const snapshot = validateRemoteSnapshot(await this.client.getRecentSession(), "open");
		return new RemoteSession({
			client: this.client,
			cwd: getSnapshotCwd(snapshot, this.cwd),
			snapshot,
			sessionManager: this,
		});
	}

	async forkFrom(reference: string): Promise<RemoteSession> {
		const snapshot = validateRemoteSnapshot(
			await this.client.forkSession(reference, { cwd: this.cwd, projectId: this.projectId }),
			"fork",
		);
		return new RemoteSession({ client: this.client, cwd: this.cwd, snapshot, sessionManager: this });
	}

	async forkSession(source: Session, targetLeafId: string | null): Promise<RemoteSession> {
		if (source instanceof RemoteSession) await source.flushPendingSync();
		const reference = source.getSessionReference();
		if (!reference) {
			throw new Error("Cannot fork a remote session without a session reference");
		}
		const snapshot = validateRemoteSnapshot(
			await this.client.forkSession(reference, {
				cwd: this.cwd,
				projectId: this.projectId,
				leafId: targetLeafId ?? undefined,
			}),
			"fork",
		);
		return new RemoteSession({ client: this.client, cwd: this.cwd, snapshot, sessionManager: this });
	}

	async importJsonl(inputPath: string, options?: OpenSessionOptions): Promise<RemoteSession> {
		const resolvedPath = resolve(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new Error(`File not found: ${resolvedPath}`);
		}

		const entries = loadEntriesFromFile(resolvedPath, { repair: false, phase: "import" });
		if (entries.length === 0) {
			throw createJsonlSessionDecodeError(
				resolvedPath,
				"import",
				"schema",
				`Cannot import empty or invalid session JSONL: ${resolvedPath}`,
			);
		}
		migrateToCurrentVersion(entries);
		validateCurrentSessionEntries(entries, resolvedPath, {
			phase: "import",
			locations: getJsonlEntryLocations(entries),
		});

		const cwd = options?.cwdOverride ?? getSnapshotCwd({ id: "", reference: "", entries }, this.cwd);
		const snapshot = validateRemoteSnapshot(
			await this.client.importJsonl({
				cwd,
				projectId: this.projectId,
				sourceName: basename(resolvedPath),
				entries,
			}),
			"import",
		);
		return new RemoteSession({
			client: this.client,
			cwd: getSnapshotCwd(snapshot, cwd),
			snapshot,
			sessionManager: this,
		});
	}

	async list(_onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		const response = await this.client.listSessions();
		return response.sessions.map((session) => normalizeRemoteSessionInfo(session));
	}

	async listAll(_onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		const response = await this.client.listSessions();
		return response.sessions.map((session) => normalizeRemoteSessionInfo(session));
	}
}
