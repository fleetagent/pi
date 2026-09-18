import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@fleetagent/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { LoadedHooks } from "../../src/core/hooks/types.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { PiAgent } from "../../src/core/pi-agent.ts";
import { InMemorySessionManager } from "../../src/core/session/in-memory-session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { LocalToolOperations } from "../../src/core/tools/operations.ts";
import { createTestResourceLoader } from "../utilities.ts";

function promptHookSettings(label: string, log: string): object {
	const script = `process.stdin.resume();process.stdin.on('end',()=>require('fs').appendFileSync(${JSON.stringify(log)},${JSON.stringify(`${label}\n`)}))`;
	return {
		hooks: {
			UserPromptSubmit: [{ hooks: [{ type: "command", command: process.execPath, args: ["-e", script] }] }],
		},
	};
}

function promptHookSnapshot(label: string, log: string): LoadedHooks {
	const source = { kind: "host" as const, path: "host-injected" };
	const script = `process.stdin.resume();process.stdin.on('end',()=>require('fs').appendFileSync(${JSON.stringify(log)},${JSON.stringify(`${label}\n`)}))`;
	return {
		handlers: [
			{
				event: "UserPromptSubmit",
				handler: { type: "command", command: process.execPath, args: ["-e", script] },
				source,
				order: 0,
			},
		],
		diagnostics: [],
		sources: [source],
	};
}
describe("PiAgent hook composition", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		while (cleanups.length) await cleanups.pop()?.();
	});

	it("loads each session cwd snapshot, exposes diagnostics, and bounds lazy lifecycle hooks", async () => {
		const root = join(tmpdir(), `pi-agent-hooks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		const home = join(root, "home");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const log = join(root, "events.log");
		const script =
			"let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>require('fs').appendFileSync(process.argv[1],JSON.parse(s).hook_event_name+'\\n'))";
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				hooks: {
					SessionStart: [{ hooks: [{ type: "command", command: process.execPath, args: ["-e", script, log] }] }],
					SessionEnd: [{ hooks: [{ type: "command", command: process.execPath, args: ["-e", script, log] }] }],
				},
			}),
		);
		writeFileSync(join(cwd, ".pi", "settings.json"), "{broken");

		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models,
		});
		const pi = await PiAgent.create({
			cwd,
			agentDir,
			hooks: { home },
			trustProjectHooks: true,
			model,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
			sessionManager: new InMemorySessionManager(cwd),
		});
		cleanups.push(() => pi.dispose());
		const session = await pi.createAgentSession();
		expect(existsSync(log)).toBe(false);
		expect(pi.diagnostics.some((diagnostic) => diagnostic.message.includes("Hook parse"))).toBe(true);
		faux.setResponses([fauxAssistantMessage("ok")]);
		await session.prompt("hello");
		expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["SessionStart"]);
		await pi.dispose();
		expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["SessionStart", "SessionEnd"]);

		const makePiWithOperations = async (operations: LocalToolOperations, trustedProjectHooksIdentity?: string) => {
			const next = await PiAgent.create({
				cwd,
				agentDir,
				hooks: { home },
				trustProjectHooks: true,
				trustedProjectHooksIdentity,
				toolOperations: operations,
				model,
				authStorage,
				modelRegistry,
				settingsManager: SettingsManager.inMemory(),
				resourceLoader: createTestResourceLoader(),
				sessionManager: new InMemorySessionManager(cwd),
			});
			cleanups.push(() => next.dispose());
			await next.createAgentSession();
			return next;
		};
		const unidentifiedOperations = new LocalToolOperations(cwd);
		Object.defineProperty(unidentifiedOperations, "getBackendInfo", { value: undefined });
		const unidentified = await makePiWithOperations(unidentifiedOperations);
		expect(unidentified.diagnostics.some((diagnostic) => diagnostic.message.includes("Hook parse"))).toBe(false);

		const identifiedLocalOperations = new LocalToolOperations(cwd);
		const identifiedLocal = await makePiWithOperations(identifiedLocalOperations);
		expect(identifiedLocal.diagnostics.some((diagnostic) => diagnostic.message.includes("Hook parse"))).toBe(true);

		const changedIdentity = await makePiWithOperations(new LocalToolOperations(cwd), join(root, "other"));
		expect(
			changedIdentity.diagnostics.some((diagnostic) => diagnostic.message.includes("trust identity changed")),
		).toBe(true);
		expect(changedIdentity.diagnostics.some((diagnostic) => diagnostic.message.includes("Hook parse"))).toBe(false);
	});

	it("reloads file-backed hooks and replaces their configuration diagnostics", async () => {
		const root = join(tmpdir(), `pi-agent-hook-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const log = join(root, "events.log");
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify(promptHookSettings("old", log)));

		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models,
		});
		const pi = await PiAgent.create({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
			sessionManager: new InMemorySessionManager(cwd),
		});
		cleanups.push(() => pi.dispose());
		const session = await pi.createAgentSession();
		faux.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage("three"),
			fauxAssistantMessage("four"),
			fauxAssistantMessage("five"),
		]);

		await session.prompt("first");
		writeFileSync(settingsPath, JSON.stringify(promptHookSettings("new", log)));
		await session.reload();
		await session.prompt("second");
		expect(readFileSync(log, "utf8")).toBe("old\nnew\n");

		writeFileSync(settingsPath, "{broken");
		await session.reload();
		expect(pi.diagnostics.some((diagnostic) => diagnostic.message.includes("Hook parse"))).toBe(true);
		await session.prompt("third");
		expect(readFileSync(log, "utf8")).toBe("old\nnew\n");

		session.setHooksEnabled(false);
		writeFileSync(settingsPath, JSON.stringify(promptHookSettings("recovered", log)));
		await session.reload();
		expect(pi.diagnostics.some((diagnostic) => diagnostic.message.includes("Hook parse"))).toBe(false);
		expect(session.hooksEnabled).toBe(false);
		await session.prompt("fourth");
		expect(readFileSync(log, "utf8")).toBe("old\nnew\n");
		session.setHooksEnabled(true);
		await session.prompt("fifth");
		expect(readFileSync(log, "utf8")).toBe("old\nnew\nrecovered\n");
	});

	it("keeps host-injected hook snapshots fixed across reload", async () => {
		const root = join(tmpdir(), `pi-agent-hook-snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const log = join(root, "events.log");
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify(promptHookSettings("file", log)));

		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models,
		});
		const pi = await PiAgent.create({
			cwd,
			agentDir,
			hooks: { snapshot: promptHookSnapshot("snapshot", log) },
			model,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
			sessionManager: new InMemorySessionManager(cwd),
		});
		cleanups.push(() => pi.dispose());
		const session = await pi.createAgentSession();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);

		await session.prompt("first");
		writeFileSync(settingsPath, JSON.stringify(promptHookSettings("changed-file", log)));
		await session.reload();
		await session.prompt("second");
		expect(readFileSync(log, "utf8")).toBe("snapshot\nsnapshot\n");
	});
});
