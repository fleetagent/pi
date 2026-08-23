import { Worker } from "node:worker_threads";
import type { AgentTool } from "@fleetagent/pi-agent-core";
import { StringEnum } from "@fleetagent/pi-ai";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { STRUCTURED_RESPONSE_INTERNAL_CUSTOM_TYPE } from "../messages.ts";
import type { ReadonlySession } from "../session/session.ts";
import type { SessionEntry } from "../session/types.ts";
import { abortIf } from "./runtime.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, truncateLine } from "./truncate.ts";

const DEFAULT_SEARCH_RESULTS = 20;
const MAX_SEARCH_RESULTS = 50;
const MAX_CONTEXT_LINES = 5;
const MAX_PATTERN_LENGTH = 1000;
const MAX_DISPLAY_LINE_LENGTH = 500;
const MAX_SEARCH_LINE_LENGTH = 10_000;
const MAX_SEARCH_BYTES = 5 * 1024 * 1024;
const MAX_SEARCH_LINES = 100_000;
const MAX_ENTRY_SERIALIZATION_BYTES = 5 * 1024 * 1024;
const REGEX_TIMEOUT_MS = 1000;

const REGEX_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
try {
  const expression = new RegExp(workerData.pattern, workerData.ignoreCase ? "iu" : "u");
  const indexes = [];
  for (let index = 0; index < workerData.lines.length; index++) {
    if (expression.test(workerData.lines[index])) indexes.push(index);
  }
  parentPort.postMessage({ indexes });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
`;

const sessionSearchSchema = Type.Object({
	pattern: Type.String({
		description:
			"JavaScript regular expression to search for, without / delimiters; use fixedStrings for literal matching",
		maxLength: MAX_PATTERN_LENGTH,
	}),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Perform case-insensitive matching, like grep -i" })),
	fixedStrings: Type.Optional(
		Type.Boolean({ description: "Treat pattern as a literal string instead of a regular expression, like grep -F" }),
	),
	beforeContext: Type.Optional(
		Type.Integer({
			description: `Context lines before each match (default 0, max ${MAX_CONTEXT_LINES}), like grep -B`,
			minimum: 0,
			maximum: MAX_CONTEXT_LINES,
		}),
	),
	afterContext: Type.Optional(
		Type.Integer({
			description: `Context lines after each match (default 0, max ${MAX_CONTEXT_LINES}), like grep -A`,
			minimum: 0,
			maximum: MAX_CONTEXT_LINES,
		}),
	),
	maxResults: Type.Optional(
		Type.Integer({
			description: `Maximum matching lines to return (default ${DEFAULT_SEARCH_RESULTS}, max ${MAX_SEARCH_RESULTS})`,
			minimum: 1,
			maximum: MAX_SEARCH_RESULTS,
		}),
	),
	scope: Type.Optional(
		StringEnum(["branch", "all"] as const, {
			description: "Search the current branch ancestry (default) or every branch in the active session",
		}),
	),
});

const sessionEntryGetSchema = Type.Object({
	entryId: Type.String({
		description: "Exact session entry ID returned by session_search or another session API",
		minLength: 1,
	}),
});

export type SessionSearchToolInput = Static<typeof sessionSearchSchema>;
export type SessionEntryGetToolInput = Static<typeof sessionEntryGetSchema>;
export type SessionSearchScope = "branch" | "all";

export interface SessionSearchMatch {
	entryId: string;
	entryType: string;
	role?: string;
	timestamp: string;
	lineNumber: number;
	line: string;
}

export interface SessionSearchToolDetails {
	pattern: string;
	ignoreCase: boolean;
	fixedStrings: boolean;
	scope: SessionSearchScope;
	matchCount: number;
	returnedMatchCount: number;
	matches: SessionSearchMatch[];
	scannedEntries: number;
	scannedLines: number;
	scannedBytes: number;
	scanTruncated: boolean;
	outputTruncated: boolean;
}

export interface SessionEntryGetToolDetails {
	entryId: string;
	entryType: string;
	onCurrentBranch: boolean;
	outputTruncated: boolean;
}

interface SearchDocument {
	entry: SessionEntry;
	role?: string;
	lines: string[];
	bytes: number;
	truncated: boolean;
	limitReached: boolean;
}

interface SearchLine {
	document: SearchDocument;
	lineIndex: number;
}

interface SearchCorpus {
	lines: SearchLine[];
	scannedEntries: number;
	scannedBytes: number;
	truncated: boolean;
}

interface CollectedMatch extends SessionSearchMatch {
	contextBefore: Array<{ lineNumber: number; line: string }>;
	contextAfter: Array<{ lineNumber: number; line: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeImageData(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((child) => sanitizeImageData(child));
	if (!isRecord(value)) return value;
	const result: Record<string, unknown> = {};
	const imageDataLength = value.type === "image" && typeof value.data === "string" ? value.data.length : undefined;
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		const child = value[key];
		result[key] =
			imageDataLength !== undefined && key === "data"
				? `[base64 image data omitted: ${imageDataLength} chars]`
				: sanitizeImageData(child);
	}
	return result;
}

function estimateSerializedBytes(value: unknown, limit: number, seen = new Set<object>()): number {
	if (typeof value === "string") return Buffer.byteLength(value, "utf8") * 6 + 2;
	if (typeof value !== "object" || value === null) return Buffer.byteLength(String(value), "utf8");
	if (seen.has(value)) return 0;
	seen.add(value);
	let total = 2;
	if (Array.isArray(value)) {
		for (const child of value) {
			total += estimateSerializedBytes(child, limit - total, seen) + 1;
			if (total > limit) return total;
		}
	} else if (isRecord(value)) {
		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			total += Buffer.byteLength(key, "utf8") * 6 + estimateSerializedBytes(value[key], limit - total, seen) + 4;
			if (total > limit) return total;
		}
	}
	return total;
}

interface BoundedLineCollector {
	lines: string[];
	bytes: number;
	encounteredLines: number;
	truncated: boolean;
	limitReached: boolean;
	appendLine(line: string): boolean;
	omitOversizedLine(): boolean;
	appendText(text: string): boolean;
}

function createBoundedLineCollector(maxLines: number, maxBytes: number): BoundedLineCollector {
	const collector: BoundedLineCollector = {
		lines: [],
		bytes: 0,
		encounteredLines: 0,
		truncated: false,
		limitReached: false,
		appendLine(line) {
			if (line.length > MAX_SEARCH_LINE_LENGTH) return collector.omitOversizedLine();
			const lineBytes = Buffer.byteLength(line, "utf8") + 1;
			if (collector.encounteredLines >= maxLines || collector.bytes + lineBytes > maxBytes) {
				collector.truncated = true;
				collector.limitReached = true;
				return false;
			}
			collector.lines.push(line);
			collector.bytes += lineBytes;
			collector.encounteredLines++;
			return true;
		},
		omitOversizedLine() {
			const budgetBytes = MAX_SEARCH_LINE_LENGTH * 4 + 1;
			if (collector.encounteredLines >= maxLines || collector.bytes + budgetBytes > maxBytes) {
				collector.truncated = true;
				collector.limitReached = true;
				return false;
			}
			collector.bytes += budgetBytes;
			collector.encounteredLines++;
			collector.truncated = true;
			return true;
		},
		appendText(text) {
			if (text.length === 0) return collector.appendLine("");
			let start = 0;
			while (start < text.length) {
				const windowEnd = Math.min(text.length, start + MAX_SEARCH_LINE_LENGTH + 1);
				const window = text.slice(start, windowEnd);
				const lineFeed = window.indexOf("\n");
				const carriageReturn = window.indexOf("\r");
				const candidates = [lineFeed, carriageReturn].filter((index) => index >= 0);
				if (candidates.length === 0) {
					if (window.length > MAX_SEARCH_LINE_LENGTH) {
						if (!collector.omitOversizedLine()) return false;
						if (windowEnd < text.length) collector.limitReached = true;
						return windowEnd === text.length;
					}
					return collector.appendLine(window);
				}
				const separatorIndex = Math.min(...candidates);
				if (!collector.appendLine(window.slice(0, separatorIndex))) return false;
				const separatorPosition = start + separatorIndex;
				start =
					separatorPosition + (text[separatorPosition] === "\r" && text[separatorPosition + 1] === "\n" ? 2 : 1);
			}
			return true;
		},
	};
	return collector;
}

function appendSearchValue(
	collector: BoundedLineCollector,
	value: unknown,
	seen = new Set<object>(),
	label?: string,
): boolean {
	if (label !== undefined && !collector.appendLine(`${label}:`)) return false;
	if (typeof value === "string") return collector.appendText(value);
	if (typeof value !== "object" || value === null) return collector.appendLine(String(value));
	if (seen.has(value)) return collector.appendLine("[circular value omitted]");
	seen.add(value);
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			if (!appendSearchValue(collector, value[index], seen, `[${index}]`)) return false;
		}
		return true;
	}
	if (!isRecord(value)) return collector.appendLine(String(value));
	if (value.type === "image" && typeof value.data === "string") {
		return collector.appendLine(
			`[image ${typeof value.mimeType === "string" ? value.mimeType : "unknown"} data omitted: ${value.data.length} chars]`,
		);
	}
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		if (!appendSearchValue(collector, value[key], seen, key)) return false;
	}
	return true;
}

function appendContentLines(collector: BoundedLineCollector, content: unknown): void {
	if (typeof content === "string") {
		collector.appendText(content);
		return;
	}
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (collector.limitReached) break;
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") {
			collector.appendText(block.text);
		} else if (block.type === "thinking" && typeof block.thinking === "string") {
			collector.appendLine("thinking:");
			collector.appendText(block.thinking);
		} else if (block.type === "toolCall") {
			collector.appendLine(`tool_call: ${typeof block.name === "string" ? block.name : "unknown"}`);
			if (block.arguments !== undefined) appendSearchValue(collector, block.arguments);
		} else if (block.type === "image") {
			collector.appendLine(`[image ${typeof block.mimeType === "string" ? block.mimeType : "unknown"} omitted]`);
		}
	}
}

function createSearchDocument(entry: SessionEntry, maxLines: number, maxBytes: number): SearchDocument | undefined {
	const collector = createBoundedLineCollector(maxLines, maxBytes);
	const finish = (role?: string): SearchDocument => ({
		entry,
		role,
		lines: collector.lines,
		bytes: collector.bytes,
		truncated: collector.truncated,
		limitReached: collector.limitReached,
	});
	if (entry.type === "message") {
		const message = entry.message;
		const role = message.role;
		if (role === "bashExecution" && message.excludeFromContext) return undefined;
		if (role === "custom" && message.customType === STRUCTURED_RESPONSE_INTERNAL_CUSTOM_TYPE) return undefined;
		collector.appendLine(`role: ${role}`);
		if (role === "user" || role === "assistant" || role === "toolResult" || role === "custom") {
			if (role === "toolResult") collector.appendLine(`tool_name: ${message.toolName}`);
			if (role === "custom") collector.appendLine(`custom_type: ${message.customType}`);
			appendContentLines(collector, message.content);
		} else if (role === "bashExecution") {
			collector.appendLine("command:");
			collector.appendText(message.command);
			collector.appendLine("output:");
			collector.appendText(message.output);
		} else if (role === "branchSummary" || role === "compactionSummary") {
			collector.appendText(message.summary);
		}
		return finish(role);
	}

	switch (entry.type) {
		case "compaction":
			collector.appendLine("compaction summary:");
			collector.appendText(entry.summary);
			return finish();
		case "branch_summary":
			collector.appendLine("branch summary:");
			collector.appendText(entry.summary);
			return finish();
		case "custom_message":
			if (entry.customType === STRUCTURED_RESPONSE_INTERNAL_CUSTOM_TYPE) return undefined;
			collector.appendLine(`custom_type: ${entry.customType}`);
			appendContentLines(collector, entry.content);
			return finish("custom");
		case "thinking_level_change":
			collector.appendLine(`thinking_level: ${entry.thinkingLevel}`);
			return finish();
		case "model_change":
			collector.appendLine(`model: ${entry.provider}/${entry.modelId}`);
			return finish();
		case "label":
			collector.appendLine(`label target: ${entry.targetId}`);
			collector.appendLine(`label: ${entry.label ?? "(cleared)"}`);
			return finish();
		case "session_info":
			collector.appendLine(`session_name: ${entry.name ?? ""}`);
			return finish();
		case "custom":
			return undefined;
	}
}

function containsToolCall(entry: SessionEntry, toolCallId: string): boolean {
	return (
		entry.type === "message" &&
		entry.message.role === "assistant" &&
		entry.message.content.some((block) => block.type === "toolCall" && block.id === toolCallId)
	);
}

function buildSearchCorpus(entries: SessionEntry[], toolCallId: string, signal?: AbortSignal): SearchCorpus {
	const searchLines: SearchLine[] = [];
	let scannedEntries = 0;
	let scannedBytes = 0;
	let truncated = false;
	for (const entry of entries) {
		abortIf(signal);
		if (containsToolCall(entry, toolCallId)) continue;
		const document = createSearchDocument(
			entry,
			MAX_SEARCH_LINES - searchLines.length,
			MAX_SEARCH_BYTES - scannedBytes,
		);
		if (!document) continue;
		for (let lineIndex = 0; lineIndex < document.lines.length; lineIndex++) {
			searchLines.push({ document, lineIndex });
		}
		if (document.lines.length > 0) scannedEntries++;
		scannedBytes += document.bytes;
		truncated ||= document.truncated;
		if (document.limitReached) break;
	}
	return { lines: searchLines, scannedEntries, scannedBytes, truncated };
}

function validateRegex(pattern: string, ignoreCase: boolean): void {
	try {
		new RegExp(pattern, ignoreCase ? "iu" : "u");
	} catch (error) {
		throw new Error(
			`Invalid session_search regular expression: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function findFixedStringMatchIndexes(lines: string[], pattern: string, ignoreCase: boolean): number[] {
	const expected = ignoreCase ? pattern.toLowerCase() : pattern;
	const indexes: number[] = [];
	for (let index = 0; index < lines.length; index++) {
		if ((ignoreCase ? lines[index].toLowerCase() : lines[index]).includes(expected)) indexes.push(index);
	}
	return indexes;
}

function findRegexMatchIndexes(
	lines: string[],
	pattern: string,
	ignoreCase: boolean,
	signal?: AbortSignal,
): Promise<number[]> {
	validateRegex(pattern, ignoreCase);
	abortIf(signal);
	return new Promise((resolve, reject) => {
		const worker = new Worker(REGEX_WORKER_SOURCE, {
			eval: true,
			workerData: { lines, pattern, ignoreCase },
		});
		let settled = false;
		const cleanup = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			void worker.terminate();
		};
		const succeed = (indexes: number[]) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(indexes);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = () => fail(new Error("Operation aborted"));
		const timeout = setTimeout(
			() => fail(new Error(`session_search regular expression exceeded the ${REGEX_TIMEOUT_MS}ms safety limit`)),
			REGEX_TIMEOUT_MS,
		);
		timeout.unref?.();
		signal?.addEventListener("abort", onAbort, { once: true });
		worker.once("message", (message: unknown) => {
			if (!isRecord(message)) {
				fail(new Error("session_search regex worker returned an invalid response"));
				return;
			}
			if (typeof message.error === "string") {
				fail(new Error(`Invalid session_search regular expression: ${message.error}`));
				return;
			}
			if (!Array.isArray(message.indexes) || !message.indexes.every((index) => Number.isSafeInteger(index))) {
				fail(new Error("session_search regex worker returned invalid match indexes"));
				return;
			}
			succeed(message.indexes as number[]);
		});
		worker.once("error", fail);
		worker.once("exit", (code) => {
			if (!settled) fail(new Error(`session_search regex worker exited before returning matches (code ${code})`));
		});
	});
}

