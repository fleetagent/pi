import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { HStack } from "../src/components/h-stack.ts";
import { Image } from "../src/components/image.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { isViewportTUI } from "../src/index.ts";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import {
	encodeKitty,
	getCapabilities,
	hyperlink,
	registerKittyImageMetadata,
	resetCapabilitiesCache,
	setCapabilities,
} from "../src/terminal-image.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";

type RecordedTerminalEvent = { type: "write"; data: string } | { type: "start" } | { type: "stop" };
type RecordedTerminalWriteEvent = Extract<RecordedTerminalEvent, { type: "write" }>;

class RecordingTerminal extends VirtualTerminal {
	readonly events: RecordedTerminalEvent[] = [];

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.events.push({ type: "start" });
		super.start(onInput, onResize);
	}

	override write(data: string): void {
		this.events.push({ type: "write", data });
		super.write(data);
	}

	override stop(): void {
		this.events.push({ type: "stop" });
		super.stop();
	}
}

const MOUSE_MODES = [1000, 1002, 1003, 1004, 1006] as const;
const ALL_MOUSE_MODES = new Set<number>(MOUSE_MODES);
const MULTIPLEXER_MOUSE_MODES = new Set<number>([1000, 1002, 1004, 1006]);
const NO_MOUSE_MODES = new Set<number>();
type TerminalModeChange = "h" | "l";

function collectRecordedWrites(terminal: RecordingTerminal): string {
	return terminal.events
		.filter((event) => event.type === "write")
		.map((event) => event.data)
		.join("");
}

