import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	formatDiagnosticFeedback,
	guideNameForDiagnostic,
	loadGuide,
	parseBiomeReport,
	selectNextDiagnostic,
	selectNextDiagnosticGroup,
} from "./biome-feedback.mjs";

const complexityDiagnostic = {
	severity: "error",
	message: "Excessive complexity of 18 detected (max: 15).",
	category: "lint/complexity/noExcessiveCognitiveComplexity",
	location: { path: "src/a.ts", start: { line: 10, column: 3 } },
};

describe("Biome hook feedback", () => {
	it("parses reports and deterministically selects one diagnostic", () => {
		const later = {
			severity: "error",
			message: "Use const.",
			category: "lint/style/useConst",
			location: { path: "src/b.ts", start: { line: 1, column: 1 } },
		};
		const report = parseBiomeReport(JSON.stringify({ diagnostics: [later, complexityDiagnostic] }));
		assert.deepEqual(selectNextDiagnostic(report.diagnostics), complexityDiagnostic);
	});

	it("groups all diagnostics for the selected rule from one file", async () => {
		const message = "[noInlineFunctionObjectTypes] Extract this type.";
		const createDiagnostic = (path, diagnosticMessage, line) => ({
			severity: "error",
			message: diagnosticMessage,
			category: "plugin",
			location: { path, start: { line, column: 18 } },
		});
		const first = createDiagnostic("src/repeated.ts", message, 1);
		const second = createDiagnostic("src/repeated.ts", message, 2);
		const differentMessage = createDiagnostic(
			"src/repeated.ts",
			"[noInlineFunctionObjectTypes] Extract the complete result type.",
			3,
		);
		const differentRule = createDiagnostic("src/repeated.ts", "[anotherRule] Different rule.", 4);
		const differentFile = createDiagnostic("src/z-other.ts", message, 1);
		const diagnostics = selectNextDiagnosticGroup([differentRule, differentMessage, differentFile, second, first]);
		assert.deepEqual(diagnostics, [first, second, differentMessage]);
		const guide = await loadGuide(first);
		const feedback = formatDiagnosticFeedback(diagnostics, 5, guide);
		assert.match(feedback, /multiple violations of the same rule in one file/);
		assert.match(feedback, /- src\/repeated\.ts:1:18/);
		assert.match(feedback, /- src\/repeated\.ts:2:18/);
		assert.match(feedback, /- src\/repeated\.ts:3:18/);
		assert.match(feedback, /Extract the complete result type/);
		assert.doesNotMatch(feedback, /Different rule/);
		assert.doesNotMatch(feedback, /src\/z-other\.ts/);
	});

	it("reports cognitive-complexity diagnostics one at a time", () => {
		const later = {
			...complexityDiagnostic,
			location: { path: "src/a.ts", start: { line: 30, column: 3 } },
		};
		assert.deepEqual(selectNextDiagnosticGroup([later, complexityDiagnostic]), [complexityDiagnostic]);
	});

	it("prioritizes the file with the most remaining diagnostics", () => {
		const diagnostic = (path, category, line) => ({
			severity: "error",
			message: category,
			category,
			location: { path, start: { line, column: 1 } },
		});
		const crowdedFirst = diagnostic("src/crowded.ts", "lint/style/useConst", 1);
		const crowdedOtherRule = diagnostic("src/crowded.ts", "lint/style/useTemplate", 2);
		const crowdedSecond = diagnostic("src/crowded.ts", "lint/style/useConst", 3);
		const sparse = diagnostic("src/a-sparse.ts", "lint/style/useConst", 1);
		assert.deepEqual(selectNextDiagnosticGroup([sparse, crowdedSecond, crowdedOtherRule, crowdedFirst]), [
			crowdedFirst,
			crowdedSecond,
		]);
	});

	it("supports Biome reports that use path objects, spans, and descriptions", async () => {
		const diagnostic = {
			severity: "error",
			description: "Function has too many parameters.",
			category: "lint/complexity/useMaxParams",
			location: { path: { file: "src/legacy-shape.ts" }, span: [42, 50] },
		};
		const guide = await loadGuide(diagnostic);
		const feedback = formatDiagnosticFeedback(diagnostic, 1, guide);
		assert.match(feedback, /src\/legacy-shape\.ts \(byte offset 42\)/);
		assert.match(feedback, /Function has too many parameters/);
		assert.match(feedback, /useMaxParams\.md/);
	});

	it("maps known rules to their guide and unknown categories to the fallback", async () => {
		assert.equal(guideNameForDiagnostic(complexityDiagnostic), "noExcessiveCognitiveComplexity");
		assert.equal(guideNameForDiagnostic({ category: "format" }), "format");
		assert.equal(
			guideNameForDiagnostic({
				category: "plugin",
				message: "[noInlineFunctionObjectTypes] Extract this type.",
			}),
			"noInlineFunctionObjectTypes",
		);
		const nearDuplicate = {
			category: "plugin",
			message: "[noNearIdenticalDataStructures] Review these contracts.",
		};
		assert.equal(guideNameForDiagnostic(nearDuplicate), "noNearIdenticalDataStructures");
		const derivedAlias = {
			category: "plugin",
			message: "[noImplementationDerivedTypeAliases] Import the owner type.",
		};
		assert.equal(guideNameForDiagnostic(derivedAlias), "noImplementationDerivedTypeAliases");
		const inlineTypeImport = {
			category: "plugin",
			message: "[noInlineTypeImports] Add a top-level type import.",
		};
		assert.equal(guideNameForDiagnostic(inlineTypeImport), "noInlineTypeImports");
		const stringLiteralUnion = {
			category: "plugin",
			message: "[noInlineStringLiteralUnions] Name this finite string domain.",
		};
		assert.equal(guideNameForDiagnostic(stringLiteralUnion), "noInlineStringLiteralUnions");
		const collectionIterations = {
			category: "plugin",
			message: "[noExcessiveCollectionIterations] Avoid repeated collection passes.",
		};
		assert.equal(guideNameForDiagnostic(collectionIterations), "noExcessiveCollectionIterations");
		const collectionIterationsGuide = await loadGuide(collectionIterations);
		assert.match(collectionIterationsGuide.content, /Set.*Map|Map.*Set/);
		const stringLiteralUnionGuide = await loadGuide(stringLiteralUnion);
		assert.match(stringLiteralUnionGuide.content, /must remain a string-literal union type/i);
		const derivedAliasGuide = await loadGuide(derivedAlias);
		const inlineTypeImportGuide = await loadGuide(inlineTypeImport);
		assert.match(inlineTypeImportGuide.content, /top-level `import type`/);
		const nearDuplicateGuide = await loadGuide(nearDuplicate);
		assert.match(nearDuplicateGuide.content, /reasoned ignore directive/);
		const fallback = await loadGuide({ category: "lint/example/notDocumented" });
		assert.equal(fallback.guideName, "general");
		assert.match(fallback.content, /underlying issue/);
	});

	it("emits only the selected issue and its matching guide", async () => {
		const guide = await loadGuide(complexityDiagnostic);
		const feedback = formatDiagnosticFeedback(complexityDiagnostic, 7, guide);
		assert.match(feedback, /Resolve only this issue/);
		assert.match(feedback, /Remaining diagnostics in this run: 7/);
		assert.match(feedback, /src\/a\.ts:10:3/);
		assert.match(feedback, /methodA1/);
		assert.doesNotMatch(feedback, /Use const/);
	});
});
