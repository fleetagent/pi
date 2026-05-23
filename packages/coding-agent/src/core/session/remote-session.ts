import type { RemoteSessionClient, RemoteSessionSnapshot } from "./remote-session-client.ts";
import { formatRemoteSessionReference } from "./remote-session-client.ts";
import { Session } from "./session.ts";
import type { SessionManager } from "./session-manager.ts";
import { RemoteSessionStore } from "./stores/remote-session-store.ts";
import type { NewSessionOptions } from "./types.ts";

export interface RemoteSessionOptions {
	client: RemoteSessionClient;
	cwd: string;
	reference?: string;
	snapshot?: RemoteSessionSnapshot;
	sessionManager?: SessionManager;
}

export class RemoteSession extends Session {
	private remoteStore: RemoteSessionStore | undefined;

	constructor(options: RemoteSessionOptions) {
		const reference =
			options.reference ??
			options.snapshot?.reference ??
			(options.snapshot ? formatRemoteSessionReference(options.snapshot.id) : undefined);
		const store = new RemoteSessionStore({
			client: options.client,
			reference,
			snapshot: options.snapshot,
		});
		super(options.cwd, "", reference, store, options.sessionManager);
		this.remoteStore = store;
	}

	protected prepareNewSessionReference(
		_sessionDir: string,
		sessionId: string,
		_timestamp: string,
	): string | undefined {
		return this.getSessionReference() ?? formatRemoteSessionReference(sessionId);
	}

	override newSession(options?: NewSessionOptions): string | undefined {
		const reference = super.newSession(options);
		this.remoteStore?.saveSnapshot();
		return reference;
	}

	flushPendingSync(): Promise<void> {
		return this.remoteStore?.flushPendingSync() ?? Promise.resolve();
	}

	getLastSyncError(): unknown {
		return this.remoteStore?.getLastSyncError();
	}
}