function collectMatches(
	corpus: SearchCorpus,
	indexes: number[],
	beforeContext: number,
	afterContext: number,
): CollectedMatch[] {
	return indexes.map((index) => {
		const searchLine = corpus.lines[index];
		const { document, lineIndex } = searchLine;
		const entry = document.entry;
		return {
			entryId: entry.id,
			entryType: entry.type,
			role: document.role,
			timestamp: entry.timestamp,
			lineNumber: lineIndex + 1,
			line: document.lines[lineIndex],
			contextBefore: document.lines
				.slice(Math.max(0, lineIndex - beforeContext), lineIndex)
				.map((line, contextIndex) => ({
					lineNumber: Math.max(0, lineIndex - beforeContext) + contextIndex + 1,
					line,
				})),
			contextAfter: document.lines
				.slice(lineIndex + 1, lineIndex + 1 + afterContext)
				.map((line, contextIndex) => ({ lineNumber: lineIndex + contextIndex + 2, line })),
		};
	});
}

function entryHeader(match: CollectedMatch): string {
	const role = match.role ? ` role=${match.role}` : "";
	return `entry ${match.entryId} type=${match.entryType}${role} timestamp=${match.timestamp}`;
}

function displayLine(line: string): string {
	return truncateLine(line, MAX_DISPLAY_LINE_LENGTH).text;
}

