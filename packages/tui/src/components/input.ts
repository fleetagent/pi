import { getKeybindings, type KeybindingsManager } from "../keybindings.ts";
import { decodeKittyPrintable } from "../keys.ts";
import { KillRing } from "../kill-ring.ts";
import { type Component, CURSOR_MARKER, type Focusable } from "../tui.ts";
import { UndoStack } from "../undo-stack.ts";
import { getGraphemeSegmenter, isWhitespaceChar, sliceByColumn, visibleWidth } from "../utils.ts";
import { findWordBackward, findWordForward } from "../word-navigation.ts";
import type { PasteInputResult } from "./editor.ts";

const segmenter = getGraphemeSegmenter();

interface InputState {
	value: string;
	cursor: number;
}

interface InputVisibleWindow {
	text: string;
	cursor: number;
}

type InputAction = "kill" | "yank" | "type-word";
/**
 * Input component - single-line text input with horizontal scrolling
 */
export class Input implements Component, Focusable {
	private value: string = "";
	private cursor: number = 0; // Cursor position in the value
	public onSubmit?: (value: string) => void;
	public onEscape?: () => void;

	/** Focusable interface - set by TUI when focus changes */
	focused: boolean = false;

	// Bracketed paste mode buffering
	private pasteBuffer: string = "";
	private isInPaste: boolean = false;

	// Kill ring for Emacs-style kill/yank operations
	private killRing = new KillRing();
	private lastAction: InputAction | null = null;

	// Undo support
	private undoStack = new UndoStack<InputState>();

	getValue(): string {
		return this.value;
	}

	setValue(value: string): void {
		this.value = value;
		this.cursor = Math.min(this.cursor, value.length);
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
		this.handlePaste(pasteContent);
		this.isInPaste = false;
		const trailingInput = this.pasteBuffer.substring(endIndex + 6);
		this.pasteBuffer = "";
		if (trailingInput) this.handleInput(trailingInput);
		return { data: remainingData, consumed: true };
	}

