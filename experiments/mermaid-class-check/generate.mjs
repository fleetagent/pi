#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeTypeScriptSources, checkClassDiagram, discoverTypeScriptSourcePaths } from "./check.mjs";
import { analyzeTypeScriptCallGraph, checkFlowchart } from "./flow-check.mjs";

const VISIBILITY_SYMBOL = new Map([
	["public", "+"],
	["private", "-"],
	["protected", "#"],
	["package", "~"],
]);

async function loadSources(sourceInputs) {
	const sourcePaths = await discoverTypeScriptSourcePaths(sourceInputs);
	const texts = await Promise.all(sourcePaths.map((path) => readFile(path, "utf8")));
	return sourcePaths.map((path, index) => ({ path, text: texts[index] }));
}

function isRenderableMemberName(name) {
	return /^#?[A-Za-z_$][\w$]*$/.test(name);
}

function isRenderableType(type) {
	return type !== null && !/[\n\r{}();]/.test(type) && !type.includes("=>");
}

function mermaidType(type) {
	const openCount = [...type].filter((character) => character === "<").length;
	const closeCount = [...type].filter((character) => character === ">").length;
	return openCount === 1 && closeCount === 1 ? type.replace("<", "~").replace(">", "~") : type;
}

function renderClassMember(member) {
	if (!isRenderableMemberName(member.name)) return null;
	const visibility = VISIBILITY_SYMBOL.get(member.visibility);
	if (!visibility) return null;
	const staticMarker = member.isStatic ? "$" : "";
	if (member.kind === "property") {
		if (!isRenderableType(member.type)) return null;
		return `${visibility}${member.name}: ${mermaidType(member.type)}${staticMarker}`;
	}
	if (member.parameters.some((type) => !isRenderableType(type))) return null;
	if (member.type !== null && !isRenderableType(member.type)) return null;
	const asyncMarker = member.isAsync ? "async " : "";
	const parameters = member.parameters.map(mermaidType).join(", ");
	const returnType = member.type === null ? "" : `: ${mermaidType(member.type)}`;
	return `${visibility}${asyncMarker}${member.name}(${parameters})${returnType}${staticMarker}`;
}

function typeReferences(type, target) {
	return new RegExp(`(?:^|[^A-Za-z0-9_$])${target}(?:$|[^A-Za-z0-9_$])`).test(type ?? "");
}

function isCollectionReference(type, target) {
	if (!type) return false;
	if (type.endsWith("[]")) return typeReferences(type.slice(0, -2), target);
	for (const collection of ["ReadonlyArray", "Set"]) {
		const prefix = `${collection}<`;
		if (type.startsWith(prefix) && type.endsWith(">")) {
			return typeReferences(type.slice(prefix.length, -1), target);
		}
	}
	return false;
}

function declarationDependencies(declaration, declarations) {
	const dependencies = new Set([...declaration.extendsNames, ...declaration.implementsNames]);
	for (const member of declaration.members) {
		if (member.kind !== "property") continue;
		for (const name of declarations.keys()) {
			if (name !== declaration.name && typeReferences(member.type, name)) dependencies.add(name);
		}
	}
	return [...dependencies].filter((name) => declarations.has(name)).sort();
}

function selectClassDeclarations(entryName, declarations, depth, maxNodes) {
	const selected = new Map();
	const pending = [{ name: entryName, depth: 0 }];
	while (pending.length > 0 && selected.size < maxNodes) {
		const current = pending.shift();
		if (selected.has(current.name)) continue;
		const declaration = declarations.get(current.name);
		if (!declaration) continue;
		selected.set(current.name, declaration);
		if (current.depth >= depth) continue;
		for (const dependency of declarationDependencies(declaration, declarations)) {
			if (!selected.has(dependency)) pending.push({ name: dependency, depth: current.depth + 1 });
		}
	}
	return selected;
}

