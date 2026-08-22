import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { convertMessages } from "../src/providers/openai-completions.ts";
import type {
	AssistantMessage,
	Context,
	Model,
	OpenAICompletionsCompat,
	ToolResultMessage,
	Usage,
} from "../src/types.ts";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const compat: Required<OpenAICompletionsCompat> = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: "anthropic",
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: true,
};

function buildToolResult(
	toolCallId: string,
	timestamp: number,
	content: ToolResultMessage["content"] = [
		{ type: "text", text: "Read image file [image/png]" },
		{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
	],
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content,
		isError: false,
		timestamp,
	};
}

describe("openai-completions convertMessages", () => {
	it("batches tool-result images after consecutive tool results", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			input: ["text", "image"],
		};

		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "img-1.png" } },
				{ type: "toolCall", id: "tool-2", name: "read", arguments: { path: "img-2.png" } },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};

		const context: Context = {
			messages: [
				{ role: "user", content: "Read the images", timestamp: now - 2 },
				assistantMessage,
				buildToolResult("tool-1", now + 1),
				buildToolResult("tool-2", now + 2),
			],
		};

		const messages = convertMessages(model, context, compat);
		const roles = messages.map((message) => message.role);
		expect(roles).toEqual(["user", "assistant", "tool", "tool", "user"]);

		const imageMessage = messages[messages.length - 1];
		expect(imageMessage.role).toBe("user");
		expect(Array.isArray(imageMessage.content)).toBe(true);

		const imageParts = (imageMessage.content as Array<{ type?: string }>).filter(
			(part) => part?.type === "image_url",
		);
		expect(imageParts.length).toBe(2);
	});

	it("uses '(no tool output)' only for genuinely empty tool results", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			input: ["text", "image"],
		};
		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "true" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};
		const emptyContents: ToolResultMessage["content"][] = [[], [{ type: "text", text: "" }]];

		for (const content of emptyContents) {
			const context: Context = {
				messages: [
					{ role: "user", content: "Run the command", timestamp: now - 1 },
					assistantMessage,
					buildToolResult("tool-1", now + 1, content),
				],
			};
			const messages = convertMessages(model, context, compat);
			const toolMessage = messages.find((message) => message.role === "tool");

			expect(toolMessage?.content).toBe("(no tool output)");
			expect(toolMessage?.content).not.toContain("see attached image");
		}
	});

	it("preserves the image placeholder and image for image-only tool results", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			input: ["text", "image"],
		};
		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "image.png" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Read the image", timestamp: now - 1 },
				assistantMessage,
				buildToolResult("tool-1", now + 1, [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }]),
			],
		};

		const messages = convertMessages(model, context, compat);
		const toolMessage = messages.find((message) => message.role === "tool");
		const imageMessage = messages.find(
			(message) =>
				message.role === "user" &&
				Array.isArray(message.content) &&
				message.content.some((part) => part.type === "image_url"),
		);

		expect(toolMessage?.content).toBe("(see attached image)");
		expect(imageMessage).toBeTruthy();
	});
});
