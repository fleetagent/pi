import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../../../src/core/package-manager.ts";
import { readPiManifest } from "../../../src/core/pi-manifest.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createHarness } from "../harness.ts";

describe("issue #7187 malformed package manifest", () => {
	it("ignores invalid resource fields without dropping valid fork resource fields", async () => {
		const harness = await createHarness();
		const tempDir = mkdtempSync(join(tmpdir(), "pi-7187-"));
		const agentDir = join(tempDir, "agent");
		try {
			const packageDir = join(agentDir, "npm", "node_modules", "bad-package");
			const extensionPath = join(packageDir, "extensions", "bad.ts");
			const skillPath = join(packageDir, "skills", "bad", "SKILL.md");
			const rulePath = join(packageDir, "rules", "bad", "RULES.md");
			const promptPath = join(packageDir, "prompts", "valid.md");
			const themePath = join(packageDir, "themes", "valid.json");
			mkdirSync(join(packageDir, "extensions"), { recursive: true });
			mkdirSync(join(packageDir, "skills", "bad"), { recursive: true });
			mkdirSync(join(packageDir, "rules", "bad"), { recursive: true });
			mkdirSync(join(packageDir, "prompts"), { recursive: true });
			mkdirSync(join(packageDir, "themes"), { recursive: true });
			writeFileSync(extensionPath, "export default function () {}\n");
			writeFileSync(skillPath, "---\nname: bad\ndescription: Must not load\n---\n");
			writeFileSync(rulePath, "---\nname: bad\ndescription: Must not load\n---\n");
			writeFileSync(promptPath, "Valid prompt\n");
			writeFileSync(themePath, "{}\n");
			writeFileSync(
				join(packageDir, "package.json"),
				JSON.stringify({
					name: "bad-package",
					version: "1.0.0",
					pi: {
						extensions: "./extensions",
						skills: "./skills",
						rules: ["./rules", 42],
						prompts: ["./prompts"],
						themes: ["./themes"],
					},
				}),
			);
			const packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager: SettingsManager.inMemory({ packages: ["npm:bad-package"] }),
			});

			const resources = await packageManager.resolve();
			expect(resources.extensions.map((extension) => extension.path)).not.toContain(extensionPath);
			expect(resources.skills.map((skill) => skill.path)).not.toContain(skillPath);
			expect(resources.rules.map((rule) => rule.path)).not.toContain(rulePath);
			expect(resources.prompts.map((prompt) => prompt.path)).toContain(promptPath);
			expect(resources.themes.map((theme) => theme.path)).toContain(themePath);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
			harness.cleanup();
		}
	});

	it("validates the package root, pi object, and every resource array", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-7187-reader-"));
		const packageJsonPath = join(tempDir, "package.json");
		try {
			writeFileSync(packageJsonPath, "not json");
			expect(readPiManifest(packageJsonPath)).toBeNull();

			writeFileSync(packageJsonPath, JSON.stringify([]));
			expect(readPiManifest(packageJsonPath)).toBeNull();

			writeFileSync(packageJsonPath, JSON.stringify({ pi: [] }));
			expect(readPiManifest(packageJsonPath)).toBeNull();

			writeFileSync(
				packageJsonPath,
				JSON.stringify({
					pi: {
						extensions: ["./extension.ts"],
						skills: [],
						rules: ["./RULES.md"],
						prompts: ["./prompt.md", null],
						themes: { path: "./theme.json" },
					},
				}),
			);
			expect(readPiManifest(packageJsonPath)).toEqual({
				extensions: ["./extension.ts"],
				skills: [],
				rules: ["./RULES.md"],
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses the shared validation during automatic extension discovery", async () => {
		const harness = await createHarness();
		const tempDir = mkdtempSync(join(tmpdir(), "pi-7187-extension-"));
		const agentDir = join(tempDir, "agent");
		const packageDir = join(tempDir, ".pi", "extensions", "extension-package");
		try {
			mkdirSync(packageDir, { recursive: true });
			const indexPath = join(packageDir, "index.ts");
			writeFileSync(indexPath, "export default function () {}\n");
			writeFileSync(join(packageDir, "package.json"), JSON.stringify({ pi: { extensions: ["./missing.ts", 42] } }));
			const packageManager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager: SettingsManager.inMemory(),
			});

			const resources = await packageManager.resolve();
			expect(resources.extensions.map((extension) => extension.path)).toContain(indexPath);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
			harness.cleanup();
		}
	});
});
