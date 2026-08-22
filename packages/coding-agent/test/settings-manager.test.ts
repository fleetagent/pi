import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS } from "../src/core/http-dispatcher.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("SettingsManager", () => {
	const testDir = join(process.cwd(), "test-settings-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		// Clean up and create fresh directories
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	describe("preserves externally added settings", () => {
		it("should preserve enabledModels when changing thinking level", async () => {
			// Create initial settings file
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					defaultModel: "claude-sonnet",
				}),
			);

			// Create SettingsManager (simulates pi starting up)
			const manager = SettingsManager.create(projectDir, agentDir);

			// Simulate user editing settings.json externally to add enabledModels
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.enabledModels = ["claude-opus-4-5", "gpt-5.2-codex"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// User changes thinking level via Shift+Tab
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// Verify enabledModels is preserved
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.enabledModels).toEqual(["claude-opus-4-5", "gpt-5.2-codex"]);
			expect(savedSettings.defaultThinkingLevel).toBe("high");
			expect(savedSettings.theme).toBe("dark");
			expect(savedSettings.defaultModel).toBe("claude-sonnet");
		});

		it("should preserve custom settings when changing theme", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					defaultModel: "claude-sonnet",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// User adds custom settings externally
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.shellPath = "/bin/zsh";
			currentSettings.extensions = ["/path/to/extension.ts"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// User changes theme
			manager.setTheme("light");
			await manager.flush();

			// Verify all settings preserved
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.theme).toBe("light");
		});

		it("should let in-memory changes override file changes for same key", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// User externally sets thinking level to "low"
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.defaultThinkingLevel = "low";
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// But then changes it via UI to "high"
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// In-memory change should win
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.defaultThinkingLevel).toBe("high");
		});
	});

	describe("packages migration", () => {
		it("should keep local-only extensions in extensions array", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					extensions: ["/local/ext.ts", "./relative/ext.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getPackages()).toEqual([]);
			expect(manager.getExtensionPaths()).toEqual(["/local/ext.ts", "./relative/ext.ts"]);
		});

		it("should handle packages with filtering objects", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					packages: [
						"npm:simple-pkg",
						{
							source: "npm:shitty-extensions",
							extensions: ["extensions/oracle.ts"],
							skills: [],
						},
					],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			const packages = manager.getPackages();
			expect(packages).toHaveLength(2);
			expect(packages[0]).toBe("npm:simple-pkg");
			expect(packages[1]).toEqual({
				source: "npm:shitty-extensions",
				extensions: ["extensions/oracle.ts"],
				skills: [],
			});
		});
	});

	describe("reload", () => {
		it("should reload global settings from disk", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					extensions: ["/before.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "light",
					extensions: ["/after.ts"],
					defaultModel: "claude-sonnet",
				}),
			);

			await manager.reload();

			expect(manager.getTheme()).toBe("light");
			expect(manager.getExtensionPaths()).toEqual(["/after.ts"]);
			expect(manager.getDefaultModel()).toBe("claude-sonnet");
		});

		it("should keep previous settings when file is invalid", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(settingsPath, "{ invalid json");
			await manager.reload();

			expect(manager.getTheme()).toBe("dark");
		});

		it("keeps cumulative runtime overrides authoritative across global and project saves and reload", async () => {
			const globalSettingsPath = join(agentDir, "settings.json");
			const projectSettingsPath = join(projectDir, ".pi", "settings.json");
			writeFileSync(globalSettingsPath, JSON.stringify({ markdown: { mermaid: false, codeBlockIndent: "    " } }));
			writeFileSync(projectSettingsPath, JSON.stringify({ packages: ["npm:before"] }));

			const manager = SettingsManager.create(projectDir, agentDir);
			manager.applyOverrides({ markdown: { mermaid: true } });
			manager.applyOverrides({ quietStartup: true });
			manager.setTheme("light");
			manager.setProjectPackages(["npm:after"]);
			await manager.flush();

			writeFileSync(
				globalSettingsPath,
				JSON.stringify({ theme: "dark", markdown: { mermaid: false, codeBlockIndent: "\t" } }),
			);
			await manager.reload();

			expect(manager.getTheme()).toBe("dark");
			expect(manager.getQuietStartup()).toBe(true);
			expect(manager.getPackages()).toEqual(["npm:after"]);
			expect(manager.getMarkdownSettings()).toEqual({ mermaid: true, codeBlockIndent: "\t" });
			expect(manager.getCodeBlockIndent()).toBe("\t");
		});
	});

	describe("error tracking", () => {
		it("should collect and clear load errors via drainErrors", () => {
			const globalSettingsPath = join(agentDir, "settings.json");
			const projectSettingsPath = join(projectDir, ".pi", "settings.json");
			writeFileSync(globalSettingsPath, "{ invalid global json");
			writeFileSync(projectSettingsPath, "{ invalid project json");

			const manager = SettingsManager.create(projectDir, agentDir);
			const errors = manager.drainErrors();

			expect(errors).toHaveLength(2);
			expect(errors.map((e) => e.scope).sort()).toEqual(["global", "project"]);
			expect(manager.drainErrors()).toEqual([]);
		});
	});

	describe("project settings directory creation", () => {
		it("should not create .pi folder when only reading project settings", () => {
			// Create agent dir with global settings, but NO .pi folder in project
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			// Delete the .pi folder that beforeEach created
			rmSync(join(projectDir, ".pi"), { recursive: true });

			// Create SettingsManager (reads both global and project settings)
			const manager = SettingsManager.create(projectDir, agentDir);

			// .pi folder should NOT have been created just from reading
			expect(existsSync(join(projectDir, ".pi"))).toBe(false);

			// Settings should still be loaded from global
			expect(manager.getTheme()).toBe("dark");
		});

		it("should create .pi folder when writing project settings", async () => {
			// Create agent dir with global settings, but NO .pi folder in project
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			// Delete the .pi folder that beforeEach created
			rmSync(join(projectDir, ".pi"), { recursive: true });

			const manager = SettingsManager.create(projectDir, agentDir);

			// .pi folder should NOT exist yet
			expect(existsSync(join(projectDir, ".pi"))).toBe(false);

			// Write a project-specific setting
			manager.setProjectPackages([{ source: "npm:test-pkg" }]);
			await manager.flush();

			// Now .pi folder should exist
			expect(existsSync(join(projectDir, ".pi"))).toBe(true);

			// And settings file should be created
			expect(existsSync(join(projectDir, ".pi", "settings.json"))).toBe(true);
		});
	});

	describe("httpIdleTimeoutMs", () => {
		it("should default to 5 minutes", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getHttpIdleTimeoutMs()).toBe(DEFAULT_HTTP_IDLE_TIMEOUT_MS);
		});

		it("should use merged global and project settings", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 300000 }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 0 }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getHttpIdleTimeoutMs()).toBe(0);
		});

		it("should reject invalid timeout values", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: -1 }));
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(() => manager.getHttpIdleTimeoutMs()).toThrow("Invalid httpIdleTimeoutMs setting");
		});
	});

	describe("shellCommandPrefix", () => {
		it("should load shellCommandPrefix from settings", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBe("shopt -s expand_aliases");
		});

		it("should return undefined when shellCommandPrefix is not set", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBeUndefined();
		});

		it("should preserve shellCommandPrefix when saving unrelated settings", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setTheme("light");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellCommandPrefix).toBe("shopt -s expand_aliases");
			expect(savedSettings.theme).toBe("light");
		});
	});

	describe("getSessionDir", () => {
		it("should return undefined when not set", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBeUndefined();
		});

		it("should return global sessionDir", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/tmp/sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("/tmp/sessions");
		});

		it("should return project sessionDir, overriding global", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/global/sessions" }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ sessionDir: "./sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("./sessions");
		});

		it("should expand ~ in sessionDir", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "~/sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe(join(homedir(), "sessions"));
		});
	});
	describe("sandbox settings", () => {
		it("merges global and project sandbox settings", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					sandbox: { image: "global-image", dockerBinary: "podman", daemonPort: 9000 },
				}),
			);
			writeFileSync(
				join(projectDir, ".pi", "settings.json"),
				JSON.stringify({
					sandbox: { image: "project-image", cleanup: "remove" },
				}),
			);
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getSandboxSettings()).toEqual({
				image: "project-image",
				dockerBinary: "podman",
				daemonPort: 9000,
				cleanup: "remove",
			});
		});
	});

	describe("TUI mode", () => {
		it("defaults to regular and persists fullscreen mode", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getTuiMode()).toBe("regular");

			manager.setTuiMode("fullscreen");
			await manager.flush();

			expect(manager.getTuiMode()).toBe("fullscreen");
			const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(savedSettings.tuiMode).toBe("fullscreen");
		});

		it("falls back to regular for unsupported and obsolete values", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tuiMode: "other", uiMode: "fullscreen" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getTuiMode()).toBe("regular");
		});
	});

	describe("fullscreen exit output", () => {
		it("defaults to transcript, persists valid modes, and rejects unsupported values", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getFullscreenExitOutput()).toBe("transcript");

			manager.setFullscreenExitOutput("resume-hint");
			await manager.flush();
			expect(manager.getFullscreenExitOutput()).toBe("resume-hint");
			expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")).fullscreenExitOutput).toBe(
				"resume-hint",
			);

			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ fullscreenExitOutput: "nothing" }));
			expect(SettingsManager.create(projectDir, agentDir).getFullscreenExitOutput()).toBe("transcript");
		});
	});

	describe("fullscreen scrollbar", () => {
		it("defaults to auto, persists valid modes, and rejects unsupported values", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getFullscreenScrollbar()).toBe("auto");

			manager.setFullscreenScrollbar("hidden");
			await manager.flush();
			expect(manager.getFullscreenScrollbar()).toBe("hidden");
			expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")).fullscreenScrollbar).toBe("hidden");

			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ fullscreenScrollbar: "sometimes" }));
			expect(SettingsManager.create(projectDir, agentDir).getFullscreenScrollbar()).toBe("auto");
		});
	});

	describe("tools settings", () => {
		it("merges global and project tool settings per tool name", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					tools: {
						websearch: { provider: "brave", apiKey: "global-key" },
						custom: { enabled: true },
					},
				}),
			);
			writeFileSync(
				join(projectDir, ".pi", "settings.json"),
				JSON.stringify({
					tools: {
						websearch: { baseUrl: "https://search.example.test" },
					},
				}),
			);
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getToolSettings("websearch")).toEqual({
				provider: "brave",
				apiKey: "global-key",
				baseUrl: "https://search.example.test",
			});
			expect(manager.getToolSettings("custom")).toEqual({ enabled: true });
		});
	});
	describe("LSP settings", () => {
		it("keeps global and project layers separate instead of shallow-merging them", () => {
			const globalLsp = { servers: [{ id: "global", enabled: false }] };
			const projectLsp = { enabled: false };
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ lsp: globalLsp }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ lsp: projectLsp }));
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getGlobalLspConfiguration()).toEqual(globalLsp);
			expect(manager.getProjectLspConfiguration()).toEqual(projectLsp);
		});
	});
});
