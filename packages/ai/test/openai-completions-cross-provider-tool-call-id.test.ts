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
import { shortHash } from "../src/utils/hash.ts";

const usage: Usage = {
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

function convertResponsesHandoff(ids: string[]) {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
	const model: Model<"openai-completions"> = { ...baseModel, api: "openai-completions" };
	const now = Date.now();
	const assistant: AssistantMessage = {
		role: "assistant",
		content: ids.map((id, index) => ({
			type: "toolCall",
			id,
			name: "echo",
			arguments: { value: index },
		})),
		api: "openai-responses",
		provider: "github-copilot",
		model: "gpt-5",
		usage,
		stopReason: "toolUse",
		timestamp: now,
	};
	const toolResults: ToolResultMessage[] = ids.map((id, index) => ({
		role: "toolResult",
		toolCallId: id,
		toolName: "echo",
		content: [{ type: "text", text: String(index) }],
		isError: false,
		timestamp: now + index + 1,
	}));
	const context: Context = {
		messages: [{ role: "user", content: "Run both tools", timestamp: now - 1 }, assistant, ...toolResults],
	};

	const converted = convertMessages(model, context, compat);
	const assistantParam = converted.find((message) => message.role === "assistant");
	if (assistantParam?.role !== "assistant") {
		throw new Error("Expected assistant message");
	}
	const toolParams = converted.filter((message) => message.role === "tool");
	return {
		assistantIds: assistantParam.tool_calls?.map((toolCall) => toolCall.id) ?? [],
		resultIds: toolParams.map((toolParam) => toolParam.tool_call_id),
	};
}

describe("OpenAI Completions cross-provider tool-call IDs", () => {
	it("preserves item-level uniqueness and matching tool results for short Responses IDs", () => {
		const ids = ["call_shared|fc_first", "call_shared|fc_second|segment"];
		const converted = convertResponsesHandoff(ids);

		expect(converted.assistantIds).toEqual(["call_shared_fc_first", "call_shared_fc_second_segment"]);
		expect(converted.resultIds).toEqual(converted.assistantIds);
		expect(new Set(converted.assistantIds).size).toBe(ids.length);
	});

	it("hashes the original long composite ID so sanitized item-ID collisions stay unique", () => {
		const callId = "call_shared_provider_identifier_123456789";
		const ids = [`${callId}|item+${"a".repeat(80)}`, `${callId}|item/${"a".repeat(80)}`];
		const converted = convertResponsesHandoff(ids);
		const expected = ids.map((id) => `${callId.slice(0, 31)}_${shortHash(id).slice(0, 8)}`);

		expect(converted.assistantIds).toEqual(expected);
		expect(converted.resultIds).toEqual(expected);
		expect(new Set(converted.assistantIds).size).toBe(ids.length);
		for (const id of converted.assistantIds) {
			expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
			expect(id.length).toBeLessThanOrEqual(40);
		}
	});
});
