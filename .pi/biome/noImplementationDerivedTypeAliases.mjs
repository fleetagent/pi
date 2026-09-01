import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const RULE_NAME = "noImplementationDerivedTypeAliases";
const DERIVATION_UTILITY_NAMES = new Set(["Parameters", "ReturnType"]);
const SOURCE_DIRECTORY_NAMES = new Set(["src", "test"]);
const EXCLUDED_DIRECTORY_NAMES = new Set([".git", ".worktrees", "dist", "node_modules"]);

function collectDerivationKinds(typeNode) {
	const kinds = new Set();
	function visit(node) {
		if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && DERIVATION_UTILITY_NAMES.has(node.typeName.text)) {
			kinds.add(node.typeName.text);
		}
		if (
			ts.isIndexedAccessTypeNode(node) &&
			ts.isLiteralTypeNode(node.indexType) &&
			ts.isStringLiteral(node.indexType.literal)
		) {
			kinds.add("indexed member access");
		}
		ts.forEachChild(node, visit);
	}
	visit(typeNode);
	return [...kinds].sort();
}

function position(sourceFile, offset) {
	const value = sourceFile.getLineAndCharacterOfPosition(offset);
	return { line: value.line + 1, column: value.character + 1 };
}

function createDiagnostic(sourceFile, path, start, end, message) {
	return {
		category: "plugin",
		severity: "error",
		message: `[${RULE_NAME}] ${message}`,
		location: {
			path,
			span: [start, end],
			start: position(sourceFile, start),
			end: position(sourceFile, end),
		},
	};
}

function diagnosticForAlias(node, sourceFile, path, derivationKinds) {
	const start = node.name.getStart(sourceFile);
	return createDiagnostic(
		sourceFile,
		path,
		start,
		node.name.end,
		`${node.name.text} derives a named contract through ${derivationKinds.join(", ")}. Export a stable domain type from the API owner and import it directly instead.`,
	);
}

function isFunctionSignature(node) {
	return (
		ts.isFunctionLike(node) ||
		ts.isFunctionTypeNode(node) ||
		ts.isCallSignatureDeclaration(node) ||
		ts.isMethodSignature(node) ||
		ts.isConstructSignatureDeclaration(node)
	);
}

function signatureTypeNodes(node) {
	const nodes = node.parameters.flatMap((parameter) => (parameter.type ? [parameter.type] : []));
	if (node.type) nodes.push(node.type);
	return nodes;
}

function signatureName(node) {
	if (node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) return node.name.text;
	return "Function signature";
}

function diagnosticForSignature(node, typeNode, sourceFile, path, derivationKinds) {
	const start = typeNode.getStart(sourceFile);
	return createDiagnostic(
		sourceFile,
		path,
		start,
		typeNode.end,
		`${signatureName(node)} derives a function signature contract through ${derivationKinds.join(", ")}. Use a stable named type from the API owner instead.`,
	);
}

export function analyzeTypeAliasSource(path, sourceText) {
	const scriptKind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
	const diagnostics = [];
	function visit(node) {
		if (ts.isTypeAliasDeclaration(node)) {
			const derivationKinds = collectDerivationKinds(node.type);
			if (derivationKinds.length > 0) {
				diagnostics.push(diagnosticForAlias(node, sourceFile, path, derivationKinds));
			}
			return;
		}
		if (isFunctionSignature(node)) {
			for (const typeNode of signatureTypeNodes(node)) {
				const derivationKinds = collectDerivationKinds(typeNode);
				if (derivationKinds.length > 0) {
					diagnostics.push(diagnosticForSignature(node, typeNode, sourceFile, path, derivationKinds));
				}
			}
		}
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
				return analyzeTypeAliasSource(relativePath, await readFile(path, "utf8"));
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
