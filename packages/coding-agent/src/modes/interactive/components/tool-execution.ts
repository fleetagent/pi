import { Box, type Component, Container, getCapabilities, Image, Spacer, Text, type TUI } from "@fleetagent/pi-tui";
import type {
	ToolCallRenderer,
	ToolDefinition,
	ToolRenderContext,
	ToolRenderShell,
	ToolResultRenderer,
} from "../../../core/extensions/types.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { LocalToolOperations } from "../../../core/tools/operations.ts";
import {
	getTextOutput as getRenderedTextOutput,
	type ToolTextOutputContent,
} from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
}
export interface ToolExecutionDisplayResult {
	content: ToolTextOutputContent[];
	details?: any;
	isError: boolean;
}

type ToolBackgroundFormatter = (text: string) => string;

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: ToolExecutionDisplayResult;
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createAllToolDefinitions(new LocalToolOperations(cwd))[toolName as ToolName];
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolCallRenderer<any, any> | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolResultRenderer<any, any, any> | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): ToolRenderShell {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		return new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}
		return new Text(theme.fg("toolOutput", output), 0, 0);
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(result: ToolExecutionDisplayResult, isPartial = false): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}
		return super.render(width);
	}

	private getBackgroundFormatter(): ToolBackgroundFormatter {
		if (this.isPartial) return (text) => theme.bg("toolPendingBg", text);
		if (this.result?.isError) return (text) => theme.bg("toolErrorBg", text);
		return (text) => theme.bg("toolSuccessBg", text);
	}

	private renderToolCall(renderContainer: Container): boolean {
		const callRenderer = this.getCallRenderer();
		if (!callRenderer) {
			renderContainer.addChild(this.createCallFallback());
			return true;
		}
		try {
			const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
			this.callRendererComponent = component;
			renderContainer.addChild(component);
		} catch {
			this.callRendererComponent = undefined;
			renderContainer.addChild(this.createCallFallback());
		}
		return true;
	}

	private renderToolResult(renderContainer: Container): boolean {
		if (!this.result) return false;
		const resultRenderer = this.getResultRenderer();
		if (!resultRenderer) {
			const component = this.createResultFallback();
			if (!component) return false;
			renderContainer.addChild(component);
			return true;
		}
		try {
			const component = resultRenderer(
				{ content: this.result.content as any, details: this.result.details },
				{ expanded: this.expanded, isPartial: this.isPartial },
				theme,
				this.getRenderContext(this.resultRendererComponent),
			);
			this.resultRendererComponent = component;
			renderContainer.addChild(component);
			return true;
		} catch {
			this.resultRendererComponent = undefined;
			const component = this.createResultFallback();
			if (!component) return false;
			renderContainer.addChild(component);
			return true;
		}
	}

	private renderDefinitionContent(backgroundFormatter: ToolBackgroundFormatter): boolean {
		const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
		if (renderContainer instanceof Box) renderContainer.setBgFn(backgroundFormatter);
		renderContainer.clear();
		const callHasContent = this.renderToolCall(renderContainer);
		const resultHasContent = this.renderToolResult(renderContainer);
		return callHasContent || resultHasContent;
	}

	private renderGenericContent(backgroundFormatter: ToolBackgroundFormatter): boolean {
		this.contentText.setCustomBgFn(backgroundFormatter);
		this.contentText.setText(this.formatToolExecution());
		return true;
	}

	private clearRenderedImages(): void {
		for (const image of this.imageComponents) this.removeChild(image);
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) this.removeChild(spacer);
		this.imageSpacers = [];
	}

	private renderResultImages(): void {
		if (!this.result) return;
		const imageBlocks = this.result.content.filter((content) => content.type === "image");
		const capabilities = getCapabilities();
		for (let index = 0; index < imageBlocks.length; index++) {
			const image = imageBlocks[index];
			if (!capabilities.images || !this.showImages || !image.data || !image.mimeType) continue;
			const converted = this.convertedImages.get(index);
			const imageData = converted?.data ?? image.data;
			const imageMimeType = converted?.mimeType ?? image.mimeType;
			if (capabilities.images === "kitty" && imageMimeType !== "image/png") continue;
			const spacer = new Spacer(1);
			this.addChild(spacer);
			this.imageSpacers.push(spacer);
			const imageComponent = new Image(
				imageData,
				imageMimeType,
				{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
				{ maxWidthCells: this.imageWidthCells },
			);
			this.imageComponents.push(imageComponent);
			this.addChild(imageComponent);
		}
	}

	private updateDisplay(): void {
		const backgroundFormatter = this.getBackgroundFormatter();
		this.hideComponent = false;
		const hasRendererDefinition = this.hasRendererDefinition();
		const hasContent = hasRendererDefinition
			? this.renderDefinitionContent(backgroundFormatter)
			: this.renderGenericContent(backgroundFormatter);

		this.clearRenderedImages();
		this.renderResultImages();
		if (hasRendererDefinition && !hasContent && this.imageComponents.length === 0) this.hideComponent = true;
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
