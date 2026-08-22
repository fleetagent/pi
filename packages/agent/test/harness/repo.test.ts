import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionRepo } from "../../src/harness/session/jsonl-repo.ts";
import { InMemorySessionRepo } from "../../src/harness/session/memory-repo.ts";
import { err, FileError, type FileSystem } from "../../src/harness/types.ts";
import { createAssistantMessage, createTempDir, createUserMessage } from "./session-test-utils.ts";

describe("InMemorySessionRepo", () => {
	it("opens, deletes, and forks by metadata", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "session-1" });
		const metadata = await session.getMetadata();
		const user1 = await session.appendMessage(createUserMessage("one"));
		const assistant1 = await session.appendMessage(createAssistantMessage("two"));
		const user2 = await session.appendMessage(createUserMessage("three"));
		expect(await repo.open(metadata)).toBe(session);
		expect((await repo.list()).map((info) => info.id)).toEqual(["session-1"]);
		const fork = await repo.fork(metadata, { entryId: user2, id: "session-2" });
		expect((await fork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1]);
		const fullFork = await repo.fork(metadata, { id: "session-3" });
		expect((await fullFork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1, user2]);
		await repo.delete(metadata);
		await expect(repo.open(metadata)).rejects.toThrow("Session not found: session-1");
	});
});

