import { cntLines } from "../hashline-utils.ts";
import { abortIf } from "../runtime.ts";
import { _lineHashesPure, HASH_SEP } from "./hash.ts";
import {
	assertNoBarePrefix,
	type BDupWarn,
	type BoundaryDuplicateKind,
	descEdit,
	fmtMismatch,
	type HEdit,
	type NEdit,
	type RHEdit,
	valEdits,
	warnUnicodeEsc,
} from "./resolve.ts";

type LIdx = {
	fileLines: string[];
	lineStarts: number[];
	hasTerminalNewline: boolean;
};

export function buildIdx(content: string): LIdx {
	const fileLines = content.split("\n");
	const lineStarts: number[] = [];
	let offset = 0;

	for (let index = 0; index < fileLines.length; index++) {
		lineStarts.push(offset);
		offset += fileLines[index]!.length;
		if (index < fileLines.length - 1) {
			offset += 1;
		}
	}

	return {
		fileLines,
		lineStarts,
		hasTerminalNewline: content.endsWith("\n"),
	};
}

type RESpan = {
	kind: "replace";
	index: number;
	label: string;
	start: number;
	end: number;
	replacement: string;
};

interface EditConflictSide {
	index: number;
	label: string;
}

interface BoundaryWarningFormatOptions {
	kind: BoundaryDuplicateKind;
	survivingContent: string;
	matchIndex: number;
	resultLines: string[];
	resultHashes: string[];
}

interface ChangedLineRange {
	firstChangedLine: number;
	lastChangedLine: number;
}

export interface ApplyEditsResult {
	content: string;
	firstChangedLine: ChangedLineRange["firstChangedLine"] | undefined;
	lastChangedLine: ChangedLineRange["lastChangedLine"] | undefined;
	warnings?: string[];
	noopEdits?: NEdit[];
	boundaryWarnings?: BDupWarn[];
}

function assertNotEmpty(originalContent: string, result: string): void {
	if (originalContent.length > 0 && result.length === 0) {
		throw new Error("[E_WOULD_EMPTY] Cannot empty a non-empty file via edit.");
	}
}

function throwConflict(left: EditConflictSide, right: EditConflictSide, reason: string): never {
	throw new Error(
		`[E_EDIT_CONFLICT] Edit ${left.index} (${left.label}) and edit ${right.index} (${right.label}) ${reason}.`,
	);
}

function resToSpan(edit: RHEdit, index: number, content: string, lineIndex: LIdx, noopEdits: NEdit[]): RESpan | null {
	const { fileLines, lineStarts } = lineIndex;

	const startLine = edit.hash_range_inclusive[0].line;
	const endLine = edit.hash_range_inclusive[1].line;
	const originalLines = fileLines.slice(startLine - 1, endLine);
	if (
		originalLines.length === edit.content_lines.length &&
		originalLines.every((line, lineIndex) => line === edit.content_lines[lineIndex])
	) {
		noopEdits.push({
			editIndex: index,
			loc: edit.hash_range_inclusive[0].hash,
			currentContent: originalLines.join("\n"),
		});
		return null;
	}

	const label = descEdit(edit);

	if (edit.content_lines.length > 0) {
		return {
			kind: "replace",
			index,
			label,
			start: lineStarts[startLine - 1]!,
			end: lineStarts[endLine - 1]! + fileLines[endLine - 1]!.length,
			replacement: edit.content_lines.join("\n"),
		};
	}

	if (startLine === 1 && endLine === fileLines.length) {
		return {
			kind: "replace",
			index,
			label,
			start: 0,
			end: content.length,
			replacement: "",
		};
	}

	if (endLine < fileLines.length) {
		return {
			kind: "replace",
			index,
			label,
			start: lineStarts[startLine - 1]!,
			end: lineStarts[endLine]!,
			replacement: "",
		};
	}

	return {
		kind: "replace",
		index,
		label,
		start: Math.max(0, lineStarts[startLine - 1]! - 1),
		end: lineStarts[endLine - 1]! + fileLines[endLine - 1]!.length,
		replacement: "",
	};
}

