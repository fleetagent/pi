/**
 * Session Management
 *
 * Control session persistence: in-memory, new file, continue, or open specific.
 */

import { InMemorySessionManager, LocalSessionManager, PiAgent } from "@fleetagent/pi-coding-agent";

const cwd = process.cwd();

// In-memory (no persistence)
const inMemoryPi = await PiAgent.create({ sessionManager: new InMemorySessionManager(cwd) });
const inMemory = await inMemoryPi.createAgentSession();
console.log("In-memory session:", inMemory.sessionReference ?? "(none)");
await inMemoryPi.dispose();

// New persistent session
const newSessionManager = new LocalSessionManager({ cwd });
const newSessionPi = await PiAgent.create({ cwd, sessionManager: newSessionManager });
const newSession = await newSessionPi.createAgentSession();
console.log("New session reference:", newSession.sessionReference);
await newSessionPi.dispose();

// Continue most recent session (or create new if none)
const continuedSessionManager = new LocalSessionManager({ cwd });
const continuedPi = await PiAgent.create({ cwd, sessionManager: continuedSessionManager });
const continued = await continuedPi.createAgentSession({ session: continuedSessionManager.continueRecent() });
if (continuedPi.modelFallbackMessage) console.log("Note:", continuedPi.modelFallbackMessage);
console.log("Continued session:", continued.sessionReference);
await continuedPi.dispose();

// List and open specific session
const sessions = await new LocalSessionManager({ cwd }).list();
console.log(`\nFound ${sessions.length} sessions:`);
for (const info of sessions.slice(0, 3)) {
	console.log(`  ${info.id.slice(0, 8)}... - "${info.firstMessage.slice(0, 30)}..."`);
}

const sessionReference = sessions[0]?.reference;
if (sessionReference) {
	const openSessionManager = new LocalSessionManager({ cwd });
	const openedPi = await PiAgent.create({ cwd, sessionManager: openSessionManager });
	const opened = await openedPi.createAgentSession({ session: openSessionManager.openReference(sessionReference) });
	console.log(`\nOpened: ${opened.sessionId}`);
	await openedPi.dispose();
}

// Custom session directory (no cwd encoding)
// const customDir = "/path/to/my-sessions";
// const localSessions = new LocalSessionManager({ cwd, sessionDir: customDir });
// const pi = await PiAgent.create({ cwd, sessionManager: localSessions });
// const session = await pi.createAgentSession();
// await localSessions.list();
// localSessions.continueRecent();
