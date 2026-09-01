import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const RULE_NAME = "noExcessiveCollectionIterations";
const IGNORE_DIRECTIVE_PATTERN =
	/(?:\/\/\s*pi-ignore\s+noExcessiveCollectionIterations\s*:\s*([^\r\n]*)|\/\*\s*pi-ignore\s+noExcessiveCollectionIterations\s*:\s*([\s\S]*?)\*\/)\s*$/;
const SOURCE_DIRECTORY_NAMES = new Set(["src", "test"]);
const EXCLUDED_DIRECTORY_NAMES = new Set([".git", ".worktrees", "dist", "node_modules"]);
const ITERATION_METHODS = new Set([
	"every",
	"filter",
	"find",
	"findIndex",
	"findLast",
	"findLastIndex",
	"flatMap",
	"forEach",
	"map",
	"reduce",
	"reduceRight",
	"some",
	"sort",
	"toSorted",
]);
const LINEAR_LOOKUP_METHODS = new Set(["includes", "indexOf", "lastIndexOf"]);
const CHAINED_PASS_METHODS = new Set(["filter", "map"]);

function position(sourceFile, offset) {
	const value = sourceFile.getLineAndCharacterOfPosition(offset);
	return { line: value.line + 1, column: value.character + 1 };
}

function hasIgnoreDirective(node, sourceFile) {
	const directive = IGNORE_DIRECTIVE_PATTERN.exec(
		sourceFile.text.slice(node.getFullStart(), node.getStart(sourceFile)),
	);
	return Boolean((directive?.[1] ?? directive?.[2] ?? "").trim());
}

function unwrapExpression(node) {
	let current = node;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isTypeAssertionExpression(current) ||
		ts.isNonNullExpression(current) ||
		ts.isSatisfiesExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function callMethodName(node) {
	const expression = unwrapExpression(node.expression);
	if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
	if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
		const argument = unwrapExpression(expression.argumentExpression);
		if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return argument.text;
	}
	return undefined;
}

function callReceiver(node) {
	const expression = unwrapExpression(node.expression);
	if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
		return unwrapExpression(expression.expression);
	}
	return undefined;
}

function isCallReceiver(node) {
	let parent = node.parent;
	while (
		parent &&
		(ts.isParenthesizedExpression(parent) ||
			ts.isAsExpression(parent) ||
			ts.isTypeAssertionExpression(parent) ||
			ts.isNonNullExpression(parent) ||
			ts.isSatisfiesExpression(parent))
	) {
		parent = parent.parent;
	}
	if (!parent || (!ts.isPropertyAccessExpression(parent) && !ts.isElementAccessExpression(parent))) return false;
	return ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
}

function chainedPassMethods(node) {
	const methods = [];
	let current = node;
	while (ts.isCallExpression(current)) {
		const method = callMethodName(current);
		if (!method || !CHAINED_PASS_METHODS.has(method)) break;
		methods.push(method);
		const receiver = callReceiver(current);
		if (!receiver || !ts.isCallExpression(receiver)) break;
		current = receiver;
	}
	return methods.reverse();
}

function repeatedPassDescription(methods) {
	const repeated = new Set();
	for (let index = 1; index < methods.length; index++) {
		if (methods[index] === methods[index - 1]) repeated.add(methods[index]);
	}
	if (repeated.size === 0) return undefined;
	return `repeated adjacent ${[...repeated].map((method) => `.${method}()`).join(" and ")} passes`;
}

function functionName(node) {
	if (node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) return node.name.text;
	const parent = node.parent;
	if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
	if (ts.isPropertyAssignment(parent) && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))) {
		return parent.name.text;
	}
	return "anonymous function";
}

function functionLocationNode(node) {
	if (node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) return node.name;
	const parent = node.parent;
	if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name;
	if (ts.isPropertyAssignment(parent) && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))) {
		return parent.name;
	}
	return node;
}

function isLoop(node) {
	return (
		ts.isForStatement(node) ||
		ts.isForInStatement(node) ||
		ts.isForOfStatement(node) ||
		ts.isWhileStatement(node) ||
		ts.isDoStatement(node)
	);
}

function collectBindingNames(name, names) {
	if (ts.isIdentifier(name)) {
		names.add(name.text);
		return;
	}
	for (const element of name.elements) {
		if (ts.isBindingElement(element)) collectBindingNames(element.name, names);
	}
}

function collectWrittenIdentifiers(node, names) {
	if (!node) return;
	function visit(current) {
		if (ts.isFunctionLike(current)) return;
		if (
			ts.isPostfixUnaryExpression(current) ||
			(ts.isPrefixUnaryExpression(current) &&
				(current.operator === ts.SyntaxKind.PlusPlusToken || current.operator === ts.SyntaxKind.MinusMinusToken))
		) {
			if (ts.isIdentifier(current.operand)) names.add(current.operand.text);
		} else if (ts.isBinaryExpression(current) && current.operatorToken.kind >= ts.SyntaxKind.FirstAssignment) {
			const left = unwrapExpression(current.left);
			if (ts.isIdentifier(left)) names.add(left.text);
		}
		ts.forEachChild(current, visit);
	}
	visit(node);
}

