import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionStorage, loadJsonlSessionMetadata } from "../../src/harness/session/jsonl-storage.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import {
	err,
	FileError,
	type FileSystem,
	type MessageEntry,
	ok,
	type SessionMetadata,
} from "../../src/harness/types.ts";
import { JsonlDecodeError, JsonlSessionError } from "../../src/index.ts";
import { createAssistantMessage, createTempDir, createUserMessage } from "./session-test-utils.ts";

describe("InMemorySessionStorage", () => {
	it("returns configured session metadata", async () => {
		const metadata: SessionMetadata = { id: "session-1", createdAt: "2026-01-01T00:00:00.000Z" };
		const storage = new InMemorySessionStorage({ metadata });
		expect(await storage.getMetadata()).toEqual(metadata);
	});

	it("copies initial entries and persists leaf changes", async () => {
		const entry: MessageEntry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		};
		const initialEntries = [entry];
		const storage = new InMemorySessionStorage({ entries: initialEntries });
		initialEntries.push({ ...entry, id: "entry-2" });
		expect((await storage.getEntries()).map((storedEntry) => storedEntry.id)).toEqual(["entry-1"]);
		expect(await storage.getLeafId()).toBe("entry-1");
		await storage.setLeafId(null);
		expect(await storage.getLeafId()).toBeNull();
		expect((await storage.getEntries()).at(-1)).toMatchObject({ type: "leaf", targetId: null });
	});

	it("rejects invalid leaf ids", async () => {
		const storage = new InMemorySessionStorage();
		await expect(storage.setLeafId("missing")).rejects.toThrow("Entry missing not found");
	});

	it("finds entries by type", async () => {
		const entry: MessageEntry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		};
		const storage = new InMemorySessionStorage({ entries: [entry] });
		expect((await storage.findEntries("message")).map((found) => found.id)).toEqual(["entry-1"]);
		expect(await storage.findEntries("session_info")).toEqual([]);
	});

	it("maintains label lookup", async () => {
		const entry: MessageEntry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		};
		const storage = new InMemorySessionStorage({ entries: [entry] });
		expect(await storage.getLabel("entry-1")).toBeUndefined();
		await storage.appendEntry({
			type: "label",
			id: "label-1",
			parentId: "entry-1",
			timestamp: "2026-01-01T00:00:01.000Z",
			targetId: "entry-1",
			label: "checkpoint",
		});
		expect(await storage.getLabel("entry-1")).toBe("checkpoint");
		await storage.appendEntry({
			type: "label",
			id: "label-2",
			parentId: "label-1",
			timestamp: "2026-01-01T00:00:02.000Z",
			targetId: "entry-1",
			label: undefined,
		});
		expect(await storage.getLabel("entry-1")).toBeUndefined();
	});

	it("walks paths to root", async () => {
		const root: MessageEntry = {
			type: "message",
			id: "root",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("root"),
		};
		const child: MessageEntry = {
			...root,
			id: "child",
			parentId: "root",
			message: createAssistantMessage("child"),
		};
		const storage = new InMemorySessionStorage({ entries: [root, child] });
		expect((await storage.getPathToRoot("child")).map((entry) => entry.id)).toEqual(["root", "child"]);
		expect(await storage.getPathToRoot(null)).toEqual([]);
	});
});

