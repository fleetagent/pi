import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { completeSimple } from "../src/stream.ts";

function createLongSystemPrompt(): string {
	const nonce = `${Date.now()}-${Math.random()}`;
	return `You are a concise assistant.\nCache nonce: ${nonce}\n\n${Array(80)
		.fill(
			"Prompt-caching probe content. Keep this exact text stable across requests so the provider can reuse prefix tokens and report cache read and cache write usage.",
		)
		.join("\n\n")}`;
}

interface OpenRouterCacheControl {
	type: string;
}

interface OpenRouterCacheableContentPart {
	type?: string;
	text?: string;
	cache_control?: OpenRouterCacheControl;
}

interface OpenRouterPromptMessage {
	role?: string;
	content?: string | OpenRouterCacheableContentPart[];
}

interface OpenRouterPromptPayload {
	messages?: OpenRouterPromptMessage[];
}

function findLastCacheableUserMessage(messages: OpenRouterPromptMessage[]): OpenRouterPromptMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const candidate = messages[index];
		if (candidate.role !== "user") continue;
		if (typeof candidate.content !== "string" && !Array.isArray(candidate.content)) continue;
		return candidate;
	}
	return undefined;
}

function markLastTextPartForCaching(content: OpenRouterCacheableContentPart[]): void {
	for (let index = content.length - 1; index >= 0; index--) {
		const part = content[index];
		if (part.type !== "text") continue;
		part.cache_control = { type: "ephemeral" };
		return;
	}
}

function markLastUserMessageForCaching(payload: unknown): unknown {
	const params = payload as OpenRouterPromptPayload;
	if (!Array.isArray(params.messages)) return payload;
	const message = findLastCacheableUserMessage(params.messages);
	if (!message) return payload;
	if (typeof message.content === "string") {
		message.content = [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }];
		return payload;
	}
	if (Array.isArray(message.content)) markLastTextPartForCaching(message.content);
	return payload;
}

describe.skipIf(!process.env.OPENROUTER_API_KEY)("OpenRouter cache_write repro E2E", () => {
	it("regression: preserves cache_write_tokens on openai-completions stream path", {
		retry: 2,
		timeout: 90000,
	}, async () => {
		const model = getModel("openrouter", "google/gemini-2.5-flash");
		const context = {
			systemPrompt: createLongSystemPrompt(),
			messages: [
				{
					role: "user" as const,
					content: "Reply with exactly: OK",
					timestamp: Date.now(),
				},
			],
		};

		const options = {
			apiKey: process.env.OPENROUTER_API_KEY!,
			maxTokens: 32,
			temperature: 0,
			onPayload: markLastUserMessageForCaching,
		};

		const first = await completeSimple(model, context, options);
		expect(first.stopReason, first.errorMessage).toBe("stop");

		const second = await completeSimple(model, context, options);
		expect(second.stopReason, second.errorMessage).toBe("stop");

		// Regression expectation: cache_write_tokens from provider usage must be preserved.
		// With the cache_control marker above, at least one of the two calls should create cache.
		const hasCacheWrite = first.usage.cacheWrite > 0 || second.usage.cacheWrite > 0;
		expect(hasCacheWrite).toBe(true);
	});
});
