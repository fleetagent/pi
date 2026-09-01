import { createInterface } from "node:readline";
import type { AgentTool, AgentToolResult } from "@fleetagent/pi-agent-core";
import { Text } from "@fleetagent/pi-tui";
import { spawn } from "child_process";
import path from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import type { ToolGrepMatch, ToolOperations } from "./operations.ts";
import { resolveToCwd } from "./path-utils.ts";
import { formatBackendIcon, getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.ts";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

export interface GrepToolOptions {}

function formatGrepCall(args: Partial<GrepToolInput> | undefined, theme: Theme): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const glob = str(args?.glob);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("grep")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	return text;
}

function formatGrepResult(
	result: AgentToolResult<GrepToolDetails | undefined>,
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}

	const matchLimit = result.details?.matchLimitReached;
	const truncation = result.details?.truncation;
	const linesTruncated = result.details?.linesTruncated;
	if (matchLimit || truncation?.truncated || linesTruncated) {
		const warnings: string[] = [];
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		if (linesTruncated) warnings.push("some lines truncated");
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}
interface GrepFormatState {
	operations: ToolOperations;
	searchPath: string;
	isDirectory: boolean;
	context: number;
	fileCache: Map<string, string[]>;
	linesTruncated: boolean;
}

interface GrepExecutionInput {
	pattern: string;
	searchPath: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context: number;
	limit: number;
}

interface RipgrepCollectionState {
	stderr: string;
	matchCount: number;
	matchLimitReached: boolean;
	aborted: boolean;
	killedDueToLimit: boolean;
	matches: ToolGrepMatch[];
}

function noGrepMatchesResult(): AgentToolResult<GrepToolDetails | undefined> {
	return { content: [{ type: "text", text: "No matches found" }], details: undefined };
}

function formatMatchedFilePath(state: GrepFormatState, filePath: string): string {
	if (state.isDirectory) {
		const relative = path.relative(state.searchPath, filePath);
		if (relative && !relative.startsWith("..")) return relative.replace(/\\/g, "/");
	}
	return path.basename(filePath);
}

async function getGrepFileLines(state: GrepFormatState, filePath: string): Promise<string[]> {
	const cached = state.fileCache.get(filePath);
	if (cached) return cached;
	let lines: string[];
	try {
		const content = (await state.operations.readFile(filePath)).toString("utf-8");
		lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	} catch {
		lines = [];
	}
	state.fileCache.set(filePath, lines);
	return lines;
}

async function formatGrepContextBlock(state: GrepFormatState, match: ToolGrepMatch): Promise<string[]> {
	const relativePath = formatMatchedFilePath(state, match.filePath);
	const lines = await getGrepFileLines(state, match.filePath);
	if (!lines.length) return [`${relativePath}:${match.lineNumber}: (unable to read file)`];
	const block: string[] = [];
	const start = state.context > 0 ? Math.max(1, match.lineNumber - state.context) : match.lineNumber;
	const end = state.context > 0 ? Math.min(lines.length, match.lineNumber + state.context) : match.lineNumber;
	for (let current = start; current <= end; current++) {
		const sanitized = (lines[current - 1] ?? "").replace(/\r/g, "");
		const { text, wasTruncated } = truncateLine(sanitized);
		if (wasTruncated) state.linesTruncated = true;
		block.push(
			current === match.lineNumber ? `${relativePath}:${current}: ${text}` : `${relativePath}-${current}- ${text}`,
		);
	}
	return block;
}

async function formatGrepMatch(state: GrepFormatState, match: ToolGrepMatch): Promise<string[]> {
	if (state.context !== 0 || match.lineText === undefined) return formatGrepContextBlock(state, match);
	const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
	const { text, wasTruncated } = truncateLine(sanitized);
	if (wasTruncated) state.linesTruncated = true;
	return [`${formatMatchedFilePath(state, match.filePath)}:${match.lineNumber}: ${text}`];
}

async function formatGrepMatches(state: GrepFormatState, matches: ToolGrepMatch[]): Promise<string[]> {
	const outputLines: string[] = [];
	for (const match of matches) outputLines.push(...(await formatGrepMatch(state, match)));
	return outputLines;
}

