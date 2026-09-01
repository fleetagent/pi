import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import { processResponsesStream } from "../src/providers/openai-responses-shared.ts";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import type { MockOpenAIRequestPromise } from "./openai-mock-types.ts";

vi.mock("openai", () => {
	async function* createMockResponsesStream(): AsyncIterable<ResponseStreamEvent> {
		yield {
			type: "response.created",
			sequence_number: 0,
			response: { id: "resp_wrapper_early_eof" },
		} as ResponseStreamEvent;
		yield {
			type: "response.output_item.added",
			sequence_number: 1,
			output_index: 0,
			item: { type: "reasoning", id: "rs_wrapper_early_eof", summary: [] },
		} as ResponseStreamEvent;
	}

	class FakeOpenAI {
		responses = {
			create: () => {
				const responseStream = createMockResponsesStream();
				const promise = Promise.resolve(responseStream) as MockOpenAIRequestPromise<
					AsyncIterable<ResponseStreamEvent>
				>;
				promise.withResponse = async () => ({
					data: responseStream,
					response: { status: 200, headers: new Headers() },
				});
				return promise;
			},
		};
	}

	return { default: FakeOpenAI };
});

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
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
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

async function* createEarlyEofEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.created",
		sequence_number: 0,
		response: { id: "resp_early_eof" },
	} as ResponseStreamEvent;
}

async function* createCompletedEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.completed",
		sequence_number: 0,
		response: {
			id: "resp_completed",
			status: "completed",
			usage: {
				input_tokens: 20,
				output_tokens: 7,
				total_tokens: 27,
				input_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 },
				output_tokens_details: { reasoning_tokens: 4 },
			},
		},
	} as unknown as ResponseStreamEvent;
}

async function* createIncompleteEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.incomplete",
		sequence_number: 0,
		response: {
			id: "resp_incomplete",
			status: "incomplete",
			usage: {
				input_tokens: 30,
				output_tokens: 12,
				total_tokens: 42,
				input_tokens_details: { cached_tokens: 5 },
			},
		},
	} as ResponseStreamEvent;
}

describe("OpenAI Responses terminal event handling", () => {
	it("rejects streams that end before a terminal response event", async () => {
		const model = createModel();
		await expect(
			processResponsesStream(createEarlyEofEvents(), createOutput(model), new AssistantMessageEventStream(), model),
		).rejects.toThrow("OpenAI Responses stream ended before a terminal response event");
	});

	it("emits an error when the wrapper stream ends before a terminal event", async () => {
		const model = createModel();
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		};
		const stream = streamOpenAIResponses(model, context, { apiKey: "test" });
		const events: AssistantMessageEvent[] = [];
		let initialStopReason: AssistantMessage["stopReason"] | undefined;
		for await (const event of stream) {
			if (event.type === "start") initialStopReason = event.partial.stopReason;
			events.push(event);
		}
		const result = await stream.result();
		expect(initialStopReason).toBe("pending");
		expect(events.at(-1)?.type).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("OpenAI Responses stream ended before a terminal response event");
	});

	it("accounts for cache writes and reasoning on completed responses", async () => {
		const model = createModel();
		const output = createOutput(model);
		await processResponsesStream(createCompletedEvents(), output, new AssistantMessageEventStream(), model);
		expect(output.responseId).toBe("resp_completed");
		expect(output.stopReason).toBe("stop");
		expect(output.rawStopReason).toBe("completed");
		expect(output.usage).toMatchObject({
			input: 15,
			output: 7,
			cacheRead: 2,
			cacheWrite: 3,
			reasoning: 4,
			totalTokens: 27,
		});
	});

	it("finalizes incomplete responses with usage and a length stop", async () => {
		const model = createModel();
		const output = createOutput(model);
		await processResponsesStream(createIncompleteEvents(), output, new AssistantMessageEventStream(), model);
		expect(output.responseId).toBe("resp_incomplete");
		expect(output.stopReason).toBe("length");
		expect(output.rawStopReason).toBe("incomplete");
		expect(output.usage).toMatchObject({ input: 25, output: 12, cacheRead: 5, cacheWrite: 0, totalTokens: 42 });
	});
});