describe("JsonlSessionStorage", () => {
	it("throws for missing files when opening", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		await expect(JsonlSessionStorage.open(env, filePath)).rejects.toMatchObject({ code: "not_found" });
	});

	it("rejects an existing exact destination without changing its bytes", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		writeFileSync(filePath, "malformed existing session\n");
		await expect(
			JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" }),
		).rejects.toMatchObject({ code: "already_exists" });
		expect(readFileSync(filePath, "utf8")).toBe("malformed existing session\n");
	});

	it("writes the header on create", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" });
		expect(existsSync(filePath)).toBe(true);
		expect(readFileSync(filePath, "utf8").trim().split("\n")).toHaveLength(1);
		expect(await storage.getLeafId()).toBeNull();
		expect(await storage.getEntries()).toEqual([]);
		await storage.appendEntry({
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		});
		const lines = readFileSync(filePath, "utf8").trim().split("\n");
		expect(JSON.parse(lines[0]!).type).toBe("session");
		expect(JSON.parse(lines[1]!).id).toBe("user-1");
		expect(lines).toHaveLength(2);
	});

	it("cleans unique staging files and leaves no final file when publication fails", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const fs = new Proxy(env, {
			get(target, property) {
				if (property === "renameFile") {
					return async (_source: string, destination: string) =>
						err(new FileError("unknown", "injected rename failure", destination));
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as FileSystem;
		const filePath = join(dir, "session.jsonl");
		const creation = JsonlSessionStorage.create(fs, filePath, { cwd: dir, sessionId: "session-1" });
		await expect(creation).rejects.toMatchObject({
			phase: "create",
			reference: filePath,
			outcome: "unknown",
		});
		await expect(creation).rejects.toThrow("injected rename failure");
		expect(existsSync(filePath)).toBe(false);
		expect(readdirSync(dir).filter((name) => name.includes("session.jsonl") && name.endsWith(".tmp"))).toEqual([]);
	});

	it("fences writes after an outcome-ambiguous append failure", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		await JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" });
		let appendCalls = 0;
		const fs = new Proxy(env, {
			get(target, property) {
				if (property === "appendFile") {
					return async (path: string, content: string | Uint8Array) => {
						appendCalls++;
						const result = await target.appendFile(path, content);
						if (!result.ok) return result;
						return err(new FileError("unknown", "write completed but acknowledgement failed", path));
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as FileSystem;
		const storage = await JsonlSessionStorage.open(fs, filePath);
		const first: MessageEntry = {
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		};
		await expect(storage.appendEntry(first)).rejects.toMatchObject({
			code: "storage",
			phase: "append",
			reference: filePath,
			outcome: "unknown",
		});
		expect(await storage.getEntries()).toEqual([]);
		expect(readFileSync(filePath, "utf8")).toContain('"id":"user-1"');
		await expect(storage.appendEntry({ ...first, id: "user-2" })).rejects.toMatchObject({
			code: "storage",
			phase: "append",
			reference: filePath,
			outcome: "unknown",
		});
		expect(appendCalls).toBe(1);
	});

	it("reconciles an ambiguous completed append through authoritative reopen", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		await JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" });
		const fs = new Proxy(env, {
			get(target, property) {
				if (property === "appendFile") {
					return async (path: string, content: string | Uint8Array) => {
						const result = await target.appendFile(path, content);
						return result.ok ? err(new FileError("unknown", "ambiguous", path)) : result;
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as FileSystem;
		const first = await JsonlSessionStorage.open(fs, filePath);
		const entry: MessageEntry = {
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		};
		await expect(first.appendEntry(entry)).rejects.toThrow("ambiguous");
		const reconciled = await JsonlSessionStorage.open(env, filePath);
		expect((await reconciled.getEntries()).map((stored) => stored.id)).toEqual(["user-1"]);
		await reconciled.appendEntry({
			...entry,
			id: "assistant-1",
			parentId: "user-1",
			message: createAssistantMessage("two"),
		});
		expect((await JsonlSessionStorage.open(env, filePath)).getEntries()).resolves.toHaveLength(2);
	});

	it("continues the append queue after a definitely-not-written failure", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "definite.jsonl");
		await JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" });
		let fail = true;
		const fs = new Proxy(env, {
			get(target, property) {
				if (property === "appendFile") {
					return async (path: string, content: string | Uint8Array) => {
						if (fail) {
							fail = false;
							return err(new FileError("permission_denied", "definitely not written", path));
						}
						return target.appendFile(path, content);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as FileSystem;
		const storage = await JsonlSessionStorage.open(fs, filePath);
		const entry: MessageEntry = {
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			message: createUserMessage("one"),
		};
		await expect(storage.appendEntry(entry)).rejects.toMatchObject({
			code: "storage",
			phase: "append",
			reference: filePath,
			outcome: "not_written",
		});
		await expect(storage.appendEntry(entry)).resolves.toBeUndefined();
		expect((await JsonlSessionStorage.open(env, filePath)).getEntries()).resolves.toHaveLength(1);
	});

	it("repairs only an unterminated final syntax or UTF-8 fragment", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		for (const [name, tail] of [
			["syntax", Buffer.from('{"type":"message"')],
			["utf8", Buffer.from([0xc3])],
		] as const) {
			const filePath = join(dir, `${name}.jsonl`);
			const header = `${JSON.stringify({ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00Z", cwd: dir })}\r\n`;
			const entry = `${JSON.stringify({ type: "message", id: "one", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: createUserMessage("one") })}\r\n`;
			const prefix = Buffer.from(`${header}  \r\n${entry}`);
			writeFileSync(filePath, Buffer.concat([prefix, tail]));
			const storage = await JsonlSessionStorage.open(env, filePath);
			expect((await storage.getEntries()).map((stored) => stored.id)).toEqual(["one"]);
			expect(readFileSync(filePath)).toEqual(prefix);
		}
	});

	it("preserves original bytes when torn-tail repair publication fails", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "repair-failure.jsonl");
		const original = `${JSON.stringify({ type: "session", version: 3, id: "repair", timestamp: "2026-01-01T00:00:00Z", cwd: dir })}\n{`;
		writeFileSync(filePath, original);
		const fs = new Proxy(env, {
			get(target, property) {
				if (property === "renameFile") {
					return async (_source: string, destination: string) =>
						err(new FileError("unknown", "injected repair rename failure", destination));
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as FileSystem;
		let failure: unknown;
		try {
			await JsonlSessionStorage.open(fs, filePath);
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({
			phase: "repair",
			reference: filePath,
			outcome: "unknown",
		});
		expect((failure as Error).message).toContain("injected repair rename failure");
		expect(readFileSync(filePath, "utf8")).toBe(original);
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("atomically adds a missing final newline without normalizing prior bytes", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "unterminated-valid.jsonl");
		const original = Buffer.from(
			`${JSON.stringify({ type: "session", version: 3, id: "valid", timestamp: "2026-01-01T00:00:00Z", cwd: dir })}\r\n${JSON.stringify({ type: "message", id: "one", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: createUserMessage("one") })}`,
		);
		writeFileSync(filePath, original);
		await JsonlSessionStorage.open(env, filePath);
		expect(readFileSync(filePath)).toEqual(Buffer.concat([original, Buffer.from("\n")]));
	});

	it.each([
		["newline final syntax", "not json\n"],
		[
			"complete final schema",
			`${JSON.stringify({ type: "unknown", id: "bad", parentId: null, timestamp: "2026-01-01T00:00:01Z" })}`,
		],
		[
			"interior syntax",
			`not json\n${JSON.stringify({ type: "message", id: "later", parentId: null, timestamp: "2026-01-01T00:00:02Z", message: createUserMessage("later") })}\n`,
		],
	])("rejects %s corruption without modifying bytes", async (_name, suffix) => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "corrupt.jsonl");
		const original = `${JSON.stringify({ type: "session", version: 3, id: "corrupt", timestamp: "2026-01-01T00:00:00Z", cwd: dir })}\n${suffix}`;
		writeFileSync(filePath, original);
		await expect(JsonlSessionStorage.open(env, filePath)).rejects.toMatchObject({ code: "invalid_entry" });
		expect(readFileSync(filePath, "utf8")).toBe(original);
	});

	it("reports typed path, physical line, byte offset, phase, decode kind, and cause on explicit open", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "typed-corruption.jsonl");
		const prefix = `${JSON.stringify({ type: "session", version: 3, id: "typed", timestamp: "2026-01-01T00:00:00Z", cwd: dir })}\r\n\r\n`;
		writeFileSync(filePath, `${prefix}not json\n`);
		let failure: unknown;
		try {
			await JsonlSessionStorage.open(env, filePath);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(JsonlSessionError);
		expect(failure).toMatchObject({
			code: "invalid_entry",
			reference: filePath,
			path: filePath,
			phase: "open",
			line: 3,
			byteOffset: Buffer.byteLength(prefix),
			decodeKind: "syntax",
			cause: expect.any(JsonlDecodeError),
		});
		expect((failure as JsonlSessionError).cause).toMatchObject({ decodeKind: "syntax" });
	});

	it("reports the physical append line and byte offset after preserved blank records", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "typed-append.jsonl");
		const prefix = `${JSON.stringify({ type: "session", version: 3, id: "typed-append", timestamp: "2026-01-01T00:00:00Z", cwd: dir })}\n\n`;
		writeFileSync(filePath, prefix);
		const storage = await JsonlSessionStorage.open(env, filePath);
		await expect(
			storage.appendEntry({
				type: "message",
				id: "bad-parent",
				parentId: "missing",
				timestamp: "2026-01-01T00:00:01Z",
				message: createUserMessage("bad"),
			}),
		).rejects.toMatchObject({
			phase: "append",
			line: 3,
			byteOffset: Buffer.byteLength(prefix),
			decodeKind: "state",
		});
	});

	it.each([
		["utf8", Buffer.from([0xc3, 0x0a])],
		[
			"schema",
			Buffer.from(
				`${JSON.stringify({ type: "unknown", id: "bad", parentId: null, timestamp: "2026-01-01T00:00:01Z" })}\n`,
			),
		],
		[
			"state",
			Buffer.from(
				`${JSON.stringify({ type: "message", id: "one", parentId: "missing", timestamp: "2026-01-01T00:00:01Z", message: createUserMessage("one") })}\n`,
			),
		],
	] as const)("reports typed %s decoding details", async (decodeKind, body) => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, `typed-${decodeKind}.jsonl`);
		const prefix = Buffer.from(
			`${JSON.stringify({ type: "session", version: 3, id: `typed-${decodeKind}`, timestamp: "2026-01-01T00:00:00Z", cwd: dir })}\n`,
		);
		writeFileSync(filePath, Buffer.concat([prefix, body]));
		await expect(JsonlSessionStorage.open(env, filePath)).rejects.toMatchObject({
			phase: "open",
			line: 2,
			byteOffset: prefix.length,
			decodeKind,
		});
	});

	it.each([
		[
			"duplicate id",
			[
				{
					type: "message",
					id: "one",
					parentId: null,
					timestamp: "2026-01-01T00:00:01Z",
					message: createUserMessage("one"),
				},
				{
					type: "message",
					id: "one",
					parentId: null,
					timestamp: "2026-01-01T00:00:02Z",
					message: createUserMessage("two"),
				},
			],
		],
		[
			"missing parent",
			[
				{
					type: "message",
					id: "one",
					parentId: "missing",
					timestamp: "2026-01-01T00:00:01Z",
					message: createUserMessage("one"),
				},
			],
		],
		[
			"missing label target",
			[
				{
					type: "label",
					id: "label",
					parentId: null,
					timestamp: "2026-01-01T00:00:01Z",
					targetId: "missing",
					label: "x",
				},
			],
		],
	] as const)("rejects %s state corruption", async (_name, body) => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "state.jsonl");
		const header = { type: "session", version: 3, id: "state", timestamp: "2026-01-01T00:00:00Z", cwd: dir };
		const original = `${[header, ...body].map((value) => JSON.stringify(value)).join("\n")}\n`;
		writeFileSync(filePath, original);
		await expect(JsonlSessionStorage.open(env, filePath)).rejects.toMatchObject({ code: "invalid_entry" });
		expect(readFileSync(filePath, "utf8")).toBe(original);
	});

	it("throws for malformed session headers", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		writeFileSync(filePath, "not json\n");
		await expect(JsonlSessionStorage.open(env, filePath)).rejects.toThrow("first line is not a valid session header");
	});

	it("throws for malformed entry lines", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: "session-1",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: dir,
		};
		const entry: MessageEntry = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		};
		writeFileSync(filePath, `${JSON.stringify(header)}\nnot json\n${JSON.stringify(entry)}\n`);
		await expect(JsonlSessionStorage.open(env, filePath)).rejects.toMatchObject({ code: "invalid_entry" });
	});

	it("creates and reads session metadata from the header", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, {
			cwd: dir,
			sessionId: "session-1",
			parentSessionPath: "/tmp/parent.jsonl",
		});
		const metadata = await storage.getMetadata();
		expect(metadata).toMatchObject({
			id: "session-1",
			cwd: dir,
			path: filePath,
			parentSessionPath: "/tmp/parent.jsonl",
		});
		await storage.appendEntry({
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		});
		expect(await loadJsonlSessionMetadata(env, filePath)).toEqual(metadata);
	});

	it("loads existing entries and reconstructs leaf", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" });
		const root: MessageEntry = {
			type: "message",
			id: "root",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("root"),
		};
		const child: MessageEntry = {
			...root,
			id: "child",
			parentId: "root",
			message: createAssistantMessage("child"),
		};
		await storage.appendEntry(root);
		await storage.appendEntry(child);
		const loaded = await JsonlSessionStorage.open(env, filePath);
		expect(await loaded.getLeafId()).toBe("child");
		expect((await loaded.getEntries()).map((entry) => entry.id)).toEqual(["root", "child"]);
		await loaded.setLeafId("root");
		const reloaded = await JsonlSessionStorage.open(env, filePath);
		expect(await reloaded.getLeafId()).toBe("root");
		expect((await reloaded.getEntries()).at(-1)).toMatchObject({ type: "leaf", targetId: "root" });
		expect((await loaded.getPathToRoot("child")).map((entry) => entry.id)).toEqual(["root", "child"]);
	});

	it("finds entries by type", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" });
		await storage.appendEntry({
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		});
		expect((await storage.findEntries("message")).map((found) => found.id)).toEqual(["entry-1"]);
		expect(await storage.findEntries("session_info")).toEqual([]);
	});

	it("maintains label lookup", async () => {
		const dir = createTempDir();
		const env = new NodeExecutionEnv({ cwd: dir });
		const filePath = join(dir, "session.jsonl");
		const storage = await JsonlSessionStorage.create(env, filePath, { cwd: dir, sessionId: "session-1" });
		await storage.appendEntry({
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: createUserMessage("one"),
		});
		expect(await storage.getLabel("entry-1")).toBeUndefined();
		await storage.appendEntry({
			type: "label",
			id: "label-1",
			parentId: "entry-1",
			timestamp: "2026-01-01T00:00:01.000Z",
			targetId: "entry-1",
			label: "checkpoint",
		});
		expect(await storage.getLabel("entry-1")).toBe("checkpoint");
		await storage.appendEntry({
			type: "label",
			id: "label-2",
			parentId: "label-1",
			timestamp: "2026-01-01T00:00:02.000Z",
			targetId: "entry-1",
			label: undefined,
		});
		expect(await storage.getLabel("entry-1")).toBeUndefined();
		const loaded = await JsonlSessionStorage.open(env, filePath);
		expect(await loaded.getLabel("entry-1")).toBeUndefined();
	});

	it("uses list-phase typed errors for malformed metadata candidates", async () => {
		const dir = createTempDir();
		const filePath = join(dir, "malformed.jsonl");
		const env = new NodeExecutionEnv({ cwd: dir });
		writeFileSync(filePath, "not json\n");
		await expect(loadJsonlSessionMetadata(env, filePath)).rejects.toMatchObject({
			code: "invalid_session",
			reference: filePath,
			phase: "list",
			line: 1,
			byteOffset: 0,
			decodeKind: "syntax",
		});
	});

	it("reads session metadata through the bounded first-line operation", async () => {
		const dir = createTempDir();
		const filePath = join(dir, "session.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: "session-1",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: dir,
		};
		const metadata = await loadJsonlSessionMetadata(
			{
				readTextLines: async () => ok([JSON.stringify(header)]),
				readBinaryFile: async () => err(new FileError("unknown", "binary fallback should not run", filePath)),
			},
			filePath,
		);
		expect(metadata).toEqual({
			id: "session-1",
			createdAt: "2026-01-01T00:00:00.000Z",
			cwd: dir,
			path: filePath,
			parentSessionPath: undefined,
		});
	});
});
