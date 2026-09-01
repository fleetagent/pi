import { getWordSegmenter, isWhitespaceChar, PUNCTUATION_REGEX } from "./utils.ts";

const wordSegmenter = getWordSegmenter();

/**
 * Options for word navigation functions.
 * When omitted, uses the default Intl.Segmenter word segmentation.
 */
export interface WordNavigationOptions {
	/** Custom segmenter returning word segments for the given text. */
	segment?: (text: string) => Iterable<Intl.SegmentData>;
	/** Predicate identifying atomic segments that should be treated as single units (e.g. paste markers). */
	isAtomicSegment?: (segment: string) => boolean;
}

function skipTrailingWhitespaceBackward(
	segments: Intl.SegmentData[],
	cursor: number,
	options?: WordNavigationOptions,
): number {
	let newCursor = cursor;
	while (segments.length > 0) {
		const last = segments[segments.length - 1]!;
		if (options?.isAtomicSegment?.(last.segment) || !isWhitespaceChar(last.segment)) break;
		newCursor -= segments.pop()!.segment.length;
	}
	return newCursor;
}

function moveBackwardAcrossNavigationUnit(
	segments: Intl.SegmentData[],
	cursor: number,
	options?: WordNavigationOptions,
): number {
	const last = segments[segments.length - 1];
	if (!last) return cursor;
	if (options?.isAtomicSegment?.(last.segment)) return cursor - last.segment.length;
	if (last.isWordLike) {
		const punctuationMatches = [...last.segment.matchAll(new RegExp(PUNCTUATION_REGEX, "g"))];
		const lastMatch = punctuationMatches[punctuationMatches.length - 1];
		return lastMatch
			? cursor - (last.segment.length - (lastMatch.index + lastMatch[0].length))
			: cursor - last.segment.length;
	}

	let newCursor = cursor;
	while (segments.length > 0) {
		const trailing = segments[segments.length - 1]!;
		if (options?.isAtomicSegment?.(trailing.segment) || trailing.isWordLike || isWhitespaceChar(trailing.segment)) {
			break;
		}
		newCursor -= segments.pop()!.segment.length;
	}
	return newCursor;
}

/**
 * Find the cursor position after moving one word backward from `cursor` in `text`.
 * Skips trailing whitespace, then stops at the next word/punctuation boundary.
 *
 * Pure function - does not mutate any state.
 */
export function findWordBackward(text: string, cursor: number, options?: WordNavigationOptions): number {
	if (cursor <= 0) return 0;
	const textBeforeCursor = text.slice(0, cursor);
	const segment = options?.segment;
	const segments = segment ? [...segment(textBeforeCursor)] : [...wordSegmenter.segment(textBeforeCursor)];
	const cursorAfterWhitespace = skipTrailingWhitespaceBackward(segments, cursor, options);
	return moveBackwardAcrossNavigationUnit(segments, cursorAfterWhitespace, options);
}

/**
 * Find the cursor position after moving one word forward from `cursor` in `text`.
 * Skips leading whitespace, then stops at the next word/punctuation boundary.
 *
 * Pure function - does not mutate any state.
 */
export function findWordForward(text: string, cursor: number, options?: WordNavigationOptions): number {
	if (cursor >= text.length) return text.length;

	const textAfterCursor = text.slice(cursor);
	const segmentFn = options?.segment;
	const isAtomic = options?.isAtomicSegment;
	const segments = segmentFn ? segmentFn(textAfterCursor) : wordSegmenter.segment(textAfterCursor);
	const iterator = segments[Symbol.iterator]();
	let next = iterator.next();
	let newCursor = cursor;

	// Skip leading whitespace
	while (!next.done && !isAtomic?.(next.value.segment) && isWhitespaceChar(next.value.segment)) {
		newCursor += next.value.segment.length;
		next = iterator.next();
	}

	if (next.done) return newCursor;

	if (isAtomic?.(next.value.segment)) {
		// Skip one atomic segment.
		newCursor += next.value.segment.length;
	} else if (next.value.isWordLike) {
		// Skip inside one word-like segment, preserving ASCII punctuation boundaries.
		newCursor += PUNCTUATION_REGEX.exec(next.value.segment)?.index ?? next.value.segment.length;
	} else {
		// Skip non-word non-whitespace run (punctuation)
		while (
			!next.done &&
			!isAtomic?.(next.value.segment) &&
			!next.value.isWordLike &&
			!isWhitespaceChar(next.value.segment)
		) {
			newCursor += next.value.segment.length;
			next = iterator.next();
		}
	}

	return newCursor;
}
