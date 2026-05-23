import type { FileEntry, SessionEntry, SessionHeader, SessionTreeNode } from "../types.ts";

export interface SessionStore {
	isPersisted(): boolean;
	getSessionReference(): string | undefined;
	setSessionReference(reference: string): void;
	exists(path: string): boolean;
	ensureDir(path: string): void;
	load(filePath: string): FileEntry[];
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
