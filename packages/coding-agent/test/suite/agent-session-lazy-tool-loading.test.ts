import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@fleetagent/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@fleetagent/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { loadRulesFromDir, type Rule } from "../../src/core/rules.ts";
import { loadSkillsFromDir, type Skill } from "../../src/core/skills.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession lazy session tool loading", () => {
	const harnesses: Harness[] = [];

	const makeLazyTool = (name: string, runs: string[]): AgentTool => ({
		name,
		label: name,
		description: `Lazy tool ${name}`,
		parameters: Type.Object({}),
		execute: async () => {
			runs.push(name);
			return { content: [{ type: "text", text: `${name}-result` }], details: {} };
		},
	});

	const createMutableResourceLoader = () => {
		const skills: Skill[] = [];
		const rules: Rule[] = [];
		const base = createTestResourceLoader();
		return {
			resourceLoader: {
				...base,
				getSkills: () => ({ skills, diagnostics: [] }),
				getRules: () => ({ rules, diagnostics: [] }),
			},
			skills,
			rules,
		};
	};

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("makes a lazily loaded tool callable on the next turn within the same run", async () => {
		const runs: string[] = [];
		const lazyTool: AgentTool = {
			name: "lazy_probe",
			label: "Lazy probe",
			description: "Lazy tool for testing load_tool",
			parameters: Type.Object({}),
			execute: async () => {
				runs.push("called");
				return { content: [{ type: "text", text: "lazy-result" }], details: {} };
			},
		};

		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.registerSessionTool(lazyTool, { lazy: true });

		// The lazy tool is not active until load_tool runs.
		expect(harness.session.getActiveToolNames()).not.toContain("lazy_probe");

		// Within a single run: load the tool, then call it, then finish.
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("load_tool", { name: "lazy_probe" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("lazy_probe", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		// The lazy tool executed within the same run (no extra prompt needed).
		expect(runs).toEqual(["called"]);

		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		const lazyResultText = toolResults.map((message) => getMessageText(message)).join("\n");
		expect(lazyResultText).toContain("lazy-result");
		expect(lazyResultText).not.toContain("not found");

		// It is now part of the active tool set.
		expect(harness.session.getActiveToolNames()).toContain("lazy_probe");
	});

	it("loads multiple tools in a single load_tool call", async () => {
		const runs: string[] = [];
		const makeLazyTool = (name: string): AgentTool => ({
			name,
			label: name,
			description: `Lazy tool ${name}`,
			parameters: Type.Object({}),
			execute: async () => {
				runs.push(name);
				return { content: [{ type: "text", text: `${name}-result` }], details: {} };
			},
		});

		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.registerSessionTool(makeLazyTool("lazy_a"), { lazy: true });
		harness.session.registerSessionTool(makeLazyTool("lazy_b"), { lazy: true });
		harness.session.registerSessionTool(makeLazyTool("lazy_c"), { lazy: true });

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("load_tool", { name: ["lazy_a", "lazy_b", "missing"] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("lazy_a", {}), fauxToolCall("lazy_b", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(runs.sort()).toEqual(["lazy_a", "lazy_b"]);
		expect(harness.session.getActiveToolNames()).toEqual(expect.arrayContaining(["lazy_a", "lazy_b"]));
		expect(harness.session.getActiveToolNames()).not.toContain("lazy_c");

		const loadResult = harness.session.messages
			.filter((message) => message.role === "toolResult")
			.map((message) => getMessageText(message))
			.join("\n");
		expect(loadResult).toContain("Loaded tools: lazy_a, lazy_b");
		expect(loadResult).toContain("not found in this session: missing");
	});

	it("loads tools for a session-registered skill when expanding a skill command", async () => {
		const runs: string[] = [];
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.registerSessionTool(makeLazyTool("rpc_skill_tool", runs), { lazy: true });
		harness.session.registerSessionSkill({
			name: "rpc-skill",
			description: "RPC skill",
			filePath: "<rpc-skill:rpc-skill>",
			baseDir: harness.tempDir,
			disableModelInvocation: false,
			tools: ["rpc_skill_tool"],
			content: "# RPC Skill\n",
		});

		expect(harness.session.getRegisteredSkills().map((skill) => skill.name)).toContain("rpc-skill");
		expect(harness.session.getActiveToolNames()).not.toContain("rpc_skill_tool");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("rpc_skill_tool", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("/skill:rpc-skill use it");

		expect(runs).toEqual(["rpc_skill_tool"]);
		expect(harness.session.getActiveToolNames()).toContain("rpc_skill_tool");
	});

	it("loads tools for a session-registered rule when expanding a rule command", async () => {
		const runs: string[] = [];
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.registerSessionTool(makeLazyTool("rpc_rule_tool", runs), { lazy: true });
		harness.session.registerSessionRule({
			name: "rpc-rule",
			description: "RPC rule",
			filePath: "<rpc-rule:rpc-rule>",
			baseDir: harness.tempDir,
			disableModelInvocation: false,
			tools: ["rpc_rule_tool"],
			content: "# RPC Rule\n",
		});

		expect(harness.session.getRegisteredRules().map((rule) => rule.name)).toContain("rpc-rule");
		expect(harness.session.getActiveToolNames()).not.toContain("rpc_rule_tool");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("rpc_rule_tool", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("/rule:rpc-rule use it");

		expect(runs).toEqual(["rpc_rule_tool"]);
		expect(harness.session.getActiveToolNames()).toContain("rpc_rule_tool");
	});

	it("loads skill frontmatter tools when expanding a skill command", async () => {
		const runs: string[] = [];
		const { resourceLoader, skills } = createMutableResourceLoader();
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		harness.session.registerSessionTool(makeLazyTool("skill_tool", runs), { lazy: true });

		const skillDir = join(harness.tempDir, "auto-skill");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: auto-skill\ndescription: Auto loads a tool.\ntools:\n  - skill_tool\n---\n\n# Auto Skill\n`,
		);
		skills.push(...loadSkillsFromDir({ dir: skillDir, source: "path" }).skills);

		expect(harness.session.getActiveToolNames()).not.toContain("skill_tool");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("skill_tool", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("/skill:auto-skill use it");

		expect(runs).toEqual(["skill_tool"]);
		expect(harness.session.getActiveToolNames()).toContain("skill_tool");
	});

	it("loads rule frontmatter tools when expanding a rule command", async () => {
		const runs: string[] = [];
		const { resourceLoader, rules } = createMutableResourceLoader();
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		harness.session.registerSessionTool(makeLazyTool("rule_tool", runs), { lazy: true });

		const ruleDir = join(harness.tempDir, "auto-rule");
		mkdirSync(ruleDir, { recursive: true });
		writeFileSync(
			join(ruleDir, "RULES.md"),
			`---\nname: auto-rule\ndescription: Auto loads a rule tool.\ntools: rule_tool\n---\n\n# Auto Rule\n`,
		);
		rules.push(...loadRulesFromDir({ dir: ruleDir, source: "path" }).rules);

		expect(harness.session.getActiveToolNames()).not.toContain("rule_tool");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("rule_tool", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("/rule:auto-rule use it");

		expect(runs).toEqual(["rule_tool"]);
		expect(harness.session.getActiveToolNames()).toContain("rule_tool");
	});

	it("loads skill frontmatter tools when the model reads the skill file", async () => {
		const runs: string[] = [];
		const { resourceLoader, skills } = createMutableResourceLoader();
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		harness.session.registerSessionTool(makeLazyTool("read_skill_tool", runs), { lazy: true });

		const skillDir = join(harness.tempDir, "read-skill");
		const skillPath = join(skillDir, "SKILL.md");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			skillPath,
			`---\nname: read-skill\ndescription: Read loads a tool.\ntools:\n  - read_skill_tool\n---\n\n# Read Skill\n`,
		);
		skills.push(...loadSkillsFromDir({ dir: skillDir, source: "path" }).skills);

		expect(harness.session.getActiveToolNames()).not.toContain("read_skill_tool");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: skillPath }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("read_skill_tool", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("load the skill");

		expect(runs).toEqual(["read_skill_tool"]);
		expect(harness.session.getActiveToolNames()).toContain("read_skill_tool");
	});

	it("loads rule frontmatter tools when the model reads the rule file", async () => {
		const runs: string[] = [];
		const { resourceLoader, rules } = createMutableResourceLoader();
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		harness.session.registerSessionTool(makeLazyTool("read_rule_tool", runs), { lazy: true });

		const ruleDir = join(harness.tempDir, "read-rule");
		const rulePath = join(ruleDir, "RULES.md");
		mkdirSync(ruleDir, { recursive: true });
		writeFileSync(
			rulePath,
			`---\nname: read-rule\ndescription: Read loads a rule tool.\ntools:\n  - read_rule_tool\n---\n\n# Read Rule\n`,
		);
		rules.push(...loadRulesFromDir({ dir: ruleDir, source: "path" }).rules);

		expect(harness.session.getActiveToolNames()).not.toContain("read_rule_tool");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: rulePath }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("read_rule_tool", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("load the rule");

		expect(runs).toEqual(["read_rule_tool"]);
		expect(harness.session.getActiveToolNames()).toContain("read_rule_tool");
	});

	it("removes a tool from the active set on the next turn after unload_tool", async () => {
		const runs: string[] = [];
		const lazyTool: AgentTool = {
			name: "lazy_probe",
			label: "Lazy probe",
			description: "Lazy tool for testing unload_tool",
			parameters: Type.Object({}),
			execute: async () => {
				runs.push("called");
				return { content: [{ type: "text", text: "lazy-result" }], details: {} };
			},
		};

		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.registerSessionTool(lazyTool, { lazy: true });

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("load_tool", { name: "lazy_probe" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("unload_tool", { name: "lazy_probe" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(runs).toEqual([]);
		expect(harness.session.getActiveToolNames()).not.toContain("lazy_probe");
	});
});
