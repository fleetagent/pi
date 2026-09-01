import * as Diff from "diff";
import { _lineHashesPure, ANCHOR_LEN, HASH_SEP } from "./hashline/hash.ts";

export type LineEnding = "\r\n" | "\n";
type DiffLinePrefix = " " | "+" | "-";

export function detectEnding(content: string): LineEnding {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1 || crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function toLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreEndings(text: string, ending: LineEnding): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

interface StrippedBomContent {
	bom: string;
	text: string;
}

interface HashlineDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export function stripBOM(content: string): StrippedBomContent {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function fmtDiffLine(prefix: DiffLinePrefix, line: string, hash: string | undefined): string {
	if (hash === undefined) {
		return `${prefix}${" ".repeat(ANCHOR_LEN)}${HASH_SEP}${line}`;
	}
	return `${prefix}${hash}${HASH_SEP}${line}`;
}
interface DiffRenderState {
	output: string[];
	newLineNumber: number;
	lastPartWasChange: boolean;
	firstChangedLine: number | undefined;
}

interface DiffContextWindow {
	lines: string[];
	skippedStartLines: number;
	skippedMiddleLines: number;
}

const DIFF_ELLIPSIS_MARKER = "__ELLIPSIS__";

function getDiffDisplayLines(part: Diff.Change): string[] {
	const lines = part.value.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function isChangedPart(part: Diff.Change): boolean {
	return part.added || part.removed;
}

function renderChangedLines(
	part: Diff.Change,
	lines: string[],
	newContentHashes: string[],
	state: DiffRenderState,
): void {
	if (state.firstChangedLine === undefined) state.firstChangedLine = state.newLineNumber;
	for (const line of lines) {
		if (part.added) {
			const hash = newContentHashes[state.newLineNumber - 1];
			state.output.push(fmtDiffLine("+", line, hash));
			state.newLineNumber++;
		} else {
			state.output.push(fmtDiffLine("-", line, undefined));
		}
	}
	state.lastPartWasChange = true;
}

function selectDiffContextWindow(
	lines: string[],
	lastPartWasChange: boolean,
	nextPartIsChange: boolean,
	contextLines: number,
): DiffContextWindow {
	if (!lastPartWasChange) {
		const skippedStartLines = Math.max(0, lines.length - contextLines);
		return { lines: lines.slice(skippedStartLines), skippedStartLines, skippedMiddleLines: 0 };
	}
	if (nextPartIsChange && lines.length > contextLines * 2) {
		return {
			lines: [...lines.slice(0, contextLines), DIFF_ELLIPSIS_MARKER, ...lines.slice(-contextLines)],
			skippedStartLines: 0,
			skippedMiddleLines: lines.length - contextLines * 2,
		};
	}
	return {
		lines: lines.length > contextLines ? lines.slice(0, contextLines) : lines,
		skippedStartLines: 0,
		skippedMiddleLines: 0,
	};
}

function renderDiffContext(window: DiffContextWindow, newContentHashes: string[], state: DiffRenderState): void {
	if (window.skippedStartLines > 0) {
		state.output.push(" ...");
		state.newLineNumber += window.skippedStartLines;
	}
	for (const line of window.lines) {
		if (line === DIFF_ELLIPSIS_MARKER) {
			state.output.push(" ...");
			state.newLineNumber += window.skippedMiddleLines;
			continue;
		}
		const hash = newContentHashes[state.newLineNumber - 1];
		state.output.push(fmtDiffLine(" ", line, hash));
		state.newLineNumber++;
	}
}

export function genDiff(
	oldContent: string,
	newContent: string,
	contextLines = 2,
	newContentHashes?: string[],
	_oldHashes?: string[],
): HashlineDiffResult {
	// Run Diff.diffLines on raw content only (no hash annotations) so that
	// lines whose content is identical are never reported as changed even
	// when their hash differs due to collision resolution or position
	// tracking. Hashes are used purely for display via fmtDiffLine.
	const effectiveNewHashes = newContentHashes ?? _lineHashesPure(newContent);
	const parts = Diff.diffLines(oldContent, newContent);
	const state: DiffRenderState = {
		output: [],
		newLineNumber: 1,
		lastPartWasChange: false,
		firstChangedLine: undefined,
	};

	for (let index = 0; index < parts.length; index++) {
		const part = parts[index]!;
		const displayLines = getDiffDisplayLines(part);
		if (isChangedPart(part)) {
			renderChangedLines(part, displayLines, effectiveNewHashes, state);
			continue;
		}
		const nextPart = parts[index + 1];
		const nextPartIsChange = nextPart !== undefined && isChangedPart(nextPart);
		if (state.lastPartWasChange || nextPartIsChange) {
			const window = selectDiffContextWindow(displayLines, state.lastPartWasChange, nextPartIsChange, contextLines);
			renderDiffContext(window, effectiveNewHashes, state);
		} else {
			state.newLineNumber += displayLines.length;
		}
		state.lastPartWasChange = false;
	}

	return { diff: state.output.join("\n"), firstChangedLine: state.firstChangedLine };
}
