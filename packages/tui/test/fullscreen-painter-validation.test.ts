import assert from "node:assert";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { type LayoutBox, renderLayoutFrame } from "../src/layout.ts";
import {
	encodeKitty,
	registerKittyImageMetadata,
	resetCapabilitiesCache,
	setCapabilities,
} from "../src/terminal-image.ts";
import { type Component, compositeTuiLine } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { normalizeTerminalOutput, sliceByColumn, visibleWidth } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const SEED = 0x92_18_dee5;
const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

class MutableLines implements Component {
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class TrackingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];
	private activeHyperlink: string | undefined;

	override write(data: string): void {
		this.writes.push(data);
		const osc8 = /\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
		for (const match of data.matchAll(osc8)) this.activeHyperlink = match[1] || undefined;
		super.write(data);
	}

	assertHyperlinkClosed(label: string): void {
		assert.strictEqual(
			this.activeHyperlink,
			undefined,
			`${label}: OSC 8 hyperlink state leaked across a terminal write`,
		);
	}
}

function createRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state += 0x6d2b79f5;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
	};
}

function randomInt(random: () => number, upperExclusive: number): number {
	return Math.floor(random() * upperExclusive);
}

function generatedLine(random: () => number, id: number): string {
	switch (randomInt(random, 8)) {
		case 0:
			return `plain-${id}-${"x".repeat(randomInt(random, 60))}`;
		case 1:
			return `\x1b[31mred-${id}\x1b[0m plain-tail`;
		case 2:
			return `before \x1b]8;;https://example.com/${id}\x1b\\linked-${id}\x1b]8;;\x1b\\ after`;
		case 3:
			return `before \x1b]8;;https://example.com/bel/${id}\x07linked-${id}\x1b]8;;\x07 after`;
		case 4:
			return `wide-${id}-界🙂é-終`;
		case 5:
			return `\x1b[1mbold-${id}\x1b[0m-${"y".repeat(220)}`;
		case 6:
			return `\x1b]133;B\x07\x1b]133;C\x07prompt-${id}`;
		default:
			return id % 5 === 0 ? "" : `reset-${id}-\x1b[7minverse\x1b[0m-tail`;
	}
}

function slowPaint(box: LayoutBox, screen: string[], width: number): void {
	if (box.lines) {
		const offset = box.lineOffset ?? 0;
		const firstRow = Math.max(box.rect.y, box.clip.y, 0);
		const lastRow = Math.min(box.rect.y + box.rect.height, box.clip.y + box.clip.height, screen.length);
		for (let row = firstRow; row < lastRow; row++) {
			const sourceLine = box.lines[offset + row - box.rect.y];
			if (sourceLine === undefined || box.clip.width <= 0) continue;
			const line = sourceLine.replace(OSC133_ZONE_PREFIX, "");
			const sourceStart = Math.max(0, box.clip.x - box.rect.x);
			const clippedLine = sliceByColumn(line, sourceStart, box.clip.width, true);
			screen[row] = compositeTuiLine(screen[row] ?? "", clippedLine, box.clip.x, box.clip.width, width);
		}
	}
	for (const child of box.children) slowPaint(child, screen, width);
}

async function renderReference(
	terminal: VirtualTerminal,
	lines: string[],
	width: number,
	height: number,
): Promise<void> {
	terminal.resize(width, height);
	terminal.reset();
	let output = "\x1b[2J";
	for (let row = 0; row < height; row++) {
		const line = normalizeTerminalOutput(lines[row] ?? "") + SEGMENT_RESET;
		output += `\x1b[${row + 1};1H\x1b[2K${line}`;
	}
	terminal.write(output);
	await terminal.flush();
}

function visualSnapshot(terminal: VirtualTerminal) {
	return terminal
		.getCellSnapshot()
		.map((row) => row.map((cell) => (cell.chars === " " ? { ...cell, chars: "" } : cell)));
}

function writesSince(terminal: TrackingTerminal, index: number): string {
	return terminal.writes.slice(index).join("");
}

