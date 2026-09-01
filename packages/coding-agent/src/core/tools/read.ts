import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { AgentTool, AgentToolResult } from "@fleetagent/pi-agent-core";
import type { Api, Model } from "@fleetagent/pi-ai";
import { Text } from "@fleetagent/pi-tui";

import { type Static, Type } from "typebox";
import { getReadmePath } from "../../config.ts";
import { keyHint, keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import { processImage } from "../../utils/image-process.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { fmtRegion } from "./hashline/apply.ts";
import { HASH_SEP, initHasher, lineHashes } from "./hashline/hash.ts";
import { visLines as hashlineVisLines } from "./hashline-utils.ts";
import type { ToolOperations } from "./operations.ts";
import { resolveReadPathAsync, resolveToCwd } from "./path-utils.ts";
import { formatBackendIcon, getTextOutput, invalidArgText, replaceTabs, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

type CompactReadClassificationKind = "docs" | "resource" | "skill" | "rule";

interface CompactReadClassification {
	kind: CompactReadClassificationKind;
	label: string;
}

const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

export interface ReadToolOperationsSelection {
	kind: "selection";
	operations: ToolOperations;
	path: string;
}

export type ReadToolOperations = ToolOperations | ReadToolOperationsSelection;

type ReadToolOperationsSelector = (absolutePath: string) => ReadToolOperations | undefined;

export interface ReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Select a backend, and optionally a canonical path, for a resolved absolute path. Defaults to the tool backend. */
	operationsForPath?: ReadToolOperationsSelector;
}

function isReadToolOperationsSelection(value: ReadToolOperations): value is ReadToolOperationsSelection {
	return "kind" in value && value.kind === "selection";
}

function getReadToolOperations(value: ReadToolOperations | undefined): ToolOperations | undefined {
	return value && isReadToolOperationsSelection(value) ? value.operations : value;
}

type ReadRenderArgs = { path?: string; file_path?: string; offset?: number; limit?: number };

function formatReadLineRange(args: ReadRenderArgs | undefined, theme: Theme): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
	return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

function formatReadCall(args: ReadRenderArgs | undefined, theme: Theme): string {
	const rawPath = str(args?.file_path ?? args?.path);
	const path = rawPath !== null ? shortenPath(rawPath) : null;
	const invalidArg = invalidArgText(theme);
	const pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
	return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}${formatReadLineRange(args, theme)}`;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
}

function getPiDocsClassification(absolutePath: string): CompactReadClassification | undefined {
	const packageRoot = dirname(getReadmePath());
	const relativePath = relative(resolvePath(packageRoot), resolvePath(absolutePath));
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return undefined;
	}

	const label = toPosixPath(relativePath);
	if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
		return { kind: "docs", label };
	}
	return undefined;
}

function getCompactReadClassification(
	args: ReadRenderArgs | undefined,
	cwd: string,
): CompactReadClassification | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	if (!rawPath) return undefined;

	const absolutePath = resolveToCwd(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	}
	if (fileName === "RULES.md") {
		return { kind: "rule", label: basename(dirname(absolutePath)) || fileName };
	}

	const docsClassification = getPiDocsClassification(absolutePath);
	if (docsClassification) return docsClassification;

	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}

	return undefined;
}

function formatCompactReadCall(
	classification: CompactReadClassification,
	args: ReadRenderArgs | undefined,
	theme: Theme,
): string {
	const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
	if (classification.kind === "skill" || classification.kind === "rule") {
		const label = classification.kind === "skill" ? "skill" : "rule";
		return (
			theme.fg("customMessageLabel", `\x1b[1m[${label}]\x1b[22m `) +
			theme.fg("customMessageText", classification.label) +
			formatReadLineRange(args, theme) +
			expandHint
		);
	}

	return (
		theme.fg("toolTitle", theme.bold(`read ${classification.kind}`)) +
		" " +
		theme.fg("accent", classification.label) +
		formatReadLineRange(args, theme) +
		expandHint
	);
}

function formatReadTruncationWarning(truncation: TruncationResult | undefined, theme: Theme): string {
	if (!truncation?.truncated) return "";
	if (truncation.firstLineExceedsLimit) {
		return `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
	}
	if (truncation.truncatedBy === "lines") {
		return `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
	}
	return `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
}

function formatReadResult(
	args: ReadRenderArgs | undefined,
	result: AgentToolResult<ReadToolDetails | undefined>,
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	cwd: string,
	isError: boolean,
): string {
	if (!options.expanded && !isError && getCompactReadClassification(args, cwd)) {
		return "";
	}

	const rawPath = str(args?.file_path ?? args?.path);
	const output = getTextOutput(result, showImages);
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
	}

	text += formatReadTruncationWarning(result.details?.truncation, theme);
	return text;
}

interface ResolvedReadTarget {
	operations: ToolOperations;
	path: string;
}

interface ReadExecutionOptions {
	input: ReadToolInput;
	defaultOperations: ToolOperations;
	cwd: string;
	operationsForPath: ReadToolOperationsSelector | undefined;
	autoResizeImages: boolean;
	model: Model<Api> | undefined;
	signal: AbortSignal | undefined;
}

interface TextReadOutputOptions {
	truncation: TruncationResult;
	allLines: string[];
	startLine: number;
	startLineDisplay: number;
	endLine: number;
	totalFileLines: number;
}

async function resolveReadTarget(options: ReadExecutionOptions): Promise<ResolvedReadTarget> {
	const absolutePath = await resolveReadPathAsync(options.input.path, options.cwd);
	const selection = options.operationsForPath?.(absolutePath);
	return {
		operations: getReadToolOperations(selection) ?? options.defaultOperations,
		path: selection && isReadToolOperationsSelection(selection) ? selection.path : absolutePath,
	};
}

async function readImageFile(
	operations: ToolOperations,
	path: string,
	mimeType: string,
	autoResizeImages: boolean,
	nonVisionImageNote: string | undefined,
): Promise<AgentToolResult<ReadToolDetails | undefined>> {
	const buffer = await operations.readFile(path);
	const processed = await processImage(buffer, mimeType, { autoResizeImages });
	if (!processed.ok) {
		let text = `Read image file [${mimeType}]\n${processed.message}`;
		if (nonVisionImageNote) text += `\n${nonVisionImageNote}`;
		return { content: [{ type: "text", text }], details: undefined };
	}
	let text = `Read image file [${processed.mimeType}]`;
	if (processed.hints.length > 0) text += `\n${processed.hints.join("\n")}`;
	if (nonVisionImageNote) text += `\n${nonVisionImageNote}`;
	return {
		content: [
			{ type: "text", text },
			{ type: "image", data: processed.data, mimeType: processed.mimeType },
		],
		details: undefined,
	};
}

function formatTextReadOutput(options: TextReadOutputOptions): AgentToolResult<ReadToolDetails | undefined> {
	const { truncation } = options;
	let text: string;
	let details: ReadToolDetails | undefined;
	if (truncation.firstLineExceedsLimit) {
		const firstLineSize = formatSize(Buffer.byteLength(options.allLines[options.startLine] ?? "", "utf-8"));
		text = `[Line ${options.startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Hashline output requires full lines; use bash for this line.]`;
		details = { truncation };
	} else if (truncation.truncated) {
		const endLineDisplay = options.startLineDisplay + truncation.outputLines - 1;
		const nextOffset = endLineDisplay + 1;
		text = truncation.content;
		if (truncation.truncatedBy === "lines") {
			text += `\n\n[Showing lines ${options.startLineDisplay}-${endLineDisplay} of ${options.totalFileLines}. Use offset=${nextOffset} to continue.]`;
		} else {
			text += `\n\n[Showing lines ${options.startLineDisplay}-${endLineDisplay} of ${options.totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
		}
		details = { truncation };
	} else if (options.endLine < options.totalFileLines) {
		const remaining = options.totalFileLines - options.endLine;
		text = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${options.endLine + 1} to continue.]`;
	} else {
		text = truncation.content;
	}
	return { content: [{ type: "text", text }], details };
}

async function readTextFile(
	operations: ToolOperations,
	path: string,
	offset: number | undefined,
	limit: number | undefined,
): Promise<AgentToolResult<ReadToolDetails | undefined>> {
	await initHasher();
	const buffer = await operations.readFile(path);
	const textContent = buffer.toString("utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const allLines = hashlineVisLines(textContent);
	const totalFileLines = allLines.length;
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	const startLineDisplay = startLine + 1;
	if (totalFileLines === 0) {
		if (startLineDisplay !== 1) throw new Error(`Offset ${offset} is beyond end of file (0 lines total)`);
		const emptyHash = (await lineHashes(textContent, path))[0] ?? "";
		return {
			content: [{ type: "text", text: `${emptyHash}${HASH_SEP}\n[File is empty. Use edit to insert content.]` }],
			details: undefined,
		};
	}
	if (startLine >= totalFileLines) {
		throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
	}
	const endLine = limit !== undefined ? Math.min(startLine + limit, totalFileLines) : totalFileLines;
	const allHashes = await lineHashes(textContent, path);
	const selectedContent = fmtRegion(allHashes.slice(startLine, endLine), allLines.slice(startLine, endLine));
	return formatTextReadOutput({
		truncation: truncateHead(selectedContent),
		allLines,
		startLine,
		startLineDisplay,
		endLine,
		totalFileLines,
	});
}

async function executeReadRequest(
	options: ReadExecutionOptions,
	isAborted: () => boolean,
): Promise<AgentToolResult<ReadToolDetails | undefined> | undefined> {
	const target = await resolveReadTarget(options);
	if (isAborted()) return undefined;
	await target.operations.access(target.path, "read");
	if (isAborted()) return undefined;
	const mimeType = target.operations.detectImageMimeType
		? await target.operations.detectImageMimeType(target.path)
		: undefined;
	const nonVisionImageNote = getNonVisionImageNote(options.model);
	const result = mimeType
		? await readImageFile(target.operations, target.path, mimeType, options.autoResizeImages, nonVisionImageNote)
		: await readTextFile(target.operations, target.path, options.input.offset, options.input.limit);
	return isAborted() ? undefined : result;
}

function executeAbortableRead(options: ReadExecutionOptions): Promise<AgentToolResult<ReadToolDetails | undefined>> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}
		let aborted = false;
		const onAbort = () => {
			aborted = true;
			reject(new Error("Operation aborted"));
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		void executeReadRequest(options, () => aborted).then(
			(result) => {
				if (result === undefined) return;
				options.signal?.removeEventListener("abort", onAbort);
				resolve(result);
			},
			(error) => {
				options.signal?.removeEventListener("abort", onAbort);
				if (!aborted) reject(error);
			},
		);
	});
}

