/**
 * StdinBuffer buffers input and emits complete sequences.
 *
 * This is necessary because stdin data events can arrive in partial chunks,
 * especially for escape sequences like mouse events. Without buffering,
 * partial sequences can be misinterpreted as regular keypresses.
 *
 * For example, the mouse SGR sequence `\x1b[<35;20;5m` might arrive as:
 * - Event 1: `\x1b`
 * - Event 2: `[<35`
 * - Event 3: `;20;5m`
 *
 * The buffer accumulates these until a complete sequence is detected.
 * Call the `process()` method to feed input data.
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */

import { EventEmitter } from "events";

const ESC = "\x1b";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const ESCAPE_SEQUENCE_PREFIXES = new Set(["[", "]", "O", "P", "_"]);

type SequenceCompletion = "complete" | "incomplete";
type EscapeSequenceCompletion = SequenceCompletion | "not-escape";

/**
 * Check if a string is a complete escape sequence or needs more data
 */
function isCompleteSequence(data: string): EscapeSequenceCompletion {
	if (!data.startsWith(ESC)) {
		return "not-escape";
	}

	if (data.length === 1) {
		return "incomplete";
	}

	const afterEsc = data.slice(1);

	// CSI sequences: ESC [
	if (afterEsc.startsWith("[")) {
		// Check for old-style mouse sequence: ESC[M + 3 bytes
		if (afterEsc.startsWith("[M")) {
			// Old-style mouse needs ESC[M + 3 bytes = 6 total
			return data.length >= 6 ? "complete" : "incomplete";
		}
		return isCompleteCsiSequence(data);
	}

	// OSC sequences: ESC ]
	if (afterEsc.startsWith("]")) {
		return isCompleteOscSequence(data);
	}

	// DCS sequences: ESC P ... ESC \ (includes XTVersion responses)
	if (afterEsc.startsWith("P")) {
		return isCompleteDcsSequence(data);
	}

	// APC sequences: ESC _ ... ESC \ (includes Kitty graphics responses)
	if (afterEsc.startsWith("_")) {
		return isCompleteApcSequence(data);
	}

	// SS3 sequences: ESC O
	if (afterEsc.startsWith("O")) {
		// ESC O followed by a single character
		return afterEsc.length >= 2 ? "complete" : "incomplete";
	}

	// Meta key sequences: ESC followed by a single character
	if (afterEsc.length === 1) {
		return "complete";
	}

	// Unknown escape sequence - treat as complete
	return "complete";
}

/**
 * Check if CSI sequence is complete
 * CSI sequences: ESC [ ... followed by a final byte (0x40-0x7E)
 */
function getSgrMouseSequenceCompletion(payload: string, lastCharacter: string): SequenceCompletion {
	if (/^<\d+;\d+;\d+[Mm]$/.test(payload)) return "complete";
	if (lastCharacter === "M" || lastCharacter === "m") {
		const parts = payload.slice(1, -1).split(";");
		if (parts.length === 3 && parts.every((part) => /^\d+$/.test(part))) return "complete";
	}
	return "incomplete";
}

function isCompleteCsiSequence(data: string): SequenceCompletion {
	if (!data.startsWith(`${ESC}[`)) {
		return "complete";
	}

	// Need at least ESC [ and one more character
	if (data.length < 3) {
		return "incomplete";
	}

	const payload = data.slice(2);

	// CSI sequences end with a byte in the range 0x40-0x7E (@-~)
	// This includes all letters and several special characters
	const lastChar = payload[payload.length - 1];
	const lastCharCode = lastChar.charCodeAt(0);

	if (lastCharCode < 0x40 || lastCharCode > 0x7e) return "incomplete";

	// Special handling for SGR mouse sequences: ESC[<B;X;Ym or ESC[<B;X;YM
	if (payload.startsWith("<")) return getSgrMouseSequenceCompletion(payload, lastChar);

	return "complete";
}

/**
 * Check if OSC sequence is complete
 * OSC sequences: ESC ] ... ST (where ST is ESC \ or BEL)
 */
