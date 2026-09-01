/**
 * Shared diff computation utilities for the edit tool.
 * Used by both edit.ts (for execution) and tool-execution.ts (for preview rendering).
 */

import * as Diff from "diff";
import type { ToolOperations } from "./operations.ts";
import { resolveToCwd } from "./path-utils.ts";
import { type LineEnding, stripBOM } from "./replace-diff.ts";

export { stripBOM as stripBom };

export function detectLineEnding(content: string): LineEnding {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: LineEnding): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			// Strip trailing whitespace per line
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

export interface FuzzyMatchResult {
	/** Whether a match was found */
	found: boolean;
	/** The index where the match starts (in the content that should be used for replacement) */
	index: number;
	/** Length of the matched text */
	matchLength: number;
	/** Whether fuzzy matching was used (false = exact match) */
	usedFuzzyMatch: boolean;
	/**
	 * The content to use for replacement operations.
	 * When exact match: original content. When fuzzy match: normalized content.
	 */
	contentForReplacement: string;
}

export interface Edit {
	oldText: string;
	newText: string;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * When fuzzy matching is used, the returned contentForReplacement is the
 * fuzzy-normalized version of the content (trailing whitespace stripped,
 * Unicode quotes/dashes normalized to ASCII).
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	// Try exact match first
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// Try fuzzy match - work entirely in normalized space
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// When fuzzy matching, we work in the normalized space for replacement.
	// This means the output will have normalized whitespace/quotes/dashes,
	// which is acceptable since we're fixing minor formatting differences anyway.
	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}
function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
	);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. If any edit needs
 * fuzzy matching, the operation runs in fuzzy-normalized content space to
 * preserve current single-edit behavior.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
	const baseContent = initialMatches.some((match) => match.usedFuzzyMatch)
		? normalizeForFuzzyMatch(normalizedContent)
		: normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(baseContent, edit.oldText);
		if (!matchResult.found) {
			throw getNotFoundError(path, i, normalizedEdits.length);
		}

		const occurrences = countOccurrences(baseContent, edit.oldText);
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	let newContent = baseContent;
	for (let i = matchedEdits.length - 1; i >= 0; i--) {
		const edit = matchedEdits[i];
		newContent =
			newContent.substring(0, edit.matchIndex) +
			edit.newText +
			newContent.substring(edit.matchIndex + edit.matchLength);
	}

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent };
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

interface DiffRenderState {
	output: string[];
	oldLineNumber: number;
	newLineNumber: number;
	lineNumberWidth: number;
	firstChangedLine: number | undefined;
}

function getDiffPartLines(part: Diff.Change): string[] {
	const lines = part.value.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

function appendChangedDiffLines(state: DiffRenderState, part: Diff.Change, lines: string[]): void {
	state.firstChangedLine ??= state.newLineNumber;
	for (const line of lines) {
		if (part.added) {
			const lineNumber = String(state.newLineNumber).padStart(state.lineNumberWidth, " ");
			state.output.push(`+${lineNumber} ${line}`);
			state.newLineNumber++;
		} else {
			const lineNumber = String(state.oldLineNumber).padStart(state.lineNumberWidth, " ");
			state.output.push(`-${lineNumber} ${line}`);
			state.oldLineNumber++;
		}
	}
}

function appendContextDiffLines(state: DiffRenderState, lines: string[]): void {
	for (const line of lines) {
		const lineNumber = String(state.oldLineNumber).padStart(state.lineNumberWidth, " ");
		state.output.push(` ${lineNumber} ${line}`);
		state.oldLineNumber++;
		state.newLineNumber++;
	}
}

function appendSkippedDiffLines(state: DiffRenderState, count: number): void {
	if (count <= 0) return;
	state.output.push(` ${"".padStart(state.lineNumberWidth, " ")} ...`);
	state.oldLineNumber += count;
	state.newLineNumber += count;
}

function appendContextBetweenChanges(state: DiffRenderState, lines: string[], contextLines: number): void {
	if (lines.length <= contextLines * 2) {
		appendContextDiffLines(state, lines);
		return;
	}
	const leadingLines = lines.slice(0, contextLines);
	const trailingLines = lines.slice(lines.length - contextLines);
	appendContextDiffLines(state, leadingLines);
	appendSkippedDiffLines(state, lines.length - leadingLines.length - trailingLines.length);
	appendContextDiffLines(state, trailingLines);
}

function appendContextAfterChange(state: DiffRenderState, lines: string[], contextLines: number): void {
	const shownLines = lines.slice(0, contextLines);
	appendContextDiffLines(state, shownLines);
	appendSkippedDiffLines(state, lines.length - shownLines.length);
}

function appendContextBeforeChange(state: DiffRenderState, lines: string[], contextLines: number): void {
	const skippedLines = Math.max(0, lines.length - contextLines);
	appendSkippedDiffLines(state, skippedLines);
	appendContextDiffLines(state, lines.slice(skippedLines));
}

function appendUnchangedDiffPart(
	state: DiffRenderState,
	lines: string[],
	hasLeadingChange: boolean,
	hasTrailingChange: boolean,
	contextLines: number,
): void {
	if (hasLeadingChange && hasTrailingChange) {
		appendContextBetweenChanges(state, lines, contextLines);
		return;
	}
	if (hasLeadingChange) {
		appendContextAfterChange(state, lines, contextLines);
		return;
	}
	if (hasTrailingChange) {
		appendContextBeforeChange(state, lines, contextLines);
		return;
	}
	state.oldLineNumber += lines.length;
	state.newLineNumber += lines.length;
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(oldContent: string, newContent: string, contextLines = 4): EditDiffResult {
	const parts = Diff.diffLines(oldContent, newContent);
	const maxLineNumber = Math.max(oldContent.split("\n").length, newContent.split("\n").length);
	const state: DiffRenderState = {
		output: [],
		oldLineNumber: 1,
		newLineNumber: 1,
		lineNumberWidth: String(maxLineNumber).length,
		firstChangedLine: undefined,
	};
	let lastWasChange = false;

	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		const lines = getDiffPartLines(part);
		if (part.added || part.removed) {
			appendChangedDiffLines(state, part, lines);
			lastWasChange = true;
			continue;
		}
		const nextPart = parts[index + 1];
		appendUnchangedDiffPart(
			state,
			lines,
			lastWasChange,
			index < parts.length - 1 && Boolean(nextPart.added || nextPart.removed),
			contextLines,
		);
		lastWasChange = false;
	}

	return { diff: state.output.join("\n"), firstChangedLine: state.firstChangedLine };
}

// pi-ignore noNearIdenticalDataStructures: Plain line-number diffs and hashline-anchored diffs use distinct rendering formats and evolve independently.
export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface EditDiffError {
	error: string;
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	operations: ToolOperations,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, operations.cwd);

	try {
		// Check if file exists and is readable
		try {
			await operations.access(absolutePath, "read");
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		// Read the file
		const rawContent = (await operations.readFile(absolutePath)).toString("utf-8");

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = stripBOM(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);

		// Generate the diff
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	operations: ToolOperations,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], operations);
}