function renderClassDeclaration(declaration, exports, defaultExports) {
	const members = declaration.members.map(renderClassMember).filter((member) => member !== null);
	const lines =
		members.length === 0
			? [`    class ${declaration.name}`]
			: [`    class ${declaration.name} {`, ...members.map((member) => `        ${member}`), "    }"];
	if (declaration.kind === "interface") lines.push(`    <<interface>> ${declaration.name}`);
	if (exports.has(declaration.name)) lines.push(`    <<export>> ${declaration.name}`);
	if (defaultExports.has(declaration.name)) {
		if (!exports.has(declaration.name)) lines.push(`    <<export>> ${declaration.name}`);
		lines.push(`    %% pi:default-export ${declaration.name}`);
	}
	return lines;
}

function renderClassRelations(selected) {
	const relations = new Set();
	for (const declaration of selected.values()) {
		for (const parent of declaration.extendsNames) {
			if (selected.has(parent)) relations.add(`    ${parent} <|-- ${declaration.name}`);
		}
		for (const contract of declaration.implementsNames) {
			if (selected.has(contract)) relations.add(`    ${contract} <|.. ${declaration.name}`);
		}
		for (const target of selected.keys()) {
			if (
				target === declaration.name ||
				declaration.extendsNames.has(target) ||
				declaration.implementsNames.has(target)
			) {
				continue;
			}
			const properties = declaration.members.filter(
				(member) => member.kind === "property" && typeReferences(member.type, target),
			);
			if (properties.length === 0) continue;
			const many = properties.some((member) => isCollectionReference(member.type, target));
			relations.add(many ? `    ${declaration.name} "1" --> "*" ${target}` : `    ${declaration.name} --> ${target}`);
		}
	}
	return [...relations].sort();
}

export function generateClassDiagram(entryName, entrySource, sources, options = {}) {
	const depth = options.depth ?? 1;
	const maxNodes = options.maxNodes ?? 20;
	const entryAnalysis = analyzeTypeScriptSources([entrySource]);
	if (!entryAnalysis.declarations.has(entryName)) {
		throw new Error(`Class or interface '${entryName}' was not found in entry file ${entrySource.path}`);
	}
	const implementations = analyzeTypeScriptSources(sources);
	const selected = selectClassDeclarations(entryName, implementations.declarations, depth, maxNodes);
	const lines = ["classDiagram", `    %% pi:generated entry ${entryName} depth ${depth} max-nodes ${maxNodes}`];
	for (const declaration of selected.values()) {
		lines.push(...renderClassDeclaration(declaration, implementations.exports, implementations.defaultExports), "");
	}
	lines.push(...renderClassRelations(selected));
	const diagram = `${lines.join("\n").trimEnd()}\n`;
	const diagnostics = checkClassDiagram(diagram, sources);
	if (diagnostics.length > 0) {
		throw new Error(
			`Generated class diagram failed validation:\n${diagnostics.map((item) => `line ${item.line}: ${item.message}`).join("\n")}`,
		);
	}
	return diagram;
}

function selectFlowSymbols(entryName, symbols, depth, maxNodes) {
	const selected = new Map();
	const pending = [{ name: entryName, depth: 0 }];
	while (pending.length > 0 && selected.size < maxNodes) {
		const current = pending.shift();
		if (selected.has(current.name)) continue;
		const symbol = symbols.get(current.name);
		if (!symbol) continue;
		selected.set(current.name, symbol);
		if (current.depth >= depth) continue;
		const calls = [...new Set(symbol.callOrder)].filter((name) => symbols.has(name));
		for (const call of calls) {
			if (!selected.has(call)) pending.push({ name: call, depth: current.depth + 1 });
		}
	}
	return selected;
}

function createFlowNodeIds(names) {
	const ids = new Map();
	const used = new Set();
	for (const name of names) {
		const base = name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z_]/, "_$&");
		let id = base;
		let suffix = 2;
		while (used.has(id)) {
			id = `${base}_${suffix}`;
			suffix += 1;
		}
		used.add(id);
		ids.set(name, id);
	}
	return ids;
}

