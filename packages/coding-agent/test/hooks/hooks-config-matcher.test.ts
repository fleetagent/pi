import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyHookOutput, hookSettingsSources, loadHooks, matchHookValue } from "../../src/core/hooks/index.ts";

describe("Claude-compatible hook configuration", () => {
	it("additively loads sources, attributes entries, deduplicates exact handlers, and fails open", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-hooks-"));
		const home = join(root, "home");
		const cwd = join(root, "project");
		await mkdir(join(home, ".claude"), { recursive: true });
		await mkdir(join(cwd, ".claude"), { recursive: true });
		const duplicate = { type: "command", command: "echo ok" };
		await writeFile(
			join(home, ".claude/settings.json"),
			JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [duplicate] }] } }),
		);
		await writeFile(
			join(cwd, ".claude/settings.json"),
			JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [duplicate, { type: "prompt" }] }] } }),
		);
		await writeFile(join(cwd, ".claude/settings.local.json"), "{not json");

		const loaded = await loadHooks({ cwd, home, sources: ["user", "project", "local"] });
		expect(loaded.handlers).toHaveLength(2);
		expect(Object.isFrozen(loaded)).toBe(true);
		expect(Object.isFrozen(loaded.handlers)).toBe(true);
		expect(Object.isFrozen(loaded.handlers[0]?.handler)).toBe(true);
		expect(loaded.handlers[0]?.source.kind).toBe("user");
		expect(loaded.handlers[1]?.handler.type).toBe("prompt");
		expect(loaded.diagnostics.map((item) => item.code)).toEqual(
			expect.arrayContaining(["unsupported-handler", "parse"]),
		);
	});

	it("prefers native Pi settings while additively supporting Claude compatibility settings", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-hooks-native-"));
		const home = join(root, "home");
		const cwd = join(root, "project");
		await mkdir(join(home, ".pi", "agent"), { recursive: true });
		await mkdir(join(home, ".claude"), { recursive: true });
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await mkdir(join(cwd, ".claude"), { recursive: true });
		const group = (commands: string[]) => ({
			hooks: { SessionStart: [{ hooks: commands.map((command) => ({ type: "command", command })) }] },
		});
		await writeFile(join(home, ".pi", "agent", "settings.json"), JSON.stringify(group(["native-user", "same"])));
		await writeFile(join(home, ".claude", "settings.json"), JSON.stringify(group(["claude-user", "same"])));
		await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify(group(["native-project"])));
		await writeFile(join(cwd, ".claude", "settings.json"), JSON.stringify(group(["claude-project"])));

		const sources = hookSettingsSources(cwd, home, ["user", "project"]);
		expect(sources.map((source) => source.path)).toEqual([
			join(home, ".pi", "agent", "settings.json"),
			join(home, ".claude", "settings.json"),
			join(cwd, ".pi", "settings.json"),
			join(cwd, ".claude", "settings.json"),
		]);
		const loaded = await loadHooks({ cwd, home, sources: ["user", "project"] });
		expect(
			loaded.handlers.map((hook) => (hook.handler.type === "command" ? hook.handler.command : hook.handler.type)),
		).toEqual(["native-user", "same", "claude-user", "native-project", "claude-project"]);
		expect(loaded.handlers[1]?.source.path).toBe(join(home, ".pi", "agent", "settings.json"));
	});

	it("discovers only user hooks by default and requires explicit project/local source selection", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-hooks-sources-"));
		const home = join(root, "home");
		const cwd = join(root, "project");
		await mkdir(join(home, ".claude"), { recursive: true });
		await mkdir(join(cwd, ".claude"), { recursive: true });
		const settings = (command: string) =>
			JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } });
		await writeFile(join(home, ".claude/settings.json"), settings("user"));
		await writeFile(join(cwd, ".claude/settings.json"), settings("project"));
		await writeFile(join(cwd, ".claude/settings.local.json"), settings("local"));
		expect((await loadHooks({ cwd, home })).handlers.map((hook) => hook.source.kind)).toEqual(["user"]);
		expect(
			(await loadHooks({ cwd, home, sources: ["user", "project", "local"] })).handlers.map(
				(hook) => hook.source.kind,
			),
		).toEqual(["user", "project", "local"]);
	});

	it("applies merged Claude HTTP URL and environment policy", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-hooks-http-policy-"));
		const home = join(root, "home");
		await mkdir(join(home, ".claude"), { recursive: true });
		await writeFile(
			join(home, ".claude/settings.json"),
			JSON.stringify({
				allowedHttpHookUrls: ["https://allowed.example/hook"],
				httpHookAllowedEnvVars: ["TOKEN"],
				hooks: {
					SessionStart: [
						{
							hooks: [
								{
									type: "http",
									url: "https://allowed.example/hook",
									headers: { authorization: "$TOKEN-$SECRET" },
									allowedEnvVars: ["TOKEN", "SECRET"],
								},
								{ type: "http", url: "https://denied.example/hook" },
							],
						},
					],
				},
			}),
		);
		const loaded = await loadHooks({ cwd: root, home });
		expect(loaded.handlers).toHaveLength(1);
		expect(loaded.handlers[0]?.httpHookAllowedEnvVars).toEqual(["TOKEN"]);
		expect(loaded.diagnostics.some((diagnostic) => diagnostic.code === "policy")).toBe(true);
	});

	it("uses final included-source precedence for disableAllHooks", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-hooks-disabled-"));
		const home = join(root, "home");
		const cwd = join(root, "project");
		await mkdir(join(home, ".claude"), { recursive: true });
		await mkdir(join(cwd, ".claude"), { recursive: true });
		const hook = { SessionStart: [{ hooks: [{ type: "command", command: "echo ok" }] }] };
		await writeFile(join(home, ".claude/settings.json"), JSON.stringify({ disableAllHooks: true, hooks: hook }));
		await writeFile(join(cwd, ".claude/settings.json"), JSON.stringify({ disableAllHooks: false }));
		expect((await loadHooks({ cwd, home, sources: ["user", "project"] })).handlers).toHaveLength(1);
		await writeFile(join(cwd, ".claude/settings.local.json"), JSON.stringify({ disableAllHooks: true }));
		expect((await loadHooks({ cwd, home, sources: ["user", "project", "local"] })).handlers).toHaveLength(0);
	});

	it("supports match-all, exact alternatives, and unanchored JS regex", () => {
		expect(matchHookValue(undefined, "Bash").matches).toBe(true);
		expect(matchHookValue("Edit, Write|Bash", "Write").matches).toBe(true);
		expect(matchHookValue("Edit", "NotebookEdit").matches).toBe(false);
		expect(matchHookValue("Edit.*", "NotebookEdit").matches).toBe(true);
		expect(matchHookValue("[", "Bash")).toMatchObject({ matches: false, error: expect.any(String) });
	});

	it("uses Claude's leading-object output classification", () => {
		expect(classifyHookOutput('  {"decision":"block"}').kind).toBe("json");
		expect(classifyHookOutput(" {broken")).toEqual({ kind: "text", text: " {broken", malformedJson: true });
		expect(classifyHookOutput("[1,2]")).toEqual({ kind: "text", text: "[1,2]", malformedJson: false });
	});
});