function loopBindingNames(loop) {
	const names = new Set();
	const initializer = loop.initializer;
	if (initializer) {
		if (ts.isVariableDeclarationList(initializer)) {
			for (const declaration of initializer.declarations) collectBindingNames(declaration.name, names);
		} else if (ts.isIdentifier(initializer)) {
			names.add(initializer.text);
		} else {
			collectWrittenIdentifiers(initializer, names);
		}
	}
	if (ts.isForStatement(loop)) collectWrittenIdentifiers(loop.incrementor, names);
	if (ts.isWhileStatement(loop) || ts.isDoStatement(loop)) collectWrittenIdentifiers(loop.statement, names);
	return names;
}

function referencesBindings(node, bindings) {
	if (!node || bindings.size === 0) return false;
	let found = false;
	function visit(current) {
		if (found || ts.isFunctionLike(current)) return;
		if (ts.isIdentifier(current) && bindings.has(current.text)) {
			found = true;
			return;
		}
		ts.forEachChild(current, visit);
	}
	visit(node);
	return found;
}

function repeatedLoopExpression(loop) {
	if (ts.isForStatement(loop)) return loop.condition;
	if (ts.isForInStatement(loop) || ts.isForOfStatement(loop)) return loop.expression;
	return undefined;
}

function extendIterationContext(context, bindings) {
	const nextBindings = new Set(context?.bindings ?? []);
	const strings = new Set(context?.strings ?? []);
	for (const binding of bindings) {
		nextBindings.delete(binding);
		strings.delete(binding);
		nextBindings.add(binding);
	}
	return { bindings: nextBindings, strings, known: true };
}

function cloneContext(context) {
	return {
		bindings: new Set(context?.bindings ?? []),
		strings: new Set(context?.strings ?? []),
		known: context?.known === true,
	};
}

function isIterationCallback(node) {
	let argument = node;
	let parent = node.parent;
	while (
		parent &&
		(ts.isParenthesizedExpression(parent) ||
			ts.isAsExpression(parent) ||
			ts.isTypeAssertionExpression(parent) ||
			ts.isNonNullExpression(parent) ||
			ts.isSatisfiesExpression(parent))
	) {
		argument = parent;
		parent = parent.parent;
	}
	return (
		ts.isCallExpression(parent) &&
		parent.arguments[0] === argument &&
		ITERATION_METHODS.has(callMethodName(parent) ?? "")
	);
}

function isStringTypeNode(node) {
	if (!node) return false;
	if (node.kind === ts.SyntaxKind.StringKeyword) return true;
	if (ts.isLiteralTypeNode(node)) return ts.isStringLiteral(node.literal);
	if (ts.isUnionTypeNode(node)) return node.types.length > 0 && node.types.every((member) => isStringTypeNode(member));
	return false;
}

function isKnownStringExpression(node, stringBindings) {
	const expression = unwrapExpression(node);
	if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return true;
	if (ts.isTemplateExpression(expression)) return true;
	if (ts.isIdentifier(expression)) return stringBindings.has(expression.text);
	if (ts.isConditionalExpression(expression)) {
		return (
			isKnownStringExpression(expression.whenTrue, stringBindings) &&
			isKnownStringExpression(expression.whenFalse, stringBindings)
		);
	}
	if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		return (
			isKnownStringExpression(expression.left, stringBindings) ||
			isKnownStringExpression(expression.right, stringBindings)
		);
	}
	return false;
}

function initialStringBindings(node) {
	const bindings = new Set();
	for (const parameter of node.parameters) {
		if (ts.isIdentifier(parameter.name) && isStringTypeNode(parameter.type)) bindings.add(parameter.name.text);
	}
	return bindings;
}

function recordVariableFacts(declaration, context) {
	const names = new Set();
	collectBindingNames(declaration.name, names);
	const dependent =
		declaration.initializer !== undefined &&
		context.known &&
		referencesBindings(declaration.initializer, context.bindings);
	for (const name of names) {
		if (dependent) context.bindings.add(name);
		else context.bindings.delete(name);
	}
	if (!ts.isIdentifier(declaration.name)) return;
	const stringValue =
		isStringTypeNode(declaration.type) ||
		(declaration.initializer !== undefined && isKnownStringExpression(declaration.initializer, context.strings));
	if (stringValue) context.strings.add(declaration.name.text);
	else context.strings.delete(declaration.name.text);
}

function recordAssignmentFacts(expression, context) {
	if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
	const left = unwrapExpression(expression.left);
	if (!ts.isIdentifier(left)) return;
	if (context.known && referencesBindings(expression.right, context.bindings)) context.bindings.add(left.text);
	else context.bindings.delete(left.text);
	if (isKnownStringExpression(expression.right, context.strings)) context.strings.add(left.text);
	else context.strings.delete(left.text);
}

