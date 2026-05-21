import { Session } from "./session.ts";
import { RemoteSessionStore } from "./stores/remote-session-store.ts";

export interface RemoteSessionOptions {
	cwd: string;
	reference?: string;
}

export class RemoteSession extends Session {
	constructor(options: RemoteSessionOptions) {
		super(options.cwd, "", options.reference, new RemoteSessionStore({ reference: options.reference }));
	}
}
