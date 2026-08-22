import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { convertResponsesMessages } from "../src/providers/openai-responses-shared.ts";
import type { Api, AssistantMessage, Context, Model, ToolResultMessage, Usage } from "../src/types.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function convertToolResult(content: ToolResultMessage["content"], input: Model<Api>["input"]) {
	const model = { ...getModel("openai", "gpt-4o-mini"), input } satisfies Model<Api>;
	const now = Date.now();
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "true" } }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "toolUse",
		timestamp: now,
	};
	const context: Context = {
		messages: [
			{ role: "user", content: "Run the command", timestamp: now - 1 },
			assistant,
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "bash",
				content,
				isError: false,
				timestamp: now + 1,
			},
		],
	};

	const converted = convertResponsesMessages(model, context, new Set(["openai", "openai-codex", "opencode"]));
	const functionCallOutput = converted.find((item) => item.type === "function_call_output");
	if (functionCallOutput?.type !== "function_call_output") {
		throw new Error("Expected function_call_output");
	}
	return functionCallOutput.output;
}

describe("OpenAI Responses convertResponsesMessages tool result placeholders", () => {
	it("uses '(no tool output)' only for genuinely empty tool results", () => {
		const emptyContents: ToolResultMessage["content"][] = [[], [{ type: "text", text: "" }]];

		for (const content of emptyContents) {
			const output = convertToolResult(content, ["text", "image"]);
			expect(output).toBe("(no tool output)");
			expect(output).not.toContain("see attached image");
		}
	});

	it("preserves image-only tool results for image-capable models", () => {
		const output = convertToolResult([{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }], ["text", "image"]);

		expect(output).toEqual([
			{
				type: "input_image",
				detail: "auto",
				image_url: "data:image/png;base64,ZmFrZQ==",
			},
		]);
	});

	it("preserves the non-vision image placeholder when the model cannot receive images", () => {
		const output = convertToolResult([{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }], ["text"]);

		expect(output).toBe("(tool image omitted: model does not support images)");
	});
});
