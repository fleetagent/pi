import type { ImageContent, Message, TextContent } from "@fleetagent/pi-ai";
import type { BashExecutionMessage, CustomMessage } from "../messages.ts";
import { CURRENT_SESSION_VERSION } from "./constants.ts";
import { buildSessionContext } from "./context.ts";
import { createSessionId, generateId } from "./ids.ts";
import { migrateToCurrentVersion } from "./migrations.ts";
import type { SessionStore } from "./stores/session-store.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	CustomMessageEntry,
	LabelEntry,
	ModelChangeEntry,
	NewSessionOptions,
	SessionContext,
	SessionEntry,
	SessionHeader,
	SessionInfoEntry,
	SessionMessageEntry,
	SessionTreeNode,
	ThinkingLevelChangeEntry,
} from "./types.ts";

export { CURRENT_SESSION_VERSION } from "./constants.ts";
export { buildSessionContext, getLatestCompactionEntry } from "./context.ts";
export { migrateSessionEntries, parseSessionEntries } from "./migrations.ts";

export type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	CustomMessageEntry,
	FileEntry,
	LabelEntry,
	ModelChangeEntry,
	NewSessionOptions,
	SessionContext,
	SessionEntry,
	SessionEntryBase,
	SessionHeader,
	SessionInfo,
	SessionInfoEntry,
	SessionListProgress,
	SessionMessageEntry,
	SessionTreeNode,
	ThinkingLevelChangeEntry,
} from "./types.ts";

export type ReadonlySessionManager = Pick<
	Session,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionReference"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "getHeader"
	| "getEntries"
	| "getTree"
	| "getSessionName"
>;

export { findMostRecentSession, getDefaultSessionDir, loadEntriesFromFile } from "./jsonl-helpers.ts";

/**
 * Manages conversation sessions as append-only trees stored in JSONL files.
 *
 * Each session entry has an id and parentId forming a tree structure. The "leaf"
 * pointer tracks the current position. Appending creates a child of the current leaf.
 * Branching moves the leaf to an earlier entry, allowing new branches without
 * modifying history.
 *
 * Use buildSessionContext() to get the resolved message list for the LLM, which
 * handles compaction summaries and follows the path from root to current leaf.
 */
export abstract class Session {
	private sessionId: string = "";
	private sessionDir: string;
	private cwd: string;
	private store: SessionStore;

	protected constructor(cwd: string, sessionDir: string, sessionReference: string | undefined, store: SessionStore) {
		this.cwd = cwd;
		this.sessionDir = sessionDir;
		this.store = store;
		if (sessionDir) {
			this.store.ensureDir(sessionDir);
		}

		if (sessionReference) {
			this.setSessionReference(sessionReference);
		} else {
			this.newSession();
		}
	}

	/** Switch to a different session reference (used for resume and branching). */
	setSessionReference(sessionReference: string): void {
		const opened = this.store.openSession(sessionReference);
		if (opened.exists) {
			this.store.setEntries(opened.entries);

			// If the opened session has no valid header, start fresh to avoid
			// appending messages without a session header.
			if (this.store.getFileEntries().length === 0) {
				this.newSession();
				this.store.setSessionReference(opened.reference);
				this.store.saveSnapshot();
				return;
			}

			const header = this.store.getHeader();
			this.sessionId = header?.id ?? createSessionId();

			if (migrateToCurrentVersion(this.store.getFileEntries())) {
				this.store.setEntries(this.store.getFileEntries());
				this.store.saveSnapshot();
			}
		} else {
			this.newSession();
			this.store.setSessionReference(opened.reference); // preserve explicit path from --session flag
		}
	}

