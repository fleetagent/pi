/**
 * Tests for AgentSession forking behavior.
 *
 * These tests verify:
 * - Forking from a single message works
 * - Forking in --no-session mode (in-memory only)
 * - getUserMessagesForForking returns correct entries
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@fleetagent/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { PiAgent } from "../src/core/pi-agent.ts";
import { InMemorySessionManager, LocalSessionManager, type Session } from "../src/core/session-manager.ts";
import { API_KEY } from "./utilities.ts";

describe.skipIf(!API_KEY)("AgentSession forking", () => {
	let session: AgentSession;
	let runtimeHost: PiAgent;
	let tempDir: string;
	let sessionManager: Session;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-branching-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (runtimeHost) {
			await runtimeHost.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(noSession: boolean = false) {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		sessionManager = noSession
			? new InMemorySessionManager(tempDir).create()
			: new LocalSessionManager({ cwd: tempDir }).create();
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", API_KEY!);

		runtimeHost = await PiAgent.create({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			sessionManager: noSession ? new InMemorySessionManager(tempDir) : new LocalSessionManager({ cwd: tempDir }),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
			resolveSessionOptions: () => ({
				model,
				tools: ["read", "bash", "edit", "write"],
			}),
		});
		session = await runtimeHost.createAgentSession({ session: sessionManager });
		session.subscribe(() => {});
		return session;
	}

	it("should allow forking from single message", async () => {
		await createSession();

		await session.prompt("Say hello");
		await session.agent.waitForIdle();

		const userMessages = session.getUserMessagesForForking();
		expect(userMessages.length).toBe(1);
		expect(userMessages[0].text).toBe("Say hello");

		const result = await runtimeHost.fork(userMessages[0].entryId);
		expect(result.cancelled).toBe(false);
		session = runtimeHost.session;
		expect(result.selectedText).toBe("Say hello");

		expect(session.messages.length).toBe(0);
		expect(session.sessionFile).not.toBeNull();
		expect(existsSync(session.sessionFile!)).toBe(false);
	});

	it("should support in-memory forking in --no-session mode", async () => {
		await createSession(true);

		expect(session.sessionFile).toBeUndefined();

		await session.prompt("Say hi");
		await session.agent.waitForIdle();

		const userMessages = session.getUserMessagesForForking();
		expect(userMessages.length).toBe(1);
		expect(session.messages.length).toBeGreaterThan(0);

		const result = await runtimeHost.fork(userMessages[0].entryId);
		expect(result.cancelled).toBe(false);
		session = runtimeHost.session;
		expect(result.selectedText).toBe("Say hi");

		expect(session.messages.length).toBe(0);
		expect(session.sessionFile).toBeUndefined();
	});

	it("should fork from middle of conversation", async () => {
		await createSession();

		await session.prompt("Say one");
		await session.agent.waitForIdle();

		await session.prompt("Say two");
		await session.agent.waitForIdle();

		await session.prompt("Say three");
		await session.agent.waitForIdle();

		const userMessages = session.getUserMessagesForForking();
		expect(userMessages.length).toBe(3);

		const secondMessage = userMessages[1];
		const result = await runtimeHost.fork(secondMessage.entryId);
		expect(result.cancelled).toBe(false);
		session = runtimeHost.session;
		expect(result.selectedText).toBe("Say two");

		expect(session.messages.length).toBe(2);
		expect(session.messages[0].role).toBe("user");
		expect(session.messages[1].role).toBe("assistant");
	}, 60000);
});
