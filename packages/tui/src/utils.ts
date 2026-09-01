import { eastAsianWidth } from "get-east-asian-width";

// segmenters (shared instance)
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/**
 * Get the shared grapheme segmenter instance.
 */
export function getGraphemeSegmenter(): Intl.Segmenter {
	return graphemeSegmenter;
}

/**
 * Get the shared word segmenter instance.
 */
export function getWordSegmenter(): Intl.Segmenter {
	return wordSegmenter;
}

/**
 * Check if a grapheme cluster (after segmentation) could possibly be an RGI emoji.
 * This is a fast heuristic to avoid the expensive rgiEmojiRegex test.
 * The tested Unicode blocks are deliberately broad to account for future
 * Unicode additions.
 */
function couldBeEmoji(segment: string): boolean {
	const cp = segment.codePointAt(0)!;
	return (
		(cp >= 0x1f000 && cp <= 0x1fbff) || // Emoji and Pictograph
		(cp >= 0x2300 && cp <= 0x23ff) || // Misc technical
		(cp >= 0x2600 && cp <= 0x27bf) || // Misc symbols, dingbats
		(cp >= 0x2b50 && cp <= 0x2b55) || // Specific stars/circles
		segment.includes("\uFE0F") || // Contains VS16 (emoji presentation selector)
		segment.length > 2 // Multi-codepoint sequences (ZWJ, skin tones, etc.)
	);
}

// Regexes for character classification (same as string-width library)
const zeroWidthRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/v;
const leadingNonPrintingRegex = /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v;
const nonPrintingCharRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})$/v;
const markCharRegex = /^\p{Mark}$/v;
// Marks that terminals allocate cells for when attached to a base character.
// This includes Unicode spacing marks and non-spacing exceptions in legacy wcwidth tables.
const terminalSpacingMarkRegex =
	/^(?:[\p{Spacing_Mark}--[\u1734\u302E\u302F]]|[\u065F\u0F7F\u102B\u102C\u1031\u1033-\u1035\u1038\u103A-\u103E])+$/v;
const rgiEmojiRegex = /^\p{RGI_Emoji}$/v;

// Cache for non-ASCII strings
const WIDTH_CACHE_SIZE = 512;
const widthCache = new Map<string, number>();

function isPrintableAscii(str: string): boolean {
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) {
			return false;
		}
	}
	return true;
}

interface FragmentTruncationState {
	text: string;
	width: number;
	pendingAnsi: string;
}

function appendPendingAnsi(state: FragmentTruncationState): void {
	if (!state.pendingAnsi) return;
	state.text += state.pendingAnsi;
	state.pendingAnsi = "";
}

function appendVisibleFragment(
	state: FragmentTruncationState,
	fragment: string,
	fragmentWidth: number,
	maxWidth: number,
): boolean {
	if (state.width + fragmentWidth > maxWidth) return false;
	appendPendingAnsi(state);
	state.text += fragment;
	state.width += fragmentWidth;
	return true;
}

function appendGraphemeRun(state: FragmentTruncationState, text: string, maxWidth: number): boolean {
	for (const { segment } of graphemeSegmenter.segment(text)) {
		if (!appendVisibleFragment(state, segment, graphemeWidth(segment), maxWidth)) return false;
	}
	return true;
}
interface TerminalTextFragment {
	text: string;
	width: number;
}

interface AnsiCodeMatch {
	code: string;
	length: number;
}

function truncateStyledFragment(state: FragmentTruncationState, text: string, maxWidth: number): void {
	let index = 0;
	while (index < text.length) {
		const ansi = extractAnsiCode(text, index);
		if (ansi) {
			state.pendingAnsi += ansi.code;
			index += ansi.length;
			continue;
		}
		if (text[index] === "\t") {
			if (!appendVisibleFragment(state, "\t", 3, maxWidth)) return;
			index++;
			continue;
		}
		let end = index;
		while (end < text.length && text[end] !== "\t" && !extractAnsiCode(text, end)) end++;
		if (!appendGraphemeRun(state, text.slice(index, end), maxWidth)) return;
		index = end;
	}
}

function truncateFragmentToWidth(text: string, maxWidth: number): TerminalTextFragment {
	if (maxWidth <= 0 || text.length === 0) return { text: "", width: 0 };
	if (isPrintableAscii(text)) {
		const clipped = text.slice(0, maxWidth);
		return { text: clipped, width: clipped.length };
	}
	const state: FragmentTruncationState = { text: "", width: 0, pendingAnsi: "" };
	if (!text.includes("\x1b") && !text.includes("\t")) {
		appendGraphemeRun(state, text, maxWidth);
	} else {
		truncateStyledFragment(state, text, maxWidth);
	}
	return { text: state.text, width: state.width };
}

function finalizeTruncatedResult(
	prefix: string,
	prefixWidth: number,
	ellipsis: string,
	ellipsisWidth: number,
	maxWidth: number,
	pad: boolean,
): string {
	const reset = "\x1b[0m";
	const hyperlinkClose = getActiveOsc8Close(prefix);
	const visibleWidth = prefixWidth + ellipsisWidth;
	let result: string;

	if (ellipsis.length > 0) {
		result = `${prefix}${hyperlinkClose}${reset}${ellipsis}${reset}`;
	} else {
		result = `${prefix}${hyperlinkClose}${reset}`;
	}

	return pad ? result + " ".repeat(Math.max(0, maxWidth - visibleWidth)) : result;
}

