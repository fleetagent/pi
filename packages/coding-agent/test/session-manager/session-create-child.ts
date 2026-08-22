import type { Message } from "@fleetagent/pi-ai";
import { LocalSessionManager } from "../../src/core/session/local-session-manager.ts";
import { SessionAlreadyExistsError } from "../../src/core/session/stores/jsonl-session-store.ts";

const [sessionDir, cwd, id] = process.argv.slice(2);
if (!sessionDir || !cwd || !id) throw new Error("Expected sessionDir, cwd, and id arguments");

const assistant: Message = {
	role: "assistant",
	content: [{ type: "text", text: "child" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "test",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 2,
};

try {
	const session = new LocalSessionManager({ cwd, sessionDir }).create({ id });
	session.appendMessage({ role: "user", content: "child", timestamp: 1 });
	session.appendMessage(assistant);
	process.stdout.write("created");
} catch (error) {
	if (error instanceof SessionAlreadyExistsError) {
		process.stdout.write(error.code);
	} else {
		throw error;
	}
}
