import type { Api, Model } from "../types.ts";

/** Only direct Anthropic Fable 5.1 has the verified binding-control contract. */
export function isAnthropicFable51(model: Model<Api>): boolean {
	return model.provider === "anthropic" && model.api === "anthropic-messages" && model.id === "claude-fable-5-1";
}