/**
 * Calculate the terminal width of a single grapheme cluster.
 * Based on code from the string-width library, but includes a possible-emoji
 * check to avoid running the RGI_Emoji regex unnecessarily.
 */
function trailingCodePointWidth(codePoint: number, followsMark: boolean): number {
	if (followsMark || (codePoint >= 0xff00 && codePoint <= 0xffef)) {
		// Indic consonants after marks and halfwidth/fullwidth forms.
		return eastAsianWidth(codePoint);
	}
	if (codePoint === 0x0e33 || codePoint === 0x0eb3) {
		// Thai/Lao AM vowels.
		return 1;
	}
	return 0;
}

function trailingGraphemeWidth(base: string): number {
	let width = 0;
	let followsMark = false;
	for (const char of [...base].slice(1)) {
		if (terminalSpacingMarkRegex.test(char)) {
			width += 1;
			followsMark = false;
			continue;
		}
		if (markCharRegex.test(char)) {
			followsMark = true;
			continue;
		}
		if (nonPrintingCharRegex.test(char)) continue;
		width += trailingCodePointWidth(char.codePointAt(0)!, followsMark);
		followsMark = false;
	}
	return width;
}

function graphemeWidth(segment: string): number {
	if (segment === "\t") {
		return 3;
	}

	// Some marks occupy cells even without a base character.
	if (terminalSpacingMarkRegex.test(segment)) {
		return [...segment].length;
	}

	// Zero-width clusters
	if (zeroWidthRegex.test(segment)) {
		return 0;
	}

	// Emoji check with pre-filter
	if (couldBeEmoji(segment) && rgiEmojiRegex.test(segment)) {
		return 2;
	}

	// Get base visible codepoint
	const base = segment.replace(leadingNonPrintingRegex, "");
	const cp = base.codePointAt(0);
	if (cp === undefined) {
		return 0;
	}

	// Regional indicator symbols (U+1F1E6..U+1F1FF) are often rendered as
	// full-width emoji in terminals, even when isolated during streaming.
	// Keep width conservative (2) to avoid terminal auto-wrap drift artifacts.
	if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
		return 2;
	}

	// Intl.Segmenter can group multiple terminal-spacing code points into one
	// grapheme. Count trailing visible code points that terminals may allocate
	// cells for.
	return eastAsianWidth(cp) + trailingGraphemeWidth(base);
}

/**
 * Calculate the visible width of a string in terminal columns.
 */
export function visibleWidth(str: string): number {
	if (str.length === 0) {
		return 0;
	}

	// Fast path: pure ASCII printable
	if (isPrintableAscii(str)) {
		return str.length;
	}

	// Check cache
	const cached = widthCache.get(str);
	if (cached !== undefined) {
		return cached;
	}

	// Normalize: tabs to 3 spaces, strip ANSI escape codes
	let clean = str;
	if (str.includes("\t")) {
		clean = clean.replace(/\t/g, "   ");
	}
	if (clean.includes("\x1b")) {
		// Strip supported ANSI/OSC/APC escape sequences in one pass.
		// This covers CSI styling/cursor codes, OSC hyperlinks and prompt markers,
		// and APC sequences like CURSOR_MARKER.
		let stripped = "";
		let i = 0;
		while (i < clean.length) {
			const ansi = extractAnsiCode(clean, i);
			if (ansi) {
				i += ansi.length;
				continue;
			}
			stripped += clean[i];
			i++;
		}
		clean = stripped;
	}

	// Calculate width
	let width = 0;
	for (const { segment } of graphemeSegmenter.segment(clean)) {
		width += graphemeWidth(segment);
	}

	// Cache result
	if (widthCache.size >= WIDTH_CACHE_SIZE) {
		const firstKey = widthCache.keys().next().value;
		if (firstKey !== undefined) {
			widthCache.delete(firstKey);
		}
	}
	widthCache.set(str, width);

	return width;
}

/** Remove ANSI, OSC, and APC control sequences while preserving visible text. */
export function stripTerminalSequences(str: string): string {
	if (!str.includes("\x1b")) return str;
	let result = "";
	let i = 0;
	while (i < str.length) {
		const ansi = extractAnsiCode(str, i);
		if (ansi) {
			i += ansi.length;
			continue;
		}
		result += str[i];
		i++;
	}
	return result;
}

// pi-ignore noNearIdenticalDataStructures: A grapheme's rendered cell extent is a text-measurement result, while selection columns span and clip an independently managed row selection.
interface GraphemeCellRange {
	start: number;
	end: number;
}

interface TerminalTextColumnScan {
	containsColumn: boolean;
	nextColumn: number;
}

function scanTerminalTextColumn(text: string, column: number, startColumn: number): TerminalTextColumnScan {
	let currentColumn = startColumn;
	for (const { segment } of graphemeSegmenter.segment(text)) {
		const width = segment === "\t" ? 3 : graphemeWidth(segment);
		if (column >= currentColumn && column < currentColumn + width) {
			return { containsColumn: true, nextColumn: currentColumn };
		}
		currentColumn += width;
	}
	return { containsColumn: false, nextColumn: currentColumn };
}

