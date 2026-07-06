/**
 * Full Control
 *
 * Replace everything - no discovery, explicit configuration.
 */

import { getModel } from "@fleetagent/pi-ai";
import {
	AuthStorage,
	createExtensionRuntime,
	InMemorySessionManager,
	ModelRegistry,
	PiAgent,
	type ResourceLoader,
	SettingsManager,
} from "@fleetagent/pi-coding-agent";

// Custom auth storage location
const authStorage = AuthStorage.create("/tmp/my-agent/auth.json");

// Runtime API key override (not persisted)
if (process.env.MY_ANTHROPIC_KEY) {
	authStorage.setRuntimeApiKey("anthropic", process.env.MY_ANTHROPIC_KEY);
}

// Model registry with no custom models.json
const modelRegistry = ModelRegistry.inMemory(authStorage);

const model = getModel("anthropic", "claude-sonnet-5");
if (!model) throw new Error("Model not found");

// In-memory settings with overrides
const settingsManager = SettingsManager.inMemory({
	compaction: { enabled: false },
	retry: { enabled: true, maxRetries: 2 },
});

const cwd = process.cwd();

const resourceLoader: ResourceLoader = {
	getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getRules: () => ({ rules: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () => `You are a minimal assistant.
Available: read, bash. Be concise.`,
	getAppendSystemPrompt: () => [],
	extendResources: () => {},
	reload: async () => {},
};

const pi = await PiAgent.create({
	cwd,
	agentDir: "/tmp/my-agent",
	model,
	thinkingLevel: "off",
	authStorage,
	modelRegistry,
	resourceLoader,
	tools: ["read", "bash"],
	sessionManager: new InMemorySessionManager(cwd),
	settingsManager,
});
const session = await pi.createAgentSession();

try {
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	await session.prompt("List files in the current directory.");
	console.log();
} finally {
	await pi.dispose();
}
