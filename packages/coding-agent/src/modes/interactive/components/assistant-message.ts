import type { AssistantContent, AssistantMessage } from "@fleetagent/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@fleetagent/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
interface AssistantContentVisibility {
	anyVisible: boolean;
	visibleAfter: boolean[];
}

function isVisibleAssistantContent(content: AssistantContent): boolean {
	return (
		(content.type === "text" && Boolean(content.text.trim())) ||
		(content.type === "thinking" && Boolean(content.thinking.trim()))
	);
}

function inspectAssistantContentVisibility(content: readonly AssistantContent[]): AssistantContentVisibility {
	const visibleAfter = new Array<boolean>(content.length);
	let anyVisible = false;
	for (let index = content.length - 1; index >= 0; index--) {
		visibleAfter[index] = anyVisible;
		if (isVisibleAssistantContent(content[index])) anyVisible = true;
	}
	return { anyVisible, visibleAfter };
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	private renderThinkingContent(thinking: string, hasVisibleContentAfter: boolean): void {
		if (this.hideThinkingBlock) {
			this.contentContainer.addChild(
				new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0),
			);
		} else {
			this.contentContainer.addChild(
				new Markdown(
					thinking.trim(),
					this.outputPad,
					0,
					this.markdownTheme,
					{
						color: (text: string) => theme.fg("thinkingText", text),
						italic: true,
					},
					{
						transform: createMarkdownTransform("assistant-thinking", this.isStreaming, this.markdownTransformers),
					},
				),
			);
		}
		if (hasVisibleContentAfter) this.contentContainer.addChild(new Spacer(1));
	}

	private renderMessageContent(message: AssistantMessage): boolean {
		const visibility = inspectAssistantContentVisibility(message.content);
		if (visibility.anyVisible) this.contentContainer.addChild(new Spacer(1));
		let hasToolCalls = false;
		for (let index = 0; index < message.content.length; index++) {
			const content = message.content[index];
			if (content.type === "toolCall") {
				hasToolCalls = true;
				continue;
			}
			if (content.type === "text" && content.text.trim()) {
				this.contentContainer.addChild(
					new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme, undefined, {
						transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
					}),
				);
			} else if (content.type === "thinking" && content.thinking.trim()) {
				this.renderThinkingContent(content.thinking, visibility.visibleAfter[index]);
			}
		}
		return hasToolCalls;
	}

	private appendCompletionStatus(message: string): void {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("error", message), this.outputPad, 0));
	}

	private renderCompletionStatus(message: AssistantMessage, hasToolCalls: boolean): void {
		if (message.stopReason === "length") {
			this.appendCompletionStatus(
				"Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
			);
			return;
		}
		if (hasToolCalls) return;
		if (message.stopReason === "aborted") {
			const abortMessage =
				message.errorMessage && message.errorMessage !== "Request was aborted"
					? message.errorMessage
					: "Operation aborted";
			this.appendCompletionStatus(abortMessage);
		} else if (message.stopReason === "error") {
			this.appendCompletionStatus(`Error: ${message.errorMessage || "Unknown error"}`);
		}
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;
		// Clear content container
		this.contentContainer.clear();

		const hasToolCalls = this.renderMessageContent(message);
		this.hasToolCalls = hasToolCalls;
		this.renderCompletionStatus(message, hasToolCalls);
	}
}
