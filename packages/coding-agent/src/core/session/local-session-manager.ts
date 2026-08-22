import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CURRENT_SESSION_VERSION } from "./constants.ts";
import { createSessionId } from "./ids.ts";
import { createJsonlSessionDecodeError } from "./jsonl-errors.ts";
import {
	findMostRecentSession,
	getDefaultSessionDir,
	getDefaultSessionDirPath,
	loadEntriesFromFile,
} from "./jsonl-helpers.ts";
import { LocalSession } from "./local-session.ts";
import { migrateToCurrentVersion } from "./migrations.ts";
import type { Session } from "./session.ts";
import type { OpenSessionOptions, SessionManager } from "./session-manager.ts";
import {
	ensureDir,
	forkSession as forkJsonlSession,
	getJsonlEntryLocations,
	getSessionDirForReference,
	getSessionsRoot,
	type JsonlFirstPublicationCoordinator,
	listAll as listAllJsonlSessions,
	list as listJsonlSessions,
	prepareSessionReference,
	publishJsonlAtomically,
	readSessionHeader,
	SessionAlreadyExistsError,
	SessionHeaderScanLimitError,
	validateCurrentSessionEntries,
} from "./stores/jsonl-session-store.ts";
import type { FileEntry, NewSessionOptions, SessionHeader, SessionInfo, SessionListProgress } from "./types.ts";

export interface LocalSessionManagerOptions {
	cwd: string;
	sessionDir?: string;
}

export class LocalSessionManager implements SessionManager {
	private readonly cwd: string;
	private readonly sessionDir?: string;
	private readonly activePublicationDestinations = new Set<string>();
	private readonly firstPublicationCoordinator: JsonlFirstPublicationCoordinator = {
		publish: (filePath, entries, operation, options) =>
			this.publishFirstSnapshot(filePath, entries, operation, options),
	};

	constructor(options: LocalSessionManagerOptions) {
		this.cwd = options.cwd;
		this.sessionDir = options.sessionDir;
	}

	create(options?: NewSessionOptions): LocalSession {
		const dir = this.sessionDir ?? getDefaultSessionDir(this.cwd);
		const session = new LocalSession(this.cwd, dir, undefined, this, undefined, this.firstPublicationCoordinator);
		if (options?.id || options?.parentSession) {
			session.newSession(options);
		}
		return session;
	}

	openReference(reference: string, options?: OpenSessionOptions): LocalSession {
		let header: SessionHeader | null = null;
		let preloadedFileEntries: FileEntry[] | undefined;
		if (options?.cwdOverride === undefined && existsSync(reference)) {
			try {
				header = readSessionHeader(reference);
			} catch (error) {
				if (!(error instanceof SessionHeaderScanLimitError)) throw error;
				// The bounded scan is only a discovery optimization. A full load remains
				// authoritative for legacy files with very large headers or prefixes.
				preloadedFileEntries = loadEntriesFromFile(reference);
				const firstEntry = preloadedFileEntries[0];
				header = firstEntry?.type === "session" ? firstEntry : null;
			}
		}
		const storedCwd = typeof header?.cwd === "string" ? header.cwd : undefined;
		const cwd = options?.cwdOverride ?? storedCwd ?? this.cwd;
		const dir = this.sessionDir ?? getSessionDirForReference(reference);
		return new LocalSession(cwd, dir, reference, this, preloadedFileEntries, this.firstPublicationCoordinator);
	}

	continueRecent(): LocalSession {
		const dir = this.sessionDir ?? getDefaultSessionDir(this.cwd);
		const filterCwd = this.sessionDir !== undefined && dir !== getDefaultSessionDirPath(this.cwd);
		const mostRecent = findMostRecentSession(dir, filterCwd ? this.cwd : undefined);
		if (mostRecent) {
			return new LocalSession(this.cwd, dir, mostRecent, this, undefined, this.firstPublicationCoordinator);
		}
		return new LocalSession(this.cwd, dir, undefined, this, undefined, this.firstPublicationCoordinator);
	}

	usesDefaultSessionDir(): boolean {
		return (this.sessionDir ?? getDefaultSessionDir(this.cwd)) === getDefaultSessionDirPath(this.cwd);
	}

