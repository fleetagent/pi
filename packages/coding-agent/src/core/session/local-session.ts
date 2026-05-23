import { join } from "node:path";
import { Session } from "./session.ts";
import type { SessionManager } from "./session-manager.ts";
import { JsonlSessionStore } from "./stores/jsonl-session-store.ts";

export class LocalSession extends Session {
	constructor(cwd: string, sessionDir: string, sessionReference: string | undefined, sessionManager?: SessionManager) {
		super(cwd, sessionDir, sessionReference, new JsonlSessionStore(), sessionManager);
	}

	protected prepareNewSessionReference(sessionDir: string, sessionId: string, timestamp: string): string | undefined {
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		return join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
	}
}
