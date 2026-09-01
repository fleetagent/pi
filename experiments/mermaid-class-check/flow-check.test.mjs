import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkFlowchart } from "./flow-check.mjs";

const checkerPath = fileURLToPath(new URL("flow-check.mjs", import.meta.url));
const agentFlowPath = fileURLToPath(new URL("fixtures/pi-agent-tool-flow.mmd", import.meta.url));
const agentSourceRoot = fileURLToPath(new URL("../../packages/agent/src", import.meta.url));

function check(flowchart, source) {
	return checkFlowchart(flowchart, [{ path: "flow.ts", text: source }]);
}

describe("Mermaid code flow checker", () => {
	it("accepts direct and transitive function call paths", () => {
		const flowchart = `flowchart TD
			start["Start"]
			finish["Finish"]
			start --> finish
		`;
		const source = `
			function start(): void { middle(); }
			function middle(): void { finish(); }
			function finish(): void {}
		`;
		assert.deepEqual(check(flowchart, source), []);
	});

	it("accepts ordered phases called by a shared orchestrator", () => {
		const flowchart = `flowchart LR
			prepare["Prepare"]
			execute["Execute"]
			prepare --> execute
		`;
		const source = `
			function orchestrate(): void { prepare(); execute(); }
			function prepare(): void {}
			function execute(): void {}
		`;
		assert.deepEqual(check(flowchart, source), []);
	});

	it("maps readable node ids to class methods", () => {
		const flowchart = `flowchart TD
			entry["Service.run()"]
			helper["Helper"]
			%% pi:symbol entry Service.run
			entry --> helper
		`;
		const source = `
			function helper(): void {}
			class Service { public run(): void { helper(); } }
		`;
		assert.deepEqual(check(flowchart, source), []);
	});

	it("reports missing symbols and flow edges unsupported by code", () => {
		const flowchart = `flowchart TD
			first["First"]
			second["Second"]
			missing["Missing"]
			first --> second
		`;
		const source = `function first(): void {} function second(): void {}`;
		const messages = check(flowchart, source).map((result) => result.message);
		assert.ok(messages.some((message) => message.includes("Missing code symbol 'missing'")));
		assert.ok(messages.some((message) => message.includes("No static call or ordered phase path")));
	});

	it("validates the Pi agent flowchart from a recursively scanned source directory", () => {
		const run = spawnSync(process.execPath, [checkerPath, agentFlowPath, agentSourceRoot], { encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
		assert.match(run.stdout, /Flowchart matches; scanned \d+ TypeScript source file/);
	});
});