	forkFrom(reference: string): LocalSession {
		const sourceEntries = loadEntriesFromFile(reference, { repair: false, phase: "fork" });
		if (sourceEntries.length === 0) {
			throw createJsonlSessionDecodeError(reference, "fork", "schema", `Cannot fork empty session: ${reference}`);
		}
		migrateToCurrentVersion(sourceEntries);
		validateCurrentSessionEntries(sourceEntries, reference, {
			phase: "fork",
			locations: getJsonlEntryLocations(sourceEntries),
		});
		const sourceHeader = sourceEntries[0];
		if (sourceHeader?.type !== "session") {
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
		const expectedReference = prepareSessionReference(dir, newHeader.id, newHeader.timestamp);
		const newSessionReference = this.claimFirstPublication(
			expectedReference,
			[newHeader, ...sourceEntries],
			() => forkJsonlSession(dir, newHeader, sourceEntries),
			{ allowExistingEmptyFile: false, phase: "fork" },
		);

		return new LocalSession(this.cwd, dir, newSessionReference, this, undefined, this.firstPublicationCoordinator);
	}

	private publishFirstSnapshot(
		filePath: string,
		entries: FileEntry[],
		operation: () => void,
		options: { allowExistingEmptyFile: boolean; phase: "create" | "fork" | "import" },
	): void {
		this.claimFirstPublication(filePath, entries, operation, options);
	}

	private claimFirstPublication<T>(
		filePath: string,
		entries: FileEntry[],
		operation: () => T,
		options: { allowExistingEmptyFile: boolean; phase: "create" | "fork" | "import" } = {
			allowExistingEmptyFile: false,
			phase: "create",
		},
	): T {
		const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
		if (!header) throw new Error(`Cannot publish session without a header: ${filePath}`);
		const key = `${this.canonicalCwd(header.cwd)}\0${header.id}`;
		if (this.activePublicationDestinations.has(key)) {
			throw new SessionAlreadyExistsError(filePath, header.id, options.phase);
		}
		this.activePublicationDestinations.add(key);
		try {
			this.rejectExistingSession(filePath, header, options);
			return operation();
		} finally {
			this.activePublicationDestinations.delete(key);
		}
	}

	private rejectExistingSession(
		filePath: string,
		header: SessionHeader,
		options: { allowExistingEmptyFile: boolean; phase: "create" | "fork" | "import" },
	): void {
		const resolvedTarget = resolve(filePath);
		for (const name of readdirSync(dirname(resolvedTarget))) {
			if (!name.endsWith(".jsonl")) continue;
			const candidate = resolve(dirname(resolvedTarget), name);
			if (candidate === resolvedTarget) {
				if (options.allowExistingEmptyFile && lstatSync(candidate).isFile() && lstatSync(candidate).size === 0) {
					continue;
				}
				throw new SessionAlreadyExistsError(candidate, header.id, options.phase);
			}
			try {
				const existing = readSessionHeader(candidate);
				if (
					existing?.id === header.id &&
					typeof existing.cwd === "string" &&
					this.canonicalCwd(existing.cwd) === this.canonicalCwd(header.cwd)
				) {
					throw new SessionAlreadyExistsError(candidate, header.id, options.phase);
				}
			} catch (error) {
				if (error instanceof SessionAlreadyExistsError) throw error;
				if (error instanceof SessionHeaderScanLimitError) continue;
				throw error;
			}
		}
	}

	private canonicalCwd(cwd: string): string {
		const canonical = resolve(cwd);
		return process.platform === "win32"
			? canonical.replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`)
			: canonical;
	}

	forkSession(source: Session, targetLeafId: string | null): LocalSession {
		const parentSession = source.getSessionReference();
		if (!targetLeafId) {
			const session = this.create();
			session.newSession({ parentSession });
			return session;
		}

		const branchSource = parentSession && existsSync(parentSession) ? this.openReference(parentSession) : source;
		const target = this.create({ parentSession });
		target.copyBranchFrom(branchSource, targetLeafId, parentSession);
		return target;
	}

	importJsonl(inputPath: string, options?: OpenSessionOptions): LocalSession {
		const resolvedPath = resolve(inputPath);
		if (!existsSync(resolvedPath)) throw new Error(`File not found: ${resolvedPath}`);

		const entries = loadEntriesFromFile(resolvedPath, { repair: false, phase: "import" });
		if (entries.length === 0) {
			throw createJsonlSessionDecodeError(
				resolvedPath,
				"import",
				"schema",
				`Cannot import empty session JSONL: ${resolvedPath}`,
			);
		}
		migrateToCurrentVersion(entries);
		validateCurrentSessionEntries(entries, resolvedPath, {
			phase: "import",
			locations: getJsonlEntryLocations(entries),
		});

		const dir = this.sessionDir ?? getDefaultSessionDir(this.cwd);
		ensureDir(dir);
		const destinationPath = join(dir, basename(resolvedPath));
		if (resolve(destinationPath) === resolvedPath) return this.openReference(resolvedPath, options);

		const header = entries[0];
		if (header?.type !== "session") throw new Error(`Cannot import session without a header: ${resolvedPath}`);
		this.claimFirstPublication(
			destinationPath,
			entries,
			() => publishJsonlAtomically(destinationPath, entries, { phase: "import" }),
			{ allowExistingEmptyFile: false, phase: "import" },
		);
		return this.openReference(destinationPath, options);
	}

	async list(onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		const dir = this.sessionDir ?? getDefaultSessionDir(this.cwd);
		const filterCwd = this.sessionDir !== undefined && dir !== getDefaultSessionDirPath(this.cwd);
		const resolvedCwd = resolve(this.cwd);
		const sessions = (await listJsonlSessions(dir, onProgress)).filter(
			(session) => !filterCwd || (session.cwd !== undefined && resolve(session.cwd) === resolvedCwd),
		);
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}

	async listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		const sessions = this.sessionDir
			? await listJsonlSessions(this.sessionDir, onProgress)
			: await listAllJsonlSessions(getSessionsRoot(), onProgress);
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}
}
