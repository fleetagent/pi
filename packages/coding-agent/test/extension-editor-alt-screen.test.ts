import { EventEmitter } from "node:events";
import { Text, TuiAltScreen } from "@fleetagent/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const childProcessMocks = vi.hoisted(() => ({
	spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: childProcessMocks.spawn }));

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

describe("fullscreen external editor handoff", () => {
	beforeEach(() => {
		initTheme("dark");
		childProcessMocks.spawn.mockReset();
		childProcessMocks.spawn.mockImplementation(() => {
			const child = new EventEmitter();
			process.nextTick(() => child.emit("close", 1));
			return child;
		});
	});

	it("restores the previous screen without replay before restarting fullscreen", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const tui = new TuiAltScreen(terminal);
		const editor = new ExtensionEditorComponent(
			tui,
			KeybindingsManager.create(),
			"Extension editor",
			"draft",
			vi.fn(),
			vi.fn(),
			undefined,
			"fake-editor",
		);
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		await (editor as unknown as { openExternalEditor(): Promise<void> }).openExternalEditor();
		await terminal.waitForRender();

		const exitWrites = terminal.writes.filter((write) => write.includes("\x1b[?1049l"));
		expect(exitWrites).toHaveLength(1);
		expect(exitWrites[0]).not.toContain("Extension editor");
		expect(exitWrites[0]).not.toContain("draft");
		expect(terminal.writes.filter((write) => write.includes("\x1b[?1049h"))).toHaveLength(2);
		expect(childProcessMocks.spawn).toHaveBeenCalledWith(
			"fake-editor",
			[expect.stringMatching(/pi-extension-editor-/)],
			{
				stdio: "inherit",
				shell: process.platform === "win32",
			},
		);

		tui.stop();
	});

	it("preserves the main interactive transcript during its external editor handoff", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("existing transcript", 0, 0));
		tui.start();
		await terminal.waitForRender();
		const editor = {
			getExpandedText: () => "draft",
			getText: () => "draft",
			setText: vi.fn(),
		};
		const context = {
			settingsManager: { getExternalEditorCommand: () => "fake-editor --wait" },
			editor,
			ui: tui,
		};

		await (
			InteractiveMode.prototype as unknown as {
				openExternalEditor(this: typeof context): Promise<void>;
			}
		).openExternalEditor.call(context);
		await terminal.waitForRender();

		const exitWrites = terminal.writes.filter((write) => write.includes("\x1b[?1049l"));
		expect(exitWrites).toHaveLength(1);
		expect(exitWrites[0]).not.toContain("existing transcript");
		expect(terminal.writes.filter((write) => write.includes("\x1b[?1049h"))).toHaveLength(2);
		expect(childProcessMocks.spawn).toHaveBeenCalledWith(
			"fake-editor",
			["--wait", expect.stringMatching(/pi-editor-/)],
			{ stdio: "inherit", shell: process.platform === "win32" },
		);
		expect(editor.setText).not.toHaveBeenCalled();

		tui.stop();
	});
});
