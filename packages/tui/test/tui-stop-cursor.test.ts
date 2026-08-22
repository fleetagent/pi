import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, CURSOR_MARKER } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

type TerminalEvent =
	| { type: "write"; data: string }
	| { type: "showCursor" }
	| { type: "hideCursor" }
	| { type: "start" }
	| { type: "stop" };

class RecordingTerminal extends VirtualTerminal {
	private events: TerminalEvent[] = [];

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.events.push({ type: "start" });
		super.start(onInput, onResize);
	}

	override stop(): void {
		this.events.push({ type: "stop" });
		super.stop();
	}

	override write(data: string): void {
		this.events.push({ type: "write", data });
		super.write(data);
	}

	override hideCursor(): void {
		this.events.push({ type: "hideCursor" });
		super.hideCursor();
	}

	override showCursor(): void {
		this.events.push({ type: "showCursor" });
		super.showCursor();
	}

	clearEvents(): void {
		this.events = [];
	}

	getEvents(): TerminalEvent[] {
		return this.events;
	}
}

class FakeCursorComponent implements Component {
	render(): string[] {
		return [`prompt ${CURSOR_MARKER}\x1b[7m \x1b[27m`];
	}

	invalidate(): void {}
}

function assertStopClearsFakeCursor(events: TerminalEvent[]): void {
	assert.deepStrictEqual(events, [
		{ type: "write", data: " " },
		{ type: "write", data: "\x1b[1B" },
		{ type: "write", data: "\r\n" },
		{ type: "showCursor" },
		{ type: "stop" },
	]);
}

describe("TUI stop cursor cleanup", () => {
	it("overwrites the fake cursor before restoring the terminal cursor", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiMainScreen(terminal);
		tui.addChild(new FakeCursorComponent());
		tui.start();
		await terminal.waitForRender();
		terminal.clearEvents();

		tui.stop();

		assertStopClearsFakeCursor(terminal.getEvents());
	});

	it("clears the fake cursor after a stop and restart cycle", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiMainScreen(terminal);
		tui.addChild(new FakeCursorComponent());
		tui.start();
		await terminal.waitForRender();
		tui.stop();

		tui.start();
		tui.requestRender(true);
		await terminal.waitForRender();
		terminal.clearEvents();
		tui.stop();

		assertStopClearsFakeCursor(terminal.getEvents());
	});

	it("does not write a cleanup space before the first render", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiMainScreen(terminal);
		tui.addChild(new FakeCursorComponent());
		tui.start();
		terminal.clearEvents();

		tui.stop();
		await new Promise<void>((resolve) => process.nextTick(resolve));

		assert.deepStrictEqual(terminal.getEvents(), [{ type: "showCursor" }, { type: "stop" }]);
	});
});
