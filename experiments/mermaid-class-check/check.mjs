#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const VISIBILITY_BY_SYMBOL = new Map([
	["+", "public"],
	["-", "private"],
	["#", "protected"],
	["~", "package"],
]);

const TYPE_ALIASES = new Map([
	["String", "string"],
	["Boolean", "boolean"],
	["Number", "number"],
	["Integer", "number"],
	["int", "number"],
	["float", "number"],
	["double", "number"],
	["Void", "void"],
]);

const EXCLUDED_SOURCE_DIRECTORY_NAMES = new Set([".git", ".worktrees", "dist", "node_modules"]);
const TYPESCRIPT_SOURCE_EXTENSION = /\.(?:cts|mts|ts|tsx)$/;

function normalizeType(type) {
	if (type === null) return null;
	let normalized = type.trim().replace(/([A-Za-z_$][\w$]*)~([^~]+)~/g, "$1<$2>");
	for (const [diagramType, typescriptType] of TYPE_ALIASES) {
		normalized = normalized.replace(new RegExp(`\\b${diagramType}\\b`, "g"), typescriptType);
	}
	normalized = normalized.replace(/\b(?:Array|List)<([^<>]+)>/g, "$1[]");
	return normalized.replace(/\s+/g, "");
}

function splitParameters(value) {
	const parameters = [];
	let start = 0;
	let depth = 0;
	let mermaidGenericOpen = false;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (character === "~") {
			depth += mermaidGenericOpen ? -1 : 1;
			mermaidGenericOpen = !mermaidGenericOpen;
		} else if (character === "<" || character === "(" || character === "[") depth += 1;
		else if (character === ">" || character === ")" || character === "]") depth -= 1;
		else if (character === "," && depth === 0) {
			parameters.push(value.slice(start, index).trim());
			start = index + 1;
		}
	}
	const finalParameter = value.slice(start).trim();
	if (finalParameter) parameters.push(finalParameter);
	return parameters;
}

function parseParameterType(parameter) {
	const colonIndex = parameter.indexOf(":");
	if (colonIndex !== -1) return normalizeType(parameter.slice(colonIndex + 1));
	const parts = parameter.trim().split(/\s+/);
	return normalizeType(parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0]);
}

function parseMember(line, lineNumber) {
	const visibility = VISIBILITY_BY_SYMBOL.get(line[0]);
	if (!visibility) throw new SyntaxError(`Line ${lineNumber}: class member must begin with +, -, #, or ~`);

	let declaration = line.slice(1).trim();
	let isStatic = false;
	let isAsync = false;
	if (declaration.startsWith("async ")) {
		isAsync = true;
		declaration = declaration.slice("async ".length).trim();
	}
	if (declaration.endsWith("$")) {
		isStatic = true;
		declaration = declaration.slice(0, -1).trim();
	}

	const openParenthesis = declaration.indexOf("(");
	if (openParenthesis !== -1) {
		const closeParenthesis = declaration.lastIndexOf(")");
		if (closeParenthesis < openParenthesis) throw new SyntaxError(`Line ${lineNumber}: method is missing ')'`);
		const prefix = declaration.slice(0, openParenthesis).trim();
		const suffix = declaration
			.slice(closeParenthesis + 1)
			.trim()
			.replace(/^:\s*/, "");
		const prefixParts = prefix.split(/\s+/);
		const name = prefixParts.at(-1);
		const prefixReturnType = prefixParts.length > 1 ? prefixParts.slice(0, -1).join(" ") : null;
		return {
			kind: "method",
			name,
			visibility,
			isStatic,
			isAsync,
			parameters: splitParameters(declaration.slice(openParenthesis + 1, closeParenthesis)).map(parseParameterType),
			type: normalizeType(suffix || prefixReturnType),
			line: lineNumber,
		};
	}

	if (isAsync) throw new SyntaxError(`Line ${lineNumber}: only methods and functions can be async`);
	const colonIndex = declaration.indexOf(":");
	if (colonIndex !== -1) {
		return {
			kind: "property",
			name: declaration.slice(0, colonIndex).trim().replace(/\?$/, ""),
			visibility,
			isStatic,
			isAsync: false,
			parameters: [],
			type: normalizeType(declaration.slice(colonIndex + 1)),
			line: lineNumber,
		};
	}

	const parts = declaration.split(/\s+/);
	if (parts.length < 2) throw new SyntaxError(`Line ${lineNumber}: property must include a name and type`);
	return {
		kind: "property",
		name: parts.at(-1).replace(/\?$/, ""),
		visibility,
		isStatic,
		isAsync: false,
		parameters: [],
		type: normalizeType(parts.slice(0, -1).join(" ")),
		line: lineNumber,
	};
}

