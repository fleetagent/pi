import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { runMigrations } from "../src/migrations.ts";

const tempDirs: string[] = [];
const originalAgentDir = process.env[ENV_AGENT_DIR];

afterEach(async () => {
	if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = originalAgentDir;
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("extension directory migration warnings", () => {
	it("does not mistake active hook script directories for legacy extensions", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-hooks-migration-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		process.env[ENV_AGENT_DIR] = agentDir;
		await mkdir(join(agentDir, "hooks"), { recursive: true });
		await mkdir(join(project, ".pi", "hooks"), { recursive: true });
		await writeFile(join(project, ".pi", "hooks", "check.mjs"), "export {};\n");

		expect(runMigrations(project).deprecationWarnings).toEqual([]);
	});

	it("continues warning about legacy custom tools directories", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-tools-migration-"));
		tempDirs.push(root);
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		process.env[ENV_AGENT_DIR] = agentDir;
		await mkdir(join(project, ".pi", "tools"), { recursive: true });
		await writeFile(join(project, ".pi", "tools", "custom.js"), "export {};\n");

		expect(runMigrations(project).deprecationWarnings).toEqual([
			"Project tools/ directory contains custom tools. Custom tools have been merged into extensions.",
		]);
	});
});
