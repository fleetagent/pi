import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as CoreValues from "../src/core/index.ts";
import * as LspValues from "../src/core/lsp/index.ts";
import * as RootValues from "../src/index.ts";

interface ExportContractEntry {
	target: ts.Symbol;
	type: boolean;
	value: boolean;
}

interface LoadedExportSurfaces {
	barrels: Record<keyof typeof barrelPaths, Map<string, ExportContractEntry>>;
	leaves: Map<string, Map<string, ExportContractEntry>>;
}

const barrelPaths = {
	lsp: fileURLToPath(new URL("../src/core/lsp/index.ts", import.meta.url)),
	core: fileURLToPath(new URL("../src/core/index.ts", import.meta.url)),
	root: fileURLToPath(new URL("../src/index.ts", import.meta.url)),
};
const lspSourceDirectory = dirname(barrelPaths.lsp);
const leafFileNames = ts.sys
	.readDirectory(lspSourceDirectory, [".ts"], undefined, ["**/*.ts"])
	.map((path) => path.slice(lspSourceDirectory.length + 1))
	.filter((fileName) => fileName !== "index.ts")
	.sort();
const intentionallyInternalLeafExports = new Set([
	"abort.ts:throwIfAborted",
	"abort.ts:waitForAbort",
	"client.ts:getTextFromToolContent",
	"portable-path.ts:PortablePathFlavor",
	"portable-path.ts:absolutePathFlavor",
	"portable-path.ts:dirnamePortablePath",
	"portable-path.ts:isPortableAbsolute",
	"portable-path.ts:joinPortablePath",
	"portable-path.ts:normalizePortablePath",
	"portable-path.ts:pathApi",
	"portable-path.ts:pathComparisonValue",
	"portable-path.ts:pathFlavor",
	"portable-path.ts:portablePathToFileUri",
	"portable-path.ts:relativePortablePath",
	"portable-path.ts:relativeWithin",
	"portable-path.ts:resolvePortablePath",
]);

function resolveExports(checker: ts.TypeChecker, sourceFile: ts.SourceFile): Map<string, ExportContractEntry> {
	const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
	if (!moduleSymbol) throw new Error(`Expected module symbol for ${sourceFile.fileName}`);

	return new Map(
		checker.getExportsOfModule(moduleSymbol).map((exportSymbol) => {
			const target =
				exportSymbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exportSymbol) : exportSymbol;
			return [
				exportSymbol.name,
				{
					target,
					type: Boolean(target.flags & ts.SymbolFlags.Type),
					value: Boolean(target.flags & ts.SymbolFlags.Value),
				},
			];
		}),
	);
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
	return ts.formatDiagnostics(diagnostics, {
		getCanonicalFileName: (fileName) => fileName,
		getCurrentDirectory: () => process.cwd(),
		getNewLine: () => "\n",
	});
}

function loadAuthoritativeSurfaces(): LoadedExportSurfaces {
	const configPath = ts.findConfigFile(dirname(barrelPaths.root), ts.sys.fileExists, "tsconfig.json");
	if (!configPath) throw new Error("Expected repository tsconfig.json");
	const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
	if (configFile.error) throw new Error(formatDiagnostics([configFile.error]));
	const parsed = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		dirname(configPath),
		{ noEmit: true },
		configPath,
	);
	const program = ts.createProgram({
		rootNames: [
			...Object.values(barrelPaths),
			...leafFileNames.map((fileName) => join(lspSourceDirectory, fileName)),
		],
		options: parsed.options,
		projectReferences: parsed.projectReferences,
	});
	const isContractDiagnostic = (diagnostic: ts.Diagnostic): boolean => {
		if (!diagnostic.file) return true;
		const fileName = diagnostic.file.fileName;
		return Object.values(barrelPaths).includes(fileName) || fileName.startsWith(`${lspSourceDirectory}${sep}`);
	};
	const diagnostics = [
		...parsed.errors,
		...program.getConfigFileParsingDiagnostics(),
		...program.getOptionsDiagnostics(),
		...program.getGlobalDiagnostics(),
		...program.getSyntacticDiagnostics().filter(isContractDiagnostic),
		...program.getSemanticDiagnostics().filter(isContractDiagnostic),
	];
	if (diagnostics.length > 0) throw new Error(formatDiagnostics(diagnostics));

	const checker = program.getTypeChecker();
	const barrels = Object.fromEntries(
		Object.entries(barrelPaths).map(([name, path]) => {
			const sourceFile = program.getSourceFile(path);
			if (!sourceFile) throw new Error(`Expected source file for ${path}`);
			return [name, resolveExports(checker, sourceFile)];
		}),
	) as Record<keyof typeof barrelPaths, Map<string, ExportContractEntry>>;
	const leaves = new Map(
		leafFileNames.map((fileName) => {
			const path = join(lspSourceDirectory, fileName);
			const sourceFile = program.getSourceFile(path);
			if (!sourceFile) throw new Error(`Expected source file for ${path}`);
			return [fileName, resolveExports(checker, sourceFile)];
		}),
	);
	return { barrels, leaves };
}

