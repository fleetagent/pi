import { Session } from "./session.ts";
import type { SessionManager } from "./session-manager.ts";
import { InMemorySessionStore } from "./stores/in-memory-session-store.ts";

export class InMemorySession extends Session {
	constructor(cwd: string = process.cwd(), sessionManager?: SessionManager) {
		super(cwd, "", undefined, new InMemorySessionStore(), sessionManager);
	}

	protected prepareNewSessionReference(
		_sessionDir: string,
		sessionId: string,
		_timestamp: string,
	): string | undefined {
		return `memory:${sessionId}`;
	}
}