describe("JsonlSessionRepo", () => {
	it("stores sessions below encoded cwd directories and lists by cwd", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const cwd = "/tmp/my-project";
		const otherCwd = "/tmp/other-project";
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ cwd, id: "019de8c2-de29-73e9-ae0c-e134db34c447" });
		const otherSession = await repo.create({ cwd: otherCwd, id: "other-session" });
		const metadata = await session.getMetadata();
		const otherMetadata = await otherSession.getMetadata();
		expect(metadata.path).toContain("--tmp-my-project--");
		expect(otherMetadata.path).toContain("--tmp-other-project--");
		expect(existsSync(metadata.path)).toBe(true);
		expect((await repo.list({ cwd })).map((sessionMetadata) => sessionMetadata.id)).toEqual([metadata.id]);
		expect((await repo.list()).map((sessionMetadata) => sessionMetadata.id).sort()).toEqual(
			[metadata.id, otherMetadata.id].sort(),
		);
	});

	it("skips malformed headers during listing while explicit open rejects without mutation", async () => {
		const root = createTempDir();
		const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
		const valid = await repo.create({ cwd: root, id: "valid" });
		const malformed = await repo.create({ cwd: root, id: "malformed" });
		const metadata = await malformed.getMetadata();
		writeFileSync(metadata.path, "not json\n");
		const invalidUtf8 = await repo.create({ cwd: root, id: "invalid-utf8" });
		const invalidUtf8Metadata = await invalidUtf8.getMetadata();
		writeFileSync(
			invalidUtf8Metadata.path,
			Buffer.concat([
				Buffer.from('{"type":"session","version":3,"id":"invalid-utf8","timestamp":"2026-01-01T00:00:00Z","cwd":"'),
				Buffer.from([0xc3]),
				Buffer.from('"}\n'),
			]),
		);
		expect((await repo.list({ cwd: root })).map((listed) => listed.id)).toEqual([(await valid.getMetadata()).id]);
		await expect(repo.open(metadata)).rejects.toMatchObject({ code: "invalid_session" });
		expect(readFileSync(metadata.path, "utf8")).toBe("not json\n");
	});

	it("opens, deletes, and forks by metadata", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const source = await repo.create({ cwd: "/tmp/source", id: "source-session" });
		const sourceMetadata = await source.getMetadata();
		const user1 = await source.appendMessage(createUserMessage("one"));
		const assistant1 = await source.appendMessage(createAssistantMessage("two"));
		const user2 = await source.appendMessage(createUserMessage("three"));
		await expect((await repo.open(sourceMetadata)).getMetadata()).resolves.toEqual(sourceMetadata);
		const fork = await repo.fork(sourceMetadata, { cwd: "/tmp/target", id: "fork-session", entryId: user2 });
		const forkMetadata = await fork.getMetadata();
		expect(forkMetadata.cwd).toBe("/tmp/target");
		expect(forkMetadata.parentSessionPath).toBe(sourceMetadata.path);
		expect((await fork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1]);
		const fullFork = await repo.fork(sourceMetadata, { cwd: "/tmp/target", id: "full-fork-session" });
		expect((await fullFork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1, user2]);
		await repo.delete(sourceMetadata);
		expect(existsSync(sourceMetadata.path)).toBe(false);
		await expect(repo.open(sourceMetadata)).rejects.toThrow("Session not found");
	});

	it("validates explicit ids before acquiring a destination claim", async () => {
		const root = createTempDir();
		const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
		await expect(repo.create({ cwd: root, id: "../escape" })).rejects.toMatchObject({ code: "invalid_session" });
		await expect(repo.create({ cwd: root, id: "valid-after-rejection" })).resolves.toBeDefined();
	});

	it.each([
		["create", "create"],
		["create", "fork"],
		["fork", "fork"],
	] as const)("rejects concurrent %s/%s claims for one canonical cwd and id", async (firstKind, secondKind) => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const cwd = join(root, "workspace");
		const source = await repo.create({ cwd, id: "source-session" });
		const sourceMetadata = await source.getMetadata();
		const run = (kind: "create" | "fork", claimedCwd: string) =>
			kind === "create"
				? repo.create({ cwd: claimedCwd, id: "claimed-session" })
				: repo.fork(sourceMetadata, { cwd: claimedCwd, id: "claimed-session" });

		const results = await Promise.allSettled([run(firstKind, cwd), run(secondKind, join(cwd, "child", ".."))]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const failures = results.filter((result) => result.status === "rejected");
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatchObject({
			reason: {
				code: "already_exists",
				phase: expect.stringMatching(/^(create|fork)$/),
				outcome: "not_written",
				reference: expect.any(String),
			},
		});
		expect((await repo.list({ cwd })).filter((metadata) => metadata.id === "claimed-session")).toHaveLength(1);
	});

	it("allows the same explicit id in different cwd namespaces whose directory encodings collide", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const root = createTempDir();
			const repo = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			await repo.create({ cwd: join(root, "one", "two"), id: "shared-session" });
			vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
			await repo.create({ cwd: join(root, "one-two"), id: "shared-session" });
			expect((await repo.list()).filter((metadata) => metadata.id === "shared-session")).toHaveLength(2);
			expect(await repo.list({ cwd: join(root, "one", "two") })).toHaveLength(1);
			expect(await repo.list({ cwd: join(root, "one-two") })).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("detects a session created by another repository owner", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const cwd = join(root, "workspace");
		await new JsonlSessionRepo({ fs: env, sessionsRoot: root }).create({ cwd, id: "external-session" });
		await expect(
			new JsonlSessionRepo({ fs: env, sessionsRoot: root }).create({ cwd, id: "external-session" }),
		).rejects.toMatchObject({ code: "already_exists" });
	});

	it("reports an already-published logical id collision across OS processes", async () => {
		const root = createTempDir();
		const cwd = join(root, "workspace");
		await new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root }).create({
			cwd,
			id: "process-session",
		});
		const child = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				fileURLToPath(new URL("./session-create-child.ts", import.meta.url)),
				root,
				cwd,
				"process-session",
			],
			{ encoding: "utf8" },
		);
		expect(child.status, child.stderr).toBe(0);
		expect(child.stdout).toBe("already_exists");
	});

	it.each(["create", "fork"] as const)("releases a %s claim after failed publication", async (kind) => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const cwd = join(root, "workspace");
		const source = await repo.create({ cwd, id: "source-session" });
		const sourceMetadata = await source.getMetadata();
		const run = () =>
			kind === "create"
				? repo.create({ cwd, id: "retry-session" })
				: repo.fork(sourceMetadata, { cwd, id: "retry-session" });
		vi.spyOn(env, "renameFile").mockResolvedValueOnce(err(new FileError("unknown", "injected failure")));
		await expect(run()).rejects.toMatchObject({ code: "storage" });
		await expect(run()).resolves.toBeDefined();
	});

	it("publishes forks atomically without changing the source", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const fs = new Proxy(env, {
			get(target, property) {
				if (property === "renameFile") {
					return async (source: string, destination: string) => {
						if (destination.includes("fork-session")) {
							return err(new FileError("unknown", "injected fork publication failure", destination));
						}
						return target.renameFile(source, destination);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as FileSystem;
		const repo = new JsonlSessionRepo({ fs, sessionsRoot: root });
		const source = await repo.create({ cwd: "/tmp/source", id: "source-session" });
		await source.appendMessage(createUserMessage("one"));
		await source.appendMessage(createAssistantMessage("two"));
		const metadata = await source.getMetadata();
		const sourceBytes = readFileSync(metadata.path, "utf8");

		const publication = repo.fork(metadata, { cwd: "/tmp/target", id: "fork-session" });
		await expect(publication).rejects.toMatchObject({ phase: "fork", outcome: "unknown" });
		await expect(publication).rejects.toThrow("injected fork publication failure");
		expect(readFileSync(metadata.path, "utf8")).toBe(sourceBytes);
		const targetDir = readdirSync(root, { withFileTypes: true }).find((entry) => entry.name.includes("tmp-target"));
		if (!targetDir) throw new Error("expected target session directory");
		const targetFiles = readdirSync(`${root}/${targetDir.name}`);
		expect(targetFiles.filter((name) => name.endsWith(".jsonl"))).toEqual([]);
		expect(targetFiles.filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});
});
