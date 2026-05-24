import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatRulesForPrompt, loadRulesFromDir, type Rule } from "../src/core/rules.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-rules-test-"));
	tempDirs.push(dir);
	return dir;
}

function createTestRule(options: {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation?: boolean;
}): Rule {
	return {
		name: options.name,
		description: options.description,
		filePath: options.filePath,
		baseDir: options.baseDir,
		sourceInfo: createSyntheticSourceInfo(options.filePath, { source: "test" }),
		disableModelInvocation: options.disableModelInvocation ?? false,
	};
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("rules", () => {
	it("loads RULES.md from a rule directory", () => {
		const root = createTempDir();
		const ruleDir = join(root, "typescript");
		mkdirSync(ruleDir, { recursive: true });
		writeFileSync(
			join(ruleDir, "RULES.md"),
			"---\nname: typescript\ndescription: Mandatory TypeScript rules. Load before editing TypeScript files.\n---\n\n# TypeScript\n\nNo any.",
		);

		const { rules, diagnostics } = loadRulesFromDir({ dir: root, source: "test" });

		expect(diagnostics).toEqual([]);
		expect(rules).toHaveLength(1);
		expect(rules[0].name).toBe("typescript");
		expect(rules[0].description).toContain("Mandatory TypeScript rules");
		expect(rules[0].filePath).toBe(join(ruleDir, "RULES.md"));
	});

	it("loads direct markdown rules from .pi-style roots", () => {
		const root = createTempDir();
		const rulePath = join(root, "naming-conventions.md");
		writeFileSync(
			rulePath,
			"---\nname: naming-conventions\ndescription: Mandatory naming rules. Load when naming files or symbols.\n---\n\n# Naming\n",
		);

		const { rules } = loadRulesFromDir({ dir: root, source: "test" });

		expect(rules).toHaveLength(1);
		expect(rules[0].name).toBe("naming-conventions");
	});

	it("formats rules as mandatory on-demand prompt context", () => {
		const rules = [
			createTestRule({
				name: "typescript",
				description: "Mandatory TypeScript rules. Load before editing TypeScript files.",
				filePath: "/path/to/typescript/RULES.md",
				baseDir: "/path/to/typescript",
			}),
		];

		const result = formatRulesForPrompt(rules);

		expect(result).toContain("The following rules provide mandatory constraints and policies.");
		expect(result).toContain("applicable rules are mandatory");
		expect(result).toContain("<available_rules>");
		expect(result).toContain("<name>typescript</name>");
		expect(result).toContain("<location>/path/to/typescript/RULES.md</location>");
	});

	it("excludes rules with disable-model-invocation from the prompt", () => {
		const result = formatRulesForPrompt([
			createTestRule({
				name: "hidden",
				description: "Hidden rule.",
				filePath: "/path/to/hidden/RULES.md",
				baseDir: "/path/to/hidden",
				disableModelInvocation: true,
			}),
		]);

		expect(result).toBe("");
	});
});