/** Return the terminal-cell range occupied by the grapheme at a visible column. */
export function getGraphemeCellRange(line: string, column: number): GraphemeCellRange | undefined {
	let currentCol = 0;
	let i = 0;
	while (i < line.length) {
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			i += ansi.length;
			continue;
		}
		let textEnd = i;
		while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;
		for (const { segment } of graphemeSegmenter.segment(line.slice(i, textEnd))) {
			const width = graphemeWidth(segment);
			if (width > 0 && column >= currentCol && column < currentCol + width) {
				return { start: currentCol, end: currentCol + width };
			}
			currentCol += width;
		}
		i = textEnd;
	}
	return undefined;
}

/** Return the OSC 8 hyperlink covering a visible terminal column. */
export function getOsc8LinkAtColumn(line: string, column: number): string | undefined {
	let activeUrl: string | undefined;
	let currentCol = 0;
	let i = 0;
	while (i < line.length) {
		const ansi = extractAnsiCode(line, i);
		if (ansi) {
			const hyperlink = /^\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)$/.exec(ansi.code);
			if (hyperlink) activeUrl = hyperlink[1] || undefined;
			i += ansi.length;
			continue;
		}
		let textEnd = i;
		while (textEnd < line.length && !extractAnsiCode(line, textEnd)) textEnd++;
		const scan = scanTerminalTextColumn(line.slice(i, textEnd), column, currentCol);
		if (scan.containsColumn) return activeUrl;
		currentCol = scan.nextColumn;
		i = textEnd;
	}
	return undefined;
}

/**
 * Normalize text for terminal output without changing logical editor content.
 * Some terminals render precomposed Thai/Lao AM vowels inconsistently during
 * differential repaint. Their compatibility decompositions have the same cell
 * width but avoid stale-cell artifacts in terminal renderers. Visible tabs are
 * expanded to the fixed width used by layout so terminal tab stops cannot wrap
 * a logical line, while tabs inside terminal string sequences stay untouched.
 */
const THAI_LAO_AM_REGEX = /[\u0e33\u0eb3]/;
const THAI_LAO_AM_GLOBAL_REGEX = /[\u0e33\u0eb3]/g;

export function normalizeTerminalOutput(str: string): string {
	let normalized = str;
	if (THAI_LAO_AM_REGEX.test(normalized)) {
		normalized = normalized.replace(THAI_LAO_AM_GLOBAL_REGEX, (char) =>
			char === "\u0e33" ? "\u0e4d\u0e32" : "\u0ecd\u0eb2",
		);
	}
	if (!normalized.includes("\t")) return normalized;

	let result = "";
	let i = 0;
	while (i < normalized.length) {
		const ansi = extractAnsiCode(normalized, i);
		if (ansi) {
			result += ansi.code;
			i += ansi.length;
			continue;
		}
		result += normalized[i] === "\t" ? "   " : normalized[i];
		i++;
	}
	return result;
}

function extractCsiSequence(str: string, pos: number): AnsiCodeMatch | null {
	let end = pos + 2;
	while (end < str.length && !/[mGKHJ]/.test(str[end]!)) end++;
	if (end >= str.length) return null;
	return { code: str.substring(pos, end + 1), length: end + 1 - pos };
}

function extractTerminatedControlString(str: string, pos: number): AnsiCodeMatch | null {
	let end = pos + 2;
	while (end < str.length) {
		if (str[end] === "\x07") return { code: str.substring(pos, end + 1), length: end + 1 - pos };
		if (str[end] === "\x1b" && str[end + 1] === "\\") {
			return { code: str.substring(pos, end + 2), length: end + 2 - pos };
		}
		end++;
	}
	return null;
}

/** Extract an ANSI escape sequence from a string at the given position. */
export function extractAnsiCode(str: string, pos: number): AnsiCodeMatch | null {
	if (pos >= str.length || str[pos] !== "\x1b") return null;
	const introducer = str[pos + 1];
	if (introducer === "[") return extractCsiSequence(str, pos);
	// OSC and APC sequences share BEL and ST termination rules.
	if (introducer === "]" || introducer === "_") return extractTerminatedControlString(str, pos);
	return null;
}

type Osc8Terminator = "\x07" | "\x1b\\";

interface ActiveHyperlink {
	params: string;
	url: string;
	terminator: Osc8Terminator;
}

function parseOsc8Hyperlink(ansiCode: string): ActiveHyperlink | null | undefined {
	if (!ansiCode.startsWith("\x1b]8;")) {
		return undefined;
	}

	const terminator: Osc8Terminator = ansiCode.endsWith("\x07") ? "\x07" : "\x1b\\";
	const body = ansiCode.slice(4, terminator === "\x07" ? -1 : -2);
	const separatorIndex = body.indexOf(";");
	if (separatorIndex === -1) {
		return undefined;
	}

	const params = body.slice(0, separatorIndex);
	const url = body.slice(separatorIndex + 1);
	if (!url) {
		return null;
	}
	return { params, url, terminator };
}

function formatOsc8Hyperlink(hyperlink: ActiveHyperlink): string {
	return `\x1b]8;${hyperlink.params};${hyperlink.url}${hyperlink.terminator}`;
}