function buildGrepResult(
	state: GrepFormatState,
	outputLines: string[],
	matchLimitReached: number | undefined,
): AgentToolResult<GrepToolDetails | undefined> {
	const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;
	const details: GrepToolDetails = {};
	const notices: string[] = [];
	if (matchLimitReached !== undefined) {
		notices.push(
			`${matchLimitReached} matches limit reached. Use limit=${matchLimitReached * 2} for more, or refine pattern`,
		);
		details.matchLimitReached = matchLimitReached;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (state.linesTruncated) {
		notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
		details.linesTruncated = true;
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
	return {
		content: [{ type: "text", text: output }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

async function executeOperationsGrep(
	operations: ToolOperations,
	input: GrepExecutionInput,
	formatState: GrepFormatState,
): Promise<AgentToolResult<GrepToolDetails | undefined>> {
	const result = await operations.grep!({
		pattern: input.pattern,
		path: input.searchPath,
		glob: input.glob,
		ignoreCase: input.ignoreCase,
		literal: input.literal,
		limit: input.limit,
	});
	formatState.isDirectory = result.isDirectory;
	if (result.matches.length === 0) return noGrepMatchesResult();
	const outputLines = await formatGrepMatches(formatState, result.matches);
	return buildGrepResult(formatState, outputLines, result.matches.length >= input.limit ? input.limit : undefined);
}

function buildRipgrepArgs(input: GrepExecutionInput): string[] {
	const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
	if (input.ignoreCase) args.push("--ignore-case");
	if (input.literal) args.push("--fixed-strings");
	if (input.glob) args.push("--glob", input.glob);
	args.push("--", input.pattern, input.searchPath);
	return args;
}

interface ParsedRipgrepLine {
	matchedEvent: boolean;
	match?: ToolGrepMatch;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getRecordText(value: unknown): unknown {
	return isUnknownRecord(value) ? value.text : undefined;
}

function parseRipgrepLine(line: string): ParsedRipgrepLine {
	if (!line.trim()) return { matchedEvent: false };
	let event: unknown;
	try {
		event = JSON.parse(line) as unknown;
	} catch {
		return { matchedEvent: false };
	}
	if (!isUnknownRecord(event) || event.type !== "match") return { matchedEvent: false };
	const data = isUnknownRecord(event.data) ? event.data : undefined;
	const filePath = getRecordText(data?.path);
	const lineNumber = data?.line_number;
	const lineText = getRecordText(data?.lines);
	return {
		matchedEvent: true,
		...(typeof filePath === "string" && typeof lineNumber === "number"
			? { match: { filePath, lineNumber, ...(typeof lineText === "string" ? { lineText } : {}) } }
			: {}),
	};
}

function collectRipgrepLine(
	line: string,
	state: RipgrepCollectionState,
	limit: number,
	stopChild: (dueToLimit?: boolean) => void,
): void {
	if (state.matchCount >= limit) return;
	const parsed = parseRipgrepLine(line);
	if (!parsed.matchedEvent) return;
	state.matchCount++;
	if (parsed.match) state.matches.push(parsed.match);
	if (state.matchCount >= limit) {
		state.matchLimitReached = true;
		stopChild(true);
	}
}

async function finishRipgrepExecution(
	code: number | null,
	state: RipgrepCollectionState,
	formatState: GrepFormatState,
	limit: number,
): Promise<AgentToolResult<GrepToolDetails | undefined>> {
	if (state.aborted) throw new Error("Operation aborted");
	if (!state.killedDueToLimit && code !== 0 && code !== 1) {
		throw new Error(state.stderr.trim() || `ripgrep exited with code ${code}`);
	}
	if (state.matchCount === 0) return noGrepMatchesResult();
	const outputLines = await formatGrepMatches(formatState, state.matches);
	return buildGrepResult(formatState, outputLines, state.matchLimitReached ? limit : undefined);
}

function executeRipgrep(
	rgPath: string,
	input: GrepExecutionInput,
	formatState: GrepFormatState,
	signal?: AbortSignal,
): Promise<AgentToolResult<GrepToolDetails | undefined>> {
	return new Promise((resolve, reject) => {
		const child = spawn(rgPath, buildRipgrepArgs(input), { stdio: ["ignore", "pipe", "pipe"] });
		const rl = createInterface({ input: child.stdout });
		const state: RipgrepCollectionState = {
			stderr: "",
			matchCount: 0,
			matchLimitReached: false,
			aborted: false,
			killedDueToLimit: false,
			matches: [],
		};
		const cleanup = (): void => {
			rl.close();
			signal?.removeEventListener("abort", onAbort);
		};
		const stopChild = (dueToLimit = false): void => {
			if (child.killed) return;
			state.killedDueToLimit = dueToLimit;
			child.kill();
		};
		const onAbort = (): void => {
			state.aborted = true;
			stopChild();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stderr.on("data", (chunk) => {
			state.stderr += chunk.toString();
		});
		rl.on("line", (line) => collectRipgrepLine(line, state, input.limit, stopChild));
		child.on("error", (error) => {
			cleanup();
			reject(new Error(`Failed to run ripgrep: ${error.message}`));
		});
		child.on("close", (code) => {
			cleanup();
			void finishRipgrepExecution(code, state, formatState, input.limit).then(resolve, reject);
		});
	});
}

async function executeGrep(
	operations: ToolOperations,
	cwd: string,
	input: GrepToolInput,
	signal?: AbortSignal,
): Promise<AgentToolResult<GrepToolDetails | undefined>> {
	if (signal?.aborted) throw new Error("Operation aborted");
	const searchPath = resolveToCwd(input.path || ".", cwd);
	let isDirectory: boolean;
	try {
		isDirectory = (await operations.stat(searchPath)).isDirectory();
	} catch {
		throw new Error(`Path not found: ${searchPath}`);
	}
	const executionInput: GrepExecutionInput = {
		pattern: input.pattern,
		searchPath,
		glob: input.glob,
		ignoreCase: input.ignoreCase,
		literal: input.literal,
		context: input.context && input.context > 0 ? input.context : 0,
		limit: Math.max(1, input.limit ?? DEFAULT_LIMIT),
	};
	const formatState: GrepFormatState = {
		operations,
		searchPath,
		isDirectory,
		context: executionInput.context,
		fileCache: new Map(),
		linesTruncated: false,
	};
	if (operations.grep) return executeOperationsGrep(operations, executionInput, formatState);
	const rgPath = await ensureTool("rg", true);
	if (!rgPath) throw new Error("ripgrep (rg) is not available and could not be downloaded");
	return executeRipgrep(rgPath, executionInput, formatState, signal);
}

export type GrepToolDefinition = ToolDefinition<typeof grepSchema, GrepToolDetails | undefined>;

export function createGrepToolDefinition(operations: ToolOperations, _options?: GrepToolOptions): GrepToolDefinition {
	const ops = operations;
	const cwd = operations.cwd;
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		parameters: grepSchema,
		async execute(_toolCallId, input: GrepToolInput, signal?: AbortSignal) {
			return executeGrep(ops, cwd, input, signal);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBackendIcon(ops.getBackendInfo?.(), theme) + formatGrepCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepResult(result, options, theme, context.showImages));
			return text;
		},
	};
}

export function createGrepTool(operations: ToolOperations, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(operations, options));
}