function flowLabel(name) {
	return `${name}()`.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

export function generateFlowchart(entryName, entryPath, sources, options = {}) {
	const depth = options.depth ?? 6;
	const maxNodes = options.maxNodes ?? 24;
	const symbols = analyzeTypeScriptCallGraph(sources);
	const entry = symbols.get(entryName);
	if (!entry || entry.kind === "class") {
		throw new Error(`Function or method '${entryName}' was not found`);
	}
	const entryFiles = new Set(entry.locations.map((location) => resolve(location.path)));
	if (!entryFiles.has(resolve(entryPath))) {
		throw new Error(`Function or method '${entryName}' was not found in entry file ${entryPath}`);
	}
	if (entryFiles.size > 1) {
		throw new Error(`Function or method '${entryName}' is ambiguous across: ${[...entryFiles].sort().join(", ")}`);
	}
	const selected = selectFlowSymbols(entryName, symbols, depth, maxNodes);
	const nodeIds = createFlowNodeIds(selected.keys());
	const lines = ["flowchart TD", `    %% pi:generated entry ${entryName} depth ${depth} max-nodes ${maxNodes}`];
	for (const name of selected.keys()) lines.push(`    ${nodeIds.get(name)}["${flowLabel(name)}"]`);
	lines.push("");
	for (const name of selected.keys()) lines.push(`    %% pi:symbol ${nodeIds.get(name)} ${name}`);
	lines.push("");
	const edges = new Set();
	for (const [name, symbol] of selected) {
		for (const target of symbol.callOrder) {
			if (selected.has(target)) edges.add(`    ${nodeIds.get(name)} --> ${nodeIds.get(target)}`);
		}
	}
	lines.push(...edges);
	const diagram = `${lines.join("\n").trimEnd()}\n`;
	const diagnostics = checkFlowchart(diagram, sources);
	if (diagnostics.length > 0) {
		throw new Error(
			`Generated flowchart failed validation:\n${diagnostics.map((item) => `line ${item.line}: ${item.message}`).join("\n")}`,
		);
	}
	return diagram;
}

function parsePositiveInteger(value, flag, allowZero) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) throw new Error(`${flag} must be an integer`);
	return parsed;
}

function parseArguments(argv) {
	const [mode, entryFile, entryName, ...flags] = argv;
	if (!["class", "flow"].includes(mode) || !entryFile || !entryName) return null;
	const options = {
		mode,
		entryFile: resolve(entryFile),
		entryName,
		sourceInputs: [],
		output: null,
		depth: undefined,
		maxNodes: undefined,
	};
	for (let index = 0; index < flags.length; index += 1) {
		const flag = flags[index];
		const value = flags[index + 1];
		if (!value) throw new Error(`Missing value for ${flag}`);
		if (flag === "--source") options.sourceInputs.push(value);
		else if (flag === "--output") options.output = resolve(value);
		else if (flag === "--depth") options.depth = parsePositiveInteger(value, flag, true);
		else if (flag === "--max-nodes") options.maxNodes = parsePositiveInteger(value, flag, false);
		else throw new Error(`Unknown option: ${flag}`);
		index += 1;
	}
	if (options.sourceInputs.length === 0) options.sourceInputs.push(dirname(options.entryFile));
	return options;
}

function printUsage() {
	process.stderr.write(
		"Usage:\n" +
			"  node generate.mjs class <entry.ts> <ClassName> [--source <path>] [--depth N] [--max-nodes N] [--output file]\n" +
			"  node generate.mjs flow <entry.ts> <function|Class.method> [--source <path>] [--depth N] [--max-nodes N] [--output file]\n",
	);
}

async function main() {
	try {
		const options = parseArguments(process.argv.slice(2));
		if (!options) {
			printUsage();
			process.exitCode = 2;
			return;
		}
		const sources = await loadSources(options.sourceInputs);
		const entrySource = sources.find((source) => resolve(source.path) === options.entryFile);
		if (!entrySource) throw new Error(`Entry file is outside the supplied source paths: ${options.entryFile}`);
		const generatorOptions = { depth: options.depth, maxNodes: options.maxNodes };
		const diagram =
			options.mode === "class"
				? generateClassDiagram(options.entryName, entrySource, sources, generatorOptions)
				: generateFlowchart(options.entryName, options.entryFile, sources, generatorOptions);
		if (!options.output) {
			process.stdout.write(diagram);
			return;
		}
		await mkdir(dirname(options.output), { recursive: true });
		await writeFile(options.output, diagram, "utf8");
		process.stdout.write(`Generated validated ${options.mode} diagram: ${options.output}\n`);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