function assertNoConflict(spans: RESpan[]): void {
	if (spans.length < 2) return;
	const ordered = [...spans].sort(
		(left, right) => left.start - right.start || right.end - left.end || left.index - right.index,
	);
	let furthestEndSpan = ordered[0]!;
	for (let index = 1; index < ordered.length; index++) {
		const current = ordered[index]!;
		if (furthestEndSpan.start < current.end && current.start < furthestEndSpan.end) {
			const [left, right] =
				furthestEndSpan.index < current.index ? [furthestEndSpan, current] : [current, furthestEndSpan];
			throwConflict(left, right, "overlap on the same original line range");
		}
		if (current.end > furthestEndSpan.end) furthestEndSpan = current;
	}
}

function resSpans(
	edits: RHEdit[],
	content: string,
	lineIndex: LIdx,
	noopEdits: NEdit[],
	signal: AbortSignal | undefined,
): RESpan[] {
	const seenSpanKeys = new Set<string>();
	const resolvedSpans: RESpan[] = [];
	for (const [index, edit] of edits.entries()) {
		abortIf(signal);
		const span = resToSpan(edit, index, content, lineIndex, noopEdits);
		if (!span) {
			continue;
		}

		const spanKey = `replace:${span.start}:${span.end}:${span.replacement}`;
		if (seenSpanKeys.has(spanKey)) {
			continue;
		}
		seenSpanKeys.add(spanKey);
		resolvedSpans.push(span);
	}

	assertNoConflict(resolvedSpans);
	return [...resolvedSpans].sort((left, right) => {
		if (right.end !== left.end) {
			return right.end - left.end;
		}
		return left.index - right.index;
	});
}

function assemble(content: string, spans: RESpan[], signal: AbortSignal | undefined): string {
	let result = content;
	for (const span of spans) {
		abortIf(signal);
		result = result.slice(0, span.start) + span.replacement + result.slice(span.end);
	}
	return result;
}

/**
 * Builds the boundary-duplication warning shown after an edit. A minimal header
 * is followed by a hashline-anchored window: 2 lines of context before the
 * duplicated pair, the pair itself, and 2 lines after. The window carries the
 * post-edit hashes the model needs to remove the duplicate in a follow-up
 * `replace` (no `read` round-trip required, since the hashes are current and
 * staleness is per-line). Rows are plain `HASH│content` — no annotations.
 */
export function fmtBoundaryWarning(params: BoundaryWarningFormatOptions): string {
	const header =
		params.kind === "trailing"
			? "Boundary duplication (trailing): the last replacement line duplicated the next line. This happens when `content_lines` includes a line that was already outside the replaced range. Delete the duplicate — the original line outside the range is still there."
			: "Boundary duplication (leading): the first replacement line duplicated the previous line. This happens when `content_lines` includes a line that was already outside the replaced range. Delete the duplicate — the original line outside the range is still there.";

	// Locate the adjacent duplicated pair (two identical neighboring lines). The
	// occurrence-based matchIndex usually lands inside the pair; when a file has
	// several identical lines we pick the pair nearest matchIndex so the window
	// frames the duplication this edit introduced, not an unrelated one.
	let pairStart = -1;
	let bestDist = Infinity;
	for (let i = 0; i < params.resultLines.length - 1; i++) {
		if (params.resultLines[i] === params.survivingContent && params.resultLines[i + 1] === params.survivingContent) {
			const dist = Math.abs(i - params.matchIndex);
			if (dist < bestDist) {
				bestDist = dist;
				pairStart = i;
			}
		}
	}
	if (pairStart < 0) pairStart = params.matchIndex;

	const winStart = Math.max(0, pairStart - 2);
	const winEnd = Math.min(params.resultLines.length - 1, pairStart + 3);

	const rows: string[] = [];
	for (let i = winStart; i <= winEnd; i++) {
		rows.push(`${params.resultHashes[i]}${HASH_SEP}${params.resultLines[i]}`);
	}
	return `${header}\n\n${rows.join("\n")}`;
}

