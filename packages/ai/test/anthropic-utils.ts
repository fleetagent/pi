import type { IncomingHttpHeaders } from "node:http";
import type { KnownProvider, Model } from "../src/types.ts";

export interface AnthropicPayloadContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	signature?: string;
}

export interface AnthropicThinkingConfig {
	type: string;
	budget_tokens?: number;
	display?: string;
}

export interface AnthropicMessagesE2ECase {
	name: string;
	provider: KnownProvider;
	model: Model<"anthropic-messages">;
	apiKey: string | undefined;
}

export interface CapturedAnthropicRequest {
	headers: IncomingHttpHeaders;
	body: Record<string, unknown>;
}
