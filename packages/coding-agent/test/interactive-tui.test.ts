import type { Component, Terminal, TUI, TuiMode } from "@fleetagent/pi-tui";
import {
	Container,
	isViewportTUI,
	ScrollView,
	stripTerminalSequences,
	Text,
	TuiAltScreen,
	TuiMainScreen,
	VStack,
	visibleWidth,
} from "@fleetagent/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { FullscreenExitOutput } from "../src/core/settings-manager.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import {
	createInteractiveTui,
	createInteractiveTuiReference,
	InteractiveMode,
} from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, type Theme } from "../src/modes/interactive/theme/theme.ts";

const clipboardMocks = vi.hoisted(() => ({
	copyToClipboard: vi.fn<(text: string) => Promise<void>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/utils/clipboard.ts", () => ({
	copyToClipboard: clipboardMocks.copyToClipboard,
	readClipboardText: clipboardMocks.readClipboardText,
}));

class RecordingTerminal extends VirtualTerminal implements Terminal {
	readonly writes: string[] = [];
	readonly progressStates: boolean[] = [];
	startCount = 0;
	stopCount = 0;

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.startCount += 1;
		super.start(onInput, onResize);
	}
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	override setProgress(active: boolean): void {
		this.progressStates.push(active);
	}

	override stop(): void {
		this.stopCount += 1;
		super.stop();
	}
}

class FocusText extends Text {
	focused = false;
	handleInput(_data: string): void {}
}

type MountRootContext = {
	ui: TUI;
	renderer: TuiMainScreen | TuiAltScreen;
	headerContainer: Container;
	loadedResourcesContainer: Container;
	chatContainer: Container;
	documentContainer: Container;
	transcriptScrollView: ScrollView | undefined;
	fullscreenLayoutRoot: Component | undefined;
	pendingMessagesContainer: Container;
	statusContainer: Container;
	widgetContainerAbove: Container;
	editorContainer: Container;
	widgetContainerBelow: Container;
	footer: Component;
	footerContainer: Container;
	customFooter: Component | undefined;
	editor: Component;
	renderWidgets: () => void;
	runtimeHost: {
		session: { settingsManager: { getFullscreenScrollbar(): "hidden" | "auto" | "always" } };
	};
};

type SetFooterContext = {
	ui: TUI;
	customFooter: (Component & { dispose?(): void }) | undefined;
	footer: Component;
	footerContainer: Container;
	footerDataProvider: unknown;
};

type HeaderContext = {
	options: { verbose?: boolean };
	settingsManager: { getQuietStartup(): boolean };
	version: string;
	headerContainer: Container;
	builtInHeader: Component | undefined;
	customHeader: (Component & { dispose?(): void }) | undefined;
	toolOutputExpanded: boolean;
	ui: TUI;
	getStartupExpansionState(): boolean;
};

type CopyCommandContext = {
	session: { getLastAssistantText: () => string | undefined };
	ui: TuiMainScreen | TuiAltScreen;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
};