function parseRelation(line, lineNumber) {
	const match = line.match(
		/^(\w+)\s*(?:"([^"]+)")?\s*(<\|\.\.|\.\.\|>|<\|--|--\|>|-->|\*--|o--|--\*|--o|--)\s*(?:"([^"]+)")?\s*(\w+)(?:\s*:\s*(.+))?$/,
	);
	if (!match) return null;
	return {
		left: match[1],
		leftMultiplicity: match[2] ?? null,
		operator: match[3],
		rightMultiplicity: match[4] ?? null,
		right: match[5],
		label: match[6] ?? null,
		line: lineNumber,
	};
}

function createDiagramNode(name, line) {
	return {
		name,
		members: [],
		line,
		kind: "class",
		isFunction: false,
		isExported: false,
		isDefaultExport: false,
		isAsync: false,
		isImport: false,
		importSource: null,
	};
}

function applyStereotype(node, stereotype, lineNumber) {
	if (stereotype === "interface") {
		node.kind = "interface";
		return;
	}
	if (stereotype === "class") {
		throw new SyntaxError(
			`Line ${lineNumber}: Mermaid reserves 'class'; omit the stereotype because nodes default to classes`,
		);
	}
	if (stereotype === "function") {
		node.isFunction = true;
		return;
	}
	if (stereotype === "export") {
		node.isExported = true;
		return;
	}
	if (stereotype === "async") {
		node.isAsync = true;
		return;
	}
	if (stereotype === "import") {
		node.isImport = true;
		return;
	}
	if (stereotype.startsWith("import ")) {
		throw new SyntaxError(
			`Line ${lineNumber}: import sources are not valid Mermaid stereotypes; use '<<import>> ${node.name}' and '%% pi:import ${node.name} from "module"'`,
		);
	}
	throw new SyntaxError(`Line ${lineNumber}: unsupported stereotype '${stereotype}'`);
}

function applyMetadataDirective(line, classes, lineNumber) {
	const importMatch = line.match(/^%%\s*pi:import\s+(\w+)\s+from\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/);
	const defaultExportMatch = line.match(/^%%\s*pi:default-export\s+(\w+)\s*$/);
	if (!importMatch && !defaultExportMatch) return false;
	const name = importMatch?.[1] ?? defaultExportMatch?.[1];
	const target = classes.get(name);
	if (!target) throw new SyntaxError(`Line ${lineNumber}: metadata target '${name}' is not declared`);
	if (importMatch) {
		target.isImport = true;
		target.importSource = importMatch[2] ?? importMatch[3] ?? importMatch[4];
	} else {
		target.isExported = true;
		target.isDefaultExport = true;
	}
	return true;
}