function formatOsc8Close(terminator: Osc8Terminator): string {
	return `\x1b]8;;${terminator}`;
}

function getActiveOsc8Close(prefix: string): string {
	if (!prefix.includes("\x1b]8;")) {
		return "";
	}

	let activeHyperlink: ActiveHyperlink | null = null;
	let i = 0;
	while (i < prefix.length) {
		const ansi = extractAnsiCode(prefix, i);
		if (ansi) {
			const hyperlink = parseOsc8Hyperlink(ansi.code);
			if (hyperlink !== undefined) {
				activeHyperlink = hyperlink;
			}
			i += ansi.length;
		} else {
			i++;
		}
	}
	return activeHyperlink ? formatOsc8Close(activeHyperlink.terminator) : "";
}

/**
 * Track active ANSI SGR codes to preserve styling across line breaks.
 */
class AnsiCodeTracker {
	// Track individual attributes separately so we can reset them specifically
	private bold = false;
	private dim = false;
	private italic = false;
	private underline = false;
	private blink = false;
	private inverse = false;
	private hidden = false;
	private strikethrough = false;
	private fgColor: string | null = null; // Stores the full code like "31" or "38;5;240"
	private bgColor: string | null = null; // Stores the full code like "41" or "48;5;240"
	private activeHyperlink: ActiveHyperlink | null = null;

	private setColor(code: number, color: string): void {
		if (code === 38) this.fgColor = color;
		else this.bgColor = color;
	}

	private processExtendedColor(parts: string[], index: number, code: number): number | undefined {
		if (code !== 38 && code !== 48) return undefined;
		if (parts[index + 1] === "5" && parts[index + 2] !== undefined) {
			this.setColor(code, `${parts[index]};${parts[index + 1]};${parts[index + 2]}`);
			return index + 3;
		}
		if (parts[index + 1] === "2" && parts[index + 4] !== undefined) {
			this.setColor(
				code,
				`${parts[index]};${parts[index + 1]};${parts[index + 2]};${parts[index + 3]};${parts[index + 4]}`,
			);
			return index + 5;
		}
		return undefined;
	}

	private processStandardSgrCode(code: number): void {
		switch (code) {
			case 0:
				this.reset();
				break;
			case 1:
				this.bold = true;
				break;
			case 2:
				this.dim = true;
				break;
			case 3:
				this.italic = true;
				break;
			case 4:
				this.underline = true;
				break;
			case 5:
				this.blink = true;
				break;
			case 7:
				this.inverse = true;
				break;
			case 8:
				this.hidden = true;
				break;
			case 9:
				this.strikethrough = true;
				break;
			case 21:
				this.bold = false;
				break;
			case 22:
				this.bold = false;
				this.dim = false;
				break;
			case 23:
				this.italic = false;
				break;
			case 24:
				this.underline = false;
				break;
			case 25:
				this.blink = false;
				break;
			case 27:
				this.inverse = false;
				break;
			case 28:
				this.hidden = false;
				break;
			case 29:
				this.strikethrough = false;
				break;
			case 39:
				this.fgColor = null;
				break;
			case 49:
				this.bgColor = null;
				break;
			default:
				if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) this.fgColor = String(code);
				else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) this.bgColor = String(code);
		}
	}

	process(ansiCode: string): void {
		const hyperlink = parseOsc8Hyperlink(ansiCode);
		if (hyperlink !== undefined) {
			this.activeHyperlink = hyperlink;
			return;
		}
		if (!ansiCode.endsWith("m")) return;
		const match = ansiCode.match(/\x1b\[([\d;]*)m/);
		if (!match) return;
		const params = match[1];
		if (params === "" || params === "0") {
			this.reset();
			return;
		}
		const parts = params.split(";");
		let index = 0;
		while (index < parts.length) {
			const code = Number.parseInt(parts[index], 10);
			const nextIndex = this.processExtendedColor(parts, index, code);
			if (nextIndex !== undefined) {
				index = nextIndex;
				continue;
			}
			this.processStandardSgrCode(code);
			index++;
		}
	}

	private reset(): void {
		this.bold = false;
		this.dim = false;
		this.italic = false;
		this.underline = false;
		this.blink = false;
		this.inverse = false;
		this.hidden = false;
		this.strikethrough = false;
		this.fgColor = null;
		this.bgColor = null;
		// SGR reset does not affect OSC 8 hyperlink state
	}

	/** Clear all state for reuse. */
	clear(): void {
		this.reset();
		this.activeHyperlink = null;
	}

	getActiveCodes(): string {
		const codes: string[] = [];
		if (this.bold) codes.push("1");
		if (this.dim) codes.push("2");
		if (this.italic) codes.push("3");
		if (this.underline) codes.push("4");
		if (this.blink) codes.push("5");
		if (this.inverse) codes.push("7");
		if (this.hidden) codes.push("8");
		if (this.strikethrough) codes.push("9");
		if (this.fgColor) codes.push(this.fgColor);
		if (this.bgColor) codes.push(this.bgColor);

		let result = codes.length > 0 ? `\x1b[${codes.join(";")}m` : "";
		if (this.activeHyperlink) {
			result += formatOsc8Hyperlink(this.activeHyperlink);
		}
		return result;
	}

	hasActiveCodes(): boolean {
		return (
			this.bold ||
			this.dim ||
			this.italic ||
			this.underline ||
			this.blink ||
			this.inverse ||
			this.hidden ||
			this.strikethrough ||
			this.fgColor !== null ||
			this.bgColor !== null ||
			this.activeHyperlink !== null
		);
	}

	/**
	 * Get reset codes for attributes that need to be turned off at line end.
	 * Underline must be closed to prevent bleeding into padding.
	 * Active OSC 8 hyperlinks must be closed and re-opened on the next line.
	 * Returns empty string if no attributes need closing.
	 */
	getLineEndReset(): string {
		let result = "";
		if (this.underline) {
			result += "\x1b[24m"; // Underline off only
		}
		if (this.activeHyperlink) {
			result += formatOsc8Close(this.activeHyperlink.terminator); // Re-opened at line start via getActiveCodes()
		}
		return result;
	}
}

