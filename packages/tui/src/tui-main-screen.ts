import * as fs from "node:fs";
import * as path from "node:path";
import { deleteKittyImage, isImageLine } from "./terminal-image.ts";
import { type RenderedCursorPosition, type TUI, TuiBase, type TuiStopOptions } from "./tui.ts";
import { visibleWidth } from "./utils.ts";

const KITTY_SEQUENCE_PREFIX = "\x1b_G";

interface KittyImageHeader {
	ids: number[];
	rows: number;
}

interface ChangedLineRange {
	firstChanged: number;
	lastChanged: number;
}

interface ChangedContentRange extends ChangedLineRange {
	appendStart: boolean;
}

interface MainScreenRenderFrame {
	width: number;
	height: number;
	widthChanged: boolean;
	heightChanged: boolean;
	newLines: string[];
	cursorPosition: RenderedCursorPosition | null;
	previousViewportTop: number;
}

interface ChangedLinesRenderResult {
	buffer: string;
	renderEnd: number;
}

function parseKittyImageHeader(line: string): KittyImageHeader | undefined {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return undefined;
	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return undefined;

	const ids: number[] = [];
	let rows = 1;
	for (const param of line.slice(paramsStart, paramsEnd).split(",")) {
		const [key, value] = param.split("=", 2);
		if (value === undefined) continue;
		const numberValue = Number(value);
		if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > 0xffffffff) continue;
		if (key === "i") ids.push(numberValue);
		else if (key === "r") rows = numberValue;
	}
	return { ids, rows };
}

function extractKittyImageIds(line: string): number[] {
	return parseKittyImageHeader(line)?.ids ?? [];
}

function extractKittyImageRows(line: string): number {
	return parseKittyImageHeader(line)?.rows ?? 1;
}

function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
}

export interface TuiMainScreenRenderState {
	previousLines: string[];
	previousWidth: number;
	previousHeight: number;
	cursorRow: number;
	hardwareCursorRow: number;
	maxLinesRendered: number;
	previousViewportTop: number;
}

/** TUI implementation that renders into the terminal's main screen and scrollback. */
export class TuiMainScreen extends TuiBase implements TUI {
	readonly mode = "regular" as const;
	private previousLines: string[] = [];
	private previousKittyImageIds = new Set<number>();
	private previousWidth = 0;
	private previousHeight = 0;
	private cursorRow = 0;
	private hardwareCursorRow = 0;
	private maxLinesRendered = 0;
	private previousViewportTop = 0;

	captureRenderState(): TuiMainScreenRenderState {
		return {
			previousLines: [...this.previousLines],
			previousWidth: this.previousWidth,
			previousHeight: this.previousHeight,
			cursorRow: this.cursorRow,
			hardwareCursorRow: this.hardwareCursorRow,
			maxLinesRendered: this.maxLinesRendered,
			previousViewportTop: this.previousViewportTop,
		};
	}

	restoreRenderState(state: TuiMainScreenRenderState): void {
		this.previousLines = state.previousLines.map((line) => (isImageLine(line) ? "" : line));
		this.previousKittyImageIds = new Set();
		this.previousWidth = state.previousWidth;
		this.previousHeight = state.previousHeight;
		this.cursorRow = state.cursorRow;
		this.hardwareCursorRow = state.hardwareCursorRow;
		this.maxLinesRendered = state.maxLinesRendered;
		this.previousViewportTop = state.previousViewportTop;
	}

	protected override resetRenderState(): void {
		this.previousLines = [];
		this.previousWidth = -1;
		this.previousHeight = -1;
		this.cursorRow = 0;
		this.hardwareCursorRow = 0;
		this.maxLinesRendered = 0;
		this.previousViewportTop = 0;
	}

	protected override beforeTerminalStop(options?: TuiStopOptions): void {
		if (options?.preserveScreen || this.previousLines.length === 0) return;
		this.terminal.write(" ");
		const targetRow = this.previousLines.length;
		const lineDiff = targetRow - this.hardwareCursorRow;
		if (lineDiff > 0) this.terminal.write(`\x1b[${lineDiff}B`);
		else if (lineDiff < 0) this.terminal.write(`\x1b[${-lineDiff}A`);
		this.terminal.write("\r\n");
	}

	private collectKittyImageIds(lines: string[]): Set<number> {
		const ids = new Set<number>();
		for (const line of lines) {
			for (const id of extractKittyImageIds(line)) {
				ids.add(id);
			}
		}
		return ids;
	}

