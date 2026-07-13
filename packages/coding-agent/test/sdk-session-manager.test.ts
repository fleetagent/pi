import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@fleetagent/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiAgent } from "../src/core/pi-agent.ts";
import { InMemorySession, InMemorySessionManager } from "../src/core/session-manager.ts";

describe("PiAgent session manager defaults", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses agentDir for the default persisted session path", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const pi = await PiAgent.create({ cwd, agentDir, model: model! });
		const session = await pi.createAgentSession();

		const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const expectedSessionDir = join(agentDir, "sessions", safePath);
		const sessionDir = session.session.getSessionDir();
		const sessionFile = session.session.getSessionReference();

		expect(sessionDir).toBe(expectedSessionDir);
		expect(sessionFile?.startsWith(`${expectedSessionDir}/`)).toBe(true);

		await pi.dispose();
	});

	it("keeps an explicit session override", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionManager = new InMemorySessionManager(cwd).create();
		const pi = await PiAgent.create({
			cwd,
			agentDir,
			model: model!,
			sessionManager: new InMemorySessionManager(cwd),
		});
		const session = await pi.createAgentSession({ session: sessionManager });

		expect(session.session).toBe(sessionManager);
		expect(session.session.isPersisted()).toBe(false);

		await pi.dispose();
	});

	it("creates a new top-level session from an explicit unmanaged session", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const initialSession = new InMemorySession(cwd);
		const pi = await PiAgent.create({
			cwd,
			agentDir,
			model: model!,
			sessionManager: new InMemorySessionManager(cwd),
		});
		const session = await pi.createAgentSession({ session: initialSession });

		const result = await pi.newSession();

		expect(result.cancelled).toBe(false);
		expect(pi.session.session).not.toBe(session.session);
		expect(pi.session.session.getHeader()?.parentSession).toBeUndefined();

		await pi.dispose();
	});

	it("preserves an explicitly assigned parent for a new session", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const pi = await PiAgent.create({
			cwd,
			agentDir,
			model: model!,
			sessionManager: new InMemorySessionManager(cwd),
		});
		await pi.createAgentSession();

		const result = await pi.newSession({ parentSession: "memory:parent" });

		expect(result.cancelled).toBe(false);
		expect(pi.session.session.getHeader()?.parentSession).toBe("memory:parent");

		await pi.dispose();
	});

	it("forks in-memory sessions without mutating the source session", () => {
		const sessionManager = new InMemorySessionManager(cwd);
		const source = sessionManager.create();
		const entryId = source.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });

		const forked = sessionManager.forkSession(source, entryId);

		expect(forked).not.toBe(source);
		expect(forked.getEntries()).toHaveLength(1);
		expect(source.getEntries()).toHaveLength(1);
		expect(forked.getEntry(entryId)).toBeTruthy();
		expect(forked.getHeader()?.parentSession).toBe(source.getSessionReference());
	});

	it("derives cwd from an explicit session when cwd is omitted", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionCwd = join(tempDir, "session-project");
		mkdirSync(sessionCwd, { recursive: true });
		const sessionManager = new InMemorySessionManager(sessionCwd).create();
		const pi = await PiAgent.create({
			agentDir,
			model: model!,
			sessionManager: new InMemorySessionManager(sessionCwd),
		});
		const session = await pi.createAgentSession({ session: sessionManager });

		expect(session.session).toBe(sessionManager);
		expect(session.systemPrompt).toContain(`Current working directory: ${sessionCwd}`);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", { command: "pwd" });
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(realpathSync(output.trim())).toBe(realpathSync(sessionCwd));

		await pi.dispose();
	});
});
