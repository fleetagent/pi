import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemorySessionManager, LocalSessionManager } from "../../src/core/session-manager.ts";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("SessionManager.newSession with custom id", () => {
	it("uses the provided id instead of generating one", () => {
		const session = new InMemorySessionManager().create();
		session.newSession({ id: "my-custom-id" });
		expect(session.getSessionId()).toBe("my-custom-id");
	});

	it("generates a UUIDv7 id when no id is provided", () => {
		const session = new InMemorySessionManager().create();
		session.newSession();
		const id = session.getSessionId();
		expect(id).toBeDefined();
		expect(id).not.toBe("");
		expect(id).toMatch(UUID_V7_RE);
	});

	it("generates a UUIDv7 id when options is provided without id", () => {
		const session = new InMemorySessionManager().create();
		session.newSession({ parentSession: "parent.jsonl" });
		const id = session.getSessionId();
		expect(id).toBeDefined();
		expect(id).not.toBe("");
		expect(id).toMatch(UUID_V7_RE);
	});

	it("includes the custom id in the session header", () => {
		const session = new InMemorySessionManager().create();
		session.newSession({ id: "header-test-id" });

		const header = session.getHeader();
		expect(header).not.toBeNull();
		expect(header!.id).toBe("header-test-id");
	});

	it("generates a UUIDv7 id when constructed without an explicit id", () => {
		const session = new InMemorySessionManager().create();
		expect(session.getSessionId()).toMatch(UUID_V7_RE);
		expect(session.getHeader()!.id).toBe(session.getSessionId());
	});

	it("generates a UUIDv7 id when creating a branched session", () => {
		const session = new InMemorySessionManager().create();
		const firstId = session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now(),
		});

		session.createBranchedSession(firstId);

		expect(session.getSessionId()).toMatch(UUID_V7_RE);
		expect(session.getHeader()!.id).toBe(session.getSessionId());
	});

	it("generates a UUIDv7 id when forking from another session file", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-manager-"));
		const sourcePath = join(tempDir, "source.jsonl");
		writeFileSync(
			sourcePath,
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "legacy-session-id",
					timestamp: new Date().toISOString(),
					cwd: tempDir,
				}),
				JSON.stringify({
					type: "message",
					id: "entry-1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: {
						role: "assistant",
						content: [{ type: "text", text: "hello" }],
						api: "openai-responses",
						provider: "openai",
						model: "gpt-5.4",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
				}),
			].join("\n")}
`,
		);

		const forked = new LocalSessionManager({ cwd: tempDir, sessionDir: tempDir }).forkFrom(sourcePath);
		const header = forked.getHeader();
		expect(header).not.toBeNull();
		expect(header!.id).toMatch(UUID_V7_RE);
		expect(header!.parentSession).toBe(sourcePath);
	});
});
