/**
 * Custom System Prompt
 *
 * Shows how to replace or modify the default system prompt.
 */

import { DefaultResourceLoader, getAgentDir, InMemorySessionManager, PiAgent } from "@fleetagent/pi-coding-agent";

const cwd = process.cwd();
const agentDir = getAgentDir();

// Option 1: Replace prompt entirely
const loader1 = new DefaultResourceLoader({
	cwd,
	agentDir,
	systemPromptOverride: () => `You are a helpful assistant that speaks like a pirate.
Always end responses with "Arrr!"`,
	// Needed to avoid DefaultResourceLoader appending APPEND_SYSTEM.md from ~/.pi/agent or <cwd>/.pi.
	appendSystemPromptOverride: () => [],
});
await loader1.reload();

const pi1 = await PiAgent.create({
	cwd,
	agentDir,
	resourceLoader: loader1,
	sessionManager: new InMemorySessionManager(),
});
const session1 = await pi1.createAgentSession();

try {
	session1.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	console.log("=== Replace prompt ===");
	await session1.prompt("What is 2 + 2?");
	console.log("\n");
} finally {
	await pi1.dispose();
}

// Option 2: Append instructions to the default prompt
const loader2 = new DefaultResourceLoader({
	cwd,
	agentDir,
	appendSystemPromptOverride: (base) => [
		...base,
		"## Additional Instructions\n- Always be concise\n- Use bullet points when listing things",
	],
});
await loader2.reload();

const pi2 = await PiAgent.create({
	cwd,
	agentDir,
	resourceLoader: loader2,
	sessionManager: new InMemorySessionManager(),
});
const session2 = await pi2.createAgentSession();

try {
	session2.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	console.log("=== Modify prompt ===");
	await session2.prompt("List 3 benefits of TypeScript.");
	console.log();
} finally {
	await pi2.dispose();
}
