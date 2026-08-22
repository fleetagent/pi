import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@fleetagent/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_SESSION_VERSION } from "../../src/core/session/constants.ts";
import { JsonlSessionError } from "../../src/core/session/jsonl-errors.ts";
import { LocalSessionManager } from "../../src/core/session/local-session-manager.ts";
import {
	JsonlSessionStore,
	type JsonlStoreWriteOperations,
	publishJsonlAtomically,
} from "../../src/core/session/stores/jsonl-session-store.ts";
import type { SessionEntry, SessionHeader, SessionMessageEntry } from "../../src/core/session/types.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = join(tmpdir(), `pi-atomic-jsonl-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

function createHeader(cwd: string): SessionHeader {
	return {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "session-1",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd,
	};
}

function createUserEntry(id: string, parentId: string | null = null): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", content: id, timestamp: 1 },
	};
}

function createAssistantMessage(id: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text: id }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

function createAssistantEntry(id: string, parentId: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:02.000Z",
		message: createAssistantMessage(id),
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("atomic JSONL publication", () => {
	it("preserves an existing destination and cleans its unique temp after rename failure", () => {
		const dir = createTempDir();
		const filePath = join(dir, "session.jsonl");
		writeFileSync(filePath, "original\n");
		const failure = Object.assign(new Error("injected rename failure"), { code: "EBUSY" });

		let error: unknown;
		try {
			publishJsonlAtomically(filePath, [createHeader(dir)], {
				platform: "linux",
				rename: () => {
					throw failure;
				},
			});
		} catch (cause) {
			error = cause;
		}
		expect(error).toBeInstanceOf(JsonlSessionError);
		expect(error).toMatchObject({ phase: "replace", reference: filePath, outcome: "unknown", cause: failure });
		expect(readFileSync(filePath, "utf8")).toBe("original\n");
		expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
	});

	it("preserves the primary publication error when temp cleanup also fails", () => {
		const dir = createTempDir();
		const filePath = join(dir, "session.jsonl");
		expect(() =>
			publishJsonlAtomically(filePath, [createHeader(dir)], {
				platform: "linux",
				rename: () => {
					throw new Error("primary rename failure");
				},
				remove: () => {
					throw new Error("secondary cleanup failure");
				},
			}),
		).toThrow("primary rename failure");
		expect(readdirSync(dir).some((name) => name.includes(".tmp-"))).toBe(true);
		expect(readdirSync(dir).some((name) => name.endsWith(".jsonl"))).toBe(false);
	});

	it("retries bounded Windows sharing failures only during rename", () => {
		const dir = createTempDir();
		const filePath = join(dir, "session.jsonl");
		let attempts = 0;
		publishJsonlAtomically(filePath, [createHeader(dir)], {
			platform: "win32",
			rename: (source, destination) => {
				attempts++;
				if (attempts < 3) throw Object.assign(new Error("sharing violation"), { code: "EBUSY" });
				renameSync(source, destination);
			},
		});
		expect(attempts).toBe(3);
		expect(JSON.parse(readFileSync(filePath, "utf8").trim())).toMatchObject({ id: "session-1" });
	});

	it.skipIf(process.platform === "win32")("rejects replacing a symlink destination", () => {
		const dir = createTempDir();
		const target = join(dir, "missing-target.jsonl");
		const link = join(dir, "session.jsonl");
		symlinkSync(target, link);
		expect(existsSync(link)).toBe(false);
		expect(() => publishJsonlAtomically(link, [createHeader(dir)])).toThrow("Refusing to replace non-file");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
	});

	it("does not commit the first assistant in memory when initial publication fails", () => {
		const dir = createTempDir();
		const filePath = join(dir, "session.jsonl");
		const operations: JsonlStoreWriteOperations = {
			append: () => {
				throw new Error("append should not run");
			},
			publish: () => {
				throw new Error("injected publication failure");
			},
		};
		const store = new JsonlSessionStore(undefined, operations);
		const user = createUserEntry("user-1");
		store.setSessionReference(filePath);
		store.setEntries([createHeader(dir), user]);

		expect(() => store.appendEntry(createAssistantEntry("assistant-1", user.id))).toThrow(
			expect.objectContaining({
				code: "storage",
				phase: "create",
				reference: filePath,
				outcome: "unknown",
			}),
		);
		expect(store.getEntries().map((entry) => entry.id)).toEqual([user.id]);
		expect(existsSync(filePath)).toBe(false);
		expect(() => store.appendEntry(createAssistantEntry("assistant-2", user.id))).toThrow("writes are fenced");
		store.setSessionReference(filePath);
		expect(() => store.appendEntry(createAssistantEntry("assistant-3", user.id))).toThrow("writes are fenced");
	});

	it("preserves typed delayed-fork publication phase and outcome", () => {
		const dir = createTempDir();
		const filePath = join(dir, "fork.jsonl");
		const failure = new JsonlSessionError({
			code: "storage",
			reference: filePath,
			phase: "fork",
			message: "fork staging failed",
			outcome: "not_written",
		});
		const operations: JsonlStoreWriteOperations = {
			append: () => {
				throw new Error("append should not run");
			},
			publish: () => {
				throw failure;
			},
		};
		const store = new JsonlSessionStore(undefined, operations);
		const user = createUserEntry("user-1");
		store.setSessionReference(filePath);
		store.setEntries([{ ...createHeader(dir), parentSession: "/parent.jsonl" }, user]);
		expect(() => store.appendEntry(createAssistantEntry("assistant-1", user.id))).toThrow(
			expect.objectContaining({
				phase: "fork",
				reference: filePath,
				outcome: "not_written",
			}),
		);
	});

	it("does not fence deterministic serialization failures before append", () => {
		const dir = createTempDir();
		const filePath = join(dir, "session.jsonl");
		const user = createUserEntry("user-1");
		const assistant = createAssistantEntry("assistant-1", user.id);
		publishJsonlAtomically(filePath, [createHeader(dir), user, assistant]);
		let appendCalls = 0;
		const operations: JsonlStoreWriteOperations = {
			append: (path, serializedEntry) => {
				appendCalls++;
				appendFileSync(path, serializedEntry);
			},
			publish: publishJsonlAtomically,
		};
		const store = new JsonlSessionStore(undefined, operations);
		store.setSessionReference(filePath);
		store.setEntries(store.load(filePath));
		const circular: { self?: unknown } = {};
		circular.self = circular;
		const invalid: SessionEntry = {
			type: "custom",
			id: "custom-1",
			parentId: assistant.id,
			timestamp: "2026-01-01T00:00:03.000Z",
			customType: "circular",
			data: circular,
		};
		expect(() => store.appendEntry(invalid)).toThrow();
		store.appendEntry(createUserEntry("user-2", assistant.id));
		expect(appendCalls).toBe(1);
		expect(store.getEntries().at(-1)?.id).toBe("user-2");
	});

	it("continues after an append failure classified as definitely not written", () => {
		const dir = createTempDir();
		const filePath = join(dir, "definite.jsonl");
		const user = createUserEntry("user-1");
		const assistant = createAssistantEntry("assistant-1", user.id);
		publishJsonlAtomically(filePath, [createHeader(dir), user, assistant]);
		let fail = true;
		const operations: JsonlStoreWriteOperations = {
			append: (path, serializedEntry) => {
				if (fail) {
					fail = false;
					throw Object.assign(new Error("definitely not written"), { code: "EACCES" });
				}
				appendFileSync(path, serializedEntry);
			},
			publish: publishJsonlAtomically,
		};
		const store = new JsonlSessionStore(undefined, operations);
		store.setSessionReference(filePath);
		store.setEntries(store.load(filePath));
		const next = createUserEntry("user-2", assistant.id);
		expect(() => store.appendEntry(next)).toThrow(
			expect.objectContaining({
				code: "storage",
				phase: "append",
				reference: filePath,
				outcome: "not_written",
			}),
		);
		expect(() => store.appendEntry(next)).not.toThrow();
		expect(store.getEntries().at(-1)?.id).toBe(next.id);
	});

	it("reports the physical append line and byte offset after preserved blank records", () => {
		const dir = createTempDir();
		const filePath = join(dir, "typed-append.jsonl");
		const user = createUserEntry("user-1");
		const assistant = createAssistantEntry("assistant-1", user.id);
		const prefix = `${JSON.stringify(createHeader(dir))}\n\n${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`;
		writeFileSync(filePath, prefix);
		const store = new JsonlSessionStore();
		store.setSessionReference(filePath);
		store.setEntries(store.load(filePath));
		expect(() => store.appendEntry({ ...createUserEntry("bad-parent"), parentId: "missing" })).toThrow(
			expect.objectContaining({
				phase: "append",
				line: 5,
				byteOffset: Buffer.byteLength(prefix),
				decodeKind: "state",
			}),
		);
	});

	it("fences an ambiguous append without advancing persisted memory", () => {
		const dir = createTempDir();
		const filePath = join(dir, "session.jsonl");
		const user = createUserEntry("user-1");
		const assistant = createAssistantEntry("assistant-1", user.id);
		publishJsonlAtomically(filePath, [createHeader(dir), user, assistant]);
		let appendCalls = 0;
		let failAfterWrite = true;
		const operations: JsonlStoreWriteOperations = {
			append: (path, serializedEntry) => {
				appendCalls++;
				appendFileSync(path, serializedEntry);
				if (failAfterWrite) throw new Error("write completed but acknowledgement failed");
			},
			publish: publishJsonlAtomically,
		};
		const store = new JsonlSessionStore(undefined, operations);
		store.setSessionReference(filePath);
		store.setEntries(store.load(filePath));
		const next = createUserEntry("user-2", assistant.id);
		expect(() => store.appendEntry(next)).toThrow(
			expect.objectContaining({
				code: "storage",
				phase: "append",
				reference: filePath,
				outcome: "unknown",
			}),
		);
		expect(store.getEntries().map((entry) => entry.id)).toEqual([user.id, assistant.id]);
		expect(readFileSync(filePath, "utf8").match(/"id":"user-2"/g)).toHaveLength(1);
		expect(() => store.appendEntry({ ...next, id: "user-3" })).toThrow(
			expect.objectContaining({
				code: "fenced",
				phase: "append",
				reference: filePath,
				outcome: "unknown",
			}),
		);
		expect(appendCalls).toBe(1);
		failAfterWrite = false;
		store.setEntries(store.load(filePath));
		expect(store.getEntries().map((entry) => entry.id)).toEqual([user.id, assistant.id, next.id]);
		store.appendEntry({ ...next, id: "user-3", parentId: next.id });
		expect(readFileSync(filePath, "utf8").match(/"id":"user-2"/g)).toHaveLength(1);
		expect(store.getEntries().at(-1)?.id).toBe("user-3");
	});

	it("updates append locations after repairing a missing final newline", () => {
		const dir = createTempDir();
		const filePath = join(dir, "typed-append-repaired.jsonl");
		const user = createUserEntry("user-1");
		const assistant = createAssistantEntry("assistant-1", user.id);
		const original = `${JSON.stringify(createHeader(dir))}\n${JSON.stringify(user)}\n${JSON.stringify(assistant)}`;
		writeFileSync(filePath, original);
		const store = new JsonlSessionStore();
		store.setSessionReference(filePath);
		store.setEntries(store.load(filePath));
		expect(() => store.appendEntry({ ...createUserEntry("bad-parent"), parentId: "missing" })).toThrow(
			expect.objectContaining({
				phase: "append",
				line: 4,
				byteOffset: Buffer.byteLength(original) + 1,
				decodeKind: "state",
			}),
		);
	});

	it("forks through a target session without mutating source memory or bytes", () => {
		const dir = createTempDir();
		const manager = new LocalSessionManager({ cwd: dir, sessionDir: dir });
		const source = manager.create();
		const userId = source.appendMessage({ role: "user", content: "one", timestamp: 1 });
		const assistantId = source.appendMessage(createAssistantMessage("assistant-1"));
		const sourceReference = source.getSessionReference();
		if (!sourceReference) throw new Error("expected source reference");
		const sourceBytes = readFileSync(sourceReference, "utf8");
		const sourceEntries = source.getEntries();

		const fork = manager.forkSession(source, assistantId);
		expect(source.getSessionReference()).toBe(sourceReference);
		expect(source.getEntries()).toEqual(sourceEntries);
		expect(readFileSync(sourceReference, "utf8")).toBe(sourceBytes);
		expect(fork.getSessionReference()).not.toBe(sourceReference);
		expect(fork.getEntries().map((entry) => entry.id)).toEqual([userId, assistantId]);
		expect(existsSync(fork.getSessionReference()!)).toBe(true);
	});

	it("keeps header-only and user-only forks memory-only", () => {
		const dir = createTempDir();
		const manager = new LocalSessionManager({ cwd: dir, sessionDir: dir });
		const source = manager.create();
		const userId = source.appendMessage({ role: "user", content: "one", timestamp: 1 });
		source.appendMessage(createAssistantMessage("assistant-1"));
		const sourceReference = source.getSessionReference();
		if (!sourceReference) throw new Error("expected source reference");
		const sourceBytes = readFileSync(sourceReference, "utf8");

		const fork = manager.forkSession(source, userId);
		expect(fork.getEntries().map((entry) => entry.id)).toEqual([userId]);
		expect(fork.getSessionReference()).toBeDefined();
		expect(existsSync(fork.getSessionReference()!)).toBe(false);
		expect(readFileSync(sourceReference, "utf8")).toBe(sourceBytes);
	});

	it("forks an unpublished user-only source without attempting to reload it", () => {
		const dir = createTempDir();
		const manager = new LocalSessionManager({ cwd: dir, sessionDir: dir });
		const source = manager.create();
		const userId = source.appendMessage({ role: "user", content: "one", timestamp: 1 });
		const sourceReference = source.getSessionReference();
		if (!sourceReference) throw new Error("expected source reference");
		expect(existsSync(sourceReference)).toBe(false);

		const fork = manager.forkSession(source, userId);
		expect(source.getSessionReference()).toBe(sourceReference);
		expect(source.getEntries().map((entry) => entry.id)).toEqual([userId]);
		expect(fork.getEntries().map((entry) => entry.id)).toEqual([userId]);
		expect(fork.getSessionReference()).toBeDefined();
		expect(existsSync(fork.getSessionReference()!)).toBe(false);
	});

	it("validates explicit ids before creating delayed session state", () => {
		const dir = createTempDir();
		const manager = new LocalSessionManager({ cwd: dir, sessionDir: dir });
		expect(() => manager.create({ id: "../escape" })).toThrow("Session id must");
		expect(() => manager.create({ id: "valid-after-rejection" })).not.toThrow();
	});

	it("rejects delayed first publication for a duplicate canonical cwd and id", () => {
		const dir = createTempDir();
		const manager = new LocalSessionManager({ cwd: join(dir, "workspace"), sessionDir: dir });
		const first = manager.create({ id: "claimed-session" });
		const second = manager.create({ id: "claimed-session" });
		first.appendMessage({ role: "user", content: "first", timestamp: 1 });
		second.appendMessage({ role: "user", content: "second", timestamp: 1 });
		first.appendMessage(createAssistantMessage("first-assistant"));
		expect(() => second.appendMessage(createAssistantMessage("second-assistant"))).toThrow(
			expect.objectContaining({ code: "already_exists" }),
		);
		expect(second.getEntries()).toHaveLength(1);
		expect(readdirSync(dir).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
	});

	it("does not treat a generated zero-byte destination as explicit empty-file initialization", () => {
		const dir = createTempDir();
		const manager = new LocalSessionManager({ cwd: dir, sessionDir: dir });
		const session = manager.create({ id: "zero-byte-conflict" });
		const reference = session.getSessionReference();
		if (!reference) throw new Error("expected session reference");
		writeFileSync(reference, "");
		session.appendMessage({ role: "user", content: "one", timestamp: 1 });
		expect(() => session.appendMessage(createAssistantMessage("one"))).toThrow(
			expect.objectContaining({ code: "already_exists" }),
		);
		expect(readFileSync(reference, "utf8")).toBe("");
	});

	it.each(["create", "fork"] as const)("releases a manager publication claim after failed %s", (kind) => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const dir = createTempDir();
			const manager = new LocalSessionManager({ cwd: dir, sessionDir: dir });
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const source = manager.create({ id: "source-session" });
			source.appendMessage({ role: "user", content: "source", timestamp: 1 });
			const sourceLeaf = source.appendMessage(createAssistantMessage("source"));
			vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
			const createTarget = () => {
				const target = manager.create({ id: "retry-session", parentSession: source.getSessionReference() });
				if (kind === "fork") target.copyBranchFrom(source, sourceLeaf, source.getSessionReference());
				else {
					target.appendMessage({ role: "user", content: "target", timestamp: 1 });
					target.appendMessage(createAssistantMessage("target"));
				}
				return target;
			};
			const failedTarget = manager.create({ id: "retry-session", parentSession: source.getSessionReference() });
			const reference = failedTarget.getSessionReference();
			if (!reference) throw new Error("expected target reference");
			mkdirSync(reference);
			expect(() => {
				if (kind === "fork") failedTarget.copyBranchFrom(source, sourceLeaf, source.getSessionReference());
				else {
					failedTarget.appendMessage({ role: "user", content: "target", timestamp: 1 });
					failedTarget.appendMessage(createAssistantMessage("target"));
				}
			}).toThrow(expect.objectContaining({ code: "already_exists" }));
			rmSync(reference, { recursive: true });
			expect(() => createTarget()).not.toThrow();
			expect(existsSync(reference)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		["create", "fork"],
		["fork", "fork"],
	] as const)("shares publication claims across %s/%s targets", (firstKind, secondKind) => {
		const dir = createTempDir();
		const manager = new LocalSessionManager({ cwd: dir, sessionDir: dir });
		const source = manager.create({ id: "source-session" });
		source.appendMessage({ role: "user", content: "one", timestamp: 1 });
		const assistantId = source.appendMessage(createAssistantMessage("source-assistant"));
		const createTarget = (kind: "create" | "fork") => {
			const target = manager.create({ id: "claimed-session", parentSession: source.getSessionReference() });
			if (kind === "fork") target.copyBranchFrom(source, assistantId, source.getSessionReference());
			else {
				target.appendMessage({ role: "user", content: "target", timestamp: 1 });
				target.appendMessage(createAssistantMessage("target-assistant"));
			}
			return target;
		};

		createTarget(firstKind);
		expect(() => createTarget(secondKind)).toThrow(expect.objectContaining({ code: "already_exists" }));
		expect(
			readdirSync(dir).filter((name) => name.endsWith(".jsonl") && name.includes("claimed-session")),
		).toHaveLength(1);
	});

	it("allows one explicit id in different canonical cwd namespaces sharing a directory", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const dir = createTempDir();
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			const first = new LocalSessionManager({ cwd: join(dir, "one"), sessionDir: dir }).create({
				id: "shared-session",
			});
			first.appendMessage({ role: "user", content: "one", timestamp: 1 });
			first.appendMessage(createAssistantMessage("one"));
			vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
			const second = new LocalSessionManager({ cwd: join(dir, "two"), sessionDir: dir }).create({
				id: "shared-session",
			});
			second.appendMessage({ role: "user", content: "two", timestamp: 1 });
			second.appendMessage(createAssistantMessage("two"));
			expect(readdirSync(dir).filter((name) => name.endsWith(".jsonl"))).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("detects a logical id published by another manager owner", () => {
		const dir = createTempDir();
		const cwd = join(dir, "workspace");
		const first = new LocalSessionManager({ cwd, sessionDir: dir }).create({ id: "external-session" });
		first.appendMessage({ role: "user", content: "one", timestamp: 1 });
		first.appendMessage(createAssistantMessage("one"));
		const second = new LocalSessionManager({ cwd: join(cwd, "child", ".."), sessionDir: dir }).create({
			id: "external-session",
		});
		second.appendMessage({ role: "user", content: "two", timestamp: 1 });
		expect(() => second.appendMessage(createAssistantMessage("two"))).toThrow(
			expect.objectContaining({ code: "already_exists" }),
		);
	});

	it("reports an already-published logical id collision across OS processes", () => {
		const dir = createTempDir();
		const cwd = join(dir, "workspace");
		const first = new LocalSessionManager({ cwd, sessionDir: dir }).create({ id: "process-session" });
		first.appendMessage({ role: "user", content: "one", timestamp: 1 });
		first.appendMessage(createAssistantMessage("one"));
		const child = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				fileURLToPath(new URL("./session-create-child.ts", import.meta.url)),
				dir,
				cwd,
				"process-session",
			],
			{ encoding: "utf8" },
		);
		expect(child.status, child.stderr).toBe(0);
		expect(child.stdout).toBe("already_exists");
	});
});
