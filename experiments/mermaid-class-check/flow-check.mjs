#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { discoverTypeScriptSourcePaths } from "./check.mjs";

function getOrCreateNode(nodes, id, line) {
	const existing = nodes.get(id);
	if (existing) return existing;
	const node = { id, line, symbol: id, concept: false };
	nodes.set(id, node);
	return node;
}

function applyFlowMetadata(line, nodes, lineNumber) {
	const symbolMatch = line.match(/^%%\s*pi:symbol\s+([A-Za-z_][\w-]*)\s+(\S+)\s*$/);
	const conceptMatch = line.match(/^%%\s*pi:concept\s+([A-Za-z_][\w-]*)\s*$/);
	if (!symbolMatch && !conceptMatch) return false;
	const id = symbolMatch?.[1] ?? conceptMatch?.[1];
	const node = nodes.get(id);
	if (!node) throw new SyntaxError(`Line ${lineNumber}: flow metadata target '${id}' is not declared`);
	if (symbolMatch) node.symbol = symbolMatch[2];
	else node.concept = true;
	return true;
}

function parseFlowEdge(line, lineNumber) {
	const match = line.match(/^([A-Za-z_][\w-]*)\s*(-->|==>|-\.->)\s*(?:\|([^|]*)\|\s*)?([A-Za-z_][\w-]*)$/);
	if (!match) return null;
	return { source: match[1], operator: match[2], label: match[3] ?? null, target: match[4], line: lineNumber };
}

export function parseMermaidFlowchart(source) {
	const nodes = new Map();
	const edges = [];
	let sawHeader = false;
	const lines = source.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const lineNumber = index + 1;
		const line = lines[index].trim();
		if (!line) continue;
		if (line.startsWith("%%")) {
			if (sawHeader) applyFlowMetadata(line, nodes, lineNumber);
			continue;
		}
		if (!sawHeader) {
			if (!/^flowchart\s+(?:TB|TD|BT|RL|LR)$/.test(line)) {
				throw new SyntaxError(`Line ${lineNumber}: expected a Mermaid flowchart direction header`);
			}
			sawHeader = true;
			continue;
		}
		if (/^direction\s+(?:TB|TD|BT|RL|LR)$/.test(line)) continue;
		const edge = parseFlowEdge(line, lineNumber);
		if (edge) {
			getOrCreateNode(nodes, edge.source, lineNumber);
			getOrCreateNode(nodes, edge.target, lineNumber);
			edges.push(edge);
			continue;
		}
		const nodeMatch = line.match(/^([A-Za-z_][\w-]*)\s*(?:\[.*\]|\{.*\}|\(.*\))$/);
		if (nodeMatch) {
			getOrCreateNode(nodes, nodeMatch[1], lineNumber);
			continue;
		}
		throw new SyntaxError(`Line ${lineNumber}: unsupported flowchart syntax: ${line}`);
	}
	if (!sawHeader) throw new SyntaxError("Flowchart is empty");
	return { nodes, edges };
}

function sourcePosition(sourceFile, node) {
	const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
	return { path: sourceFile.fileName, line: position.line + 1 };
}

function addSymbol(symbols, name, kind, sourceFile, node, body, ownerClass) {
	let symbol = symbols.get(name);
	if (!symbol) {
		symbol = { name, kind, calls: new Set(), callOrder: [], locations: [] };
		symbols.set(name, symbol);
	}
	symbol.locations.push(sourcePosition(sourceFile, node));
	if (body) collectCalls(body, ownerClass, symbol.calls, symbol.callOrder);
}

function calledSymbolName(expression, ownerClass) {
	if (ts.isIdentifier(expression)) return expression.text;
	if (!ts.isPropertyAccessExpression(expression)) return null;
	if (expression.expression.kind === ts.SyntaxKind.ThisKeyword && ownerClass) {
		return `${ownerClass}.${expression.name.text}`;
	}
	if (ts.isIdentifier(expression.expression) && /^[A-Z]/.test(expression.expression.text)) {
		return `${expression.expression.text}.${expression.name.text}`;
	}
	return null;
}

