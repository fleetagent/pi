import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../../src/core/extensions/loader.ts";
import type {
	ExtensionAPI,
	ExtensionFactory,
	LoadExtensionsResult,
	ResourceLoader,
	Rule,
	Skill,
	ToolDefinition,
} from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

function createLazyTool(name: string): ToolDefinition {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
	};
}

async function createReloadableResourceLoader(factory: ExtensionFactory, eventBus: ReturnType<typeof createEventBus>) {
	let extensionsResult: LoadExtensionsResult;
	let skills: Skill[] = [];
	let rules: Rule[] = [];

	const loadExtensions = async (): Promise<void> => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(factory, process.cwd(), eventBus, runtime);
		extensionsResult = { extensions: [extension], errors: [], runtime };
		skills = Array.from(extension.skills.values());
		rules = Array.from(extension.rules.values());
	};
	await loadExtensions();

	const resourceLoader: ResourceLoader = {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills, diagnostics: [] }),
		getRules: () => ({ rules, diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: loadExtensions,
	};
	return resourceLoader;
}

// Regression for https://github.com/fleetagent/pi/issues/7193
describe("extension event-bus lifecycle (#7193)", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			const harness = harnesses.pop();
			await harness?.session.dispose();
			harness?.cleanup();
		}
	});

	it("removes extension-owned event-bus listeners on reload and dispose while retaining host listeners", async () => {
		const eventBus = createEventBus();
		let extensionCalls = 0;
		let hostCalls = 0;
		let firstApi: ExtensionAPI | undefined;
		const factory: ExtensionFactory = (pi) => {
			firstApi ??= pi;
			pi.events.on("reload:test", () => extensionCalls++);
		};
		eventBus.on("reload:test", () => hostCalls++);

		const resourceLoader = await createReloadableResourceLoader(factory, eventBus);
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		await harness.session.bindExtensions({ shutdownHandler: () => {} });

		const emit = async () => {
			const extensionBefore = extensionCalls;
			const hostBefore = hostCalls;
			eventBus.emit("reload:test", undefined);
			await new Promise((resolve) => setImmediate(resolve));
			return { extension: extensionCalls - extensionBefore, host: hostCalls - hostBefore };
		};

		expect(await emit()).toEqual({ extension: 1, host: 1 });
		await harness.session.reload();
		expect(() => firstApi?.getCommands()).toThrow("stale after session replacement or reload");
		expect(() => firstApi?.events.emit("reload:test", undefined)).toThrow(
			"stale after session replacement or reload",
		);
		expect(() => firstApi?.events.on("reload:test", () => {})).toThrow("stale after session replacement or reload");
		expect(await emit()).toEqual({ extension: 1, host: 1 });
		await harness.session.reload();
		expect(await emit()).toEqual({ extension: 1, host: 1 });

		await harness.session.dispose();
		expect(await emit()).toEqual({ extension: 0, host: 1 });
	});

	it("retires old extension tools and instructions without clearing session-scoped RPC resources", async () => {
		const eventBus = createEventBus();
		const apis: ExtensionAPI[] = [];
		let generation = 0;
		const factory: ExtensionFactory = (pi) => {
			const currentGeneration = ++generation;
			apis.push(pi);
			pi.registerTool(createLazyTool(`extension_lazy_${currentGeneration}`), { lazy: true });
			pi.registerSkill({
				name: `extension_skill_${currentGeneration}`,
				description: "Extension skill",
				content: "Extension skill instructions.",
			});
			pi.registerRule({
				name: `extension_rule_${currentGeneration}`,
				description: "Extension rule",
				content: "Extension rule instructions.",
			});
		};

		const resourceLoader = await createReloadableResourceLoader(factory, eventBus);
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		await harness.session.bindExtensions({ shutdownHandler: () => {} });

		harness.session.registerSessionTool(createLazyTool("rpc_lazy"), { lazy: true });
		harness.session.registerSessionSkill({
			name: "rpc_skill",
			description: "RPC skill",
			filePath: "<rpc-skill:rpc_skill>",
			content: "RPC skill instructions.",
			disableModelInvocation: false,
		});
		harness.session.registerSessionRule({
			name: "rpc_rule",
			description: "RPC rule",
			filePath: "<rpc-rule:rpc_rule>",
			content: "RPC rule instructions.",
			disableModelInvocation: false,
		});
		expect(harness.session.loadSessionTool("rpc_lazy")).toBe(true);
		expect(harness.session.getAvailableSessionTools().map((tool) => tool.name)).toContain("extension_lazy_1");

		await harness.session.reload();

		expect(harness.session.getActiveToolNames()).toContain("rpc_lazy");
		expect(harness.session.getRegisteredSkills().map((skill) => skill.name)).toEqual(
			expect.arrayContaining(["rpc_skill", "extension_skill_2"]),
		);
		expect(harness.session.getRegisteredSkills().map((skill) => skill.name)).not.toContain("extension_skill_1");
		expect(harness.session.getRegisteredRules().map((rule) => rule.name)).toEqual(
			expect.arrayContaining(["rpc_rule", "extension_rule_2"]),
		);
		expect(harness.session.getRegisteredRules().map((rule) => rule.name)).not.toContain("extension_rule_1");
		const availableTools = harness.session.getAvailableSessionTools().map((tool) => tool.name);
		expect(availableTools).toEqual(expect.arrayContaining(["rpc_lazy", "extension_lazy_2"]));
		expect(availableTools).not.toContain("extension_lazy_1");

		expect(() => apis[0].registerTool(createLazyTool("stale_lazy"), { lazy: true })).toThrow(
			"stale after session replacement or reload",
		);
		expect(() =>
			apis[0].registerSkill({
				name: "stale_skill",
				description: "Stale skill",
				content: "Must not register.",
			}),
		).toThrow("stale after session replacement or reload");
		expect(() =>
			apis[0].registerRule({
				name: "stale_rule",
				description: "Stale rule",
				content: "Must not register.",
			}),
		).toThrow("stale after session replacement or reload");
	});
});
