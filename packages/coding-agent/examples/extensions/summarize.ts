import { complete, getModel, type TextContent } from "@fleetagent/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@fleetagent/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@fleetagent/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@fleetagent/pi-tui";

type ContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

const extractTextParts = (content: unknown): string[] => {
	if (typeof content === "string") {
		return [content];
	}

	if (!Array.isArray(content)) {
		return [];
	}

	const textParts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") {
			continue;
		}

		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") {
			textParts.push(block.text);
		}
	}

	return textParts;
};

const extractToolCallLines = (content: unknown): string[] => {
	if (!Array.isArray(content)) {
		return [];
	}

	const toolCalls: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") {
			continue;
		}

		const block = part as ContentBlock;
		if (block.type !== "toolCall" || typeof block.name !== "string") {
			continue;
		}

		const args = block.arguments ?? {};
		toolCalls.push(`Tool ${block.name} was called with args ${JSON.stringify(args)}`);
	}

	return toolCalls;
};

const formatConversationEntry = (entry: SessionEntry): string | undefined => {
	if (entry.type !== "message" || !entry.message?.role) return undefined;
	const role = entry.message.role;
	if (role !== "user" && role !== "assistant") return undefined;

	const entryLines: string[] = [];
	const messageText = extractTextParts(entry.message.content).join("\n").trim();
	if (messageText.length > 0) entryLines.push(`${role === "user" ? "User" : "Assistant"}: ${messageText}`);
	if (role === "assistant") entryLines.push(...extractToolCallLines(entry.message.content));
	return entryLines.length > 0 ? entryLines.join("\n") : undefined;
};

const buildConversationText = (entries: SessionEntry[]): string => {
	const sections: string[] = [];
	for (const entry of entries) {
		const section = formatConversationEntry(entry);
		if (section) sections.push(section);
	}

	return sections.join("\n\n");
};

const buildSummaryPrompt = (conversationText: string): string =>
	[
		"Summarize this conversation so I can resume it later.",
		"Include goals, key decisions, progress, open questions, and next steps.",
		"Keep it concise and structured with headings.",
		"",
		"<conversation>",
		conversationText,
		"</conversation>",
	].join("\n");

const showSummaryUi = async (summary: string, ctx: ExtensionCommandContext) => {
	if (!ctx.hasUI) {
		return;
	}

	await ctx.ui.custom((_tui, theme, _kb, done) => {
		const container = new Container();
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));
		const mdTheme = getMarkdownTheme();

		container.addChild(border);
		container.addChild(new Text(theme.fg("accent", theme.bold("Conversation Summary")), 1, 0));
		container.addChild(new Markdown(summary, 1, 1, mdTheme));
		container.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 1, 0));
		container.addChild(border);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
					done(undefined);
				}
			},
		};
	});
};

function notifySummaryWarning(ctx: ExtensionCommandContext, message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, "warning");
}

async function generateConversationSummary(
	conversationText: string,
	ctx: ExtensionCommandContext,
): Promise<string | undefined> {
	const model = getModel("openai", "gpt-5.2");
	if (!model) {
		notifySummaryWarning(ctx, "Model openai/gpt-5.2 not found");
		return undefined;
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		notifySummaryWarning(ctx, auth.error);
		return undefined;
	}
	if (!auth.apiKey) {
		notifySummaryWarning(ctx, "No API key for openai/gpt-5.2");
		return undefined;
	}
	const response = await complete(
		model,
		{
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: buildSummaryPrompt(conversationText) }],
					timestamp: Date.now(),
				},
			],
		},
		{ apiKey: auth.apiKey, headers: auth.headers, reasoningEffort: "high" },
	);
	return response.content
		.filter((content): content is TextContent => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("summarize", {
		description: "Summarize the current conversation in a custom UI",
		handler: async (_args, ctx) => {
			const branch = ctx.session.getBranch();
			const conversationText = buildConversationText(branch);

			if (!conversationText.trim()) {
				if (ctx.hasUI) {
					ctx.ui.notify("No conversation text found", "warning");
				}
				return;
			}

			if (ctx.hasUI) {
				ctx.ui.notify("Preparing summary...", "info");
			}

			const summary = await generateConversationSummary(conversationText, ctx);
			if (summary === undefined) return;

			await showSummaryUi(summary, ctx);
		},
	});
}
