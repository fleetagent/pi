import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	canonicalProjectHookIdentity,
	hasProjectHookConfiguration,
	ProjectHookTrustStore,
} from "../../src/core/hooks/index.ts";

interface ProjectHookTrustFixture {
	root: string;
	agentDir: string;
	project: string;
}
async function fixture(name: string): Promise<ProjectHookTrustFixture> {
	const root = await mkdtemp(join(tmpdir(), `pi-hook-trust-${name}-`));
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	await mkdir(project, { recursive: true });
	return { root, agentDir, project };
}

describe("project hook trust store", () => {
	it("keys trust by the nearest repository root and does not fingerprint hook content", async () => {
		const { agentDir, project } = await fixture("repository");
		await writeFile(join(project, ".git"), "gitdir: elsewhere\n");
		const nested = join(project, "packages", "app");
		await mkdir(nested, { recursive: true });
		const store = new ProjectHookTrustStore(agentDir);

		expect(store.isTrusted(nested).trusted).toBe(false);
		expect(store.trustAlways(nested)).toMatchObject({ trusted: true, identity: project });
		await mkdir(join(project, ".pi"), { recursive: true });
		await writeFile(join(project, ".pi", "settings.json"), JSON.stringify({ hooks: { SessionStart: [] } }));
		expect(store.isTrusted(project).trusted).toBe(true);

		const persisted = JSON.parse(await readFile(join(agentDir, "trusted-project-hooks.json"), "utf8")) as {
			version: number;
			trustedProjects: Record<string, true>;
		};
		expect(persisted).toEqual({ version: 1, trustedProjects: { [project]: true } });
	});

	it("normalizes symlinks and falls back to canonical cwd outside a repository", async () => {
		const { root, agentDir, project } = await fixture("symlink");
		const alias = join(root, "alias");
		await symlink(project, alias, process.platform === "win32" ? "junction" : "dir");
		expect(canonicalProjectHookIdentity(alias)).toBe(project);
		const store = new ProjectHookTrustStore(agentDir);
		store.trust(alias);
		expect(store.isTrusted(project).trusted).toBe(true);
	});

	it("merges updates from independent instances and creates private storage", async () => {
		const { root, agentDir, project } = await fixture("updates");
		const other = join(root, "other");
		await mkdir(other);
		new ProjectHookTrustStore(agentDir).trustAlways(project);
		new ProjectHookTrustStore(agentDir).trustAlways(other);
		expect(new ProjectHookTrustStore(agentDir).isTrusted(project).trusted).toBe(true);
		expect(new ProjectHookTrustStore(agentDir).isTrusted(other).trusted).toBe(true);
		if (process.platform !== "win32") {
			expect((await lstat(agentDir)).mode & 0o777).toBe(0o700);
			expect((await lstat(join(agentDir, "trusted-project-hooks.json"))).mode & 0o777).toBe(0o600);
		}
	});

	it("fails closed with readable errors for malformed and unreadable storage", async () => {
		const { agentDir, project } = await fixture("invalid");
		await mkdir(agentDir);
		const path = join(agentDir, "trusted-project-hooks.json");
		await writeFile(path, "{broken");
		const malformed = new ProjectHookTrustStore(agentDir).isTrusted(project);
		expect(malformed.trusted).toBe(false);
		expect(malformed.error).toContain("Unable to read project hook trust");
		await writeFile(path, JSON.stringify({ version: 99, trustedProjects: { [project]: true } }));
		expect(new ProjectHookTrustStore(agentDir).isTrusted(project)).toMatchObject({
			trusted: false,
			error: expect.stringContaining("version 1"),
		});
		if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0) {
			await chmod(path, 0o000);
			expect(new ProjectHookTrustStore(agentDir).isTrusted(project).trusted).toBe(false);
		}
	});
});

describe("hasProjectHookConfiguration", () => {
	it("detects only an actual hooks field in native or compatibility settings", async () => {
		const { project } = await fixture("configuration");
		await mkdir(join(project, ".pi"));
		await writeFile(join(project, ".pi", "settings.json"), JSON.stringify({ disableAllHooks: true }));
		expect(hasProjectHookConfiguration(project)).toBe(false);
		await mkdir(join(project, ".claude"));
		await writeFile(join(project, ".claude", "settings.local.json"), JSON.stringify({ hooks: null }));
		expect(hasProjectHookConfiguration(project)).toBe(true);
	});
});