function isCompleteOscSequence(data: string): SequenceCompletion {
	if (!data.startsWith(`${ESC}]`)) {
		return "complete";
	}

	// OSC sequences end with ST (ESC \) or BEL (\x07)
	if (data.endsWith(`${ESC}\\`) || data.endsWith("\x07")) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Check if DCS (Device Control String) sequence is complete
 * DCS sequences: ESC P ... ST (where ST is ESC \)
 * Used for XTVersion responses like ESC P >| ... ESC \
 */
function isCompleteDcsSequence(data: string): SequenceCompletion {
	if (!data.startsWith(`${ESC}P`)) {
		return "complete";
	}

	// DCS sequences end with ST (ESC \)
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Check if APC (Application Program Command) sequence is complete
 * APC sequences: ESC _ ... ST (where ST is ESC \)
 * Used for Kitty graphics responses like ESC _ G ... ESC \
 */
function isCompleteApcSequence(data: string): SequenceCompletion {
	if (!data.startsWith(`${ESC}_`)) {
		return "complete";
	}

	// APC sequences end with ST (ESC \)
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Split accumulated buffer into complete sequences
 */
function parseUnmodifiedKittyPrintableCodepoint(sequence: string): number | undefined {
	const match = sequence.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/);
	if (!match) return undefined;

	const codepoint = parseInt(match[1]!, 10);
	return codepoint >= 32 ? codepoint : undefined;
}

interface EscapeSequenceExtraction {
	completion: SequenceCompletion;
	sequence: string;
	consumed: number;
}

interface ExtractedSequences {
	sequences: string[];
	remainder: string;
}

function shouldSplitAdjacentEscapeSequence(candidate: string, nextCharacter: string | undefined): boolean {
	return candidate === `${ESC}${ESC}` && nextCharacter !== undefined && ESCAPE_SEQUENCE_PREFIXES.has(nextCharacter);
}

function extractEscapeSequence(remaining: string): EscapeSequenceExtraction {
	let sequenceEnd = 1;
	while (sequenceEnd <= remaining.length) {
		const candidate = remaining.slice(0, sequenceEnd);
		const status = isCompleteSequence(candidate);
		if (status === "incomplete") {
			sequenceEnd++;
			continue;
		}
		if (status === "complete" && shouldSplitAdjacentEscapeSequence(candidate, remaining[sequenceEnd])) {
			return { completion: "complete", sequence: ESC, consumed: 1 };
		}
		return { completion: "complete", sequence: candidate, consumed: sequenceEnd };
	}
	return { completion: "incomplete", sequence: "", consumed: 0 };
}

function extractCompleteSequences(buffer: string): ExtractedSequences {
	const sequences: string[] = [];
	let position = 0;

	while (position < buffer.length) {
		const remaining = buffer.slice(position);
		if (!remaining.startsWith(ESC)) {
			sequences.push(remaining[0]!);
			position++;
			continue;
		}

		const extraction = extractEscapeSequence(remaining);
		if (extraction.completion === "incomplete") return { sequences, remainder: remaining };
		sequences.push(extraction.sequence);
		position += extraction.consumed;
	}

	return { sequences, remainder: "" };
}

export type StdinBufferOptions = {
	/**
	 * Maximum time to wait for sequence completion (default: 10ms)
	 * After this time, the buffer is flushed even if incomplete
	 */
	timeout?: number;
};

export type StdinBufferEventMap = {
	data: [string];
	paste: [string];
};

/**
 * Buffers stdin input and emits complete sequences via the 'data' event.
 * Handles partial escape sequences that arrive across multiple chunks.
 */
export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	private buffer: string = "";
	private timeout: ReturnType<typeof setTimeout> | null = null;
	private readonly timeoutMs: number;
	private pasteMode: boolean = false;
	private pasteBuffer: string = "";
	private pendingKittyPrintableCodepoint: number | undefined;

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.timeoutMs = options.timeout ?? 10;
	}

	private clearPendingTimeout(): void {
		if (!this.timeout) return;
		clearTimeout(this.timeout);
		this.timeout = null;
	}

	private decodeInputChunk(data: string | Buffer): string {
		if (!Buffer.isBuffer(data)) return data;
		if (data.length !== 1 || data[0]! <= 127) return data.toString();
		return `${ESC}${String.fromCharCode(data[0]! - 128)}`;
	}

	private emitDataSequences(sequences: readonly string[]): void {
		for (const sequence of sequences) this.emitDataSequence(sequence);
	}

	private finishBracketedPasteIfComplete(): void {
		const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
		if (endIndex === -1) return;
		const pastedContent = this.pasteBuffer.slice(0, endIndex);
		const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);
		this.pasteMode = false;
		this.pasteBuffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
		this.emit("paste", pastedContent);
		if (remaining.length > 0) this.process(remaining);
	}

	private continueBracketedPaste(): void {
		this.pasteBuffer += this.buffer;
		this.buffer = "";
		this.finishBracketedPasteIfComplete();
	}

	private beginBracketedPaste(startIndex: number): void {
		if (startIndex > 0) {
			const beforePaste = this.buffer.slice(0, startIndex);
			this.emitDataSequences(extractCompleteSequences(beforePaste).sequences);
		}
		this.pendingKittyPrintableCodepoint = undefined;
		this.buffer = this.buffer.slice(startIndex + BRACKETED_PASTE_START.length);
		this.pasteMode = true;
		this.pasteBuffer = this.buffer;
		this.buffer = "";
		this.finishBracketedPasteIfComplete();
	}

	private emitCompleteBufferedSequences(): void {
		const result = extractCompleteSequences(this.buffer);
		this.buffer = result.remainder;
		this.emitDataSequences(result.sequences);
	}

	private scheduleIncompleteSequenceFlush(): void {
		if (this.buffer.length === 0) return;
		this.timeout = setTimeout(() => this.emitDataSequences(this.flush()), this.timeoutMs);
	}

	public process(data: string | Buffer): void {
		this.clearPendingTimeout();
		const chunk = this.decodeInputChunk(data);
		if (chunk.length === 0 && this.buffer.length === 0) {
			this.emitDataSequence("");
			return;
		}
		this.buffer += chunk;

		if (this.pasteMode) {
			this.continueBracketedPaste();
			return;
		}
		const pasteStartIndex = this.buffer.indexOf(BRACKETED_PASTE_START);
		if (pasteStartIndex !== -1) {
			this.beginBracketedPaste(pasteStartIndex);
			return;
		}

		this.emitCompleteBufferedSequences();
		this.scheduleIncompleteSequenceFlush();
	}

	private emitDataSequence(sequence: string): void {
		const rawCodepoint = sequence.length === 1 ? sequence.codePointAt(0) : undefined;
		if (rawCodepoint !== undefined && rawCodepoint === this.pendingKittyPrintableCodepoint) {
			this.pendingKittyPrintableCodepoint = undefined;
			return;
		}

		this.pendingKittyPrintableCodepoint = parseUnmodifiedKittyPrintableCodepoint(sequence);
		this.emit("data", sequence);
	}

	flush(): string[] {
		this.clearPendingTimeout();

		if (this.buffer.length === 0) {
			return [];
		}

		const sequences = [this.buffer];
		this.buffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
		return sequences;
	}

	clear(): void {
		this.clearPendingTimeout();
		this.buffer = "";
		this.pasteMode = false;
		this.pasteBuffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
	}

	getBuffer(): string {
		return this.buffer;
	}

	destroy(): void {
		this.clear();
	}
}
