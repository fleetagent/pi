import type { ScrollView } from "./components/scroll-view.ts";
import { allocateStackSizes, visibleStackEntries } from "./components/stack.ts";
import { getLayoutNode, type LayoutViewport, type ScrollLayoutNode, type StackLayoutNode } from "./layout-node.ts";
import { cropKittyImageLine, getKittyImageMetadata, isImageLine } from "./terminal-image.ts";
import { type Component, CURSOR_MARKER, compositeTuiLine } from "./tui.ts";
import { extractAnsiCode, getGraphemeCellRange, sliceByColumn, visibleWidth } from "./utils.ts";

const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

export interface LayoutRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface LayoutBox {
	component: Component;
	rect: LayoutRect;
	clip: LayoutRect;
	children: LayoutBox[];
	parent?: LayoutBox;
	lines?: readonly string[];
	lineOffset?: number;
	scrollView?: ScrollView;
	scrollContentLines?: readonly string[];
	layer: number;
}

export interface LayoutFrame {
	root: LayoutBox;
	width: number;
	height: number;
	lines: string[];
	primaryScrollView?: ScrollView;
}

export interface ScrollbarGeometry {
	column: number;
	trackTop: number;
	trackHeight: number;
	thumbTop: number;
	thumbHeight: number;
	maxScrollTop: number;
}

interface LayoutContext {
	viewport: LayoutViewport;
	renderCache: Map<Component, Map<number, string[]>>;
	requestRender: () => void;
	primaryScrollView: ScrollView | undefined;
}

interface ScrolledKittyImagePaintRequest {
	box: LayoutBox;
	screen: string[];
	totalWidth: number;
	scrollTop: number;
	imageLine: string;
	imageRow: number;
	imageRows: number;
}

function intersect(a: LayoutRect, b: LayoutRect): LayoutRect {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.width, b.x + b.width);
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function renderCached(context: LayoutContext, component: Component, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	let widths = context.renderCache.get(component);
	if (!widths) {
		widths = new Map<number, string[]>();
		context.renderCache.set(component, widths);
	}
	let lines = widths.get(safeWidth);
	if (!lines) {
		lines = component.render(safeWidth);
		widths.set(safeWidth, lines);
	}
	return lines;
}

function measureHeight(context: LayoutContext, component: Component, width: number): number {
	return renderCached(context, component, width).length;
}

function measureWidth(context: LayoutContext, component: Component, width: number): number {
	return renderCached(context, component, width).reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
}

function withParent(box: LayoutBox, parent: LayoutBox): LayoutBox {
	box.parent = parent;
	return box;
}

function translateBox(box: LayoutBox, deltaY: number): void {
	box.rect.y += deltaY;
	for (const child of box.children) translateBox(child, deltaY);
}

function updateClips(box: LayoutBox, parentClip: LayoutRect): void {
	box.clip = intersect(parentClip, box.rect);
	for (const child of box.children) updateClips(child, box.clip);
}

interface ComponentLayoutRequest {
	context: LayoutContext;
	component: Component;
	x: number;
	y: number;
	width: number;
	height: number | undefined;
	clip: LayoutRect;
}

function layoutLeafComponent(request: ComponentLayoutRequest): LayoutBox {
	const { context, component, x, y, width, height, clip } = request;
	const lines = renderCached(context, component, width);
	const allocatedHeight = height === undefined ? lines.length : Math.max(0, Math.floor(height));
	let lineOffset = 0;
	if (lines.length > allocatedHeight && allocatedHeight > 0) {
		const cursorLine = lines.findIndex((line) => line.includes(CURSOR_MARKER));
		if (cursorLine >= allocatedHeight) lineOffset = cursorLine - allocatedHeight + 1;
	}
	return {
		component,
		rect: { x, y, width, height: allocatedHeight },
		clip: intersect(clip, { x, y, width, height: allocatedHeight }),
		children: [],
		lines,
		lineOffset,
		layer: 0,
	};
}

function layoutScrollComponent(request: ComponentLayoutRequest, node: ScrollLayoutNode): LayoutBox {
	const { context, component, x, y, width, height, clip } = request;
	const previousScrollTop = node.state.scrollTop;
	const contentWidth = node.state.getContentWidth(width);
	const childBox = layoutComponent(context, node.component, x, y - previousScrollTop, contentWidth, undefined, clip);
	const contentHeight = childBox.rect.height;
	const viewportHeight = height === undefined ? contentHeight : Math.max(0, Math.floor(height));
	node.state.updateLayout(contentHeight, viewportHeight, context.requestRender);
	translateBox(childBox, previousScrollTop - node.state.scrollTop);
	const scrollView = node.state as ScrollView;
	if (node.state.primary || !context.primaryScrollView) context.primaryScrollView = scrollView;
	const rect = { x, y, width, height: viewportHeight };
	const childClip = intersect(clip, rect);
	const box: LayoutBox = {
		component,
		rect,
		clip: childClip,
		children: [childBox],
		scrollView,
		scrollContentLines: renderCached(context, node.component, contentWidth),
		layer: 0,
	};
	childBox.parent = box;
	updateClips(childBox, childClip);
	return box;
}

