import { describe, expect, it } from "vitest";
import { convertMessages, requiresToolCallId } from "../src/providers/google-shared.ts";
import type { Context, Model } from "../src/types.ts";

function makeGemini3Model<TApi extends "google-generative-ai" | "google-vertex">(
	api: TApi,
	provider: Model<TApi>["provider"],
	id = "gemini-3-pro-preview",
): Model<TApi> {
	return {
		id,
		name: "Gemini 3 Pro Preview",
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

function makeContext(
	model: { api: string; provider: string; id: string },
	thoughtSignature?: string,
	toolCallIds: readonly [string, string] = ["call_1", "call_2"],
): Context {
	const now = Date.now();
	return {
		messages: [
			{ role: "user", content: "Hi", timestamp: now },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: toolCallIds[0],
						name: "bash",
						arguments: { command: "echo hi" },
						...(thoughtSignature && { thoughtSignature }),
					},
					{
						type: "toolCall",
						id: toolCallIds[1],
						name: "bash",
						arguments: { command: "ls -la" },
					},
				],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: now,
			},
			{
				role: "toolResult",
				toolCallId: toolCallIds[0],
				toolName: "bash",
				content: [{ type: "text", text: "hi" }],
				isError: false,
				timestamp: now,
			},
			{
				role: "toolResult",
				toolCallId: toolCallIds[1],
				toolName: "bash",
				content: [{ type: "text", text: "files" }],
				isError: false,
				timestamp: now,
			},
		],
	};
}

function getFunctionIds(contents: ReturnType<typeof convertMessages>) {
	return {
		callIds: contents
			.flatMap((content) => content.parts ?? [])
			.flatMap((part) => (part.functionCall?.id ? [part.functionCall.id] : [])),
		responseIds: contents
			.flatMap((content) => content.parts ?? [])
			.flatMap((part) => (part.functionResponse?.id ? [part.functionResponse.id] : [])),
	};
}

describe("google-shared convertMessages — Gemini 3 unsigned tool calls", () => {
	it.each([
		makeGemini3Model("google-generative-ai", "google"),
		makeGemini3Model("google-generative-ai", "google", "gemini-3.6-flash"),
		makeGemini3Model("google-vertex", "google-vertex"),
	])("preserves tool call IDs for $id via $api history", (model) => {
		const ids = getFunctionIds(convertMessages(model, makeContext(model)));

		expect(ids.callIds).toEqual(["call_1", "call_2"]);
		expect(ids.responseIds).toEqual(["call_1", "call_2"]);
	});

	it("normalizes and pairs tool call and response IDs after a provider handoff", () => {
		const model = makeGemini3Model("google-generative-ai", "google");
		const sourceModel = { api: "openai-responses", provider: "github-copilot", id: "gpt-5" };
		const ids = getFunctionIds(convertMessages(model, makeContext(sourceModel, undefined, ["call.one", "call/two"])));

		expect(ids.callIds).toEqual(["call_one", "call_two"]);
		expect(ids.responseIds).toEqual(ids.callIds);
	});

	it("does not add skip_thought_signature_validator for unsigned Google Gen AI tool calls", () => {
		const model = makeGemini3Model("google-generative-ai", "google");
		const contents = convertMessages(model, makeContext({ ...model, id: "other-model" }));

		const modelTurn = contents.find((c) => c.role === "model");
		expect(modelTurn).toBeTruthy();

		const functionCallParts = modelTurn?.parts?.filter((p) => p.functionCall !== undefined) ?? [];
		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts[0]?.thoughtSignature).toBeUndefined();
		expect(functionCallParts[1]?.thoughtSignature).toBeUndefined();
		expect(JSON.stringify(modelTurn)).not.toContain("skip_thought_signature_validator");

		const textParts = modelTurn?.parts?.filter((p) => p.text !== undefined) ?? [];
		const historicalText = textParts.filter((p) => p.text?.includes("Historical context"));
		expect(historicalText).toHaveLength(0);
	});

	it("does not add skip_thought_signature_validator for unsigned Vertex tool calls", () => {
		const model = makeGemini3Model("google-vertex", "google-vertex");
		const contents = convertMessages(model, makeContext(model));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((p) => p.functionCall !== undefined) ?? [];

		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts[0]?.thoughtSignature).toBeUndefined();
		expect(functionCallParts[1]?.thoughtSignature).toBeUndefined();
		expect(JSON.stringify(modelTurn)).not.toContain("skip_thought_signature_validator");
	});

	it("preserves valid thoughtSignature when present for the same provider and model", () => {
		const model = makeGemini3Model("google-generative-ai", "google");
		const validSig = "AAAAAAAAAAAAAAAAAAAAAA==";
		const contents = convertMessages(model, makeContext(model, validSig));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((p) => p.functionCall !== undefined) ?? [];

		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts[0]?.thoughtSignature).toBe(validSig);
		expect(functionCallParts[1]?.thoughtSignature).toBeUndefined();
	});

	it("does not add a thoughtSignature or IDs for non-Gemini-3 models", () => {
		const model = makeGemini3Model("google-generative-ai", "google", "gemini-2.5-flash");
		const contents = convertMessages(model, makeContext({ ...model, id: "other-model" }));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((part) => part.functionCall !== undefined) ?? [];
		const functionResponseParts = contents
			.flatMap((content) => content.parts ?? [])
			.filter((part) => part.functionResponse !== undefined);

		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts.every((part) => part.functionCall?.id === undefined)).toBe(true);
		expect(functionCallParts.every((part) => part.thoughtSignature === undefined)).toBe(true);
		expect(functionResponseParts).toHaveLength(2);
		expect(functionResponseParts.every((part) => part.functionResponse?.id === undefined)).toBe(true);
	});
});

describe("requiresToolCallId", () => {
	it.each([
		[false, "gemini-2.5-flash"],
		[true, "gemini-3.6-flash"],
		[true, "claude-sonnet-4-5"],
		[true, "gpt-oss-120b"],
	] as const)("returns %s for %s", (expected, modelId) => {
		expect(requiresToolCallId(modelId)).toBe(expected);
	});
});
