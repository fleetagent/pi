import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CURRENT_SESSION_VERSION } from "./constants.ts";
import { createSessionId } from "./ids.ts";
import { findMostRecentSession, getDefaultSessionDir, loadEntriesFromFile } from "./jsonl-helpers.ts";
import { LocalSession } from "./local-session.ts";
import type { Session } from "./session.ts";
import type { OpenSessionOptions, SessionManager } from "./session-manager.ts";
import {
	ensureDir,
	forkSession as forkJsonlSession,
	getSessionDirForReference,
	getSessionsRoot,
	listAll as listAllJsonlSessions,
	list as listJsonlSessions,
} from "./stores/jsonl-session-store.ts";
import type { NewSessionOptions, SessionHeader, SessionInfo, SessionListProgress } from "./types.ts";

export interface LocalSessionManagerOptions {
	cwd: string;
	sessionDir?: string;
}

export class LocalSessionManager implements SessionManager {
	private readonly cwd: string;
	private readonly sessionDir?: string;

	constructor(options: LocalSessionManagerOptions) {
		this.cwd = options.cwd;
		this.sessionDir = options.sessionDir;
	}

	create(options?: NewSessionOptions): LocalSession {
		const dir = this.sessionDir ?? getDefaultSessionDir(this.cwd);
		const session = new LocalSession(this.cwd, dir, undefined, this);
		if (options?.id || options?.parentSession) {
			session.newSession(options);
		}
		return session;
	}

	openReference(reference: string, options?: OpenSessionOptions): LocalSession {
		const entries = loadEntriesFromFile(reference);
		const header = entries.find((entry) => entry.type === "session") as SessionHeader | undefined;
		const cwd = options?.cwdOverride ?? header?.cwd ?? this.cwd;
		const dir = this.sessionDir ?? getSessionDirForReference(reference);
		return new LocalSession(cwd, dir, reference, this);
	}

	continueRecent(): LocalSession {
		const dir = this.sessionDir ?? getDefaultSessionDir(this.cwd);
		const mostRecent = findMostRecentSession(dir);
		if (mostRecent) {
			return new LocalSession(this.cwd, dir, mostRecent, this);
		}
		return new LocalSession(this.cwd, dir, undefined, this);
	}

	forkFrom(reference: string): LocalSession {
		const sourceEntries = loadEntriesFromFile(reference);
		if (sourceEntries.length === 0) {
			throw new Error(`Cannot fork: source session is empty or invalid: ${reference}`);
		}

		const sourceHeader = sourceEntries.find((entry) => entry.type === "session") as SessionHeader | undefined;
		if (!sourceHeader) {
			throw new Error(`Cannot fork: source session has no header: ${reference}`);
		}

		const dir = this.sessionDir ?? getDefaultSessionDir(this.cwd);
		ensureDir(dir);

		const newSessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const newHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: reference,
		};
		const newSessionReference = forkJsonlSession(dir, newHeader, sourceEntries);

		return new LocalSession(this.cwd, dir, newSessionReference, this);
	}

	forkSession(source: Session, targetLeafId: string | null): LocalSession {
		const parentSession = source.getSessionReference();
		if (!targetLeafId) {
			const session = this.create();
			session.newSession({ parentSession });
			return session;
		}

		const branchSource = parentSession ? this.openReference(parentSession) : source;
		const forkedReference = branchSource.createBranchedSession(targetLeafId);
		if (!forkedReference) {
			throw new Error("Failed to create forked session");
		}
		return this.openReference(forkedReference);
	}

	importJsonl(inputPath: string, options?: OpenSessionOptions): LocalSession {
		const resolvedPath = resolve(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new Error(`File not found: ${resolvedPath}`);
		}

		const dir = this.sessionDir ?? getDefaultSessionDir(this.cwd);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const destinationPath = join(dir, basename(resolvedPath));
		if (resolve(destinationPath) !== resolvedPath) {
			copyFileSync(resolvedPath, destinationPath);
		}
		return this.openReference(destinationPath, options);
	}

	async list(onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		const dir = this.sessionDir ?? getDefaultSessionDir(this.cwd);
		const sessions = await listJsonlSessions(dir, onProgress);
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}

	async listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		const sessions = await listAllJsonlSessions(getSessionsRoot(), onProgress);
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}
}