type InteractiveModePrototype = {
	initializeBuiltInHeader(this: HeaderContext): void;
	mountRootComponents(this: MountRootContext): void;
	setExtensionFooter(
		this: SetFooterContext,
		factory: ((tui: TUI, theme: Theme, footerData: unknown) => Component & { dispose?(): void }) | undefined,
	): void;
	setExtensionHeader(
		this: HeaderContext,
		factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
	): void;
	handleCopyCommand(this: CopyCommandContext, options?: { flashConfirmation?: boolean }): Promise<void>;
	handleRightClickPaste(this: {
		renderer: { getFocusedComponent(): Component | null };
		ui: { requestRender(): void };
	}): Promise<void>;
	retireAndRenderCurrentTranscript(this: {
		transcriptScrollView: ScrollView | undefined;
		chatContainer: Container;
		pendingMessagesContainer: Container;
		compactionQueuedMessages: unknown[];
		streamingComponent: unknown;
		streamingMessage: unknown;
		pendingTools: Map<string, unknown>;
		renderInitialMessages(): void;
	}): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("createInteractiveTuiReference", () => {
	it("calls the method captured before a custom wrapper replaces it", () => {
		const renderer = {
			render: (width: number) => [`width: ${width}`],
		} as unknown as TUI;
		const tui = createInteractiveTuiReference(() => renderer);
		const originalRender = tui.render;
		tui.render = (width: number) => originalRender(width);

		expect(tui.render(80)).toEqual(["width: 80"]);
	});

	it("routes a captured method to the renderer selected by a mode switch", () => {
		const regularRequestRender = vi.fn();
		const fullscreenRequestRender = vi.fn();
		let renderer = { requestRender: regularRequestRender } as unknown as TUI;
		const tui = createInteractiveTuiReference(() => renderer);
		const requestRender = tui.requestRender;

		requestRender();
		renderer = { requestRender: fullscreenRequestRender } as unknown as TUI;
		requestRender();

		expect(regularRequestRender).toHaveBeenCalledOnce();
		expect(fullscreenRequestRender).toHaveBeenCalledOnce();
	});
});
function createRootContext(ui: TUI, fullscreenScrollbar: "hidden" | "auto" | "always" = "auto"): MountRootContext {
	const withText = (text: string): Container => {
		const container = new Container();
		container.addChild(new Text(text, 0, 0));
		return container;
	};
	const headerContainer = withText("header");
	const loadedResourcesContainer = withText("resources");
	const chatContainer = withText("message tool subagent");
	const documentContainer = new Container();
	documentContainer.addChild(headerContainer);
	documentContainer.addChild(loadedResourcesContainer);
	documentContainer.addChild(chatContainer);
	const editor = new FocusText("editor", 0, 0);
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const footer = new Text("footer daemon LSP", 0, 0);
	const footerContainer = new Container();
	footerContainer.addChild(footer);
	return Object.assign(Object.create(InteractiveMode.prototype), {
		ui,
		renderer: ui,
		headerContainer,
		loadedResourcesContainer,
		chatContainer,
		documentContainer,
		transcriptScrollView: undefined,
		fullscreenLayoutRoot: undefined,
		pendingMessagesContainer: withText("pending"),
		statusContainer: withText("status sandbox"),
		widgetContainerAbove: withText("widget above"),
		editorContainer,
		widgetContainerBelow: withText("widget below"),
		footer,
		footerContainer,
		customFooter: undefined,
		editor,
		renderWidgets: vi.fn(),
		runtimeHost: { session: { settingsManager: { getFullscreenScrollbar: () => fullscreenScrollbar } } },
	}) as MountRootContext;
}

describe("createInteractiveTui", () => {
	it("selects fullscreen only for the startup-only opt-in", async () => {
		for (const mode of ["regular", "fullscreen"] as const satisfies readonly TuiMode[]) {
			const terminal = new RecordingTerminal(40, 9);
			const ui = createInteractiveTui({
				tuiMode: mode,
				showHardwareCursor: false,
				logDirectory: "/tmp",
				terminal,
			});
			expect(ui.mode).toBe(mode);
			expect(ui).toBeInstanceOf(mode === "fullscreen" ? TuiAltScreen : TuiMainScreen);
			expect(isViewportTUI(ui)).toBe(mode === "fullscreen");
			ui.start();
			await terminal.waitForRender();
			expect(terminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(mode === "fullscreen");
			ui.stop({ preserveScreen: true });
		}
	});

	it("forwards the right-click paste callback only to the fullscreen renderer", () => {
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		if (!platformDescriptor) throw new Error("process.platform descriptor unavailable");
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		try {
			const paste = vi.fn();
			const inputByMode = new Map<TuiMode, string[]>();
			for (const mode of ["regular", "fullscreen"] as const satisfies readonly TuiMode[]) {
				const terminal = new RecordingTerminal(20, 4);
				const ui = createInteractiveTui({
					tuiMode: mode,
					showHardwareCursor: false,
					logDirectory: "/tmp",
					terminal,
					onRightClickPaste: paste,
				});
				const inputs: string[] = [];
				inputByMode.set(mode, inputs);
				const target = {
					render: () => [],
					invalidate: () => {},
					handleInput: (data: string) => inputs.push(data),
				} satisfies Component;
				ui.addChild(target);
				ui.setFocus(target);
				ui.start();
				terminal.sendInput("\x1b[<2;1;1M");
				ui.stop({ preserveScreen: true });
			}
			expect(paste).toHaveBeenCalledOnce();
			expect(inputByMode.get("regular")).toEqual(["\x1b[<2;1;1M"]);
			expect(inputByMode.get("fullscreen")).toEqual([]);
		} finally {
			Object.defineProperty(process, "platform", platformDescriptor);
		}
	});

	it("feeds right-click clipboard text to the stable focused component as bracketed paste", async () => {
		clipboardMocks.readClipboardText.mockResolvedValue("clipboard text");
		const handleInput = vi.fn<(data: string) => void>();
		const target = { render: () => [], invalidate: () => {}, handleInput } satisfies Component;
		const requestRender = vi.fn();
		const context = {
			renderer: { getFocusedComponent: () => target },
			ui: { requestRender },
		};

		await interactiveModePrototype.handleRightClickPaste.call(context);

		expect(handleInput).toHaveBeenCalledWith("\x1b[200~clipboard text\x1b[201~");
		expect(requestRender).toHaveBeenCalledOnce();
	});

	it("drops asynchronous right-click paste when focus changes", async () => {
		let resolveClipboard: ((text: string) => void) | undefined;
		clipboardMocks.readClipboardText.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveClipboard = resolve;
				}),
		);
		const firstInput = vi.fn<(data: string) => void>();
		const first = { render: () => [], invalidate: () => {}, handleInput: firstInput } satisfies Component;
		const second = { render: () => [], invalidate: () => {}, handleInput: vi.fn() } satisfies Component;
		let focused: Component = first;
		const requestRender = vi.fn();
		const context = {
			renderer: { getFocusedComponent: () => focused },
			ui: { requestRender },
		};

		const pastePromise = interactiveModePrototype.handleRightClickPaste.call(context);
		focused = second;
		if (!resolveClipboard) throw new Error("clipboard read did not start");
		resolveClipboard("stale clipboard text");
		await pastePromise;

		expect(firstInput).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("replaces the renderer while preserving state and prints transcript output on shutdown", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const renderer = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		let stableUi: TUI;
		const invalidatedModes: TuiMode[] = [];
		const component = new FocusText("transcript and editor state", 0, 0);
		component.invalidate = () => invalidatedModes.push(stableUi.mode);
		renderer.addChild(component);
		renderer.setFocus(component);

		type SwitchContext = {
			renderer: ReturnType<typeof createInteractiveTui>;
			ui: TUI;
			mainScreenRenderState: ReturnType<TuiMainScreen["captureRenderState"]> | undefined;
			fullscreenLayoutRoot: Component;
			onRightClickPaste: () => void;
			options: { tuiMode?: TuiMode };
			extensionTerminalInputSubscriptions: Set<{
				handler: (data: string) => { consume?: boolean; data?: string } | undefined;
				unsubscribe: () => void;
			}>;
			runtimeHost: {
				session: {
					settingsManager: { getShowTerminalProgress(): boolean };
					isStreaming: boolean;
					isCompacting: boolean;
				};
			};
		};
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			renderer,
			ui: undefined as unknown as TUI,
			mainScreenRenderState: undefined,
			onRightClickPaste: vi.fn(),
			fullscreenLayoutRoot: component,
			options: { tuiMode: "regular" as TuiMode },
			extensionTerminalInputSubscriptions: new Set(),
			runtimeHost: {
				session: {
					settingsManager: { getShowTerminalProgress: () => true },
					isStreaming: true,
					isCompacting: false,
				},
			},
		}) as SwitchContext;
		stableUi = createInteractiveTuiReference(() => context.renderer);
		context.ui = stableUi;
		const { addExtensionTerminalInputListener, stopInteractiveTui, switchTuiMode } =
			InteractiveMode.prototype as unknown as {
				addExtensionTerminalInputListener(
					this: SwitchContext,
					handler: (data: string) => { consume?: boolean; data?: string } | undefined,
				): () => void;
				stopInteractiveTui(this: SwitchContext, fullscreenExitOutput: FullscreenExitOutput): void;
				switchTuiMode(this: SwitchContext, mode: TuiMode, restoreProgress?: boolean): boolean;
			};
		const inputListener = vi.fn(() => undefined);
		const unsubscribe = addExtensionTerminalInputListener.call(context, inputListener);

		renderer.start();
		await terminal.waitForRender();
		terminal.sendInput("before");
		expect(inputListener).toHaveBeenLastCalledWith("before");
		expect(switchTuiMode.call(context, "fullscreen")).toBe(true);
		await terminal.waitForRender();
		terminal.sendInput("after");
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		if (!platformDescriptor) throw new Error("process.platform descriptor unavailable");
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		try {
			terminal.sendInput("\x1b[<2;1;1M");
		} finally {
			Object.defineProperty(process, "platform", platformDescriptor);
		}
		expect(stableUi.mode).toBe("fullscreen");
		expect(stableUi).toBeInstanceOf(TuiAltScreen);
		expect(
			context.mainScreenRenderState?.previousLines.some((line) => line.includes("transcript and editor state")),
		).toBe(true);
		expect(context.renderer.children).toEqual([component]);
		expect(context.renderer.getFocusedComponent()).toBe(component);
		expect(component.focused).toBe(true);
		expect(inputListener).toHaveBeenLastCalledWith("after");
		expect(context.onRightClickPaste).toHaveBeenCalledOnce();
		expect(invalidatedModes).toEqual(["fullscreen"]);
		expect([terminal.startCount, terminal.stopCount]).toEqual([2, 1]);
		expect(terminal.progressStates).toEqual([true]);
		component.setText("transcript updated while fullscreen");
		context.renderer.requestRender();
		await terminal.waitForRender();
		terminal.writes.length = 0;

		stopInteractiveTui.call(context, "transcript");

		expect(stableUi.mode).toBe("regular");
		expect(context.renderer).toBeInstanceOf(TuiMainScreen);
		expect(context.renderer.children).toEqual([component]);
		expect([terminal.startCount, terminal.stopCount]).toEqual([2, 3]);
		expect(terminal.writes.join(" ")).toContain("transcript updated while fullscreen");
		expect(terminal.writes.at(-1)).not.toContain("\x1b[16t");
		unsubscribe();
	});

	it("does not carry an active fullscreen selection through renderer mode switches", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const renderer = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const component = new FocusText("alpha\nbeta\ngamma\ndelta", 0, 0);
		renderer.addChild(component);

		type SelectionSwitchContext = {
			renderer: ReturnType<typeof createInteractiveTui>;
			ui: TUI;
			mainScreenRenderState: ReturnType<TuiMainScreen["captureRenderState"]> | undefined;
			fullscreenLayoutRoot: Component;
			options: { tuiMode?: TuiMode };
			extensionTerminalInputSubscriptions: Set<{
				handler: (data: string) => { consume?: boolean; data?: string } | undefined;
				unsubscribe: () => void;
			}>;
			runtimeHost: {
				session: {
					settingsManager: { getShowTerminalProgress(): boolean };
					isStreaming: boolean;
					isCompacting: boolean;
				};
			};
		};
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			renderer,
			ui: undefined as unknown as TUI,
			mainScreenRenderState: undefined,
			fullscreenLayoutRoot: component,
			options: { tuiMode: "fullscreen" as TuiMode },
			extensionTerminalInputSubscriptions: new Set(),
			runtimeHost: {
				session: {
					settingsManager: { getShowTerminalProgress: () => false },
					isStreaming: false,
					isCompacting: false,
				},
			},
		}) as SelectionSwitchContext;
		context.ui = createInteractiveTuiReference(() => context.renderer);
		const { switchTuiMode } = InteractiveMode.prototype as unknown as {
			switchTuiMode(this: SelectionSwitchContext, mode: TuiMode, restoreProgress?: boolean): boolean;
		};

		renderer.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;4;2M");
			await terminal.waitForRender();
			expect(terminal.writes.join("")).toContain("\x1b[7m");

			expect(switchTuiMode.call(context, "regular", false)).toBe(true);
			expect(switchTuiMode.call(context, "fullscreen", false)).toBe(true);
			await terminal.waitForRender();
			terminal.writes.length = 0;
			terminal.sendInput("\x1b[<32;4;2M");
			terminal.sendInput("\x1b[<0;4;2m");
			await terminal.waitForRender();

			expect(context.renderer.mode).toBe("fullscreen");
			expect(terminal.writes.join("")).not.toContain("\x1b]52;c;");
			expect(terminal.writes.join("")).not.toContain("\x1b[7m");
		} finally {
			context.renderer.stop({ preserveScreen: true });
		}
	});

	it("restores the previous screen without replaying transcript output for resume-hint shutdown", async () => {
		const terminal = new RecordingTerminal(40, 8);
		const renderer = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		renderer.addChild(new Text("fullscreen transcript must not be replayed", 0, 0));
		const context = {
			renderer,
			ui: createInteractiveTuiReference(() => renderer),
		};
		const { stopInteractiveTui } = InteractiveMode.prototype as unknown as {
			stopInteractiveTui(this: typeof context, fullscreenExitOutput: FullscreenExitOutput): void;
		};
		renderer.start();
		await terminal.waitForRender();
		terminal.writes.length = 0;

		stopInteractiveTui.call(context, "resume-hint");

		expect(context.renderer.mode).toBe("fullscreen");
		expect([terminal.startCount, terminal.stopCount]).toEqual([1, 1]);
		expect(terminal.writes.join("")).toContain("\x1b[?1049l");
		expect(terminal.writes.join("")).not.toContain("fullscreen transcript must not be replayed");
	});

	it("refuses renderer replacement while an overlay is active", () => {
		const renderer = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
		});
		const overlay = new FocusText("overlay", 0, 0);
		const handle = renderer.showOverlay(overlay);
		const context = { renderer };
		const { switchTuiMode } = InteractiveMode.prototype as unknown as {
			switchTuiMode(this: typeof context, mode: TuiMode, restoreProgress?: boolean): boolean;
		};

		expect(switchTuiMode.call(context, "fullscreen", false)).toBe(false);
		expect(context.renderer).toBe(renderer);
		expect(overlay.focused).toBe(true);
		handle.hide();
		renderer.stop({ preserveScreen: true });
	});

	it("keeps regular mode as the omitted-option default and preserves flat render order", () => {
		const ui = createInteractiveTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
		});
		const context = createRootContext(ui);
		interactiveModePrototype.mountRootComponents.call(context);
		expect(ui.mode).toBe("regular");
		expect(ui).toBeInstanceOf(TuiMainScreen);
		expect(isViewportTUI(ui)).toBe(false);
		expect(ui.children).toEqual([
			context.documentContainer,
			context.pendingMessagesContainer,
			context.statusContainer,
			context.widgetContainerAbove,
			context.editorContainer,
			context.widgetContainerBelow,
			context.footerContainer,
		]);
		expect(context.documentContainer.children).toEqual([
			context.headerContainer,
			context.loadedResourcesContainer,
			context.chatContainer,
		]);
		expect(
			ui
				.render(40)
				.map((line) => stripTerminalSequences(line).trimEnd())
				.join("\n"),
		).toBe(
			"header\nresources\nmessage tool subagent\npending\nstatus sandbox\nwidget above\neditor\nwidget below\nfooter daemon LSP",
		);
	});

	it("keeps the dock fixed and preserves manual transcript scroll during streaming growth", async () => {
		initTheme("dark");
		const terminal = new RecordingTerminal(30, 12);
		const ui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const context = createRootContext(ui, "always");
		context.headerContainer.clear();
		context.loadedResourcesContainer.clear();
		context.chatContainer.clear();
		const transcript = new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0);
		context.chatContainer.addChild(transcript);
		interactiveModePrototype.mountRootComponents.call(context);
		ui.start();
		await terminal.waitForRender();

		const scrollView = context.transcriptScrollView;
		expect(scrollView).toBeInstanceOf(ScrollView);
		expect(scrollView?.scrollbar).toBe("always");
		expect(scrollView?.viewportHeight).toBe(4);
		expect(scrollView?.isFollowingEnd).toBe(true);
		expect(terminal.getViewport().at(-1)).toContain("footer daemon LSP");

		scrollView?.scrollBy(-2);
		await terminal.waitForRender();
		const manualTop = scrollView?.scrollTop;
		expect(scrollView?.isFollowingEnd).toBe(false);
		transcript.setText(Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join("\n"));
		ui.requestRender();
		await terminal.waitForRender();
		expect(scrollView?.scrollTop).toBe(manualTop);
		expect(scrollView?.isFollowingEnd).toBe(false);
		expect(terminal.getViewport().some((line) => line.includes("line 14"))).toBe(false);
		expect(terminal.getViewport().some((line) => line.includes("editor"))).toBe(true);
		expect(terminal.getViewport().at(-1)).toContain("footer daemon LSP");

		const replacement = new Text(Array.from({ length: 15 }, (_, index) => `new ${index + 1}`).join("\n"), 0, 0);
		interactiveModePrototype.retireAndRenderCurrentTranscript.call({
			transcriptScrollView: scrollView,
			chatContainer: context.chatContainer,
			pendingMessagesContainer: context.pendingMessagesContainer,
			compactionQueuedMessages: [],
			streamingComponent: undefined,
			streamingMessage: undefined,
			pendingTools: new Map(),
			renderInitialMessages: () => context.chatContainer.addChild(replacement),
		});
		ui.requestRender();
		await terminal.waitForRender();
		expect(scrollView?.isFollowingEnd).toBe(true);
		expect(terminal.getViewport().some((line) => line.includes("new 15"))).toBe(true);
		expect(terminal.getViewport().at(-1)).toContain("footer daemon LSP");
		ui.stop({ preserveScreen: true });
	});

	it("reflows one mounted fullscreen tree across narrow and wide resizes", async () => {
		const terminal = new RecordingTerminal(80, 24);
		const ui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const context = createRootContext(ui);
		interactiveModePrototype.mountRootComponents.call(context);
		const root = context.fullscreenLayoutRoot;
		const transcript = context.transcriptScrollView;
		ui.start();
		await terminal.waitForRender();
		for (const [columns, rows] of [
			[20, 8],
			[40, 12],
			[80, 24],
			[160, 48],
		] as const) {
			terminal.resize(columns, rows);
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			expect(viewport).toHaveLength(rows);
			expect(viewport.every((line) => visibleWidth(line) <= columns)).toBe(true);
			expect(viewport.some((line) => line.includes("editor"))).toBe(true);
			expect(viewport.some((line) => line.includes("footer"))).toBe(true);
			expect(context.fullscreenLayoutRoot).toBe(root);
			expect(context.transcriptScrollView).toBe(transcript);
		}
		ui.stop({ preserveScreen: true });
	});

	it("mounts a scrolling transcript, fixed dock, stable components, and overlays in fullscreen", async () => {
		const terminal = new RecordingTerminal(40, 9);
		const ui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const context = createRootContext(ui);
		interactiveModePrototype.mountRootComponents.call(context);
		expect(isViewportTUI(ui)).toBe(true);
		expect(context.transcriptScrollView).toBeInstanceOf(ScrollView);
		expect(context.fullscreenLayoutRoot).toBeInstanceOf(VStack);
		expect(ui.children).toEqual([
			context.documentContainer,
			context.pendingMessagesContainer,
			context.statusContainer,
			context.widgetContainerAbove,
			context.editorContainer,
			context.widgetContainerBelow,
			context.footerContainer,
		]);
		expect(context.documentContainer.children).toEqual([
			context.headerContainer,
			context.loadedResourcesContainer,
			context.chatContainer,
		]);
		expect((context.editor as FocusText).focused).toBe(true);

		ui.start();
		await terminal.waitForRender();
		expect(terminal.getViewport().map((line) => line.trimEnd())).toEqual([
			"message tool subagent",
			"pending",
			"status sandbox",
			"widget above",
			"editor",
			"",
			"",
			"widget below",
			"footer daemon LSP",
		]);
		initTheme("dark");
		const userMessage = new UserMessageComponent("source markdown", undefined, 1, [
			(markdown) => markdown.replace("source", "transformed"),
		]);
		const tool = new ToolExecutionComponent(
			"subagent",
			"tool-1",
			{ agent: "worker" },
			{ showImages: false },
			undefined,
			ui,
			process.cwd(),
		);
		tool.updateResult(
			{
				content: [
					{ type: "text", text: "child output" },
					{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				],
				isError: false,
			},
			false,
		);
		const imageTool = new ToolExecutionComponent(
			"remote_image",
			"tool-2",
			{},
			{ showImages: false },
			undefined,
			ui,
			process.cwd(),
		);
		imageTool.updateResult(
			{ content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], isError: false },
			false,
		);
		context.chatContainer.addChild(userMessage);
		context.chatContainer.addChild(tool);
		context.chatContainer.addChild(imageTool);
		const fullDocument = stripTerminalSequences(context.documentContainer.render(80).join("\n"));
		expect(fullDocument).toContain("transformed markdown");
		expect(fullDocument).toContain("subagent");
		expect(fullDocument).toContain("child output");
		expect(fullDocument).toContain("Image:");

		const selector = new FocusText("selector dialog", 0, 0);
		context.editorContainer.clear();
		context.editorContainer.addChild(selector);
		ui.setFocus(selector);
		ui.requestRender();
		await terminal.waitForRender();
		expect(selector.focused).toBe(true);
		expect(terminal.getViewport().some((line) => line.includes("selector dialog"))).toBe(true);
		expect(terminal.getViewport().at(-1)).toContain("footer daemon LSP");
		context.editorContainer.clear();
		context.editorContainer.addChild(context.editor);
		ui.setFocus(context.editor);

		const overlay = new FocusText("overlay", 0, 0);
		const handle = ui.showOverlay(overlay, { row: 0, col: 0, width: 7 });
		await terminal.waitForRender();
		expect(overlay.focused).toBe(true);
		expect(terminal.getViewport()[0]?.startsWith("overlay")).toBe(true);
		handle.hide();
		await terminal.waitForRender();
		expect((context.editor as FocusText).focused).toBe(true);
		ui.stop({ preserveScreen: true });
	});

	it("fills bounded fullscreen viewports at the required terminal-size smoke points", async () => {
		for (const [columns, rows] of [
			[20, 8],
			[40, 12],
			[80, 24],
			[160, 48],
		] as const) {
			const terminal = new RecordingTerminal(columns, rows);
			const ui = createInteractiveTui({
				tuiMode: "fullscreen",
				showHardwareCursor: false,
				logDirectory: "/tmp",
				terminal,
			});
			const context = createRootContext(ui);
			interactiveModePrototype.mountRootComponents.call(context);
			ui.start();
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			expect(viewport).toHaveLength(rows);
			expect(viewport.every((line) => visibleWidth(line) <= columns)).toBe(true);
			expect(viewport.some((line) => line.includes("editor"))).toBe(true);
			expect(viewport.some((line) => line.includes("footer"))).toBe(true);
			ui.stop({ preserveScreen: true });
		}
	});

	it("initializes and replaces the existing header inside the fullscreen root", () => {
		initTheme("dark");
		const ui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
		});
		const context: HeaderContext = {
			options: { verbose: true },
			settingsManager: { getQuietStartup: () => false },
			version: "test",
			headerContainer: new Container(),
			builtInHeader: undefined,
			customHeader: undefined,
			toolOutputExpanded: false,
			ui,
			getStartupExpansionState: () => false,
		};
		interactiveModePrototype.initializeBuiltInHeader.call(context);
		const builtInHeader = context.builtInHeader;
		expect(builtInHeader).toBeDefined();
		expect(context.headerContainer.children).toContain(builtInHeader);
		interactiveModePrototype.setExtensionHeader.call(context, () => new Text("custom header", 0, 0));
		expect(context.headerContainer.children).toContain(context.customHeader);
		expect(context.headerContainer.children).not.toContain(builtInHeader);
		interactiveModePrototype.setExtensionHeader.call(context, undefined);
		expect(context.headerContainer.children).toContain(builtInHeader);
	});

	it("keeps custom footer replacement inside the permanent fullscreen dock container", () => {
		initTheme("dark");
		const ui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new RecordingTerminal(),
		});
		const rootContext = createRootContext(ui);
		interactiveModePrototype.mountRootComponents.call(rootContext);
		const footerContext: SetFooterContext = {
			ui,
			customFooter: undefined,
			footer: rootContext.footer,
			footerContainer: rootContext.footerContainer,
			footerDataProvider: {},
		};
		interactiveModePrototype.setExtensionFooter.call(footerContext, () => new Text("custom footer", 0, 0));
		expect(rootContext.footerContainer.children).toEqual([footerContext.customFooter]);
		expect(ui.children.at(-1)).toBe(rootContext.footerContainer);
		expect(ui.children).not.toContain(rootContext.footer);
		interactiveModePrototype.setExtensionFooter.call(footerContext, undefined);
		expect(rootContext.footerContainer.children).toEqual([rootContext.footer]);
		expect(ui.children.at(-1)).toBe(rootContext.footerContainer);
	});
});