function formatMatches(
	matches: CollectedMatch[],
	totalMatches: number,
	maxResults: number,
	scanTruncated: boolean,
): string {
	const blocks = matches.map((match) => {
		const lines = [entryHeader(match)];
		for (const context of match.contextBefore) lines.push(`  ${context.lineNumber}-${displayLine(context.line)}`);
		lines.push(`> ${match.lineNumber}:${displayLine(match.line)}`);
		for (const context of match.contextAfter) lines.push(`  ${context.lineNumber}-${displayLine(context.line)}`);
		return lines.join("\n");
	});
	if (blocks.length === 0) blocks.push("No matching session entries found.");
	if (totalMatches > maxResults) {
		blocks.push(
			`[Showing ${matches.length} of ${totalMatches} matching lines. Refine the pattern or raise maxResults.]`,
		);
	}
	if (scanTruncated) {
		blocks.push(
			`[Session search input was bounded at ${MAX_SEARCH_LINES} lines, ${MAX_SEARCH_BYTES} bytes, and ${MAX_SEARCH_LINE_LENGTH} characters per line. Results may be incomplete.]`,
		);
	}
	return blocks.join("\n\n");
}

function truncateToolOutput(output: string): { text: string; truncated: boolean } {
	const initial = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!initial.truncated) return { text: output, truncated: false };
	const notice = "\n\n[Session tool output truncated. Refine the request.]";
	const reserved = truncateHead(output, {
		maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(notice, "utf8"),
		maxLines: DEFAULT_MAX_LINES - 2,
	});
	return { text: `${reserved.content}${notice}`, truncated: true };
}