export function parseMermaidClassDiagram(source) {
	const classes = new Map();
	const relations = [];
	let currentClass = null;
	let sawHeader = false;
	const lines = source.split(/\r?\n/);

	for (let index = 0; index < lines.length; index += 1) {
		const lineNumber = index + 1;
		const rawLine = lines[index].trim();
		if (rawLine.startsWith("%%")) {
			if (sawHeader) applyMetadataDirective(rawLine, classes, lineNumber);
			continue;
		}
		const line = rawLine;
		if (!line) continue;
		if (!sawHeader) {
			if (line !== "classDiagram") throw new SyntaxError(`Line ${lineNumber}: expected 'classDiagram'`);
			sawHeader = true;
			continue;
		}
		if (currentClass) {
			if (line === "}") {
				currentClass = null;
				continue;
			}
			const stereotypeMatch = line.match(/^<<(.+)>>$/);
			if (stereotypeMatch) applyStereotype(currentClass, stereotypeMatch[1].trim(), lineNumber);
			else currentClass.members.push(parseMember(line, lineNumber));
			continue;
		}
		const classMatch = line.match(/^class\s+(\w+)(?:\s*\{)?$/);
		if (classMatch) {
			const name = classMatch[1];
			if (classes.has(name)) throw new SyntaxError(`Line ${lineNumber}: duplicate diagram node '${name}'`);
			const diagramClass = createDiagramNode(name, lineNumber);
			classes.set(name, diagramClass);
			if (line.endsWith("{")) currentClass = diagramClass;
			continue;
		}
		const stereotypeMatch = line.match(/^<<(.+)>>\s+(\w+)$/);
		if (stereotypeMatch) {
			const target = classes.get(stereotypeMatch[2]);
			if (!target)
				throw new SyntaxError(`Line ${lineNumber}: stereotype target '${stereotypeMatch[2]}' is not declared`);
			applyStereotype(target, stereotypeMatch[1].trim(), lineNumber);
			continue;
		}
		const relation = parseRelation(line, lineNumber);
		if (relation) {
			relations.push(relation);
			continue;
		}
		throw new SyntaxError(`Line ${lineNumber}: unsupported class diagram syntax: ${line}`);
	}
	if (!sawHeader) throw new SyntaxError("Diagram is empty");
	if (currentClass) throw new SyntaxError(`Diagram node '${currentClass.name}' is missing '}'`);
	return { classes, relations };
}

function declarationFlags(node) {
	return ts.getCombinedModifierFlags(node);
}

function memberVisibility(member) {
	const flags = declarationFlags(member);
	if (flags & ts.ModifierFlags.Private) return "private";
	if (flags & ts.ModifierFlags.Protected) return "protected";
	return "public";
}

function memberName(member, sourceFile) {
	if (!member.name) return null;
	if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) return member.name.text;
	return member.name.getText(sourceFile);
}

function extractMembers(node, sourceFile) {
	const members = [];
	for (const member of node.members) {
		if (
			!ts.isPropertyDeclaration(member) &&
			!ts.isMethodDeclaration(member) &&
			!ts.isPropertySignature(member) &&
			!ts.isMethodSignature(member)
		)
			continue;
		const name = memberName(member, sourceFile);
		if (!name) continue;
		const isMethod = ts.isMethodDeclaration(member) || ts.isMethodSignature(member);
		members.push({
			kind: isMethod ? "method" : "property",
			name,
			visibility: memberVisibility(member),
			isStatic: Boolean(declarationFlags(member) & ts.ModifierFlags.Static),
			isAsync: Boolean(declarationFlags(member) & ts.ModifierFlags.Async),
			parameters: isMethod
				? member.parameters.map((parameter) => normalizeType(parameter.type?.getText(sourceFile) ?? null))
				: [],
			type: normalizeType(member.type?.getText(sourceFile) ?? null),
		});
	}
	return members;
}

function extractHeritage(node, sourceFile) {
	const extendsNames = new Set();
	const implementsNames = new Set();
	for (const clause of node.heritageClauses ?? []) {
		const names = clause.token === ts.SyntaxKind.ImplementsKeyword ? implementsNames : extendsNames;
		for (const type of clause.types) names.add(type.expression.getText(sourceFile));
	}
	return { extendsNames, implementsNames };
}

function extractClassDeclaration(node, sourceFile) {
	if (!node.name) return null;
	return {
		name: node.name.text,
		kind: ts.isInterfaceDeclaration(node) ? "interface" : "class",
		members: extractMembers(node, sourceFile),
		...extractHeritage(node, sourceFile),
	};
}

function extractFunctionDeclaration(node, sourceFile) {
	if (!node.name) return null;
	return {
		name: node.name.text,
		parameters: node.parameters.map((parameter) => normalizeType(parameter.type?.getText(sourceFile) ?? null)),
		type: normalizeType(node.type?.getText(sourceFile) ?? null),
		isAsync: Boolean(declarationFlags(node) & ts.ModifierFlags.Async),
	};
}

function addImport(imports, name, source, isTypeOnly) {
	const existing = imports.get(name) ?? [];
	existing.push({ source, isTypeOnly });
	imports.set(name, existing);
}

