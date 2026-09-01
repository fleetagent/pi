import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const biomeBinary = join(repositoryRoot, "node_modules", ".bin", process.platform === "win32" ? "biome.cmd" : "biome");
const pluginPath = join(repositoryRoot, ".pi", "biome", "noInlineFunctionObjectTypes.grit");

describe("noInlineFunctionObjectTypes GritQL plugin", () => {
	it("reports inline objects in function signatures and named object contracts", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-inline-types-"));
		try {
			const fixturePath = join(directory, "fixture.ts");
			const configPath = join(directory, "biome.json");
			const fixtureLines = [
				"interface NamedValue { value: string; }",
				"type Handler = (input: { id: string }) => Promise<{ value: string }>;",
				"type GenericHandler = <T extends { id: string }>(value: T) => T;",
				"const local: { value: string } = { value: 'ok' };",
				"function flagged(input: { id: string }): Promise<{ value: string }> { return Promise.resolve({ value: input.id }); }",
				"class Service { method(input: { id: string }): { value: string } { return { value: input.id }; } }",
				"const callback = (input: { id: string }): Promise<{ value: string }> => Promise.resolve({ value: input.id });",
				"function nested(input: { config: { enabled: boolean } }): Promise<{ result: { ok: boolean } }> { return Promise.resolve({ result: { ok: input.config.enabled } }); }",
				"function higherOrder(cb: (arg: { id: string }) => void): () => { id: string } { return () => ({ id: 'ok' }); }",
				"function rest(...items: Array<{ id: string }>): void { void items; }",
				"function withThis(this: { id: string }): void { void this; }",
				"function allowed(input: NamedValue): NamedValue { return input; }",
				"const typedHandler: (input: { id: string }) => void = () => {};",
				"interface TypedProperty { callback: (input: { id: string }) => void; }",
				"function genericHigher(handler: <T extends { id: string }>(value: T) => T): <T extends { id: string }>(value: T) => T { return handler; }",
				"type CallableConstraint<T extends (input: { id: string }) => void> = T;",
				"interface DockerInspectRecord { Config?: { Image?: string; Labels?: Record<string, string>; }; State?: { Status?: string; Running?: boolean; }; NetworkSettings?: { Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>; }; }",
				"type Envelope = { payload: { id: string }; entries: Array<{ value: string }>; callback: (input: { id: string }) => void; };",
				"void local; void callback; void typedHandler;",
			];
			writeFileSync(fixturePath, fixtureLines.join("\n"));
			writeFileSync(
				configPath,
				JSON.stringify({
					plugins: [pluginPath],
					linter: { enabled: true, rules: { preset: "none" } },
					formatter: { enabled: false },
				}),
			);

			const result = spawnSync(biomeBinary, ["lint", `--config-path=${configPath}`, "--reporter=json", fixturePath], {
				encoding: "utf8",
			});
			assert.equal(result.status, 1, result.stderr);
			const report = JSON.parse(result.stdout);
			assert.equal(report.diagnostics.length, 24);
			const diagnostics = [...report.diagnostics].sort(
				(left, right) =>
					left.location.start.line - right.location.start.line ||
					left.location.start.column - right.location.start.column,
			);
			assert.deepEqual(
				diagnostics.map((diagnostic) => {
					const { line, column } = diagnostic.location.start;
					const endColumn = diagnostic.location.end.column;
					return [line, fixtureLines[line - 1].slice(column - 1, endColumn - 1)];
				}),
				[
					[2, "(input: { id: string }) => Promise<{ value: string }>"],
					[5, "{ id: string }"],
					[5, "Promise<{ value: string }>"],
					[6, "{ id: string }"],
					[6, "{ value: string }"],
					[7, "{ id: string }"],
					[7, "Promise<{ value: string }>"],
					[8, "{ config: { enabled: boolean } }"],
					[8, "{ enabled: boolean }"],
					[8, "Promise<{ result: { ok: boolean } }>"],
					[8, "{ ok: boolean }"],
					[9, "(arg: { id: string }) => void"],
					[9, "() => { id: string }"],
					[10, "Array<{ id: string }>"],
					[11, "{ id: string }"],
					[13, "(input: { id: string }) => void"],
					[14, "(input: { id: string }) => void"],
					[17, "{ Image?: string; Labels?: Record<string, string>; }"],
					[17, "{ Status?: string; Running?: boolean; }"],
					[17, "{ Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>; }"],
					[17, "{ HostIp?: string; HostPort?: string }"],
					[18, "{ id: string }"],
					[18, "{ value: string }"],
					[18, "(input: { id: string }) => void"],
				],
			);
			for (const diagnostic of diagnostics) {
				assert.match(diagnostic.message, /^\[noInlineFunctionObjectTypes\]/);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
