/**
 * Minimal TUI implementation with differential rendering
 */

import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { isKeyRelease, matchesKey } from "./keys.ts";
import type { Terminal } from "./terminal.ts";
import { getCapabilities, isImageLine, setCellDimensions } from "./terminal-image.ts";
import { extractSegments, normalizeTerminalOutput, sliceByColumn, sliceWithWidth, visibleWidth } from "./utils.ts";

/**
 * Component interface - all components must implement this
 */
export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	render(width: number): string[];

	/**
	 * Optional handler for keyboard input when component has focus
	 */
	handleInput?(data: string): void;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false - release events are filtered out.
	 */
	wantsKeyRelease?: boolean;

	/**
	 * Invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate(): void;
}

export type TuiInputListenerResult = { consume?: boolean; data?: string } | undefined;
export type TuiInputListener = (data: string) => TuiInputListenerResult;

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 */
export interface Focusable {
	/** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
	focused: boolean;
}

/** Type guard to check if a component implements Focusable */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

/**
 * Anchor position for overlays
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * Margin configuration for overlays
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** Value that can be absolute (number) or percentage (string like "50%") */
export type SizeValue = number | `${number}%`;

/** Parse a SizeValue into absolute value given a reference size */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// Parse percentage string like "50%"
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
	// === Sizing ===
	/** Width in columns, or percentage of terminal width (e.g., "50%") */
	width?: SizeValue;
	/** Minimum width in columns */
	minWidth?: number;
	/** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
	maxHeight?: SizeValue;

	// === Positioning - anchor-based ===
	/** Anchor point for positioning (default: 'center') */
	anchor?: OverlayAnchor;
	/** Horizontal offset from anchor position (positive = right) */
	offsetX?: number;
	/** Vertical offset from anchor position (positive = down) */
	offsetY?: number;

	// === Positioning - percentage or absolute ===
	/** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
	row?: SizeValue;
	/** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
	col?: SizeValue;

	// === Margin from terminal edges ===
	/** Margin from terminal edges. Number applies to all sides. */
	margin?: OverlayMargin | number;

	// === Visibility ===
	/**
	 * Control overlay visibility based on terminal dimensions.
	 * If provided, overlay is only rendered when this returns true.
	 * Called each render cycle with current terminal dimensions.
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;
	/** If true, don't capture keyboard focus when shown */
	nonCapturing?: boolean;
}

/** Options for {@link OverlayHandle.unfocus}. */
export interface OverlayUnfocusOptions {
	/** Explicit target to focus after releasing this overlay. */
	target: Component | null;
}

/**
 * Handle returned by showOverlay for controlling the overlay
 */
export interface OverlayHandle {
	/** Permanently remove the overlay (cannot be shown again) */
	hide(): void;
	/** Temporarily hide or show the overlay */
	setHidden(hidden: boolean): void;
	/** Check if overlay is temporarily hidden */
	isHidden(): boolean;
	/** Focus this overlay and bring it to the visual front */
	focus(): void;
	/** Release focus to the next visible capturing overlay or previous target, or to an explicit target when provided */
	unfocus(options?: OverlayUnfocusOptions): void;
	/** Check if this overlay currently has focus */
	isFocused(): boolean;
}

type OverlayStackEntry = {
	component: Component;
	options?: OverlayOptions;
	preFocus: Component | null;
	hidden: boolean;
	focusOrder: number;
	visible: boolean;
};

type OverlayBlockedFocusResume = { status: "restore-overlay" } | { status: "focus-target"; target: Component | null };
type EligibleOverlayFocusRestoreState = { status: "eligible"; overlay: OverlayStackEntry };
type BlockedOverlayFocusRestoreState = {
	status: "blocked";
	overlay: OverlayStackEntry;
	blockedBy: Component;
	resume: OverlayBlockedFocusResume;
};
type ActiveOverlayFocusRestoreState = EligibleOverlayFocusRestoreState | BlockedOverlayFocusRestoreState;
type OverlayFocusRestoreState = { status: "inactive" } | ActiveOverlayFocusRestoreState;
type OverlayFocusRestorePolicy = "clear" | "preserve";

interface FocusTransitionRequest {
	component: Component | null;
	overlayFocusRestore: OverlayFocusRestorePolicy;
}