export type ReadToolDefinition = ToolDefinition<typeof readSchema, ReadToolDetails | undefined>;

export function createReadToolDefinition(operations: ToolOperations, options?: ReadToolOptions): ReadToolDefinition {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = operations;
	const cwd = operations.cwd;
	const operationsForPath = options?.operationsForPath;
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. Text files are returned as HASH│content rows for hash-anchored editing. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		promptSnippet: "Read file contents with hashline anchors",
		promptGuidelines: [
			"Use read to examine files instead of cat or sed.",
			"For edits, copy only the 3-character HASH values into edit hash_range_inclusive; do not include HASH│ prefixes in content_lines.",
		],
		parameters: readSchema,
		async execute(_toolCallId, input: ReadToolInput, signal?: AbortSignal, _onUpdate?, ctx?) {
			return executeAbortableRead({
				input,
				defaultOperations: ops,
				cwd,
				operationsForPath,
				autoResizeImages,
				model: ctx?.model,
				signal,
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const classification = !context.expanded ? getCompactReadClassification(args, context.cwd) : undefined;
			const renderArgs = args as ReadRenderArgs | undefined;
			const rawPath = str(renderArgs?.file_path ?? renderArgs?.path);
			const displayOps = rawPath
				? (getReadToolOperations(operationsForPath?.(resolveToCwd(rawPath, cwd))) ?? ops)
				: ops;
			text.setText(
				formatBackendIcon(displayOps.getBackendInfo?.(), theme) +
					(classification ? formatCompactReadCall(classification, args, theme) : formatReadCall(args, theme)),
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				formatReadResult(context.args, result, options, theme, context.showImages, context.cwd, context.isError),
			);
			return text;
		},
	};
}

export function createReadTool(operations: ToolOperations, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(operations, options));
}
