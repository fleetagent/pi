import { join } from "node:path";
import { Session } from "./session.ts";
import type { SessionManager } from "./session-manager.ts";
import { type JsonlFirstPublicationCoordinator, JsonlSessionStore } from "./stores/jsonl-session-store.ts";
import type { FileEntry } from "./types.ts";

export class LocalSession extends Session {
	constructor(
		cwd: string,
		sessionDir: string,
		sessionReference: string | undefined,
		sessionManager?: SessionManager,
		preloadedFileEntries?: FileEntry[],
		firstPublicationCoordinator?: JsonlFirstPublicationCoordinator,
	) {
		super(
			cwd,
			sessionDir,
			sessionReference,
			new JsonlSessionStore(
				sessionReference && preloadedFileEntries
					? { reference: sessionReference, entries: preloadedFileEntries }
					: undefined,
				undefined,
				firstPublicationCoordinator,
			),
			sessionManager,
		);
	}

	protected prepareNewSessionReference(sessionDir: string, sessionId: string, timestamp: string): string | undefined {
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		return join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
	}
}
