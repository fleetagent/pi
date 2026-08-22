/**
 * Message content is required by the TypeScript contract, but untyped callers
 * can supply null or omit it. Provider conversion is intentionally lax at its
 * boundary and normalizes only those nullish values without mutating history.
 */

import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/providers/transform-messages.ts";
import type { Message, Model } from "../src/types.ts";

function makeModel(supportsImages = false): Model<"openai-completions"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		input: supportsImages ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	};
}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("lax message content handling", () => {
	it("normalizes null or missing content for provider conversion without mutating the input", () => {
		const messages = [
			{ role: "user", content: null, timestamp: Date.now() },
			{
				role: "assistant",
				content: null,
				api: "openai-completions",
				provider: "openai",
				model: "test-model",
				usage,
				stopReason: "stop",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "web_search",
				isError: false,
				timestamp: Date.now(),
			},
		] as unknown as Message[];

		const result = transformMessages(messages, makeModel());

		expect(result).toHaveLength(3);
		for (const message of result) {
			expect(message.content).toEqual([]);
		}
		expect(messages[0].content).toBeNull();
		expect(messages[1].content).toBeNull();
		expect("content" in messages[2]).toBe(false);
	});

	it("preserves valid signed reasoning and image content", () => {
		const userContent = [
			{ type: "text" as const, text: "describe this" },
			{ type: "image" as const, data: "dXNlcg==", mimeType: "image/png" },
		];
		const signedThinking = {
			type: "thinking" as const,
			thinking: "",
			thinkingSignature: "signed-reasoning",
		};
		const signedText = { type: "text" as const, text: "result", textSignature: "signed-text" };
		const signedToolCall = {
			type: "toolCall" as const,
			id: "call_1",
			name: "inspect_image",
			arguments: {},
			thoughtSignature: "signed-tool-call",
		};
		const assistantContent = [signedThinking, signedText, signedToolCall];
		const toolContent = [{ type: "image" as const, data: "dG9vbA==", mimeType: "image/png" }];
		const messages: Message[] = [
			{ role: "user", content: userContent, timestamp: Date.now() },
			{
				role: "assistant",
				content: assistantContent,
				api: "openai-completions",
				provider: "openai",
				model: "test-model",
				usage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "inspect_image",
				content: toolContent,
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, makeModel(true));

		expect(result).toHaveLength(3);
		expect(result[0]).toBe(messages[0]);
		expect(result[0].content).toBe(userContent);
		expect(result[1].content).toEqual(assistantContent);
		expect(result[1].content[0]).toBe(signedThinking);
		expect(result[1].content[1]).toBe(signedText);
		expect(result[1].content[2]).toBe(signedToolCall);
		expect(result[2]).toBe(messages[2]);
		expect(result[2].content).toBe(toolContent);
		expect(messages[1].content).toBe(assistantContent);
	});
});