function extractImports(statement, imports) {
	if (!statement.importClause || !ts.isStringLiteral(statement.moduleSpecifier)) return;
	const source = statement.moduleSpecifier.text;
	const clause = statement.importClause;
	if (clause.name) addImport(imports, clause.name.text, source, clause.isTypeOnly);
	if (!clause.namedBindings) return;
	if (ts.isNamespaceImport(clause.namedBindings)) {
		addImport(imports, clause.namedBindings.name.text, source, clause.isTypeOnly);
		return;
	}
	for (const element of clause.namedBindings.elements) {
		addImport(imports, element.name.text, source, clause.isTypeOnly || element.isTypeOnly);
	}
}

function extractExportNames(statement, exports, defaultExports) {
	if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) return;
	for (const element of statement.exportClause.elements) {
		const localName = element.propertyName?.text ?? element.name.text;
		if (element.name.text === "default") defaultExports.add(localName);
		else exports.add(localName);
	}
}

function recordDeclarationExport(node, name, exports, defaultExports) {
	const flags = declarationFlags(node);
	if (flags & ts.ModifierFlags.Export) exports.add(name);
	if (flags & ts.ModifierFlags.Default) defaultExports.add(name);
}

export function analyzeTypeScriptSources(sources) {
	const declarations = new Map();
	const functions = new Map();
	const imports = new Map();
	const exports = new Set();
	const defaultExports = new Set();
	for (const source of sources) {
		const scriptKind = source.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
		const sourceFile = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true, scriptKind);
		for (const statement of sourceFile.statements) {
			if (ts.isImportDeclaration(statement)) extractImports(statement, imports);
			else if (ts.isExportDeclaration(statement)) extractExportNames(statement, exports, defaultExports);
			else if (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
				const declaration = extractClassDeclaration(statement, sourceFile);
				if (declaration) {
					declarations.set(declaration.name, declaration);
					recordDeclarationExport(statement, declaration.name, exports, defaultExports);
				}
			} else if (ts.isFunctionDeclaration(statement)) {
				const declaration = extractFunctionDeclaration(statement, sourceFile);
				if (declaration) {
					const overloads = functions.get(declaration.name) ?? [];
					overloads.push(declaration);
					functions.set(declaration.name, overloads);
					recordDeclarationExport(statement, declaration.name, exports, defaultExports);
				}
			}
		}
	}
	return { declarations, functions, imports, exports, defaultExports };
}

function formatMember(member) {
	const staticMarker = member.isStatic ? "static " : "";
	const asyncMarker = member.isAsync ? "async " : "";
	if (member.kind === "property") return `${member.visibility} ${staticMarker}${member.name}: ${member.type}`;
	return `${member.visibility} ${staticMarker}${asyncMarker}${member.name}(${member.parameters.join(", ")}): ${member.type ?? "unspecified"}`;
}

function signaturesMatch(expected, actual) {
	if (expected.type !== null && expected.type !== actual.type) return false;
	if (expected.isAsync !== actual.isAsync) return false;
	return (
		expected.parameters.length === actual.parameters.length &&
		expected.parameters.every((type, index) => type === actual.parameters[index])
	);
}

function memberMatches(expected, actual) {
	if (expected.kind !== actual.kind || expected.name !== actual.name) return false;
	if (expected.visibility !== actual.visibility || expected.isStatic !== actual.isStatic) return false;
	return signaturesMatch(expected, actual);
}

function relationIsMany(multiplicity) {
	return multiplicity?.includes("*") ?? false;
}

function typeReferences(type, target, requireMany) {
	if (!type) return false;
	const normalized = normalizeType(type);
	if (requireMany) {
		if (normalized.endsWith("[]")) return typeReferences(normalized.slice(0, -2), target, false);
		for (const collectionType of ["ReadonlyArray", "Set"]) {
			const prefix = `${collectionType}<`;
			if (normalized.startsWith(prefix) && normalized.endsWith(">")) {
				return typeReferences(normalized.slice(prefix.length, -1), target, false);
			}
		}
		return false;
	}
	return new RegExp(`(?:^|[^A-Za-z0-9_$])${target}(?:$|[^A-Za-z0-9_$])`).test(normalized);
}

function classReferences(targetClass, targetName, requireMany) {
	return targetClass.members.some(
		(member) =>
			typeReferences(member.type, targetName, requireMany) ||
			member.parameters.some((type) => typeReferences(type, targetName, requireMany)),
	);
}

