import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { loadEntriesFromFile } from "./jsonl-helpers.ts";
import { migrateToCurrentVersion } from "./migrations.ts";
import { RemoteSession } from "./remote-session.ts";
import type { RemoteSessionSnapshot } from "./remote-session-client.ts";
import { RemoteSessionClient } from "./remote-session-client.ts";
import type { Session } from "./session.ts";
import type { OpenSessionOptions, SessionManager } from "./session-manager.ts";
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
	return header?.cwd ?? fallback;
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
		const snapshot = await this.client.createSession({
			id: options?.id,
			cwd: this.cwd,
			projectId: this.projectId,
			parentSession: options?.parentSession,
		});
		return new RemoteSession({ client: this.client, cwd: this.cwd, snapshot });
	}

	async openReference(reference: string, options?: OpenSessionOptions): Promise<RemoteSession> {
		const snapshot = await this.client.openSession(reference);
		return new RemoteSession({
			client: this.client,
			cwd: options?.cwdOverride ?? getSnapshotCwd(snapshot, this.cwd),
			snapshot,
		});
	}

	async continueRecent(): Promise<RemoteSession> {
		const snapshot = await this.client.getRecentSession();
		return new RemoteSession({ client: this.client, cwd: getSnapshotCwd(snapshot, this.cwd), snapshot });
	}

	async forkFrom(reference: string): Promise<RemoteSession> {
		const snapshot = await this.client.forkSession(reference, { cwd: this.cwd, projectId: this.projectId });
		return new RemoteSession({ client: this.client, cwd: this.cwd, snapshot });
	}

	async forkSession(source: Session, targetLeafId: string | null): Promise<RemoteSession> {
		const reference = source.getSessionReference();
		if (!reference) {
			throw new Error("Cannot fork a remote session without a session reference");
		}
		const snapshot = await this.client.forkSession(reference, {
			cwd: this.cwd,
			projectId: this.projectId,
			leafId: targetLeafId ?? undefined,
		});
		return new RemoteSession({ client: this.client, cwd: this.cwd, snapshot });
	}

	async importJsonl(inputPath: string, options?: OpenSessionOptions): Promise<RemoteSession> {
		const resolvedPath = resolve(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new Error(`File not found: ${resolvedPath}`);
		}

		const entries = loadEntriesFromFile(resolvedPath);
		if (entries.length === 0) {
			throw new Error(`Cannot import empty or invalid session JSONL: ${resolvedPath}`);
		}
		migrateToCurrentVersion(entries);

		const cwd = options?.cwdOverride ?? getSnapshotCwd({ id: "", reference: "", entries }, this.cwd);
		const snapshot = await this.client.importJsonl({
			cwd,
			projectId: this.projectId,
			sourceName: basename(resolvedPath),
			entries,
		});
		return new RemoteSession({ client: this.client, cwd: getSnapshotCwd(snapshot, cwd), snapshot });
	}

	async list(_onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		const response = await this.client.listSessions();
		return response.sessions;
	}

	async listAll(_onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		const response = await this.client.listSessions();
		return response.sessions;
	}
}
