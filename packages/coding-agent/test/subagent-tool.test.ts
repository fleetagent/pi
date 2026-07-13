import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getModel, registerFauxProvider } from "@fleetagent/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ACTIVE_TOOL_NAMES } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { PiAgent } from "../src/core/pi-agent.ts";
import { InMemorySessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createAllToolDefinitions } from "../src/core/tools/index.ts";
import { LocalToolOperations } from "../src/core/tools/operations.ts";
import {
	createSubagentToolDefinition,
	formatSubagentModelCatalog,
	formatSubagentTaskPrompt,
	subagentParamsSchema,
} from "../src/core/tools/subagent.ts";
import { discoverAgents } from "../src/core/tools/subagent-agents.ts";
import { createHarness } from "./suite/harness.ts";

const tempDirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("native subagent tool", () => {
	it("is registered and active by default", () => {
		const cwd = createTempDir("pi-subagent-tools-");
		const definitions = createAllToolDefinitions(new LocalToolOperations(cwd));
		expect(definitions.subagent.name).toBe("subagent");
		expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("subagent");
	});

	it("does not expose subagent in sessions without an embedded runner", async () => {
		const harness = await createHarness();
		try {
			expect(harness.session.getActiveToolNames()).not.toContain("subagent");
		} finally {
			harness.cleanup();
		}
	});

	it("reports a configuration error when no embedded runner is available", async () => {
		const cwd = createTempDir("pi-subagent-no-runner-");
		const result = await createSubagentToolDefinition().execute(
			"call-no-runner",
			{ task: "inspect" },
			undefined,
			undefined,
			{ cwd, hasUI: false } as unknown as ExtensionContext,
		);
		expect(result.content).toEqual([{ type: "text", text: "Subagent runner is not configured for this session." }]);
	});

	it("bundles default agents and lets user definitions override them", () => {
		const cwd = createTempDir("pi-subagent-cwd-");
		const agentDir = createTempDir("pi-subagent-config-");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		writeFileSync(
			join(agentDir, "agents", "explore.md"),
			["---", "name: explore", "description: User explorer", "tools: read", "---", "Custom explore prompt."].join(
				"\n",
			),
		);

		const discovery = discoverAgents(cwd, "user");
		expect(discovery.agents.map((agent) => agent.name)).toEqual(["explore", "worker", "reviewer"]);
		expect(discovery.agents.find((agent) => agent.name === "explore")).toMatchObject({
			description: "User explorer",
			source: "user",
			systemPrompt: "Custom explore prompt.",
		});
		expect(discovery.agents.every((agent) => agent.model === undefined)).toBe(true);
	});

	it("supports ad-hoc personas, output contracts, models, and tools", () => {
		expect(subagentParamsSchema.properties).toMatchObject({
			responseFormat: expect.any(Object),
			systemPrompt: expect.any(Object),
			model: expect.any(Object),
			tools: expect.any(Object),
		});
		expect("confirmProjectAgents" in subagentParamsSchema.properties).toBe(false);
		const taskProperties = subagentParamsSchema.properties.tasks.items.properties;
		expect(taskProperties.agent).toBeDefined();
		expect(taskProperties.responseFormat).toBeDefined();
		expect(taskProperties.systemPrompt).toBeDefined();
		expect(taskProperties.model).toBeDefined();
		expect(taskProperties.tools).toBeDefined();
		const prompt = formatSubagentTaskPrompt("Inspect auth", "Return files and risks");
		expect(prompt).toBe(
			"<task>\nInspect auth\n</task>\n\n<response-format>\nReturn files and risks\n</response-format>",
		);
	});

	it("requires host approval for project presets and fails closed without a UI", async () => {
		const cwd = createTempDir("pi-subagent-project-trust-");
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "project.md"),
			["---", "name: project", "description: Project preset", "---", "Project-controlled prompt."].join("\n"),
		);
		let runnerCalls = 0;
		const runner = async () => {
			runnerCalls++;
			return { exitCode: 0, stderr: "" };
		};

		const untrustedResult = await createSubagentToolDefinition({ runner }).execute(
			"call-project-untrusted",
			{ agentScope: "project", agent: "project", task: "inspect" },
			undefined,
			undefined,
			{ cwd, hasUI: false } as unknown as ExtensionContext,
		);
		expect(untrustedResult.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("require host approval"),
		});
		expect(runnerCalls).toBe(0);

		let confirmationCalls = 0;
		await createSubagentToolDefinition({ runner }).execute(
			"call-project-approved",
			{ agentScope: "project", agent: "project", task: "inspect" },
			undefined,
			undefined,
			{
				cwd,
				hasUI: true,
				ui: {
					confirm: async () => {
						confirmationCalls++;
						return true;
					},
				},
			} as unknown as ExtensionContext,
		);
		expect(confirmationCalls).toBe(1);
		expect(runnerCalls).toBe(1);

		const trustedResult = await createSubagentToolDefinition({ runner, trustProjectAgents: true }).execute(
			"call-project-trusted",
			{ agentScope: "project", agent: "project", task: "inspect" },
			undefined,
			undefined,
			{ cwd, hasUI: false } as unknown as ExtensionContext,
		);
		expect(runnerCalls).toBe(2);
		expect(trustedResult.content[0]).toMatchObject({ type: "text", text: "(no output)" });
	});

	it("uses an injected in-process runner without invoking the CLI", async () => {
		const cwd = createTempDir("pi-subagent-embedded-");
		let receivedPrompt = "";
		let receivedModel: string | undefined;
		const definition = createSubagentToolDefinition({
			runner: async (request) => {
				receivedPrompt = request.prompt;
				receivedModel = request.model;
				request.onMessage(fauxAssistantMessage("embedded result"));
				return { exitCode: 0, stderr: "" };
			},
		});
		const model = getModel("openai-codex", "gpt-5.6");
		const result = await definition.execute(
			"call-embedded",
			{ task: "Inspect auth", model: "openai-codex/gpt-5.6-luna", tools: ["read"] },
			undefined,
			undefined,
			{ cwd, hasUI: false, model } as unknown as ExtensionContext,
		);

		expect(receivedPrompt).toBe("<task>\nInspect auth\n</task>");
		expect(receivedModel).toBe("openai-codex/gpt-5.6-luna");
		expect(result.content).toEqual([{ type: "text", text: "embedded result" }]);
		expect(result.details.results[0]).toMatchObject({ status: "completed", exitCode: 0 });
	});

	it("combines final assistant text blocks while building presentation state incrementally", async () => {
		const cwd = createTempDir("pi-subagent-presentation-");
		const definition = createSubagentToolDefinition({
			runner: async (request) => {
				const message = fauxAssistantMessage("first block");
				message.content.push({ type: "text", text: "second block" });
				request.onMessage(message);
				return { exitCode: 0, stderr: "" };
			},
		});
		const result = await definition.execute("call-presentation", { task: "respond" }, undefined, undefined, {
			cwd,
			hasUI: false,
		} as unknown as ExtensionContext);

		expect(result.content).toEqual([{ type: "text", text: "first block\nsecond block" }]);
	});

	it("bounds retained output across parallel tasks", async () => {
		const cwd = createTempDir("pi-subagent-bounded-");
		const definition = createSubagentToolDefinition({
			runner: async (request) => {
				for (let index = 0; index < 12; index++) {
					request.onMessage({
						role: "toolResult",
						toolCallId: `call-${index}`,
						toolName: "read",
						content: [{ type: "text", text: "x".repeat(100_000) }],
						details: { raw: "y".repeat(100_000) },
						isError: false,
						timestamp: Date.now(),
					});
				}
				request.onMessage(fauxAssistantMessage("bounded final output"));
				return { exitCode: 0, stderr: "" };
			},
		});
		const result = await definition.execute(
			"call-bounded",
			{ tasks: [{ task: "one" }, { task: "two" }] },
			undefined,
			undefined,
			{ cwd, hasUI: false } as unknown as ExtensionContext,
		);

		expect(result.details.results).toHaveLength(2);
		for (const taskResult of result.details.results) {
			expect(JSON.stringify(taskResult.messages).length).toBeLessThan(300_000);
			expect(taskResult.messages.length).toBeLessThan(12);
			expect(taskResult.status).toBe("completed");
		}
	});

	it("returns structured partial results and does not start queued tasks when aborted", async () => {
		const cwd = createTempDir("pi-subagent-abort-");
		const controller = new AbortController();
		let runnerCalls = 0;
		const definition = createSubagentToolDefinition({
			runner: async (request) => {
				runnerCalls++;
				request.onMessage(fauxAssistantMessage("partial output"));
				controller.abort();
				throw new Error("runner aborted");
			},
		});
		const tasks = Array.from({ length: 8 }, (_, index) => ({ task: `task ${index}` }));
		const result = await definition.execute("call-abort", { tasks }, controller.signal, undefined, {
			cwd,
			hasUI: false,
		} as unknown as ExtensionContext);

		expect(runnerCalls).toBe(1);
		expect(result.details.results).toHaveLength(8);
		expect(result.details.results.every((taskResult) => taskResult.status === "failed")).toBe(true);
		expect(result.details.results.every((taskResult) => taskResult.stopReason === "aborted")).toBe(true);
		expect(result.details.results[0].messages).toHaveLength(1);
		expect(result.details.results[0].messages[0]).toMatchObject({ role: "assistant" });
	});

	it("runs built-in subagents as fresh sessions in the parent process", async () => {
		const cwd = createTempDir("pi-subagent-pi-agent-");
		const agentDir = createTempDir("pi-subagent-pi-agent-config-");
		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1.0-alpha", reasoning: true },
				{ id: "faux-2.0-beta", reasoning: true },
			],
		});
		const model = faux.getModel("faux-1.0-alpha")!;
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});
		let childToolNames: string[] = [];
		let childUserText = "";
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("subagent", { task: "Return child output", tools: ["read", "bash"] }), {
				stopReason: "toolUse",
			}),
			(context) => {
				childToolNames = context.tools?.map((tool) => tool.name) ?? [];
				const user = context.messages.find((message) => message.role === "user");
				childUserText =
					user?.role === "user" && Array.isArray(user.content)
						? user.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage("child output");
			},
			fauxAssistantMessage("parent output"),
		]);
		const pi = await PiAgent.create({
			cwd,
			agentDir,
			sessionManager: new InMemorySessionManager(cwd),
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory(),
			model,
			excludedTools: ["bash"],
		});
		try {
			const session = await pi.createAgentSession();
			await session.prompt("delegate");
			const toolResult = session.messages.find((message) => message.role === "toolResult");
			const toolText =
				toolResult?.role === "toolResult"
					? toolResult.content
							.filter((part): part is { type: "text"; text: string } => part.type === "text")
							.map((part) => part.text)
							.join("\n")
					: "";
			expect(toolText).toBe("child output");
			expect(childToolNames).toContain("read");
			expect(childToolNames).not.toContain("bash");
			expect(childToolNames).not.toContain("subagent");
			expect(childUserText).toBe("<task>\nReturn child output\n</task>");
			expect(session.messages.at(-1)).toMatchObject({ role: "assistant" });
			expect(faux.state.callCount).toBe(3);
			const initialParameters = session.getToolDefinition("subagent")?.parameters as typeof subagentParamsSchema;
			const initialModelDescription = (initialParameters.properties.model as { description?: string }).description;
			expect(initialModelDescription).toContain("faux/faux-1.0-alpha");
			expect(initialModelDescription).not.toContain("faux/faux-2.0-beta");

			await session.setModel(faux.getModel("faux-2.0-beta")!);
			const switchedParameters = session.getToolDefinition("subagent")?.parameters as typeof subagentParamsSchema;
			const switchedModelDescription = (switchedParameters.properties.model as { description?: string }).description;
			expect(switchedModelDescription).toContain("faux/faux-2.0-beta");
			expect(switchedModelDescription).not.toContain("faux/faux-1.0-alpha");
		} finally {
			await pi.dispose();
			faux.unregister();
		}
	});

	it("describes authenticated models from the current model family", () => {
		const current = getModel("openai-codex", "gpt-5.6");
		const catalog = formatSubagentModelCatalog(current, [
			current,
			getModel("openai-codex", "gpt-5.6-luna"),
			getModel("openai-codex", "gpt-5.5"),
		]);
		expect(catalog).toContain("openai-codex/gpt-5.6");
		expect(catalog).toContain("openai-codex/gpt-5.6-luna");
		expect(catalog).not.toContain("openai-codex/gpt-5.5");
		expect(catalog).toContain("input $");
		expect(catalog).toContain("output $");
		const parameters = createSubagentToolDefinition({ modelCatalog: catalog }).parameters;
		const singleDescription = (parameters.properties.model as { description?: string }).description;
		const taskDescription = (parameters.properties.tasks.items.properties.model as { description?: string })
			.description;
		const chainDescription = (parameters.properties.chain.items.properties.model as { description?: string })
			.description;
		expect(singleDescription).toContain("openai-codex/gpt-5.6-luna");
		expect(taskDescription).toContain("openai-codex/gpt-5.6-luna");
		expect(chainDescription).toContain("openai-codex/gpt-5.6-luna");
	});

	it("rejects ambiguous mode parameters before running a subagent", async () => {
		const cwd = createTempDir("pi-subagent-invalid-");
		const definition = createSubagentToolDefinition();
		const result = await definition.execute(
			"call-1",
			{ agent: "explore", task: "inspect", tasks: [{ agent: "reviewer", task: "review" }] },
			undefined,
			undefined,
			{ cwd, hasUI: false } as unknown as ExtensionContext,
		);

		expect(result.content[0]).toMatchObject({ type: "text" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Provide exactly one mode");
		expect(result.details.results).toEqual([]);
	});
});

it("keeps excluded tools hidden from discovery and lifecycle APIs", async () => {
	const cwd = createTempDir("pi-excluded-tool-policy-");
	const secretTool = {
		name: "secret",
		label: "Secret",
		description: "Must remain excluded",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "secret" }], details: {} }),
	};
	const pi = await PiAgent.create({
		cwd,
		sessionManager: new InMemorySessionManager(cwd),
		settingsManager: SettingsManager.inMemory(),
		customTools: [secretTool],
		excludedTools: ["secret"],
	});
	try {
		const session = await pi.createAgentSession();
		session.registerSessionTool(secretTool, { lazy: true });
		session.setActiveToolsByName([...session.getActiveToolNames(), "secret"]);

		expect(session.getAllTools().some((tool) => tool.name === "secret")).toBe(false);
		expect(session.getToolDefinition("secret")).toBeUndefined();
		expect(session.getAvailableSessionTools().some((tool) => tool.name === "secret")).toBe(false);
		expect(session.loadSessionTool("secret")).toBe(false);
		expect(session.getActiveToolNames()).not.toContain("secret");
		expect(session.systemPrompt).not.toContain('name="secret"');
	} finally {
		await pi.dispose();
	}
});