function analyzeFunction(node, sourceFile) {
	if (!node.body || hasIgnoreDirective(node, sourceFile)) return [];
	const findings = new Map();
	const rootContext = { bindings: new Set(), strings: initialStringBindings(node), known: false };
	const addFinding = (findingNode, description) => {
		const start = findingNode.getStart(sourceFile);
		findings.set(`${start}:${description}`, { start, description });
	};
	const walkLoop = (loop, context, walk) => {
		const repeatedExpression = repeatedLoopExpression(loop);
		if (context?.known && repeatedExpression && !referencesBindings(repeatedExpression, context.bindings)) {
			addFinding(loop, "a nested traversal over an outer-invariant collection or bound");
		}
		const ownBindings = loopBindingNames(loop);
		const loopContext = cloneContext(context);
		const childContext = extendIterationContext(loopContext, ownBindings);
		if (ts.isForStatement(loop)) {
			if (loop.initializer) walk(loop.initializer, loopContext);
			if (loop.condition) walk(loop.condition, childContext);
			if (loop.incrementor) walk(loop.incrementor, childContext);
			walk(loop.statement, childContext);
			return;
		}
		if (ts.isForInStatement(loop) || ts.isForOfStatement(loop)) {
			walk(loop.initializer, loopContext);
			walk(loop.expression, loopContext);
			walk(loop.statement, childContext);
			return;
		}
		walk(loop.expression, childContext);
		walk(loop.statement, childContext);
	};
	const walk = (current, context) => {
		if (current !== node && ts.isFunctionLike(current)) return;
		if (ts.isBlock(current)) {
			const blockContext = cloneContext(context);
			for (const statement of current.statements) walk(statement, blockContext);
			return;
		}
		if (ts.isVariableDeclaration(current)) recordVariableFacts(current, context);
		if (ts.isBinaryExpression(current)) recordAssignmentFacts(current, context);
		if (isLoop(current)) {
			walkLoop(current, context, walk);
			return;
		}
		if (ts.isCallExpression(current)) {
			const method = callMethodName(current);
			if (!isCallReceiver(current)) {
				const description = repeatedPassDescription(chainedPassMethods(current));
				if (description) addFinding(current, description);
			}
			const receiver = callReceiver(current);
			const receiverIsInvariant =
				context?.known === true && receiver !== undefined && !referencesBindings(receiver, context.bindings);
			if (receiverIsInvariant && method && ITERATION_METHODS.has(method)) {
				addFinding(current, `a .${method}() traversal of outer-invariant data inside an iteration`);
			}
			if (
				receiverIsInvariant &&
				method &&
				LINEAR_LOOKUP_METHODS.has(method) &&
				!isKnownStringExpression(receiver, context.strings)
			) {
				addFinding(current, `a linear .${method}() lookup over outer-invariant data inside an iteration`);
			}
			if (receiver) walk(receiver, context);
			for (const [argumentIndex, argument] of current.arguments.entries()) {
				const unwrappedArgument = unwrapExpression(argument);
				if (argumentIndex === 0 && ts.isFunctionLike(unwrappedArgument)) {
					if (method && ITERATION_METHODS.has(method) && unwrappedArgument.body) {
						const callbackBindings = new Set();
						for (const parameter of unwrappedArgument.parameters) {
							collectBindingNames(parameter.name, callbackBindings);
						}
						walk(unwrappedArgument.body, extendIterationContext(context, callbackBindings));
					}
				} else if (!ts.isFunctionLike(unwrappedArgument)) {
					walk(argument, context);
				}
			}
			return;
		}
		ts.forEachChild(current, (child) => walk(child, context));
	};
	walk(node.body, rootContext);
	return [...findings.values()].sort((left, right) => left.start - right.start);
}

function createDiagnostic(path, sourceFile, node, findings) {
	const target = functionLocationNode(node);
	const start = target.getStart(sourceFile);
	const end = target.end;
	const summaries = findings.slice(0, 5).map((finding) => {
		const location = position(sourceFile, finding.start);
		return `${finding.description} at line ${location.line}`;
	});
	const omitted = findings.length - summaries.length;
	return {
		category: "plugin",
		severity: "error",
		message: `[${RULE_NAME}] Function ${functionName(node)} contains potentially superlinear collection work or avoidable repeated full passes: ${summaries.join("; ")}${omitted > 0 ? `; and ${omitted} more finding${omitted === 1 ? "" : "s"}` : ""}. Move invariant traversal outside iterations, precompute Set/Map indexes for repeated lookups, or combine repeated passes when that remains clearer.`,
		location: {
			path,
			span: [start, end],
			start: position(sourceFile, start),
			end: position(sourceFile, end),
		},
	};
}

export function analyzeCollectionIterationSource(path, sourceText) {
	const scriptKind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
	const diagnostics = [];
	function visit(node) {
		if (ts.isFunctionLike(node) && node.body && !isIterationCallback(node)) {
			const findings = analyzeFunction(node, sourceFile);
			if (findings.length > 0) diagnostics.push(createDiagnostic(path, sourceFile, node, findings));
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return diagnostics.sort(
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
				return analyzeCollectionIterationSource(relativePath, await readFile(path, "utf8"));
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
