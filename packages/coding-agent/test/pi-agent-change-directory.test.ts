import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@fleetagent/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { PiAgent } from "../src/core/pi-agent.ts";
import { LocalSessionManager } from "../src/core/session/local-session-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PiAgent.changeDirectory", () => {
	it("rebuilds the active runtime in a new cwd without losing session history", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-change-directory-"));
		tempDirectories.push(cwd);
		const nextCwd = join(cwd, "next");
		mkdirSync(nextCwd);
		const faux = registerFauxProvider();
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const pi = await PiAgent.create({
			cwd,
			agentDir: cwd,
			model,
			authStorage,
			modelRegistry: ModelRegistry.inMemory(authStorage),
			sessionManager: new LocalSessionManager({ cwd }),
			resourceLoader: createTestResourceLoader(),
		});

		try {
			const session = await pi.createAgentSession();
			session.session.appendMessage({ role: "user", content: "keep me", timestamp: 1 });
			const sessionReference = session.sessionReference;

			pi.setBeforeSessionInvalidate(() => {
				throw new Error("replacement blocked");
			});
			await expect(pi.changeDirectory(nextCwd)).rejects.toThrow("replacement blocked");
			expect(pi.currentCwd).toBe(cwd);
			expect(pi.session.session.getCwd()).toBe(cwd);
			pi.setBeforeSessionInvalidate();

			await pi.changeDirectory(nextCwd);

			expect(pi.currentCwd).toBe(nextCwd);
			expect(pi.session.sessionReference).toBe(sessionReference);
			expect(pi.session.messages).toContainEqual({ role: "user", content: "keep me", timestamp: 1 });
		} finally {
			await pi.dispose();
			faux.unregister();
		}
	});
});