describe("InteractiveMode fullscreen copy confirmation", () => {
	beforeEach(() => {
		clipboardMocks.copyToClipboard.mockReset();
		clipboardMocks.copyToClipboard.mockResolvedValue(undefined);
	});

	it("flashes without mutating transcript status for the fullscreen shortcut", async () => {
		const terminal = new RecordingTerminal(40, 4);
		const ui = createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
		});
		const showStatus = vi.fn();
		const showError = vi.fn();
		ui.start();
		try {
			await terminal.waitForRender();
			await interactiveModePrototype.handleCopyCommand.call(
				{
					session: { getLastAssistantText: () => "assistant response" },
					ui,
					showStatus,
					showError,
				},
				{ flashConfirmation: true },
			);
			await terminal.waitForRender();
			expect(clipboardMocks.copyToClipboard).toHaveBeenCalledWith("assistant response");
			expect(showStatus).not.toHaveBeenCalled();
			expect(showError).not.toHaveBeenCalled();
			expect(terminal.getViewport().some((line) => line.includes("Copied!"))).toBe(true);
		} finally {
			ui.stop({ preserveScreen: true });
		}
	});

	it("retains status confirmation in regular mode and for explicit fullscreen commands", async () => {
		for (const [mode, flashConfirmation] of [
			["regular", true],
			["fullscreen", false],
		] as const) {
			const ui = createInteractiveTui({
				tuiMode: mode,
				showHardwareCursor: false,
				logDirectory: "/tmp",
				terminal: new RecordingTerminal(),
			});
			const showStatus = vi.fn();
			const showError = vi.fn();
			await interactiveModePrototype.handleCopyCommand.call(
				{
					session: { getLastAssistantText: () => "assistant response" },
					ui,
					showStatus,
					showError,
				},
				{ flashConfirmation },
			);
			expect(showStatus).toHaveBeenCalledWith("Copied last agent message to clipboard");
			expect(showError).not.toHaveBeenCalled();
		}
	});
});
