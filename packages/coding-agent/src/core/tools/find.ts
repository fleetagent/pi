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
import type { ToolOperations } from "./operations.ts";
import { resolveToCwd } from "./path-utils.ts";
import { formatBackendIcon, getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

const findSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 1000;

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
}

export interface FindToolOptions {}

function formatFindCall(args: FindToolInput | undefined, theme: Theme): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("find")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}

function formatFindResult(
	result: AgentToolResult<FindToolDetails | undefined>,
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}

	const resultLimit = result.details?.resultLimitReached;
	const truncation = result.details?.truncation;
	if (resultLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (resultLimit) warnings.push(`${resultLimit} results limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

type FindExecutionResult = AgentToolResult<FindToolDetails | undefined>;

interface FindExecutionRequest {
	operations: ToolOperations;
	cwd: string;
	pattern: string;
	searchDir: string | undefined;
	limit: number | undefined;
	signal: AbortSignal | undefined;
}

type RegisterFindChildStop = (stop: () => void) => void;

function throwIfFindAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

function noFindResults(): FindExecutionResult {
	return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
}

function formatFindMatches(paths: string[], limit: number, includeRefineHint: boolean): FindExecutionResult {
	const resultLimitReached = paths.length >= limit;
	const truncation = truncateHead(paths.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;
	const details: FindToolDetails = {};
	const notices: string[] = [];
	if (resultLimitReached) {
		notices.push(
			includeRefineHint
				? `${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`
				: `${limit} results limit reached`,
		);
		details.resultLimitReached = limit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
	return {
		content: [{ type: "text", text: output }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

function relativizeGlobMatches(paths: string[], searchPath: string): string[] {
	return paths.map((matchedPath) => {
		if (matchedPath.startsWith(searchPath)) return toPosixPath(matchedPath.slice(searchPath.length + 1));
		return toPosixPath(path.relative(searchPath, matchedPath));
	});
}

async function executeOperationsFind(
	request: FindExecutionRequest,
	searchPath: string,
	effectiveLimit: number,
): Promise<FindExecutionResult> {
	try {
		await request.operations.access(searchPath, "exists");
	} catch {
		throw new Error(`Path not found: ${searchPath}`);
	}
	throwIfFindAborted(request.signal);
	if (!request.operations.glob) throw new Error("Glob operation is unavailable");
	const results = await request.operations.glob(request.pattern, searchPath, {
		ignore: ["**/node_modules/**", "**/.git/**"],
		limit: effectiveLimit,
	});
	throwIfFindAborted(request.signal);
	if (results.length === 0) return noFindResults();
	return formatFindMatches(relativizeGlobMatches(results, searchPath), effectiveLimit, false);
}

function buildFdArguments(pattern: string, searchPath: string, limit: number): string[] {
	const args = ["--glob", "--color=never", "--hidden", "--no-require-git", "--max-results", String(limit)];
	let effectivePattern = pattern;
	if (pattern.includes("/")) {
		args.push("--full-path");
		if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
			effectivePattern = `**/${pattern}`;
		}
	}
	args.push("--", effectivePattern, searchPath);
	return args;
}

function relativizeFdMatches(lines: string[], searchPath: string): string[] {
	const relativized: string[] = [];
	for (const rawLine of lines) {
		const line = rawLine.replace(/\r$/, "").trim();
		if (!line) continue;
		const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
		let relativePath = line;
		if (line.startsWith(searchPath)) {
			relativePath = line.slice(searchPath.length + 1);
		} else {
			relativePath = path.relative(searchPath, line);
		}
		if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
		relativized.push(toPosixPath(relativePath));
	}
	return relativized;
}

function executeFdFind(
	fdPath: string,
	request: FindExecutionRequest,
	searchPath: string,
	effectiveLimit: number,
	registerStop: RegisterFindChildStop,
): Promise<FindExecutionResult> {
	return new Promise((resolveFind, rejectFind) => {
		const child = spawn(fdPath, buildFdArguments(request.pattern, searchPath, effectiveLimit), {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const rl = createInterface({ input: child.stdout });
		let stderr = "";
		const lines: string[] = [];
		registerStop(() => {
			if (!child.killed) child.kill();
		});
		const cleanup = (): void => rl.close();
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		rl.on("line", (line) => lines.push(line));
		child.on("error", (error) => {
			cleanup();
			rejectFind(new Error(`Failed to run fd: ${error.message}`));
		});
		child.on("close", (code) => {
			cleanup();
			if (request.signal?.aborted) {
				rejectFind(new Error("Operation aborted"));
				return;
			}
			const output = lines.join("\n");
			if (code !== 0 && !output) {
				rejectFind(new Error(stderr.trim() || `fd exited with code ${code}`));
				return;
			}
			if (!output) {
				resolveFind(noFindResults());
				return;
			}
			resolveFind(formatFindMatches(relativizeFdMatches(lines, searchPath), effectiveLimit, true));
		});
	});
}

async function dispatchFindExecution(
	request: FindExecutionRequest,
	registerStop: RegisterFindChildStop,
): Promise<FindExecutionResult> {
	const searchPath = resolveToCwd(request.searchDir || ".", request.cwd);
	const effectiveLimit = request.limit ?? DEFAULT_LIMIT;
	if (request.operations.glob) return executeOperationsFind(request, searchPath, effectiveLimit);
	const fdPath = await ensureTool("fd", true);
	throwIfFindAborted(request.signal);
	if (!fdPath) throw new Error("fd is not available and could not be downloaded");
	return executeFdFind(fdPath, request, searchPath, effectiveLimit, registerStop);
}

function executeFind(request: FindExecutionRequest): Promise<FindExecutionResult> {
	return new Promise((resolveFind, rejectFind) => {
		if (request.signal?.aborted) {
			rejectFind(new Error("Operation aborted"));
			return;
		}
		let settled = false;
		let stopChild: (() => void) | undefined;
		const settle = (complete: () => void): void => {
			if (settled) return;
			settled = true;
			request.signal?.removeEventListener("abort", onAbort);
			stopChild = undefined;
			complete();
		};
		const onAbort = (): void => {
			stopChild?.();
			settle(() => rejectFind(new Error("Operation aborted")));
		};
		request.signal?.addEventListener("abort", onAbort, { once: true });
		void dispatchFindExecution(request, (stop) => {
			stopChild = stop;
		}).then(
			(result) => settle(() => resolveFind(result)),
			(error: unknown) => {
				if (request.signal?.aborted) {
					settle(() => rejectFind(new Error("Operation aborted")));
					return;
				}
				settle(() => rejectFind(error instanceof Error ? error : new Error(String(error))));
			},
		);
	});
}

export type FindToolDefinition = ToolDefinition<typeof findSchema, FindToolDetails | undefined>;

export function createFindToolDefinition(operations: ToolOperations, _options?: FindToolOptions): FindToolDefinition {
	const ops = operations;
	const cwd = operations.cwd;
	return {
		name: "find",
		label: "find",
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: "Find files by glob pattern (respects .gitignore)",
		parameters: findSchema,
		async execute(
			_toolCallId,
			{ pattern, path: searchDir, limit }: FindToolInput,
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			return executeFind({
				operations: ops,
				cwd,
				pattern,
				searchDir,
				limit,
				signal,
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBackendIcon(ops.getBackendInfo?.(), theme) + formatFindCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFindResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createFindTool(operations: ToolOperations, options?: FindToolOptions): AgentTool<typeof findSchema> {
	return wrapToolDefinition(createFindToolDefinition(operations, options));
}