interface ResolvedOverlayLayout {
	width: number;
	row: number;
	col: number;
	maxHeight: number | undefined;
}

interface RenderedOverlay {
	lines: string[];
	row: number;
	col: number;
	width: number;
}

interface OverlayRenderPlan {
	overlays: RenderedOverlay[];
	minimumLineCount: number;
}

interface OverlayLayoutBounds {
	marginTop: number;
	marginRight: number;
	marginBottom: number;
	marginLeft: number;
	availableWidth: number;
	availableHeight: number;
}

export interface RenderedCursorPosition {
	row: number;
	col: number;
}
/**
 * Container - a component that contains other components
 */
export class Container implements Component {
	children: Component[] = [];

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = child.render(width);
			for (const line of childLines) {
				lines.push(line);
			}
		}
		return lines;
	}
}

/**
 * TUI - Main class for managing terminal UI with differential rendering
 */
const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

/** Composite overlay content into a terminal line at a fixed column. */
export function compositeTuiLine(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	if (isImageLine(baseLine)) return baseLine;

	const afterStart = startCol + overlayWidth;
	const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);
	const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);
	const beforePad = Math.max(0, startCol - base.beforeWidth);
	const overlayPad = Math.max(0, overlayWidth - overlay.width);
	const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
	const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
	const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
	const afterPad = Math.max(0, afterTarget - base.afterWidth);
	const result =
		base.before +
		" ".repeat(beforePad) +
		SEGMENT_RESET +
		overlay.text +
		" ".repeat(overlayPad) +
		SEGMENT_RESET +
		base.after +
		" ".repeat(afterPad);

	return visibleWidth(result) <= totalWidth ? result : sliceByColumn(result, 0, totalWidth, true);
}

export type TuiMode = "regular" | "fullscreen";

export interface TuiStopOptions {
	/** Restore the previous main buffer without replaying renderer content. */
	preserveScreen?: boolean;
}

export interface TUI extends Component {
	readonly mode: TuiMode;
	children: Component[];
	terminal: Terminal;
	onDebug?: () => void;
	readonly fullRedraws: number;
	readonly hasOverlayEntries: boolean;
	addChild(component: Component): void;
	removeChild(component: Component): void;
	clear(): void;
	getShowHardwareCursor(): boolean;
	setShowHardwareCursor(enabled: boolean): void;
	getClearOnShrink(): boolean;
	setClearOnShrink(enabled: boolean): void;
	getFocusedComponent(): Component | null;
	setFocus(component: Component | null): void;
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
	hideOverlay(): void;
	hasOverlay(): boolean;
	start(): void;
	stop(options?: TuiStopOptions): void;
	renderNow(force?: boolean): void;
	requestRender(force?: boolean): void;
	addInputListener(listener: TuiInputListener): () => void;
	removeInputListener(listener: TuiInputListener): void;
}

export const VIEWPORT_TUI = Symbol.for("@fleetagent/pi-tui/viewport");

export interface ViewportTUI extends TUI {
	readonly [VIEWPORT_TUI]: true;
	setLayoutRoot(component: Component | undefined): void;
}

export function isViewportTUI(tui: TUI): tui is ViewportTUI {
	return (tui as Partial<ViewportTUI>)[VIEWPORT_TUI] === true;
}

export abstract class TuiBase extends Container implements TUI {
	abstract readonly mode: TuiMode;
	public terminal: Terminal;
	private focusedComponent: Component | null = null;
	private inputListeners = new Set<TuiInputListener>();

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	public onDebug?: () => void;
	private renderRequested = false;
	private immediateRenderScheduled = false;
	private renderTimer: NodeJS.Timeout | undefined;
	private lastRenderAt = 0;
	private static readonly MIN_RENDER_INTERVAL_MS = 16;
	private showHardwareCursor = process.env.PI_HARDWARE_CURSOR === "1";
	private clearOnShrink = process.env.PI_CLEAR_ON_SHRINK === "1";
	protected fullRedrawCount = 0;
	protected stopped = false;
	protected readonly logDirectory: string;

	// Overlay stack for modal components rendered on top of base content
	private focusOrderCounter = 0;
	private overlayStack: OverlayStackEntry[] = [];