function updateTrackerFromText(text: string, tracker: AnsiCodeTracker): void {
	let i = 0;
	while (i < text.length) {
		const ansiResult = extractAnsiCode(text, i);
		if (ansiResult) {
			tracker.process(ansiResult.code);
			i += ansiResult.length;
		} else {
			i++;
		}
	}
}

/**
 * Split text into words while keeping ANSI codes attached.
 */
function splitIntoTokensWithAnsi(text: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let pendingAnsi = ""; // ANSI codes waiting to be attached to next visible content
	let inWhitespace = false;
	let i = 0;

	while (i < text.length) {
		const ansiResult = extractAnsiCode(text, i);
		if (ansiResult) {
			// Hold ANSI codes separately - they'll be attached to the next visible char
			pendingAnsi += ansiResult.code;
			i += ansiResult.length;
			continue;
		}

		const char = text[i];
		const charIsSpace = char === " ";

		if (charIsSpace !== inWhitespace && current) {
			// Switching between whitespace and non-whitespace, push current token
			tokens.push(current);
			current = "";
		}

		// Attach any pending ANSI codes to this visible character
		if (pendingAnsi) {
			current += pendingAnsi;
			pendingAnsi = "";
		}

		inWhitespace = charIsSpace;
		current += char;
		i++;
	}

	// Handle any remaining pending ANSI codes (attach to last token)
	if (pendingAnsi) {
		current += pendingAnsi;
	}

	if (current) {
		tokens.push(current);
	}

	return tokens;
}

/**
 * Wrap text with ANSI codes preserved.
 *
 * ONLY does word wrapping - NO padding, NO background colors.
 * Returns lines where each line is <= width visible chars.
 * Active ANSI codes are preserved across line breaks.
 *
 * @param text - Text to wrap (may contain ANSI codes and newlines)
 * @param width - Maximum visible width per line
 * @returns Array of wrapped lines (NOT padded to width)
 */
export function wrapTextWithAnsi(text: string, width: number): string[] {
	if (!text) {
		return [""];
	}

	// Handle newlines by processing each line separately
	// Track ANSI state across lines so styles carry over after literal newlines
	const inputLines = text.split(/\r\n|\r|\n/);
	const result: string[] = [];
	const tracker = new AnsiCodeTracker();

	for (const inputLine of inputLines) {
		// Prepend active ANSI codes from previous lines (except for first line)
		const prefix = result.length > 0 ? tracker.getActiveCodes() : "";
		const wrappedLines = wrapSingleLine(prefix + inputLine, width);
		for (const wrappedLine of wrappedLines) {
			result.push(wrappedLine);
		}
		// Update tracker with codes from this line for next iteration
		updateTrackerFromText(inputLine, tracker);
	}

	return result.length > 0 ? result : [""];
}

interface AnsiWrapLineState {
	text: string;
	visibleWidth: number;
}

interface AnsiWrapContext {
	maxWidth: number;
	lines: string[];
	tracker: AnsiCodeTracker;
	current: AnsiWrapLineState;
}

function appendLineEndReset(text: string, tracker: AnsiCodeTracker): string {
	return text + tracker.getLineEndReset();
}

function appendOversizedWrapToken(token: string, context: AnsiWrapContext): void {
	if (context.current.text) {
		context.lines.push(appendLineEndReset(context.current.text, context.tracker));
		context.current.text = "";
		context.current.visibleWidth = 0;
	}

	const broken = breakLongWord(token, context.maxWidth, context.tracker);
	for (let index = 0; index < broken.length - 1; index++) context.lines.push(broken[index]!);
	context.current.text = broken[broken.length - 1];
	context.current.visibleWidth = visibleWidth(context.current.text);
}

function appendFittingWrapToken(
	token: string,
	tokenVisibleWidth: number,
	isWhitespace: boolean,
	context: AnsiWrapContext,
): void {
	const exceedsLine = context.current.visibleWidth + tokenVisibleWidth > context.maxWidth;
	if (!exceedsLine || context.current.visibleWidth === 0) {
		context.current.text += token;
		context.current.visibleWidth += tokenVisibleWidth;
		return;
	}

	context.lines.push(appendLineEndReset(context.current.text.trimEnd(), context.tracker));
	if (isWhitespace) {
		context.current.text = context.tracker.getActiveCodes();
		context.current.visibleWidth = 0;
		return;
	}
	context.current.text = context.tracker.getActiveCodes() + token;
	context.current.visibleWidth = tokenVisibleWidth;
}

