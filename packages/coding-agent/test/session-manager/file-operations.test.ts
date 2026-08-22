import { constants as bufferConstants } from "buffer";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMostRecentSession, LocalSessionManager, loadEntriesFromFile } from "../../src/core/session-manager.ts";

const HEADER_SCAN_LIMIT_BYTES = 1024 * 1024;
describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSessionHeader(file: string, cwd: string, id: string, prefix = ""): void {
		writeFileSync(
			file,
			`${prefix}${JSON.stringify({
				type: "session",
				version: 3,
				id,
				timestamp: "2025-01-01T00:00:00Z",
				cwd,
			})}\n`,
		);
	}

	it("returns empty array for non-existent file", () => {
		const entries = loadEntriesFromFile(join(tempDir, "nonexistent.jsonl"));
		expect(entries).toEqual([]);
	});

	it("returns empty array for empty file", () => {
		const file = join(tempDir, "empty.jsonl");
		writeFileSync(file, "");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("rejects a file without a valid session header", () => {
		const file = join(tempDir, "no-header.jsonl");
		writeFileSync(file, '{"type":"message","id":"1"}\n');
		expect(() => loadEntriesFromFile(file)).toThrow("is not a session header");
	});

	it("rejects malformed header JSON", () => {
		const file = join(tempDir, "malformed.jsonl");
		writeFileSync(file, "not json\n");
		expect(() => loadEntriesFromFile(file)).toThrow("is not valid JSON");
	});

	it("loads valid session file", () => {
		const file = join(tempDir, "valid.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1].type).toBe("message");
	});

	it.each([
		["leading blank lines", "\n  \n", "leading-blank"],
		["a multi-buffer header", "", "a".repeat(8192)],
	])("reads cwd from a session with %s", (_description, prefix, sessionId) => {
		const file = join(tempDir, "header.jsonl");
		const storedCwd = join(tempDir, "stored-project");
		writeSessionHeader(file, storedCwd, sessionId, prefix);

		const session = new LocalSessionManager({ cwd: tempDir, sessionDir: tempDir }).openReference(file);
		expect(session.getSessionId()).toBe(sessionId);
		expect(session.getCwd()).toBe(storedCwd);
	});

	it("rejects a malformed non-blank prefix before a valid header", () => {
		const file = join(tempDir, "malformed-prefix.jsonl");
		writeSessionHeader(file, tempDir, "later", "not json\n");
		expect(() => new LocalSessionManager({ cwd: tempDir, sessionDir: tempDir }).openReference(file)).toThrow(
			"line 1",
		);
	});

	it("decodes a header when a UTF-8 sequence crosses a read-buffer boundary", () => {
		const file = join(tempDir, "unicode-header.jsonl");
		const marker = "__CWD__";
		const template = JSON.stringify({
			type: "session",
			version: 3,
			id: "unicode-header",
			timestamp: "2025-01-01T00:00:00Z",
			cwd: marker,
		});
		const markerOffset = Buffer.byteLength(template.slice(0, template.indexOf(marker)));
		const storedCwd = `${"a".repeat(4095 - markerOffset)}😀`;
		writeSessionHeader(file, storedCwd, "unicode-header");

		const session = new LocalSessionManager({ cwd: tempDir, sessionDir: tempDir }).openReference(file);
		expect(session.getSessionId()).toBe("unicode-header");
		expect(session.getCwd()).toBe(storedCwd);
	});

	it("opens a compatible session whose header exceeds the discovery scan limit", () => {
		const storedCwd = join(tempDir, "stored-project");
		const overrideCwd = join(tempDir, "override-project");
		const file = join(tempDir, "large-header.jsonl");
		const id = "a".repeat(HEADER_SCAN_LIMIT_BYTES + 1);
		writeSessionHeader(file, storedCwd, id);
		for (const cwdOverride of [undefined, overrideCwd]) {
			const session = new LocalSessionManager({ cwd: tempDir, sessionDir: tempDir }).openReference(file, {
				cwdOverride,
			});
			expect(session.getSessionId()).toBe(id);
			expect(session.getCwd()).toBe(cwdOverride ?? storedCwd);
		}
	});

	it("migrates an over-limit legacy header from the single fallback load", () => {
		const file = join(tempDir, "legacy-large-header.jsonl");
		const sessionId = "a".repeat(HEADER_SCAN_LIMIT_BYTES + 1);
		writeFileSync(
			file,
			`${JSON.stringify({
				type: "session",
				id: sessionId,
				timestamp: "2025-01-01T00:00:00Z",
				cwd: tempDir,
			})}\n${JSON.stringify({
				type: "message",
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "legacy", timestamp: 1 },
			})}\n`,
		);

		const session = new LocalSessionManager({ cwd: tempDir, sessionDir: tempDir }).openReference(file);
		const entries = loadEntriesFromFile(file);
		expect(session.getSessionId()).toBe(sessionId);
		expect(session.getHeader()?.version).toBe(3);
		expect(session.getEntries()).toHaveLength(1);
		expect(session.getEntries()[0]).toMatchObject({ type: "message", parentId: null });
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ type: "session", version: 3, id: sessionId });
	});

	it("rejects malformed interior lines instead of omitting them", () => {
		const file = join(tempDir, "mixed.jsonl");
		const original =
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
			"not valid json\n" +
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n';
		writeFileSync(file, original);
		expect(() => loadEntriesFromFile(file)).toThrow("line 2");
		expect(readFileSync(file, "utf8")).toBe(original);
	});

	it("rejects sparse interior corruption without building a max-length string", () => {
		const file = join(tempDir, "large.jsonl");
		writeFileSync(
			file,
			'{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n',
		);
		const fd = openSync(file, "r+");
		try {
			const newline = Buffer.from("\n");
			const stride = 16 * 1024 * 1024;
			for (let offset = stride; offset <= bufferConstants.MAX_STRING_LENGTH + stride; offset += stride) {
				writeSync(fd, newline, 0, newline.length, offset);
			}
		} finally {
			closeSync(fd);
		}
		expect(() => loadEntriesFromFile(file)).toThrow("line 2");
	});
});

