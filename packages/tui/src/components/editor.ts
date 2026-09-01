import type {
	AutocompleteCompletion,
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
} from "../autocomplete.ts";
import { getKeybindings, type KeybindingsManager } from "../keybindings.ts";
import { decodePrintableKey, matchesKey } from "../keys.ts";
import { KillRing } from "../kill-ring.ts";
import { type Component, CURSOR_MARKER, type Focusable, type TUI } from "../tui.ts";
import { UndoStack } from "../undo-stack.ts";
import { getGraphemeSegmenter, getWordSegmenter, isWhitespaceChar, sliceByColumn, visibleWidth } from "../utils.ts";
import { findWordBackward, findWordForward } from "../word-navigation.ts";
import { SelectList, type SelectListLayoutOptions, type SelectListTheme } from "./select-list.ts";

const graphemeSegmenter = getGraphemeSegmenter();
const wordSegmenter = getWordSegmenter();

/** Regex matching paste markers like `[paste #1 +123 lines]` or `[paste #2 1234 chars]`. */
const PASTE_MARKER_REGEX = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;

/** Non-global version for single-segment testing. */
const PASTE_MARKER_SINGLE = /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/;
// pi-ignore noNearIdenticalDataStructures: Paste marker UTF-16 offsets are parser spans, distinct from terminal-cell and selection-column coordinates.
interface PasteMarkerSpan {
	start: number;
	end: number;
}

/** Check if a segment is a paste marker (i.e. was merged by segmentWithMarkers). */
function isPasteMarker(segment: string): boolean {
	return segment.length >= 10 && PASTE_MARKER_SINGLE.test(segment);
}

/**
 * A segmenter that wraps Intl.Segmenter and merges graphemes that fall
 * within paste markers into single atomic segments.  This makes cursor
 * movement, deletion, word-wrap, etc. treat paste markers as single units.
 *
 * Only markers whose numeric ID exists in `validIds` are merged.
 */
function findPasteMarkerSpans(text: string, validIds: Set<number>): PasteMarkerSpan[] {
	const markers: PasteMarkerSpan[] = [];
	for (const match of text.matchAll(PASTE_MARKER_REGEX)) {
		const id = Number.parseInt(match[1]!, 10);
		if (!validIds.has(id)) continue;
		markers.push({ start: match.index, end: match.index + match[0].length });
	}
	return markers;
}

function mergePasteMarkerSegments(
	text: string,
	baseSegments: Iterable<Intl.SegmentData>,
	markers: PasteMarkerSpan[],
): Intl.SegmentData[] {
	const result: Intl.SegmentData[] = [];
	let markerIndex = 0;
	for (const segment of baseSegments) {
		while (markerIndex < markers.length && markers[markerIndex]!.end <= segment.index) markerIndex++;
		const marker = markerIndex < markers.length ? markers[markerIndex]! : undefined;
		if (marker && segment.index >= marker.start && segment.index < marker.end) {
			if (segment.index === marker.start) {
				result.push({
					segment: text.slice(marker.start, marker.end),
					index: marker.start,
					input: text,
				});
			}
		} else {
			result.push(segment);
		}
	}
	return result;
}

function segmentWithMarkers(
	text: string,
	baseSegmenter: Intl.Segmenter,
	validIds: Set<number>,
): Iterable<Intl.SegmentData> {
	if (validIds.size === 0 || !text.includes("[paste #")) return baseSegmenter.segment(text);
	const markers = findPasteMarkerSpans(text, validIds);
	if (markers.length === 0) return baseSegmenter.segment(text);
	return mergePasteMarkerSegments(text, baseSegmenter.segment(text), markers);
}

/**
 * Represents a chunk of text for word-wrap layout.
 * Tracks both the text content and its position in the original line.
 */
export interface TextChunk {
	text: string;
	startIndex: number;
	endIndex: number;
}

interface WrapOverflowInput {
	line: string;
	maxWidth: number;
	graphemeWidth: number;
	charIndex: number;
	chunkStart: number;
	currentWidth: number;
	wrapOpportunityIndex: number;
	wrapOpportunityWidth: number;
}

interface WrapOverflowResolution {
	chunk?: TextChunk;
	chunkStart: number;
	currentWidth: number;
}

interface OversizedSegmentWrap {
	completedChunks: TextChunk[];
	chunkStart: number;
	currentWidth: number;
}

function resolveWrapOverflow(input: WrapOverflowInput): WrapOverflowResolution {
	if (
		input.wrapOpportunityIndex >= 0 &&
		input.currentWidth - input.wrapOpportunityWidth + input.graphemeWidth <= input.maxWidth
	) {
		return {
			chunk: {
				text: input.line.slice(input.chunkStart, input.wrapOpportunityIndex),
				startIndex: input.chunkStart,
				endIndex: input.wrapOpportunityIndex,
			},
			chunkStart: input.wrapOpportunityIndex,
			currentWidth: input.currentWidth - input.wrapOpportunityWidth,
		};
	}
	if (input.chunkStart < input.charIndex) {
		return {
			chunk: {
				text: input.line.slice(input.chunkStart, input.charIndex),
				startIndex: input.chunkStart,
				endIndex: input.charIndex,
			},
			chunkStart: input.charIndex,
			currentWidth: 0,
		};
	}
	return { chunkStart: input.chunkStart, currentWidth: input.currentWidth };
}

function splitOversizedSegment(grapheme: string, maxWidth: number, charIndex: number): OversizedSegmentWrap {
	const subChunks = wordWrapLine(grapheme, maxWidth);
	const completedChunks = subChunks.slice(0, -1).map((chunk) => ({
		text: chunk.text,
		startIndex: charIndex + chunk.startIndex,
		endIndex: charIndex + chunk.endIndex,
	}));
	const last = subChunks[subChunks.length - 1]!;
	return {
		completedChunks,
		chunkStart: charIndex + last.startIndex,
		currentWidth: visibleWidth(last.text),
	};
}

function findWrapOpportunityAfterWhitespace(
	currentIsWhitespace: boolean,
	next: Intl.SegmentData | undefined,
): number | undefined {
	if (!currentIsWhitespace || !next) return undefined;
	if (!isPasteMarker(next.segment) && isWhitespaceChar(next.segment)) return undefined;
	return next.index;
}

/**
 * Split a line into word-wrapped chunks.
 * Wraps at word boundaries when possible, falling back to character-level
 * wrapping for words longer than the available width.
 *
 * @param line - The text line to wrap
 * @param maxWidth - Maximum visible width per chunk
 * @param preSegmented - Optional pre-segmented graphemes (e.g. with paste-marker awareness).
 *                       When omitted the default Intl.Segmenter is used.
 * @returns Array of chunks with text and position information
 */
export function wordWrapLine(line: string, maxWidth: number, preSegmented?: Intl.SegmentData[]): TextChunk[] {
	if (!line || maxWidth <= 0) {
		return [{ text: "", startIndex: 0, endIndex: 0 }];
	}

	const lineWidth = visibleWidth(line);
	if (lineWidth <= maxWidth) {
		return [{ text: line, startIndex: 0, endIndex: line.length }];
	}

	const chunks: TextChunk[] = [];
	const segments = preSegmented ?? [...graphemeSegmenter.segment(line)];

	let currentWidth = 0;
	let chunkStart = 0;

	// Wrap opportunity: the position after the last whitespace before a non-whitespace
	// grapheme, i.e. where a line break is allowed.
	let wrapOppIndex = -1;
	let wrapOppWidth = 0;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!;
		const grapheme = seg.segment;
		const gWidth = visibleWidth(grapheme);
		const charIndex = seg.index;
		const isWs = !isPasteMarker(grapheme) && isWhitespaceChar(grapheme);

		// Resolve overflow before advancing to the current grapheme.
		if (currentWidth + gWidth > maxWidth) {
			const resolution = resolveWrapOverflow({
				line,
				maxWidth,
				graphemeWidth: gWidth,
				charIndex,
				chunkStart,
				currentWidth,
				wrapOpportunityIndex: wrapOppIndex,
				wrapOpportunityWidth: wrapOppWidth,
			});
			if (resolution.chunk) chunks.push(resolution.chunk);
			chunkStart = resolution.chunkStart;
			currentWidth = resolution.currentWidth;
			wrapOppIndex = -1;
		}

		if (gWidth > maxWidth) {
			// Keep the segment logically atomic for editing while splitting its visual layout.
			const wrapped = splitOversizedSegment(grapheme, maxWidth, charIndex);
			chunks.push(...wrapped.completedChunks);
			chunkStart = wrapped.chunkStart;
			currentWidth = wrapped.currentWidth;
			wrapOppIndex = -1;
			continue;
		}

		// Advance.
		currentWidth += gWidth;

		// Record wrap opportunity: whitespace followed by non-whitespace.
		// Multiple spaces join (no break between them); the break point is
		// after the last space before the next word.
		const next = segments[i + 1];
		const nextWrapOpportunity = findWrapOpportunityAfterWhitespace(isWs, next);
		if (nextWrapOpportunity !== undefined) {
			wrapOppIndex = nextWrapOpportunity;
			wrapOppWidth = currentWidth;
		}
	}

	// Push final chunk.
	chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });

	return chunks;
}

// Kitty CSI-u sequences for printable keys, including optional shifted/base codepoints.

/** Undo snapshot: editor text state plus the paste registry. */
interface EditorSnapshot {
	state: AutocompleteCompletion;
	pastes: Map<number, string>;
	pasteCounter: number;
}

interface LayoutLine {
	text: string;
	hasCursor: boolean;
	cursorPos?: number;
}

