import { RemoteSession } from "./remote-session.ts";
import { RemoteSessionClient } from "./remote-session-client.ts";
import type { Session } from "./session.ts";
import type { OpenSessionOptions, SessionManager } from "./session-manager.ts";
import type { SessionInfo, SessionListProgress } from "./types.ts";

export interface RemoteSessionManagerOptions {
	baseUrl: string;
	token: string;
	cwd: string;
	projectId?: string;
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
		this.client = new RemoteSessionClient({ baseUrl: options.baseUrl, token: options.token });
		this.cwd = options.cwd;
		this.projectId = options.projectId;
	}

	async create(): Promise<RemoteSession> {
		const snapshot = await this.client.createSession({ cwd: this.cwd, projectId: this.projectId });
		return new RemoteSession({ cwd: this.cwd, reference: snapshot.reference });
	}

	async openReference(reference: string, _options?: OpenSessionOptions): Promise<RemoteSession> {
		const snapshot = await this.client.openSession(reference);
		return new RemoteSession({ cwd: this.cwd, reference: snapshot.reference });
	}

	async continueRecent(): Promise<RemoteSession> {
		const snapshot = await this.client.getRecentSession();
		return new RemoteSession({ cwd: this.cwd, reference: snapshot.reference });
	}

	async forkFrom(reference: string): Promise<RemoteSession> {
		const snapshot = await this.client.forkSession(reference, { cwd: this.cwd, projectId: this.projectId });
		return new RemoteSession({ cwd: this.cwd, reference: snapshot.reference });
	}

	async forkSession(source: Session, _targetLeafId: string | null): Promise<RemoteSession> {
		const reference = source.getSessionReference();
		if (!reference) {
			throw new Error("Cannot fork a remote session without a session reference");
		}
		return this.forkFrom(reference);
	}

	importJsonl(_inputPath: string, _options?: OpenSessionOptions): Promise<RemoteSession> {
		throw new Error("Importing JSONL sessions is not supported by remote sessions");
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