function diagnostic(line, message) {
	return { line, message };
}

function checkImport(expected, implementations, diagnostics) {
	const candidates = implementations.imports.get(expected.name) ?? [];
	const matches = candidates.some(
		(candidate) => expected.importSource === null || candidate.source === expected.importSource,
	);
	if (!matches) {
		const source = expected.importSource === null ? "" : ` from '${expected.importSource}'`;
		diagnostics.push(diagnostic(expected.line, `Missing import '${expected.name}'${source}.`));
	}
}

function checkExport(expected, implementations, diagnostics) {
	if (!expected.isExported) return;
	const exportSet = expected.isDefaultExport ? implementations.defaultExports : implementations.exports;
	if (!exportSet.has(expected.name)) {
		const kind = expected.isDefaultExport ? "default export" : "export";
		diagnostics.push(diagnostic(expected.line, `Missing ${kind} for '${expected.name}'.`));
	}
}

function checkFunction(expected, implementations, diagnostics) {
	const signature = expected.members.find((member) => member.kind === "method" && member.name === expected.name);
	if (!signature) {
		diagnostics.push(
			diagnostic(expected.line, `Function node '${expected.name}' must contain a method with the same name.`),
		);
		return;
	}
	const expectedSignature = { ...signature, isAsync: expected.isAsync || signature.isAsync };
	const candidates = implementations.functions.get(expected.name) ?? [];
	if (candidates.length === 0) {
		const asyncMarker = expectedSignature.isAsync ? "async " : "";
		diagnostics.push(diagnostic(expected.line, `Missing ${asyncMarker}function '${expected.name}'.`));
		return;
	}
	if (!candidates.some((candidate) => signaturesMatch(expectedSignature, candidate))) {
		const asyncMarker = expectedSignature.isAsync ? "async " : "";
		diagnostics.push(
			diagnostic(
				signature.line,
				`Expected ${asyncMarker}function ${expected.name}(${expectedSignature.parameters.join(", ")}): ${expectedSignature.type ?? "unspecified"}.`,
			),
		);
	}
}

function checkDeclaration(expected, implementations, diagnostics) {
	const actual = implementations.declarations.get(expected.name);
	if (!actual) {
		diagnostics.push(diagnostic(expected.line, `Missing ${expected.kind} '${expected.name}'.`));
		return;
	}
	if (actual.kind !== expected.kind) {
		const article = expected.kind === "interface" ? "an" : "a";
		diagnostics.push(
			diagnostic(expected.line, `Expected '${expected.name}' to be ${article} ${expected.kind}; found ${actual.kind}.`),
		);
		return;
	}
	for (const expectedMember of expected.members) {
		const candidates = actual.members.filter((member) => member.name === expectedMember.name);
		if (candidates.some((member) => memberMatches(expectedMember, member))) continue;
		const found = candidates.length === 0 ? "not found" : candidates.map(formatMember).join("; ");
		diagnostics.push(
			diagnostic(
				expectedMember.line,
				`Expected ${formatMember(expectedMember)} on '${expected.name}'; found ${found}.`,
			),
		);
	}
}

function checkHeritageRelation(relation, implementations, diagnostics) {
	const isReverse = relation.operator === "<|--" || relation.operator === "<|..";
	const childName = isReverse ? relation.right : relation.left;
	const parentName = isReverse ? relation.left : relation.right;
	const child = implementations.declarations.get(childName);
	if (!child) return true;
	const isImplements = relation.operator === "<|.." || relation.operator === "..|>";
	const names = isImplements ? child.implementsNames : child.extendsNames;
	if (!names.has(parentName)) {
		const verb = isImplements ? "implement" : "extend";
		diagnostics.push(diagnostic(relation.line, `'${childName}' must ${verb} '${parentName}'.`));
	}
	return true;
}

