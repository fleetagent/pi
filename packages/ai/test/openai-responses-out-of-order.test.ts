import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { processResponsesStream } from "../src/providers/openai-responses-shared.ts";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5.6",
	name: "GPT-5.6",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
};

function createOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function* createInterleavedEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		sequence_number: 0,
		output_index: 0,
		item: { type: "reasoning", id: "rs_test", summary: [] },
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.added",
		sequence_number: 1,
		output_index: 1,
		item: { type: "message", id: "msg_test", role: "assistant", status: "in_progress", content: [] },
	} as ResponseStreamEvent;
	yield {
		type: "response.reasoning_summary_text.delta",
		sequence_number: 2,
		output_index: 0,
		item_id: "rs_test",
		summary_index: 0,
		delta: "Preserved reasoning",
	} as ResponseStreamEvent;
	yield {
		type: "response.output_text.delta",
		sequence_number: 3,
		output_index: 1,
		item_id: "msg_test",
		content_index: 0,
		delta: "Visible text",
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		sequence_number: 4,
		output_index: 0,
		item: {
			type: "reasoning",
			id: "rs_test",
			summary: [{ type: "summary_text", text: "Preserved reasoning" }],
			content: [],
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		sequence_number: 5,
		output_index: 1,
		item: {
			type: "message",
			id: "msg_test",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Visible text", annotations: [] }],
		},
	} as ResponseStreamEvent;
}

describe("OpenAI Responses out-of-order output items", () => {
	it("routes interleaved reasoning and text events by output index", async () => {
		const output = createOutput();
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");

		await processResponsesStream(createInterleavedEvents(), output, stream, model);

		expect(output.content).toMatchObject([
			{ type: "thinking", thinking: "Preserved reasoning" },
			{ type: "text", text: "Visible text" },
		]);
		const events = pushSpy.mock.calls.map(([event]) => event as AssistantMessageEvent);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "thinking_delta", contentIndex: 0, delta: "Preserved reasoning" }),
				expect.objectContaining({ type: "thinking_end", contentIndex: 0, content: "Preserved reasoning" }),
				expect.objectContaining({ type: "text_delta", contentIndex: 1, delta: "Visible text" }),
				expect.objectContaining({ type: "text_end", contentIndex: 1, content: "Visible text" }),
			]),
		);
	});
});