describe("fullscreen painter validation", () => {
	it("matches the slow compositor through seeded streaming, tool-output shrink, scroll, and resize storms", async () => {
		const random = createRandom(SEED);
		const dimensions = [
			[20, 8],
			[40, 12],
			[80, 24],
			[160, 48],
			[2, 3],
			[1, 1],
		] as const;
		let nextLineId = 0;
		const transcript = new MutableLines(
			Array.from({ length: 1200 }, () => `tool-stale-${nextLineId++}-${"z".repeat(120)}`),
		);
		const dock = new MutableLines(["status", "editor"]);
		const scrollView = new ScrollView(transcript, {
			follow: "end",
			primary: true,
			scrollbar: "hidden",
		});
		const root = new VStack([
			{ component: scrollView, basis: 0, grow: 1, minSize: 1 },
			{ component: dock, basis: 2, shrink: 0, minSize: 1 },
		]);
		const terminal = new TrackingTerminal(20, 8);
		const reference = new VirtualTerminal(20, 8);
		const tui = new TuiAltScreen(terminal);
		tui.setLayoutRoot(root);
		tui.start();
		try {
			const validate = async (label: string): Promise<void> => {
				tui.renderNow();
				await terminal.flush();
				const frame = renderLayoutFrame(root, terminal.columns, terminal.rows, () => {});
				const slowLines = Array.from({ length: frame.height }, () => "");
				slowPaint(frame.root, slowLines, frame.width);
				assert.ok(
					frame.lines.every((line) => visibleWidth(line) <= frame.width),
					`${label}: optimized row overflow`,
				);
				assert.ok(
					slowLines.every((line) => visibleWidth(line) <= frame.width),
					`${label}: reference row overflow`,
				);
				await renderReference(reference, slowLines, frame.width, frame.height);
				assert.deepStrictEqual(visualSnapshot(terminal), visualSnapshot(reference), `${label}; seed=${SEED}`);
				terminal.assertHyperlinkClosed(label);
			};

			await validate("large tool output");
			transcript.lines = ["tool-current-a", "tool-current-b"];
			await validate("large tool output shrink");
			assert.ok(!terminal.getViewport().some((line) => line.includes("tool-stale-")));

			for (let index = 0; index < 80; index++) {
				transcript.lines.push(generatedLine(random, nextLineId++));
				await validate(`streaming frame ${index}`);
			}

			for (let step = 0; step < 160; step++) {
				switch (randomInt(random, 7)) {
					case 0:
						transcript.lines.push(generatedLine(random, nextLineId++));
						break;
					case 1:
						if (transcript.lines.length > 0) {
							transcript.lines[randomInt(random, transcript.lines.length)] = generatedLine(random, nextLineId++);
						}
						break;
					case 2:
						transcript.lines.length = randomInt(random, transcript.lines.length + 1);
						break;
					case 3:
						transcript.lines = Array.from({ length: 50 + randomInt(random, 250) }, () =>
							generatedLine(random, nextLineId++),
						);
						break;
					case 4:
						scrollView.scrollBy(randomInt(random, 25) - 12);
						break;
					case 5: {
						const [width, height] = dimensions[randomInt(random, dimensions.length)]!;
						terminal.resize(width, height);
						break;
					}
					default:
						dock.lines = [generatedLine(random, nextLineId++), `editor-${step}`];
				}
				await validate(`randomized frame ${step}`);
			}
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("keeps Kitty placements coherent across overlay, resize, scroll, reentry, and removal", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const imageId = 9200;
			const imageLine = encodeKitty("A".repeat(8192), {
				columns: 4,
				rows: 2,
				imageId,
				moveCursor: false,
			});
			registerKittyImageMetadata({ imageId, columns: 4, rows: 2, widthPx: 320, heightPx: 160 });
			const content = new MutableLines([
				imageLine,
				"",
				...Array.from({ length: 30 }, (_, index) => `tail-${index + 1}`),
			]);
			const scrollView = new ScrollView(content, { primary: true, scrollbar: "hidden" });
			const terminal = new TrackingTerminal(20, 6);
			const tui = new TuiAltScreen(terminal);
			tui.setLayoutRoot(
				new VStack([
					{ component: scrollView, basis: 0, grow: 1, minSize: 1 },
					{ component: new Text("dock", 0, 0), basis: 1, shrink: 0 },
				]),
			);
			tui.start();
			try {
				tui.renderNow();
				await terminal.flush();
				assert.ok(terminal.writes.some((write) => write.includes("\x1b_Ga=T") && write.includes(`i=${imageId}`)));

				let eventIndex = terminal.writes.length;
				const overlay = tui.showOverlay(new Text("overlay", 0, 0), { anchor: "bottom-center", width: 10 });
				tui.renderNow();
				await terminal.flush();
				let writes = writesSince(terminal, eventIndex);
				assert.ok(terminal.getViewport().some((line) => line.includes("overlay")));
				assert.ok(!writes.includes("\x1b_Ga=T"), "overlay must not retransmit unchanged image payloads");

				eventIndex = terminal.writes.length;
				overlay.hide();
				tui.renderNow();
				await terminal.flush();
				writes = writesSince(terminal, eventIndex);
				assert.ok(!terminal.getViewport().some((line) => line.includes("overlay")));
				assert.ok(!writes.includes("\x1b_Ga=T"), "overlay removal must not retransmit unchanged image payloads");

				eventIndex = terminal.writes.length;
				terminal.resize(40, 12);
				tui.renderNow();
				await terminal.flush();
				writes = writesSince(terminal, eventIndex);
				assert.ok(writes.includes("\x1b_Ga=d,d=a,q=2\x1b\\"));
				assert.ok(writes.includes("\x1b_Ga=p,q=2"));
				assert.ok(!writes.includes("\x1b_Ga=T"), "resize must reuse the transmitted payload");

				eventIndex = terminal.writes.length;
				scrollView.scrollBy(3);
				tui.renderNow();
				await terminal.flush();
				writes = writesSince(terminal, eventIndex);
				assert.ok(writes.includes("\x1b_Ga=d,d=a,q=2\x1b\\"));
				assert.ok(!writes.includes("\x1b_Ga=p,q=2"), "offscreen image must not leave a placement");

				eventIndex = terminal.writes.length;
				scrollView.scrollBy(-3);
				tui.renderNow();
				await terminal.flush();
				writes = writesSince(terminal, eventIndex);
				assert.ok(writes.includes("\x1b_Ga=p,q=2"));
				assert.ok(!writes.includes("\x1b_Ga=T"), "reentry must use a placement-only command");

				eventIndex = terminal.writes.length;
				content.lines = ["replacement", "tail"];
				tui.renderNow();
				await terminal.flush();
				writes = writesSince(terminal, eventIndex);
				assert.ok(writes.includes("\x1b_Ga=d,d=a,q=2\x1b\\"));
				assert.ok(!writes.includes("\x1b_Ga=p,q=2"));
				assert.ok(!terminal.getViewport().some((line) => line.includes("tail-5")));
				terminal.assertHyperlinkClosed("Kitty matrix");
			} finally {
				tui.stop({ preserveScreen: true });
			}
		} finally {
			resetCapabilitiesCache();
		}
	});
});