describe("findMostRecentSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns null for empty directory", () => {
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns null for non-existent directory", () => {
		expect(findMostRecentSession(join(tempDir, "nonexistent"))).toBeNull();
	});

	it("ignores non-jsonl files", () => {
		writeFileSync(join(tempDir, "file.txt"), "hello");
		writeFileSync(join(tempDir, "file.json"), "{}");
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("ignores jsonl files without valid session header", () => {
		writeFileSync(join(tempDir, "invalid.jsonl"), '{"type":"message"}\n');
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns single valid session file", () => {
		const file = join(tempDir, "session.jsonl");
		writeFileSync(file, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		expect(findMostRecentSession(tempDir)).toBe(file);
	});

	it("returns most recently modified session", async () => {
		const file1 = join(tempDir, "older.jsonl");
		const file2 = join(tempDir, "newer.jsonl");

		writeFileSync(file1, '{"type":"session","id":"old","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		// Small delay to ensure different mtime
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(file2, '{"type":"session","id":"new","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(file2);
	});

	it("skips invalid files and returns valid one", async () => {
		const invalid = join(tempDir, "invalid.jsonl");
		const valid = join(tempDir, "valid.jsonl");

		writeFileSync(invalid, '{"type":"not-session"}\n');
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(valid, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(valid);
	});

	it("skips oversized corrupt files and returns a valid session", () => {
		const invalid = join(tempDir, "oversized.jsonl");
		const valid = join(tempDir, "valid.jsonl");
		writeFileSync(invalid, "x".repeat(HEADER_SCAN_LIMIT_BYTES + 1));
		writeFileSync(valid, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(valid);
	});

	it("filters most recent session by cwd", async () => {
		const projectA = join(tempDir, "project-a");
		const projectB = join(tempDir, "project-b");
		const fileA = join(tempDir, "a.jsonl");
		const fileB = join(tempDir, "b.jsonl");

		writeFileSync(
			fileA,
			`${JSON.stringify({ type: "session", id: "a", timestamp: "2025-01-01T00:00:00Z", cwd: projectA })}\n`,
		);
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(
			fileB,
			`${JSON.stringify({ type: "session", id: "b", timestamp: "2025-01-01T00:00:00Z", cwd: projectB })}\n`,
		);

		expect(findMostRecentSession(tempDir, projectA)).toBe(fileA);
		expect(findMostRecentSession(tempDir, projectB)).toBe(fileB);
	});
});

describe("SessionManager custom flat session directory", () => {
	let tempDir: string;
	let projectA: string;
	let projectB: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		projectA = join(tempDir, "project-a");
		projectB = join(tempDir, "project-b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createPersistedSession(cwd: string, label: string): string {
		const session = new LocalSessionManager({ cwd, sessionDir: tempDir }).create();
		session.appendMessage({ role: "user", content: label, timestamp: Date.now() });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `reply to ${label}` }],
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
			timestamp: Date.now(),
		});
		const sessionFile = session.getSessionReference();
		if (!sessionFile) {
			throw new Error("Expected persisted session file");
		}
		return sessionFile;
	}

	it("scopes current-folder APIs by cwd while listing all flat sessions", async () => {
		const sessionA = createPersistedSession(projectA, "from A");
		await new Promise((r) => setTimeout(r, 10));
		const sessionB = createPersistedSession(projectB, "from B");

		const currentA = await new LocalSessionManager({ cwd: projectA, sessionDir: tempDir }).list();
		expect(currentA.map((session) => session.path)).toEqual([sessionA]);

		const all = await new LocalSessionManager({ cwd: process.cwd(), sessionDir: tempDir }).listAll();
		expect(new Set(all.map((session) => session.path))).toEqual(new Set([sessionA, sessionB]));

		const continuedA = new LocalSessionManager({ cwd: projectA, sessionDir: tempDir }).continueRecent();
		expect(continuedA.getSessionReference()).toBe(sessionA);
	});
});

describe("SessionManager.setSessionFile with corrupted files", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("truncates and rewrites empty file with valid header", () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");

		const sm = new LocalSessionManager({ cwd: process.cwd(), sessionDir: tempDir }).openReference(emptyFile);

		// Should have created a new session with valid header
		expect(sm.getSessionId()).toBeTruthy();
		expect(sm.getHeader()).toBeTruthy();
		expect(sm.getHeader()?.type).toBe("session");

		// File should now contain a valid header
		const content = readFileSync(emptyFile, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		expect(lines.length).toBe(1);
		const header = JSON.parse(lines[0]);
		expect(header.type).toBe("session");
		expect(header.id).toBe(sm.getSessionId());
	});

	it("throws and preserves non-empty file without valid header", () => {
		const noHeaderFile = join(tempDir, "no-header.jsonl");
		const originalContent =
			'{"type":"message","id":"abc","parentId":"orphaned","timestamp":"2025-01-01T00:00:00Z","message":{"role":"assistant","content":"test"}}\n';
		writeFileSync(noHeaderFile, originalContent);
		expect(() =>
			new LocalSessionManager({ cwd: process.cwd(), sessionDir: tempDir }).openReference(noHeaderFile),
		).toThrow("is not a session header");
		expect(readFileSync(noHeaderFile, "utf-8")).toBe(originalContent);
	});

	it("throws and preserves non-session JSONL files", () => {
		const nonSessionFile = join(tempDir, "not-a-session.log");
		const originalContent = '{"type":"event","data":"not a session"}\n';
		writeFileSync(nonSessionFile, originalContent);
		expect(() =>
			new LocalSessionManager({ cwd: process.cwd(), sessionDir: tempDir }).openReference(nonSessionFile),
		).toThrow("is not a session header");
		expect(readFileSync(nonSessionFile, "utf-8")).toBe(originalContent);
	});

	it("preserves explicit session file path when recovering from corrupted file", () => {
		const explicitPath = join(tempDir, "my-session.jsonl");
		writeFileSync(explicitPath, "");

		const sm = new LocalSessionManager({ cwd: process.cwd(), sessionDir: tempDir }).openReference(explicitPath);

		// The session file path should be preserved
		expect(sm.getSessionReference()).toBe(explicitPath);
	});

	it("subsequent loads of initialized empty file work correctly", () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");

		const sm1 = new LocalSessionManager({ cwd: process.cwd(), sessionDir: tempDir }).openReference(emptyFile);
		const sessionId = sm1.getSessionId();

		const sm2 = new LocalSessionManager({ cwd: process.cwd(), sessionDir: tempDir }).openReference(emptyFile);
		expect(sm2.getSessionId()).toBe(sessionId);
		expect(sm2.getHeader()?.type).toBe("session");
	});
});