	private deleteKittyImages(ids: Iterable<number>): string {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	private getKittyImageReservedRows(lines: string[], index: number, maxIndex = lines.length - 1): number {
		const rows = extractKittyImageRows(lines[index] ?? "");
		if (rows <= 1) return 1;

		const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
		let reservedRows = 1;
		while (reservedRows < maxRows) {
			const line = lines[index + reservedRows] ?? "";
			if (isImageLine(line) || visibleWidth(line) > 0) break;
			reservedRows++;
		}
		return reservedRows;
	}

	private expandChangedRangeForKittyImages(
		firstChanged: number,
		lastChanged: number,
		newLines: string[],
	): ChangedLineRange {
		let expandedFirstChanged = firstChanged;
		let expandedLastChanged = lastChanged;
		const expandForLines = (lines: string[]): void => {
			for (let i = 0; i < lines.length; i++) {
				if (extractKittyImageIds(lines[i]).length === 0) continue;
				const blockEnd = i + this.getKittyImageReservedRows(lines, i) - 1;
				if (i >= firstChanged || (i <= lastChanged && blockEnd >= firstChanged)) {
					expandedFirstChanged = Math.min(expandedFirstChanged, i);
					expandedLastChanged = Math.max(expandedLastChanged, blockEnd);
				}
			}
		};

		expandForLines(this.previousLines);
		expandForLines(newLines);
		return { firstChanged: expandedFirstChanged, lastChanged: expandedLastChanged };
	}

	private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
		if (firstChanged < 0 || lastChanged < firstChanged) return "";

		const ids = new Set<number>();
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		for (let i = firstChanged; i <= maxLine; i++) {
			for (const id of extractKittyImageIds(this.previousLines[i] ?? "")) {
				ids.add(id);
			}
		}

		return this.deleteKittyImages(ids);
	}

	private prepareRenderFrame(): MainScreenRenderFrame {
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
		const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		const previousViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;

		let newLines = this.render(width);
		if (this.hasOverlayEntries) newLines = this.compositeOverlays(newLines, width, height);
		const cursorPosition = this.extractCursorPosition(newLines, height);
		newLines = this.applyLineResets(newLines);
		return { width, height, widthChanged, heightChanged, newLines, cursorPosition, previousViewportTop };
	}

	private getLineDiff(
		targetRow: number,
		hardwareCursorRow: number,
		previousViewportTop: number,
		viewportTop: number,
	): number {
		const currentScreenRow = hardwareCursorRow - previousViewportTop;
		const targetScreenRow = targetRow - viewportTop;
		return targetScreenRow - currentScreenRow;
	}

	private logFullRedraw(frame: MainScreenRenderFrame, reason: string): void {
		if (process.env.PI_DEBUG_REDRAW !== "1") return;
		const logPath = path.join(this.logDirectory, "pi-debug.log");
		const message = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${frame.newLines.length}, height=${frame.height})\n`;
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		fs.appendFileSync(logPath, message);
	}

	private renderFullFrame(frame: MainScreenRenderFrame, clear: boolean): void {
		this.fullRedrawCount += 1;
		let buffer = "\x1b[?2026h";
		if (clear) {
			buffer += this.deleteKittyImages(this.previousKittyImageIds);
			buffer += "\x1b[2J\x1b[H\x1b[3J";
		}
		for (let index = 0; index < frame.newLines.length; index++) {
			if (index > 0) buffer += "\r\n";
			const line = frame.newLines[index];
			const reservedRows = isImageLine(line) ? this.getKittyImageReservedRows(frame.newLines, index) : 1;
			if (reservedRows > 1 && reservedRows <= frame.height) {
				buffer += "\r\n".repeat(reservedRows - 1);
				buffer += `\x1b[${reservedRows - 1}A${line}\x1b[${reservedRows - 1}B`;
				index += reservedRows - 1;
				continue;
			}
			buffer += line;
		}
		buffer += "\x1b[?2026l";
		this.terminal.write(buffer);
		this.cursorRow = Math.max(0, frame.newLines.length - 1);
		this.hardwareCursorRow = this.cursorRow;
		this.maxLinesRendered = clear ? frame.newLines.length : Math.max(this.maxLinesRendered, frame.newLines.length);
		const bufferLength = Math.max(frame.height, frame.newLines.length);
		this.previousViewportTop = Math.max(0, bufferLength - frame.height);
		this.positionHardwareCursor(frame.cursorPosition, frame.newLines.length);
		this.previousLines = frame.newLines;
		this.previousKittyImageIds = this.collectKittyImageIds(frame.newLines);
		this.previousWidth = frame.width;
		this.previousHeight = frame.height;
	}

	private renderRequiredFullFrame(frame: MainScreenRenderFrame): boolean {
		if (this.previousLines.length === 0 && !frame.widthChanged && !frame.heightChanged) {
			this.logFullRedraw(frame, "first render");
			this.renderFullFrame(frame, false);
			return true;
		}
		if (frame.widthChanged) {
			this.logFullRedraw(frame, `terminal width changed (${this.previousWidth} -> ${frame.width})`);
			this.renderFullFrame(frame, true);
			return true;
		}
		if (frame.heightChanged && !isTermuxSession()) {
			this.logFullRedraw(frame, `terminal height changed (${this.previousHeight} -> ${frame.height})`);
			this.renderFullFrame(frame, true);
			return true;
		}
		if (this.getClearOnShrink() && frame.newLines.length < this.maxLinesRendered && !this.hasOverlayEntries) {
			this.logFullRedraw(frame, `clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			this.renderFullFrame(frame, true);
			return true;
		}
		return false;
	}