	newSession(options?: NewSessionOptions): string | undefined {
		this.sessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: options?.parentSession,
		};
		this.store.setEntries([header]);
		return this.store.prepareSessionReference(this.getSessionDir(), this.sessionId, timestamp);
	}

	isPersisted(): boolean {
		return this.store.isPersisted();
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionReference(): string | undefined {
		return this.store.getSessionReference();
	}

	private _appendEntry(entry: SessionEntry): void {
		this.store.appendEntry(entry);
	}

	/** Append a message as child of current leaf, then advance leaf. Returns entry id.
	 * Does not allow writing CompactionSummaryMessage and BranchSummaryMessage directly.
	 * Reason: we want these to be top-level entries in the session, not message session entries,
	 * so it is easier to find them.
	 * These need to be appended via appendCompaction() and appendBranchSummary() methods.
	 */
	appendMessage(message: Message | CustomMessage | BashExecutionMessage): string {
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.store),
			parentId: this.store.getLeafId(),
			timestamp: new Date().toISOString(),
			message,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
	appendThinkingLevelChange(thinkingLevel: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: generateId(this.store),
			parentId: this.store.getLeafId(),
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a model change as child of current leaf, then advance leaf. Returns entry id. */
	appendModelChange(provider: string, modelId: string): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: generateId(this.store),
			parentId: this.store.getLeafId(),
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a compaction summary as child of current leaf, then advance leaf. Returns entry id. */
	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
	): string {
		const entry: CompactionEntry<T> = {
			type: "compaction",
			id: generateId(this.store),
			parentId: this.store.getLeafId(),
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromHook,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a custom entry (for extensions) as child of current leaf, then advance leaf. Returns entry id. */
	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = {
			type: "custom",
			customType,
			data,
			id: generateId(this.store),
			parentId: this.store.getLeafId(),
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Append a session info entry (e.g., display name). Returns entry id. */
	appendSessionInfo(name: string): string {
		const entry: SessionInfoEntry = {
			type: "session_info",
			id: generateId(this.store),
			parentId: this.store.getLeafId(),
			timestamp: new Date().toISOString(),
			name: name.trim(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** Get the current session name from the latest session_info entry, if any. */
	getSessionName(): string | undefined {
		return this.store.getSessionName();
	}

	/**
	 * Append a custom message entry (for extensions) that participates in LLM context.
	 * @param customType Extension identifier for filtering on reload
	 * @param content Message content (string or TextContent/ImageContent array)
	 * @param display Whether to show in TUI (true = styled display, false = hidden)
	 * @param details Optional extension-specific metadata (not sent to LLM)
	 * @returns Entry id
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): string {
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			details,
			id: generateId(this.store),
			parentId: this.store.getLeafId(),
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	// =========================================================================
	// Tree Traversal
	// =========================================================================

	getLeafId(): string | null {
		return this.store.getLeafId();
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.store.getLeafEntry();
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.store.getEntry(id);
	}

	/**
	 * Get all direct children of an entry.
	 */
	getChildren(parentId: string): SessionEntry[] {
		return this.store.getChildren(parentId);
	}

	/**
	 * Get the label for an entry, if any.
	 */
	getLabel(id: string): string | undefined {
		return this.store.getLabel(id);
	}

	/**
	 * Set or clear a label on an entry.
	 * Labels are user-defined markers for bookmarking/navigation.
	 * Pass undefined or empty string to clear the label.
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.store.has(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry: LabelEntry = {
			type: "label",
			id: generateId(this.store),
			parentId: this.store.getLeafId(),
			timestamp: new Date().toISOString(),
			targetId,
			label,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/**
	 * Walk from entry to root, returning all entries in path order.
	 * Includes all entry types (messages, compaction, model changes, etc.).
	 * Use buildSessionContext() to get the resolved messages for the LLM.
	 */
	getBranch(fromId?: string): SessionEntry[] {
		return this.store.getBranch(fromId);
	}

	/**
	 * Build the session context (what gets sent to the LLM).
	 * Uses tree traversal from current leaf.
	 */
	buildSessionContext(): SessionContext {
		return buildSessionContext(this.getEntries(), this.store.getLeafId(), this.store.getEntryIndex());
	}

	/**
	 * Get session header.
	 */
	getHeader(): SessionHeader | null {
		return this.store.getHeader();
	}

	/**
	 * Get all session entries (excludes header). Returns a shallow copy.
	 * The session is append-only: use appendXXX() to add entries, branch() to
	 * change the leaf pointer. Entries cannot be modified or deleted.
	 */
	getEntries(): SessionEntry[] {
		return this.store.getEntries();
	}

	/**
	 * Get the session as a tree structure. Returns a shallow defensive copy of all entries.
	 * A well-formed session has exactly one root (first entry with parentId === null).
	 * Orphaned entries (broken parent chain) are also returned as roots.
	 */
	getTree(): SessionTreeNode[] {
		return this.store.getTree();
	}

	// =========================================================================
	// Branching
	// =========================================================================

	/**
	 * Start a new branch from an earlier entry.
	 * Moves the leaf pointer to the specified entry. The next appendXXX() call
	 * will create a child of that entry, forming a new branch. Existing entries
	 * are not modified or deleted.
	 */
	branch(branchFromId: string): void {
		if (!this.store.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.store.setLeafId(branchFromId);
	}

	/**
	 * Reset the leaf pointer to null (before any entries).
	 * The next appendXXX() call will create a new root entry (parentId = null).
	 * Use this when navigating to re-edit the first user message.
	 */
	resetLeaf(): void {
		this.store.setLeafId(null);
	}

	/**
	 * Start a new branch with a summary of the abandoned path.
	 * Same as branch(), but also appends a branch_summary entry that captures
	 * context from the abandoned conversation path.
	 */
	branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromHook?: boolean): string {
		if (branchFromId !== null && !this.store.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.store.setLeafId(branchFromId);
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.store),
			parentId: branchFromId,
			timestamp: new Date().toISOString(),
			fromId: branchFromId ?? "root",
			summary,
			details,
			fromHook,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/**
	 * Create a new session reference containing only the path from root to the specified leaf.
	 * Useful for extracting a single conversation path from a branched session.
	 * Returns the new session reference, or undefined if the store does not expose one.
	 */
	createBranchedSession(leafId: string): string | undefined {
		const parentSession = this.store.getParentSessionReference();
		const path = this.getBranch(leafId);
		if (path.length === 0) {
			throw new Error(`Entry ${leafId} not found`);
		}

		// Filter out LabelEntry from path - we'll recreate them from the resolved map
		const pathWithoutLabels = path.filter((e) => e.type !== "label");

		const newSessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const newSessionReference = this.store.prepareSessionReference(this.getSessionDir(), newSessionId, timestamp);

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.cwd,
			parentSession,
		};

		// Collect labels for entries in the path
		const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
		const labelsToWrite = this.store.getLabelsForEntryIds(pathEntryIds);

		const labelEntries: LabelEntry[] = [];
		let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
		for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...pathEntryIds, ...labelEntries.map((e) => e.id)])),
				parentId,
				timestamp: labelTimestamp,
				targetId,
				label,
			};
			pathEntryIds.add(labelEntry.id);
			labelEntries.push(labelEntry);
			parentId = labelEntry.id;
		}
		this.store.setEntries([header, ...pathWithoutLabels, ...labelEntries]);
		this.sessionId = newSessionId;
		this.store.commitSnapshot();
		return newSessionReference;
	}
}
