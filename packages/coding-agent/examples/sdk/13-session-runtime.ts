#!/usr/bin/env tsx
/**
 * Session replacement
 *
 * Use PiAgent when you need to replace the active AgentSession, for example
 * for new-session, resume, fork, or import flows.
 *
 * The important pattern is: after PiAgent replaces the active session, rebind
 * any session-local subscriptions and extension bindings to `pi.session`.
 */

import { LocalSessionManager, PiAgent } from "@earendil-works/pi-coding-agent";

const pi = await PiAgent.create({
	cwd: process.cwd(),
	sessionManager: new LocalSessionManager({ cwd: process.cwd() }),
});

let unsubscribe: (() => void) | undefined;

async function bindSession() {
	unsubscribe?.();
	const session = pi.session;
	await session.bindExtensions({});
	unsubscribe = session.subscribe((event) => {
		if (event.type === "queue_update") {
			console.log("Queued:", event.steering.length + event.followUp.length);
		}
	});
	return session;
}

await pi.createAgentSession();
let session = await bindSession();
const originalSessionFile = session.sessionFile;
console.log("Initial session:", originalSessionFile);

await pi.newSession();
session = await bindSession();
console.log("After newSession():", session.sessionFile);

if (originalSessionFile) {
	await pi.switchSession(originalSessionFile);
	session = await bindSession();
	console.log("After switchSession():", session.sessionFile);
}

unsubscribe?.();
await pi.dispose();