export function checkClassDiagram(diagramSource, sources) {
	const diagram = parseMermaidClassDiagram(diagramSource);
	const implementations = analyzeTypeScriptSources(sources);
	const diagnostics = [];

	for (const expected of diagram.classes.values()) {
		if (expected.isImport) checkImport(expected, implementations, diagnostics);
		else if (expected.isFunction) checkFunction(expected, implementations, diagnostics);
		else checkDeclaration(expected, implementations, diagnostics);
		checkExport(expected, implementations, diagnostics);
	}

	for (const relation of diagram.relations) {
		if (["<|--", "--|>", "<|..", "..|>"].includes(relation.operator)) {
			checkHeritageRelation(relation, implementations, diagnostics);
			continue;
		}
		const reverse = relation.operator === "--*" || relation.operator === "--o";
		const ownerName = reverse ? relation.right : relation.left;
		const owner = implementations.declarations.get(ownerName);
		if (!owner) continue;
		const targetName = reverse ? relation.left : relation.right;
		const multiplicity = reverse ? relation.leftMultiplicity : relation.rightMultiplicity;
		if (!classReferences(owner, targetName, relationIsMany(multiplicity))) {
			const cardinality = relationIsMany(multiplicity) ? "a collection of" : "a reference to";
			diagnostics.push(
				diagnostic(relation.line, `'${ownerName}' must contain ${cardinality} '${targetName}' for this relationship.`),
			);
		}
	}

	return diagnostics.sort((left, right) => left.line - right.line || left.message.localeCompare(right.message));
}

async function collectTypeScriptSourcePaths(path, discoveredPaths) {
	const pathStat = await stat(path);
	if (pathStat.isFile()) {
		if (!TYPESCRIPT_SOURCE_EXTENSION.test(path) || path.endsWith(".d.ts")) {
			throw new Error(`Source input is not a TypeScript source file: ${path}`);
		}
		discoveredPaths.add(resolve(path));
		return;
	}
	if (!pathStat.isDirectory()) throw new Error(`Source input is not a file or directory: ${path}`);

	const entries = await readdir(path, { withFileTypes: true });
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory() && EXCLUDED_SOURCE_DIRECTORY_NAMES.has(entry.name)) continue;
		const entryPath = resolve(path, entry.name);
		if (entry.isDirectory()) await collectTypeScriptSourcePaths(entryPath, discoveredPaths);
		else if (entry.isFile() && TYPESCRIPT_SOURCE_EXTENSION.test(entry.name) && !entry.name.endsWith(".d.ts")) {
			discoveredPaths.add(entryPath);
		}
	}
}

export async function discoverTypeScriptSourcePaths(sourceInputs) {
	const discoveredPaths = new Set();
	for (const sourceInput of sourceInputs) await collectTypeScriptSourcePaths(resolve(sourceInput), discoveredPaths);
	const sourcePaths = [...discoveredPaths].sort();
	if (sourcePaths.length === 0) throw new Error("No TypeScript source files found in the supplied source paths");
	return sourcePaths;
}

export async function checkClassDiagramPaths(diagramPath, sourceInputs) {
	const sourcePaths = await discoverTypeScriptSourcePaths(sourceInputs);
	const [diagramSource, ...sourceTexts] = await Promise.all([
		readFile(diagramPath, "utf8"),
		...sourcePaths.map((path) => readFile(path, "utf8")),
	]);
	return {
		diagnostics: checkClassDiagram(
			diagramSource,
			sourcePaths.map((path, index) => ({ path, text: sourceTexts[index] })),
		),
		sourcePaths,
	};
}

export async function checkClassDiagramFiles(diagramPath, sourceInputs) {
	return (await checkClassDiagramPaths(diagramPath, sourceInputs)).diagnostics;
}

async function main() {
	const [, , diagramPath, ...sourceInputs] = process.argv;
	if (!diagramPath || sourceInputs.length === 0) {
		process.stderr.write("Usage: node check.mjs <diagram.mmd> <source-file-or-directory> [...]\n");
		process.exitCode = 2;
		return;
	}
	try {
		const { diagnostics, sourcePaths } = await checkClassDiagramPaths(diagramPath, sourceInputs);
		if (diagnostics.length === 0) {
			process.stdout.write(`Class diagram matches; scanned ${sourcePaths.length} TypeScript source file(s).\n`);
			return;
		}
		for (const result of diagnostics) process.stderr.write(`${diagramPath}:${result.line}: ${result.message}\n`);
		process.stderr.write(`${diagnostics.length} class diagram mismatch(es).\n`);
		process.exitCode = 1;
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
