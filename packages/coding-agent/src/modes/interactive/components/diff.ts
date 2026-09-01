import * as Diff from "diff";
import { theme } from "../theme/theme.ts";

interface ParsedDiffLine {
	prefix: string;
	lineNum: string;
	content: string;
}

type DiffChangePrefix = "-" | "+";

interface DiffContentLine {
	lineNum: string;
	content: string;
}

interface DiffLineRun {
	lines: DiffContentLine[];
	nextIndex: number;
}

interface IntraLineDiffRender {
	removedLine: string;
	addedLine: string;
}

interface IntraLineChannelState {
	line: string;
	firstChange: boolean;
}

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): ParsedDiffLine | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * Replace tabs with spaces for consistent rendering.
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function appendChangedIntraLinePart(state: IntraLineChannelState, value: string): void {
	let changedValue = value;
	if (state.firstChange) {
		const leadingWhitespace = changedValue.match(/^(\s*)/)?.[1] || "";
		changedValue = changedValue.slice(leadingWhitespace.length);
		state.line += leadingWhitespace;
		state.firstChange = false;
	}
	if (changedValue) state.line += theme.inverse(changedValue);
}

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Uses diffWords which groups whitespace with adjacent words for cleaner highlighting.
 * Strips leading whitespace from inverse to avoid highlighting indentation.
 */
function renderIntraLineDiff(oldContent: string, newContent: string): IntraLineDiffRender {
	const wordDiff = Diff.diffWords(oldContent, newContent);

	const removed = { line: "", firstChange: true };
	const added = { line: "", firstChange: true };

	for (const part of wordDiff) {
		if (part.removed) {
			appendChangedIntraLinePart(removed, part.value);
		} else if (part.added) {
			appendChangedIntraLinePart(added, part.value);
		} else {
			removed.line += part.value;
			added.line += part.value;
		}
	}

	return { removedLine: removed.line, addedLine: added.line };
}

function collectDiffLineRun(lines: string[], startIndex: number, prefix: DiffChangePrefix): DiffLineRun {
	const run: DiffContentLine[] = [];
	let nextIndex = startIndex;
	while (nextIndex < lines.length) {
		const parsed = parseDiffLine(lines[nextIndex]);
		if (parsed?.prefix !== prefix) break;
		run.push({ lineNum: parsed.lineNum, content: parsed.content });
		nextIndex++;
	}
	return { lines: run, nextIndex };
}

function appendChangedLineBlock(
	result: string[],
	removedLines: DiffContentLine[],
	addedLines: DiffContentLine[],
): void {
	if (removedLines.length === 1 && addedLines.length === 1) {
		const removed = removedLines[0];
		const added = addedLines[0];
		const { removedLine, addedLine } = renderIntraLineDiff(replaceTabs(removed.content), replaceTabs(added.content));
		result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${removedLine}`));
		result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${addedLine}`));
		return;
	}

	for (const removed of removedLines) {
		result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${replaceTabs(removed.content)}`));
	}
	for (const added of addedLines) {
		result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${replaceTabs(added.content)}`));
	}
}
export interface RenderDiffOptions {
	/** File path (unused, kept for API compatibility) */
	filePath?: string;
}

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: dim/gray
 * - Removed lines: red, with inverse on changed tokens
 * - Added lines: green, with inverse on changed tokens
 */
export function renderDiff(diffText: string, _options: RenderDiffOptions = {}): string {
	const lines = diffText.split("\n");
	const result: string[] = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);

		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			const removed = collectDiffLineRun(lines, i, "-");
			const added = collectDiffLineRun(lines, removed.nextIndex, "+");
			appendChangedLineBlock(result, removed.lines, added.lines);
			i = added.nextIndex;
		} else if (parsed.prefix === "+") {
			// Standalone added line
			result.push(theme.fg("toolDiffAdded", `+${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		} else {
			// Context line
			result.push(theme.fg("toolDiffContext", ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		}
	}

	return result.join("\n");
}
