/**
 * Shared truncation utilities for tool outputs.
 *
 * Truncation is based on two independent limits - whichever is hit first wins:
 * - Line limit (default: 2000 lines)
 * - Byte limit (default: 50KB)
 *
 * Never returns partial lines (except bash tail truncation edge case).
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
export const GREP_MAX_LINE_LENGTH = 500; // Max chars per grep match line

export type TruncationLimit = "lines" | "bytes";

export interface TruncationResult {
	/** The truncated content */
	content: string;
	/** Whether truncation occurred */
	truncated: boolean;
	/** Which limit was hit: "lines", "bytes", or null if not truncated */
	truncatedBy: TruncationLimit | null;
	/** Total number of lines in the original content */
	totalLines: number;
	/** Total number of bytes in the original content */
	totalBytes: number;
	/** Number of complete lines in the truncated output */
	outputLines: number;
	/** Number of bytes in the truncated output */
	outputBytes: number;
	/** Whether the last line was partially truncated (only for tail truncation edge case) */
	lastLinePartial: boolean;
	/** Whether the first line exceeded the byte limit (for head truncation) */
	firstLineExceedsLimit: boolean;
	/** The max lines limit that was applied */
	maxLines: number;
	/** The max bytes limit that was applied */
	maxBytes: number;
}

/** Result of truncating a single display line. */
export interface LineTruncationResult {
	text: string;
	wasTruncated: boolean;
}

export interface TruncationOptions {
	/** Maximum number of lines (default: 2000) */
	maxLines?: number;
	/** Maximum number of bytes (default: 50KB) */
	maxBytes?: number;
}

interface RuntimeBuffer {
	byteLength(content: string, encoding: "utf8"): number;
}

const runtimeBuffer = (globalThis as { Buffer?: RuntimeBuffer }).Buffer;
const nonAsciiPattern = /[^\x00-\x7f]/;
function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

function utf8ByteLength(content: string): number {
	if (runtimeBuffer) return runtimeBuffer.byteLength(content, "utf8");

	const firstNonAscii = content.search(nonAsciiPattern);
	if (firstNonAscii === -1) return content.length;

	let bytes = firstNonAscii;
	for (let i = firstNonAscii; i < content.length; i++) {
		const code = content.charCodeAt(i);
		if (code <= 0x7f) {
			bytes += 1;
		} else if (code <= 0x7ff) {
			bytes += 2;
		} else if (isHighSurrogate(code) && i + 1 < content.length) {
			const next = content.charCodeAt(i + 1);
			if (isLowSurrogate(next)) {
				bytes += 4;
				i++;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

function replaceUnpairedSurrogates(content: string): string {
	let output = "";
	for (let i = 0; i < content.length; i++) {
		const code = content.charCodeAt(i);
		if (!isHighSurrogate(code)) {
			output += isLowSurrogate(code) ? "�" : content[i];
			continue;
		}
		if (i + 1 >= content.length || !isLowSurrogate(content.charCodeAt(i + 1))) {
			output += "�";
			continue;
		}
		output += content[i] + content[i + 1];
		i++;
	}
	return output;
}

/**
 * Format bytes as human-readable size.
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}

/**
 * Truncate content from the head (keep first N lines/bytes).
 * Suitable for file reads where you want to see the beginning.
 *
 * Never returns partial lines. If first line exceeds byte limit,
 * returns empty content with firstLineExceedsLimit=true.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = utf8ByteLength(content);
	const lines = content.split("\n");
	const totalLines = lines.length;

	// Check if no truncation needed
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// Check if first line alone exceeds byte limit
	const firstLineBytes = utf8ByteLength(lines[0]);
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	// Collect complete lines that fit
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: TruncationLimit = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = utf8ByteLength(line) + (i > 0 ? 1 : 0); // +1 for newline

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	// If we exited due to line limit
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = utf8ByteLength(outputContent);

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

interface TailLineSelection {
	lines: string[];
	truncatedBy: TruncationLimit;
	lastLinePartial: boolean;
}

function collectTailLines(lines: string[], maxLines: number, maxBytes: number): TailLineSelection {
	const selectedLines: string[] = [];
	let selectedBytes = 0;
	let truncatedBy: TruncationLimit = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && selectedLines.length < maxLines; i--) {
		const line = lines[i];
		const lineBytes = utf8ByteLength(line) + (selectedLines.length > 0 ? 1 : 0);
		if (selectedBytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			if (selectedLines.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				selectedLines.unshift(truncatedLine);
				selectedBytes = utf8ByteLength(truncatedLine);
				lastLinePartial = true;
			}
			break;
		}
		selectedLines.unshift(line);
		selectedBytes += lineBytes;
	}

	if (selectedLines.length >= maxLines && selectedBytes <= maxBytes) truncatedBy = "lines";
	return { lines: selectedLines, truncatedBy, lastLinePartial };
}

/**
 * Truncate content from the tail (keep last N lines/bytes).
 * Suitable for bash output where you want to see the end (errors, final results).
 *
 * May return partial first line if the last line of original content exceeds byte limit.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = utf8ByteLength(content);
	const lines = content.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	const totalLines = lines.length;

	// Check if no truncation needed
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	const selection = collectTailLines(lines, maxLines, maxBytes);

	const outputContent = selection.lines.join("\n");
	const finalOutputBytes = utf8ByteLength(outputContent);

	return {
		content: outputContent,
		truncated: true,
		truncatedBy: selection.truncatedBy,
		totalLines,
		totalBytes,
		outputLines: selection.lines.length,
		outputBytes: finalOutputBytes,
		lastLinePartial: selection.lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

interface ReverseUtf8Character {
	start: number;
	byteLength: number;
	unpairedSurrogate: boolean;
}

function inspectPreviousUtf8Character(value: string, end: number): ReverseUtf8Character {
	const start = end - 1;
	const code = value.charCodeAt(start);
	if (isLowSurrogate(code) && start > 0) {
		const previous = value.charCodeAt(start - 1);
		if (isHighSurrogate(previous)) {
			return { start: start - 1, byteLength: 4, unpairedSurrogate: false };
		}
		return { start, byteLength: 3, unpairedSurrogate: true };
	}
	if (isHighSurrogate(code) || isLowSurrogate(code)) {
		return { start, byteLength: 3, unpairedSurrogate: true };
	}
	const byteLength = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
	return { start, byteLength, unpairedSurrogate: false };
}

/**
 * Truncate a string to fit within a byte limit (from the end).
 * Handles multi-byte UTF-8 characters correctly.
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";

	let outputBytes = 0;
	let start = str.length;
	let needsReplacement = false;
	for (let index = str.length; index > 0; ) {
		const character = inspectPreviousUtf8Character(str, index);
		if (outputBytes + character.byteLength > maxBytes) break;
		outputBytes += character.byteLength;
		start = character.start;
		needsReplacement ||= character.unpairedSurrogate;
		index = character.start;
	}

	const output = str.slice(start);
	return needsReplacement ? replaceUnpairedSurrogates(output) : output;
}

/**
 * Truncate a single line to max characters, adding [truncated] suffix.
 * Used for grep match lines.
 */
export function truncateLine(line: string, maxChars: number = GREP_MAX_LINE_LENGTH): LineTruncationResult {
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
