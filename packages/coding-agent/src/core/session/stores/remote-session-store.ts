import { InMemorySessionStore } from "./in-memory-session-store.ts";

export interface RemoteSessionStoreOptions {
	reference?: string;
}

/**
 * Placeholder remote store.
 *
 * Remote sessions will keep an in-memory working set like local sessions, while
 * load/append/flush operations synchronize with a remote session service.
 */
export class RemoteSessionStore extends InMemorySessionStore {
	private sessionReference: string | undefined;

	constructor(options: RemoteSessionStoreOptions = {}) {
		super();
		this.sessionReference = options.reference;
	}

	override isPersisted(): boolean {
		return true;
	}

	override getSessionReference(): string | undefined {
		return this.sessionReference;
	}

	override setSessionReference(reference: string): void {
		this.sessionReference = reference;
	}
}
