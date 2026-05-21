import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { PiAgent } from "../src/core/pi-agent.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { InMemorySessionManager } from "../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

describe("PiAgent skills option", () => {
	let tempDir: string;
	let skillsDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		skillsDir = join(tempDir, "skills", "test-skill");
		mkdirSync(skillsDir, { recursive: true });

		writeFileSync(
			join(skillsDir, "SKILL.md"),
			`---
name: test-skill
description: A test skill for SDK tests.
---

# Test Skill

This is a test skill.
`,
		);
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(resourceLoader?: ResourceLoader) {
		const pi = await PiAgent.create({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: new InMemorySessionManager(tempDir),
			resourceLoader,
		});
		return pi.createAgentSession();
	}

	it("should discover skills by default and expose them on session.skills", async () => {
		const session = await createSession();

		expect(session.resourceLoader.getSkills().skills.length).toBeGreaterThan(0);
		expect(session.resourceLoader.getSkills().skills.some((s) => s.name === "test-skill")).toBe(true);
	});

	it("should have empty skills when resource loader returns none (--no-skills)", async () => {
		const resourceLoader: ResourceLoader = {
			getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => undefined,
			getAppendSystemPrompt: () => [],
			extendResources: () => {},
			reload: async () => {},
		};

		const session = await createSession(resourceLoader);

		expect(session.resourceLoader.getSkills().skills).toEqual([]);
		expect(session.resourceLoader.getSkills().diagnostics).toEqual([]);
	});

	it("should use provided skills when resource loader supplies them", async () => {
		const customSkill = {
			name: "custom-skill",
			description: "A custom skill",
			filePath: "/fake/path/SKILL.md",
			baseDir: "/fake/path",
			sourceInfo: createSyntheticSourceInfo("/fake/path/SKILL.md", { source: "sdk" }),
			disableModelInvocation: false,
		};

		const resourceLoader: ResourceLoader = {
			getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
			getSkills: () => ({ skills: [customSkill], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => undefined,
			getAppendSystemPrompt: () => [],
			extendResources: () => {},
			reload: async () => {},
		};

		const session = await createSession(resourceLoader);

		expect(session.resourceLoader.getSkills().skills).toEqual([customSkill]);
		expect(session.resourceLoader.getSkills().diagnostics).toEqual([]);
	});
});
