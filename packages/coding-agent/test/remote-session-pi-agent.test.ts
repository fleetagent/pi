import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@fleetagent/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { PiAgent } from "../src/core/pi-agent.ts";
import { RemoteSession } from "../src/core/session/remote-session.ts";
import { RemoteSessionManager } from "../src/core/session/remote-session-manager.ts";
import type { FileEntry, SessionHeader } from "../src/core/session/types.ts";
import { createTestResourceLoader } from "./utilities.ts";

function header(id: string, cwd: string, parentSession?: string): SessionHeader {
	return {
		type: "session",
		version: 3,
		id,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd,
		parentSession,
	};
}

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("PiAgent remote session durability barriers", () => {
	const directories: string[] = [];

	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("flushes active remote entries before requesting a fork snapshot", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-remote-fork-barrier-"));
		directories.push(cwd);
		const sourceId = "source-session";
		const forkId = "fork-session";
		let sourceEntries: FileEntry[] = [header(sourceId, cwd)];
		let etag = 0;
		let gateAppends = false;
		let releaseAppend: () => void = () => undefined;
		let markAppendStarted: () => void = () => undefined;
		let appendGate = Promise.resolve();
		let appendStarted = Promise.resolve();
		let forkRequests = 0;
		const requestOrder: string[] = [];
		const manager = new RemoteSessionManager({
			baseUrl: "https://sessions.example.test",
			token: "secret-token",
			cwd,
			fetch: async (input, init) => {
				const url = String(input);
				const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
				if (url.endsWith("/v1/sessions") && init?.method === "POST") {
					return json({ reference: `remote:${sourceId}`, id: sourceId, entries: sourceEntries, etag: `v${etag}` });
				}
				if (url.endsWith(`/${sourceId}/entries`) && init?.method === "POST") {
					requestOrder.push("append");
					markAppendStarted();
					if (gateAppends) await appendGate;
					const entries = body.entries as FileEntry[];
					sourceEntries = [...sourceEntries, ...entries];
					etag++;
					return json({ accepted: entries.length, etag: `v${etag}` });
				}
				if (url.endsWith(`/${sourceId}/fork`) && init?.method === "POST") {
					requestOrder.push("fork");
					forkRequests++;
					const leafId = body.leafId;
					if (
						typeof leafId !== "string" ||
						!sourceEntries.some((entry) => entry.type !== "session" && entry.id === leafId)
					) {
						return new Response("unknown leaf", { status: 409 });
					}
					return json({
						reference: `remote:${forkId}`,
						id: forkId,
						entries: [header(forkId, cwd, `remote:${sourceId}`), ...structuredClone(sourceEntries.slice(1))],
						etag: "fork-v1",
					});
				}
				throw new Error(`Unexpected remote session request: ${init?.method} ${url}`);
			},
		});
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
			sessionManager: manager,
			resourceLoader: createTestResourceLoader(),
		});
		try {
			const session = await pi.createAgentSession();
			expect(session.session).toBeInstanceOf(RemoteSession);
			await (session.session as RemoteSession).flushPendingSync();

			gateAppends = true;
			appendGate = new Promise<void>((resolve) => {
				releaseAppend = resolve;
			});
			appendStarted = new Promise<void>((resolve) => {
				markAppendStarted = resolve;
			});
			const leafId = session.session.appendMessage({ role: "user", content: "fork me", timestamp: 1 });
			const forking = pi.fork(leafId, { position: "at" });
			await appendStarted;
			expect(forkRequests).toBe(0);
			releaseAppend();
			await expect(forking).resolves.toMatchObject({ cancelled: false });
			expect(requestOrder.slice(-2)).toEqual(["append", "fork"]);
			expect(pi.session.sessionReference).toBe(`remote:${forkId}`);
			expect(pi.session.session.getEntry(leafId)).toBeDefined();
		} finally {
			await pi.dispose();
			faux.unregister();
		}
	});
});
