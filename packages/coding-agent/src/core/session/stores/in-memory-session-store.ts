import type {
	FileEntry,
	LabelEntry,
	SessionEntry,
	SessionHeader,
	SessionInfo,
	SessionListProgress,
	SessionTreeNode,
} from "../types.ts";
import type { SessionOpenResult, SessionStore } from "./session-store.ts";

export class InMemorySessionStore implements SessionStore {
	protected fileEntries: FileEntry[] = [];
	protected byId: Map<string, SessionEntry> = new Map();
	protected labelsById: Map<string, string> = new Map();
	protected labelTimestampsById: Map<string, string> = new Map();
	protected leafId: string | null = null;

	isPersisted(): boolean {
		return false;
	}

	getSessionReference(): string | undefined {
		return undefined;
	}

	setSessionReference(_reference: string): void {
		// No-op for in-memory sessions.
	}

	openSession(reference: string): SessionOpenResult {
		return { reference, exists: false, entries: [] };
	}

	getSessionDirForReference(_reference: string): string {
		return "";
	}

	getDefaultSessionDir(_cwd: string, _agentDir?: string): string {
		return "";
	}

	getSessionsRoot(): string {
		return "";
	}

	prepareSessionReference(_sessionDir: string, _sessionId: string, _timestamp: string): string | undefined {
		return undefined;
	}

	getParentSessionReference(): string | undefined {
		return undefined;
	}

	exists(_path: string): boolean {
		return false;
	}

	ensureDir(_path: string): void {
		// No-op for in-memory sessions.
	}

	load(_filePath: string): FileEntry[] {
		return [];
	}

	findMostRecent(_sessionDir: string): string | null {
		return null;
	}

	async list(_dir: string, _onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		return [];
	}

	async listAll(_sessionsDir: string, _onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		return [];
	}

	setEntries(entries: FileEntry[]): void {
		this.fileEntries = entries;
		this.rebuildIndex();
	}

	getFileEntries(): FileEntry[] {
		return this.fileEntries;
	}

	getHeader(): SessionHeader | null {
		const header = this.fileEntries.find((entry) => entry.type === "session");
		return header ? (header as SessionHeader) : null;
	}

	getEntries(): SessionEntry[] {
		return this.fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
	}

	getEntryIndex(): Map<string, SessionEntry> {
		return this.byId;
	}

	has(id: string): boolean {
		return this.byId.has(id);
	}

	appendEntry(entry: SessionEntry): void {
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		this.applyLabelEntry(entry);
	}

	saveSnapshot(): void {
		// No-op for in-memory sessions.
	}

	commitSnapshot(): void {
		// No-op for in-memory sessions.
	}

	getLeafId(): string | null {
		return this.leafId;
	}

	setLeafId(leafId: string | null): void {
		this.leafId = leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	getChildren(parentId: string): SessionEntry[] {
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId) {
				children.push(entry);
			}
		}
		return children;
	}

	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}

	getBranch(fromId?: string): SessionEntry[] {
		const path: SessionEntry[] = [];
		const startId = fromId ?? this.leafId;
		let current = startId ? this.byId.get(startId) : undefined;
		while (current) {
			path.unshift(current);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		return path;
	}

	getTree(): SessionTreeNode[] {
		const entries = this.getEntries();
		const nodeMap = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		for (const entry of entries) {
			const label = this.labelsById.get(entry.id);
			const labelTimestamp = this.labelTimestampsById.get(entry.id);
			nodeMap.set(entry.id, { entry, children: [], label, labelTimestamp });
		}

		for (const entry of entries) {
			const node = nodeMap.get(entry.id)!;
			if (entry.parentId === null || entry.parentId === entry.id) {
				roots.push(node);
			} else {
				const parent = nodeMap.get(entry.parentId);
				if (parent) {
					parent.children.push(node);
				} else {
					roots.push(node);
				}
			}
		}

		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
			stack.push(...node.children);
		}

		return roots;
	}

	getSessionName(): string | undefined {
		const entries = this.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "session_info") {
				return entry.name?.trim() || undefined;
			}
		}
		return undefined;
	}

	getLabelsForEntryIds(entryIds: Set<string>): Array<{ targetId: string; label: string; timestamp: string }> {
		const labels: Array<{ targetId: string; label: string; timestamp: string }> = [];
		for (const [targetId, label] of this.labelsById) {
			if (entryIds.has(targetId)) {
				labels.push({ targetId, label, timestamp: this.labelTimestampsById.get(targetId)! });
			}
		}
		return labels;
	}

	hasAssistantMessage(): boolean {
		return this.fileEntries.some((entry) => entry.type === "message" && entry.message.role === "assistant");
	}

	private rebuildIndex(): void {
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;
			this.byId.set(entry.id, entry);
			this.leafId = entry.id;
			this.applyLabelEntry(entry);
		}
	}

	private applyLabelEntry(entry: SessionEntry): void {
		if (entry.type !== "label") return;
		const labelEntry = entry as LabelEntry;
		if (labelEntry.label) {
			this.labelsById.set(labelEntry.targetId, labelEntry.label);
			this.labelTimestampsById.set(labelEntry.targetId, labelEntry.timestamp);
		} else {
			this.labelsById.delete(labelEntry.targetId);
			this.labelTimestampsById.delete(labelEntry.targetId);
		}
	}
}
