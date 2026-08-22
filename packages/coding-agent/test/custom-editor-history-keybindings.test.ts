import { Editor, setKeybindings, TuiMainScreen } from "@fleetagent/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

describe("CustomEditor prompt history keybindings", () => {
	it("gives an explicit history binding precedence over model cycling", () => {
		const keybindings = new KeybindingsManager({
			"tui.editor.historyPrevious": "ctrl+p",
			"tui.editor.historyNext": "ctrl+n",
		});
		const originalMatches = keybindings.matches.bind(keybindings);
		vi.spyOn(keybindings, "matches").mockImplementation((data, keybinding) => {
			const keybindingId = String(keybinding);
			if (keybindingId === "tui.editor.historyPrevious") return data === "\x10";
			if (keybindingId === "tui.editor.historyNext") return data === "\x0e";
			return originalMatches(data, keybinding);
		});
		setKeybindings(keybindings);
		const superHandleInput = vi.spyOn(Editor.prototype, "handleInput");
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		let modelCycles = 0;
		editor.onAction("app.model.cycleForward", () => {
			modelCycles++;
		});

		editor.handleInput("\x10"); // Ctrl+P
		expect(modelCycles).toBe(0);
		expect(superHandleInput).toHaveBeenCalledWith("\x10");

		editor.handleInput("\x0e"); // Ctrl+N
		expect(superHandleInput).toHaveBeenCalledWith("\x0e");
	});
});
