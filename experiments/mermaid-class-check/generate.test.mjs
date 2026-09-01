import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { generateClassDiagram, generateFlowchart } from "./generate.mjs";

const generatorPath = fileURLToPath(new URL("generate.mjs", import.meta.url));
const sampleSourcePath = fileURLToPath(new URL("fixtures/sample.ts", import.meta.url));

async function sampleSource() {
	return { path: sampleSourcePath, text: await readFile(sampleSourcePath, "utf8") };
}

describe("Mermaid diagram generator", () => {
	it("deterministically generates a validated class diagram from an entry declaration", async () => {
		const source = await sampleSource();
		const first = generateClassDiagram("User", source, [source]);
		const second = generateClassDiagram("User", source, [source]);
		assert.equal(first, second);
		assert.match(first, /^classDiagram/m);
		assert.match(first, /class User \{/);
		assert.match(first, /Identifiable <\|\.\. User/);
		assert.match(first, /User "1" --> "\*" Session/);
	});

	it("deterministically generates a validated flowchart from a function", () => {
		const source = {
			path: "/project/flow.ts",
			text: `
				function start(): void { prepare(); execute(); }
				function prepare(): void {}
				function execute(): void { finish(); }
				function finish(): void {}
			`,
		};
		const first = generateFlowchart("start", source.path, [source], { depth: 3 });
		const second = generateFlowchart("start", source.path, [source], { depth: 3 });
		assert.equal(first, second);
		assert.match(first, /^flowchart TD/m);
		assert.match(first, /start --> prepare/);
		assert.match(first, /start --> execute/);
		assert.match(first, /execute --> finish/);
	});

	it("writes a generated diagram through the CLI", async () => {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "mermaid-generate-"));
		const outputPath = join(temporaryDirectory, "user.class.mmd");
		try {
			const run = spawnSync(
				process.execPath,
				[generatorPath, "class", sampleSourcePath, "User", "--source", sampleSourcePath, "--output", outputPath],
				{ encoding: "utf8" },
			);
			assert.equal(run.status, 0, run.stderr);
			assert.match(run.stdout, /Generated validated class diagram/);
			assert.match(await readFile(outputPath, "utf8"), /^classDiagram/m);
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	});
});
