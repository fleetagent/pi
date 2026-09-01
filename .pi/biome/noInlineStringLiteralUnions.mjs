import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const RULE_NAME = "noInlineStringLiteralUnions";
const SOURCE_DIRECTORY_NAMES = new Set(["src", "test"]);
const EXCLUDED_DIRECTORY_NAMES = new Set([".git", ".worktrees", "dist", "node_modules"]);

function position(sourceFile, offset) {
	const value = sourceFile.getLineAndCharacterOfPosition(offset);
	return { line: value.line + 1, column: value.character + 1 };
}

function createDiagnostic(sourceFile, path, unionNode, owner) {
	const start = unionNode.getStart(sourceFile);
	return {
		category: "plugin",
		severity: "error",
		message: `[${RULE_NAME}] ${owner} contains an inline string-literal union. Extract it to a stable, domain-oriented named type alias such as type WorkspaceAvailability = "remote" | "unavailable"; do not use an enum.`,
		location: {
			path,
			span: [start, unionNode.end],
			start: position(sourceFile, start),
			end: position(sourceFile, unionNode.end),
		},
	};
}

function isStringLiteralUnion(node) {
	return (
		ts.isUnionTypeNode(node) &&
		new Set(
			node.types
				.filter((member) => ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal))
				.map((member) => member.literal.text),
		).size >= 2
	);
}

function isPropertyKeyUnion(node, typeNode) {
	let child = node;
	for (let parent = node.parent; parent && child !== typeNode; parent = parent.parent) {
		if (ts.isIndexedAccessTypeNode(parent) && parent.indexType === child) return true;
		if (ts.isMappedTypeNode(parent) && parent.typeParameter.constraint === child) return true;
		if (ts.isTypeReferenceNode(parent) && ts.isIdentifier(parent.typeName)) {
			const argumentIndex = parent.typeArguments?.indexOf(child) ?? -1;
			if ((parent.typeName.text === "Omit" || parent.typeName.text === "Pick") && argumentIndex === 1) return true;
			if (parent.typeName.text === "Record" && argumentIndex === 0) return true;
		}
		child = parent;
	}
	return false;
}

function collectStringLiteralUnions(typeNode) {
	const unions = [];
	function visit(node) {
		if (isStringLiteralUnion(node) && !isPropertyKeyUnion(node, typeNode)) unions.push(node);
		ts.forEachChild(node, visit);
	}
	visit(typeNode);
	return unions;
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

function declarationName(node, fallback) {
	if (node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) return node.name.text;
	return fallback;
}

function relevantTypeAnnotations(node) {
	if (ts.isPropertyDeclaration(node) || (ts.isPropertySignature(node) && ts.isInterfaceDeclaration(node.parent))) {
		return node.type ? [{ typeNode: node.type, owner: `Property ${declarationName(node, "signature")}` }] : [];
	}
	if (!isFunctionSignature(node)) return [];
	const annotations = node.parameters.flatMap((parameter) =>
		parameter.type
			? [
					{
						typeNode: parameter.type,
						owner: `Parameter ${declarationName(parameter, "signature")} of ${declarationName(node, "function signature")}`,
					},
				]
			: [],
	);
	if (node.type) annotations.push({ typeNode: node.type, owner: `Return type of ${declarationName(node, "function signature")}` });
	return annotations;
}

export function analyzeStringLiteralUnionSource(path, sourceText) {
	const scriptKind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
	const diagnosticsBySpan = new Map();
	function visit(node) {
		for (const { typeNode, owner } of relevantTypeAnnotations(node)) {
			for (const unionNode of collectStringLiteralUnions(typeNode)) {
				const key = `${unionNode.getStart(sourceFile)}:${unionNode.end}`;
				if (!diagnosticsBySpan.has(key)) {
					diagnosticsBySpan.set(key, createDiagnostic(sourceFile, path, unionNode, owner));
				}
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return [...diagnosticsBySpan.values()].sort(
		(left, right) =>
			left.location.start.line - right.location.start.line || left.location.start.column - right.location.start.column,
	);
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
				return analyzeStringLiteralUnionSource(relativePath, await readFile(path, "utf8"));
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
