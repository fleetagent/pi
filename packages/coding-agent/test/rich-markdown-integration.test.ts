import type { AssistantMessage } from "@fleetagent/pi-ai";
import { visibleWidth } from "@fleetagent/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { MarkdownTransformContext, MarkdownTransformer } from "../src/core/extensions/types.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import {
	applyMarkdownTransformers,
	createMarkdownTransform,
} from "../src/modes/interactive/components/markdown-transform.ts";
import { createMermaidMarkdownTransformer } from "../src/modes/interactive/components/mermaid.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

function assistantMessage(text: string, thinking = ""): AssistantMessage {
	return {
		role: "assistant",
		content: [...(thinking ? [{ type: "thinking" as const, thinking }] : []), { type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("interactive Markdown transformer chain", () => {
	it("chains in order while isolating throws and non-string results", () => {
		const context: MarkdownTransformContext = {
			messageType: "assistant",
			isStreaming: false,
			availableWidth: 40,
		};
		const invalid = (() => 42) as unknown as MarkdownTransformer;
		const result = applyMarkdownTransformers("a", context, [
			(markdown) => `${markdown}b`,
			() => {
				throw new Error("ignored");
			},
			invalid,
			(markdown) => `${markdown}c`,
		]);
		expect(result).toBe("abc");
	});

	it("passes exact assistant, thinking, and user contexts without mutating messages", () => {
		initTheme("dark");
		const contexts: MarkdownTransformContext[] = [];
		const transformer: MarkdownTransformer = (markdown, context) => {
			contexts.push({ ...context });
			return `${markdown} transformed`;
		};
		const message = assistantMessage("answer", "reason");
		const before = structuredClone(message);
		const assistant = new AssistantMessageComponent(message, false, getMarkdownTheme(), "Thinking...", 1, [
			transformer,
		]);
		const userText = "1) user\\text";
		const user = new UserMessageComponent(userText, getMarkdownTheme(), 1, [transformer]);

		assistant.render(40);
		user.render(40);

		expect(contexts).toEqual([
			{ messageType: "assistant-thinking", isStreaming: false, availableWidth: 38 },
			{ messageType: "assistant", isStreaming: false, availableWidth: 38 },
			{ messageType: "user", isStreaming: false, availableWidth: 38 },
		]);
		expect(message).toEqual(before);
		expect(userText).toBe("1) user\\text");
	});

	it("reruns on streaming-to-final, width, mode, and theme invalidation transitions", () => {
		initTheme("dark");
		let mode = "streaming";
		let themeName = "dark";
		const calls: MarkdownTransformContext[] = [];
		const transformer: MarkdownTransformer = (markdown, context) => {
			calls.push({ ...context });
			return `${markdown} ${mode} ${themeName}`;
		};
		const message = assistantMessage("answer");
		const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1, [
			transformer,
		]);

		component.updateContent(message, true);
		component.render(40);
		component.render(40);
		component.render(50);
		mode = "final";
		themeName = "light";
		component.invalidate();
		component.render(50);
		component.updateContent(message, false);
		component.render(50);

		expect(calls.map(({ isStreaming, availableWidth }) => [isStreaming, availableWidth])).toEqual([
			[true, 38],
			[true, 48],
			[true, 48],
			[false, 48],
		]);
		expect(message).toEqual(assistantMessage("answer"));
	});

	it("runs built-in Mermaid before extensions and continues after extension failure", () => {
		const extension = vi.fn((markdown: string) => `${markdown}\nextension`);
		const mermaid = createMermaidMarkdownTransformer({
			getMode: () => "streaming",
			renderMermaid: () => ({
				plain: ["A -> B"],
				styled: [[{ text: "A -> B", cls: "text" }]],
				width: 6,
				warnings: [],
			}),
		});
		const transform = createMarkdownTransform("assistant", false, [
			mermaid,
			() => {
				throw new Error("ignored");
			},
			extension,
		]);
		const source = "```mermaid\ngraph TD\nA-->B\n```\n";

		const result = transform(source, 20);

		expect(extension).toHaveBeenCalledWith("`A -> B`  \n", {
			messageType: "assistant",
			isStreaming: false,
			availableWidth: 20,
		});
		expect(result).toContain("extension");
		expect(result).not.toContain("```mermaid");
		expect(result.split("\n").every((line) => visibleWidth(line) <= 20)).toBe(true);
	});
});
