/**
 * Auto-Commit on Exit Extension
 *
 * Automatically commits changes when the agent exits.
 * Uses the last assistant message to generate a commit message.
 */

import type { ExtensionAPI, SessionEntry } from "@fleetagent/pi-coding-agent";

function findLastAssistantText(entries: SessionEntry[]): string {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) return "";
		return content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", async (_event, ctx) => {
		// Check for uncommitted changes
		const { stdout: status, code } = await pi.exec("git", ["status", "--porcelain"]);

		if (code !== 0 || status.trim().length === 0) {
			// Not a git repo or no changes
			return;
		}

		// Find the last assistant message for commit context
		const lastAssistantText = findLastAssistantText(ctx.session.getEntries());

		// Generate a simple commit message
		const firstLine = lastAssistantText.split("\n")[0] || "Work in progress";
		const commitMessage = `[pi] ${firstLine.slice(0, 50)}${firstLine.length > 50 ? "..." : ""}`;

		// Stage and commit
		await pi.exec("git", ["add", "-A"]);
		const { code: commitCode } = await pi.exec("git", ["commit", "-m", commitMessage]);

		if (commitCode === 0 && ctx.hasUI) {
			ctx.ui.notify(`Auto-committed: ${commitMessage}`, "info");
		}
	});
}