function collectChangedTerminalModes(writes: string, change: TerminalModeChange): Set<number> {
	const modes = new Set<number>();
	for (const match of writes.matchAll(/\x1b\[\?(\d+)([hl])/g)) {
		if (match[2] === change) modes.add(Number(match[1]));
	}
	return modes;
}

function assertMouseModeWrites(
	writes: string,
	change: TerminalModeChange,
	expectedModes: ReadonlySet<number>,
	context = "terminal",
): void {
	const changedModes = collectChangedTerminalModes(writes, change);
	for (const mode of MOUSE_MODES) {
		assert.strictEqual(
			changedModes.has(mode),
			expectedModes.has(mode),
			`${context} should ${expectedModes.has(mode) ? "change" : "not change"} mode ${mode}${change}`,
		);
	}
}

function clearMultiplexerEnvironment(): void {
	delete process.env.TMUX;
	delete process.env.ZELLIJ;
	delete process.env.STY;
	delete process.env.TERM;
}

describe("TuiAltScreen", () => {
	it("renders a terminal-height viewport and preserves manual scroll position", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const text = new Text(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0);
		tui.addChild(text);
		tui.start();
		await terminal.waitForRender();

		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 7", "line 8", "line 9", "line 10"],
		);
		assert.strictEqual(tui.isFollowingOutput, true);

		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 6", "line 7", "line 8", "line 9"],
		);
		assert.strictEqual(tui.viewportTop, 5);
		assert.strictEqual(tui.isFollowingOutput, false);

		text.setText(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"));
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 6", "line 7", "line 8", "line 9"],
		);

		tui.stop();
	});

	it("renders an explicit scrolling document above a fixed dock", async () => {
		const terminal = new VirtualTerminal(12, 4);
		const tui = new TuiAltScreen(terminal);
		const transcript = new ScrollView(new Text("line 1\nline 2\nline 3\nline 4", 0, 0), {
			follow: "end",
			primary: true,
		});
		let editorInput = "";
		const editor = {
			render: () => ["editor", "footer"],
			invalidate: () => {},
			handleInput: (data: string) => {
				editorInput += data;
			},
		};
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: editor, basis: 2, shrink: 0, minSize: 2 },
			]),
		);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 3", "line 4", "editor", "footer"],
		);
		assert.strictEqual(tui.viewportTop, 2);
		assert.strictEqual(isViewportTUI(tui), true);
		terminal.sendInput("x");
		assert.strictEqual(editorInput, "x");
		tui.stop({ preserveScreen: true });
	});

	it("emits only dirty rows during incremental fullscreen redraws", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		let lines = ["alpha", "beta", "gamma"];
		tui.setLayoutRoot({ render: () => lines, invalidate: () => {} });
		tui.start();
		await terminal.waitForRender();

		let eventCount = terminal.events.length;
		lines = ["alpha", "updated", "gamma"];
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.events.slice(eventCount), [
			{
				type: "write",
				data: "\x1b[?2026h\x1b[2;1H\x1b[2Kupdated\x1b[0m\x1b]8;;\x07\x1b[?25l\x1b[?2026l",
			},
		]);

		eventCount = terminal.events.length;
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.events.slice(eventCount), [
			{ type: "write", data: "\x1b[?2026h\x1b[?25l\x1b[?2026l" },
		]);
		tui.stop({ preserveScreen: true });
	});

	it("invalidates only the active mounted root", () => {
		const tui = new TuiAltScreen(new VirtualTerminal());
		let flatInvalidations = 0;
		let layoutInvalidations = 0;
		const flat = { render: () => ["flat"], invalidate: () => flatInvalidations++ };
		const mounted = { render: () => ["mounted"], invalidate: () => layoutInvalidations++ };
		tui.addChild(flat);
		tui.setLayoutRoot(new VStack([mounted]));
		tui.invalidate();
		assert.strictEqual(layoutInvalidations, 1);
		assert.strictEqual(flatInvalidations, 0);
		tui.setLayoutRoot(undefined);
		tui.invalidate();
		assert.strictEqual(layoutInvalidations, 1);
		assert.strictEqual(flatInvalidations, 1);
	});

	it("routes wheel input to the deepest side-by-side scroll viewport without overdraw", async () => {
		const terminal = new VirtualTerminal(10, 2);
		const tui = new TuiAltScreen(terminal);
		const left = new ScrollView(new Text("a1\na2\na3\na4", 0, 0), { follow: "end", primary: true });
		const right = new ScrollView(new Text("b1\nb2\nb3\nb4", 0, 0), {
			follow: "end",
			overscroll: "contain",
		});
		tui.setLayoutRoot(
			new HStack([
				{ component: left, basis: 5, shrink: 0 },
				{ component: right, basis: 5, shrink: 0 },
			]),
		);
		tui.start();
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["a3   b3", "a4   b4"],
		);
		terminal.sendInput("\x1b[<64;8;1M");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["a3   b2", "a4   b3"],
		);
		assert.strictEqual(left.scrollTop, 2);
		assert.strictEqual(right.scrollTop, 1);
		terminal.sendInput("\x1b[<64;8;1M");
		terminal.sendInput("\x1b[<64;8;1M");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["a3   b1", "a4   b2"],
		);
		assert.strictEqual(left.scrollTop, 2);
		assert.strictEqual(right.scrollTop, 0);
		tui.stop({ preserveScreen: true });
	});

	it("invokes right-click paste only for unmodified Windows secondary-button presses", async () => {
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		assert.ok(platformDescriptor);
		const terminal = new VirtualTerminal(10, 3);
		let pasteCount = 0;
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			onRightClickPaste: () => {
				pasteCount += 1;
			},
		});
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			tui.addChild(new Text("one\ntwo\nthree", 0, 0));
			tui.start();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<2;1;1M");
			terminal.sendInput("\x1b[<2;1;1m");
			terminal.sendInput("\x1b[<18;1;1M");
			assert.strictEqual(pasteCount, 1);

			Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
			terminal.sendInput("\x1b[<2;1;1M");
			assert.strictEqual(pasteCount, 1);

			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			const throwingTerminal = new VirtualTerminal();
			const throwingTui = new TuiAltScreen(throwingTerminal, undefined, undefined, {
				onRightClickPaste: () => {
					throw new Error("clipboard unavailable");
				},
			});
			throwingTui.start();
			try {
				assert.doesNotThrow(() => throwingTerminal.sendInput("\x1b[<2;1;1M"));
			} finally {
				throwingTui.stop();
			}
		} finally {
			try {
				tui.stop();
			} finally {
				Object.defineProperty(process, "platform", platformDescriptor);
			}
		}
	});

	it("chains unused wheel delta to an outer scroll view", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { wheelScrollLines: 3 });
		const inner = new ScrollView(new Text("i1\ni2\ni3\ni4\ni5\ni6", 0, 0));
		const outer = new ScrollView(
			new VStack([{ component: inner, basis: 2 }, new Text("tail1\ntail2\ntail3\ntail4\ntail5", 0, 0)]),
			{ primary: true },
		);
		tui.setLayoutRoot(outer);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<65;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(inner.scrollTop, 3);
		assert.strictEqual(outer.scrollTop, 0);

		terminal.sendInput("\x1b[<65;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(inner.scrollTop, 4);
		assert.strictEqual(outer.scrollTop, 2);
		tui.stop();
	});

	it("drags a transient scrollbar thumb, captures motion, and fades after pointer exit", async () => {
		const terminal = new RecordingTerminal(10, 5);
		const tui = new TuiAltScreen(terminal);
		const scrollView = new ScrollView(
			new Text(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ primary: true, scrollbar: "auto", scrollbarHideDelayMs: 20 },
		);
		tui.setLayoutRoot(scrollView);
		tui.start();
		try {
			await terminal.waitForRender();
			assert.strictEqual(scrollView.isScrollbarVisible, false);

			terminal.sendInput("\x1b[<65;10;1M");
			await terminal.waitForRender();
			assert.strictEqual(scrollView.scrollTop, 1);
			assert.strictEqual(scrollView.isScrollbarVisible, true);

			terminal.sendInput("\x1b[<0;10;1M");
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.strictEqual(scrollView.isScrollbarVisible, true);

			terminal.sendInput("\x1b[<32;10;4M");
			await terminal.waitForRender();
			assert.strictEqual(scrollView.scrollTop, 15);
			assert.deepStrictEqual(
				terminal.getViewport().map((line) => line.trimEnd()),
				["line 16", "line 17", "line 18", "line 19", "line 20"],
			);

			terminal.sendInput("\x1b[<0;10;4m");
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.strictEqual(scrollView.isScrollbarVisible, true);
			terminal.sendInput("\x1b[<35;9;4M");
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.strictEqual(scrollView.isScrollbarVisible, false);
			assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")));
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("cancels scrollbar capture on focus loss", async () => {
		const terminal = new RecordingTerminal(10, 5);
		const tui = new TuiAltScreen(terminal);
		const scrollView = new ScrollView(new Text(Array.from({ length: 20 }, () => "line").join("\n"), 0, 0), {
			primary: true,
			scrollbar: "auto",
			scrollbarHideDelayMs: 20,
		});
		tui.setLayoutRoot(scrollView);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<65;10;1M");
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;10;1M");
			terminal.sendInput("\x1b[O");
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.strictEqual(scrollView.isScrollbarVisible, false);

			const scrollTop = scrollView.scrollTop;
			terminal.sendInput("\x1b[<32;10;5M");
			assert.strictEqual(scrollView.scrollTop, scrollTop);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("drags an always-visible scrollbar in a one-column viewport", async () => {
		const terminal = new RecordingTerminal(1, 4);
		const tui = new TuiAltScreen(terminal);
		const scrollView = new ScrollView(
			{ render: () => [..."abcdefghijkl"], invalidate: () => {} },
			{ primary: true, scrollbar: "always" },
		);
		tui.setLayoutRoot(scrollView);
		tui.start();
		try {
			await terminal.waitForRender();
			assert.strictEqual(scrollView.isScrollbarVisible, true);
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;1;4M");
			terminal.sendInput("\x1b[<0;1;4m");
			await terminal.waitForRender();
			assert.strictEqual(scrollView.scrollTop, 8);
			assert.deepStrictEqual(terminal.getViewport(), ["i", "j", "k", "l"]);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("keeps the scrollbar column selectable while the transient thumb is hidden", async () => {
		const terminal = new RecordingTerminal(10, 2);
		const tui = new TuiAltScreen(terminal);
		const scrollView = new ScrollView(new Text("123456789A\nabcdefghij\nmore\nlines", 0, 0), {
			scrollbar: "auto",
		});
		tui.setLayoutRoot(scrollView);
		tui.start();
		try {
			await terminal.waitForRender();
			assert.strictEqual(scrollView.isScrollbarVisible, false);
			terminal.sendInput("\x1b[<0;10;1M");
			terminal.sendInput("\x1b[<32;10;2M");
			terminal.sendInput("\x1b[<0;10;2m");
			await terminal.waitForRender();

			const expected = `\x1b]52;c;${Buffer.from("A\nabcdefghij").toString("base64")}\x07`;
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(expected)));
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("reflows explicit layouts across narrow resizes and restores implicit flat mode", async () => {
		const terminal = new VirtualTerminal(8, 3);
		const tui = new TuiAltScreen(terminal);
		const flat = new Text("flat document", 0, 0);
		tui.addChild(flat);
		tui.setLayoutRoot(new VStack([new Text("explicit content wraps", 0, 0), new Text("dock", 0, 0)]));
		tui.start();
		await terminal.waitForRender();
		terminal.resize(1, 2);
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport().length, 2);
		assert.ok(terminal.getViewport().every((line) => line.length <= 1));
		terminal.resize(8, 3);
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().every((line) => line.length <= 8));
		tui.setLayoutRoot(undefined);
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((line) => line.includes("flat")));
		tui.stop({ preserveScreen: true });
	});

	it("supports keyboard viewport navigation with four rows of page overlap and ignores releases", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 12);

		terminal.sendInput("\x1b[57421u");
		terminal.sendInput("\x1b[57421;1:3u");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 8);
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "line 9");

		terminal.sendInput("\x1b[57422u");
		terminal.sendInput("\x1b[57422;1:3u");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 12);

		terminal.sendInput("\x1bOH");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 0);

		terminal.sendInput("\x1b[57422u");
		terminal.sendInput("\x1b[57422;1:3u");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 4);
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "line 5");

		terminal.sendInput("\x1bOF");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 12);
		assert.strictEqual(tui.isFollowingOutput, true);

		tui.stop();
	});

	it("scrolls the primary transcript by half its viewport with custom bindings", async () => {
		const originalKeybindings = getKeybindings();
		const terminal = new VirtualTerminal(20, 11);
		const tui = new TuiAltScreen(terminal);
		const transcript = new ScrollView(
			new Text(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ follow: "end", primary: true },
		);
		const editorInputs: string[] = [];
		const editor = {
			focused: false,
			render: () => ["editor"],
			invalidate: () => {},
			handleInput: (data: string) => editorInputs.push(data),
		};
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.altScreen.halfPageUp": "ctrl+u",
				"tui.altScreen.halfPageDown": "ctrl+d",
			}),
		);
		try {
			tui.setLayoutRoot(
				new VStack([
					{ component: transcript, basis: 0, grow: 1, minSize: 1 },
					{ component: editor, basis: 1, shrink: 0 },
				]),
			);
			tui.setFocus(editor);
			tui.start();
			await terminal.waitForRender();
			assert.strictEqual(transcript.viewportHeight, 10);
			assert.strictEqual(transcript.scrollTop, 20);

			terminal.sendInput("\x15");
			await terminal.waitForRender();
			assert.strictEqual(transcript.scrollTop, 15);
			assert.deepStrictEqual(editorInputs, []);

			terminal.sendInput("\x1b[117;5:3u");
			await terminal.waitForRender();
			assert.strictEqual(transcript.scrollTop, 15);
			assert.deepStrictEqual(editorInputs, []);

			terminal.sendInput("\x1b[100;5:3u");
			await terminal.waitForRender();
			assert.strictEqual(transcript.scrollTop, 15);
			assert.deepStrictEqual(editorInputs, []);

			terminal.sendInput("\x04");
			await terminal.waitForRender();
			assert.strictEqual(transcript.scrollTop, 20);
			assert.strictEqual(transcript.isFollowingEnd, true);
			assert.deepStrictEqual(editorInputs, []);
			terminal.resize(20, 10);
			await terminal.waitForRender();
			assert.strictEqual(transcript.viewportHeight, 9);
			assert.strictEqual(transcript.scrollTop, 21);
			terminal.sendInput("\x15");
			await terminal.waitForRender();
			assert.strictEqual(transcript.scrollTop, 17);
			terminal.sendInput("\x04");
			await terminal.waitForRender();
			assert.strictEqual(transcript.scrollTop, 21);

			terminal.resize(20, 2);
			await terminal.waitForRender();
			assert.strictEqual(transcript.viewportHeight, 1);
			assert.strictEqual(transcript.scrollTop, 29);

			terminal.sendInput("\x15");
			await terminal.waitForRender();
			assert.strictEqual(transcript.scrollTop, 28);

			terminal.sendInput("\x04");
			await terminal.waitForRender();
			assert.strictEqual(transcript.scrollTop, 29);
			assert.strictEqual(transcript.isFollowingEnd, true);
			assert.deepStrictEqual(editorInputs, []);
		} finally {
			try {
				tui.stop();
			} finally {
				setKeybindings(originalKeybindings);
			}
		}
	});

	it("honors transcript navigation overrides and disabled actions", async () => {
		const originalKeybindings = getKeybindings();
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TuiAltScreen(terminal);
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.altScreen.pageUp": "ctrl+pageUp",
				"tui.altScreen.pageDown": [],
			}),
		);
		try {
			tui.addChild(new Text(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
			tui.start();
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 12);

			terminal.sendInput("\x1b[5~");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 12);

			terminal.sendInput("\x1b[6~");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 12);

			terminal.sendInput("\x1b[5;5~");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 8);
		} finally {
			try {
				tui.stop();
			} finally {
				setKeybindings(originalKeybindings);
			}
		}
	});

	it("routes Ctrl-modified viewport navigation and editor history input to the focused component", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const transcript = new ScrollView(
			new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ follow: "end", primary: true },
		);
		const editorInputs: string[] = [];
		const editor = {
			focused: false,
			render: () => ["editor"],
			invalidate: () => {},
			handleInput: (data: string) => editorInputs.push(data),
		};
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: editor, basis: 1, shrink: 0 },
			]),
		);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1bOH");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 0);
		assert.deepStrictEqual(editorInputs, []);

		const historyInputs = ["\x1b[A", "\x1b[B"];
		for (const input of historyInputs) terminal.sendInput(input);
		const modifiedInputs = ["\x1b[1;5H", "\x1b[1;5F", "\x1b[5;5~", "\x1b[6;5~", "\x1b[57423;5u"];
		for (const input of modifiedInputs) terminal.sendInput(input);
		terminal.sendInput("\x1b[57423;5:3u");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 0);
		assert.deepStrictEqual(editorInputs, [...historyInputs, ...modifiedInputs]);

		terminal.sendInput("\x1b[6~");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 1);
		assert.deepStrictEqual(editorInputs, [...historyInputs, ...modifiedInputs]);

		tui.stop();
	});

	it("jumps between OSC 133 semantic prompt markers in the explicit primary transcript", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const transcript = new ScrollView(
			new Text(
				[1, 2, 3, 4].flatMap((message) => [`${OSC133_ZONE_START}message ${message}`, "detail"]).join("\n"),
				0,
				0,
			),
			{ follow: "end", primary: true },
		);
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: new Text("editor", 0, 0), basis: 1, shrink: 0 },
			]),
		);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 5);

		terminal.sendInput("\x1b[57419;6u");
		terminal.sendInput("\x1b[57419;6:3u");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 4);
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "message 3");

		terminal.sendInput("\x1b[1;6A");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 2);
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "message 2");

		terminal.sendInput("\x1b[57420;6u");
		terminal.sendInput("\x1b[57420;6:3u");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 4);
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "message 3");

		terminal.sendInput("\x1b[1;6B");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 5);
		assert.strictEqual(terminal.getViewport()[1]?.trimEnd(), "message 4");
		assert.strictEqual(transcript.isFollowingEnd, true);

		tui.stop();
	});

	it("does not emit Kitty graphics commands or OSC 133 zones in iTerm2", async () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 3);
			const tui = new TuiAltScreen(terminal);
			tui.addChild({
				render: () => ["\x1b]133;B\x07\x1b]133;C\x07\x1b]133;A\x07content"],
				invalidate: () => {},
			});
			tui.addChild(
				new Image(
					"AAAA",
					"image/png",
					{ fallbackColor: (value) => value },
					{ filename: "example.png" },
					{ widthPx: 10, heightPx: 10 },
				),
			);
			tui.start();
			await terminal.waitForRender();
			tui.stop();
			assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b_G")));
			assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]133;")));
			assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]1337;File=")));
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("[Image:")));
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("clears stale iTerm2 image placements when they leave the viewport", async () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 3);
			const tui = new TuiAltScreen(terminal);
			const imageLine = "\x1b]1337;File=inline=1;width=2;height=auto:AAAA\x07";
			tui.addChild({
				render: () => [imageLine, "", "", "after", "more", "end"],
				invalidate: () => {},
			});
			tui.start();
			await terminal.waitForRender();
			tui.scrollToTop();
			await terminal.waitForRender();
			const eventCount = terminal.events.length;

			tui.scrollBy(1);
			await terminal.waitForRender();
			assert.ok(
				terminal.events.slice(eventCount).some((event) => event.type === "write" && event.data.includes("\x1b[2J")),
			);
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("crops a Kitty image whose first line is above the viewport", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		const imageId = 123;
		const imageLine = encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
		registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
		tui.addChild({
			render: () => ["before", imageLine, "", "", "after", "end"],
			invalidate: () => {},
		});
		tui.start();
		await terminal.waitForRender();

		assert.strictEqual(tui.viewportTop, 3);
		assert.ok(
			terminal.events.some(
				(event) => event.type === "write" && event.data.includes("i=123") && event.data.includes("y=66,h=34,r=1"),
			),
		);

		tui.stop();
	});

	it("reuses moved Kitty images without dropping HStack siblings", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 6);
			const tui = new TuiAltScreen(terminal);
			const label = new Text("left", 0, 0);
			const image = new Image(
				"A".repeat(8192),
				"image/png",
				{ fallbackColor: (value) => value },
				{},
				{ widthPx: 100, heightPx: 100 },
			);
			const header = new Text("header", 0, 0);
			const row = new HStack([
				{ component: label, basis: 10 },
				{ component: image, basis: 10 },
			]);
			tui.setLayoutRoot(
				new VStack([
					{ component: header, basis: "auto" },
					{ component: row, basis: 4 },
				]),
			);
			tui.start();
			await terminal.waitForRender();
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b_Ga=T")));

			const eventCount = terminal.events.length;
			label.setText("changed");
			header.setText("header\nsecond");
			tui.requestRender();
			await terminal.waitForRender();
			const redrawWrites = terminal.events
				.slice(eventCount)
				.filter((event): event is RecordedTerminalWriteEvent => event.type === "write")
				.map((event) => event.data)
				.join("");
			const placementIndex = redrawWrites.indexOf("\x1b_Ga=p,q=2");
			assert.ok(redrawWrites.includes("\x1b_Ga=d,d=a,q=2\x1b\\"));
			assert.ok(placementIndex > redrawWrites.indexOf("changed"));
			assert.ok(!redrawWrites.includes("\x1b_Ga=T"));
			assert.ok(redrawWrites.length < 2000, `expected placement-only redraw, got ${redrawWrites.length} bytes`);
			assert.ok(terminal.getViewport().some((line) => line.trimEnd() === "changed"));
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("retains recently offscreen Kitty images for placement-only reuse", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 1);
			const tui = new TuiAltScreen(terminal);
			const imageId = 321;
			const imageLine = encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 100, heightPx: 50 });
			tui.setLayoutRoot(
				new ScrollView(
					{
						render: () => [imageLine, "after"],
						invalidate: () => {},
					},
					{ primary: true },
				),
			);
			tui.start();
			await terminal.waitForRender();
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b_Ga=T")));

			const eventCount = terminal.events.length;
			tui.scrollBy(1);
			await terminal.waitForRender();
			tui.scrollBy(-1);
			await terminal.waitForRender();
			const reentryWrites = terminal.events
				.slice(eventCount)
				.filter((event): event is RecordedTerminalWriteEvent => event.type === "write")
				.map((event) => event.data)
				.join("");
			assert.ok(reentryWrites.includes("\x1b_Ga=p,q=2"));
			assert.ok(!reentryWrites.includes("\x1b_Ga=T"));
			assert.ok(!reentryWrites.includes(`\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`));
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("retransmits Kitty image data after the same image ID is regenerated", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 1);
			const tui = new TuiAltScreen(terminal);
			const imageId = 400;
			let imageLine = encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 100, heightPx: 50 });
			tui.setLayoutRoot({ render: () => [imageLine], invalidate: () => {} });
			tui.start();
			await terminal.waitForRender();

			const eventCount = terminal.events.length;
			imageLine = encodeKitty("BBBB", { columns: 2, rows: 1, imageId, moveCursor: false });
			registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 100, heightPx: 50 });
			tui.requestRender();
			await terminal.waitForRender();
			const updateWrites = terminal.events
				.slice(eventCount)
				.filter((event): event is RecordedTerminalWriteEvent => event.type === "write")
				.map((event) => event.data)
				.join("");
			assert.ok(updateWrites.includes("\x1b_Ga=T"));
			assert.ok(updateWrites.includes("BBBB"));
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("reuses Kitty payloads on full redraw and retransmits them after restart", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 1);
			const tui = new TuiAltScreen(terminal);
			const imageId = 450;
			const imageLine = encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 100, heightPx: 50 });
			tui.setLayoutRoot({ render: () => [imageLine], invalidate: () => {} });
			tui.start();
			await terminal.waitForRender();

			const resizeEventCount = terminal.events.length;
			terminal.resize(21, 1);
			await terminal.waitForRender();
			const resizeWrites = terminal.events
				.slice(resizeEventCount)
				.filter((event): event is RecordedTerminalWriteEvent => event.type === "write")
				.map((event) => event.data)
				.join("");
			assert.ok(resizeWrites.includes("\x1b_Ga=d,d=a,q=2\x1b\\"));
			assert.ok(resizeWrites.includes("\x1b_Ga=p,q=2"));
			assert.ok(!resizeWrites.includes("\x1b_Ga=T"));

			tui.stop({ preserveScreen: true });
			const restartEventCount = terminal.events.length;
			tui.start();
			await terminal.waitForRender();
			const restartWrites = terminal.events
				.slice(restartEventCount)
				.filter((event): event is RecordedTerminalWriteEvent => event.type === "write")
				.map((event) => event.data)
				.join("");
			assert.ok(restartWrites.includes("\x1b_Ga=T"));
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("evicts the least recently visible Kitty image when the cache is full", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 1);
			const tui = new TuiAltScreen(terminal);
			const firstImageId = 500;
			const imageLines = Array.from({ length: 18 }, (_, index) => {
				const imageId = firstImageId + index;
				registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 100, heightPx: 50 });
				return encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			});
			tui.setLayoutRoot(new ScrollView({ render: () => imageLines, invalidate: () => {} }, { primary: true }));
			tui.start();
			await terminal.waitForRender();
			for (let index = 1; index < imageLines.length - 1; index++) {
				tui.scrollBy(1);
				await terminal.waitForRender();
			}
			tui.scrollToTop();
			await terminal.waitForRender();

			const evictionEventCount = terminal.events.length;
			tui.scrollBy(imageLines.length - 1);
			await terminal.waitForRender();
			const evictionWrites = terminal.events
				.slice(evictionEventCount)
				.filter((event): event is RecordedTerminalWriteEvent => event.type === "write")
				.map((event) => event.data)
				.join("");
			assert.ok(evictionWrites.includes(`\x1b_Ga=d,d=I,i=${firstImageId + 1},q=2\x1b\\`));
			assert.ok(!evictionWrites.includes(`\x1b_Ga=d,d=I,i=${firstImageId},q=2\x1b\\`));

			const reentryEventCount = terminal.events.length;
			tui.scrollBy(-(imageLines.length - 2));
			await terminal.waitForRender();
			const reentryWrites = terminal.events
				.slice(reentryEventCount)
				.filter((event): event is RecordedTerminalWriteEvent => event.type === "write")
				.map((event) => event.data)
				.join("");
			assert.ok(reentryWrites.includes("\x1b_Ga=T"));
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("evicts offscreen Kitty images when decoded raster memory exceeds the cache quota", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 1);
			const tui = new TuiAltScreen(terminal);
			const firstImageId = 600;
			const imageLines = Array.from({ length: 4 }, (_, index) => {
				const imageId = firstImageId + index;
				registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 3840, heightPx: 2160 });
				return encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			});
			tui.setLayoutRoot(new ScrollView({ render: () => imageLines, invalidate: () => {} }, { primary: true }));
			tui.start();
			await terminal.waitForRender();
			for (let index = 1; index < imageLines.length; index++) {
				tui.scrollBy(1);
				await terminal.waitForRender();
			}
			assert.ok(
				terminal.events.some(
					(event) => event.type === "write" && event.data.includes(`\x1b_Ga=d,d=I,i=${firstImageId},q=2\x1b\\`),
				),
			);
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("opens an OSC 8 hyperlink on click but not on drag", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const openedUrls: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			openUrl: (url) => openedUrls.push(url),
		});
		const url = "https://example.com/path?q=1";
		const belUrl = "https://example.com/bel";
		const emojiUrl = "https://example.com/emoji";
		tui.addChild(
			new Text(
				`${hyperlink("link", url)}\n\x1b]8;;${belUrl}\x07link\x1b]8;;\x07\n${hyperlink("🙂", emojiUrl)}`,
				0,
				0,
			),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<0;2;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, [url]);

		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, [url, belUrl]);

		terminal.sendInput("\x1b[<0;2;3M");
		terminal.sendInput("\x1b[<0;2;3m");
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, [url, belUrl, emojiUrl]);

		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<32;4;1M");
		terminal.sendInput("\x1b[<0;4;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, [url, belUrl, emojiUrl]);

		tui.stop();
	});

	it("selects visible text with the mouse and copies it with OSC 52", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("\x1b[1mal\x1b[0mpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();

		const expectedClipboardSequence = `\x1b]52;c;${Buffer.from("alpha\nbeta").toString("base64")}\x07`;
		const clipboardWrites = terminal.events.filter(
			(event) => event.type === "write" && event.data.includes("\x1b]52;c;"),
		);
		assert.ok(
			clipboardWrites.some((event) => event.type === "write" && event.data.includes(expectedClipboardSequence)),
			JSON.stringify(clipboardWrites),
		);
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[7m")));
		assert.ok(
			terminal.events.some((event) => event.type === "write" && event.data.includes("al\x1b[0m\x1b[7mpha")),
			"selection inverse must be reapplied after a reset inside the selection",
		);
		assert.ok(terminal.getViewport().some((line) => line.includes("Copied!")));

		tui.stop();
	});

	it("stacks flash messages and collapses them as they expire", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("one\ntwo\nthree\nfour", 0, 0));
		tui.start();
		await terminal.waitForRender();

		tui.flash("First", 40);
		tui.flash("Second", 500);
		await terminal.waitForRender();
		let viewport = terminal.getViewport();
		assert.ok(viewport[0]?.endsWith(" First "));
		assert.ok(viewport[1]?.endsWith(" Second "));

		await new Promise((resolve) => setTimeout(resolve, 80));
		await terminal.waitForRender();
		viewport = terminal.getViewport();
		assert.ok(viewport[0]?.endsWith(" Second "));
		assert.ok(!viewport.some((line) => line.includes("First")));

		tui.stop();
	});

	it("keeps selection highlighting active across embedded SGR resets", async () => {
		const terminal = new RecordingTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("\x1b[31mred\x1b[0m plain", 0, 0));
		tui.start();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;8;1M");
		await terminal.waitForRender();
		const writes = terminal.events
			.filter((event) => event.type === "write")
			.map((event) => event.data)
			.join("");
		assert.ok(writes.includes("\x1b[0m\x1b[7m"));
		terminal.sendInput("\x1b[<0;8;1m");
		await terminal.waitForRender();
		tui.stop();
	});

	it("snaps mouse selection to CJK, emoji, and combining grapheme boundaries", async () => {
		const terminal = new RecordingTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("A界🙂éZ", 0, 0));
		tui.start();
		await terminal.waitForRender();

		const wideSelection = `\x1b]52;c;${Buffer.from("界🙂").toString("base64")}\x07`;
		terminal.sendInput("\x1b[<0;3;1M");
		terminal.sendInput("\x1b[<32;4;1M");
		terminal.sendInput("\x1b[<0;4;1m");
		await terminal.waitForRender();
		assert.strictEqual(
			terminal.events.filter((event) => event.type === "write" && event.data.includes(wideSelection)).length,
			1,
		);

		terminal.sendInput("\x1b[<0;5;1M");
		terminal.sendInput("\x1b[<32;2;1M");
		terminal.sendInput("\x1b[<0;2;1m");
		await terminal.waitForRender();
		assert.strictEqual(
			terminal.events.filter((event) => event.type === "write" && event.data.includes(wideSelection)).length,
			2,
		);

		const combiningSelection = `\x1b]52;c;${Buffer.from("éZ").toString("base64")}\x07`;
		terminal.sendInput("\x1b[<0;6;1M");
		terminal.sendInput("\x1b[<32;7;1M");
		terminal.sendInput("\x1b[<0;7;1m");
		await terminal.waitForRender();
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(combiningSelection)));

		tui.stop();
	});

	it("does not append whitespace to double-click word highlighting", async () => {
		const terminal = new RecordingTerminal(20, 1);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("foo  bar", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		terminal.sendInput("\x1b[<0;3;1M");
		await terminal.waitForRender();

		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("foo\x1b[27m")));
		tui.stop();
	});

	it("highlights a complete whitespace segment during a word drag", async () => {
		const terminal = new RecordingTerminal(20, 1);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("foo  bar", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<32;4;1M");
		await terminal.waitForRender();

		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("foo  \x1b[27m")));
		tui.stop();
	});

	it("selects whole words on double click, extends word drags, and selects lines on triple click", async () => {
		const terminal = new RecordingTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("zero alpha beta\ngamma delta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		// The second click lands on a different character in alpha.
		terminal.sendInput("\x1b[<0;6;1M");
		terminal.sendInput("\x1b[<0;6;1m");
		terminal.sendInput("\x1b[<0;10;1M");
		terminal.sendInput("\x1b[<0;10;1m");
		await terminal.waitForRender();
		const alpha = `\x1b]52;c;${Buffer.from("alpha").toString("base64")}\x07`;
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(alpha)));

		// A double-click drag includes each word touched, rather than partial words.
		terminal.sendInput("\x1b[<0;12;1M");
		terminal.sendInput("\x1b[<0;12;1m");
		terminal.sendInput("\x1b[<0;14;1M");
		terminal.sendInput("\x1b[<32;3;2M");
		terminal.sendInput("\x1b[<0;3;2m");
		await terminal.waitForRender();
		const words = `\x1b]52;c;${Buffer.from("beta\ngamma").toString("base64")}\x07`;
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(words)));

		terminal.sendInput("\x1b[<0;7;2M");
		terminal.sendInput("\x1b[<0;7;2m");
		terminal.sendInput("\x1b[<0;9;2M");
		terminal.sendInput("\x1b[<0;9;2m");
		terminal.sendInput("\x1b[<0;11;2M");
		terminal.sendInput("\x1b[<0;11;2m");
		await terminal.waitForRender();
		const line = `\x1b]52;c;${Buffer.from("gamma delta").toString("base64")}\x07`;
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(line)));

		tui.stop();
	});

	it("resets the multi-click count after the double-click interval", async () => {
		const originalNow = Date.now;
		let now = 1_000;
		Date.now = () => now;
		const terminal = new RecordingTerminal(10, 1);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha", 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			const click = () => {
				terminal.sendInput("\x1b[<0;1;1M");
				terminal.sendInput("\x1b[<0;1;1m");
			};
			const alpha = `\x1b]52;c;${Buffer.from("alpha").toString("base64")}\x07`;
			const copyCount = () =>
				terminal.events.filter((event) => event.type === "write" && event.data.includes(alpha)).length;

			click();
			now += 501;
			click();
			assert.strictEqual(copyCount(), 0);

			now += 500;
			click();
			assert.strictEqual(copyCount(), 1);
		} finally {
			tui.stop();
			Date.now = originalNow;
		}
	});

	it("selects Unicode segments inside links without reopening them on the second click", async () => {
		const terminal = new RecordingTerminal(24, 1);
		const openedUrls: string[] = [];
		const url = "https://example.com/unicode";
		const tui = new TuiAltScreen(terminal, false, undefined, { openUrl: (openedUrl) => openedUrls.push(openedUrl) });
		tui.addChild(new Text(`${hyperlink("naïve", url)} 東京 🙂`, 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			const click = (column: number) => {
				terminal.sendInput(`\x1b[<0;${column};1M`);
				terminal.sendInput(`\x1b[<0;${column};1m`);
			};
			const hasCopied = (text: string) => {
				const payload = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
				return terminal.events.some((event) => event.type === "write" && event.data.includes(payload));
			};

			click(1);
			click(5);
			assert.deepStrictEqual(openedUrls, [url]);
			assert.ok(hasCopied("naïve"));

			click(7);
			click(10);
			assert.ok(hasCopied("東京"));

			click(12);
			click(13);
			assert.ok(hasCopied("🙂"));
		} finally {
			tui.stop();
		}
	});

	it("triple-clicks a visual line after text wrapping", async () => {
		const terminal = new RecordingTerminal(10, 2);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha beta gamma", 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			assert.deepStrictEqual(
				terminal.getViewport().map((line) => line.trimEnd()),
				["alpha beta", "gamma"],
			);
			for (const column of [1, 3, 5]) {
				terminal.sendInput(`\x1b[<0;${column};1M`);
				terminal.sendInput(`\x1b[<0;${column};1m`);
			}
			const payload = `\x1b]52;c;${Buffer.from("alpha beta").toString("base64")}\x07`;
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(payload)));
		} finally {
			tui.stop();
		}
	});

	it("keeps overlay input ahead of transcript navigation and captured pointer interactions", async () => {
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		assert.ok(platformDescriptor);
		const terminal = new VirtualTerminal(12, 5);
		let pasteCount = 0;
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			onRightClickPaste: () => {
				pasteCount += 1;
			},
		});
		const scrollView = new ScrollView(
			new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ primary: true, scrollbar: "always" },
		);
		const overlayInput: string[] = [];
		const overlay = {
			render: () => ["overlay"],
			invalidate: () => {},
			handleInput: (data: string) => overlayInput.push(data),
		};
		tui.setLayoutRoot(scrollView);
		try {
			tui.start();
			await terminal.waitForRender();
			scrollView.scrollTo(3);
			await terminal.waitForRender();
			const overlayHandle = tui.showOverlay(overlay, { row: 1, col: 1, width: 7 });
			terminal.sendInput("\x1b[5~");
			terminal.sendInput("\x1b[<64;1;1M");
			assert.deepStrictEqual(overlayInput, ["\x1b[5~"]);
			assert.strictEqual(scrollView.scrollTop, 3);
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			terminal.sendInput("\x1b[<2;2;2M");
			assert.strictEqual(pasteCount, 1);
			overlayHandle.hide();
			await terminal.waitForRender();

			scrollView.scrollTo(0);
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;12;1M");
			const dragOverlay = tui.showOverlay(overlay, { row: 1, col: 1, width: 7 });
			terminal.sendInput("\x1b[<32;12;5M");
			terminal.sendInput("\x1b[<0;12;5m");
			assert.strictEqual(scrollView.scrollTop, 0);
			dragOverlay.hide();
			terminal.sendInput("\x1b[<32;12;5M");
			terminal.sendInput("\x1b[<0;12;5m");
			assert.strictEqual(scrollView.scrollTop, 0);

			const nonCapturing = tui.showOverlay(overlay, { nonCapturing: true, row: 1, col: 1, width: 7 });
			terminal.sendInput("\x1b[<0;12;1M");
			terminal.sendInput("\x1b[<32;12;5M");
			terminal.sendInput("\x1b[<0;12;5m");
			assert.strictEqual(scrollView.scrollTop, 7);
			nonCapturing.hide();
		} finally {
			Object.defineProperty(process, "platform", platformDescriptor);
			tui.stop({ preserveScreen: true });
		}
	});

	it("retargets focus before viewport input when resize reveals a capturing overlay", async () => {
		const terminal = new VirtualTerminal(12, 5);
		const tui = new TuiAltScreen(terminal);
		const scrollView = new ScrollView(
			new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ primary: true },
		);
		const editor = { render: () => ["editor"], invalidate: () => {}, handleInput: () => {} };
		const baseOverlay = { render: () => ["base overlay"], invalidate: () => {}, handleInput: () => {} };
		const overlayInput: string[] = [];
		const overlay = {
			render: () => ["overlay"],
			invalidate: () => {},
			handleInput: (data: string) => overlayInput.push(data),
		};
		tui.setLayoutRoot(scrollView);
		tui.setFocus(editor);
		tui.start();
		try {
			await terminal.waitForRender();
			scrollView.scrollTo(3);
			tui.showOverlay(baseOverlay);
			assert.strictEqual(tui.getFocusedComponent(), baseOverlay);
			tui.showOverlay(overlay, { visible: (_width, height) => height < 5 });
			assert.strictEqual(tui.getFocusedComponent(), baseOverlay);
			terminal.resize(12, 4);
			assert.strictEqual(tui.getFocusedComponent(), overlay);
			terminal.sendInput("\x1b[5~");
			assert.deepStrictEqual(overlayInput, ["\x1b[5~"]);
			assert.strictEqual(scrollView.scrollTop, 3);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("auto-scrolls edge selections and cancels them on release, focus loss, and overlays", async () => {
		mock.timers.enable({ apis: ["setInterval"] });
		const terminal = new VirtualTerminal(16, 4);
		const tui = new TuiAltScreen(terminal);
		const scrollView = new ScrollView(
			new Text(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ primary: true },
		);
		tui.setLayoutRoot(scrollView);
		try {
			tui.start();
			await terminal.waitForRender();
			scrollView.scrollTo(8);
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<0;1;3M");
			terminal.sendInput("\x1b[<32;5;1M");
			mock.timers.tick(150);
			assert.strictEqual(scrollView.scrollTop, 5);
			terminal.sendInput("\x1b[<0;5;1m");
			mock.timers.tick(150);
			assert.strictEqual(scrollView.scrollTop, 5);

			terminal.sendInput("\x1b[<0;1;2M");
			terminal.sendInput("\x1b[<32;5;4M");
			terminal.sendInput("\x1b[O");
			mock.timers.tick(150);
			assert.strictEqual(scrollView.scrollTop, 5);

			terminal.sendInput("\x1b[I");
			terminal.sendInput("\x1b[<0;1;2M");
			terminal.sendInput("\x1b[<32;5;4M");
			const overlay = tui.showOverlay(new Text("overlay", 0, 0), { row: 1, col: 1, width: 7 });
			mock.timers.tick(150);
			assert.strictEqual(scrollView.scrollTop, 5);
			overlay.hide();

			terminal.sendInput("\x1b[<0;1;2M");
			terminal.sendInput("\x1b[<32;5;4M");
			terminal.resize(12, 3);
			mock.timers.tick(150);
			assert.strictEqual(scrollView.scrollTop, 5);
		} finally {
			tui.stop({ preserveScreen: true });
			mock.timers.reset();
		}
	});

	it("keeps keyboard navigation available without enabling terminal mouse tracking", async () => {
		const terminal = new RecordingTerminal(16, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { mouse: false });
		const inputs: string[] = [];
		tui.addChild({
			render: () => Array.from({ length: 10 }, (_, index) => `line ${index + 1}`),
			invalidate: () => {},
			handleInput: (data: string) => inputs.push(data),
		});
		tui.setFocus(tui.children[0] ?? null);
		tui.start();
		try {
			await terminal.waitForRender();
			const writes = collectRecordedWrites(terminal);
			assertMouseModeWrites(writes, "h", NO_MOUSE_MODES);
			terminal.sendInput("\x1b[5~");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 5);
			const wheel = "\x1b[<64;1;1M";
			terminal.sendInput(wheel);
			assert.strictEqual(tui.viewportTop, 5);
			assert.deepStrictEqual(inputs, [wheel]);
		} finally {
			tui.stop({ preserveScreen: true });
		}
		const shutdownWrites = collectRecordedWrites(terminal);
		assertMouseModeWrites(shutdownWrites, "l", NO_MOUSE_MODES);
	});

	it("ignores horizontal trackpad wheel events", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<66;1;1M");
		terminal.sendInput("\x1b[<67;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 4);
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8"],
		);

		tui.stop();
	});

	it("uses button-motion tracking and preserves mouse interactions in multiplexer environments", async () => {
		const keys = ["TMUX", "ZELLIJ", "STY", "TERM"] as const;
		const previous = new Map(keys.map((key) => [key, process.env[key]]));
		try {
			clearMultiplexerEnvironment();
			process.env.TERM = "xterm-256color";
			const direct = new RecordingTerminal();
			const directTui = new TuiAltScreen(direct);
			directTui.start();
			const directStartupWrites = collectRecordedWrites(direct);
			assertMouseModeWrites(directStartupWrites, "h", ALL_MOUSE_MODES, "direct terminal");
			directTui.stop();
			const directShutdownWrites = collectRecordedWrites(direct);
			assertMouseModeWrites(directShutdownWrites, "l", ALL_MOUSE_MODES, "direct terminal");

			const multiplexers = [
				{ name: "tmux environment", environment: { TMUX: "/tmp/tmux/default,1,0" } },
				{ name: "tmux TERM", environment: { TERM: "tmux-256color" } },
				{ name: "Zellij environment", environment: { ZELLIJ: "0" } },
				{ name: "Screen environment", environment: { STY: "123.session" } },
				{ name: "Screen TERM", environment: { TERM: "screen-256color" } },
			];
			for (const { name, environment } of multiplexers) {
				clearMultiplexerEnvironment();
				Object.assign(process.env, environment);
				const terminal = new RecordingTerminal(10, 5);
				const scrollView = new ScrollView(
					new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
					{ primary: true, scrollbar: "always" },
				);
				const tui = new TuiAltScreen(terminal);
				tui.setLayoutRoot(scrollView);
				tui.start();
				try {
					await terminal.waitForRender();
					const startupWrites = collectRecordedWrites(terminal);
					assertMouseModeWrites(startupWrites, "h", MULTIPLEXER_MOUSE_MODES, name);
					terminal.sendInput("\x1b[<65;1;1M");
					await terminal.waitForRender();
					assert.strictEqual(scrollView.scrollTop, 1, `${name} should preserve wheel scrolling`);

					const copiedText = `\x1b]52;c;${Buffer.from("line").toString("base64")}\x07`;
					terminal.sendInput("\x1b[<0;1;1M");
					terminal.sendInput("\x1b[<32;4;1M");
					terminal.sendInput("\x1b[<0;4;1m");
					await terminal.waitForRender();
					const selectionWrites: string = collectRecordedWrites(terminal);
					assert.ok(selectionWrites.includes(copiedText), `${name} should preserve text selection`);

					terminal.sendInput("\x1b[<0;10;1M");
					terminal.sendInput("\x1b[<32;10;5M");
					terminal.sendInput("\x1b[<0;10;5m");
					await terminal.waitForRender();
					assert.strictEqual(scrollView.scrollTop, 7, `${name} should preserve scrollbar dragging`);
				} finally {
					tui.stop();
				}
				const shutdownWrites = collectRecordedWrites(terminal);
				assertMouseModeWrites(shutdownWrites, "l", ALL_MOUSE_MODES, name);
			}
		} finally {
			for (const key of keys) {
				const value = previous.get(key);
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("does not resurrect orphan selections after scroll, resize, overlay, or focus changes", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const scrollView = new ScrollView(
			new Text(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ primary: true },
		);
		tui.setLayoutRoot(scrollView);
		tui.start();
		try {
			await terminal.waitForRender();
			const clipboardWriteCount = () =>
				terminal.events.filter((event) => event.type === "write" && event.data.includes("\x1b]52;c;")).length;

			// A completed click leaves a zero-width anchor. Scrolling, resizing, and
			// overlay composition must not let later orphaned motion extend it.
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<0;1;1m");
			terminal.sendInput("\x1b[<64;1;1M");
			terminal.resize(12, 3);
			const overlay = tui.showOverlay(new Text("overlay", 0, 0), { row: 0, col: 0, width: 7 });
			await terminal.waitForRender();
			const orphanEventStart = terminal.events.length;
			terminal.sendInput("\x1b[<32;4;2M");
			terminal.sendInput("\x1b[<0;4;2m");
			await terminal.waitForRender();
			assert.strictEqual(clipboardWriteCount(), 0);
			assert.ok(
				terminal.events
					.slice(orphanEventStart)
					.every((event) => event.type !== "write" || !event.data.includes("\x1b[7m")),
			);
			overlay.hide();
			await terminal.waitForRender();

			// Losing focus cancels an in-flight drag and removes its highlight before
			// unmatched events arrive after the pane regains focus.
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;4;2M");
			await terminal.waitForRender();
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[7m")));
			terminal.sendInput("\x1b[O");
			terminal.sendInput("\x1b[I");
			const focusEventStart = terminal.events.length;
			terminal.sendInput("\x1b[<32;4;2M");
			terminal.sendInput("\x1b[<0;4;2m");
			await terminal.waitForRender();
			assert.strictEqual(clipboardWriteCount(), 0);
			assert.ok(
				terminal.events
					.slice(focusEventStart)
					.every((event) => event.type !== "write" || !event.data.includes("\x1b[7m")),
			);
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[?1004h")));
		} finally {
			tui.stop();
		}
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[?1004l")));
	});

	it("repaints resized alternate screens", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("one\ntwo\nthree\nfour", 0, 0));
		tui.start();
		await terminal.waitForRender();
		terminal.resize(10, 2);
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["three", "four"],
		);
		tui.stop();
	});

	it("rolls back alternate-screen and image capability state when startup throws", () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		try {
			class ThrowingStartTerminal extends RecordingTerminal {
				override start(onInput: (data: string) => void, onResize: () => void): void {
					super.start(onInput, onResize);
					throw new Error("start failed");
				}
			}
			const terminal = new ThrowingStartTerminal();
			const tui = new TuiAltScreen(terminal);
			assert.throws(() => tui.start(), /start failed/);
			assert.strictEqual(getCapabilities().images, "iterm2");
			assert.ok(terminal.events.some((event) => event.type === "stop"));
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[?1049l")));
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("restores alternate-screen state even when terminal shutdown throws", () => {
		class ThrowingStopTerminal extends RecordingTerminal {
			override stop(): void {
				super.stop();
				throw new Error("stop failed");
			}
		}
		const terminal = new ThrowingStopTerminal();
		const tui = new TuiAltScreen(terminal);
		tui.start();
		assert.throws(() => tui.stop(), /stop failed/);
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[?1049l")));
	});
	it("preserves the previous main buffer for temporary stop and repaints after restart", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("first\nsecond\nthird\nfourth", 0, 0));
		tui.start();
		await terminal.waitForRender();
		tui.requestRender();
		tui.stop({ preserveScreen: true });

		const temporaryExit = terminal.events
			.slice()
			.reverse()
			.find((event) => event.type === "write" && event.data.includes("\x1b[?1049l"));
		assert.strictEqual(temporaryExit?.type, "write");
		if (temporaryExit?.type === "write") {
			assert.ok(!temporaryExit.data.includes("first"));
			assert.ok(!temporaryExit.data.includes("fourth"));
			assert.ok(!temporaryExit.data.includes("\r\n"));
		}

		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(
			terminal.events.filter((event) => event.type === "write" && event.data.includes("\x1b[?1049h")).length,
			2,
		);
		tui.stop();
		const finalExit = terminal.events
			.slice()
			.reverse()
			.find((event) => event.type === "write" && event.data.includes("\x1b[?1049l"));
		assert.strictEqual(finalExit?.type, "write");
		if (finalExit?.type === "write") {
			assert.ok(finalExit.data.includes("first"));
			assert.ok(finalExit.data.includes("fourth"));
		}
	});

	it("restores iTerm2 capability state when alternate-screen exit output throws", () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		try {
			class ThrowingExitTerminal extends RecordingTerminal {
				override write(data: string): void {
					super.write(data);
					if (data.includes("\x1b[?1049l")) throw new Error("exit failed");
				}
			}
			const terminal = new ThrowingExitTerminal();
			const tui = new TuiAltScreen(terminal);
			tui.start();
			assert.throws(() => tui.stop(), /exit failed/);
			assert.strictEqual(getCapabilities().images, "iterm2");
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("restores keyboard state before leaving alt mode and prints the full document", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("first\nsecond\nthird\nfourth\nfifth\nsixth", 0, 0));
		tui.start();
		await terminal.waitForRender();
		tui.stop();

		const startIndex = terminal.events.findIndex((event) => event.type === "start");
		const altScreenEnterIndex = terminal.events.findIndex(
			(event) => event.type === "write" && event.data.includes("\x1b[?1049h"),
		);
		const stopIndex = terminal.events.findIndex((event) => event.type === "stop");
		const mouseDisableIndex = terminal.events.findIndex(
			(event) => event.type === "write" && event.data.includes("\x1b[?1006l"),
		);
		const mainScreenRestoreIndex = terminal.events.findIndex(
			(event) => event.type === "write" && event.data.includes("\x1b[?1049l"),
		);
		assert.ok(altScreenEnterIndex >= 0 && altScreenEnterIndex < startIndex);
		assert.ok(mouseDisableIndex >= 0 && mouseDisableIndex < stopIndex);
		assert.ok(mainScreenRestoreIndex > stopIndex);

		const restoreEvent = terminal.events[mainScreenRestoreIndex];
		assert.strictEqual(restoreEvent?.type, "write");
		if (restoreEvent?.type === "write") {
			assert.ok(restoreEvent.data.includes("first"));
			assert.ok(restoreEvent.data.includes("second"));
			assert.ok(restoreEvent.data.includes("third"));
			assert.ok(restoreEvent.data.includes("fourth"));
			assert.ok(restoreEvent.data.includes("fifth"));
			assert.ok(restoreEvent.data.includes("sixth"));
			assert.ok(restoreEvent.data.indexOf("first") < restoreEvent.data.indexOf("sixth"));
		}
	});
});