function wrapSingleLine(line: string, width: number): string[] {
	if (!line) return [""];
	if (visibleWidth(line) <= width) return [line];

	const context: AnsiWrapContext = {
		maxWidth: width,
		lines: [],
		tracker: new AnsiCodeTracker(),
		current: { text: "", visibleWidth: 0 },
	};
	for (const token of splitIntoTokensWithAnsi(line)) {
		const tokenVisibleWidth = visibleWidth(token);
		const isWhitespace = token.trim() === "";
		if (tokenVisibleWidth > width && !isWhitespace) {
			appendOversizedWrapToken(token, context);
			continue;
		}
		appendFittingWrapToken(token, tokenVisibleWidth, isWhitespace, context);
		updateTrackerFromText(token, context.tracker);
	}

	if (context.current.text) context.lines.push(context.current.text);
	return context.lines.length > 0 ? context.lines.map((wrappedLine) => wrappedLine.trimEnd()) : [""];
}

export const PUNCTUATION_REGEX = /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/;

/**
 * Check if a character is whitespace.
 */
export function isWhitespaceChar(char: string): boolean {
	return /\s/.test(char);
}

/**
 * Check if a character is punctuation.
 */
export function isPunctuationChar(char: string): boolean {
	return PUNCTUATION_REGEX.test(char);
}

type AnsiTextSegmentType = "ansi" | "grapheme";

interface AnsiTextSegment {
	type: AnsiTextSegmentType;
	value: string;
}

function* iterateAnsiTextSegments(text: string): Generator<AnsiTextSegment> {
	let index = 0;
	while (index < text.length) {
		const ansiResult = extractAnsiCode(text, index);
		if (ansiResult) {
			yield { type: "ansi", value: ansiResult.code };
			index += ansiResult.length;
			continue;
		}

		let end = index;
		while (end < text.length) {
			if (extractAnsiCode(text, end)) break;
			end++;
		}
		for (const segment of graphemeSegmenter.segment(text.slice(index, end))) {
			yield { type: "grapheme", value: segment.segment };
		}
		index = end;
	}
}

function breakLongWord(word: string, width: number, tracker: AnsiCodeTracker): string[] {
	const lines: string[] = [];
	let currentLine = tracker.getActiveCodes();
	let currentWidth = 0;

	// Now process segments
	for (const seg of iterateAnsiTextSegments(word)) {
		if (seg.type === "ansi") {
			currentLine += seg.value;
			tracker.process(seg.value);
			continue;
		}

		const grapheme = seg.value;
		// Skip empty graphemes to avoid issues with string-width calculation
		if (!grapheme) continue;

		const graphemeWidth = visibleWidth(grapheme);

		if (currentWidth + graphemeWidth > width) {
			// Add specific reset for underline only (preserves background)
			const lineEndReset = tracker.getLineEndReset();
			if (lineEndReset) {
				currentLine += lineEndReset;
			}
			lines.push(currentLine);
			currentLine = tracker.getActiveCodes();
			currentWidth = 0;
		}

		currentLine += grapheme;
		currentWidth += graphemeWidth;
	}

	if (currentLine) {
		// No reset at end of final segment - caller handles continuation
		lines.push(currentLine);
	}

	return lines.length > 0 ? lines : [""];
}

/**
 * Apply background color to a line, padding to full width.
 *
 * @param line - Line of text (may contain ANSI codes)
 * @param width - Total width to pad to
 * @param bgFn - Background color function
 * @returns Line with background applied and padded to width
 */
export function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	// Calculate padding needed
	const visibleLen = visibleWidth(line);
	const paddingNeeded = Math.max(0, width - visibleLen);
	const padding = " ".repeat(paddingNeeded);

	// Apply background to content + padding
	const withPadding = line + padding;
	return bgFn(withPadding);
}

interface WidthTruncationScan {
	prefix: string;
	prefixWidth: number;
	pendingAnsi: string;
	visibleWidth: number;
	keepingPrefix: boolean;
	overflowed: boolean;
	exhaustedInput: boolean;
}

function createWidthTruncationScan(): WidthTruncationScan {
	return {
		prefix: "",
		prefixWidth: 0,
		pendingAnsi: "",
		visibleWidth: 0,
		keepingPrefix: true,
		overflowed: false,
		exhaustedInput: false,
	};
}

function appendWidthTruncationFragment(
	state: WidthTruncationScan,
	fragment: string,
	fragmentWidth: number,
	targetWidth: number,
	maxWidth: number,
): boolean {
	if (state.keepingPrefix && state.prefixWidth + fragmentWidth <= targetWidth) {
		state.prefix += state.pendingAnsi + fragment;
		state.pendingAnsi = "";
		state.prefixWidth += fragmentWidth;
	} else {
		state.keepingPrefix = false;
		state.pendingAnsi = "";
	}
	state.visibleWidth += fragmentWidth;
	if (state.visibleWidth <= maxWidth) return true;
	state.overflowed = true;
	return false;
}

