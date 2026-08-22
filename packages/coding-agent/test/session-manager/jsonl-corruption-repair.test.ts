import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findMostRecent, list, listAll, load } from "../../src/core/session/stores/jsonl-session-store.ts";
import { LocalSessionManager, loadEntriesFromFile } from "../../src/core/session-manager.ts";
import { JsonlDecodeError, JsonlSessionError } from "../../src/index.ts";

const createdDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-jsonl-corruption-"));
	createdDirs.push(dir);
	return dir;
}

function header(cwd: string, id = "session", version: number | undefined = 3): Record<string, unknown> {
	return {
		type: "session",
		...(version === undefined ? {} : { version }),
		id,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd,
	};
}

function message(id: string, parentId: string | null, content = id): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role: "user", content, timestamp: 1 },
	};
}

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best effort test cleanup.
		}
	}
});

describe("strict coding-agent JSONL recovery", () => {
	it.each([
		["JSON syntax", Buffer.from('{"type":"message"')],
		["UTF-8", Buffer.from([0xc3])],
	] as const)("drops only an unterminated final %s fragment and preserves prefix bytes", (_name, tail) => {
		const dir = tempDir();
		const file = join(dir, "torn.jsonl");
		const prefix = Buffer.from(`${JSON.stringify(header(dir))}\r\n  \r\n${JSON.stringify(message("one", null))}\r\n`);
		writeFileSync(file, Buffer.concat([prefix, tail]));

		const entries = loadEntriesFromFile(file);
		expect(entries.map((entry) => (entry.type === "session" ? entry.id : entry.id))).toEqual(["session", "one"]);
		expect(readFileSync(file)).toEqual(prefix);
	});

	it("atomically adds a missing final newline without normalizing prior bytes", () => {
		const dir = tempDir();
		const file = join(dir, "valid-no-newline.jsonl");
		const original = Buffer.from(`${JSON.stringify(header(dir))}\r\n${JSON.stringify(message("one", null))}`);
		writeFileSync(file, original);

		expect(loadEntriesFromFile(file)).toHaveLength(2);
		expect(readFileSync(file)).toEqual(Buffer.concat([original, Buffer.from("\n")]));
	});

	it("preserves original bytes when repair publication fails", () => {
		const dir = tempDir();
		const file = join(dir, "repair-failure.jsonl");
		const original = `${JSON.stringify(header(dir))}\n${JSON.stringify(message("one", null))}\n{`;
		writeFileSync(file, original);
		let failure: unknown;
		try {
			load(file, {
				rename: () => {
					throw new Error("injected repair rename failure");
				},
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(JsonlSessionError);
		expect(failure).toMatchObject({ phase: "repair", reference: file, outcome: "unknown" });
		expect((failure as Error).message).toContain("injected repair rename failure");
		expect(readFileSync(file, "utf8")).toBe(original);
		expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
	});

	it.each([
		["newline-terminated final syntax", "not json\n"],
		[
			"complete final schema",
			JSON.stringify({ type: "unknown", id: "bad", parentId: null, timestamp: "2026-01-01T00:00:02Z" }),
		],
		["interior syntax", `not json\n${JSON.stringify(message("later", null))}\n`],
	])("rejects %s corruption without changing the file", (_name, suffix) => {
		const dir = tempDir();
		const file = join(dir, "corrupt.jsonl");
		const original = `${JSON.stringify(header(dir))}\n${suffix}`;
		writeFileSync(file, original);

		expect(() => loadEntriesFromFile(file)).toThrow("Invalid JSONL session file");
		expect(readFileSync(file, "utf8")).toBe(original);
	});

	it("reports typed path, physical line, byte offset, phase, decode kind, and cause on explicit open", () => {
		const dir = tempDir();
		const file = join(dir, "typed-corruption.jsonl");
		const prefix = `${JSON.stringify(header(dir))}\r\n\r\n`;
		writeFileSync(file, `${prefix}not json\n`);
		let failure: unknown;
		try {
			loadEntriesFromFile(file);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(JsonlSessionError);
		expect(failure).toMatchObject({
			code: "invalid_jsonl",
			reference: file,
			path: file,
			phase: "open",
			line: 3,
			byteOffset: Buffer.byteLength(prefix),
			decodeKind: "syntax",
			cause: expect.any(JsonlDecodeError),
		});
		expect((failure as JsonlSessionError).cause).toMatchObject({ decodeKind: "syntax" });
	});

	it.each([
		["utf8", Buffer.from([0xc3, 0x0a])],
		[
			"schema",
			Buffer.from(
				`${JSON.stringify({ type: "unknown", id: "bad", parentId: null, timestamp: "2026-01-01T00:00:01Z" })}\n`,
			),
		],
		["state", Buffer.from(`${JSON.stringify(message("one", "missing"))}\n`)],
	] as const)("reports typed %s decoding details", (decodeKind, body) => {
		const dir = tempDir();
		const file = join(dir, `typed-${decodeKind}.jsonl`);
		const prefix = Buffer.from(`${JSON.stringify(header(dir))}\n`);
		writeFileSync(file, Buffer.concat([prefix, body]));
		expect(() => loadEntriesFromFile(file)).toThrow(
			expect.objectContaining({
				phase: "open",
				line: 2,
				byteOffset: prefix.length,
				decodeKind,
			}),
		);
	});

	it.each([
		["duplicate id", [message("one", null), message("one", null)]],
		["missing parent", [message("one", "missing")]],
		[
			"missing target",
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
		["invalid entry id", [{ ...message("bad/id", null) }]],
		["invalid timestamp", [{ ...message("one", null), timestamp: "not-a-date" }]],
		["invalid message", [{ ...message("one", null), message: { content: "missing role" } }]],
	])("rejects %s schema or state corruption", (_name, body) => {
		const dir = tempDir();
		const file = join(dir, "state.jsonl");
		const original = `${[header(dir), ...body].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		writeFileSync(file, original);

		expect(() => new LocalSessionManager({ cwd: dir, sessionDir: dir }).openReference(file)).toThrow();
		expect(readFileSync(file, "utf8")).toBe(original);
	});

	it("keeps rich listing non-mutating while strict open rejects malformed body data", async () => {
		const dir = tempDir();
		const file = join(dir, "listed.jsonl");
		const original = `${JSON.stringify(header(dir, "listed"))}\nnot json\n${JSON.stringify(message("one", null, "searchable"))}\n`;
		writeFileSync(file, original);
		const manager = new LocalSessionManager({ cwd: dir, sessionDir: dir });

		expect(await manager.list()).toEqual([
			expect.objectContaining({ id: "listed", messageCount: 1, firstMessage: "searchable" }),
		]);
		expect(readFileSync(file, "utf8")).toBe(original);
		expect(() => manager.openReference(file)).toThrow("line 2");
		expect(readFileSync(file, "utf8")).toBe(original);
	});

	it.skipIf(process.platform === "win32")(
		"quarantines a disappearing candidate without hiding valid recent sessions",
		() => {
			const dir = tempDir();
			const valid = join(dir, "valid.jsonl");
			writeFileSync(valid, `${JSON.stringify(header(dir, "valid"))}\n`);
			symlinkSync(join(dir, "gone.jsonl"), join(dir, "newer.jsonl"));
			expect(findMostRecent(dir)).toBe(valid);
		},
	);

	it("migrates a legacy fork snapshot in memory before publishing a valid v3 destination", () => {
		const dir = tempDir();
		const source = join(dir, "legacy-source.jsonl");
		const original = `${JSON.stringify(header(dir, "legacy-source", 1))}\n${JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "legacy", timestamp: 1 } })}\n`;
		writeFileSync(source, original);
		const fork = new LocalSessionManager({ cwd: dir, sessionDir: dir }).forkFrom(source);
		expect(fork.getHeader()?.version).toBe(3);
		expect(fork.getEntries()[0]).toMatchObject({ id: expect.any(String), parentId: null });
		expect(loadEntriesFromFile(fork.getSessionReference()!)[0]).toMatchObject({ type: "session", version: 3 });
		expect(readFileSync(source, "utf8")).toBe(original);
	});

	it("quarantines unsupported or malformed headers from discovery and rich listing", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "future.jsonl"), `${JSON.stringify(header(dir, "future", 99))}\n`);
		writeFileSync(
			join(dir, "bad-time.jsonl"),
			`${JSON.stringify({ ...header(dir, "bad-time"), timestamp: "not-a-date" })}\n`,
		);
		writeFileSync(join(dir, "bad-cwd.jsonl"), `${JSON.stringify({ ...header(dir, "bad-cwd"), cwd: 42 })}\n`);
		writeFileSync(
			join(dir, "bad-utf8.jsonl"),
			Buffer.concat([
				Buffer.from('{"type":"session","version":3,"id":"bad-utf8","timestamp":"2026-01-01T00:00:00Z","cwd":"'),
				Buffer.from([0xc3]),
				Buffer.from('"}\n'),
			]),
		);
		const manager = new LocalSessionManager({ cwd: dir, sessionDir: dir });
		expect(await manager.list()).toEqual([]);
	});

	it.each(["migrate", "fork", "import"] as const)(
		"preserves physical source locations during post-migration %s validation",
		(phase) => {
			const root = tempDir();
			const sourceDir = join(root, "source");
			const destinationDir = join(root, "destination");
			mkdirSync(sourceDir, { recursive: true });
			mkdirSync(destinationDir, { recursive: true });
			const file = join(sourceDir, `${phase}.jsonl`);
			const prefix = `${JSON.stringify(header(root, phase, 1))}\r\n\r\n`;
			const invalid = {
				type: "branch_summary",
				timestamp: "2026-01-01T00:00:01Z",
				fromId: "missing",
				summary: "invalid",
			};
			writeFileSync(file, `${prefix}${JSON.stringify(invalid)}\r\n`);
			const manager = new LocalSessionManager({ cwd: root, sessionDir: destinationDir });
			const operation = () => {
				if (phase === "fork") return manager.forkFrom(file);
				if (phase === "import") return manager.importJsonl(file);
				return manager.openReference(file);
			};
			expect(operation).toThrow(
				expect.objectContaining({
					phase,
					line: 3,
					byteOffset: Buffer.byteLength(prefix),
					decodeKind: "state",
				}),
			);
		},
	);

	it("surfaces unexpected directory enumeration failures", async () => {
		const dir = tempDir();
		const notDirectory = join(dir, "not-a-directory");
		writeFileSync(notDirectory, "file");
		expect(() => findMostRecent(notDirectory)).toThrow();
		await expect(list(notDirectory)).rejects.toThrow();
		await expect(listAll(notDirectory)).rejects.toThrow();
	});

	it("validates a source before fork publication and rejects torn sources without a target", () => {
		const dir = tempDir();
		const source = join(dir, "source.jsonl");
		const prefix = `${JSON.stringify(header(dir, "source"))}\n${JSON.stringify(message("one", null))}\n`;
		writeFileSync(source, prefix);
		const manager = new LocalSessionManager({ cwd: dir, sessionDir: dir });
		const fork = manager.forkFrom(source);
		expect(readFileSync(source, "utf8")).toBe(prefix);
		expect(fork.getEntries().map((entry) => entry.id)).toEqual(["one"]);

		const corrupt = join(dir, "corrupt-source.jsonl");
		writeFileSync(corrupt, `${JSON.stringify(header(dir, "corrupt"))}\n{`);
		const before = new Set(readdirSync(dir));
		expect(() => manager.forkFrom(corrupt)).toThrow(
			expect.objectContaining({
				code: "invalid_jsonl",
				reference: corrupt,
				phase: "fork",
				line: 2,
				decodeKind: "syntax",
			}),
		);
		expect(new Set(readdirSync(dir))).toEqual(before);
	});

	it.each(["fork", "import"] as const)("reports typed %s errors for empty sources", (phase) => {
		const root = tempDir();
		const sourceDir = join(root, "source");
		const destinationDir = join(root, "destination");
		mkdirSync(sourceDir, { recursive: true });
		mkdirSync(destinationDir, { recursive: true });
		const file = join(sourceDir, `${phase}-empty.jsonl`);
		writeFileSync(file, "");
		const manager = new LocalSessionManager({ cwd: root, sessionDir: destinationDir });
		const operation = () => (phase === "fork" ? manager.forkFrom(file) : manager.importJsonl(file));
		expect(operation).toThrow(
			expect.objectContaining({
				code: "invalid_jsonl",
				reference: file,
				phase,
				line: 1,
				byteOffset: 0,
				decodeKind: "schema",
			}),
		);
	});

	it("strictly decodes and atomically migrates v1 before normal use", () => {
		const dir = tempDir();
		const file = join(dir, "legacy.jsonl");
		writeFileSync(
			file,
			`${JSON.stringify(header(dir, "legacy", 1))}\n${JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "legacy", timestamp: 1 } })}\n`,
		);
		const session = new LocalSessionManager({ cwd: dir, sessionDir: dir }).openReference(file);
		expect(session.getHeader()?.version).toBe(3);
		expect(session.getEntries()[0]).toMatchObject({ id: expect.any(String), parentId: null });
		expect(loadEntriesFromFile(file)[0]).toMatchObject({ type: "session", version: 3, id: "legacy" });
	});

	it("validates an import before publication and rejects destination conflicts", () => {
		const root = tempDir();
		const sourceDir = join(root, "source");
		const destinationDir = join(root, "destination");
		mkdirSync(sourceDir, { recursive: true });
		mkdirSync(destinationDir, { recursive: true });
		const malformed = join(sourceDir, "malformed.jsonl");
		writeFileSync(malformed, `${JSON.stringify(header(root, "bad"))}\nnot json\n`);
		const manager = new LocalSessionManager({ cwd: root, sessionDir: destinationDir });
		expect(() => manager.importJsonl(malformed)).toThrow(
			expect.objectContaining({
				code: "invalid_jsonl",
				reference: malformed,
				phase: "import",
				line: 2,
				decodeKind: "syntax",
			}),
		);
		expect(existsSync(join(destinationDir, "malformed.jsonl"))).toBe(false);

		const valid = join(sourceDir, "valid.jsonl");
		const validSource = `${JSON.stringify(header(root, "valid", 1))}\n${JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "one", timestamp: 1 } })}\n`;
		writeFileSync(valid, validSource);
		const imported = manager.importJsonl(valid);
		expect(imported.getHeader()?.version).toBe(3);
		expect(imported.getEntries()[0]).toMatchObject({ id: expect.any(String), parentId: null });
		expect(readFileSync(valid, "utf8")).toBe(validSource);
		expect(() => manager.importJsonl(valid)).toThrow(
			expect.objectContaining({
				code: "already_exists",
				reference: join(destinationDir, "valid.jsonl"),
				phase: "import",
				outcome: "not_written",
			}),
		);
		expect(readFileSync(valid, "utf8")).toBe(validSource);
	});
});
