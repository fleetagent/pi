import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiAgent } from "../../../src/core/pi-agent.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { InMemorySessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

describe("regression #3592: no-builtin-tools keeps extension tools enabled", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-no-builtin-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(options?: { noTools?: "all" | "builtin"; tools?: string[] }) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = new InMemorySessionManager(tempDir).create();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Tool registered from session_start",
							promptSnippet: "Run dynamic test behavior",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const pi = await PiAgent.create({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: new InMemorySessionManager(tempDir),
			resourceLoader,
			noTools: options?.noTools,
			tools: options?.tools,
		});
		const session = await pi.createAgentSession({ session: sessionManager });
		await session.bindExtensions({});
		return session;
	}

	it("keeps extension tools active when built-in defaults are disabled", async () => {
		const session = await createSession({ noTools: "builtin" });

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual(["bash", "dynamic_tool", "edit", "find", "grep", "ls", "read", "write"]);
		expect(session.getActiveToolNames()).toEqual(["dynamic_tool"]);
		expect(session.systemPrompt).toContain("- dynamic_tool: Run dynamic test behavior");
		expect(session.systemPrompt).not.toContain("- read:");
		expect(session.systemPrompt).not.toContain("- bash:");
		session.dispose();
	});

	it("still disables all tools when noTools is all", async () => {
		const session = await createSession({ noTools: "all" });

		expect(session.getAllTools()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual([]);
		expect(session.systemPrompt).toContain("Available tools:\n(none)");
		session.dispose();
	});

	it("propagates noTools through direct session creation", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = new InMemorySessionManager(tempDir).create();

		const pi = await PiAgent.create({
			cwd: tempDir,
			agentDir,
			settingsManager,
			sessionManager: new InMemorySessionManager(tempDir),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			noTools: "builtin",
		});
		const session = await pi.createAgentSession({ session: sessionManager });

		expect(session.getActiveToolNames()).toEqual([]);
		expect(session.systemPrompt).toContain("Available tools:\n(none)");
		expect(session.systemPrompt).not.toContain("- read:");
		session.dispose();
	});
});
