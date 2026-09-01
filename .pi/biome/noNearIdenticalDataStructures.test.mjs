import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeInterfaceSources, normalizeInterfaceMember } from "./noNearIdenticalDataStructures.mjs";

function analyze(...sources) {
	return analyzeInterfaceSources(
		sources.map((sourceText, index) => ({ path: `src/fixture-${index + 1}.ts`, sourceText })),
	);
}

describe("noNearIdenticalDataStructures", () => {
	it("normalizes optional, readonly, nullable, unordered union, whitespace, and member order differences", () => {
		const diagnostics = analyze(
			`interface Person {
				age: number;
				readonly name: string | undefined;
				status: string | number;
				id: string;
			}`,
			`interface User {
				id: string;
				name?: string;
				status?: number | undefined | string;
				age: null | number;
			}`,
		);
		assert.equal(diagnostics.length, 2);
		assert.match(diagnostics[0].message, /^\[noNearIdenticalDataStructures\]/);
		assert.match(diagnostics[0].message, /Person/);
		assert.match(diagnostics[1].message, /User/);
	});

	it("does not merge materially different structures or trivial one-member contracts", () => {
		const diagnostics = analyze(`
			interface Person { id: string; age: number; }
			interface User { id: string; age: bigint; }
			interface LeftId { id: string; }
			interface RightId { id?: string | undefined; }
		`);
		assert.deepEqual(diagnostics, []);
	});

	it("preserves generic constraints and heritage when comparing structures", () => {
		const diagnostics = analyze(`
			interface StringValue<T extends string> { id: string; value: T; }
			interface NumberValue<T extends number> { value: T; id: string; }
			interface StoredValue extends StoredRecord { id: string; value: string; }
			interface WireValue extends WireRecord { value: string; id: string; }
		`);
		assert.deepEqual(diagnostics, []);
	});

	it("preserves nested structure while normalizing top-level unions", () => {
		assert.equal(
			normalizeInterfaceMember("callback?: ((value: string) => number) | undefined;"),
			"callback:((value:string)=>number)",
		);
		const diagnostics = analyze(`
			interface First { id: string; payload: { value: string }; }
			interface Second { payload: { value: number }; id: string; }
		`);
		assert.deepEqual(diagnostics, []);
	});

	it("supports a reasoned declaration-level ignore for intentionally distinct domains", () => {
		const diagnostics = analyze(`
			interface Person { id: string; age: number; }
			// pi-ignore noNearIdenticalDataStructures: External user identity has separate lifecycle ownership.
			interface User { age: number | null; id?: string; }
		`);
		assert.deepEqual(diagnostics, []);
	});

	it("does not accept an ignore directive without a reason", () => {
		const diagnostics = analyze(`
			interface Person { id: string; age: number; }
			// pi-ignore noNearIdenticalDataStructures:
			interface User { age: number | null; id?: string; }
			/* pi-ignore noNearIdenticalDataStructures: */
			interface Account { id: string | undefined; age?: number; }
		`);
		assert.equal(diagnostics.length, 3);
	});
});
