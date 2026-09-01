import {
	allocateImageId,
	getCapabilities,
	getCellDimensions,
	getImageDimensions,
	type ImageDimensions,
	type ImageProtocol,
	type ImageRenderResult,
	imageFallback,
	renderImage,
} from "../terminal-image.ts";
import type { Component } from "../tui.ts";

export interface ImageTheme {
	fallbackColor: (str: string) => string;
}

export interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
	/** Kitty image ID. If provided, reuses this ID (for animations/updates). */
	imageId?: number;
}

export class Image implements Component {
	private base64Data: string;
	private mimeType: string;
	private dimensions: ImageDimensions;
	private theme: ImageTheme;
	private options: ImageOptions;
	private imageId?: number;

	private cachedLines?: string[];
	private cachedWidth?: number;

	constructor(
		base64Data: string,
		mimeType: string,
		theme: ImageTheme,
		options: ImageOptions = {},
		dimensions?: ImageDimensions,
	) {
		this.base64Data = base64Data;
		this.mimeType = mimeType;
		this.theme = theme;
		this.options = options;
		this.dimensions = dimensions || getImageDimensions(base64Data, mimeType) || { widthPx: 800, heightPx: 600 };
		this.imageId = options.imageId;
	}

	/** Get the Kitty image ID used by this image (if any). */
	getImageId(): number | undefined {
		return this.imageId;
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	private renderFallbackLines(): string[] {
		const fallback = imageFallback(this.mimeType, this.dimensions, this.options.filename);
		return [this.theme.fallbackColor(fallback)];
	}

	private renderKittyImageLines(result: ImageRenderResult): string[] {
		const lines = [result.sequence];
		for (let index = 0; index < result.rows - 1; index++) lines.push("");
		return lines;
	}

	private renderITermImageLines(result: ImageRenderResult): string[] {
		const lines: string[] = [];
		for (let index = 0; index < result.rows - 1; index++) lines.push("");
		const rowOffset = result.rows - 1;
		const moveUp = rowOffset > 0 ? `\x1b[${rowOffset}A` : "";
		lines.push(moveUp + result.sequence);
		return lines;
	}

	private renderTerminalImageLines(
		protocol: ImageProtocol,
		maxWidthCells: number,
		maxHeightCells: number,
	): string[] | undefined {
		if (!protocol) return undefined;
		if (protocol === "kitty" && this.imageId === undefined) this.imageId = allocateImageId();
		const result = renderImage(this.base64Data, this.dimensions, {
			maxWidthCells,
			maxHeightCells,
			imageId: this.imageId,
			moveCursor: false,
		});
		if (!result) return undefined;
		if (result.imageId) this.imageId = result.imageId;
		return protocol === "kitty" ? this.renderKittyImageLines(result) : this.renderITermImageLines(result);
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const maxWidth = Math.max(1, Math.min(width - 2, this.options.maxWidthCells ?? 60));
		const cellDimensions = getCellDimensions();
		const defaultMaxHeight = Math.max(1, Math.ceil((maxWidth * cellDimensions.widthPx) / cellDimensions.heightPx));
		const maxHeight = this.options.maxHeightCells ?? defaultMaxHeight;
		const lines =
			this.renderTerminalImageLines(getCapabilities().images, maxWidth, maxHeight) ?? this.renderFallbackLines();

		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}
}
