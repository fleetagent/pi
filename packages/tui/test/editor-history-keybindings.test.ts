import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

afterEach(() => {
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

describe("Editor prompt history keybindings", () => {
	it("browses history directly without changing arrow navigation", () => {
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.editor.historyPrevious": "ctrl+p",
				"tui.editor.historyNext": "ctrl+n",
			}),
		);
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		editor.addToHistory("older prompt");
		editor.addToHistory("newer\nmultiline prompt");
		editor.setText("draft\nline");

		editor.handleInput("\x1b[A"); // Up still moves within the draft.
		assert.strictEqual(editor.getText(), "draft\nline");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 4 });

		editor.handleInput("\x10"); // Ctrl+P bypasses vertical cursor movement.
		assert.strictEqual(editor.getText(), "newer\nmultiline prompt");
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 16 });

		editor.handleInput("\x10");
		assert.strictEqual(editor.getText(), "older prompt");

		editor.handleInput("\x0e"); // Ctrl+N selects the newer entry directly.
		assert.strictEqual(editor.getText(), "newer\nmultiline prompt");
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 16 });

		editor.handleInput("\x0e");
		assert.strictEqual(editor.getText(), "");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 0 });
	});
});