interface EditorRenderGeometry {
	width: number;
	paddingX: number;
	contentWidth: number;
	layoutWidth: number;
	horizontal: string;
	leftPadding: string;
	rightPadding: string;
}

export interface PasteInputResult {
	data: string;
	consumed: boolean;
}

interface RenderedEditorLine {
	displayText: string;
	visibleWidth: number;
	cursorInPadding: boolean;
}

export interface EditorCursorPosition {
	line: number;
	col: number;
}

interface EditorVisualLine {
	logicalLine: number;
	startCol: number;
	length: number;
}

interface AutocompleteRequestOptions {
	force: boolean;
	explicitTab: boolean;
}

export interface EditorTheme {
	borderColor: (str: string) => string;
	selectList: SelectListTheme;
}

export interface EditorOptions {
	paddingX?: number;
	autocompleteMaxVisible?: number;
}

type ScrollBorderDirection = "↑" | "↓";
type AutocompleteTriggerMode = "regular" | "force";
type EditorAction = "kill" | "yank" | "type-word";
type CharacterJumpDirection = "forward" | "backward";
type EditorSegmentationMode = "word" | "grapheme";

const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS = 20;

function createScrollBorder(direction: ScrollBorderDirection, hiddenLineCount: number, width: number): string {
	const availableWidth = Math.max(0, width);
	const indicator = `─── ${direction} ${hiddenLineCount} more `;
	const remaining = availableWidth - visibleWidth(indicator);
	if (remaining >= 0) return indicator + "─".repeat(remaining);

	const ellipsis = "...".slice(0, availableWidth);
	const indicatorWidth = availableWidth - visibleWidth(ellipsis);
	return sliceByColumn(indicator, 0, indicatorWidth, true) + ellipsis;
}

export class Editor implements Component, Focusable {
	private state: AutocompleteCompletion = {
		lines: [""],
		cursorLine: 0,
		cursorCol: 0,
	};

	/** Focusable interface - set by TUI when focus changes */
	focused: boolean = false;

	protected tui: TUI;
	private theme: EditorTheme;
	private paddingX: number = 0;

	// Store last render width for cursor navigation
	private lastWidth: number = 80;

	// Vertical scrolling support
	private scrollOffset: number = 0;

	// Border color (can be changed dynamically)
	public borderColor: (str: string) => string;

	// Autocomplete support
	private autocompleteProvider?: AutocompleteProvider;
	private autocompleteList?: SelectList;
	private autocompleteState: AutocompleteTriggerMode | null = null;
	private autocompletePrefix: string = "";
	private autocompleteMaxVisible: number = 5;
	private autocompleteAbort?: AbortController;
	private autocompleteDebounceTimer?: ReturnType<typeof setTimeout>;
	private autocompleteRequestTask: Promise<void> = Promise.resolve();
	private autocompleteStartToken: number = 0;
	private autocompleteRequestId: number = 0;

	// Paste tracking for large pastes
	private pastes: Map<number, string> = new Map();
	private pasteCounter: number = 0;

	// Bracketed paste mode buffering
	private pasteBuffer: string = "";
	private isInPaste: boolean = false;

	// Prompt history for up/down navigation
	private history: string[] = [];
	private historyIndex: number = -1; // -1 = not browsing, 0 = most recent, 1 = older, etc.

	// Kill ring for Emacs-style kill/yank operations
	private killRing = new KillRing();
	private lastAction: EditorAction | null = null;

	// Character jump mode
	private jumpMode: CharacterJumpDirection | null = null;

	// Preferred visual column for vertical cursor movement (sticky column)
	private preferredVisualCol: number | null = null;

	// When the cursor is snapped to the start of an atomic segment, e.g. a
	// paste marker, cursorCol no longer reflects where the cursor would have
	// landed. This field stores the pre-snap cursorCol so that the next
	// vertical move can resolve it to a visual column on whatever VL it belongs
	// to.
	private snappedFromCursorCol: number | null = null;

	// Undo support
	private undoStack = new UndoStack<EditorSnapshot>();
	public onSubmit?: (text: string) => void;
	public onChange?: (text: string) => void;
	public disableSubmit: boolean = false;

	constructor(tui: TUI, theme: EditorTheme, options: EditorOptions = {}) {
		this.tui = tui;
		this.theme = theme;
		this.borderColor = theme.borderColor;
		const paddingX = options.paddingX ?? 0;
		this.paddingX = Number.isFinite(paddingX) ? Math.max(0, Math.floor(paddingX)) : 0;
		const maxVisible = options.autocompleteMaxVisible ?? 5;
		this.autocompleteMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
	}

	/** Set of currently valid paste IDs, for marker-aware segmentation. */
	private validPasteIds(): Set<number> {
		return new Set(this.pastes.keys());
	}

	/** Segment text with paste-marker awareness, only merging markers with valid IDs. */
	private segment(text: string, mode: EditorSegmentationMode): Iterable<Intl.SegmentData> {
		return segmentWithMarkers(text, mode === "word" ? wordSegmenter : graphemeSegmenter, this.validPasteIds());
	}

	getPaddingX(): number {
		return this.paddingX;
	}

	setPaddingX(padding: number): void {
		const newPadding = Number.isFinite(padding) ? Math.max(0, Math.floor(padding)) : 0;
		if (this.paddingX !== newPadding) {
			this.paddingX = newPadding;
			this.tui.requestRender();
		}
	}

	getAutocompleteMaxVisible(): number {
		return this.autocompleteMaxVisible;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		const newMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
		if (this.autocompleteMaxVisible !== newMaxVisible) {
			this.autocompleteMaxVisible = newMaxVisible;
			this.tui.requestRender();
		}
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.cancelAutocomplete();
		this.autocompleteProvider = provider;
	}

	/**
	 * Add a prompt to history for up/down arrow navigation.
	 * Called after successful submission.
	 */
	addToHistory(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		// Don't add consecutive duplicates
		if (this.history.length > 0 && this.history[0] === trimmed) return;
		this.history.unshift(trimmed);
		// Limit history size
		if (this.history.length > 100) {
			this.history.pop();
		}
	}

	private isEditorEmpty(): boolean {
		return this.state.lines.length === 1 && this.state.lines[0] === "";
	}

	private isOnFirstVisualLine(): boolean {
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		return currentVisualLine === 0;
	}

	private isOnLastVisualLine(): boolean {
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		return currentVisualLine === visualLines.length - 1;
	}

	private navigateHistory(direction: 1 | -1): void {
		this.lastAction = null;
		if (this.history.length === 0) return;

		const newIndex = this.historyIndex - direction; // Up(-1) increases index, Down(1) decreases
		if (newIndex < -1 || newIndex >= this.history.length) return;

		// Capture state when first entering history browsing mode
		if (this.historyIndex === -1 && newIndex >= 0) {
			this.pushUndoSnapshot();
		}

		this.historyIndex = newIndex;

		if (this.historyIndex === -1) {
			// Returned to "current" state - clear editor
			this.setTextInternal("");
		} else {
			this.setTextInternal(this.history[this.historyIndex] || "");
		}
	}

