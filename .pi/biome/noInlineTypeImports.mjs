import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const RULE_NAME = "noInlineTypeImports";
const SOURCE_DIRECTORY_NAMES = new Set(["src", "test"]);
const EXCLUDED_DIRECTORY_NAMES = new Set([".git", ".worktrees", "dist", "node_modules"]);

function position(sourceFile, offset) {
	const value = sourceFile.getLineAndCharacterOfPosition(offset);
	return { line: value.line + 1, column: value.character + 1 };
}

function createDiagnostic(sourceFile, path, node) {
	const start = node.getStart(sourceFile);
	const moduleName =
		ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)
			? node.argument.literal.text
			: "unknown module";
	return {
		category: "plugin",
		severity: "error",
		message: `[${RULE_NAME}] Inline type import from ${JSON.stringify(moduleName)} hides type ownership and dependency structure. Add a top-level type import and reference an owner-exported named type directly.`,
		location: {
			path,
			span: [start, node.end],
			start: position(sourceFile, start),
			end: position(sourceFile, node.end),
		},
	};
}

export function analyzeInlineTypeImportSource(path, sourceText) {
	const scriptKind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
	const diagnostics = [];
	function visit(node) {
		if (ts.isImportTypeNode(node)) diagnostics.push(createDiagnostic(sourceFile, path, node));
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return diagnostics;
}

function shouldAnalyze(path) {
	const normalized = path.split(sep).join("/");
	if (!/\.(?:ts|tsx)$/.test(normalized)) return false;
	if (normalized.endsWith("/models.generated.ts") || normalized.endsWith("/test-sessions.ts")) return false;
	if (normalized.includes("/packages/mom/data/")) return false;
	const parts = normalized.split("/");
	const packagesIndex = parts.lastIndexOf("packages");
	if (packagesIndex === -1) return false;
	const relativeParts = parts.slice(packagesIndex + 2);
	return SOURCE_DIRECTORY_NAMES.has(relativeParts[0]) || relativeParts[0] === "examples";
}

async function collectTypeScriptPaths(directory) {
	const paths = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.isDirectory() && EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) paths.push(...(await collectTypeScriptPaths(path)));
		else if (entry.isFile() && shouldAnalyze(path)) paths.push(path);
	}
	return paths;
}

export async function analyzeRepository(repositoryRoot) {
	const root = resolve(repositoryRoot);
	const paths = await collectTypeScriptPaths(resolve(root, "packages"));
	const diagnostics = (
		await Promise.all(
			paths.sort().map(async (path) => {
				const relativePath = relative(root, path).split(sep).join("/");
				return analyzeInlineTypeImportSource(relativePath, await readFile(path, "utf8"));
			}),
		)
	).flat();
	return diagnostics.sort(
		(left, right) =>
			left.location.path.localeCompare(right.location.path) ||
			left.location.start.line - right.location.start.line ||
			left.location.start.column - right.location.start.column,
	);
}

async function main() {
	const diagnostics = await analyzeRepository(process.cwd());
	process.stdout.write(`${JSON.stringify({ diagnostics }, null, 2)}\n`);
	if (diagnostics.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
