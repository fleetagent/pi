import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeTypeAliasSource } from "./noImplementationDerivedTypeAliases.mjs";

function analyze(sourceText) {
	return analyzeTypeAliasSource("packages/example/src/fixture.ts", sourceText);
}

describe("noImplementationDerivedTypeAliases", () => {
	it("reports aliases derived through return, parameter, and indexed member extraction", () => {
		const diagnostics = analyze(`
			declare function load(input: LoadInput): Promise<LoadResult>;
			interface Service {
				handler?: (input: LoadInput) => Promise<LoadResult>;
				load(): Promise<LoadResult>;
			}
			type LoadedResult = ReturnType<Service["load"]>;
			type LoadArgument = Parameters<typeof load>[0];
			type Handler = NonNullable<Service["handler"]>;
			type HandlerResult = Exclude<Awaited<ReturnType<Handler>>, undefined>;
		`);
		assert.deepEqual(
			diagnostics.map((diagnostic) => diagnostic.location.start.line),
			[7, 8, 9, 10],
		);
		assert.match(diagnostics[0].message, /^\[noImplementationDerivedTypeAliases\]/);
		assert.match(diagnostics[0].message, /ReturnType, indexed member access/);
		assert.match(diagnostics[1].message, /Parameters/);
		assert.match(diagnostics[2].message, /indexed member access/);
	});

	it("allows stable named contracts and non-contract utility annotations", () => {
		const diagnostics = analyze(`
			interface LoadInput { path: string; }
			interface LoadResult { content: string; }
			type OptionalResult = LoadResult | undefined;
			type ResultFields = Pick<LoadResult, "content">;
			const timer: ReturnType<typeof setTimeout> | undefined = undefined;
			function run(input: string): LoadResult {
				return { content: input };
			}
			void timer;
		`);
		assert.deepEqual(diagnostics, []);
	});

	it("reports implementation-derived types used directly in function signatures", () => {
		const diagnostics = analyze(`
			interface Model { id: string; }
			class AgentSession {
				model: Model | undefined;
				requireModel(): NonNullable<AgentSession["model"]> {
					throw new Error();
				}
			}
			declare function consume(input: Parameters<(value: string) => void>[0]): void;
		`);
		assert.deepEqual(
			diagnostics.map((diagnostic) => diagnostic.location.start.line),
			[5, 9],
		);
		assert.match(diagnostics[0].message, /requireModel derives a function signature contract/);
		assert.match(diagnostics[0].message, /indexed member access/);
		assert.match(diagnostics[1].message, /Parameters/);
	});
});
