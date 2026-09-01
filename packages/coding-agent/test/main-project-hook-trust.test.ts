import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectHookTrustStore } from "../src/core/hooks/trust-store.ts";
import { createProjectHookTrustPolicy, type ProjectHookTrustChoice, type ProjectHookTrustPolicy } from "../src/main.ts";

interface ProjectHookTrustFixture {
	root: string;
	project: string;
	store: ProjectHookTrustStore;
}

interface ProjectHookTrustTestOptions {
	project: string;
	store: ProjectHookTrustStore;
	prompt: (cwd: string, identity: string) => Promise<ProjectHookTrustChoice>;
	interactive?: boolean;
	explicitTrust?: boolean;
	sessionId?: string;
}
const tempDirs: string[] = [];

async function fixture(withHooks = true): Promise<ProjectHookTrustFixture> {
	const root = await mkdtemp(join(tmpdir(), "pi-main-hook-trust-"));
	tempDirs.push(root);
	const project = join(root, "project");
	await mkdir(project);
	await writeFile(join(project, ".git"), "gitdir: elsewhere\n");
	if (withHooks) {
		await mkdir(join(project, ".pi"));
		await writeFile(join(project, ".pi", "settings.json"), JSON.stringify({ hooks: { SessionStart: [] } }));
	}
	return { root, project, store: new ProjectHookTrustStore(join(root, "agent")) };
}

function policy(options: ProjectHookTrustTestOptions): ProjectHookTrustPolicy {
	return createProjectHookTrustPolicy({
		initialCwd: options.project,
		initialSessionId: options.sessionId ?? "initial-session",
		explicitTrust: options.explicitTrust ?? false,
		interactive: options.interactive ?? true,
		skipInitialPrompt: false,
		store: options.store,
		prompt: options.prompt,
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("main project-hook trust startup policy", () => {
	it("denies project hooks when the interactive prompt is denied", async () => {
		const { project, store } = await fixture();
		const prompt = vi.fn(async () => "deny" as const);
		const trust = policy({ project, store, prompt });

		expect(await trust.resolveInitial(true)).toBe(false);
		expect(trust.isTrustedFor(project, "initial-session")).toBe(false);
		expect(prompt).toHaveBeenCalledOnce();
		expect(store.isTrusted(project).trusted).toBe(false);
	});

	it("consumes Trust once for only the initial session snapshot", async () => {
		const { project, store } = await fixture();
		const trust = policy({ project, store, prompt: async () => "once" });

		expect(await trust.resolveInitial(true)).toBe(true);
		expect(trust.getInitialTrustedIdentity()).toBe(project);
		expect(trust.isTrustedFor(project, "initial-session")).toBe(true);
		expect(trust.isTrustedFor(project, "initial-session")).toBe(false);
		expect(trust.isTrustedFor(project, "different-session")).toBe(false);
		expect(store.isTrusted(project).trusted).toBe(false);
	});

	it("persists Trust always", async () => {
		const { project, store } = await fixture();
		const trust = policy({ project, store, prompt: async () => "always" });

		expect(await trust.resolveInitial(true)).toBe(true);
		expect(trust.getInitialTrustedIdentity()).toBe(project);
		expect(store.isTrusted(project).trusted).toBe(true);
		expect(trust.isTrustedFor(project, "different-session")).toBe(true);
	});

	it("persists the repository identity displayed before an always-trust prompt", async () => {
		const { root, project, store } = await fixture();
		const other = join(root, "other");
		await mkdir(join(other, ".pi"), { recursive: true });
		await writeFile(join(other, ".git"), "gitdir: elsewhere\n");
		await writeFile(join(other, ".pi", "settings.json"), JSON.stringify({ hooks: { SessionStart: [] } }));
		const alias = join(root, "alias");
		await symlink(project, alias, process.platform === "win32" ? "junction" : "dir");
		const trust = policy({
			project: alias,
			store,
			prompt: async () => {
				await unlink(alias);
				await symlink(other, alias, process.platform === "win32" ? "junction" : "dir");
				return "always";
			},
		});

		expect(await trust.resolveInitial(true)).toBe(true);
		expect(store.isTrusted(project).trusted).toBe(true);
		expect(store.isTrusted(other).trusted).toBe(false);
	});

	it("uses persisted Trust always without prompting", async () => {
		const { project, store } = await fixture();
		store.trustAlways(project);
		const prompt = vi.fn(async () => "deny" as const);
		const trust = policy({ project, store, prompt });

		expect(await trust.resolveInitial(true)).toBe(true);
		expect(trust.getInitialTrustedIdentity()).toBe(project);
		expect(prompt).not.toHaveBeenCalled();
	});

	it("does not prompt when the project has no hooks", async () => {
		const { project, store } = await fixture(false);
		const prompt = vi.fn(async () => "always" as const);
		const trust = policy({ project, store, prompt });

		expect(await trust.resolveInitial(true)).toBe(false);
		expect(prompt).not.toHaveBeenCalled();
		expect(store.isTrusted(project).trusted).toBe(false);
	});

	it("fails closed without prompting in noninteractive mode", async () => {
		const { project, store } = await fixture();
		const prompt = vi.fn(async () => "always" as const);
		const trust = policy({ project, store, prompt, interactive: false });

		expect(await trust.resolveInitial(true)).toBe(false);
		expect(prompt).not.toHaveBeenCalled();
		expect(store.isTrusted(project).trusted).toBe(false);
	});

	it("does not prompt or trust project hooks for a non-local startup backend", async () => {
		const { project, store } = await fixture();
		const prompt = vi.fn(async () => "always" as const);
		const trust = policy({ project, store, prompt });

		expect(await trust.resolveInitial(false)).toBe(false);
		expect(prompt).not.toHaveBeenCalled();
		expect(store.isTrusted(project).trusted).toBe(false);
	});

	it("lets the explicit trust flag bypass store lookup and prompting", async () => {
		const { project, store } = await fixture();
		const prompt = vi.fn(async () => "deny" as const);
		const lookup = vi.spyOn(store, "isTrusted");
		const trust = policy({ project, store, prompt, explicitTrust: true });

		expect(await trust.resolveInitial(true)).toBe(true);
		expect(trust.isTrustedFor(project, "different-session")).toBe(true);
		expect(prompt).not.toHaveBeenCalled();
		expect(lookup).not.toHaveBeenCalled();
	});
});
