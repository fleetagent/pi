import type {
	FileSystem,
	JsonlSessionCreateOptions,
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	JsonlSessionRepoApi,
	Session,
	SessionForkOptions,
	SessionTreeEntry,
} from "../types.ts";
import { SessionError, toError } from "../types.ts";
import { JsonlDecodeError, JsonlSessionError } from "./jsonl-errors.ts";
import {
	type JsonlSessionCreationPhase,
	type JsonlSessionLoadPhase,
	JsonlSessionStorage,
	loadJsonlSessionMetadata,
} from "./jsonl-storage.ts";
import {
	createSessionId,
	createTimestamp,
	getEntriesToFork,
	getFileSystemResultOrThrow,
	toSession,
} from "./repo-utils.ts";

type JsonlSessionRepoFileSystem = Pick<
	FileSystem,
	| "cwd"
	| "absolutePath"
	| "joinPath"
	| "readBinaryFile"
	| "readTextLines"
	| "writeFile"
	| "appendFile"
	| "renameFile"
	| "fileInfo"
	| "listDir"
	| "exists"
	| "createDir"
	| "remove"
>;

/** Options for constructing a JSONL-backed session repository. */
export interface JsonlSessionRepoOptions {
	fs: JsonlSessionRepoFileSystem;
	sessionsRoot: string;
}

interface JsonlSessionCreateDestination {
	id: string;
	cwd: string;
}

