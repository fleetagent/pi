import { describe, expect, it, vi } from "vitest";
import type { MarkdownTransformContext, MarkdownTransformer } from "../src/core/extensions/types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type RebindContext = {
	ui: object;
	unsubscribe?: () => void;
	transcriptRendered: boolean;
	applyRuntimeSettings: () => void;
	bindCurrentSessionExtensions: () => Promise<void>;
	retireAndRenderCurrentTranscript: () => void;
	subscribeToAgent: () => void;
	updateAvailableProviderCount: () => Promise<void>;
	updateEditorBorderColor: () => void;
	updateTerminalTitle: () => void;
};

type InteractiveModePrivate = {
	rebindCurrentSession(this: RebindContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;
const transformContext: MarkdownTransformContext = {
	messageType: "assistant",
	isStreaming: false,
	availableWidth: 80,
};

describe("InteractiveMode Markdown transformer rebind", () => {
	it("rebuilds an existing transcript with replacement transformers before subscribing callbacks", async () => {
		const calls: string[] = [];
		const oldTransformer: MarkdownTransformer = vi.fn((markdown) => `${markdown}:old`);
		const replacementTransformer: MarkdownTransformer = vi.fn((markdown) => `${markdown}:replacement`);
		let activeTransformers = [oldTransformer];
		const rendered: string[] = [];
		const renderTranscript = () => {
			let markdown = "transcript";
			for (const transformer of activeTransformers) markdown = transformer(markdown, transformContext);
			rendered.push(markdown);
		};
		renderTranscript();

		const renderer = { mode: "fullscreen" };
		const context: RebindContext = {
			ui: renderer,
			unsubscribe: () => calls.push("unsubscribe"),
			transcriptRendered: true,
			applyRuntimeSettings: () => calls.push("settings"),
			bindCurrentSessionExtensions: async () => {
				calls.push("bind");
				activeTransformers = [replacementTransformer];
			},
			retireAndRenderCurrentTranscript: () => {
				calls.push("render");
				renderTranscript();
			},
			subscribeToAgent: () => calls.push("subscribe"),
			updateAvailableProviderCount: async () => {
				calls.push("providers");
			},
			updateEditorBorderColor: () => calls.push("border"),
			updateTerminalTitle: () => calls.push("title"),
		};

		await interactiveModePrototype.rebindCurrentSession.call(context);

		expect(rendered).toEqual(["transcript:old", "transcript:replacement"]);
		expect(oldTransformer).toHaveBeenCalledTimes(1);
		expect(replacementTransformer).toHaveBeenCalledTimes(1);
		expect(context.ui).toBe(renderer);
		expect(calls).toEqual(["unsubscribe", "settings", "bind", "render", "subscribe", "providers", "border", "title"]);
	});

	it("does not render during the initial bind before startup renders the transcript", async () => {
		const render = vi.fn();
		const context: RebindContext = {
			ui: { mode: "fullscreen" },
			transcriptRendered: false,
			applyRuntimeSettings: vi.fn(),
			bindCurrentSessionExtensions: vi.fn(async () => {}),
			retireAndRenderCurrentTranscript: render,
			subscribeToAgent: vi.fn(),
			updateAvailableProviderCount: vi.fn(async () => {}),
			updateEditorBorderColor: vi.fn(),
			updateTerminalTitle: vi.fn(),
		};

		await interactiveModePrototype.rebindCurrentSession.call(context);
		expect(render).not.toHaveBeenCalled();
	});
});
