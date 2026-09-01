import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const RULE_NAME = "noNearIdenticalDataStructures";
const IGNORE_DIRECTIVE_PATTERN =
	/(?:\/\/\s*pi-ignore\s+noNearIdenticalDataStructures\s*:\s*([^\r\n]*)|\/\*\s*pi-ignore\s+noNearIdenticalDataStructures\s*:\s*([\s\S]*?)\*\/)\s*$/;
const SOURCE_DIRECTORY_NAMES = new Set(["src", "test"]);
const EXCLUDED_DIRECTORY_NAMES = new Set([".git", ".worktrees", "dist", "node_modules"]);

function stripWhitespaceOutsideStrings(input) {
	let result = "";
	let quote = null;
	let escaped = false;
	for (const character of input) {
		if (quote !== null) {
			result += character;
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === quote) quote = null;
			continue;
		}
		if (character === "'" || character === '"' || character === "`") {
			quote = character;
			result += character;
		} else if (!/\s/.test(character)) {
			result += character;
		}
	}
	return result;
}

function splitTopLevelUnion(input) {
	const parts = [];
	let start = 0;
	let parentheses = 0;
	let squareBrackets = 0;
	let braces = 0;
	let angleBrackets = 0;
	let quote = null;
	let escaped = false;
	for (let index = 0; index <= input.length; index++) {
		const character = input[index];
		if (index === input.length) {
			parts.push(input.slice(start));
			break;
		}
		if (quote !== null) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === quote) quote = null;
			continue;
		}
		if (character === "'" || character === '"' || character === "`") {
			quote = character;
			continue;
		}
		if (character === "(") parentheses++;
		else if (character === ")") parentheses--;
		else if (character === "[") squareBrackets++;
		else if (character === "]") squareBrackets--;
		else if (character === "{") braces++;
		else if (character === "}") braces--;
		else if (character === "<") angleBrackets++;
		else if (character === ">" && angleBrackets > 0) angleBrackets--;
		else if (character === "|" && parentheses === 0 && squareBrackets === 0 && braces === 0 && angleBrackets === 0) {
			parts.push(input.slice(start, index));
			start = index + 1;
		}
	}
	return parts;
}

function findTopLevelColon(input) {
	let parentheses = 0;
	let squareBrackets = 0;
	let braces = 0;
	let angleBrackets = 0;
	let quote = null;
	let escaped = false;
	for (let index = 0; index < input.length; index++) {
		const character = input[index];
		if (quote !== null) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === quote) quote = null;
			continue;
		}
		if (character === "'" || character === '"' || character === "`") {
			quote = character;
			continue;
		}
		if (character === "(") parentheses++;
		else if (character === ")") parentheses--;
		else if (character === "[") squareBrackets++;
		else if (character === "]") squareBrackets--;
		else if (character === "{") braces++;
		else if (character === "}") braces--;
		else if (character === "<") angleBrackets++;
		else if (character === ">" && angleBrackets > 0) angleBrackets--;
		else if (character === ":" && parentheses === 0 && squareBrackets === 0 && braces === 0 && angleBrackets === 0) {
			return index;
		}
	}
	return -1;
}

export function normalizeInterfaceMember(sourceText) {
	const source = sourceText
		.trim()
		.replace(/[;,]\s*$/, "")
		.replace(/^readonly\s+/, "");
	const colon = findTopLevelColon(source);
	if (colon === -1) return stripWhitespaceOutsideStrings(source);
	const name = source
		.slice(0, colon)
		.trim()
		.replace(/\?\s*$/, "");
	const originalParts = splitTopLevelUnion(source.slice(colon + 1).trim());
	let parts = originalParts
		.map((part) => stripWhitespaceOutsideStrings(part.trim()))
		.filter(Boolean)
		.filter((part) => part !== "null" && part !== "undefined");
	if (parts.length === 0) {
		parts = originalParts.map((part) => stripWhitespaceOutsideStrings(part.trim())).filter(Boolean);
	}
	return `${stripWhitespaceOutsideStrings(name)}:${[...new Set(parts)].sort().join("|")}`;
}

function hasIgnoreDirective(node, sourceFile) {
	const directive = IGNORE_DIRECTIVE_PATTERN.exec(
		sourceFile.text.slice(node.getFullStart(), node.getStart(sourceFile)),
	);
	return Boolean((directive?.[1] ?? directive?.[2] ?? "").trim());
}

function interfaceRecord(node, sourceFile, path) {
	if (node.members.length < 2 || hasIgnoreDirective(node, sourceFile)) return undefined;
	const members = node.members.map((member) => normalizeInterfaceMember(member.getText(sourceFile))).sort();
	const typeParameters =
		node.typeParameters?.map((parameter) => stripWhitespaceOutsideStrings(parameter.getText(sourceFile))) ?? [];
	const heritage =
		node.heritageClauses?.map((clause) => stripWhitespaceOutsideStrings(clause.getText(sourceFile))).sort() ?? [];
	return {
		name: node.name.text,
		path,
		signature: `${typeParameters.join(",")}\u001e${heritage.join(",")}\u001e${members.join("\u001f")}`,
		start: node.getStart(sourceFile),
		end: node.name.end,
		sourceFile,
	};
}

function collectInterfaceRecords(path, sourceText) {
	const scriptKind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
	const records = [];
	function visit(node) {
		if (ts.isInterfaceDeclaration(node)) {
			const record = interfaceRecord(node, sourceFile, path);
			if (record) records.push(record);
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return records;
}

function position(sourceFile, offset) {
	const value = sourceFile.getLineAndCharacterOfPosition(offset);
	return { line: value.line + 1, column: value.character + 1 };
}

function diagnosticForRecord(record, matches) {
	const candidates = matches
		.filter((candidate) => candidate !== record)
		.map((candidate) => `${candidate.name} @ ${candidate.path}`)
		.sort();
	const displayedCandidates = candidates.slice(0, 5);
	const omittedCount = candidates.length - displayedCandidates.length;
	const candidateText = `${displayedCandidates.join(", ")}${omittedCount > 0 ? `, and ${omittedCount} more` : ""}`;
	return {
		category: "plugin",
		severity: "error",
		message: `[${RULE_NAME}] ${record.name} has the same normalized member structure as ${candidateText}. Reuse or merge the owning contract when semantics match; otherwise add a reasoned pi-ignore directive.`,
		location: {
			path: record.path,
			span: [record.start, record.end],
			start: position(record.sourceFile, record.start),
			end: position(record.sourceFile, record.end),
		},
	};
}

export function analyzeInterfaceSources(sources) {
	const records = sources.flatMap(({ path, sourceText }) => collectInterfaceRecords(path, sourceText));
	const groups = new Map();
	for (const record of records) {
		const group = groups.get(record.signature);
		if (group) group.push(record);
		else groups.set(record.signature, [record]);
	}
	return [...groups.values()]
		.filter((group) => group.length > 1)
		.flatMap((group) => group.map((record) => diagnosticForRecord(record, group)))
		.sort(
			(left, right) =>
				left.location.path.localeCompare(right.location.path) ||
				left.location.start.line - right.location.start.line ||
				left.location.start.column - right.location.start.column,
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
	const sources = await Promise.all(
		paths.sort().map(async (path) => ({
			path: relative(root, path).split(sep).join("/"),
			sourceText: await readFile(path, "utf8"),
		})),
	);
	return analyzeInterfaceSources(sources);
}

async function main() {
	const diagnostics = await analyzeRepository(process.cwd());
	process.stdout.write(`${JSON.stringify({ diagnostics }, null, 2)}\n`);
	if (diagnostics.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