function canonicalClaimCwd(cwd: string): string {
	if (!/^[A-Za-z]:[/\\]/.test(cwd)) return cwd;
	return `${cwd[0]!.toLowerCase()}:${cwd.slice(2).replaceAll("\\", "/")}`;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function validateSessionId(id: string): void {
	if (!SESSION_ID_PATTERN.test(id)) {
		throw new SessionError(
			"invalid_session",
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}

function encodeCwd(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export class JsonlSessionRepo implements JsonlSessionRepoApi {
	private readonly fs: JsonlSessionRepoFileSystem;
	private readonly sessionsRootInput: string;
	private readonly activeCreateDestinations = new Set<string>();
	private sessionsRoot: string | undefined;

	constructor(options: JsonlSessionRepoOptions) {
		this.fs = options.fs;
		this.sessionsRootInput = options.sessionsRoot;
	}

	private async getSessionsRoot(): Promise<string> {
		if (!this.sessionsRoot) {
			this.sessionsRoot = getFileSystemResultOrThrow(
				await this.fs.absolutePath(this.sessionsRootInput),
				`Failed to resolve sessions root ${this.sessionsRootInput}`,
			);
		}
		return this.sessionsRoot;
	}

	private async getSessionDir(cwd: string): Promise<string> {
		return getFileSystemResultOrThrow(
			await this.fs.joinPath([await this.getSessionsRoot(), encodeCwd(cwd)]),
			`Failed to resolve session directory for ${cwd}`,
		);
	}

	private async createSessionFilePath(cwd: string, sessionId: string, timestamp: string): Promise<string> {
		return getFileSystemResultOrThrow(
			await this.fs.joinPath([
				await this.getSessionDir(cwd),
				`${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
			]),
			`Failed to resolve session file path for ${sessionId}`,
		);
	}

	async create(options: JsonlSessionCreateOptions): Promise<Session<JsonlSessionMetadata>> {
		const destination = await this.resolveCreateDestination(options);
		return this.claimCreateDestination(destination, "create", async () => {
			const createdAt = createTimestamp();
			const sessionDir = await this.getSessionDir(destination.cwd);
			getFileSystemResultOrThrow(
				await this.fs.createDir(sessionDir, { recursive: true }),
				`Failed to create session directory ${sessionDir}`,
			);
			await this.rejectExistingSessionId(destination);
			const filePath = await this.createSessionFilePath(destination.cwd, destination.id, createdAt);
			const storage = await JsonlSessionStorage.create(this.fs, filePath, {
				cwd: destination.cwd,
				sessionId: destination.id,
				parentSessionPath: options.parentSessionPath,
			});
			return toSession(storage);
		});
	}

	async open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
		return this.openWithPhase(metadata, "open");
	}

	private async openWithPhase(
		metadata: JsonlSessionMetadata,
		phase: JsonlSessionLoadPhase,
	): Promise<Session<JsonlSessionMetadata>> {
		if (
			!getFileSystemResultOrThrow(await this.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)
		) {
			throw new SessionError("not_found", `Session not found: ${metadata.path}`);
		}
		const storage = await JsonlSessionStorage.open(this.fs, metadata.path, phase);
		const loadedMetadata = await storage.getMetadata();
		if (loadedMetadata.id !== metadata.id) {
			const cause = new JsonlDecodeError(
				"state",
				`metadata id ${metadata.id} does not match file header ${loadedMetadata.id}`,
			);
			throw new JsonlSessionError({
				code: "invalid_session",
				reference: metadata.path,
				phase,
				line: 1,
				byteOffset: 0,
				decodeKind: cause.decodeKind,
				message: `Session metadata id ${metadata.id} does not match file header ${loadedMetadata.id}`,
				cause,
			});
		}
		return toSession(storage);
	}

	async list(options: JsonlSessionListOptions = {}): Promise<JsonlSessionMetadata[]> {
		const cwd = options.cwd
			? getFileSystemResultOrThrow(
					await this.fs.absolutePath(options.cwd),
					`Failed to resolve session cwd ${options.cwd}`,
				)
			: undefined;
		const dirs = cwd ? [await this.getSessionDir(cwd)] : await this.listSessionDirs();
		const sessions: JsonlSessionMetadata[] = [];
		for (const dir of dirs) sessions.push(...(await this.listSessionsInDir(dir, cwd)));
		sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
		return sessions;
	}

	private async listSessionsInDir(dir: string, cwd: string | undefined): Promise<JsonlSessionMetadata[]> {
		if (!getFileSystemResultOrThrow(await this.fs.exists(dir), `Failed to check session directory ${dir}`)) {
			return [];
		}
		const files = getFileSystemResultOrThrow(await this.fs.listDir(dir), `Failed to list sessions in ${dir}`).filter(
			(file) => file.kind !== "directory" && file.name.endsWith(".jsonl"),
		);
		const sessions: JsonlSessionMetadata[] = [];
		for (const file of files) {
			const metadata = await this.loadListableSessionMetadata(file.path);
			if (metadata && (!cwd || canonicalClaimCwd(metadata.cwd) === canonicalClaimCwd(cwd))) sessions.push(metadata);
		}
		return sessions;
	}

	private async loadListableSessionMetadata(path: string): Promise<JsonlSessionMetadata | undefined> {
		try {
			return await loadJsonlSessionMetadata(this.fs, path);
		} catch (error) {
			const cause = toError(error);
			if (!(cause instanceof SessionError) || cause.code !== "invalid_session") throw cause;
			return undefined;
		}
	}

	async delete(metadata: JsonlSessionMetadata): Promise<void> {
		getFileSystemResultOrThrow(
			await this.fs.remove(metadata.path, { force: true }),
			`Failed to delete session ${metadata.path}`,
		);
	}

	async fork(
		sourceMetadata: JsonlSessionMetadata,
		options: JsonlSessionCreateOptions & SessionForkOptions,
	): Promise<Session<JsonlSessionMetadata>> {
		const source = await this.openWithPhase(sourceMetadata, "fork");
		let forkedEntries: SessionTreeEntry[];
		try {
			forkedEntries = await getEntriesToFork(source.getStorage(), options);
		} catch (error) {
			const cause = toError(error);
			throw new JsonlSessionError({
				code: cause instanceof SessionError ? cause.code : "invalid_fork_target",
				reference: sourceMetadata.path,
				phase: "fork",
				message: cause.message,
				cause,
			});
		}
		const destination = await this.resolveCreateDestination(options);
		return this.claimCreateDestination(destination, "fork", async () => {
			const createdAt = createTimestamp();
			const sessionDir = await this.getSessionDir(destination.cwd);
			getFileSystemResultOrThrow(
				await this.fs.createDir(sessionDir, { recursive: true }),
				`Failed to create session directory ${sessionDir}`,
			);
			await this.rejectExistingSessionId(destination, "fork");
			const storage = await JsonlSessionStorage.create(
				this.fs,
				await this.createSessionFilePath(destination.cwd, destination.id, createdAt),
				{
					cwd: destination.cwd,
					sessionId: destination.id,
					parentSessionPath: options.parentSessionPath ?? sourceMetadata.path,
					entries: forkedEntries,
					phase: "fork",
				},
			);
			return toSession(storage);
		});
	}

	private async resolveCreateDestination(options: JsonlSessionCreateOptions): Promise<JsonlSessionCreateDestination> {
		const id = options.id ?? createSessionId();
		validateSessionId(id);
		const cwd = getFileSystemResultOrThrow(
			await this.fs.absolutePath(options.cwd),
			`Failed to resolve session cwd ${options.cwd}`,
		);
		return { id, cwd };
	}

	private async claimCreateDestination<T>(
		destination: JsonlSessionCreateDestination,
		phase: JsonlSessionCreationPhase,
		operation: () => Promise<T>,
	): Promise<T> {
		const key = `${canonicalClaimCwd(destination.cwd)}\0${destination.id}`;
		if (this.activeCreateDestinations.has(key)) {
			throw new JsonlSessionError({
				code: "already_exists",
				reference: `${destination.cwd}#${destination.id}`,
				phase,
				message: `Session already exists: ${destination.id}`,
				outcome: "not_written",
			});
		}
		this.activeCreateDestinations.add(key);
		try {
			return await operation();
		} finally {
			this.activeCreateDestinations.delete(key);
		}
	}

	private async rejectExistingSessionId(
		destination: JsonlSessionCreateDestination,
		phase: JsonlSessionCreationPhase = "create",
	): Promise<void> {
		const existing = (await this.list({ cwd: destination.cwd })).find(
			(session) =>
				session.id === destination.id && canonicalClaimCwd(session.cwd) === canonicalClaimCwd(destination.cwd),
		);
		if (existing) {
			throw new JsonlSessionError({
				code: "already_exists",
				reference: existing.path,
				phase,
				message: `Session already exists: ${destination.id}`,
				outcome: "not_written",
			});
		}
	}

	private async listSessionDirs(): Promise<string[]> {
		const sessionsRoot = await this.getSessionsRoot();
		if (
			!getFileSystemResultOrThrow(
				await this.fs.exists(sessionsRoot),
				`Failed to check sessions root ${sessionsRoot}`,
			)
		) {
			return [];
		}
		const entries = getFileSystemResultOrThrow(
			await this.fs.listDir(sessionsRoot),
			`Failed to list sessions root ${sessionsRoot}`,
		);
		return entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path);
	}
}