function layoutVerticalStack(request: ComponentLayoutRequest, node: StackLayoutNode): LayoutBox {
	const { context, component, x, y, width, height, clip } = request;
	const entries = visibleStackEntries(node.entries, context.viewport);
	const intrinsicHeights = entries.map((entry) =>
		typeof entry.basis === "number" ? entry.basis : measureHeight(context, entry.component, width),
	);
	const sizes = allocateStackSizes(entries, intrinsicHeights, height, node.gap);
	const gapTotal = Math.max(0, entries.length - 1) * node.gap;
	const naturalHeight = sizes.reduce((sum, size) => sum + size, 0) + gapTotal;
	const allocatedHeight = height === undefined ? naturalHeight : Math.max(0, Math.floor(height));
	const rect = { x, y, width, height: allocatedHeight };
	const box: LayoutBox = {
		component,
		rect,
		clip: intersect(clip, rect),
		children: [],
		layer: 0,
	};
	let childY = y;
	for (let index = 0; index < entries.length; index++) {
		box.children.push(
			withParent(
				layoutComponent(context, entries[index]!.component, x, childY, width, sizes[index]!, box.clip),
				box,
			),
		);
		childY += sizes[index]! + node.gap;
	}
	return box;
}

function layoutHorizontalStack(request: ComponentLayoutRequest, node: StackLayoutNode): LayoutBox {
	const { context, component, x, y, width, height, clip } = request;
	const entries = visibleStackEntries(node.entries, context.viewport);
	const intrinsicWidths = entries.map((entry) =>
		typeof entry.basis === "number" ? entry.basis : measureWidth(context, entry.component, width),
	);
	const widths = allocateStackSizes(entries, intrinsicWidths, width, node.gap);
	const intrinsicHeights = entries.map((entry, index) =>
		measureHeight(context, entry.component, Math.max(1, widths[index]!)),
	);
	const allocatedHeight =
		height === undefined
			? intrinsicHeights.reduce((max, childHeight) => Math.max(max, childHeight), 0)
			: Math.max(0, height);
	const rect = { x, y, width, height: allocatedHeight };
	const box: LayoutBox = {
		component,
		rect,
		clip: intersect(clip, rect),
		children: [],
		layer: 0,
	};
	let childX = x;
	for (let index = 0; index < entries.length; index++) {
		const naturalChildHeight = intrinsicHeights[index]!;
		const childHeight = node.align === "stretch" ? allocatedHeight : Math.min(allocatedHeight, naturalChildHeight);
		let childY = y;
		if (node.align === "center") childY += Math.floor((allocatedHeight - childHeight) / 2);
		else if (node.align === "end") childY += allocatedHeight - childHeight;
		const childWidth = widths[index]!;
		if (childWidth === 0) {
			box.children.push({
				component: entries[index]!.component,
				rect: { x: childX, y: childY, width: 0, height: childHeight },
				clip: { x: childX, y: childY, width: 0, height: 0 },
				children: [],
				parent: box,
				layer: 0,
			});
		} else {
			box.children.push(
				withParent(
					layoutComponent(context, entries[index]!.component, childX, childY, childWidth, childHeight, box.clip),
					box,
				),
			);
		}
		childX += childWidth + node.gap;
	}
	return box;
}

function layoutComponent(
	context: LayoutContext,
	component: Component,
	x: number,
	y: number,
	width: number,
	height: number | undefined,
	clip: LayoutRect,
): LayoutBox {
	const request = { context, component, x, y, width: Math.max(1, Math.floor(width)), height, clip };
	const node = getLayoutNode(component);
	if (!node) return layoutLeafComponent(request);
	switch (node.type) {
		case "scroll":
			return layoutScrollComponent(request, node);
		case "vstack":
			return layoutVerticalStack(request, node);
		case "hstack":
			return layoutHorizontalStack(request, node);
	}
}