	private handleControlInput(data: string, keybindings: KeybindingsManager): boolean {
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.onEscape?.();
			return true;
		}
		if (keybindings.matches(data, "tui.editor.undo")) {
			this.undo();
			return true;
		}
		if (!keybindings.matches(data, "tui.input.submit") && data !== "\n") return false;
		this.onSubmit?.(this.value);
		return true;
	}

	private handleDeletionInput(data: string, keybindings: KeybindingsManager): boolean {
		if (keybindings.matches(data, "tui.editor.deleteCharBackward")) this.handleBackspace();
		else if (keybindings.matches(data, "tui.editor.deleteCharForward")) this.handleForwardDelete();
		else if (keybindings.matches(data, "tui.editor.deleteWordBackward")) this.deleteWordBackwards();
		else if (keybindings.matches(data, "tui.editor.deleteWordForward")) this.deleteWordForward();
		else if (keybindings.matches(data, "tui.editor.deleteToLineStart")) this.deleteToLineStart();
		else if (keybindings.matches(data, "tui.editor.deleteToLineEnd")) this.deleteToLineEnd();
		else return false;
		return true;
	}

	private handleKillRingInput(data: string, keybindings: KeybindingsManager): boolean {
		if (keybindings.matches(data, "tui.editor.yank")) this.yank();
		else if (keybindings.matches(data, "tui.editor.yankPop")) this.yankPop();
		else return false;
		return true;
	}

	private moveCursorLeft(): void {
		this.lastAction = null;
		if (this.cursor === 0) return;
		const beforeCursor = this.value.slice(0, this.cursor);
		const graphemes = [...segmenter.segment(beforeCursor)];
		const lastGrapheme = graphemes[graphemes.length - 1];
		this.cursor -= lastGrapheme ? lastGrapheme.segment.length : 1;
	}

	private moveCursorRight(): void {
		this.lastAction = null;
		if (this.cursor >= this.value.length) return;
		const afterCursor = this.value.slice(this.cursor);
		const graphemes = [...segmenter.segment(afterCursor)];
		const firstGrapheme = graphemes[0];
		this.cursor += firstGrapheme ? firstGrapheme.segment.length : 1;
	}

	private handleCursorMovementInput(data: string, keybindings: KeybindingsManager): boolean {
		if (keybindings.matches(data, "tui.editor.cursorLeft")) this.moveCursorLeft();
		else if (keybindings.matches(data, "tui.editor.cursorRight")) this.moveCursorRight();
		else if (keybindings.matches(data, "tui.editor.cursorLineStart")) {
			this.lastAction = null;
			this.cursor = 0;
		} else if (keybindings.matches(data, "tui.editor.cursorLineEnd")) {
			this.lastAction = null;
			this.cursor = this.value.length;
		} else if (keybindings.matches(data, "tui.editor.cursorWordLeft")) this.moveWordBackwards();
		else if (keybindings.matches(data, "tui.editor.cursorWordRight")) this.moveWordForwards();
		else return false;
		return true;
	}

	private handlePrintableInput(data: string): void {
		const kittyPrintable = decodeKittyPrintable(data);
		if (kittyPrintable !== undefined) {
			this.insertCharacter(kittyPrintable);
			return;
		}
		const hasControlChars = [...data].some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
		});
		if (!hasControlChars) this.insertCharacter(data);
	}

	handleInput(data: string): void {
		const paste = this.handleBracketedPasteInput(data);
		if (paste.consumed) return;
		data = paste.data;
		const keybindings = getKeybindings();
		if (this.handleControlInput(data, keybindings)) return;
		if (this.handleDeletionInput(data, keybindings)) return;
		if (this.handleKillRingInput(data, keybindings)) return;
		if (this.handleCursorMovementInput(data, keybindings)) return;
		this.handlePrintableInput(data);
	}

	private insertCharacter(char: string): void {
		// Undo coalescing: consecutive word chars coalesce into one undo unit
		if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
			this.pushUndo();
		}
		this.lastAction = "type-word";

		this.value = this.value.slice(0, this.cursor) + char + this.value.slice(this.cursor);
		this.cursor += char.length;
	}

	private handleBackspace(): void {
		this.lastAction = null;
		if (this.cursor > 0) {
			this.pushUndo();
			const beforeCursor = this.value.slice(0, this.cursor);
			const graphemes = [...segmenter.segment(beforeCursor)];
			const lastGrapheme = graphemes[graphemes.length - 1];
			const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;
			this.value = this.value.slice(0, this.cursor - graphemeLength) + this.value.slice(this.cursor);
			this.cursor -= graphemeLength;
		}
	}

	private handleForwardDelete(): void {
		this.lastAction = null;
		if (this.cursor < this.value.length) {
			this.pushUndo();
			const afterCursor = this.value.slice(this.cursor);
			const graphemes = [...segmenter.segment(afterCursor)];
			const firstGrapheme = graphemes[0];
			const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;
			this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + graphemeLength);
		}
	}

	private deleteToLineStart(): void {
		if (this.cursor === 0) return;
		this.pushUndo();
		const deletedText = this.value.slice(0, this.cursor);
		this.killRing.push(deletedText, { prepend: true, accumulate: this.lastAction === "kill" });
		this.lastAction = "kill";
		this.value = this.value.slice(this.cursor);
		this.cursor = 0;
	}

	private deleteToLineEnd(): void {
		if (this.cursor >= this.value.length) return;
		this.pushUndo();
		const deletedText = this.value.slice(this.cursor);
		this.killRing.push(deletedText, { prepend: false, accumulate: this.lastAction === "kill" });
		this.lastAction = "kill";
		this.value = this.value.slice(0, this.cursor);
	}

	private deleteWordBackwards(): void {
		if (this.cursor === 0) return;

		// Save lastAction before cursor movement (moveWordBackwards resets it)
		const wasKill = this.lastAction === "kill";

		this.pushUndo();

		const oldCursor = this.cursor;
		this.moveWordBackwards();
		const deleteFrom = this.cursor;
		this.cursor = oldCursor;

		const deletedText = this.value.slice(deleteFrom, this.cursor);
		this.killRing.push(deletedText, { prepend: true, accumulate: wasKill });
		this.lastAction = "kill";

		this.value = this.value.slice(0, deleteFrom) + this.value.slice(this.cursor);
		this.cursor = deleteFrom;
	}

	private deleteWordForward(): void {
		if (this.cursor >= this.value.length) return;

		// Save lastAction before cursor movement (moveWordForwards resets it)
		const wasKill = this.lastAction === "kill";

		this.pushUndo();

		const oldCursor = this.cursor;
		this.moveWordForwards();
		const deleteTo = this.cursor;
		this.cursor = oldCursor;

		const deletedText = this.value.slice(this.cursor, deleteTo);
		this.killRing.push(deletedText, { prepend: false, accumulate: wasKill });
		this.lastAction = "kill";

		this.value = this.value.slice(0, this.cursor) + this.value.slice(deleteTo);
	}

	private yank(): void {
		const text = this.killRing.peek();
		if (!text) return;

		this.pushUndo();

		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		this.cursor += text.length;
		this.lastAction = "yank";
	}

	private yankPop(): void {
		if (this.lastAction !== "yank" || this.killRing.length <= 1) return;

		this.pushUndo();

		// Delete the previously yanked text (still at end of ring before rotation)
		const prevText = this.killRing.peek() || "";
		this.value = this.value.slice(0, this.cursor - prevText.length) + this.value.slice(this.cursor);
		this.cursor -= prevText.length;

		// Rotate and insert new entry
		this.killRing.rotate();
		const text = this.killRing.peek() || "";
		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		this.cursor += text.length;
		this.lastAction = "yank";
	}

	private pushUndo(): void {
		this.undoStack.push({ value: this.value, cursor: this.cursor });
	}

	private undo(): void {
		const snapshot = this.undoStack.pop();
		if (!snapshot) return;
		this.value = snapshot.value;
		this.cursor = snapshot.cursor;
		this.lastAction = null;
	}

	private moveWordBackwards(): void {
		if (this.cursor === 0) return;
		this.lastAction = null;
		this.cursor = findWordBackward(this.value, this.cursor);
	}

	private moveWordForwards(): void {
		if (this.cursor >= this.value.length) return;
		this.lastAction = null;
		this.cursor = findWordForward(this.value, this.cursor);
	}

	private handlePaste(pastedText: string): void {
		this.lastAction = null;
		this.pushUndo();

		// Clean the pasted text - remove newlines and carriage returns
		const cleanText = pastedText.replace(/\r\n/g, "").replace(/\r/g, "").replace(/\n/g, "").replace(/\t/g, "    ");

		// Insert at cursor position
		this.value = this.value.slice(0, this.cursor) + cleanText + this.value.slice(this.cursor);
		this.cursor += cleanText.length;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	private getVisibleWindow(availableWidth: number): InputVisibleWindow {
		const totalWidth = visibleWidth(this.value);
		if (totalWidth < availableWidth) return { text: this.value, cursor: this.cursor };

		const scrollWidth = this.cursor === this.value.length ? availableWidth - 1 : availableWidth;
		if (scrollWidth <= 0) return { text: "", cursor: 0 };

		const cursorColumn = visibleWidth(this.value.slice(0, this.cursor));
		const halfWidth = Math.floor(scrollWidth / 2);
		let startColumn: number;
		if (cursorColumn < halfWidth) startColumn = 0;
		else if (cursorColumn > totalWidth - halfWidth) startColumn = Math.max(0, totalWidth - scrollWidth);
		else startColumn = Math.max(0, cursorColumn - halfWidth);

		const text = sliceByColumn(this.value, startColumn, scrollWidth, true);
		const beforeCursor = sliceByColumn(this.value, startColumn, Math.max(0, cursorColumn - startColumn), true);
		return { text, cursor: beforeCursor.length };
	}

	render(width: number): string[] {
		const prompt = "> ";
		const availableWidth = width - prompt.length;
		if (availableWidth <= 0) return [prompt];

		const visibleWindow = this.getVisibleWindow(availableWidth);
		const visibleText = visibleWindow.text;
		const cursorDisplay = visibleWindow.cursor;

		// Build line with fake cursor
		// Insert cursor character at cursor position
		const graphemes = [...segmenter.segment(visibleText.slice(cursorDisplay))];
		const cursorGrapheme = graphemes[0];

		const beforeCursor = visibleText.slice(0, cursorDisplay);
		const atCursor = cursorGrapheme?.segment ?? " "; // Character at cursor, or space if at end
		const afterCursor = visibleText.slice(cursorDisplay + atCursor.length);

		// Hardware cursor marker (zero-width, emitted before fake cursor for IME positioning)
		const marker = this.focused ? CURSOR_MARKER : "";

		// Use inverse video to show cursor
		const cursorChar = `\x1b[7m${atCursor}\x1b[27m`; // ESC[7m = reverse video, ESC[27m = normal
		const textWithCursor = beforeCursor + marker + cursorChar + afterCursor;

		// Calculate visual width
		const visualLength = visibleWidth(textWithCursor);
		const padding = " ".repeat(Math.max(0, availableWidth - visualLength));
		const line = prompt + textWithCursor + padding;

		return [line];
	}
}
