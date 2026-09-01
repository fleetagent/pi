import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeInlineTypeImportSource } from "./noInlineTypeImports.mjs";

function analyze(sourceText) {
	return analyzeInlineTypeImportSource("packages/example/src/fixture.ts", sourceText);
}

describe("noInlineTypeImports", () => {
	it("reports inline module types, imported members, assertions, and generic arguments", () => {
		const diagnostics = analyze(`
			type Photon = typeof import("photon-node");
			let theme: typeof import("./theme.ts").theme;
			function render(value: import("./theme.ts").Theme): import("./render.ts").RenderResult {
				return value as typeof import("./render.ts").fallback;
			}
			declare function importActual<T>(path: string): Promise<T>;
			void importActual<typeof import("node:fs")>("node:fs");
		`);
		assert.deepEqual(
			diagnostics.map((diagnostic) => diagnostic.location.start.line),
			[2, 3, 4, 4, 5, 8],
		);
		assert.match(diagnostics[0].message, /^\[noInlineTypeImports\]/);
		assert.match(diagnostics[1].message, /\.\/theme\.ts/);
	});

	it("allows top-level type imports and runtime dynamic imports", () => {
		const diagnostics = analyze(`
			import type { Theme } from "./theme.ts";
			import type * as PhotonModule from "photon-node";
			let theme: Theme;
			type Photon = typeof PhotonModule;
			async function load() {
				return await import("./runtime.ts");
			}
			void theme;
			void load;
		`);
		assert.deepEqual(diagnostics, []);
	});
});
