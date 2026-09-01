/**
 * Q&A extraction extension - extracts questions from assistant responses
 *
 * Demonstrates the "prompt generator" pattern:
 * 1. /qna command gets the last assistant message
 * 2. Shows a spinner while extracting (hides editor)
 * 3. Loads the result into the editor for user to fill in answers
 */

import { complete, type StopReason, type TextContent, type UserMessage } from "@fleetagent/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@fleetagent/pi-coding-agent";
import { BorderedLoader } from "@fleetagent/pi-coding-agent";

const SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering and format them for the user to fill in.

Output format:
- List each question on its own line, prefixed with "Q: "
- After each question, add a blank line for the answer prefixed with "A: "
- If no questions are found, output "No questions found in the last message."

Example output:
Q: What is your preferred database?
A: 

Q: Should we use TypeScript or JavaScript?
A: 

Keep questions in the order they appeared. Be concise.`;

type AssistantTextLookup =
	| { status: "found"; text: string }
	| { status: "incomplete"; stopReason: StopReason }
	| { status: "missing" };

function findLastAssistantText(ctx: ExtensionContext): AssistantTextLookup {
	const branch = ctx.session.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!("role" in message) || message.role !== "assistant") continue;
		if (message.stopReason !== "stop") return { status: "incomplete", stopReason: message.stopReason };
		const textParts = message.content
			.filter((content): content is TextContent => content.type === "text")
			.map((content) => content.text);
		if (textParts.length > 0) return { status: "found", text: textParts.join("\n") };
	}
	return { status: "missing" };
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("qna", {
		description: "Extract questions from last assistant message into editor",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("qna requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const assistantText = findLastAssistantText(ctx);
			if (assistantText.status === "incomplete") {
				ctx.ui.notify(`Last assistant message incomplete (${assistantText.stopReason})`, "error");
				return;
			}
			if (assistantText.status === "missing" || !assistantText.text) {
				ctx.ui.notify("No assistant messages found", "error");
				return;
			}
			const lastAssistantText = assistantText.text;

			// Run extraction with loader UI
			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Extracting questions using ${ctx.model!.id}...`);
				loader.onAbort = () => done(null);

				// Do the work
				const doExtract = async () => {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
					if (!auth.ok || !auth.apiKey) {
						throw new Error(auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error);
					}
					const userMessage: UserMessage = {
						role: "user",
						content: [{ type: "text", text: lastAssistantText! }],
						timestamp: Date.now(),
					};

					const response = await complete(
						ctx.model!,
						{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
						{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
					);

					if (response.stopReason === "aborted") {
						return null;
					}

					return response.content
						.filter((c): c is TextContent => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				};

				doExtract()
					.then(done)
					.catch(() => done(null));

				return loader;
			});

			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			ctx.ui.setEditorText(result);
			ctx.ui.notify("Questions loaded. Edit and submit when ready.", "info");
		},
	});
}
