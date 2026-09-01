import type { AgentTool, AgentToolResult } from "@fleetagent/pi-agent-core";
import { Text } from "@fleetagent/pi-tui";
import nodePath from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import type { ToolOperations } from "./operations.ts";
import { resolveToCwd } from "./path-utils.ts";
import { formatBackendIcon, getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
});

export type LsToolInput = Static<typeof lsSchema>;

const DEFAULT_LIMIT = 500;

export interface LsToolDetails {
	truncation?: TruncationResult;
	entryLimitReached?: number;
}

export interface LsToolOptions {}

function formatLsCall(args: Partial<LsToolInput> | undefined, theme: Theme): string {
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text = `${theme.fg("toolTitle", theme.bold("ls"))} ${path === null ? invalidArg : theme.fg("accent", path)}`;
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}

function formatLsResult(
	result: AgentToolResult<LsToolDetails | undefined>,
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

	const entryLimit = result.details?.entryLimitReached;
	const truncation = result.details?.truncation;
	if (entryLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (entryLimit) warnings.push(`${entryLimit} entries limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}
interface DirectoryListingEntries {
	entries: string[];
	entryLimitReached: boolean;
}

async function readDirectoryNames(dirPath: string, operations: ToolOperations): Promise<string[]> {
	try {
		return await operations.readdir(dirPath);
	} catch (error) {
		const message =
			typeof error === "object" && error !== null && "message" in error ? String(error.message) : "undefined";
		throw new Error(`Cannot read directory: ${message}`);
	}
}

async function collectDirectoryListingEntries(
	dirPath: string,
	names: string[],
	limit: number,
	operations: ToolOperations,
): Promise<DirectoryListingEntries> {
	names.sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
	const entries: string[] = [];
	for (const name of names) {
		if (entries.length >= limit) return { entries, entryLimitReached: true };
		try {
			const entryStat = await operations.stat(nodePath.join(dirPath, name));
			entries.push(entryStat.isDirectory() ? `${name}/` : name);
		} catch {
			// Skip entries we cannot stat.
		}
	}
	return { entries, entryLimitReached: false };
}

function formatDirectoryListingResult(
	listing: DirectoryListingEntries,
	limit: number,
): AgentToolResult<LsToolDetails | undefined> {
	if (listing.entries.length === 0) {
		return { content: [{ type: "text", text: "(empty directory)" }], details: undefined };
	}
	const truncation = truncateHead(listing.entries.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	let output = truncation.content;
	const details: LsToolDetails = {};
	const notices: string[] = [];
	if (listing.entryLimitReached) {
		notices.push(`${limit} entries limit reached. Use limit=${limit * 2} for more`);
		details.entryLimitReached = limit;
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

async function buildDirectoryListing(
	input: LsToolInput,
	operations: ToolOperations,
	cwd: string,
): Promise<AgentToolResult<LsToolDetails | undefined>> {
	const dirPath = resolveToCwd(input.path || ".", cwd);
	const limit = input.limit ?? DEFAULT_LIMIT;
	try {
		await operations.access(dirPath, "exists");
	} catch {
		throw new Error(`Path not found: ${dirPath}`);
	}
	if (!(await operations.stat(dirPath)).isDirectory()) throw new Error(`Not a directory: ${dirPath}`);
	const names = await readDirectoryNames(dirPath, operations);
	return formatDirectoryListingResult(await collectDirectoryListingEntries(dirPath, names, limit, operations), limit);
}

function executeAbortableDirectoryListing(
	input: LsToolInput,
	operations: ToolOperations,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<LsToolDetails | undefined>> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}
		const onAbort = () => reject(new Error("Operation aborted"));
		signal?.addEventListener("abort", onAbort, { once: true });
		void buildDirectoryListing(input, operations, cwd).then(
			(result) => {
				signal?.removeEventListener("abort", onAbort);
				resolve(result);
			},
			(error) => {
				signal?.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export type LsToolDefinition = ToolDefinition<typeof lsSchema, LsToolDetails | undefined>;

export function createLsToolDefinition(operations: ToolOperations, _options?: LsToolOptions): LsToolDefinition {
	const ops = operations;
	const cwd = operations.cwd;
	return {
		name: "ls",
		label: "ls",
		description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: "List directory contents",
		parameters: lsSchema,
		async execute(_toolCallId, input: LsToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			return executeAbortableDirectoryListing(input, ops, cwd, signal);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBackendIcon(ops.getBackendInfo?.(), theme) + formatLsCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatLsResult(result, options, theme, context.showImages));
			return text;
		},
	};
}

export function createLsTool(operations: ToolOperations, options?: LsToolOptions): AgentTool<typeof lsSchema> {
	return wrapToolDefinition(createLsToolDefinition(operations, options));
}
