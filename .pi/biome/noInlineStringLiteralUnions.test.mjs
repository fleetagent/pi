import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeStringLiteralUnionSource } from "./noInlineStringLiteralUnions.mjs";

function analyze(sourceText) {
	return analyzeStringLiteralUnionSource("packages/example/src/fixture.ts", sourceText);
}

describe("noInlineStringLiteralUnions", () => {
	it("reports inline string-literal unions in interface and class properties", () => {
		const diagnostics = analyze(`
			export interface PiAgentDiagnostic {
				type: "info" | "warning" | "error";
				message: string;
			}
			class WorkspaceState {
				availability: "remote" | "unavailable" = "unavailable";
			}
		`);
		assert.deepEqual(
			diagnostics.map((diagnostic) => diagnostic.location.start.line),
			[3, 7],
		);
		assert.match(diagnostics[0].message, /^\[noInlineStringLiteralUnions\]/);
		assert.match(diagnostics[0].message, /named type alias/);
		assert.match(diagnostics[0].message, /do not use an enum/);
	});

	it("reports inline string-literal unions in parameters and return types", () => {
		const diagnostics = analyze(`
			function resolveWorkspaceToolExecution(
				mode: "local" | "remote",
			): "remote" | "unavailable" {
				return mode === "remote" ? "remote" : "unavailable";
			}
			interface Resolver {
				resolve(mode: "local" | "remote"): Promise<"remote" | "unavailable">;
			}
		`);
		assert.deepEqual(
			diagnostics.map((diagnostic) => diagnostic.location.start.line),
			[3, 4, 8, 8],
		);
	});

	it("reports constructor parameters and nested signature annotations without duplicates", () => {
		const diagnostics = analyze(`
			class Runner {
				constructor(public mode: "local" | "remote") {}
				handler: (state: "idle" | "running") => Promise<"done" | "failed">;
			}
		`);
		assert.equal(diagnostics.length, 3);
	});

	it("allows named string-literal unions and does not require enums", () => {
		const diagnostics = analyze(`
			type WorkspaceAvailability = "remote" | "unavailable";
			type DiagnosticType = "info" | "warning" | "error";
			interface Diagnostic {
				type: DiagnosticType;
			}
			class Resolver {
				resolve(mode: WorkspaceAvailability): WorkspaceAvailability {
					return mode;
				}
			}
		`);
		assert.deepEqual(diagnostics, []);
	});

	it("does not report single literals, property-key unions, or unrelated annotations", () => {
		const diagnostics = analyze(`
			interface Fixed { type: "info"; value: string | number; }
			interface State { left: string; right: string; }
			type InlineOptions = { mode: "local" | "remote" };
			const value: "left" | "right" = "left";
			function select(input: Pick<State, "left" | "right">): State["left" | "right"] {
				return input.left;
			}
			void value;
		`);
		assert.deepEqual(diagnostics, []);
	});
});
