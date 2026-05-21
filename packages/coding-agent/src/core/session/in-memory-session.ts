import { Session } from "./session.ts";
import { InMemorySessionStore } from "./stores/in-memory-session-store.ts";

export class InMemorySession extends Session {
	constructor(cwd: string = process.cwd()) {
		super(cwd, "", undefined, new InMemorySessionStore());
	}
}