function styleScrollbarCell(line: string, column: number, totalWidth: number, style: (text: string) => string): string {
	if (isImageLine(line)) return line;

	const graphemeRange = getGraphemeCellRange(line, column);
	const start = graphemeRange?.start ?? column;
	const end = graphemeRange?.end ?? column + 1;
	const before = sliceByColumn(line, 0, start, true);
	const target = sliceByColumn(line, start, end - start, true);
	const after = sliceByColumn(line, end, Math.max(0, totalWidth - end), true);

	let targetPrefix = "";
	let targetIndex = 0;
	while (targetIndex < target.length) {
		const ansi = extractAnsiCode(target, targetIndex);
		if (!ansi) break;
		targetPrefix += ansi.code;
		targetIndex += ansi.length;
	}
	const targetText = target.slice(targetIndex) || " ".repeat(end - start);
	const beforePadding = " ".repeat(Math.max(0, start - visibleWidth(before)));
	return `${before}${beforePadding}${targetPrefix}${style(targetText)}${after}`;
}

export function getScrollbarGeometry(box: LayoutBox): ScrollbarGeometry | undefined {
	if (!box.scrollView?.isScrollbarVisible || box.rect.width <= 0 || box.rect.height <= 0) return undefined;

	const contentHeight = box.children[0]?.rect.height ?? box.scrollContentLines?.length ?? 0;
	const trackHeight = box.rect.height;
	const minThumbHeight = Math.min(2, trackHeight);
	const thumbHeight = Math.max(
		minThumbHeight,
		Math.min(trackHeight, Math.round((trackHeight * trackHeight) / contentHeight)),
	);
	const maxScrollTop = Math.max(0, contentHeight - trackHeight);
	const maxThumbTop = trackHeight - thumbHeight;
	const thumbOffset = maxScrollTop === 0 ? 0 : Math.round((box.scrollView.scrollTop / maxScrollTop) * maxThumbTop);
	const column = box.rect.x + box.rect.width - 1;
	if (column < box.clip.x || column >= box.clip.x + box.clip.width) return undefined;

	return {
		column,
		trackTop: box.rect.y,
		trackHeight,
		thumbTop: box.rect.y + thumbOffset,
		thumbHeight,
		maxScrollTop,
	};
}

function paintScrollbar(box: LayoutBox, screen: string[], totalWidth: number): void {
	const geometry = getScrollbarGeometry(box);
	if (!geometry || !box.scrollView) return;

	for (let offset = 0; offset < geometry.thumbHeight; offset++) {
		const row = geometry.thumbTop + offset;
		if (row < box.clip.y || row >= box.clip.y + box.clip.height || row < 0 || row >= screen.length) continue;
		screen[row] = styleScrollbarCell(screen[row] ?? "", geometry.column, totalWidth, box.scrollView.scrollbarStyle);
	}
}

function boxFillsViewportWidth(box: LayoutBox, totalWidth: number): boolean {
	return box.rect.x === 0 && box.rect.width >= totalWidth && box.clip.x === 0 && box.clip.width >= totalWidth;
}

function cropBoxImageLine(line: string, row: number, box: LayoutBox, screenHeight: number): string {
	const imageMetadata = getKittyImageMetadata(line);
	if (!imageMetadata) return line;
	const clipBottom = Math.min(screenHeight, box.clip.y + box.clip.height);
	const visibleRows = Math.min(imageMetadata.rows, clipBottom - row);
	return visibleRows < imageMetadata.rows ? cropKittyImageLine(line, 0, visibleRows) : line;
}

function paintBoxImageLine(box: LayoutBox, screen: string[], row: number, line: string, totalWidth: number): void {
	if (boxFillsViewportWidth(box, totalWidth)) {
		screen[row] = line;
		return;
	}
	if (box.clip.x !== box.rect.x || box.clip.width !== box.rect.width) return;
	screen[row] = compositeTuiLine(screen[row] ?? "", line, box.rect.x, box.rect.width, totalWidth);
}

function paintBoxTextLine(box: LayoutBox, screen: string[], row: number, line: string, totalWidth: number): void {
	if (box.clip.width <= 0) return;
	// A full-width box painting onto an untouched row can retain the source line
	// reference. Recomposition would rebuild the row through ANSI/grapheme
	// segmentation on every frame. Keep over-wide sources on the clipping path
	// so LayoutFrame rows remain viewport-bounded.
	if (boxFillsViewportWidth(box, totalWidth) && !screen[row] && visibleWidth(line) <= totalWidth) {
		screen[row] = line;
		return;
	}
	const sourceStart = Math.max(0, box.clip.x - box.rect.x);
	const clippedLine = sliceByColumn(line, sourceStart, box.clip.width, true);
	screen[row] = compositeTuiLine(screen[row] ?? "", clippedLine, box.clip.x, box.clip.width, totalWidth);
}

function paintBoxLine(box: LayoutBox, screen: string[], row: number, sourceLine: string, totalWidth: number): void {
	const line = cropBoxImageLine(sourceLine.replace(OSC133_ZONE_PREFIX, ""), row, box, screen.length);
	if (isImageLine(line)) {
		paintBoxImageLine(box, screen, row, line, totalWidth);
		return;
	}
	paintBoxTextLine(box, screen, row, line, totalWidth);
}

