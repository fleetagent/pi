#!/usr/bin/env tsx
/**
 * Manual smoke test for AgentSession.getStructuredResponse() with openai-codex/gpt-5.5.
 *
 * Run from the repo root:
 *
 *   npx tsx packages/coding-agent/test/sdk-structured-response-gpt55.ts
 *
 * Requires configured auth for openai-codex, usually:
 *
 *   ./pi-test.sh /login openai-codex
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel, Type } from "@fleetagent/pi-ai";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { PiAgent } from "../src/core/pi-agent.ts";
import { InMemorySessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const model = getModel("openai-codex", "gpt-5.5");
if (!model) {
	throw new Error("Model openai-codex/gpt-5.5 not found");
}

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

if (!modelRegistry.hasConfiguredAuth(model)) {
	throw new Error("No configured auth for openai-codex. Run `./pi-test.sh /login openai-codex` first.");
}

const RiskReportSchema = Type.Object({
	summary: Type.String(),
	risks: Type.Array(
		Type.Object({
			title: Type.String(),
			severity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
			reason: Type.String(),
		}),
	),
	recommendation: Type.String(),
});

const pi = await PiAgent.create({
	cwd: process.cwd(),
	agentDir: join(tmpdir(), "pi-structured-response-gpt55"),
	model: { ...model, maxTokens: 2_000 },
	thinkingLevel: "low",
	noTools: "all",
	authStorage,
	modelRegistry,
	sessionManager: new InMemorySessionManager(process.cwd()),
	settingsManager: SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	}),
});

const session = await pi.createAgentSession();

try {
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	console.log("Running visible prompt with openai-codex/gpt-5.5...\n");
	await session.prompt(
		"In prose, identify two practical risks of using AI coding agents in a TypeScript repository. Keep it concise.",
	);
	console.log("\n\nExtracting structured response with hidden internal calls...\n");

	const result = await session.getStructuredResponse({
		schema: RiskReportSchema,
		name: "structured_output",
		maxCorrections: 2,
	});

	console.log(JSON.stringify(result.output, null, 2));
	console.log(`\nsource=${result.source} attempts=${result.attempts}`);

	const hiddenEntries = session.session
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === "structured_response_internal");
	console.log(`hidden structured-response entries=${hiddenEntries.length}`);
} finally {
	await pi.dispose();
}
