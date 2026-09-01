/**
 * Inline Bash Extension - expands inline bash commands in user prompts.
 *
 * Start pi with this extension:
 *   pi -e ./examples/extensions/inline-bash.ts
 *
 * Then type prompts with inline bash:
 *   What's in !{pwd}?
 *   The current branch is !{git branch --show-current} and status: !{git status --short}
 *   My node version is !{node --version}
 *
 * The !{command} patterns are executed and replaced with their output before
 * the prompt is sent to the agent.
 *
 * Note: Regular !command syntax (whole-line bash) is preserved and works as before.
 */
import type { ExtensionAPI } from "@fleetagent/pi-coding-agent";

const INLINE_BASH_PATTERN = /!\{([^}]+)\}/g;
const INLINE_BASH_TIMEOUT_MS = 30000;

interface InlineBashMatch {
	full: string;
	command: string;
}

interface InlineBashExpansion {
	command: string;
	output: string;
	error?: string;
}

interface InlineBashExecution {
	text: string;
	expansions: InlineBashExpansion[];
}

function findInlineBashMatches(text: string): InlineBashMatch[] {
	INLINE_BASH_PATTERN.lastIndex = 0;
	const matches: InlineBashMatch[] = [];
	let match = INLINE_BASH_PATTERN.exec(text);
	while (match) {
		matches.push({ full: match[0], command: match[1] });
		match = INLINE_BASH_PATTERN.exec(text);
	}
	return matches;
}

async function executeInlineBashCommands(
	pi: ExtensionAPI,
	text: string,
	matches: InlineBashMatch[],
): Promise<InlineBashExecution> {
	let transformedText = text;
	const expansions: InlineBashExpansion[] = [];
	for (const { full, command } of matches) {
		try {
			const bashResult = await pi.exec("bash", ["-c", command], { timeout: INLINE_BASH_TIMEOUT_MS });
			const output = bashResult.stdout || bashResult.stderr || "";
			const trimmed = output.trim();
			if (bashResult.code !== 0 && bashResult.stderr) {
				expansions.push({ command, output: trimmed, error: `exit code ${bashResult.code}` });
			} else {
				expansions.push({ command, output: trimmed });
			}
			transformedText = transformedText.replace(full, trimmed);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			expansions.push({ command, output: "", error: errorMessage });
			transformedText = transformedText.replace(full, `[error: ${errorMessage}]`);
		}
	}
	return { text: transformedText, expansions };
}

function formatInlineBashExpansionSummary(expansions: InlineBashExpansion[]): string {
	return expansions
		.map((expansion) => {
			const status = expansion.error ? ` (${expansion.error})` : "";
			const preview = expansion.output.length > 50 ? `${expansion.output.slice(0, 50)}...` : expansion.output;
			return `!{${expansion.command}}${status} -> "${preview}"`;
		})
		.join("\n");
}
export default function (pi: ExtensionAPI) {
	pi.on("input", async (event, ctx) => {
		const text = event.text;
		// Preserve the existing whole-line !command behavior.
		if (text.trimStart().startsWith("!") && !text.trimStart().startsWith("!{")) {
			return { action: "continue" };
		}

		const matches = findInlineBashMatches(text);
		if (matches.length === 0) return { action: "continue" };

		const execution = await executeInlineBashCommands(pi, text, matches);
		if (ctx.hasUI && execution.expansions.length > 0) {
			const summary = formatInlineBashExpansionSummary(execution.expansions);
			ctx.ui.notify(`Expanded ${execution.expansions.length} inline command(s):\n${summary}`, "info");
		}

		return { action: "transform", text: execution.text, images: event.images };
	});
}