function paintBoxLines(box: LayoutBox, screen: string[], totalWidth: number): void {
	if (!box.lines) return;
	const offset = box.lineOffset ?? 0;
	const firstRow = Math.max(box.rect.y, box.clip.y, 0);
	const lastRow = Math.min(box.rect.y + box.rect.height, box.clip.y + box.clip.height, screen.length);
	for (let row = firstRow; row < lastRow; row++) {
		const sourceLine = box.lines[offset + row - box.rect.y];
		if (sourceLine !== undefined) paintBoxLine(box, screen, row, sourceLine, totalWidth);
	}
}

function paintScrolledKittyImagePlacement(request: ScrolledKittyImagePaintRequest): void {
	const { box, screen, totalWidth, scrollTop, imageLine, imageRow, imageRows } = request;
	const targetRow = Math.max(0, box.rect.y, box.clip.y);
	const hiddenRows = scrollTop - imageRow + (targetRow - box.rect.y);
	if (hiddenRows >= imageRows) return;
	const clipBottom = Math.min(screen.length, box.rect.y + box.rect.height, box.clip.y + box.clip.height);
	const visibleRows = Math.min(clipBottom - targetRow, imageRows - hiddenRows);
	if (visibleRows <= 0) return;
	const cropped = cropKittyImageLine(imageLine, hiddenRows, visibleRows);
	if (boxFillsViewportWidth(box, totalWidth)) screen[targetRow] = cropped;
}

function paintScrolledKittyImage(box: LayoutBox, screen: string[], totalWidth: number): void {
	const scrollView = box.scrollView;
	const contentLines = box.scrollContentLines;
	if (!scrollView || !contentLines || scrollView.scrollTop <= 0 || box.rect.height <= 0) return;
	for (let imageRow = scrollView.scrollTop - 1; imageRow >= 0; imageRow--) {
		const imageLine = contentLines[imageRow] ?? "";
		const metadata = getKittyImageMetadata(imageLine);
		if (metadata) {
			paintScrolledKittyImagePlacement({
				box,
				screen,
				totalWidth,
				scrollTop: scrollView.scrollTop,
				imageLine,
				imageRow,
				imageRows: metadata.rows,
			});
			return;
		}
		if (imageLine !== "") return;
	}
}

function paintBox(box: LayoutBox, screen: string[], totalWidth: number): void {
	paintBoxLines(box, screen, totalWidth);
	for (const child of box.children) paintBox(child, screen, totalWidth);
	paintScrolledKittyImage(box, screen, totalWidth);
	paintScrollbar(box, screen, totalWidth);
}

export function renderLayoutFrame(
	root: Component,
	width: number,
	height: number,
	requestRender: () => void,
): LayoutFrame {
	const safeWidth = Math.max(1, Math.floor(width));
	const safeHeight = Math.max(1, Math.floor(height));
	const context: LayoutContext = {
		viewport: { width: safeWidth, height: safeHeight },
		renderCache: new Map(),
		requestRender,
		primaryScrollView: undefined,
	};
	const rootBox = layoutComponent(context, root, 0, 0, safeWidth, safeHeight, {
		x: 0,
		y: 0,
		width: safeWidth,
		height: safeHeight,
	});
	const lines = Array.from({ length: safeHeight }, () => "");
	paintBox(rootBox, lines, safeWidth);
	return {
		root: rootBox,
		width: safeWidth,
		height: safeHeight,
		lines,
		...(context.primaryScrollView === undefined ? {} : { primaryScrollView: context.primaryScrollView }),
	};
}

function containsPoint(rect: LayoutRect, x: number, y: number): boolean {
	return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

export function getScrollViewBox(frame: LayoutFrame, scrollView: ScrollView): LayoutBox | undefined {
	const visit = (box: LayoutBox): LayoutBox | undefined => {
		if (box.scrollView === scrollView) return box;
		for (const child of box.children) {
			const match = visit(child);
			if (match) return match;
		}
		return undefined;
	};
	return visit(frame.root);
}

export function getScrollViewsAt(frame: LayoutFrame, x: number, y: number): ScrollView[] {
	const result: Array<{ scrollView: ScrollView; depth: number }> = [];
	const visit = (box: LayoutBox, depth: number): void => {
		if (!containsPoint(box.clip, x, y)) return;
		if (box.scrollView && containsPoint(box.rect, x, y)) result.push({ scrollView: box.scrollView, depth });
		for (const child of box.children) visit(child, depth + 1);
	};
	visit(frame.root, 0);
	result.sort((a, b) => b.depth - a.depth);
	return result.map((entry) => entry.scrollView);
}
