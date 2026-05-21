import { Session } from "./session.ts";
import { JsonlSessionStore } from "./stores/jsonl-session-store.ts";

export class LocalSession extends Session {
	constructor(cwd: string, sessionDir: string, sessionReference: string | undefined) {
		super(cwd, sessionDir, sessionReference, new JsonlSessionStore());
	}
}
