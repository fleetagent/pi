import type { RemoteSessionClient, RemoteSessionSnapshot } from "../remote-session-client.ts";
import { formatRemoteSessionReference, parseRemoteSessionId } from "../remote-session-client.ts";
import type { FileEntry, SessionEntry } from "../types.ts";
import { InMemorySessionStore } from "./in-memory-session-store.ts";

export interface RemoteSessionStoreOptions {
	client: RemoteSessionClient;
	reference?: string;
	snapshot?: RemoteSessionSnapshot;
}

function getSnapshotReference(snapshot: RemoteSessionSnapshot): string {
	return snapshot.reference || formatRemoteSessionReference(snapshot.id);
}

/**
 * Remote session store.
 *
 * The active session state is kept in memory for synchronous Session access.
 * Mutations are serialized to the remote service in the background, and
 * snapshots fetched by RemoteSessionManager are used to hydrate the store before
 * Session starts reading from it.
 */
export class RemoteSessionStore extends InMemorySessionStore {
	private readonly client: RemoteSessionClient;
	private reference: string | undefined;
	private etag: string | undefined;
	private pendingSync: Promise<void> = Promise.resolve();
	private dirtyEntries: FileEntry[] = [];
	private lastSyncError: unknown;
	private snapshot: RemoteSessionSnapshot | undefined;

	constructor(options: RemoteSessionStoreOptions) {
		super();
		this.client = options.client;
		this.snapshot = options.snapshot;
		this.reference = options.reference ?? (options.snapshot ? getSnapshotReference(options.snapshot) : undefined);
		this.etag = options.snapshot?.etag;
	}

	override isPersisted(): boolean {
		return true;
	}

	override getSessionReference(): string | undefined {
		return this.reference;
	}

	override setSessionReference(reference: string): void {
		this.reference = formatRemoteSessionReference(parseRemoteSessionId(reference));
	}

	override exists(reference: string): boolean {
		if (!this.snapshot) return false;
		const snapshotReference = getSnapshotReference(this.snapshot);
		return parseRemoteSessionId(reference) === parseRemoteSessionId(snapshotReference);
	}

	override load(reference: string): FileEntry[] {
		if (!this.snapshot || !this.exists(reference)) return [];
		this.reference = getSnapshotReference(this.snapshot);
		this.etag = this.snapshot.etag;
		const entries = [...this.snapshot.entries];
		this.snapshot = undefined;
		return entries;
	}

	override appendEntry(entry: SessionEntry): void {
		super.appendEntry(entry);
		this.queueAppend([entry]);
	}

	override saveSnapshot(): void {
		this.queueReplaceSnapshot();
	}

	override commitSnapshot(): void {
		this.queueReplaceSnapshot();
	}

	async flushPendingSync(): Promise<void> {
		while (true) {
			const pending = this.pendingSync;
			await pending;
			if (this.lastSyncError) {
				throw this.lastSyncError;
			}
			if (pending !== this.pendingSync) continue;
			if (this.dirtyEntries.length > 0) {
				const error = new Error(`Remote session synchronization left ${this.dirtyEntries.length} unsaved entries`);
				this.lastSyncError = error;
				throw error;
			}
			return;
		}
	}

	getLastSyncError(): unknown {
		return this.lastSyncError;
	}

	private queueAppend(entries: FileEntry[]): void {
		this.dirtyEntries.push(...entries);
		this.pendingSync = this.pendingSync
			.then(() => this.flushDirtyEntries())
			.catch((error: unknown) => {
				this.lastSyncError = error;
			});
	}

	private queueReplaceSnapshot(): void {
		this.pendingSync = this.pendingSync
			.then(() => this.replaceSnapshot())
			.catch((error: unknown) => {
				this.lastSyncError = error;
			});
	}

	private async flushDirtyEntries(): Promise<void> {
		if (this.dirtyEntries.length === 0) return;
		if (!this.reference) {
			throw new Error("Cannot synchronize remote session entries without a session reference");
		}

		while (this.dirtyEntries.length > 0) {
			const entries = [...this.dirtyEntries];
			const response = await this.client.appendEntries(this.reference, {
				baseEtag: this.etag,
				entries,
			});
			if (!Number.isInteger(response.accepted) || response.accepted <= 0 || response.accepted > entries.length) {
				throw new Error(
					`Remote session append accepted ${response.accepted} of ${entries.length} entries without valid progress`,
				);
			}
			this.etag = response.etag ?? this.etag;
			this.dirtyEntries = this.dirtyEntries.slice(response.accepted);
			if (this.dirtyEntries.length > 0 && !response.etag) {
				throw new Error("Remote session append partially accepted entries without returning an updated ETag");
			}
		}
		this.lastSyncError = undefined;
	}

	private async replaceSnapshot(): Promise<void> {
		if (!this.reference) return;

		const entries = this.getFileEntries();
		const dirtyEntryCount = this.dirtyEntries.length;
		const response = await this.client.replaceSnapshot(this.reference, {
			baseEtag: this.etag,
			entries,
		});
		this.etag = response.etag ?? this.etag;
		this.dirtyEntries = this.dirtyEntries.slice(dirtyEntryCount);
		this.lastSyncError = undefined;
	}
}
