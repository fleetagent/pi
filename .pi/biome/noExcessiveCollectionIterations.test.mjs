import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeCollectionIterationSource } from "./noExcessiveCollectionIterations.mjs";

function analyze(sourceText) {
	return analyzeCollectionIterationSource("packages/example/src/fixture.ts", sourceText);
}

describe("noExcessiveCollectionIterations", () => {
	it("reports nested loops and linear membership lookups inside loops", () => {
		const diagnostics = analyze(`
			function intersect(left: string[], right: string[]) {
				const matches = [];
				for (const item of left) {
					if (right.includes(item)) matches.push(item);
					for (const candidate of right) {
						if (candidate === item) matches.push(candidate);
					}
				}
				return matches;
			}
		`);
		assert.equal(diagnostics.length, 1);
		assert.match(diagnostics[0].message, /^\[noExcessiveCollectionIterations\] Function intersect/);
		assert.match(diagnostics[0].message, /linear \.includes\(\) lookup over outer-invariant data/);
		assert.match(diagnostics[0].message, /nested traversal over an outer-invariant collection or bound/);
	});

	it("reports collection traversal nested in iteration callbacks", () => {
		const diagnostics = analyze(`
			function matchOwners(users: User[], teams: Team[]) {
				return users.map(((user) => teams.find((team) => team.ownerId === user.id)));
			}
		`);
		assert.equal(diagnostics.length, 1);
		assert.match(diagnostics[0].message, /\.find\(\) traversal of outer-invariant data inside an iteration/);
	});

	it("reports repeated map and filter chains while allowing one filter-map pipeline", () => {
		const diagnostics = analyze(`
			function repeated(values: number[]) {
				const filtered = values.filter(Boolean).filter((value) => value > 1);
				return filtered.map(String).map((value) => value.trim());
			}
			function ordinary(values: number[]) {
				return values.filter((value) => value > 0).map(String);
			}
		`);
		assert.equal(diagnostics.length, 1);
		assert.match(diagnostics[0].message, /Function repeated/);
		assert.match(diagnostics[0].message, /repeated adjacent \.filter\(\) passes/);
		assert.match(diagnostics[0].message, /repeated adjacent \.map\(\) passes/);
	});

	it("allows distinct transformation stages and interrupted method chains", () => {
		const diagnostics = analyze(`
			const project = (values: number[]) => values.filter(Boolean).map(String).flatMap((value) => value.split(""));
			const interrupted = (values: number[]) => values.map(String).join("").split("").map((value) => value.trim());
		`);
		assert.deepEqual(diagnostics, []);
	});

	it("allows sequential loops, indexed membership, and nested helper declarations", () => {
		const diagnostics = analyze(`
			function linear(left: string[], right: string[]) {
				const rightSet = new Set(right);
				const matches = [];
				for (const item of left) {
					if (rightSet.has(item)) matches.push(item);
				}
				for (const item of right) matches.push(item);
				for (const group of [{ members: left }, { members: right }]) {
					for (const member of group.members) matches.push(member);
				}
				left.some((item) => item.includes("needle"));
				function unusedPairwise() {
					for (const x of left) for (const y of right) console.log(x, y);
				}
				return { matches, unusedPairwise };
			}
		`);
		assert.equal(diagnostics.length, 1);
		assert.match(diagnostics[0].message, /Function unusedPairwise/);
	});

	it("treats item-derived aliases and string searches as dependent work", () => {
		const diagnostics = analyze(`
			function hierarchical(entries: Entry[], baseUrl: string, fragments: string[]) {
				for (const entry of entries) {
					const details = getDetails(entry);
					for (const file of details.readFiles) console.log(file);
				}
				entries.forEach((entry) => {
					const details = entry.details;
					for (const details of entry.children) console.log(details);
					details.files.map((file) => file.name);
				});
				return fragments.some((fragment) => baseUrl.includes(fragment));
			}
		`);
		assert.deepEqual(diagnostics, []);
	});

	it("tracks predeclared loop counters and scope-sensitive alias reassignment", () => {
		const diagnostics = analyze(`
			function repeated(items: Item[], shared: Item[], text: string) {
				let index = 0;
				while (index < items.length) {
					shared.find((candidate) => candidate.id === items[index].id);
					index++;
				}
				for (let item of items) {
					let details = item.details;
					details = shared;
					details.find((candidate) => candidate.id === item.id);
					{
						const item = { values: shared };
						item.values.find(Boolean);
					}
				}
				return text.includes("safe string lookup");
			}
		`);
		assert.equal(diagnostics.length, 1);
		assert.match(diagnostics[0].message, /Function repeated/);
		assert.match(diagnostics[0].message, /\.find\(\) traversal of outer-invariant data/);
	});

	it("allows a reasoned ignore for intentionally bounded or pairwise algorithms", () => {
		const diagnostics = analyze(`
			// pi-ignore noExcessiveCollectionIterations: Matrix dimensions are capped at 4x4 by validated input.
			function multiplySmallMatrices(left: number[][], right: number[][]) {
				for (const row of left) {
					for (const column of right) console.log(row, column);
				}
			}
			// pi-ignore noExcessiveCollectionIterations:
			function missingReason(left: number[], right: number[]) {
				for (const x of left) for (const y of right) console.log(x, y);
			}
		`);
		assert.equal(diagnostics.length, 1);
		assert.match(diagnostics[0].message, /Function missingReason/);
	});
});