function scanTruncationGraphemes(
	text: string,
	state: WidthTruncationScan,
	targetWidth: number,
	maxWidth: number,
): boolean {
	for (const { segment } of graphemeSegmenter.segment(text)) {
		if (!appendWidthTruncationFragment(state, segment, graphemeWidth(segment), targetWidth, maxWidth)) return false;
	}
	return true;
}

function scanPlainTextForTruncation(text: string, targetWidth: number, maxWidth: number): WidthTruncationScan {
	const state = createWidthTruncationScan();
	state.exhaustedInput = scanTruncationGraphemes(text, state, targetWidth, maxWidth);
	return state;
}

function scanStyledTextForTruncation(text: string, targetWidth: number, maxWidth: number): WidthTruncationScan {
	const state = createWidthTruncationScan();
	let index = 0;
	while (index < text.length) {
		const ansi = extractAnsiCode(text, index);
		if (ansi) {
			state.pendingAnsi += ansi.code;
			index += ansi.length;
			continue;
		}
		if (text[index] === "\t") {
			if (!appendWidthTruncationFragment(state, "\t", 3, targetWidth, maxWidth)) break;
			index++;
			continue;
		}

		let end = index;
		while (end < text.length && text[end] !== "\t" && !extractAnsiCode(text, end)) end++;
		if (!scanTruncationGraphemes(text.slice(index, end), state, targetWidth, maxWidth)) break;
		index = end;
	}
	state.exhaustedInput = index >= text.length;
	return state;
}

function truncateWithOversizedEllipsis(
	text: string,
	maxWidth: number,
	ellipsis: string,
	ellipsisWidth: number,
	pad: boolean,
): string | undefined {
	if (ellipsisWidth < maxWidth) return undefined;
	const textWidth = visibleWidth(text);
	if (textWidth <= maxWidth) return pad ? text + " ".repeat(maxWidth - textWidth) : text;
	const clippedEllipsis = truncateFragmentToWidth(ellipsis, maxWidth);
	if (clippedEllipsis.width === 0) return pad ? " ".repeat(maxWidth) : "";
	return finalizeTruncatedResult("", 0, clippedEllipsis.text, clippedEllipsis.width, maxWidth, pad);
}

function truncatePrintableAscii(
	text: string,
	maxWidth: number,
	ellipsis: string,
	ellipsisWidth: number,
	pad: boolean,
): string | undefined {
	if (!isPrintableAscii(text)) return undefined;
	if (text.length <= maxWidth) return pad ? text + " ".repeat(maxWidth - text.length) : text;
	const targetWidth = maxWidth - ellipsisWidth;
	return finalizeTruncatedResult(text.slice(0, targetWidth), targetWidth, ellipsis, ellipsisWidth, maxWidth, pad);
}

function truncateMeasuredText(
	text: string,
	maxWidth: number,
	ellipsis: string,
	ellipsisWidth: number,
	pad: boolean,
): string {
	const targetWidth = maxWidth - ellipsisWidth;
	const scan =
		text.includes("\x1b") || text.includes("\t")
			? scanStyledTextForTruncation(text, targetWidth, maxWidth)
			: scanPlainTextForTruncation(text, targetWidth, maxWidth);
	if (!scan.overflowed && scan.exhaustedInput) {
		return pad ? text + " ".repeat(Math.max(0, maxWidth - scan.visibleWidth)) : text;
	}
	return finalizeTruncatedResult(scan.prefix, scan.prefixWidth, ellipsis, ellipsisWidth, maxWidth, pad);
}

/**
 * Truncate text to fit within a maximum visible width, adding ellipsis if needed.
 * Optionally pad with spaces to reach exactly maxWidth.
 * Properly handles ANSI escape codes (they don't count toward width).
 *
 * @param text - Text to truncate (may contain ANSI codes)
 * @param maxWidth - Maximum visible width
 * @param ellipsis - Ellipsis string to append when truncating (default: "...")
 * @param pad - If true, pad result with spaces to exactly maxWidth (default: false)
 * @returns Truncated text, optionally padded to exactly maxWidth
 */
export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsis: string = "...",
	pad: boolean = false,
): string {
	if (maxWidth <= 0) return "";
	if (text.length === 0) return pad ? " ".repeat(maxWidth) : "";

	const ellipsisWidth = visibleWidth(ellipsis);
	const oversizedEllipsis = truncateWithOversizedEllipsis(text, maxWidth, ellipsis, ellipsisWidth, pad);
	if (oversizedEllipsis !== undefined) return oversizedEllipsis;
	const printableAscii = truncatePrintableAscii(text, maxWidth, ellipsis, ellipsisWidth, pad);
	if (printableAscii !== undefined) return printableAscii;
	return truncateMeasuredText(text, maxWidth, ellipsis, ellipsisWidth, pad);
}

/**
 * Extract a range of visible columns from a line. Handles ANSI codes and wide chars.
 * @param strict - If true, exclude wide chars at boundary that would extend past the range
 */
export function sliceByColumn(line: string, startCol: number, length: number, strict = false): string {
	return sliceWithWidth(line, startCol, length, strict).text;
}

interface TerminalColumnSliceState extends TerminalTextFragment {
	currentColumn: number;
	pendingAnsi: string;
}