function collectCalls(root, ownerClass, calls, callOrder) {
	function visit(node) {
		if (ts.isCallExpression(node)) {
			const name = calledSymbolName(node.expression, ownerClass);
			if (name) {
				calls.add(name);
				callOrder.push(name);
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(root);
}

export function analyzeTypeScriptCallGraph(sources) {
	const symbols = new Map();
	for (const source of sources) {
		const scriptKind = source.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
		const sourceFile = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true, scriptKind);
		for (const statement of sourceFile.statements) {
			if (ts.isFunctionDeclaration(statement) && statement.name) {
				addSymbol(symbols, statement.name.text, "function", sourceFile, statement, statement.body, undefined);
				continue;
			}
			if (!ts.isClassDeclaration(statement) || !statement.name) continue;
			const className = statement.name.text;
			addSymbol(symbols, className, "class", sourceFile, statement, undefined, className);
			for (const member of statement.members) {
				if (!ts.isMethodDeclaration(member) || !member.name) continue;
				const methodName =
					ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
						? member.name.text
						: member.name.getText(sourceFile);
				addSymbol(symbols, `${className}.${methodName}`, "method", sourceFile, member, member.body, className);
			}
		}
	}
	return symbols;
}

function hasCallPath(symbols, sourceName, targetName) {
	if (sourceName === targetName) return true;
	const visited = new Set([sourceName]);
	const pending = [sourceName];
	while (pending.length > 0) {
		const currentName = pending.shift();
		const current = symbols.get(currentName);
		if (!current) continue;
		for (const calledName of current.calls) {
			if (calledName === targetName) return true;
			if (!symbols.has(calledName) || visited.has(calledName)) continue;
			visited.add(calledName);
			pending.push(calledName);
		}
	}
	return false;
}

function hasOrderedPhasePath(symbols, sourceName, targetName) {
	for (const owner of symbols.values()) {
		let sawSource = false;
		for (const calledName of owner.callOrder) {
			if (calledName === sourceName) sawSource = true;
			else if (sawSource && calledName === targetName) return true;
		}
	}
	return false;
}

function diagnostic(line, message) {
	return { line, message };
}

export function checkFlowchart(flowSource, sources) {
	const flowchart = parseMermaidFlowchart(flowSource);
	const symbols = analyzeTypeScriptCallGraph(sources);
	const diagnostics = [];
	for (const node of flowchart.nodes.values()) {
		if (!node.concept && !symbols.has(node.symbol)) {
			diagnostics.push(diagnostic(node.line, `Missing code symbol '${node.symbol}' for flow node '${node.id}'.`));
		}
	}
	for (const edge of flowchart.edges) {
		const sourceNode = flowchart.nodes.get(edge.source);
		const targetNode = flowchart.nodes.get(edge.target);
		if (sourceNode.concept || targetNode.concept) continue;
		if (!symbols.has(sourceNode.symbol) || !symbols.has(targetNode.symbol)) continue;
		if (
			!hasCallPath(symbols, sourceNode.symbol, targetNode.symbol) &&
			!hasOrderedPhasePath(symbols, sourceNode.symbol, targetNode.symbol)
		) {
			diagnostics.push(
				diagnostic(
					edge.line,
					`No static call or ordered phase path from '${sourceNode.symbol}' to '${targetNode.symbol}' for flow edge '${edge.source}' -> '${edge.target}'.`,
				),
			);
		}
	}
	return diagnostics.sort((left, right) => left.line - right.line || left.message.localeCompare(right.message));
}

export async function checkFlowchartPaths(flowPath, sourceInputs) {
	const sourcePaths = await discoverTypeScriptSourcePaths(sourceInputs);
	const [flowSource, ...sourceTexts] = await Promise.all([
		readFile(flowPath, "utf8"),
		...sourcePaths.map((path) => readFile(path, "utf8")),
	]);
	return {
		diagnostics: checkFlowchart(
			flowSource,
			sourcePaths.map((path, index) => ({ path, text: sourceTexts[index] })),
		),
		sourcePaths,
	};
}

async function main() {
	const [, , flowPath, ...sourceInputs] = process.argv;
	if (!flowPath || sourceInputs.length === 0) {
		process.stderr.write("Usage: node flow-check.mjs <flowchart.mmd> <source-file-or-directory> [...]\n");
		process.exitCode = 2;
		return;
	}
	try {
		const { diagnostics, sourcePaths } = await checkFlowchartPaths(flowPath, sourceInputs);
		if (diagnostics.length === 0) {
			process.stdout.write(`Flowchart matches; scanned ${sourcePaths.length} TypeScript source file(s).\n`);
			return;
		}
		for (const result of diagnostics) process.stderr.write(`${flowPath}:${result.line}: ${result.message}\n`);
		process.stderr.write(`${diagnostics.length} flowchart mismatch(es).\n`);
		process.exitCode = 1;
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
