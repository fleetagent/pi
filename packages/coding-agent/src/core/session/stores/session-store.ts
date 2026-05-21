import type {
	FileEntry,
	SessionEntry,
	SessionHeader,
	SessionInfo,
	SessionListProgress,
	SessionTreeNode,
} from "../types.ts";

export interface SessionOpenResult {
	reference: string;
	exists: boolean;
	entries: FileEntry[];
}

export interface SessionStore {
	isPersisted(): boolean;
	getSessionReference(): string | undefined;
	setSessionReference(reference: string): void;
	openSession(reference: string): SessionOpenResult;
	getSessionDirForReference(reference: string): string;
	getDefaultSessionDir(cwd: string, agentDir?: string): string;
	getSessionsRoot(): string;
	prepareSessionReference(sessionDir: string, sessionId: string, timestamp: string): string | undefined;
	getParentSessionReference(): string | undefined;
	exists(path: string): boolean;
	ensureDir(path: string): void;
	load(filePath: string): FileEntry[];
	findMostRecent(sessionDir: string): string | null;
	list(dir: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	listAll(sessionsDir: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	setEntries(entries: FileEntry[]): void;
	getFileEntries(): FileEntry[];
	getHeader(): SessionHeader | null;
	getEntries(): SessionEntry[];
	getEntryIndex(): Map<string, SessionEntry>;
	has(id: string): boolean;
	appendEntry(entry: SessionEntry): void;
	saveSnapshot(): void;
	commitSnapshot(): void;
	getLeafId(): string | null;
	setLeafId(leafId: string | null): void;
	getLeafEntry(): SessionEntry | undefined;
	getEntry(id: string): SessionEntry | undefined;
	getChildren(parentId: string): SessionEntry[];
	getLabel(id: string): string | undefined;
	getBranch(fromId?: string): SessionEntry[];
	getTree(): SessionTreeNode[];
	getSessionName(): string | undefined;
	getLabelsForEntryIds(entryIds: Set<string>): Array<{ targetId: string; label: string; timestamp: string }>;
	hasAssistantMessage(): boolean;
}
