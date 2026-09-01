/**
 * Custom Footer Extension - demonstrates ctx.ui.setFooter()
 *
 * footerData exposes data not otherwise accessible:
 * - getGitBranch(): current git branch
 * - getExtensionStatuses(): texts from ctx.ui.setStatus()
 *
 * Token stats come from ctx.session/ctx.model (already accessible).
 */

import type { AssistantMessage } from "@fleetagent/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@fleetagent/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@fleetagent/pi-tui";

interface FooterUsage {
	input: number;
	output: number;
	cost: number;
}

function summarizeFooterUsage(entries: SessionEntry[]): FooterUsage {
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		input += message.usage.input;
		output += message.usage.output;
		cost += message.usage.cost.total;
	}
	return { input, output, cost };
}

function formatTokenCount(count: number): string {
	return count < 1000 ? `${count}` : `${(count / 1000).toFixed(1)}k`;
}

export default function (pi: ExtensionAPI) {
	let enabled = false;

	pi.registerCommand("footer", {
		description: "Toggle custom footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;

			if (enabled) {
				ctx.ui.setFooter((tui, theme, footerData) => {
					const unsub = footerData.onBranchChange(() => tui.requestRender());

					return {
						dispose: unsub,
						invalidate() {},
						render(width: number): string[] {
							const { input, output, cost } = summarizeFooterUsage(ctx.session.getBranch());

							// Get git branch (not otherwise accessible)
							const branch = footerData.getGitBranch();

							const left = theme.fg(
								"dim",
								`↑${formatTokenCount(input)} ↓${formatTokenCount(output)} $${cost.toFixed(3)}`,
							);
							const branchStr = branch ? ` (${branch})` : "";
							const right = theme.fg("dim", `${ctx.model?.id || "no-model"}${branchStr}`);

							const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
							return [truncateToWidth(left + pad + right, width)];
						},
					};
				});
				ctx.ui.notify("Custom footer enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Default footer restored", "info");
			}
		},
	});
}
