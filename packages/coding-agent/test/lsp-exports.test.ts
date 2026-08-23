import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as ClientValues from "../src/core/lsp/client.ts";
import * as ConfigValues from "../src/core/lsp/config.ts";
import * as ConfigLoaderValues from "../src/core/lsp/config-loader.ts";
import * as DiagnosticsValues from "../src/core/lsp/diagnostics.ts";
import * as FileSyncValues from "../src/core/lsp/file-sync.ts";
import * as IntegrationValues from "../src/core/lsp/integration.ts";
import * as LanguageMapValues from "../src/core/lsp/language-map.ts";
import * as ManagerValues from "../src/core/lsp/manager.ts";
import * as NavigationValues from "../src/core/lsp/navigation.ts";
import * as RefactorValues from "../src/core/lsp/refactor.ts";
import * as TransportValues from "../src/core/lsp/transport.ts";
import * as RootValues from "../src/index.ts";

interface ExportContractEntry {
	target: ts.Symbol;
	type: boolean;
	value: boolean;
}

const rootPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const lspSourceDirectory = fileURLToPath(new URL("../src/core/lsp", import.meta.url));
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
const lspRuntimeValues = {
	...ClientValues,
	...ConfigValues,
	...ConfigLoaderValues,
	...DiagnosticsValues,
	...FileSyncValues,
	...IntegrationValues,
	...LanguageMapValues,
	...ManagerValues,
	...NavigationValues,
	...RefactorValues,
	...TransportValues,
};

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

function loadSurfaces(): {
	root: Map<string, ExportContractEntry>;
	leaves: Map<string, Map<string, ExportContractEntry>>;
} {
	const configPath = ts.findConfigFile(dirname(rootPath), ts.sys.fileExists, "tsconfig.json");
	if (!configPath) throw new Error("Expected repository tsconfig.json");
	const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
	const parsed = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		dirname(configPath),
		{ noEmit: true },
		configPath,
	);
	const leafPaths = leafFileNames.map((fileName) => join(lspSourceDirectory, fileName));
	const program = ts.createProgram({ rootNames: [rootPath, ...leafPaths], options: parsed.options });
	const diagnostics = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].filter(
		(diagnostic) =>
			!diagnostic.file ||
			diagnostic.file.fileName === rootPath ||
			diagnostic.file.fileName.startsWith(`${lspSourceDirectory}${sep}`),
	);
	if (diagnostics.length > 0) {
		throw new Error(
			ts.formatDiagnostics(diagnostics, {
				getCanonicalFileName: (fileName) => fileName,
				getCurrentDirectory: () => process.cwd(),
				getNewLine: () => "\n",
			}),
		);
	}
	const checker = program.getTypeChecker();
	const rootSource = program.getSourceFile(rootPath);
	if (!rootSource) throw new Error(`Expected source file for ${rootPath}`);
	return {
		root: resolveExports(checker, rootSource),
		leaves: new Map(
			leafFileNames.map((fileName) => {
				const source = program.getSourceFile(join(lspSourceDirectory, fileName));
				if (!source) throw new Error(`Expected LSP leaf ${fileName}`);
				return [fileName, resolveExports(checker, source)];
			}),
		),
	};
}

const surfaces = loadSurfaces();
const publicLeafExports = [...surfaces.leaves].flatMap(([fileName, exports]) =>
	[...exports]
		.filter(([name]) => !intentionallyInternalLeafExports.has(`${fileName}:${name}`))
		.map(([name, entry]) => ({ fileName, name, entry })),
);

describe("public LSP exports", () => {
	it("exports every public LSP leaf declaration directly from the package root", () => {
		for (const { fileName, name, entry } of publicLeafExports) {
			const actual = surfaces.root.get(name);
			expect(actual, `root is missing ${fileName}:${name}`).toBeDefined();
			expect(actual?.target, `root.${name} declaration identity`).toBe(entry.target);
			expect(actual?.type, `root.${name} type export`).toBe(entry.type);
		}
	});

	it("keeps intentionally internal LSP declarations private", () => {
		for (const internalExport of intentionallyInternalLeafExports) {
			const [fileName, name] = internalExport.split(":");
			expect(surfaces.leaves.get(fileName)?.has(name), `${internalExport} still exists`).toBe(true);
			expect(surfaces.root.has(name), `${internalExport} remains internal`).toBe(false);
		}
	});

	it("preserves every public LSP runtime value by identity", () => {
		const runtimeNames = publicLeafExports
			.filter(({ entry }) => entry.value)
			.map(({ name }) => name)
			.sort();
		expect(
			Object.keys(lspRuntimeValues)
				.filter((name) => runtimeNames.includes(name))
				.sort(),
		).toEqual(runtimeNames);
		for (const name of runtimeNames) {
			expect(Object.hasOwn(RootValues, name), `root owns ${name}`).toBe(true);
			expect(Reflect.get(RootValues, name), `root.${name}`).toBe(Reflect.get(lspRuntimeValues, name));
		}
	});
});