export function applyEdits(
	content: string,
	edits: HEdit[],
	signal?: AbortSignal,
	precomputedHashes?: string[],
	filePath?: string,
): ApplyEditsResult {
	abortIf(signal);
	if (!edits.length)
		return {
			content,
			firstChangedLine: undefined,
			lastChangedLine: undefined,
		};

	edits = edits.map((edit) =>
		edit.content_lines.length === 1 && edit.content_lines[0] === "" ? { ...edit, content_lines: [] } : edit,
	);

	const lineIndex = buildIdx(content);
	const fileHashes = precomputedHashes ?? _lineHashesPure(content);
	const noopEdits: NEdit[] = [];
	const warnings: string[] = [];

	const { resolved, mismatches, boundaryWarnings } = valEdits(
		edits,
		lineIndex.fileLines,
		fileHashes,
		warnings,
		signal,
	);
	if (mismatches.length) {
		throw new Error(fmtMismatch(mismatches, lineIndex.fileLines, fileHashes, filePath));
	}

	assertNoBarePrefix(edits, lineIndex.fileLines, fileHashes);
	warnUnicodeEsc(edits, warnings);

	const orderedSpans = resSpans(resolved, content, lineIndex, noopEdits, signal);

	const result = assemble(content, orderedSpans, signal);
	assertNotEmpty(content, result);
	const range = changedRange(content, result);

	return {
		content: result,
		firstChangedLine: range?.firstChangedLine,
		lastChangedLine: range?.lastChangedLine,
		...(warnings.length ? { warnings } : {}),
		...(noopEdits.length ? { noopEdits } : {}),
		...(boundaryWarnings.length ? { boundaryWarnings } : {}),
	};
}

export function fmtRegion(hashes: string[], lines: string[]): string {
	if (hashes.length !== lines.length) {
		throw new Error(`fmtRegion: hashes.length (${hashes.length}) must match lines.length (${lines.length}).`);
	}
	return lines.map((line, index) => `${hashes[index]}${HASH_SEP}${line}`).join("\n");
}
function characterIndexToLineNumber(characterIndex: number, text: string): number {
	let line = 1;
	for (let index = 0; index < characterIndex && index < text.length; index++) {
		if (text[index] === "\n") line++;
	}
	return line;
}
interface ChangedRangeScan {
	original: string;
	result: string;
	firstDifferenceIndex: number;
	lastResultDifferenceIndex: number;
	firstChangedLine: number;
}

function resolveLastChangedLine(scan: ChangedRangeScan): number {
	if (scan.lastResultDifferenceIndex < scan.firstDifferenceIndex) {
		return scan.result.length === 0 ? 1 : cntLines(scan.result);
	}
	if (scan.firstDifferenceIndex === 0 && scan.original.length > 0 && scan.result.endsWith(scan.original)) {
		return scan.firstChangedLine;
	}
	return characterIndexToLineNumber(scan.lastResultDifferenceIndex + 1, scan.result);
}

export function changedRange(original: string, result: string): ChangedLineRange | null {
	if (original === result) return null;

	if (original.length === 0) {
		return {
			firstChangedLine: 1,
			lastChangedLine: cntLines(result),
		};
	}

	if (result.startsWith(original) && original.endsWith("\n")) {
		return {
			firstChangedLine: cntLines(original) + 1,
			lastChangedLine: cntLines(result),
		};
	}

	let firstDiff = 0;
	const minLen = Math.min(original.length, result.length);
	while (firstDiff < minLen && original[firstDiff] === result[firstDiff]) {
		firstDiff++;
	}
	if (firstDiff === minLen && original.length === result.length) return null;

	let lastOrig = original.length - 1;
	let lastRes = result.length - 1;
	while (lastOrig >= firstDiff && lastRes >= firstDiff && original[lastOrig] === result[lastRes]) {
		lastOrig--;
		lastRes--;
	}

	const firstChangedLine = characterIndexToLineNumber(firstDiff + 1, result);
	const lastChangedLine = resolveLastChangedLine({
		original,
		result,
		firstDifferenceIndex: firstDiff,
		lastResultDifferenceIndex: lastRes,
		firstChangedLine,
	});

	return { firstChangedLine, lastChangedLine };
}
