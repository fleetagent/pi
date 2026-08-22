/**
 * Alt-screen render churn benchmark.
 *
 * Measures cumulative JS allocation and wall time for repeated TuiAltScreen
 * frames on a layout mirroring pi's fullscreen interactive mode:
 * VStack [ ScrollView(transcript), dock VStack [image, status, editor, footer] ].
 *
 * Scenarios cover a static long transcript, editor updates, a visible Kitty
 * image, a composited overlay, alternating viewport sizes, a streaming response,
 * and replacement of large tool output.
 *
 * Allocation is estimated with the V8 sampling heap profiler including
 * objects collected by minor/major GC, so it measures churn, not retention.
 *
 * Run from packages/tui: node test/render-churn-bench.ts
 */

import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import type { Terminal } from "../src/terminal.ts";
import {
	encodeKitty,
	registerKittyImageMetadata,
	resetCapabilitiesCache,
	setCapabilities,
} from "../src/terminal-image.ts";
import { type Component, Container, CURSOR_MARKER } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";

const COLUMNS = 100;
const ROWS = 30;
const WARMUP_FRAMES = 20;
const FRAMES = 300;
const SAMPLING_INTERVAL = 4096;

/** Terminal that discards output; keeps xterm parsing out of the measurement. */
class NullTerminal implements Terminal {
	bytesWritten = 0;
	private width = COLUMNS;
	private height = ROWS;

	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.bytesWritten += data.length;
	}
	get columns(): number {
		return this.width;
	}
	get rows(): number {
		return this.height;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	resize(columns: number, rows: number): void {
		this.width = columns;
		this.height = rows;
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

/** Editor stand-in that caches lines until its text changes. */
class EditorSim implements Component {
	private text = "";
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	append(char: string): void {
		this.text += char;
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) return this.cachedLines;
		const border = `\x1b[90m${"─".repeat(Math.max(1, width - 2))}\x1b[39m`;
		const lines = [border, ` > ${this.text}${CURSOR_MARKER}`, border];
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

class ImageSim implements Component {
	enabled = false;
	private readonly line: string;

	constructor(imageId: number) {
		this.line = encodeKitty("AAAA", { columns: 4, rows: 1, imageId, moveCursor: false });
		registerKittyImageMetadata({ imageId, columns: 4, rows: 1, widthPx: 160, heightPx: 40 });
	}

	invalidate(): void {}

	render(): string[] {
		return this.enabled ? [this.line] : [];
	}
}

function buildTranscript(): Container {
	const container = new Container();
	for (let index = 0; index < 150; index++) {
		const styled =
			index % 3 === 0
				? `\x1b[1m\x1b[36muser ${index}\x1b[39m\x1b[22m message with some \x1b[33mstyled\x1b[39m content padding padding`
				: `assistant ${index} plain response line with enough text to be representative of a transcript row`;
		container.addChild(new Text(styled, 1, 0));
	}
	return container;
}

interface SamplingNode {
	selfSize: number;
	children: SamplingNode[];
}

function sumProfile(node: SamplingNode): number {
	let total = node.selfSize;
	for (const child of node.children) total += sumProfile(child);
	return total;
}

interface ScenarioResult {
	allocatedBytes: number;
	elapsedMs: number;
	bytesWritten: number;
}

interface Harness {
	terminal: NullTerminal;
	tui: TuiAltScreen;
	transcript: Container;
	editor: EditorSim;
	image: ImageSim;
	streaming: Text;
	toolOutput: Text;
}

let nextImageId = 9000;

function createHarness(): Harness {
	const terminal = new NullTerminal();
	const tui = new TuiAltScreen(terminal, false, "/tmp/pi-tui-bench");
	const transcript = buildTranscript();
	const editor = new EditorSim();
	const image = new ImageSim(nextImageId++);
	const streaming = new Text("stream start", 1, 0);
	const toolOutput = new Text("", 1, 0);
	transcript.addChild(streaming);
	transcript.addChild(toolOutput);
	const scrollView = new ScrollView(transcript, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: "auto",
	});
	const status = new Text("\x1b[2mstatus: idle\x1b[22m", 1, 0);
	const footer = new Text("\x1b[2m~/workspaces/pi  main  100k tokens\x1b[22m", 1, 0);
	const dock = new VStack([
		{ component: image, shrink: 1, minSize: 0 },
		{ component: status, shrink: 1, minSize: 0 },
		{ component: editor, shrink: 1, minSize: 3 },
		{ component: footer, shrink: 1, minSize: 1 },
	]);
	tui.setLayoutRoot(
		new VStack([
			{ component: scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]),
	);
	return { terminal, tui, transcript, editor, image, streaming, toolOutput };
}

async function runScenario(
	session: Session,
	setup: (harness: Harness) => void,
	frame: (harness: Harness, index: number) => void,
): Promise<ScenarioResult> {
	const harness = createHarness();
	let sampling = false;
	try {
		setup(harness);
		harness.tui.start();
		for (let index = 0; index < WARMUP_FRAMES; index++) harness.tui.renderNow();

		const writtenBefore = harness.terminal.bytesWritten;
		await session.post("HeapProfiler.startSampling", {
			samplingInterval: SAMPLING_INTERVAL,
			includeObjectsCollectedByMajorGC: true,
			includeObjectsCollectedByMinorGC: true,
		});
		sampling = true;
		const start = performance.now();
		for (let index = 0; index < FRAMES; index++) {
			frame(harness, index);
			harness.tui.renderNow();
		}
		const elapsedMs = performance.now() - start;
		const { profile } = await session.post("HeapProfiler.stopSampling");
		sampling = false;
		return {
			allocatedBytes: sumProfile(profile.head as SamplingNode),
			elapsedMs,
			bytesWritten: harness.terminal.bytesWritten - writtenBefore,
		};
	} finally {
		if (sampling) await session.post("HeapProfiler.stopSampling").catch(() => undefined);
		harness.tui.stop();
	}
}

function report(name: string, result: ScenarioResult): void {
	const perFrameKiB = result.allocatedBytes / FRAMES / 1024;
	const totalMiB = result.allocatedBytes / 1024 / 1024;
	const msPerFrame = result.elapsedMs / FRAMES;
	console.log(
		`${name.padEnd(11)} allocated ${totalMiB.toFixed(1).padStart(7)} MiB total  ` +
			`${perFrameKiB.toFixed(1).padStart(8)} KiB/frame  ` +
			`${msPerFrame.toFixed(3).padStart(7)} ms/frame  ` +
			`${(result.bytesWritten / FRAMES).toFixed(0).padStart(6)} written bytes/frame`,
	);
}

async function main(): Promise<void> {
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	const session = new Session();
	session.connect();
	try {
		const staticResult = await runScenario(
			session,
			() => {},
			() => {},
		);
		const editorResult = await runScenario(
			session,
			() => {},
			(harness, index) => harness.editor.append(String.fromCharCode(97 + (index % 26))),
		);
		const imageResult = await runScenario(
			session,
			(harness) => {
				harness.image.enabled = true;
			},
			() => {},
		);
		const overlayResult = await runScenario(
			session,
			(harness) => {
				harness.tui.showOverlay(new Text("\x1b[1moverlay\x1b[0m\nbody\nfooter", 1, 0), {
					anchor: "center",
					width: 40,
					maxHeight: 5,
				});
			},
			() => {},
		);
		const resizeResult = await runScenario(
			session,
			() => {},
			(harness, index) => harness.terminal.resize(COLUMNS - (index % 2), ROWS + (index % 2)),
		);
		let streamingText = "stream start";
		const streamingResult = await runScenario(
			session,
			() => {},
			(harness, index) => {
				streamingText += ` token-${index}`;
				harness.streaming.setText(streamingText);
			},
		);
		const toolLines = Array.from({ length: 500 }, (_, index) => `tool row ${index}: ${"x".repeat(80)}`);
		const toolResult = await runScenario(
			session,
			(harness) => harness.toolOutput.setText(toolLines.join("\n")),
			(harness, index) => {
				const visibleIndex = toolLines.length - 1 - (index % 10);
				toolLines[visibleIndex] = `tool row ${index}: ${"y".repeat(80)}`;
				harness.toolOutput.setText(toolLines.join("\n"));
			},
		);

		console.log(`frames=${FRAMES} viewport=${COLUMNS}x${ROWS} transcript=150 components`);
		report("static", staticResult);
		report("editor", editorResult);
		report("image", imageResult);
		report("overlay", overlayResult);
		report("resize", resizeResult);
		report("streaming", streamingResult);
		report("tool-output", toolResult);
	} finally {
		session.disconnect();
		resetCapabilitiesCache();
	}
}

await main();