	private findChangedContent(frame: MainScreenRenderFrame): ChangedContentRange | undefined {
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(frame.newLines.length, this.previousLines.length);
		for (let index = 0; index < maxLines; index++) {
			const oldLine = index < this.previousLines.length ? this.previousLines[index] : "";
			const newLine = index < frame.newLines.length ? frame.newLines[index] : "";
			if (oldLine === newLine) continue;
			if (firstChanged === -1) firstChanged = index;
			lastChanged = index;
		}

		const appendedLines = frame.newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) firstChanged = this.previousLines.length;
			lastChanged = frame.newLines.length - 1;
		}
		if (firstChanged === -1) return undefined;

		const expanded = this.expandChangedRangeForKittyImages(firstChanged, lastChanged, frame.newLines);
		return {
			...expanded,
			appendStart: appendedLines && expanded.firstChanged === this.previousLines.length && expanded.firstChanged > 0,
		};
	}

	private commitFrameHistory(frame: MainScreenRenderFrame, viewportTop: number): void {
		this.previousLines = frame.newLines;
		this.previousKittyImageIds = this.collectKittyImageIds(frame.newLines);
		this.previousWidth = frame.width;
		this.previousHeight = frame.height;
		this.previousViewportTop = viewportTop;
	}

	private handleUnchangedFrame(frame: MainScreenRenderFrame): void {
		this.positionHardwareCursor(frame.cursorPosition, frame.newLines.length);
		this.previousViewportTop = frame.previousViewportTop;
		this.previousHeight = frame.height;
	}

	private renderDeletedContent(frame: MainScreenRenderFrame, range: ChangedContentRange): void {
		if (this.previousLines.length <= frame.newLines.length) {
			this.positionHardwareCursor(frame.cursorPosition, frame.newLines.length);
			this.commitFrameHistory(frame, frame.previousViewportTop);
			return;
		}

		let buffer = "\x1b[?2026h";
		buffer += this.deleteChangedKittyImages(range.firstChanged, range.lastChanged);
		const targetRow = Math.max(0, frame.newLines.length - 1);
		if (targetRow < frame.previousViewportTop) {
			this.logFullRedraw(frame, `deleted lines moved viewport up (${targetRow} < ${frame.previousViewportTop})`);
			this.renderFullFrame(frame, true);
			return;
		}
		const lineDiff = this.getLineDiff(
			targetRow,
			this.hardwareCursorRow,
			frame.previousViewportTop,
			frame.previousViewportTop,
		);
		if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
		else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
		buffer += "\r";
		const extraLines = this.previousLines.length - frame.newLines.length;
		if (extraLines > frame.height) {
			this.logFullRedraw(frame, `extraLines > height (${extraLines} > ${frame.height})`);
			this.renderFullFrame(frame, true);
			return;
		}
		const clearStartOffset = frame.newLines.length === 0 ? 0 : 1;
		if (extraLines > 0 && clearStartOffset > 0) buffer += `\x1b[${clearStartOffset}B`;
		for (let index = 0; index < extraLines; index++) {
			buffer += "\r\x1b[2K";
			if (index < extraLines - 1) buffer += "\x1b[1B";
		}
		const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
		if (moveBack > 0) buffer += `\x1b[${moveBack}A`;
		buffer += "\x1b[?2026l";
		this.terminal.write(buffer);
		this.cursorRow = targetRow;
		this.hardwareCursorRow = targetRow;
		this.positionHardwareCursor(frame.cursorPosition, frame.newLines.length);
		this.commitFrameHistory(frame, frame.previousViewportTop);
	}

	private assertRenderedLineFits(line: string, index: number, frame: MainScreenRenderFrame): void {
		if (isImageLine(line) || visibleWidth(line) <= frame.width) return;
		const crashLogPath = path.join(this.logDirectory, "pi-crash.log");
		const crashData = [
			`Crash at ${new Date().toISOString()}`,
			`Terminal width: ${frame.width}`,
			`Line ${index} visible width: ${visibleWidth(line)}`,
			"",
			"=== All rendered lines ===",
			...frame.newLines.map(
				(renderedLine, lineIndex) => `[${lineIndex}] (w=${visibleWidth(renderedLine)}) ${renderedLine}`,
			),
			"",
		].join("\n");
		fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
		fs.writeFileSync(crashLogPath, crashData);
		this.stop();
		throw new Error(
			[
				`Rendered line ${index} exceeds terminal width (${visibleWidth(line)} > ${frame.width}).`,
				"",
				"This is likely caused by a custom TUI component not truncating its output.",
				"Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
				"",
				`Debug log written to: ${crashLogPath}`,
			].join("\n"),
		);
	}

	private renderChangedLines(
		frame: MainScreenRenderFrame,
		range: ChangedContentRange,
		viewportTop: number,
		initialBuffer: string,
	): ChangedLinesRenderResult | undefined {
		let buffer = initialBuffer;
		const renderEnd = Math.min(range.lastChanged, frame.newLines.length - 1);
		for (let index = range.firstChanged; index <= renderEnd; index++) {
			if (index > range.firstChanged) buffer += "\r\n";
			const line = frame.newLines[index];
			const reservedRows = isImageLine(line) ? this.getKittyImageReservedRows(frame.newLines, index, renderEnd) : 1;
			if (reservedRows > 1) {
				const imageStartScreenRow = index - viewportTop;
				if (imageStartScreenRow < 0 || imageStartScreenRow + reservedRows > frame.height) {
					this.logFullRedraw(
						frame,
						`kitty image pre-clear would scroll (${imageStartScreenRow} + ${reservedRows} > ${frame.height})`,
					);
					this.renderFullFrame(frame, true);
					return undefined;
				}
				buffer += "\x1b[2K";
				for (let row = 1; row < reservedRows; row++) buffer += "\r\n\x1b[2K";
				buffer += `\x1b[${reservedRows - 1}A${line}\x1b[${reservedRows - 1}B`;
				index += reservedRows - 1;
				continue;
			}
			buffer += "\x1b[2K";
			this.assertRenderedLineFits(line, index, frame);
			buffer += line;
		}
		return { buffer, renderEnd };
	}

	private writeDifferentialDebugLog(
		frame: MainScreenRenderFrame,
		range: ChangedContentRange,
		viewportTop: number,
		hardwareCursorRow: number,
		lineDiff: number,
		renderEnd: number,
		finalCursorRow: number,
		buffer: string,
	): void {
		if (process.env.PI_TUI_DEBUG !== "1") return;
		const debugDir = "/tmp/tui";
		fs.mkdirSync(debugDir, { recursive: true });
		const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
		const debugData = [
			`firstChanged: ${range.firstChanged}`,
			`viewportTop: ${viewportTop}`,
			`cursorRow: ${this.cursorRow}`,
			`height: ${frame.height}`,
			`lineDiff: ${lineDiff}`,
			`hardwareCursorRow: ${hardwareCursorRow}`,
			`renderEnd: ${renderEnd}`,
			`finalCursorRow: ${finalCursorRow}`,
			`cursorPos: ${JSON.stringify(frame.cursorPosition)}`,
			`newLines.length: ${frame.newLines.length}`,
			`previousLines.length: ${this.previousLines.length}`,
			"",
			"=== newLines ===",
			JSON.stringify(frame.newLines, null, 2),
			"",
			"=== previousLines ===",
			JSON.stringify(this.previousLines, null, 2),
			"",
			"=== buffer ===",
			JSON.stringify(buffer),
		].join("\n");
		fs.writeFileSync(debugPath, debugData);
	}

	private renderDifferentialContent(frame: MainScreenRenderFrame, range: ChangedContentRange): void {
		if (range.firstChanged < frame.previousViewportTop) {
			this.logFullRedraw(frame, `firstChanged < viewportTop (${range.firstChanged} < ${frame.previousViewportTop})`);
			this.renderFullFrame(frame, true);
			return;
		}

		let previousViewportTop = frame.previousViewportTop;
		let viewportTop = previousViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		let buffer = `\x1b[?2026h${this.deleteChangedKittyImages(range.firstChanged, range.lastChanged)}`;
		const previousViewportBottom = previousViewportTop + frame.height - 1;
		const moveTargetRow = range.appendStart ? range.firstChanged - 1 : range.firstChanged;
		if (moveTargetRow > previousViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(frame.height - 1, hardwareCursorRow - previousViewportTop));
			const moveToBottom = frame.height - 1 - currentScreenRow;
			if (moveToBottom > 0) buffer += `\x1b[${moveToBottom}B`;
			const scroll = moveTargetRow - previousViewportBottom;
			buffer += "\r\n".repeat(scroll);
			previousViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		const lineDiff = this.getLineDiff(moveTargetRow, hardwareCursorRow, previousViewportTop, viewportTop);
		if (lineDiff > 0) buffer += `\x1b[${lineDiff}B`;
		else if (lineDiff < 0) buffer += `\x1b[${-lineDiff}A`;
		buffer += range.appendStart ? "\r\n" : "\r";

		const changedLines = this.renderChangedLines(frame, range, viewportTop, buffer);
		if (!changedLines) return;
		buffer = changedLines.buffer;
		let finalCursorRow = changedLines.renderEnd;
		if (this.previousLines.length > frame.newLines.length) {
			if (changedLines.renderEnd < frame.newLines.length - 1) {
				const moveDown = frame.newLines.length - 1 - changedLines.renderEnd;
				buffer += `\x1b[${moveDown}B`;
				finalCursorRow = frame.newLines.length - 1;
			}
			const extraLines = this.previousLines.length - frame.newLines.length;
			for (let index = frame.newLines.length; index < this.previousLines.length; index++) {
				buffer += "\r\n\x1b[2K";
			}
			buffer += `\x1b[${extraLines}A`;
		}
		buffer += "\x1b[?2026l";

		this.writeDifferentialDebugLog(
			frame,
			range,
			viewportTop,
			hardwareCursorRow,
			lineDiff,
			changedLines.renderEnd,
			finalCursorRow,
			buffer,
		);
		this.terminal.write(buffer);
		this.cursorRow = Math.max(0, frame.newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		this.maxLinesRendered = Math.max(this.maxLinesRendered, frame.newLines.length);
		const committedViewportTop = Math.max(previousViewportTop, finalCursorRow - frame.height + 1);
		this.positionHardwareCursor(frame.cursorPosition, frame.newLines.length);
		this.commitFrameHistory(frame, committedViewportTop);
	}

	protected doRender(): void {
		if (this.stopped) return;
		const frame = this.prepareRenderFrame();
		if (this.renderRequiredFullFrame(frame)) return;
		const changedContent = this.findChangedContent(frame);
		if (!changedContent) {
			this.handleUnchangedFrame(frame);
			return;
		}
		if (changedContent.firstChanged >= frame.newLines.length) {
			this.renderDeletedContent(frame, changedContent);
			return;
		}
		this.renderDifferentialContent(frame, changedContent);
	}

	/**
	 * Position the hardware cursor for IME candidate window.
	 * @param cursorPos The cursor position extracted from rendered output, or null
	 * @param totalLines Total number of rendered lines
	 */
	private positionHardwareCursor(cursorPos: RenderedCursorPosition | null, totalLines: number): void {
		if (!cursorPos || totalLines <= 0) {
			this.terminal.hideCursor();
			return;
		}

		// Clamp cursor position to valid range
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		// Move cursor from current position to target
		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		buffer += `\x1b[${targetCol + 1}G`;

		if (buffer) {
			this.terminal.write(buffer);
		}

		this.hardwareCursorRow = targetRow;
		if (this.getShowHardwareCursor()) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
	}
}