function originatesInLspSource(entry: ExportContractEntry): boolean {
	return Boolean(
		entry.target.declarations?.some((declaration) => {
			const fileName = declaration.getSourceFile().fileName;
			return fileName === barrelPaths.lsp || fileName.startsWith(`${lspSourceDirectory}${sep}`);
		}),
	);
}

const surfaces = loadAuthoritativeSurfaces();
const authoritativeContract = surfaces.barrels.lsp;
const authoritativeRuntimeNames = [...authoritativeContract]
	.filter(([, entry]) => entry.value)
	.map(([name]) => name)
	.sort();

describe("public LSP exports", () => {
	it("uses the LSP barrel as the authoritative declaration contract for every public barrel", () => {
		for (const [name, expected] of authoritativeContract) {
			for (const barrelName of ["core", "root"] as const) {
				const actual = surfaces.barrels[barrelName].get(name);
				expect(actual, `${barrelName} barrel is missing ${name}`).toBeDefined();
				expect(actual?.target, `${barrelName}.${name} declaration identity`).toBe(expected.target);
				expect(actual?.type, `${barrelName}.${name} type export`).toBe(expected.type);
			}
		}

		for (const barrelName of ["core", "root"] as const) {
			const uncontractedLspExports = [...surfaces.barrels[barrelName]]
				.filter(([name, entry]) => originatesInLspSource(entry) && !authoritativeContract.has(name))
				.map(([name]) => name);
			expect(uncontractedLspExports, `${barrelName} has LSP exports outside the authoritative barrel`).toEqual([]);
		}
	});

	it("requires every exported public-leaf declaration to be contracted or explicitly internal", () => {
		const uncontractedLeafExports = [...surfaces.leaves].flatMap(([fileName, exports]) =>
			[...exports]
				.filter(([name, entry]) => {
					const contracted = authoritativeContract.get(name);
					if (contracted) return contracted.target !== entry.target;
					return !intentionallyInternalLeafExports.has(`${fileName}:${name}`);
				})
				.map(([name]) => `${fileName}:${name}`),
		);
		expect(uncontractedLeafExports).toEqual([]);
		for (const internalExport of intentionallyInternalLeafExports) {
			const [fileName, name] = internalExport.split(":");
			const internalEntry = surfaces.leaves.get(fileName)?.get(name);
			expect(internalEntry, `${internalExport} still exists`).toBeDefined();
			const publicAliases = [...authoritativeContract]
				.filter(([, publicEntry]) => publicEntry.target === internalEntry?.target)
				.map(([publicName]) => publicName);
			expect(publicAliases, `${internalExport} remains internal under every name`).toEqual([]);
		}
	});

	it("exports every authoritative runtime value by ownership and identity from each public barrel", () => {
		expect(Object.keys(LspValues).sort()).toEqual(authoritativeRuntimeNames);
		for (const name of authoritativeRuntimeNames) {
			expect(authoritativeContract.has(name), `LSP runtime export ${name} has a declaration`).toBe(true);
			expect(Object.hasOwn(CoreValues, name), `core owns ${name}`).toBe(true);
			expect(Object.hasOwn(RootValues, name), `root owns ${name}`).toBe(true);
			expect(Reflect.get(CoreValues, name), `core.${name}`).toBe(Reflect.get(LspValues, name));
			expect(Reflect.get(RootValues, name), `root.${name}`).toBe(Reflect.get(LspValues, name));
		}
	});
});
