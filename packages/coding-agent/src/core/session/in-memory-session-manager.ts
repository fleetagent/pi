import { InMemorySession } from "./in-memory-session.ts";
import type { Session } from "./session.ts";
import type { OpenSessionOptions, SessionManager } from "./session-manager.ts";
import type { NewSessionOptions, SessionInfo, SessionListProgress } from "./types.ts";

export class InMemorySessionManager implements SessionManager {
	private readonly cwd: string;

	constructor(cwd: string = process.cwd()) {
		this.cwd = cwd;
	}

	create(options?: NewSessionOptions): InMemorySession {
		const session = new InMemorySession(this.cwd);
		if (options?.id || options?.parentSession) {
			session.newSession(options);
		}
		return session;
	}

	openReference(_reference: string, _options?: OpenSessionOptions): InMemorySession {
		return this.create();
	}

	continueRecent(): InMemorySession {
		return this.create();
	}

	forkFrom(_reference: string): InMemorySession {
		return this.create();
	}

	forkSession(source: Session, targetLeafId: string | null): Session {
		if (!targetLeafId) {
			source.newSession({ parentSession: source.getSessionReference() });
		} else {
			source.createBranchedSession(targetLeafId);
		}
		return source;
	}

	importJsonl(_inputPath: string, _options?: OpenSessionOptions): InMemorySession {
		throw new Error("Importing JSONL sessions is not supported by in-memory sessions");
	}

	async list(_onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		return [];
	}

	async listAll(_onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		return [];
	}
}