function appendAnsiToColumnSlice(
	state: TerminalColumnSliceState,
	ansi: string,
	startColumn: number,
	endColumn: number,
): void {
	if (state.currentColumn >= startColumn && state.currentColumn < endColumn) state.text += ansi;
	else if (state.currentColumn < startColumn) state.pendingAnsi += ansi;
}

function appendGraphemeToColumnSlice(
	state: TerminalColumnSliceState,
	grapheme: string,
	graphemeWidth: number,
	startColumn: number,
	endColumn: number,
	strict: boolean,
): void {
	if (state.currentColumn < startColumn || state.currentColumn >= endColumn) return;
	if (strict && state.currentColumn + graphemeWidth > endColumn) return;
	if (state.pendingAnsi) {
		state.text += state.pendingAnsi;
		state.pendingAnsi = "";
	}
	state.text += grapheme;
	state.width += graphemeWidth;
}

/** Like sliceByColumn but also returns the actual visible width of the result. */
export function sliceWithWidth(line: string, startCol: number, length: number, strict = false): TerminalTextFragment {
	if (length <= 0) return { text: "", width: 0 };
	const endColumn = startCol + length;
	const state: TerminalColumnSliceState = { text: "", width: 0, currentColumn: 0, pendingAnsi: "" };
	for (const segment of iterateAnsiTextSegments(line)) {
		if (segment.type === "ansi") {
			appendAnsiToColumnSlice(state, segment.value, startCol, endColumn);
			continue;
		}
		const width = graphemeWidth(segment.value);
		appendGraphemeToColumnSlice(state, segment.value, width, startCol, endColumn, strict);
		state.currentColumn += width;
		if (state.currentColumn >= endColumn) break;
	}
	return { text: state.text, width: state.width };
}

// Pooled tracker instance for extractSegments (avoids allocation per call)
const pooledStyleTracker = new AnsiCodeTracker();

interface ExtractedLineSegments {
	before: string;
	beforeWidth: number;
	after: string;
	afterWidth: number;
}

interface LineSegmentExtractionContext {
	beforeEnd: number;
	afterStart: number;
	afterEnd: number;
	afterLength: number;
	strictAfter: boolean;
}

interface LineSegmentExtractionState extends ExtractedLineSegments {
	currentColumn: number;
	pendingAnsiBefore: string;
	afterStarted: boolean;
}

function appendAnsiToExtractedSegments(
	state: LineSegmentExtractionState,
	ansiCode: string,
	context: LineSegmentExtractionContext,
): void {
	pooledStyleTracker.process(ansiCode);
	if (state.currentColumn < context.beforeEnd) {
		state.pendingAnsiBefore += ansiCode;
		return;
	}
	if (state.currentColumn >= context.afterStart && state.currentColumn < context.afterEnd && state.afterStarted) {
		state.after += ansiCode;
	}
}

function appendGraphemeToExtractedSegments(
	state: LineSegmentExtractionState,
	grapheme: string,
	graphemeWidth: number,
	context: LineSegmentExtractionContext,
): void {
	if (state.currentColumn < context.beforeEnd && state.currentColumn + graphemeWidth <= context.beforeEnd) {
		state.before += state.pendingAnsiBefore + grapheme;
		state.pendingAnsiBefore = "";
		state.beforeWidth += graphemeWidth;
		return;
	}
	if (state.currentColumn < context.afterStart || state.currentColumn >= context.afterEnd) return;
	if (context.strictAfter && state.currentColumn + graphemeWidth > context.afterEnd) return;
	if (!state.afterStarted) {
		state.after += pooledStyleTracker.getActiveCodes();
		state.afterStarted = true;
	}
	state.after += grapheme;
	state.afterWidth += graphemeWidth;
}

function isLineSegmentExtractionComplete(
	state: LineSegmentExtractionState,
	context: LineSegmentExtractionContext,
): boolean {
	return context.afterLength <= 0 ? state.currentColumn >= context.beforeEnd : state.currentColumn >= context.afterEnd;
}

/**
 * Extract "before" and "after" segments from a line in a single pass.
 * Used for overlay compositing where we need content before and after the overlay region.
 * Preserves styling from before the overlay that should affect content after it.
 */
export function extractSegments(
	line: string,
	beforeEnd: number,
	afterStart: number,
	afterLen: number,
	strictAfter = false,
): ExtractedLineSegments {
	const context: LineSegmentExtractionContext = {
		beforeEnd,
		afterStart,
		afterEnd: afterStart + afterLen,
		afterLength: afterLen,
		strictAfter,
	};
	const state: LineSegmentExtractionState = {
		before: "",
		beforeWidth: 0,
		after: "",
		afterWidth: 0,
		currentColumn: 0,
		pendingAnsiBefore: "",
		afterStarted: false,
	};
	pooledStyleTracker.clear();
	for (const segment of iterateAnsiTextSegments(line)) {
		if (segment.type === "ansi") {
			appendAnsiToExtractedSegments(state, segment.value, context);
			continue;
		}
		const width = graphemeWidth(segment.value);
		appendGraphemeToExtractedSegments(state, segment.value, width, context);
		state.currentColumn += width;
		if (isLineSegmentExtractionComplete(state, context)) break;
	}
	return {
		before: state.before,
		beforeWidth: state.beforeWidth,
		after: state.after,
		afterWidth: state.afterWidth,
	};
}
