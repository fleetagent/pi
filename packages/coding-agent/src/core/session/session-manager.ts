import type { Session } from "./session.ts";
import type { NewSessionOptions, SessionInfo, SessionListProgress } from "./types.ts";

export type SessionResult = Session | Promise<Session>;

export interface OpenSessionOptions {
	cwdOverride?: string;
}

export interface SessionManager {
	create(options?: NewSessionOptions): SessionResult;
	openReference(reference: string, options?: OpenSessionOptions): SessionResult;
	continueRecent(): SessionResult;
	forkFrom(reference: string): SessionResult;
	forkSession(source: Session, targetLeafId: string | null): SessionResult;
	importJsonl(inputPath: string, options?: OpenSessionOptions): SessionResult;
	list(onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]>;
}