function projectEntryForModel(entry: SessionEntry): unknown | undefined {
	if (entry.type === "custom") return undefined;
	if (entry.type === "custom_message") {
		if (entry.customType === STRUCTURED_RESPONSE_INTERNAL_CUSTOM_TYPE) return undefined;
		const { details: _details, ...visible } = entry;
		return visible;
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		const { details: _details, ...visible } = entry;
		return visible;
	}
	if (entry.type !== "message") return entry;
	const message = entry.message;
	if (message.role === "bashExecution") {
		if (message.excludeFromContext) return undefined;
		const { fullOutputPath: _fullOutputPath, ...visibleMessage } = message;
		return { ...entry, message: visibleMessage };
	}
	if (message.role === "toolResult") {
		const { details: _details, ...visibleMessage } = message;
		return { ...entry, message: visibleMessage };
	}
	if (message.role === "custom") {
		if (message.customType === STRUCTURED_RESPONSE_INTERNAL_CUSTOM_TYPE) return undefined;
		const { details: _details, ...visibleMessage } = message;
		return { ...entry, message: visibleMessage };
	}
	return entry;
}

export function createSessionSearchToolDefinition(
	session: ReadonlySession,
): ToolDefinition<typeof sessionSearchSchema, SessionSearchToolDetails> {
	return {
		name: "session_search",
		label: "session_search",
		description:
			"Search finalized entries in the active session using a JavaScript regular expression by default, with grep-like case, fixed-string, context, result-limit, and branch-scope options. Searches the current branch by default, including history omitted from model context by compaction. Hidden extension state and context-excluded bash output are not searched. Input and output are bounded.",
		promptSnippet: "Search finalized entries in the active session history with a regular expression",
		promptGuidelines: [
			"Use session_search when exact earlier messages, decisions, identifiers, or tool output may have been omitted by compaction; use session_entry_get with a returned entry ID when the exact model-visible entry is needed.",
		],
		parameters: sessionSearchSchema,
		executionMode: "sequential",
		async execute(
			toolCallId,
			{
				pattern,
				ignoreCase = false,
				fixedStrings = false,
				beforeContext = 0,
				afterContext = 0,
				maxResults = DEFAULT_SEARCH_RESULTS,
				scope = "branch",
			}: SessionSearchToolInput,
			signal,
		) {
			abortIf(signal);
			const entries = scope === "all" ? session.getEntries() : session.getBranch();
			const corpus = buildSearchCorpus(entries, toolCallId, signal);
			const lines = corpus.lines.map(({ document, lineIndex }) => document.lines[lineIndex]);
			const matchIndexes = fixedStrings
				? findFixedStringMatchIndexes(lines, pattern, ignoreCase)
				: await findRegexMatchIndexes(lines, pattern, ignoreCase, signal);
			abortIf(signal);
			const matches = collectMatches(corpus, matchIndexes.slice(0, maxResults), beforeContext, afterContext);
			const output = truncateToolOutput(formatMatches(matches, matchIndexes.length, maxResults, corpus.truncated));
			return {
				content: [{ type: "text", text: output.text }],
				details: {
					pattern,
					ignoreCase,
					fixedStrings,
					scope,
					matchCount: matchIndexes.length,
					returnedMatchCount: matches.length,
					matches: matches.map(({ contextBefore: _before, contextAfter: _after, ...match }) => ({
						...match,
						line: displayLine(match.line),
					})),
					scannedEntries: corpus.scannedEntries,
					scannedLines: corpus.lines.length,
					scannedBytes: corpus.scannedBytes,
					scanTruncated: corpus.truncated,
					outputTruncated: output.truncated,
				},
			};
		},
	};
}

