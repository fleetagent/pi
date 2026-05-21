/**
 * API Keys and OAuth
 *
 * Configure API key resolution via AuthStorage and ModelRegistry.
 */

import { AuthStorage, InMemorySessionManager, ModelRegistry, PiAgent } from "@earendil-works/pi-coding-agent";

async function createAuthExample(options: { authStorage: AuthStorage; modelRegistry: ModelRegistry }) {
	const pi = await PiAgent.create({
		authStorage: options.authStorage,
		modelRegistry: options.modelRegistry,
		sessionManager: new InMemorySessionManager(),
	});
	await pi.createAgentSession();
	return pi;
}

// Default: AuthStorage uses ~/.pi/agent/auth.json
// ModelRegistry loads built-in + custom models from ~/.pi/agent/models.json
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const defaultAuthPi = await createAuthExample({ authStorage, modelRegistry });
console.log("Session with default auth storage and model registry");
await defaultAuthPi.dispose();

// Custom auth storage location
const customAuthStorage = AuthStorage.create("/tmp/my-app/auth.json");
const customModelRegistry = ModelRegistry.create(customAuthStorage, "/tmp/my-app/models.json");

const customAuthPi = await createAuthExample({ authStorage: customAuthStorage, modelRegistry: customModelRegistry });
console.log("Session with custom auth storage location");
await customAuthPi.dispose();

// Runtime API key override (not persisted to disk)
authStorage.setRuntimeApiKey("anthropic", "sk-my-temp-key");
const runtimeKeyPi = await createAuthExample({ authStorage, modelRegistry });
console.log("Session with runtime API key override");
await runtimeKeyPi.dispose();

// No models.json - only built-in models
const simpleRegistry = ModelRegistry.inMemory(authStorage);
const builtInModelsPi = await createAuthExample({ authStorage, modelRegistry: simpleRegistry });
console.log("Session with only built-in models");
await builtInModelsPi.dispose();
