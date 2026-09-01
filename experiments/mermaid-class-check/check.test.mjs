import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkClassDiagram } from "./check.mjs";

const checkerPath = fileURLToPath(new URL("check.mjs", import.meta.url));
const diagramPath = fileURLToPath(new URL("fixtures/sample.mmd", import.meta.url));
const validSourcePath = fileURLToPath(new URL("fixtures/sample.ts", import.meta.url));
const brokenSourcePath = fileURLToPath(new URL("fixtures/broken.ts", import.meta.url));
const agentDiagramPath = fileURLToPath(new URL("fixtures/pi-agent-tool-calls.mmd", import.meta.url));
const agentSourceRoot = fileURLToPath(new URL("../../packages/agent/src", import.meta.url));

async function readFixture(path) {
	return await readFile(path, "utf8");
}

describe("Mermaid class diagram checker", () => {
	it("accepts classes, interfaces, imports, exports, async functions, and relationships", async () => {
		const diagnostics = checkClassDiagram(await readFixture(diagramPath), [
			{ path: validSourcePath, text: await readFixture(validSourcePath) },
		]);
		assert.deepEqual(diagnostics, []);
	});

	it("accepts generic element types in collection relationships", () => {
		const diagram = `classDiagram
			class Registry {
				+AgentTool~any~[] tools
			}
			class AgentTool
			Registry "1" --> "*" AgentTool : contains
		`;
		const source = `
			class AgentTool {}
			class Registry { public tools: AgentTool<any>[] = []; }
		`;
		assert.deepEqual(checkClassDiagram(diagram, [{ path: "registry.ts", text: source }]), []);
	});

	it("reports declaration, module-boundary, async, and heritage mismatches", async () => {
		const diagnostics = checkClassDiagram(await readFixture(diagramPath), [
			{ path: brokenSourcePath, text: await readFixture(brokenSourcePath) },
		]);
		const messages = diagnostics.map((result) => result.message);
		assert.ok(messages.some((message) => message.includes("Expected 'Identifiable' to be an interface; found class")));
		assert.ok(messages.some((message) => message.includes("Missing export for 'Identifiable'")));
		assert.ok(messages.some((message) => message.includes("Missing import 'Clock' from './clock.ts'")));
		assert.ok(messages.some((message) => message.includes("Expected public id: string on 'User'")));
		assert.ok(messages.some((message) => message.includes("Expected public async refresh(): Promise<void>")));
		assert.ok(
			messages.some((message) =>
				message.includes("Expected async function createSession(User, Clock): Promise<Session>"),
			),
		);
		assert.ok(messages.some((message) => message.includes("'User' must implement 'Identifiable'")));
		assert.ok(messages.some((message) => message.includes("'Message' must extend 'BaseMessage'")));
		assert.ok(messages.some((message) => message.includes("'User' must contain a collection of 'Session'")));
	});

	it("supports reverse extends and implements arrows plus default exports", () => {
		const diagram = `classDiagram
			class Contract {
				+string id
			}
			<<interface>> Contract
			class Base
			class Worker {
				+string id
			}
			<<export>> Worker
			%% pi:default-export Worker
			Worker ..|> Contract : implements
			Worker --|> Base : extends
		`;
		const matchingSource = `
			interface Contract { id: string; }
			class Base {}
			export default class Worker extends Base implements Contract { public id: string = "worker"; }
		`;
		const brokenSource = `
			interface Contract { id: string; }
			class Base {}
			class Worker { public id: string = "worker"; }
		`;
		assert.deepEqual(checkClassDiagram(diagram, [{ path: "matching.ts", text: matchingSource }]), []);
		const messages = checkClassDiagram(diagram, [{ path: "broken.ts", text: brokenSource }]).map(
			(result) => result.message,
		);
		assert.ok(messages.some((message) => message.includes("Missing default export")));
		assert.ok(messages.some((message) => message.includes("must implement")));
		assert.ok(messages.some((message) => message.includes("must extend")));
	});

	it("checks async top-level function signatures", () => {
		const diagram = `classDiagram
			class loadUser {
				+loadUser(Promise~string~ id, number attempt): Promise~string~
			}
			<<function>> loadUser
			<<async>> loadUser
			<<export>> loadUser
		`;
		const source = `export async function loadUser(id: Promise<string>, attempt: number): Promise<string> { return await id + attempt; }`;
		assert.deepEqual(checkClassDiagram(diagram, [{ path: "function.ts", text: source }]), []);
	});

	it("reports diagram components that are absent from every discovered source", () => {
		const diagram = `classDiagram
			class MissingTool
			class runMissing {
				+runMissing(): void
			}
			<<function>> runMissing
		`;
		assert.deepEqual(checkClassDiagram(diagram, []), [
			{ line: 2, message: "Missing class 'MissingTool'." },
			{ line: 3, message: "Missing function 'runMissing'." },
		]);
	});

	it("provides a CLI for source files and recursively discovered source directories", () => {
		const validRun = spawnSync(process.execPath, [checkerPath, diagramPath, validSourcePath], { encoding: "utf8" });
		assert.equal(validRun.status, 0, validRun.stderr);
		assert.match(validRun.stdout, /Class diagram matches; scanned 1 TypeScript source file/);

		const directoryRun = spawnSync(process.execPath, [checkerPath, agentDiagramPath, agentSourceRoot], {
			encoding: "utf8",
		});
		assert.equal(directoryRun.status, 0, directoryRun.stderr);
		assert.match(directoryRun.stdout, /Class diagram matches; scanned \d+ TypeScript source file/);

		const brokenRun = spawnSync(process.execPath, [checkerPath, diagramPath, brokenSourcePath], { encoding: "utf8" });
		assert.equal(brokenRun.status, 1);
		assert.match(brokenRun.stderr, /class diagram mismatch/);
	});
});