export function createSessionEntryGetToolDefinition(
	session: ReadonlySession,
): ToolDefinition<typeof sessionEntryGetSchema, SessionEntryGetToolDetails> {
	return {
		name: "session_entry_get",
		label: "session_entry_get",
		description:
			"Fetch one exact model-visible entry by ID from the active session, including entries outside the current branch. Extension-private metadata, hidden custom entries, context-excluded bash output, and base64 image payloads are not exposed. Returns the complete JSON projection unless safety or tool-output limits require truncation.",
		promptSnippet: "Fetch an exact model-visible entry by ID from the active session",
		parameters: sessionEntryGetSchema,
		executionMode: "sequential",
		async execute(_toolCallId, { entryId }: SessionEntryGetToolInput, signal) {
			abortIf(signal);
			const entry = session.getEntry(entryId);
			if (!entry) throw new Error(`Session entry not found: ${entryId}`);
			const visibleEntry = projectEntryForModel(entry);
			if (!visibleEntry) throw new Error(`Session entry is private or context-excluded: ${entryId}`);
			const sanitizedEntry = sanitizeImageData(visibleEntry);
			if (estimateSerializedBytes(sanitizedEntry, MAX_ENTRY_SERIALIZATION_BYTES) > MAX_ENTRY_SERIALIZATION_BYTES) {
				throw new Error(
					`Session entry exceeds the ${MAX_ENTRY_SERIALIZATION_BYTES}-byte serialization safety limit: ${entryId}`,
				);
			}
			const onCurrentBranch = session.getBranch().some((candidate) => candidate.id === entryId);
			const output = truncateToolOutput(`Session entry ${entryId}:\n${JSON.stringify(sanitizedEntry)}`);
			return {
				content: [{ type: "text", text: output.text }],
				details: {
					entryId,
					entryType: entry.type,
					onCurrentBranch,
					outputTruncated: output.truncated,
				},
			};
		},
	};
}

export function createSessionSearchTool(session: ReadonlySession): AgentTool<typeof sessionSearchSchema> {
	return wrapToolDefinition(createSessionSearchToolDefinition(session));
}

export function createSessionEntryGetTool(session: ReadonlySession): AgentTool<typeof sessionEntryGetSchema> {
	return wrapToolDefinition(createSessionEntryGetToolDefinition(session));
}
