/**
 * Tools Configuration
 *
 * Use tool names to choose which built-in tools are enabled.
 *
 * Tool names are matched against all available tools. If you use a custom `cwd`,
 * PiAgent applies that cwd when it builds the actual built-in tools.
 *
 * For custom tools, see 06-extensions.ts - custom tools are registered via the
 * extensions system using pi.registerTool().
 */

import { InMemorySessionManager, PiAgent } from "@fleetagent/pi-coding-agent";

async function createToolSession(options: { cwd?: string; tools: string[] }) {
	const cwd = options.cwd ?? process.cwd();
	const pi = await PiAgent.create({
		cwd,
		tools: options.tools,
		sessionManager: new InMemorySessionManager(cwd),
	});
	await pi.createAgentSession();
	return pi;
}

// Read-only mode (no edit/write)
const readOnlyPi = await createToolSession({ tools: ["read", "grep", "find", "ls"] });
console.log("Read-only session created");
await readOnlyPi.dispose();

// Custom tool selection
const customToolsPi = await createToolSession({ tools: ["read", "bash", "grep"] });
console.log("Custom tools session created");
await customToolsPi.dispose();

// With custom cwd
const customCwd = "/path/to/project";
const customCwdPi = await createToolSession({
	cwd: customCwd,
	tools: ["read", "bash", "edit", "write"],
});
console.log("Custom cwd session created");
await customCwdPi.dispose();

// Or pick specific tools for custom cwd
const specificToolsPi = await createToolSession({
	cwd: customCwd,
	tools: ["read", "bash", "grep"],
});
console.log("Specific tools with custom cwd session created");
await specificToolsPi.dispose();
