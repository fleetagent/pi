import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/models.ts";
import { type AnthropicOptions, streamAnthropic, streamSimpleAnthropic } from "../src/providers/anthropic.ts";
import { isAnthropicFable51 } from "../src/providers/anthropic-fable.ts";
import type { Context, ThinkingLevel } from "../src/types.ts";

const model = getModel("anthropic", "claude-fable-5-1");
const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 0 }] };
const bindingBeta = "thinking-binding-controls-2026-08-01";

function mockTransport() {
	const requests: { body: MessageCreateParamsStreaming; headers: Headers }[] = [];
	const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
		requests.push({
			body: JSON.parse(String(init?.body)) as MessageCreateParamsStreaming,
			headers: new Headers(init?.headers),
		});
		const request = requests.at(-1)!;
		if (
			request.body.model === model.id &&
			request.body.messages.some((message) => message.role === "assistant") &&
			(request.body.thinking?.type !== "adaptive" ||
				request.body.thinking.block_binding?.prefix_mismatch_behavior !== "drop_block" ||
				!request.headers.get("anthropic-beta")?.includes(bindingBeta))
		) {
			return new Response(
				JSON.stringify({
					type: "error",
					error: { type: "invalid_request_error", message: "thinking prefix mismatch" },
				}),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		}
		const events = [
			{ type: "message_start", message: { id: "msg_test", usage: { input_tokens: 10, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed-" } },
			{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "thinking" } },
			{ type: "content_block_stop", index: 0 },
			{
				type: "content_block_start",
				index: 1,
				content_block: { type: "tool_use", id: "tool_1", name: "read", input: {} },
			},
			{ type: "content_block_stop", index: 1 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
			{ type: "message_stop" },
		];
		return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
			headers: { "content-type": "text/event-stream" },
		});
	});
	vi.stubGlobal("fetch", fetchMock);
	return { requests, fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

describe("direct Anthropic Fable 5.1", () => {
	it("publishes verified metadata and confines matching to the direct model", () => {
		expect(model.cost).toEqual({ input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 });
		expect(model.contextWindow).toBe(1000000);
		expect(model.maxTokens).toBe(128000);
		expect(model.thinkingLevelMap).toMatchObject({ off: "low", minimal: "low", xhigh: "xhigh" });
		expect(getSupportedThinkingLevels(model)).toContain("xhigh");
		for (const id of ["claude-fable-5", "claude-fable-5-10", "claude-fable-5.1"]) {
			expect(isAnthropicFable51({ ...model, id })).toBe(false);
		}
		expect(isAnthropicFable51({ ...model, provider: "other" })).toBe(false);
	});

	it.each<ThinkingLevel | undefined>([undefined, "minimal", "low", "medium", "high", "xhigh"])(
		"uses adaptive effort for %s",
		async (reasoning) => {
			const { requests } = mockTransport();
			const result = await streamSimpleAnthropic(model, context, {
				apiKey: "test-key",
				reasoning,
				temperature: 0,
				maxTokens: 4000,
			}).result();
			expect(result.stopReason).toBe("toolUse");
			expect(requests[0].body.thinking).toEqual({
				type: "adaptive",
				display: "summarized",
				block_binding: { prefix_mismatch_behavior: "drop_block" },
			});
			expect(requests[0].body.output_config?.effort).toBe(!reasoning || reasoning === "minimal" ? "low" : reasoning);
			expect(requests[0].body.temperature).toBeUndefined();
			expect(requests[0].body.max_tokens).toBe(4000);
			expect(requests[0].headers.get("anthropic-beta")).toBe(bindingBeta);
		},
	);

	it.each<AnthropicOptions>([
		{},
		{ thinkingEnabled: false },
		{ thinkingEnabled: true, thinkingBudgetTokens: 2000 },
		{ effort: "max", thinkingDisplay: "omitted" },
	])("handles provider-specific thinking options %j", async (options) => {
		const { requests } = mockTransport();
		await streamAnthropic(model, context, { ...options, apiKey: "test-key", temperature: 1 }).result();
		expect(requests[0].body.thinking?.type).toBe("adaptive");
		expect(requests[0].body.output_config?.effort).toBe(
			options.thinkingEnabled === false ? "low" : (options.effort ?? "high"),
		);
		expect(requests[0].body.temperature).toBeUndefined();
	});

	it("preserves OAuth and custom beta headers", async () => {
		const { requests } = mockTransport();
		await streamAnthropic(model, context, { apiKey: "sk-ant-oat-test" }).result();
		expect(requests[0].headers.get("authorization")).toBe("Bearer sk-ant-oat-test");
		expect(requests[0].headers.get("user-agent")).toBe("claude-cli/2.1.251");
		expect(requests[0].headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
		expect(requests[0].headers.get("anthropic-beta")).toContain(bindingBeta);
		await streamAnthropic(model, context, {
			apiKey: "test-key",
			headers: { "Anthropic-Beta": "custom-beta" },
		}).result();
		expect(requests[1].headers.get("anthropic-beta")).toBe(`custom-beta,${bindingBeta}`);
	});

	it("adds recovery to an injected client without replacing its headers or fetch", async () => {
		const { requests, fetchMock } = mockTransport();
		const client = new Anthropic({
			apiKey: "test-key",
			fetch: fetchMock,
			defaultHeaders: { "anthropic-beta": "client-beta", "x-client": "kept" },
		});
		await streamAnthropic(model, context, { client }).result();
		expect(requests[0].headers.get("anthropic-beta")).toBe(`client-beta,${bindingBeta}`);
		expect(requests[0].headers.get("x-client")).toBe("kept");
	});

	it.each<AnthropicOptions["toolChoice"]>(["any", { type: "tool", name: "read" }])(
		"rejects forced tool choice %j before HTTP",
		async (toolChoice) => {
			const { fetchMock } = mockTransport();
			const result = await streamAnthropic(model, context, { apiKey: "test-key", toolChoice }).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("does not support forced tool choice");
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each<AnthropicOptions["toolChoice"]>(["auto", "none"])("allows tool choice %s", async (toolChoice) => {
		const { requests } = mockTransport();
		await streamAnthropic(model, context, { apiKey: "test-key", toolChoice }).result();
		expect(requests[0].body.tool_choice).toEqual({ type: toolChoice });
	});

	it.each(["unchanged", "system", "compaction", "tools", "history"])(
		"replays signed thinking after %s changes",
		async (change) => {
			const { requests } = mockTransport();
			const response = await streamAnthropic(model, context, {
				apiKey: "test-key",
				thinkingDisplay: "omitted",
			}).result();
			expect(response.content[0]).toMatchObject({
				type: "thinking",
				thinking: "",
				thinkingSignature: "signed-thinking",
			});
			const continued: Context = {
				messages: [
					...context.messages,
					response,
					{
						role: "toolResult",
						toolCallId: "tool_1",
						toolName: "read",
						content: [{ type: "text", text: "result" }],
						isError: false,
						timestamp: 1,
					},
				],
			};
			if (change === "system") continued.systemPrompt = "Changed prompt";
			if (change === "compaction") continued.messages = continued.messages.slice(1);
			if (change === "history") continued.messages[0] = { role: "user", content: "Edited", timestamp: 0 };
			if (change === "tools")
				continued.tools = [{ name: "lazy_tool", description: "Newly loaded", parameters: Type.Object({}) }];
			const result = await streamAnthropic(model, continued, { apiKey: "test-key" }).result();
			expect(result.stopReason).toBe("toolUse");
			const request = requests[1];
			const assistant = request.body.messages.find((message) => message.role === "assistant");
			expect(assistant?.content).toContainEqual({ type: "thinking", thinking: "", signature: "signed-thinking" });
			expect(request.body.thinking).toMatchObject({ block_binding: { prefix_mismatch_behavior: "drop_block" } });
			expect(request.headers.get("anthropic-beta")).toContain(bindingBeta);
		},
	);

	it("preserves redacted thinking and omits unsigned empty blocks", async () => {
		const { requests } = mockTransport();
		const response = await streamAnthropic(model, context, { apiKey: "test-key" }).result();
		response.content = [
			{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque-data" },
			{ type: "thinking", thinking: "" },
			{ type: "text", text: "Answer" },
		];
		await streamAnthropic(model, { messages: [...context.messages, response] }, { apiKey: "test-key" }).result();
		const assistant = requests[1].body.messages[1];
		expect(assistant.content).toEqual([
			{ type: "redacted_thinking", data: "opaque-data" },
			{ type: "text", text: "Answer" },
		]);
	});

	it("does not forward another model's thinking signatures", async () => {
		const { requests } = mockTransport();
		const response = await streamAnthropic(getModel("anthropic", "claude-sonnet-4-5"), context, {
			apiKey: "test-key",
		}).result();
		await streamAnthropic(model, { messages: [...context.messages, response] }, { apiKey: "test-key" }).result();
		expect(JSON.stringify(requests[1].body.messages)).not.toContain("signed-thinking");
		expect(requests[1].headers.get("anthropic-beta")).toContain(bindingBeta);
	});

	it("surfaces strict prefix errors when a payload hook removes recovery", async () => {
		mockTransport();
		const response = await streamAnthropic(model, context, { apiKey: "test-key" }).result();
		const result = await streamAnthropic(
			model,
			{ messages: [...context.messages, response] },
			{
				apiKey: "test-key",
				onPayload: (payload) => ({ ...(payload as MessageCreateParamsStreaming), thinking: { type: "adaptive" } }),
			},
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("thinking prefix mismatch");
	});

	it("leaves older model request behavior unchanged", async () => {
		const { requests } = mockTransport();
		await streamSimpleAnthropic(getModel("anthropic", "claude-sonnet-4-5"), context, {
			apiKey: "test-key",
			temperature: 0,
		}).result();
		expect(requests[0].body.thinking).toEqual({ type: "disabled" });
		expect(requests[0].body.temperature).toBe(0);
		expect(requests[0].headers.get("anthropic-beta")).not.toContain(bindingBeta);
	});
});