	get hasOverlayEntries(): boolean {
		return this.overlayStack.length > 0;
	}
	private overlayFocusRestore: OverlayFocusRestoreState = { status: "inactive" };

	constructor(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?: string) {
		super();
		this.terminal = terminal;
		this.logDirectory = logDirectory ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
		if (showHardwareCursor !== undefined) {
			this.showHardwareCursor = showHardwareCursor;
		}
	}

	protected abstract doRender(): void;

	protected resetRenderState(): void {}

	protected beforeTerminalStart(): void {}

	protected afterTerminalStart(): void {}

	protected onTerminalResize(): void {}

	protected onOverlayStackChanged(): void {}

	protected beforeTerminalStop(_options?: TuiStopOptions): void {}

	protected afterTerminalStop(_options?: TuiStopOptions): void {}

	get fullRedraws(): number {
		return this.fullRedrawCount;
	}

	getShowHardwareCursor(): boolean {
		return this.showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.showHardwareCursor === enabled) return;
		this.showHardwareCursor = enabled;
		if (!enabled) {
			this.terminal.hideCursor();
		}
		this.requestRender();
	}

	getClearOnShrink(): boolean {
		return this.clearOnShrink;
	}

	/**
	 * Set whether to trigger full re-render when content shrinks.
	 * When true (default), empty rows are cleared when content shrinks.
	 * When false, empty rows remain (reduces redraws on slower terminals).
	 */
	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}

	getFocusedComponent(): Component | null {
		return this.focusedComponent;
	}

	setFocus(component: Component | null): void {
		this.setFocusInternal({ component, overlayFocusRestore: "clear" });
	}

	private resolveNonOverlayFocus(
		nextFocus: Component,
		previousFocus: Component | null,
		restoreState: OverlayFocusRestoreState,
	): Component | null {
		if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
			if (restoreState.resume.status === "focus-target" || !this.isComponentMounted(restoreState.blockedBy)) {
				return this.resolveBlockedOverlayFocusResume(restoreState);
			}
			this.overlayFocusRestore = {
				status: "blocked",
				overlay: restoreState.overlay,
				blockedBy: nextFocus,
				resume: restoreState.resume,
			};
			return nextFocus;
		}

		const previousFocusedOverlay = previousFocus
			? this.overlayStack.find((entry) => entry.component === previousFocus && this.isOverlayVisible(entry))
			: undefined;
		if (
			previousFocusedOverlay &&
			restoreState.status !== "inactive" &&
			restoreState.overlay === previousFocusedOverlay &&
			!this.isOverlayFocusAncestor(previousFocusedOverlay, nextFocus)
		) {
			this.overlayFocusRestore = {
				status: "blocked",
				overlay: previousFocusedOverlay,
				blockedBy: nextFocus,
				resume: { status: "restore-overlay" },
			};
		}
		return nextFocus;
	}

	private resolveNullFocus(
		previousFocus: Component | null,
		restoreState: OverlayFocusRestoreState,
		overlayFocusRestore: OverlayFocusRestorePolicy,
	): Component | null {
		if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
			return this.resolveBlockedOverlayFocusResume(restoreState);
		}
		if (overlayFocusRestore === "clear") this.clearOverlayFocusRestore();
		return null;
	}

	private resolveFocusTarget(
		component: Component | null,
		overlayFocusRestore: OverlayFocusRestorePolicy,
	): Component | null {
		const previousFocus = this.focusedComponent;
		const restoreState = this.getVisibleOverlayFocusRestore();
		if (component === null) return this.resolveNullFocus(previousFocus, restoreState, overlayFocusRestore);
		const isOverlay = this.overlayStack.some((entry) => entry.component === component);
		if (isOverlay) return component;
		return this.resolveNonOverlayFocus(component, previousFocus, restoreState);
	}

	private applyFocus(nextFocus: Component | null): void {
		if (isFocusable(this.focusedComponent)) this.focusedComponent.focused = false;
		this.focusedComponent = nextFocus;
		if (isFocusable(nextFocus)) nextFocus.focused = true;

		const focusedOverlay = nextFocus
			? this.overlayStack.find((entry) => entry.component === nextFocus && this.isOverlayVisible(entry))
			: undefined;
		if (focusedOverlay) this.overlayFocusRestore = { status: "eligible", overlay: focusedOverlay };
	}

	private setFocusInternal({ component, overlayFocusRestore }: FocusTransitionRequest): void {
		const nextFocus = this.resolveFocusTarget(component, overlayFocusRestore);
		this.applyFocus(nextFocus);
	}

	private clearOverlayFocusRestore(): void {
		this.overlayFocusRestore = { status: "inactive" };
	}

	private clearOverlayFocusRestoreFor(overlay: OverlayStackEntry): void {
		if (this.overlayFocusRestore.status !== "inactive" && this.overlayFocusRestore.overlay === overlay) {
			this.clearOverlayFocusRestore();
		}
	}

	private resolveBlockedOverlayFocusResume(restoreState: BlockedOverlayFocusRestoreState): Component | null {
		if (restoreState.resume.status === "restore-overlay") return restoreState.overlay.component;
		this.clearOverlayFocusRestore();
		return restoreState.resume.target;
	}

	private getVisibleOverlayFocusRestore(): OverlayFocusRestoreState {
		const restoreState = this.overlayFocusRestore;
		if (restoreState.status === "inactive") return restoreState;
		if (!this.overlayStack.includes(restoreState.overlay) || !this.isOverlayVisible(restoreState.overlay)) {
			return { status: "inactive" };
		}
		return restoreState;
	}

	private isOverlayFocusAncestor(entry: OverlayStackEntry, component: Component): boolean {
		const preFocusByComponent = new Map<Component, Component | null>();
		for (const overlay of this.overlayStack) {
			if (!preFocusByComponent.has(overlay.component)) {
				preFocusByComponent.set(overlay.component, overlay.preFocus);
			}
		}

		const visited = new Set<Component>();
		let current = entry.preFocus;
		while (current && !visited.has(current)) {
			visited.add(current);
			if (current === component) return true;
			current = preFocusByComponent.get(current) ?? null;
		}
		return false;
	}

	private retargetOverlayPreFocus(removed: OverlayStackEntry): void {
		for (const overlay of this.overlayStack) {
			if (overlay !== removed && overlay.preFocus === removed.component) {
				overlay.preFocus = removed.preFocus;
			}
		}
	}

	protected getMountedRoots(): readonly Component[] {
		return this.children;
	}

	private isComponentMounted(component: Component): boolean {
		return this.getMountedRoots().some((child) => this.containsComponent(child, component));
	}

	private containsComponent(root: Component, target: Component): boolean {
		if (root === target) return true;
		if (!(root instanceof Container)) return false;
		return root.children.some((child) => this.containsComponent(child, target));
	}

	private applyBlockedOverlayUnfocus(
		entry: OverlayStackEntry,
		restoreState: OverlayFocusRestoreState,
		options: OverlayUnfocusOptions | undefined,
	): boolean {
		if (
			restoreState.status !== "blocked" ||
			restoreState.overlay !== entry ||
			this.focusedComponent !== restoreState.blockedBy
		) {
			return false;
		}
		if (options) {
			this.overlayFocusRestore = {
				status: "blocked",
				overlay: entry,
				blockedBy: restoreState.blockedBy,
				resume: { status: "focus-target", target: options.target },
			};
		} else {
			this.clearOverlayFocusRestore();
		}
		this.requestRender();
		return true;
	}

	private unfocusOverlay(entry: OverlayStackEntry, options: OverlayUnfocusOptions | undefined): void {
		const isFocused = this.focusedComponent === entry.component;
		const restoreState = this.overlayFocusRestore;
		const hasPendingRestore = restoreState.status !== "inactive" && restoreState.overlay === entry;
		if (!isFocused && !hasPendingRestore) return;
		if (this.applyBlockedOverlayUnfocus(entry, restoreState, options)) return;

		this.clearOverlayFocusRestoreFor(entry);
		if (isFocused || options) {
			const topVisible = this.getTopmostVisibleOverlay();
			const fallbackTarget = topVisible && topVisible !== entry ? topVisible.component : entry.preFocus;
			this.setFocus(options ? options.target : fallbackTarget);
		}
		this.requestRender();
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry: OverlayStackEntry = {
			component,
			...(options === undefined ? {} : { options }),
			preFocus: this.focusedComponent,
			hidden: false,
			focusOrder: ++this.focusOrderCounter,
			visible: false,
		};
		this.overlayStack.push(entry);
		entry.visible = this.isOverlayVisible(entry);
		this.onOverlayStackChanged();
		// Only focus if overlay is actually visible
		if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.requestRender();

		// Return handle for controlling this overlay
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.clearOverlayFocusRestoreFor(entry);
					this.retargetOverlayPreFocus(entry);
					this.overlayStack.splice(index, 1);
					this.onOverlayStackChanged();
					// Restore focus if this overlay had focus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.terminal.hideCursor();
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				entry.visible = this.isOverlayVisible(entry);
				// Update focus when hiding/showing
				if (hidden) {
					this.clearOverlayFocusRestoreFor(entry);
					// If this overlay had focus, move focus to next visible or preFocus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// Restore focus to this overlay when showing (if it's actually visible)
					if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
						entry.focusOrder = ++this.focusOrderCounter;
						this.setFocus(component);
					}
				}
				this.onOverlayStackChanged();
				this.requestRender();
			},
			isHidden: () => entry.hidden,
			focus: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry)) return;
				entry.focusOrder = ++this.focusOrderCounter;
				this.setFocus(component);
				this.requestRender();
			},
			unfocus: (unfocusOptions) => this.unfocusOverlay(entry, unfocusOptions),
			isFocused: () => this.focusedComponent === component,
		};
	}

	/** Hide the topmost overlay and restore previous focus. */
	hideOverlay(): void {
		const overlay = this.overlayStack[this.overlayStack.length - 1];
		if (!overlay) return;
		this.clearOverlayFocusRestoreFor(overlay);
		this.retargetOverlayPreFocus(overlay);
		this.overlayStack.pop();
		this.onOverlayStackChanged();
		if (this.focusedComponent === overlay.component) {
			// Find topmost visible overlay, or fall back to preFocus
			const topVisible = this.getTopmostVisibleOverlay();
			this.setFocus(topVisible?.component ?? overlay.preFocus);
		}
		if (this.overlayStack.length === 0) this.terminal.hideCursor();
		this.requestRender();
	}

	/** Check if there are any visible overlays */
	hasOverlay(): boolean {
		return this.overlayStack.some((o) => this.isOverlayVisible(o));
	}

	protected hasCapturingOverlay(): boolean {
		return this.overlayStack.some((o) => !o.options?.nonCapturing && this.isOverlayVisible(o));
	}

	/** Check if an overlay entry is currently visible */
	private isOverlayVisible(entry: OverlayStackEntry): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** Find the visual-frontmost visible capturing overlay, if any */
	private getTopmostVisibleOverlay(): OverlayStackEntry | undefined {
		let topmost: OverlayStackEntry | undefined;
		for (const overlay of this.overlayStack) {
			if (overlay.options?.nonCapturing || !this.isOverlayVisible(overlay)) continue;
			if (!topmost || overlay.focusOrder > topmost.focusOrder) {
				topmost = overlay;
			}
		}
		return topmost;
	}

	private refreshOverlayVisibility(): OverlayStackEntry | undefined {
		let newlyVisible: OverlayStackEntry | undefined;
		for (const overlay of this.overlayStack) {
			const visible = this.isOverlayVisible(overlay);
			if (visible && !overlay.visible && !overlay.options?.nonCapturing) {
				if (!newlyVisible || overlay.focusOrder > newlyVisible.focusOrder) newlyVisible = overlay;
			}
			overlay.visible = visible;
		}
		return newlyVisible;
	}

	private retargetFocusFromHiddenOverlay(): void {
		const focusedOverlay = this.overlayStack.find((overlay) => overlay.component === this.focusedComponent);
		if (!focusedOverlay || this.isOverlayVisible(focusedOverlay)) return;
		const topVisible = this.getTopmostVisibleOverlay();
		if (topVisible) {
			this.setFocus(topVisible.component);
			return;
		}
		this.setFocusInternal({ component: focusedOverlay.preFocus, overlayFocusRestore: "preserve" });
	}

	private focusNewlyVisibleOverlay(newlyVisible: OverlayStackEntry | undefined): void {
		if (!newlyVisible) return;
		const currentFocusedOverlay = this.overlayStack.find(
			(overlay) => overlay.component === this.focusedComponent && this.isOverlayVisible(overlay),
		);
		if (!currentFocusedOverlay || newlyVisible.focusOrder > currentFocusedOverlay.focusOrder) {
			this.setFocus(newlyVisible.component);
		}
	}

	private restoreVisibleOverlayFocus(): void {
		if (this.overlayStack.some((overlay) => overlay.component === this.focusedComponent)) return;
		const restoreState = this.getVisibleOverlayFocusRestore();
		if (restoreState.status === "eligible") {
			this.setFocus(restoreState.overlay.component);
			return;
		}
		if (restoreState.status !== "blocked" || restoreState.blockedBy === this.focusedComponent) return;
		if (restoreState.resume.status === "restore-overlay") {
			this.setFocus(restoreState.overlay.component);
			return;
		}
		this.clearOverlayFocusRestore();
		this.setFocus(restoreState.resume.target);
	}

	private reconcileOverlayFocus(): void {
		const newlyVisible = this.refreshOverlayVisibility();
		this.retargetFocusFromHiddenOverlay();
		this.focusNewlyVisibleOverlay(newlyVisible);
		this.restoreVisibleOverlayFocus();
	}

	override invalidate(): void {
		for (const root of this.getMountedRoots()) root.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate?.();
	}

	start(): void {
		this.stopped = false;
		try {
			this.beforeTerminalStart();
			this.terminal.start(
				(data) => this.handleTerminalInput(data),
				() => {
					this.reconcileOverlayFocus();
					this.onTerminalResize();
					this.requestRender();
				},
			);
			this.afterTerminalStart();
			this.terminal.hideCursor();
			this.queryCellSize();
			this.requestRender();
		} catch (error) {
			// A terminal may throw after partially entering raw or alternate-screen mode.
			// Route startup failures through the same complete cleanup path as signals.
			try {
				this.stop();
			} catch {
				// Preserve the startup failure; cleanup is best-effort but exhaustive.
			}
			throw error;
		}
	}

	addInputListener(listener: TuiInputListener): () => void {
		this.inputListeners.add(listener);
		return () => {
			this.inputListeners.delete(listener);
		};
	}

	removeInputListener(listener: TuiInputListener): void {
		this.inputListeners.delete(listener);
	}

	private queryCellSize(): void {
		// Only query if terminal supports images (cell size is only used for image rendering)
		if (!getCapabilities().images) {
			return;
		}
		// Query terminal for cell size in pixels: CSI 16 t
		// Response format: CSI 6 ; height ; width t
		this.terminal.write("\x1b[16t");
	}

	stop(options?: TuiStopOptions): void {
		this.stopped = true;
		this.renderRequested = false;
		this.cancelRenderTimer();
		let failure: unknown;
		const cleanup = (action: () => void): void => {
			try {
				action();
			} catch (error) {
				failure ??= error;
			}
		};
		cleanup(() => this.beforeTerminalStop(options));
		cleanup(() => this.terminal.showCursor());
		cleanup(() => this.terminal.stop());
		// Alternate-screen exit and capability restoration must run even when
		// keyboard/raw-mode shutdown reports an error.
		cleanup(() => this.afterTerminalStop(options));
		if (failure !== undefined) throw failure;
	}

	renderNow(force = false): void {
		if (force) this.resetRenderState();
		this.renderRequested = false;
		this.cancelRenderTimer();
		this.lastRenderAt = performance.now();
		this.doRender();
	}

	requestRender(force = false): void {
		if (force) {
			this.resetRenderState();
			this.requestImmediateRender();
			return;
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => this.scheduleRender());
	}

	private requestImmediateRender(): void {
		this.cancelRenderTimer();
		this.renderRequested = true;
		if (this.immediateRenderScheduled) return;
		this.immediateRenderScheduled = true;
		process.nextTick(() => {
			this.immediateRenderScheduled = false;
			if (this.stopped || !this.renderRequested) return;
			this.cancelRenderTimer();
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
		});
	}

	private cancelRenderTimer(): void {
		if (!this.renderTimer) return;
		clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
	}

	private scheduleRender(): void {
		if (this.stopped || this.renderTimer || !this.renderRequested) return;
		const elapsed = performance.now() - this.lastRenderAt;
		const delay = Math.max(0, TuiBase.MIN_RENDER_INTERVAL_MS - elapsed);
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (this.stopped || !this.renderRequested) return;
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
			if (this.renderRequested) this.scheduleRender();
		}, delay);
	}

	private applyInputListeners(data: string): string | undefined {
		if (this.inputListeners.size === 0) return data;
		let current = data;
		for (const listener of this.inputListeners) {
			const result = listener(current);
			if (result?.consume) return undefined;
			if (result?.data !== undefined) current = result.data;
		}
		return current.length === 0 ? undefined : current;
	}

	private handleTerminalInput(data: string): void {
		this.reconcileOverlayFocus();
		const filteredData = this.applyInputListeners(data);
		if (filteredData === undefined) return;
		data = filteredData;

		// Consume terminal cell size responses without blocking unrelated input.
		if (this.consumeCellSizeResponse(data)) return;

		// Global debug key handler (Shift+Ctrl+D)
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// Pass input to focused component (including Ctrl+C).
		// The focused component can decide how to handle Ctrl+C.
		if (!this.focusedComponent?.handleInput) return;
		// Filter out key release events unless component opts in.
		if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) return;
		this.focusedComponent.handleInput(data);
		this.requestImmediateRender();
	}

	private consumeCellSizeResponse(data: string): boolean {
		// Response format: ESC [ 6 ; height ; width t
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1], 10);
		const widthPx = parseInt(match[2], 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		// Invalidate all components so images re-render with correct dimensions.
		this.invalidate();
		this.requestRender();
		return true;
	}

	private resolveOverlayBounds(options: OverlayOptions, termWidth: number, termHeight: number): OverlayLayoutBounds {
		const margin =
			typeof options.margin === "number"
				? { top: options.margin, right: options.margin, bottom: options.margin, left: options.margin }
				: (options.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);
		return {
			marginTop,
			marginRight,
			marginBottom,
			marginLeft,
			availableWidth: Math.max(1, termWidth - marginLeft - marginRight),
			availableHeight: Math.max(1, termHeight - marginTop - marginBottom),
		};
	}

	private resolveOverlayWidth(options: OverlayOptions, termWidth: number, bounds: OverlayLayoutBounds): number {
		let width = parseSizeValue(options.width, termWidth) ?? Math.min(80, bounds.availableWidth);
		if (options.minWidth !== undefined) width = Math.max(width, options.minWidth);
		return Math.max(1, Math.min(width, bounds.availableWidth));
	}

	private resolveOverlayMaxHeight(
		options: OverlayOptions,
		termHeight: number,
		bounds: OverlayLayoutBounds,
	): number | undefined {
		const maxHeight = parseSizeValue(options.maxHeight, termHeight);
		return maxHeight === undefined ? undefined : Math.max(1, Math.min(maxHeight, bounds.availableHeight));
	}

	private resolveOverlayRow(options: OverlayOptions, overlayHeight: number, bounds: OverlayLayoutBounds): number {
		if (options.row === undefined) {
			return this.resolveAnchorRow(
				options.anchor ?? "center",
				overlayHeight,
				bounds.availableHeight,
				bounds.marginTop,
			);
		}
		if (typeof options.row === "number") return options.row;
		const match = options.row.match(/^(\d+(?:\.\d+)?)%$/);
		if (!match) return this.resolveAnchorRow("center", overlayHeight, bounds.availableHeight, bounds.marginTop);
		const maxRow = Math.max(0, bounds.availableHeight - overlayHeight);
		return bounds.marginTop + Math.floor(maxRow * (parseFloat(match[1]) / 100));
	}

	private resolveOverlayColumn(options: OverlayOptions, width: number, bounds: OverlayLayoutBounds): number {
		if (options.col === undefined) {
			return this.resolveAnchorCol(options.anchor ?? "center", width, bounds.availableWidth, bounds.marginLeft);
		}
		if (typeof options.col === "number") return options.col;
		const match = options.col.match(/^(\d+(?:\.\d+)?)%$/);
		if (!match) return this.resolveAnchorCol("center", width, bounds.availableWidth, bounds.marginLeft);
		const maxCol = Math.max(0, bounds.availableWidth - width);
		return bounds.marginLeft + Math.floor(maxCol * (parseFloat(match[1]) / 100));
	}

	/** Resolve overlay layout from options. */
	private resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): ResolvedOverlayLayout {
		const resolvedOptions = options ?? {};
		const bounds = this.resolveOverlayBounds(resolvedOptions, termWidth, termHeight);
		const width = this.resolveOverlayWidth(resolvedOptions, termWidth, bounds);
		const maxHeight = this.resolveOverlayMaxHeight(resolvedOptions, termHeight, bounds);
		const effectiveHeight = maxHeight === undefined ? overlayHeight : Math.min(overlayHeight, maxHeight);
		let row = this.resolveOverlayRow(resolvedOptions, effectiveHeight, bounds) + (resolvedOptions.offsetY ?? 0);
		let col = this.resolveOverlayColumn(resolvedOptions, width, bounds) + (resolvedOptions.offsetX ?? 0);
		row = Math.max(bounds.marginTop, Math.min(row, termHeight - bounds.marginBottom - effectiveHeight));
		col = Math.max(bounds.marginLeft, Math.min(col, termWidth - bounds.marginRight - width));
		return { width, row, col, maxHeight };
	}

	private resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	private resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	private prepareOverlayRenderPlan(baseLineCount: number, termWidth: number, termHeight: number): OverlayRenderPlan {
		const visibleEntries = this.overlayStack.filter((entry) => this.isOverlayVisible(entry));
		visibleEntries.sort((left, right) => left.focusOrder - right.focusOrder);
		const overlays: RenderedOverlay[] = [];
		let minimumLineCount = baseLineCount;
		for (const entry of visibleEntries) {
			const { width, maxHeight } = this.resolveOverlayLayout(entry.options, 0, termWidth, termHeight);
			let overlayLines = entry.component.render(width);
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}
			const { row, col } = this.resolveOverlayLayout(entry.options, overlayLines.length, termWidth, termHeight);
			overlays.push({ lines: overlayLines, row, col, width });
			minimumLineCount = Math.max(minimumLineCount, row + overlayLines.length);
		}
		return { overlays, minimumLineCount };
	}

	private compositeRenderedOverlay(
		result: string[],
		overlay: RenderedOverlay,
		viewportStart: number,
		termWidth: number,
	): void {
		for (let lineIndex = 0; lineIndex < overlay.lines.length; lineIndex++) {
			const targetIndex = viewportStart + overlay.row + lineIndex;
			if (targetIndex < 0 || targetIndex >= result.length) continue;
			const overlayLine = overlay.lines[lineIndex]!;
			const truncatedLine =
				visibleWidth(overlayLine) > overlay.width
					? sliceByColumn(overlayLine, 0, overlay.width, true)
					: overlayLine;
			result[targetIndex] = this.compositeLineAt(
				result[targetIndex]!,
				truncatedLine,
				overlay.col,
				overlay.width,
				termWidth,
			);
		}
	}

	/** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */
	protected compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		if (this.overlayStack.length === 0) return lines;
		const result = [...lines];
		const plan = this.prepareOverlayRenderPlan(result.length, termWidth, termHeight);
		const workingHeight = Math.max(result.length, termHeight, plan.minimumLineCount);
		while (result.length < workingHeight) result.push("");
		const viewportStart = Math.max(0, workingHeight - termHeight);
		for (const overlay of plan.overlays) {
			this.compositeRenderedOverlay(result, overlay, viewportStart, termWidth);
		}
		return result;
	}

	protected applyLineResets(lines: string[]): string[] {
		const reset = SEGMENT_RESET;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!isImageLine(line)) {
				lines[i] = normalizeTerminalOutput(line) + reset;
			}
		}
		return lines;
	}

	private compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		return compositeTuiLine(baseLine, overlayLine, startCol, overlayWidth, totalWidth);
	}

	/**
	 * Find and extract cursor position from rendered lines.
	 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
	 * Only scans the bottom terminal height lines (visible viewport).
	 * @param lines - Rendered lines to search
	 * @param height - Terminal height (visible viewport size)
	 * @returns Cursor position { row, col } or null if no marker found
	 */
	protected extractCursorPosition(lines: string[], height: number): RenderedCursorPosition | null {
		// Only scan the bottom `height` lines (visible viewport)
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const line = lines[row];
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				// Calculate visual column (width of text before marker)
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker);

				// Strip marker from the line
				lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

				return { row, col };
			}
		}
		return null;
	}
}