	/** Internal setText that doesn't reset history state - used by navigateHistory */
	private setTextInternal(text: string): void {
		const lines = text.split("\n");
		this.state.lines = lines.length === 0 ? [""] : lines;
		this.state.cursorLine = this.state.lines.length - 1;
		this.setCursorCol(this.state.lines[this.state.cursorLine]?.length || 0);
		// Reset scroll - render() will adjust to show cursor
		this.scrollOffset = 0;

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	private getRenderGeometry(width: number): EditorRenderGeometry {
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const paddingX = Math.min(this.paddingX, maxPadding);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));
		const leftPadding = " ".repeat(paddingX);
		return {
			width,
			paddingX,
			contentWidth,
			layoutWidth,
			horizontal: this.borderColor("─"),
			leftPadding,
			rightPadding: leftPadding,
		};
	}

	private getVisibleLayoutLines(layoutLines: LayoutLine[]): LayoutLine[] {
		const maxVisibleLines = Math.max(5, Math.floor(this.tui.terminal.rows * 0.3));
		const foundCursorLineIndex = layoutLines.findIndex((line) => line.hasCursor);
		const cursorLineIndex = foundCursorLineIndex === -1 ? 0 : foundCursorLineIndex;
		if (cursorLineIndex < this.scrollOffset) {
			this.scrollOffset = cursorLineIndex;
		} else if (cursorLineIndex >= this.scrollOffset + maxVisibleLines) {
			this.scrollOffset = cursorLineIndex - maxVisibleLines + 1;
		}
		const maxScrollOffset = Math.max(0, layoutLines.length - maxVisibleLines);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScrollOffset));
		return layoutLines.slice(this.scrollOffset, this.scrollOffset + maxVisibleLines);
	}

	private renderLayoutLineCursor(
		layoutLine: LayoutLine,
		geometry: EditorRenderGeometry,
		emitCursorMarker: boolean,
	): RenderedEditorLine {
		const lineWidth = visibleWidth(layoutLine.text);
		if (!layoutLine.hasCursor || layoutLine.cursorPos === undefined) {
			return { displayText: layoutLine.text, visibleWidth: lineWidth, cursorInPadding: false };
		}
		const before = layoutLine.text.slice(0, layoutLine.cursorPos);
		const after = layoutLine.text.slice(layoutLine.cursorPos);
		const marker = emitCursorMarker ? CURSOR_MARKER : "";
		if (after.length > 0) {
			const firstGrapheme = [...this.segment(after, "grapheme")][0]?.segment || "";
			const restAfter = after.slice(firstGrapheme.length);
			return {
				displayText: `${before}${marker}\x1b[7m${firstGrapheme}\x1b[0m${restAfter}`,
				visibleWidth: lineWidth,
				cursorInPadding: false,
			};
		}
		const widthWithCursor = lineWidth + 1;
		return {
			displayText: `${before}${marker}\x1b[7m \x1b[0m`,
			visibleWidth: widthWithCursor,
			cursorInPadding: widthWithCursor > geometry.contentWidth && geometry.paddingX > 0,
		};
	}

	private renderVisibleLayoutLine(
		layoutLine: LayoutLine,
		geometry: EditorRenderGeometry,
		emitCursorMarker: boolean,
	): string {
		const rendered = this.renderLayoutLineCursor(layoutLine, geometry, emitCursorMarker);
		const padding = " ".repeat(Math.max(0, geometry.contentWidth - rendered.visibleWidth));
		const rightPadding = rendered.cursorInPadding ? geometry.rightPadding.slice(1) : geometry.rightPadding;
		return `${geometry.leftPadding}${rendered.displayText}${padding}${rightPadding}`;
	}

	private renderTopEditorBorder(geometry: EditorRenderGeometry): string {
		if (this.scrollOffset === 0) return geometry.horizontal.repeat(geometry.width);
		return this.borderColor(createScrollBorder("↑", this.scrollOffset, geometry.width));
	}

	private renderBottomEditorBorder(
		layoutLineCount: number,
		visibleLineCount: number,
		geometry: EditorRenderGeometry,
	): string {
		const linesBelow = layoutLineCount - (this.scrollOffset + visibleLineCount);
		if (linesBelow <= 0) return geometry.horizontal.repeat(geometry.width);
		return this.borderColor(createScrollBorder("↓", linesBelow, geometry.width));
	}

	private appendAutocompleteLines(result: string[], geometry: EditorRenderGeometry): void {
		if (!this.autocompleteState || !this.autocompleteList) return;
		for (const line of this.autocompleteList.render(geometry.contentWidth)) {
			const lineWidth = visibleWidth(line);
			const linePadding = " ".repeat(Math.max(0, geometry.contentWidth - lineWidth));
			result.push(`${geometry.leftPadding}${line}${linePadding}${geometry.rightPadding}`);
		}
	}

	render(width: number): string[] {
		const geometry = this.getRenderGeometry(width);
		this.lastWidth = geometry.layoutWidth;
		const layoutLines = this.layoutText(geometry.layoutWidth);
		const visibleLines = this.getVisibleLayoutLines(layoutLines);
		const result = [this.renderTopEditorBorder(geometry)];
		const emitCursorMarker = this.focused && !this.autocompleteState;
		for (const layoutLine of visibleLines) {
			result.push(this.renderVisibleLayoutLine(layoutLine, geometry, emitCursorMarker));
		}
		result.push(this.renderBottomEditorBorder(layoutLines.length, visibleLines.length, geometry));
		this.appendAutocompleteLines(result, geometry);
		return result;
	}

	private handleJumpModeInput(data: string, keybindings: KeybindingsManager): boolean {
		if (this.jumpMode === null) return false;
		if (keybindings.matches(data, "tui.editor.jumpForward") || keybindings.matches(data, "tui.editor.jumpBackward")) {
			this.jumpMode = null;
			return true;
		}
		const printable = decodePrintableKey(data) ?? (data.charCodeAt(0) >= 32 ? data : undefined);
		if (printable !== undefined) {
			const direction = this.jumpMode;
			this.jumpMode = null;
			this.jumpToChar(printable, direction);
			return true;
		}
		this.jumpMode = null;
		return false;
	}

	private handleBracketedPasteInput(data: string): PasteInputResult {
		let remainingData = data;
		if (remainingData.includes("\x1b[200~")) {
			this.isInPaste = true;
			this.pasteBuffer = "";
			remainingData = remainingData.replace("\x1b[200~", "");
		}
		if (!this.isInPaste) return { data: remainingData, consumed: false };
		this.pasteBuffer += remainingData;
		const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
		if (endIndex === -1) return { data: remainingData, consumed: true };
		const pasteContent = this.pasteBuffer.substring(0, endIndex);
		if (pasteContent.length > 0) this.handlePaste(pasteContent);
		this.isInPaste = false;
		const trailingInput = this.pasteBuffer.substring(endIndex + 6);
		this.pasteBuffer = "";
		if (trailingInput.length > 0) this.handleInput(trailingInput);
		return { data: remainingData, consumed: true };
	}

	private applySelectedAutocomplete(): boolean {
		const selected = this.autocompleteList?.getSelectedItem();
		if (!selected || !this.autocompleteProvider) return false;
		this.pushUndoSnapshot();
		this.lastAction = null;
		const result = this.autocompleteProvider.applyCompletion(
			this.state.lines,
			this.state.cursorLine,
			this.state.cursorCol,
			selected,
			this.autocompletePrefix,
		);
		this.state.lines = result.lines;
		this.state.cursorLine = result.cursorLine;
		this.setCursorCol(result.cursorCol);
		return true;
	}

	private handleAutocompleteInput(data: string, keybindings: KeybindingsManager): boolean {
		if (!this.autocompleteState || !this.autocompleteList) return false;
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.cancelAutocomplete();
			return true;
		}
		if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down")) {
			this.autocompleteList.handleInput(data);
			return true;
		}
		if (keybindings.matches(data, "tui.input.tab")) {
			if (this.applySelectedAutocomplete()) {
				this.cancelAutocomplete();
				this.onChange?.(this.getText());
			}
			return true;
		}
		if (!keybindings.matches(data, "tui.select.confirm") || !this.applySelectedAutocomplete()) return false;
		const submitCompletion = this.autocompletePrefix.startsWith("/");
		this.cancelAutocomplete();
		if (submitCompletion) return false;
		this.onChange?.(this.getText());
		return true;
	}

	private handleGlobalEditorInput(data: string, keybindings: KeybindingsManager): boolean {
		if (keybindings.matches(data, "tui.input.copy")) return true;
		if (!keybindings.matches(data, "tui.editor.undo")) return false;
		this.undo();
		return true;
	}

	private handleTabInput(data: string, keybindings: KeybindingsManager): boolean {
		if (!keybindings.matches(data, "tui.input.tab") || this.autocompleteState) return false;
		this.handleTabCompletion();
		return true;
	}

	private handleDeletionInput(data: string, keybindings: KeybindingsManager): boolean {
		if (keybindings.matches(data, "tui.editor.deleteToLineEnd")) this.deleteToEndOfLine();
		else if (keybindings.matches(data, "tui.editor.deleteToLineStart")) this.deleteToStartOfLine();
		else if (keybindings.matches(data, "tui.editor.deleteWordBackward")) this.deleteWordBackwards();
		else if (keybindings.matches(data, "tui.editor.deleteWordForward")) this.deleteWordForward();
		else if (keybindings.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace"))
			this.handleBackspace();
		else if (keybindings.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete"))
			this.handleForwardDelete();
		else return false;
		return true;
	}

	private handleKillRingInput(data: string, keybindings: KeybindingsManager): boolean {
		if (keybindings.matches(data, "tui.editor.yank")) this.yank();
		else if (keybindings.matches(data, "tui.editor.yankPop")) this.yankPop();
		else return false;
		return true;
	}

	private handleHistoryInput(data: string, keybindings: KeybindingsManager): boolean {
		let direction: 1 | -1;
		if (keybindings.matches(data, "tui.editor.historyPrevious")) direction = -1;
		else if (keybindings.matches(data, "tui.editor.historyNext")) direction = 1;
		else return false;
		this.cancelAutocomplete();
		this.navigateHistory(direction);
		return true;
	}

	private handleLineAndWordMovement(data: string, keybindings: KeybindingsManager): boolean {
		if (keybindings.matches(data, "tui.editor.cursorLineStart")) this.moveToLineStart();
		else if (keybindings.matches(data, "tui.editor.cursorLineEnd")) this.moveToLineEnd();
		else if (keybindings.matches(data, "tui.editor.cursorWordLeft")) this.moveWordBackwards();
		else if (keybindings.matches(data, "tui.editor.cursorWordRight")) this.moveWordForwards();
		else return false;
		return true;
	}

	private isLineBreakInput(data: string, keybindings: KeybindingsManager): boolean {
		return (
			keybindings.matches(data, "tui.input.newLine") ||
			(data.charCodeAt(0) === 10 && data.length > 1) ||
			data === "\x1b\r" ||
			data === "\x1b[13;2~" ||
			(data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
			data === "\n"
		);
	}

	private handleLineBreakInput(data: string, keybindings: KeybindingsManager): boolean {
		if (!this.isLineBreakInput(data, keybindings)) return false;
		if (this.shouldSubmitOnBackslashEnter(data, keybindings)) {
			this.handleBackspace();
			this.submitValue();
		} else {
			this.addNewLine();
		}
		return true;
	}

	private handleSubmitInput(data: string, keybindings: KeybindingsManager): boolean {
		if (!keybindings.matches(data, "tui.input.submit")) return false;
		if (this.disableSubmit) return true;
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		if (this.state.cursorCol > 0 && currentLine[this.state.cursorCol - 1] === "\\") {
			this.handleBackspace();
			this.addNewLine();
		} else {
			this.submitValue();
		}
		return true;
	}

	private handleVerticalNavigation(data: string, keybindings: KeybindingsManager): boolean {
		if (keybindings.matches(data, "tui.editor.cursorUp")) {
			if (this.isEditorEmpty() || (this.historyIndex > -1 && this.isOnFirstVisualLine())) this.navigateHistory(-1);
			else if (this.isOnFirstVisualLine()) this.moveToLineStart();
			else this.moveCursor(-1, 0);
			return true;
		}
		if (!keybindings.matches(data, "tui.editor.cursorDown")) return false;
		if (this.historyIndex > -1 && this.isOnLastVisualLine()) this.navigateHistory(1);
		else if (this.isOnLastVisualLine()) this.moveToLineEnd();
		else this.moveCursor(1, 0);
		return true;
	}

	private handleHorizontalNavigation(data: string, keybindings: KeybindingsManager): boolean {
		if (keybindings.matches(data, "tui.editor.cursorRight")) this.moveCursor(0, 1);
		else if (keybindings.matches(data, "tui.editor.cursorLeft")) this.moveCursor(0, -1);
		else return false;
		return true;
	}

	private handlePageAndJumpInput(data: string, keybindings: KeybindingsManager): boolean {
		if (keybindings.matches(data, "tui.editor.pageUp")) this.pageScroll(-1);
		else if (keybindings.matches(data, "tui.editor.pageDown")) this.pageScroll(1);
		else if (keybindings.matches(data, "tui.editor.jumpForward")) this.jumpMode = "forward";
		else if (keybindings.matches(data, "tui.editor.jumpBackward")) this.jumpMode = "backward";
		else return false;
		return true;
	}

	private handlePrintableInput(data: string): void {
		if (matchesKey(data, "shift+space")) {
			this.insertCharacter(" ");
			return;
		}
		const printable = decodePrintableKey(data);
		if (printable !== undefined) this.insertCharacter(printable);
		else if (data.charCodeAt(0) >= 32) this.insertCharacter(data);
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (this.handleJumpModeInput(data, keybindings)) return;
		const paste = this.handleBracketedPasteInput(data);
		if (paste.consumed) return;
		data = paste.data;
		if (this.handleGlobalEditorInput(data, keybindings)) return;
		if (this.handleAutocompleteInput(data, keybindings)) return;
		if (this.handleTabInput(data, keybindings)) return;
		if (this.handleDeletionInput(data, keybindings)) return;
		if (this.handleKillRingInput(data, keybindings)) return;
		if (this.handleHistoryInput(data, keybindings)) return;
		if (this.handleLineAndWordMovement(data, keybindings)) return;
		if (this.handleLineBreakInput(data, keybindings)) return;
		if (this.handleSubmitInput(data, keybindings)) return;
		if (this.handleVerticalNavigation(data, keybindings)) return;
		if (this.handleHorizontalNavigation(data, keybindings)) return;
		if (this.handlePageAndJumpInput(data, keybindings)) return;
		this.handlePrintableInput(data);
	}

	private getWrappedChunkCursorPosition(
		chunk: TextChunk,
		isLastChunk: boolean,
		isCurrentLine: boolean,
	): number | undefined {
		if (!isCurrentLine) return undefined;
		const cursorPosition = this.state.cursorCol;
		if (isLastChunk) {
			return cursorPosition >= chunk.startIndex ? cursorPosition - chunk.startIndex : undefined;
		}
		if (cursorPosition < chunk.startIndex || cursorPosition >= chunk.endIndex) return undefined;
		return Math.min(cursorPosition - chunk.startIndex, chunk.text.length);
	}

	private layoutWrappedLine(line: string, contentWidth: number, isCurrentLine: boolean): LayoutLine[] {
		const chunks = wordWrapLine(line, contentWidth, [...this.segment(line, "grapheme")]);
		const layoutLines: LayoutLine[] = [];
		for (let index = 0; index < chunks.length; index++) {
			const chunk = chunks[index];
			if (!chunk) continue;
			const cursorPos = this.getWrappedChunkCursorPosition(chunk, index === chunks.length - 1, isCurrentLine);
			layoutLines.push({
				text: chunk.text,
				hasCursor: cursorPos !== undefined,
				...(cursorPos === undefined ? {} : { cursorPos }),
			});
		}
		return layoutLines;
	}

	private layoutLogicalLine(line: string, contentWidth: number, isCurrentLine: boolean): LayoutLine[] {
		if (visibleWidth(line) > contentWidth) return this.layoutWrappedLine(line, contentWidth, isCurrentLine);
		return [
			{
				text: line,
				hasCursor: isCurrentLine,
				...(isCurrentLine ? { cursorPos: this.state.cursorCol } : {}),
			},
		];
	}

	private layoutText(contentWidth: number): LayoutLine[] {
		if (this.state.lines.length === 0 || (this.state.lines.length === 1 && this.state.lines[0] === "")) {
			return [{ text: "", hasCursor: true, cursorPos: 0 }];
		}
		const layoutLines: LayoutLine[] = [];
		for (let index = 0; index < this.state.lines.length; index++) {
			layoutLines.push(
				...this.layoutLogicalLine(this.state.lines[index] || "", contentWidth, index === this.state.cursorLine),
			);
		}
		return layoutLines;
	}

	getText(): string {
		return this.state.lines.join("\n");
	}

	private expandPasteMarkers(text: string): string {
		let result = text;
		for (const [pasteId, pasteContent] of this.pastes) {
			const markerRegex = new RegExp(`\\[paste #${pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`, "g");
			result = result.replace(markerRegex, () => pasteContent);
		}
		return result;
	}

	/**
	 * Get text with paste markers expanded to their actual content.
	 * Use this when you need the full content (e.g., for external editor).
	 */
	getExpandedText(): string {
		return this.expandPasteMarkers(this.state.lines.join("\n"));
	}

	getLines(): string[] {
		return [...this.state.lines];
	}

	getCursor(): EditorCursorPosition {
		return { line: this.state.cursorLine, col: this.state.cursorCol };
	}

	setText(text: string): void {
		this.cancelAutocomplete();
		this.lastAction = null;
		this.historyIndex = -1; // Exit history browsing mode
		const normalized = this.normalizeText(text);
		// Push undo snapshot if content differs (makes programmatic changes undoable)
		if (this.getText() !== normalized) {
			this.pushUndoSnapshot();
		}
		this.pastes.clear();
		this.pasteCounter = 0;
		this.setTextInternal(normalized);
	}

	/**
	 * Insert text at the current cursor position.
	 * Used for programmatic insertion (e.g., clipboard image markers).
	 * This is atomic for undo - single undo restores entire pre-insert state.
	 */
	insertTextAtCursor(text: string): void {
		if (!text) return;
		this.cancelAutocomplete();
		this.pushUndoSnapshot();
		this.lastAction = null;
		this.historyIndex = -1;
		this.insertTextAtCursorInternal(text);
	}

	/**
	 * Normalize text for editor storage:
	 * - Normalize line endings (\r\n and \r -> \n)
	 * - Expand tabs to 4 spaces
	 */
	private normalizeText(text: string): string {
		return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
	}

	/**
	 * Internal text insertion at cursor. Handles single and multi-line text.
	 * Does not push undo snapshots or trigger autocomplete - caller is responsible.
	 * Normalizes line endings and calls onChange once at the end.
	 */
	private insertTextAtCursorInternal(text: string): void {
		if (!text) return;

		// Normalize line endings and tabs
		const normalized = this.normalizeText(text);
		const insertedLines = normalized.split("\n");

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		const afterCursor = currentLine.slice(this.state.cursorCol);

		if (insertedLines.length === 1) {
			// Single line - insert at cursor position
			this.state.lines[this.state.cursorLine] = beforeCursor + normalized + afterCursor;
			this.setCursorCol(this.state.cursorCol + normalized.length);
		} else {
			// Multi-line insertion
			this.state.lines = [
				// All lines before current line
				...this.state.lines.slice(0, this.state.cursorLine),

				// The first inserted line merged with text before cursor
				beforeCursor + insertedLines[0],

				// All middle inserted lines
				...insertedLines.slice(1, -1),

				// The last inserted line with text after cursor
				insertedLines[insertedLines.length - 1] + afterCursor,

				// All lines after current line
				...this.state.lines.slice(this.state.cursorLine + 1),
			];

			this.state.cursorLine += insertedLines.length - 1;
			this.setCursorCol((insertedLines[insertedLines.length - 1] || "").length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private refreshAutocompleteAfterCharacterInsertion(char: string): void {
		if (this.autocompleteState) {
			this.updateAutocomplete();
			return;
		}
		if (char === "/" && this.isAtStartOfMessage()) {
			this.tryTriggerAutocomplete();
			return;
		}

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
		if (char === "@" || char === "#") {
			const charBeforeSymbol = textBeforeCursor[textBeforeCursor.length - 2];
			if (textBeforeCursor.length === 1 || charBeforeSymbol === " " || charBeforeSymbol === "\t") {
				this.tryTriggerAutocomplete();
			}
			return;
		}
		if (!/[a-zA-Z0-9.\-_]/.test(char)) return;
		if (this.isInSlashCommandContext(textBeforeCursor) || textBeforeCursor.match(/(?:^|[\s])[@#][^\s]*$/)) {
			this.tryTriggerAutocomplete();
		}
	}

	// All the editor methods from before...
	private insertCharacter(char: string, skipUndoCoalescing?: boolean): void {
		this.historyIndex = -1; // Exit history browsing mode

		// Undo coalescing (fish-style):
		// - Consecutive word chars coalesce into one undo unit
		// - Space captures state before itself (so undo removes space+following word together)
		// - Each space is separately undoable
		// Skip coalescing when called from atomic operations (e.g., handlePaste)
		if (!skipUndoCoalescing) {
			if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
				this.pushUndoSnapshot();
			}
			this.lastAction = "type-word";
		}

		const line = this.state.lines[this.state.cursorLine] || "";

		const before = line.slice(0, this.state.cursorCol);
		const after = line.slice(this.state.cursorCol);

		this.state.lines[this.state.cursorLine] = before + char + after;
		this.setCursorCol(this.state.cursorCol + char.length);

		if (this.onChange) {
			this.onChange(this.getText());
		}

		this.refreshAutocompleteAfterCharacterInsertion(char);
	}

	private handlePaste(pastedText: string): void {
		this.cancelAutocomplete();
		this.historyIndex = -1; // Exit history browsing mode
		this.lastAction = null;

		this.pushUndoSnapshot();

		// Some terminals (e.g. tmux popups with extended-keys-format=csi-u) re-encode
		// control bytes inside bracketed paste as CSI-u Ctrl+<letter> sequences
		// (ESC [ <codepoint> ; 5 u). Decode those back to their literal byte so the
		// per-char filter below preserves newlines instead of stripping ESC and
		// leaking the printable tail (e.g. "[106;5u") into the editor.
		const decodedText = pastedText.replace(/\x1b\[(\d+);5u/g, (match, code) => {
			const cp = Number(code);
			if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
			if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
			return match;
		});

		// Clean the pasted text: normalize line endings, expand tabs
		const cleanText = this.normalizeText(decodedText);

		// Filter out non-printable characters except newlines
		let filteredText = cleanText
			.split("")
			.filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
			.join("");

		// If pasting a file path (starts with /, ~, or .) and the character before
		// the cursor is a word character, prepend a space for better readability
		if (/^[/~.]/.test(filteredText)) {
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const charBeforeCursor = this.state.cursorCol > 0 ? currentLine[this.state.cursorCol - 1] : "";
			if (charBeforeCursor && /\w/.test(charBeforeCursor)) {
				filteredText = ` ${filteredText}`;
			}
		}

		// Split into lines to check for large paste
		const pastedLines = filteredText.split("\n");

		// Check if this is a large paste (> 10 lines or > 1000 characters)
		const totalChars = filteredText.length;
		if (pastedLines.length > 10 || totalChars > 1000) {
			// Store the paste and insert a marker
			this.pasteCounter++;
			const pasteId = this.pasteCounter;
			this.pastes.set(pasteId, filteredText);

			// Insert marker like "[paste #1 +123 lines]" or "[paste #1 1234 chars]"
			const marker =
				pastedLines.length > 10
					? `[paste #${pasteId} +${pastedLines.length} lines]`
					: `[paste #${pasteId} ${totalChars} chars]`;
			this.insertTextAtCursorInternal(marker);
			return;
		}

		if (pastedLines.length === 1) {
			// Single line - insert atomically (do not trigger autocomplete during paste)
			this.insertTextAtCursorInternal(filteredText);
			return;
		}

		// Multi-line paste - use direct state manipulation
		this.insertTextAtCursorInternal(filteredText);
	}

	private addNewLine(): void {
		this.cancelAutocomplete();
		this.historyIndex = -1; // Exit history browsing mode
		this.lastAction = null;

		this.pushUndoSnapshot();

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		const before = currentLine.slice(0, this.state.cursorCol);
		const after = currentLine.slice(this.state.cursorCol);

		// Split current line
		this.state.lines[this.state.cursorLine] = before;
		this.state.lines.splice(this.state.cursorLine + 1, 0, after);

		// Move cursor to start of new line
		this.state.cursorLine++;
		this.setCursorCol(0);

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private shouldSubmitOnBackslashEnter(data: string, kb: KeybindingsManager): boolean {
		if (this.disableSubmit) return false;
		if (!matchesKey(data, "enter")) return false;
		const submitKeys = kb.getKeys("tui.input.submit");
		const hasShiftEnter = submitKeys.includes("shift+enter") || submitKeys.includes("shift+return");
		if (!hasShiftEnter) return false;

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		return this.state.cursorCol > 0 && currentLine[this.state.cursorCol - 1] === "\\";
	}

	private submitValue(): void {
		this.cancelAutocomplete();
		const result = this.expandPasteMarkers(this.state.lines.join("\n")).trim();

		this.state = { lines: [""], cursorLine: 0, cursorCol: 0 };
		this.pastes.clear();
		this.pasteCounter = 0;
		this.historyIndex = -1;
		this.scrollOffset = 0;
		this.undoStack.clear();
		this.lastAction = null;

		if (this.onChange) this.onChange("");
		if (this.onSubmit) this.onSubmit(result);
	}

	private deleteGraphemeBeforeCursor(): void {
		const line = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = line.slice(0, this.state.cursorCol);
		const graphemes = [...this.segment(beforeCursor, "grapheme")];
		const lastGrapheme = graphemes[graphemes.length - 1];
		const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;
		const pastedSegment = lastGrapheme ? PASTE_MARKER_SINGLE.exec(lastGrapheme.segment) : null;

		if (!pastedSegment) {
			const before = line.slice(0, this.state.cursorCol - graphemeLength);
			const after = line.slice(this.state.cursorCol);
			this.state.lines[this.state.cursorLine] = before + after;
			this.setCursorCol(this.state.cursorCol - graphemeLength);
			return;
		}

		const targetId = Number(pastedSegment[1]);
		const markerStart = this.state.cursorCol - graphemeLength;
		const beforeMarker = line.slice(0, markerStart);
		const afterMarker = line.slice(this.state.cursorCol);

		this.pastes.delete(targetId);
		this.pasteCounter--;

		// Shift registry entries down in ascending id order, independent
		// of marker order in the text ([paste #3] becomes [paste #2] when
		// [paste #1] is removed).
		const higherIds = [...this.pastes.keys()].filter((id) => id > targetId).sort((a, b) => a - b);
		for (const id of higherIds) {
			this.pastes.set(id - 1, this.pastes.get(id)!);
			this.pastes.delete(id);
		}

		const renumberMarkers = (text: string): string =>
			text.replace(PASTE_MARKER_REGEX, (fullMatch, idGroup, suffixGroup) => {
				const id = Number(idGroup);
				if (id <= targetId) return fullMatch;
				return `[paste #${id - 1}${suffixGroup}]`;
			});

		// Delete the target before renumbering. Renumber the text on each side
		// separately so an earlier #10 -> #9 change cannot stale cursorCol.
		const before = renumberMarkers(beforeMarker);
		const after = renumberMarkers(afterMarker);
		this.state.lines = this.state.lines.map((line, index) =>
			index === this.state.cursorLine ? before + after : renumberMarkers(line),
		);
		this.setCursorCol(before.length);
	}

	private handleBackspace(): void {
		this.historyIndex = -1; // Exit history browsing mode
		this.lastAction = null;

		if (this.state.cursorCol > 0) {
			this.pushUndoSnapshot();
			this.deleteGraphemeBeforeCursor();
		} else if (this.state.cursorLine > 0) {
			this.pushUndoSnapshot();

			// Merge with previous line
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";

			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			this.state.lines.splice(this.state.cursorLine, 1);

			this.state.cursorLine--;
			this.setCursorCol(previousLine.length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}

		// Update or re-trigger autocomplete after backspace
		if (this.autocompleteState) {
			this.updateAutocomplete();
		} else {
			// If autocomplete was cancelled (no matches), re-trigger if we're in a completable context
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
			// Slash command context
			if (this.isInSlashCommandContext(textBeforeCursor)) {
				this.tryTriggerAutocomplete();
			}
			// Symbol-based completion context like @ or #
			else if (textBeforeCursor.match(/(?:^|[\s])[@#][^\s]*$/)) {
				this.tryTriggerAutocomplete();
			}
		}
	}

	/**
	 * Set cursor column and clear preferredVisualCol.
	 * Use this for all non-vertical cursor movements to reset sticky column behavior.
	 */
	private setCursorCol(col: number): void {
		this.state.cursorCol = col;
		this.preferredVisualCol = null;
		this.snappedFromCursorCol = null;
	}

	/**
	 * Move cursor to a target visual line, applying sticky column logic.
	 * Shared by moveCursor() and pageScroll().
	 */
	private resolveCurrentVisualColumn(visualLines: EditorVisualLine[], currentVL: EditorVisualLine): number {
		if (this.snappedFromCursorCol === null) return this.state.cursorCol - currentVL.startCol;
		const visualLineIndex = this.findVisualLineAt(visualLines, currentVL.logicalLine, this.snappedFromCursorCol);
		return this.snappedFromCursorCol - visualLines[visualLineIndex].startCol;
	}

	private getVisualSegmentMaxColumn(
		visualLines: EditorVisualLine[],
		visualLineIndex: number,
		visualLine: EditorVisualLine,
	): number {
		const isLastSegment =
			visualLineIndex === visualLines.length - 1 ||
			visualLines[visualLineIndex + 1]?.logicalLine !== visualLine.logicalLine;
		return isLastSegment ? visualLine.length : Math.max(0, visualLine.length - 1);
	}

	private findAtomicSegmentAtCursor(logicalLine: string): Intl.SegmentData | undefined {
		for (const segment of this.segment(logicalLine, "grapheme")) {
			if (segment.index > this.state.cursorCol) return undefined;
			if (segment.segment.length > 1 && this.state.cursorCol < segment.index + segment.segment.length)
				return segment;
		}
		return undefined;
	}

	private findVisualLineAfterSegment(
		visualLines: EditorVisualLine[],
		targetVisualLine: number,
		segmentEnd: number,
	): number | undefined {
		const target = visualLines[targetVisualLine];
		if (!target) return undefined;
		let next = targetVisualLine + 1;
		while (
			next < visualLines.length &&
			visualLines[next].logicalLine === target.logicalLine &&
			visualLines[next].startCol < segmentEnd
		) {
			next++;
		}
		return next < visualLines.length ? next : undefined;
	}

	private snapCursorToAtomicSegment(
		visualLines: EditorVisualLine[],
		currentVisualLine: number,
		targetVisualLine: number,
		logicalLine: string,
	): void {
		const segment = this.findAtomicSegmentAtCursor(logicalLine);
		if (!segment) {
			this.snappedFromCursorCol = null;
			return;
		}
		const target = visualLines[targetVisualLine];
		const isContinuation = target ? segment.index < target.startCol : false;
		if (isContinuation && targetVisualLine > currentVisualLine) {
			const next = this.findVisualLineAfterSegment(
				visualLines,
				targetVisualLine,
				segment.index + segment.segment.length,
			);
			if (next !== undefined) {
				this.moveToVisualLine(visualLines, currentVisualLine, next);
				return;
			}
		}
		this.snappedFromCursorCol = this.state.cursorCol;
		this.state.cursorCol = segment.index;
	}

	private moveToVisualLine(
		visualLines: EditorVisualLine[],
		currentVisualLine: number,
		targetVisualLine: number,
	): void {
		const currentVL = visualLines[currentVisualLine];
		const targetVL = visualLines[targetVisualLine];
		if (!(currentVL && targetVL)) return;

		const currentVisualCol = this.resolveCurrentVisualColumn(visualLines, currentVL);
		const sourceMaxVisualCol = this.getVisualSegmentMaxColumn(visualLines, currentVisualLine, currentVL);
		const targetMaxVisualCol = this.getVisualSegmentMaxColumn(visualLines, targetVisualLine, targetVL);
		const moveToVisualCol = this.computeVerticalMoveColumn(currentVisualCol, sourceMaxVisualCol, targetMaxVisualCol);

		this.state.cursorLine = targetVL.logicalLine;
		const targetCol = targetVL.startCol + moveToVisualCol;
		const logicalLine = this.state.lines[targetVL.logicalLine] || "";
		this.state.cursorCol = Math.min(targetCol, logicalLine.length);
		this.snapCursorToAtomicSegment(visualLines, currentVisualLine, targetVisualLine, logicalLine);
	}

	/**
	 * Compute the target visual column for vertical cursor movement.
	 * Implements the sticky column decision table:
	 *
	 * | P | S | T | U | Scenario                                             | Set Preferred | Move To     |
	 * |---|---|---|---| ---------------------------------------------------- |---------------|-------------|
	 * | 0 | * | 0 | - | Start nav, target fits                               | null          | current     |
	 * | 0 | * | 1 | - | Start nav, target shorter                            | current       | target end  |
	 * | 1 | 0 | 0 | 0 | Clamped, target fits preferred                       | null          | preferred   |
	 * | 1 | 0 | 0 | 1 | Clamped, target longer but still can't fit preferred | keep          | target end  |
	 * | 1 | 0 | 1 | - | Clamped, target even shorter                         | keep          | target end  |
	 * | 1 | 1 | 0 | - | Rewrapped, target fits current                       | null          | current     |
	 * | 1 | 1 | 1 | - | Rewrapped, target shorter than current               | current       | target end  |
	 *
	 * Where:
	 * - P = preferred col is set
	 * - S = cursor in middle of source line (not clamped to end)
	 * - T = target line shorter than current visual col
	 * - U = target line shorter than preferred col
	 */
	private computeVerticalMoveColumn(
		currentVisualCol: number,
		sourceMaxVisualCol: number,
		targetMaxVisualCol: number,
	): number {
		const hasPreferred = this.preferredVisualCol !== null; // P
		const cursorInMiddle = currentVisualCol < sourceMaxVisualCol; // S
		const targetTooShort = targetMaxVisualCol < currentVisualCol; // T

		if (!hasPreferred || cursorInMiddle) {
			if (targetTooShort) {
				// Cases 2 and 7
				this.preferredVisualCol = currentVisualCol;
				return targetMaxVisualCol;
			}

			// Cases 1 and 6
			this.preferredVisualCol = null;
			return currentVisualCol;
		}

		const targetCantFitPreferred = targetMaxVisualCol < this.preferredVisualCol!; // U
		if (targetTooShort || targetCantFitPreferred) {
			// Cases 4 and 5
			return targetMaxVisualCol;
		}

		// Case 3
		const result = this.preferredVisualCol!;
		this.preferredVisualCol = null;
		return result;
	}

	private moveToLineStart(): void {
		this.lastAction = null;
		this.setCursorCol(0);
	}

	private moveToLineEnd(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		this.setCursorCol(currentLine.length);
	}

	private deleteToStartOfLine(): void {
		this.historyIndex = -1; // Exit history browsing mode

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol > 0) {
			this.pushUndoSnapshot();

			// Calculate text to be deleted and save to kill ring (backward deletion = prepend)
			const deletedText = currentLine.slice(0, this.state.cursorCol);
			this.killRing.push(deletedText, { prepend: true, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			// Delete from start of line up to cursor
			this.state.lines[this.state.cursorLine] = currentLine.slice(this.state.cursorCol);
			this.setCursorCol(0);
		} else if (this.state.cursorLine > 0) {
			this.pushUndoSnapshot();

			// At start of line - merge with previous line, treating newline as deleted text
			this.killRing.push("\n", { prepend: true, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			this.state.lines.splice(this.state.cursorLine, 1);
			this.state.cursorLine--;
			this.setCursorCol(previousLine.length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private deleteToEndOfLine(): void {
		this.historyIndex = -1; // Exit history browsing mode

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol < currentLine.length) {
			this.pushUndoSnapshot();

			// Calculate text to be deleted and save to kill ring (forward deletion = append)
			const deletedText = currentLine.slice(this.state.cursorCol);
			this.killRing.push(deletedText, { prepend: false, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			// Delete from cursor to end of line
			this.state.lines[this.state.cursorLine] = currentLine.slice(0, this.state.cursorCol);
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			this.pushUndoSnapshot();

			// At end of line - merge with next line, treating newline as deleted text
			this.killRing.push("\n", { prepend: false, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private deleteWordBackwards(): void {
		this.historyIndex = -1; // Exit history browsing mode

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at start of line, behave like backspace at column 0 (merge with previous line)
		if (this.state.cursorCol === 0) {
			if (this.state.cursorLine > 0) {
				this.pushUndoSnapshot();

				// Treat newline as deleted text (backward deletion = prepend)
				this.killRing.push("\n", { prepend: true, accumulate: this.lastAction === "kill" });
				this.lastAction = "kill";

				const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
				this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
				this.state.lines.splice(this.state.cursorLine, 1);
				this.state.cursorLine--;
				this.setCursorCol(previousLine.length);
			}
		} else {
			this.pushUndoSnapshot();

			// Save lastAction before cursor movement (moveWordBackwards resets it)
			const wasKill = this.lastAction === "kill";

			const oldCursorCol = this.state.cursorCol;
			this.moveWordBackwards();
			const deleteFrom = this.state.cursorCol;
			this.setCursorCol(oldCursorCol);

			const deletedText = currentLine.slice(deleteFrom, this.state.cursorCol);
			this.killRing.push(deletedText, { prepend: true, accumulate: wasKill });
			this.lastAction = "kill";

			this.state.lines[this.state.cursorLine] =
				currentLine.slice(0, deleteFrom) + currentLine.slice(this.state.cursorCol);
			this.setCursorCol(deleteFrom);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private deleteWordForward(): void {
		this.historyIndex = -1; // Exit history browsing mode

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at end of line, merge with next line (delete the newline)
		if (this.state.cursorCol >= currentLine.length) {
			if (this.state.cursorLine < this.state.lines.length - 1) {
				this.pushUndoSnapshot();

				// Treat newline as deleted text (forward deletion = append)
				this.killRing.push("\n", { prepend: false, accumulate: this.lastAction === "kill" });
				this.lastAction = "kill";

				const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
				this.state.lines[this.state.cursorLine] = currentLine + nextLine;
				this.state.lines.splice(this.state.cursorLine + 1, 1);
			}
		} else {
			this.pushUndoSnapshot();

			// Save lastAction before cursor movement (moveWordForwards resets it)
			const wasKill = this.lastAction === "kill";

			const oldCursorCol = this.state.cursorCol;
			this.moveWordForwards();
			const deleteTo = this.state.cursorCol;
			this.setCursorCol(oldCursorCol);

			const deletedText = currentLine.slice(this.state.cursorCol, deleteTo);
			this.killRing.push(deletedText, { prepend: false, accumulate: wasKill });
			this.lastAction = "kill";

			this.state.lines[this.state.cursorLine] =
				currentLine.slice(0, this.state.cursorCol) + currentLine.slice(deleteTo);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private handleForwardDelete(): void {
		this.historyIndex = -1; // Exit history browsing mode
		this.lastAction = null;

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol < currentLine.length) {
			this.pushUndoSnapshot();

			// Delete grapheme at cursor position (handles emojis, combining characters, etc.)
			const afterCursor = currentLine.slice(this.state.cursorCol);

			// Find the first grapheme at cursor
			const graphemes = [...this.segment(afterCursor, "grapheme")];
			const firstGrapheme = graphemes[0];
			const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;

			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol + graphemeLength);
			this.state.lines[this.state.cursorLine] = before + after;
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			this.pushUndoSnapshot();

			// At end of line - merge with next line
			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}

		// Update or re-trigger autocomplete after forward delete
		if (this.autocompleteState) {
			this.updateAutocomplete();
		} else {
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
			// Slash command context
			if (this.isInSlashCommandContext(textBeforeCursor)) {
				this.tryTriggerAutocomplete();
			}
			// Symbol-based completion context like @ or #
			else if (textBeforeCursor.match(/(?:^|[\s])[@#][^\s]*$/)) {
				this.tryTriggerAutocomplete();
			}
		}
	}

	/**
	 * Build a mapping from visual lines to logical positions.
	 * Returns an array where each element represents a visual line with:
	 * - logicalLine: index into this.state.lines
	 * - startCol: starting column in the logical line
	 * - length: length of this visual line segment
	 */
	private buildVisualLineMap(width: number): EditorVisualLine[] {
		const visualLines: EditorVisualLine[] = [];

		for (let i = 0; i < this.state.lines.length; i++) {
			const line = this.state.lines[i] || "";
			const lineVisWidth = visibleWidth(line);
			if (line.length === 0) {
				// Empty line still takes one visual line
				visualLines.push({ logicalLine: i, startCol: 0, length: 0 });
			} else if (lineVisWidth <= width) {
				visualLines.push({ logicalLine: i, startCol: 0, length: line.length });
			} else {
				// Line needs wrapping - use word-aware wrapping
				const chunks = wordWrapLine(line, width, [...this.segment(line, "grapheme")]);
				for (const chunk of chunks) {
					visualLines.push({
						logicalLine: i,
						startCol: chunk.startIndex,
						length: chunk.endIndex - chunk.startIndex,
					});
				}
			}
		}

		return visualLines;
	}

	/**
	 * Find the visual line index that contains the given logical position.
	 */
	private findVisualLineAt(visualLines: EditorVisualLine[], line: number, col: number): number {
		for (let i = 0; i < visualLines.length; i++) {
			const vl = visualLines[i];
			if (!vl || vl.logicalLine !== line) continue;
			const offset = col - vl.startCol;
			// Cursor is in this segment if it's within range. For the last
			// segment of a logical line, cursor can be at length (end position)
			const isLastSegmentOfLine = i === visualLines.length - 1 || visualLines[i + 1]?.logicalLine !== vl.logicalLine;
			if (offset >= 0 && (offset < vl.length || (isLastSegmentOfLine && offset === vl.length))) {
				return i;
			}
		}
		return visualLines.length - 1;
	}

	/**
	 * Find the visual line index for the current cursor position.
	 */
	private findCurrentVisualLine(visualLines: EditorVisualLine[]): number {
		return this.findVisualLineAt(visualLines, this.state.cursorLine, this.state.cursorCol);
	}

	private moveCursorVertically(visualLines: EditorVisualLine[], currentVisualLine: number, deltaLine: number): void {
		if (deltaLine === 0) return;
		const targetVisualLine = currentVisualLine + deltaLine;
		if (targetVisualLine >= 0 && targetVisualLine < visualLines.length) {
			this.moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
		}
	}

	private moveCursorRight(visualLines: EditorVisualLine[], currentVisualLine: number): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		if (this.state.cursorCol < currentLine.length) {
			const afterCursor = currentLine.slice(this.state.cursorCol);
			const firstGrapheme = [...this.segment(afterCursor, "grapheme")][0];
			this.setCursorCol(this.state.cursorCol + (firstGrapheme ? firstGrapheme.segment.length : 1));
			return;
		}
		if (this.state.cursorLine < this.state.lines.length - 1) {
			this.state.cursorLine++;
			this.setCursorCol(0);
			return;
		}
		const currentVL = visualLines[currentVisualLine];
		if (currentVL) this.preferredVisualCol = this.state.cursorCol - currentVL.startCol;
	}

	private moveCursorLeft(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		if (this.state.cursorCol > 0) {
			const beforeCursor = currentLine.slice(0, this.state.cursorCol);
			const graphemes = [...this.segment(beforeCursor, "grapheme")];
			const lastGrapheme = graphemes[graphemes.length - 1];
			this.setCursorCol(this.state.cursorCol - (lastGrapheme ? lastGrapheme.segment.length : 1));
			return;
		}
		if (this.state.cursorLine > 0) {
			this.state.cursorLine--;
			const previousLine = this.state.lines[this.state.cursorLine] || "";
			this.setCursorCol(previousLine.length);
		}
	}

	private moveCursorHorizontally(visualLines: EditorVisualLine[], currentVisualLine: number, deltaCol: number): void {
		if (deltaCol > 0) this.moveCursorRight(visualLines, currentVisualLine);
		else if (deltaCol < 0) this.moveCursorLeft();
	}

	private moveCursor(deltaLine: number, deltaCol: number): void {
		this.lastAction = null;
		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		this.moveCursorVertically(visualLines, currentVisualLine, deltaLine);
		this.moveCursorHorizontally(visualLines, currentVisualLine, deltaCol);
	}

	/**
	 * Scroll by a page (direction: -1 for up, 1 for down).
	 * Moves cursor by the page size while keeping it in bounds.
	 */
	private pageScroll(direction: -1 | 1): void {
		this.lastAction = null;
		const terminalRows = this.tui.terminal.rows;
		const pageSize = Math.max(5, Math.floor(terminalRows * 0.3));

		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		const targetVisualLine = Math.max(0, Math.min(visualLines.length - 1, currentVisualLine + direction * pageSize));

		this.moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
	}

	private moveWordBackwards(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at start of line, move to end of previous line
		if (this.state.cursorCol === 0) {
			if (this.state.cursorLine > 0) {
				this.state.cursorLine--;
				const prevLine = this.state.lines[this.state.cursorLine] || "";
				this.setCursorCol(prevLine.length);
			}
			return;
		}

		this.setCursorCol(
			findWordBackward(currentLine, this.state.cursorCol, {
				segment: (text) => this.segment(text, "word"),
				isAtomicSegment: isPasteMarker,
			}),
		);
	}

	/**
	 * Yank (paste) the most recent kill ring entry at cursor position.
	 */
	private yank(): void {
		if (this.killRing.length === 0) return;

		this.pushUndoSnapshot();

		const text = this.killRing.peek()!;
		this.insertYankedText(text);

		this.lastAction = "yank";
	}

	/**
	 * Cycle through kill ring (only works immediately after yank or yank-pop).
	 * Replaces the last yanked text with the previous entry in the ring.
	 */
	private yankPop(): void {
		// Only works if we just yanked and have more than one entry
		if (this.lastAction !== "yank" || this.killRing.length <= 1) return;

		this.pushUndoSnapshot();

		// Delete the previously yanked text (still at end of ring before rotation)
		this.deleteYankedText();

		// Rotate the ring: move end to front
		this.killRing.rotate();

		// Insert the new most recent entry (now at end after rotation)
		const text = this.killRing.peek()!;
		this.insertYankedText(text);

		this.lastAction = "yank";
	}

	/**
	 * Insert text at cursor position (used by yank operations).
	 */
	private insertYankedText(text: string): void {
		this.historyIndex = -1; // Exit history browsing mode
		const lines = text.split("\n");

		if (lines.length === 1) {
			// Single line - insert at cursor
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol);
			this.state.lines[this.state.cursorLine] = before + text + after;
			this.setCursorCol(this.state.cursorCol + text.length);
		} else {
			// Multi-line insert
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol);

			// First line merges with text before cursor
			this.state.lines[this.state.cursorLine] = before + (lines[0] || "");

			// Insert middle lines
			for (let i = 1; i < lines.length - 1; i++) {
				this.state.lines.splice(this.state.cursorLine + i, 0, lines[i] || "");
			}

			// Last line merges with text after cursor
			const lastLineIndex = this.state.cursorLine + lines.length - 1;
			this.state.lines.splice(lastLineIndex, 0, (lines[lines.length - 1] || "") + after);

			// Update cursor position
			this.state.cursorLine = lastLineIndex;
			this.setCursorCol((lines[lines.length - 1] || "").length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	/**
	 * Delete the previously yanked text (used by yank-pop).
	 * The yanked text is derived from killRing[end] since it hasn't been rotated yet.
	 */
	private deleteYankedText(): void {
		const yankedText = this.killRing.peek();
		if (!yankedText) return;

		const yankLines = yankedText.split("\n");

		if (yankLines.length === 1) {
			// Single line - delete backward from cursor
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const deleteLen = yankedText.length;
			const before = currentLine.slice(0, this.state.cursorCol - deleteLen);
			const after = currentLine.slice(this.state.cursorCol);
			this.state.lines[this.state.cursorLine] = before + after;
			this.setCursorCol(this.state.cursorCol - deleteLen);
		} else {
			// Multi-line delete - cursor is at end of last yanked line
			const startLine = this.state.cursorLine - (yankLines.length - 1);
			const startCol = (this.state.lines[startLine] || "").length - (yankLines[0] || "").length;

			// Get text after cursor on current line
			const afterCursor = (this.state.lines[this.state.cursorLine] || "").slice(this.state.cursorCol);

			// Get text before yank start position
			const beforeYank = (this.state.lines[startLine] || "").slice(0, startCol);

			// Remove all lines from startLine to cursorLine and replace with merged line
			this.state.lines.splice(startLine, yankLines.length, beforeYank + afterCursor);

			// Update cursor
			this.state.cursorLine = startLine;
			this.setCursorCol(startCol);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private pushUndoSnapshot(): void {
		this.undoStack.push({ state: this.state, pastes: this.pastes, pasteCounter: this.pasteCounter });
	}

	private undo(): void {
		this.historyIndex = -1; // Exit history browsing mode
		const snapshot = this.undoStack.pop();
		if (!snapshot) return;
		Object.assign(this.state, snapshot.state);
		this.pastes = snapshot.pastes;
		this.pasteCounter = snapshot.pasteCounter;
		this.lastAction = null;
		this.preferredVisualCol = null;
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	/**
	 * Jump to the first occurrence of a character in the specified direction.
	 * Multi-line search. Case-sensitive. Skips the current cursor position.
	 */
	private jumpToChar(char: string, direction: CharacterJumpDirection): void {
		this.lastAction = null;
		const isForward = direction === "forward";
		const lines = this.state.lines;

		const end = isForward ? lines.length : -1;
		const step = isForward ? 1 : -1;

		for (let lineIdx = this.state.cursorLine; lineIdx !== end; lineIdx += step) {
			const line = lines[lineIdx] || "";
			const isCurrentLine = lineIdx === this.state.cursorLine;

			// Current line: start after/before cursor; other lines: search full line
			const searchFrom = isCurrentLine
				? isForward
					? this.state.cursorCol + 1
					: this.state.cursorCol - 1
				: undefined;

			const idx = isForward ? line.indexOf(char, searchFrom) : line.lastIndexOf(char, searchFrom);

			if (idx !== -1) {
				this.state.cursorLine = lineIdx;
				this.setCursorCol(idx);
				return;
			}
		}
		// No match found - cursor stays in place
	}

	private moveWordForwards(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at end of line, move to start of next line
		if (this.state.cursorCol >= currentLine.length) {
			if (this.state.cursorLine < this.state.lines.length - 1) {
				this.state.cursorLine++;
				this.setCursorCol(0);
			}
			return;
		}

		this.setCursorCol(
			findWordForward(currentLine, this.state.cursorCol, {
				segment: (text) => this.segment(text, "word"),
				isAtomicSegment: isPasteMarker,
			}),
		);
	}

	// Slash menu only allowed on the first line of the editor
	private isSlashMenuAllowed(): boolean {
		return this.state.cursorLine === 0;
	}

	// Helper method to check if cursor is at start of message (for slash command detection)
	private isAtStartOfMessage(): boolean {
		if (!this.isSlashMenuAllowed()) return false;
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		return beforeCursor.trim() === "" || beforeCursor.trim() === "/";
	}

	private isInSlashCommandContext(textBeforeCursor: string): boolean {
		return this.isSlashMenuAllowed() && textBeforeCursor.trimStart().startsWith("/");
	}

	// Autocomplete methods
	/**
	 * Find the best autocomplete item index for the given prefix.
	 * Returns -1 if no match is found.
	 *
	 * Match priority:
	 * 1. Exact match (prefix === item.value) -> always selected
	 * 2. Prefix match -> first item whose value starts with prefix
	 * 3. No match -> -1 (keep default highlight)
	 *
	 * Matching is case-sensitive and checks item.value only.
	 */
	private getBestAutocompleteMatchIndex(items: AutocompleteItem[], prefix: string): number {
		if (!prefix) return -1;

		let firstPrefixIndex = -1;

		for (let i = 0; i < items.length; i++) {
			const value = items[i]!.value;
			if (value === prefix) {
				return i; // Exact match always wins
			}
			if (firstPrefixIndex === -1 && value.startsWith(prefix)) {
				firstPrefixIndex = i;
			}
		}

		return firstPrefixIndex;
	}

	private createAutocompleteList(prefix: string, items: AutocompleteItem[]): SelectList {
		const layout = prefix.startsWith("/") ? SLASH_COMMAND_SELECT_LIST_LAYOUT : undefined;
		return new SelectList(items, this.autocompleteMaxVisible, this.theme.selectList, layout);
	}

	private tryTriggerAutocomplete(explicitTab: boolean = false): void {
		this.requestAutocomplete({ force: false, explicitTab });
	}

	private handleTabCompletion(): void {
		if (!this.autocompleteProvider) return;

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);

		if (this.isInSlashCommandContext(beforeCursor) && !beforeCursor.trimStart().includes(" ")) {
			this.handleSlashCommandCompletion();
		} else {
			this.forceFileAutocomplete(true);
		}
	}

	private handleSlashCommandCompletion(): void {
		this.requestAutocomplete({ force: false, explicitTab: true });
	}

	private forceFileAutocomplete(explicitTab: boolean = false): void {
		this.requestAutocomplete({ force: true, explicitTab });
	}

	private requestAutocomplete(options: AutocompleteRequestOptions): void {
		if (!this.autocompleteProvider) return;

		if (options.force) {
			const shouldTrigger =
				!this.autocompleteProvider.shouldTriggerFileCompletion ||
				this.autocompleteProvider.shouldTriggerFileCompletion(
					this.state.lines,
					this.state.cursorLine,
					this.state.cursorCol,
				);
			if (!shouldTrigger) {
				return;
			}
		}

		this.cancelAutocompleteRequest();
		const startToken = ++this.autocompleteStartToken;

		const debounceMs = this.getAutocompleteDebounceMs(options);
		if (debounceMs > 0) {
			this.autocompleteDebounceTimer = setTimeout(() => {
				this.autocompleteDebounceTimer = undefined;
				void this.startAutocompleteRequest(startToken, options);
			}, debounceMs);
			return;
		}

		void this.startAutocompleteRequest(startToken, options);
	}

	private async startAutocompleteRequest(startToken: number, options: AutocompleteRequestOptions): Promise<void> {
		const previousTask = this.autocompleteRequestTask;
		this.autocompleteRequestTask = (async () => {
			await previousTask;
			if (startToken !== this.autocompleteStartToken || !this.autocompleteProvider) {
				return;
			}

			const controller = new AbortController();
			this.autocompleteAbort = controller;
			const requestId = ++this.autocompleteRequestId;
			const snapshotText = this.getText();
			const snapshotLine = this.state.cursorLine;
			const snapshotCol = this.state.cursorCol;

			await this.runAutocompleteRequest(requestId, controller, snapshotText, snapshotLine, snapshotCol, options);
		})();
		await this.autocompleteRequestTask;
	}

	private getAutocompleteDebounceMs(options: AutocompleteRequestOptions): number {
		if (options.explicitTab || options.force) {
			return 0;
		}

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
		const isSymbolAutocompleteContext = /(?:^|[ \t])(?:@(?:"[^"]*|[^\s]*)|#[^\s]*)$/.test(textBeforeCursor);
		return isSymbolAutocompleteContext ? ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS : 0;
	}

	private async runAutocompleteRequest(
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
		options: AutocompleteRequestOptions,
	): Promise<void> {
		if (!this.autocompleteProvider) return;

		const suggestions = await this.autocompleteProvider.getSuggestions(
			this.state.lines,
			this.state.cursorLine,
			this.state.cursorCol,
			{ signal: controller.signal, force: options.force },
		);

		if (!this.isAutocompleteRequestCurrent(requestId, controller, snapshotText, snapshotLine, snapshotCol)) {
			return;
		}

		this.autocompleteAbort = undefined;

		if (!suggestions || !Array.isArray(suggestions.items) || suggestions.items.length === 0) {
			this.cancelAutocomplete();
			this.tui.requestRender();
			return;
		}

		if (options.force && options.explicitTab && suggestions.items.length === 1) {
			const item = suggestions.items[0]!;
			this.pushUndoSnapshot();
			this.lastAction = null;
			const result = this.autocompleteProvider.applyCompletion(
				this.state.lines,
				this.state.cursorLine,
				this.state.cursorCol,
				item,
				suggestions.prefix,
			);
			this.state.lines = result.lines;
			this.state.cursorLine = result.cursorLine;
			this.setCursorCol(result.cursorCol);
			if (this.onChange) this.onChange(this.getText());
			this.tui.requestRender();
			return;
		}

		this.applyAutocompleteSuggestions(suggestions, options.force ? "force" : "regular");
		this.tui.requestRender();
	}

	private isAutocompleteRequestCurrent(
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
	): boolean {
		return (
			!controller.signal.aborted &&
			requestId === this.autocompleteRequestId &&
			this.getText() === snapshotText &&
			this.state.cursorLine === snapshotLine &&
			this.state.cursorCol === snapshotCol
		);
	}

	private applyAutocompleteSuggestions(suggestions: AutocompleteSuggestions, state: AutocompleteTriggerMode): void {
		this.autocompletePrefix = suggestions.prefix;
		this.autocompleteList = this.createAutocompleteList(suggestions.prefix, suggestions.items);

		const bestMatchIndex = this.getBestAutocompleteMatchIndex(suggestions.items, suggestions.prefix);
		if (bestMatchIndex >= 0) {
			this.autocompleteList.setSelectedIndex(bestMatchIndex);
		}

		this.autocompleteState = state;
	}

	private cancelAutocompleteRequest(): void {
		this.autocompleteStartToken += 1;
		if (this.autocompleteDebounceTimer) {
			clearTimeout(this.autocompleteDebounceTimer);
			this.autocompleteDebounceTimer = undefined;
		}
		this.autocompleteAbort?.abort();
		this.autocompleteAbort = undefined;
	}

	private clearAutocompleteUi(): void {
		this.autocompleteState = null;
		this.autocompleteList = undefined;
		this.autocompletePrefix = "";
	}

	private cancelAutocomplete(): void {
		this.cancelAutocompleteRequest();
		this.clearAutocompleteUi();
	}

	public isShowingAutocomplete(): boolean {
		return this.autocompleteState !== null;
	}

	private updateAutocomplete(): void {
		if (!this.autocompleteState || !this.autocompleteProvider) return;
		this.requestAutocomplete({ force: this.autocompleteState === "force", explicitTab: false });
	}
}
