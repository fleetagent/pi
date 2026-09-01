import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@fleetagent/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { theme } from "../theme/theme.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}
interface FooterUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	private collectUsageTotals(): FooterUsageTotals {
		const totals: FooterUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		for (const entry of this.session.session.getEntries()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			totals.input += entry.message.usage.input;
			totals.output += entry.message.usage.output;
			totals.cacheRead += entry.message.usage.cacheRead;
			totals.cacheWrite += entry.message.usage.cacheWrite;
			totals.cost += entry.message.usage.cost.total;
		}
		return totals;
	}

	private formatLocation(): string {
		let location = formatCwdForFooter(this.session.session.getCwd(), process.env.HOME || process.env.USERPROFILE);
		const branch = this.footerData.getGitBranch();
		if (branch) location = `${location} (${branch})`;
		const sessionName = this.session.session.getSessionName();
		if (sessionName) location = `${location} • ${sessionName}`;
		return location;
	}

	private formatContextUsage(contextWindow: number, contextPercentValue: number, contextPercent: string): string {
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const display =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) return theme.fg("error", display);
		if (contextPercentValue > 70) return theme.fg("warning", display);
		return display;
	}

	private formatUsageSummary(
		totals: FooterUsageTotals,
		contextWindow: number,
		contextPercentValue: number,
		contextPercent: string,
	): string {
		const parts: string[] = [];
		if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
		if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
		if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
		if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
		const state = this.session.state;
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		if (totals.cost || usingSubscription) {
			parts.push(`$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
		}
		parts.push(this.formatContextUsage(contextWindow, contextPercentValue, contextPercent));
		return parts.join(" ");
	}

	private formatModelSummary(statsWidth: number, width: number): string {
		const state = this.session.state;
		const modelName = state.model?.id || "no-model";
		let summary = modelName;
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			summary = thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
		}
		if (this.footerData.getAvailableProviderCount() <= 1 || !state.model) return summary;
		const providerSummary = `(${state.model.provider}) ${summary}`;
		return statsWidth + 2 + visibleWidth(providerSummary) <= width ? providerSummary : summary;
	}

	private layoutStatsLine(stats: string, modelSummary: string, width: number): string {
		const statsWidth = visibleWidth(stats);
		const modelWidth = visibleWidth(modelSummary);
		const minPadding = 2;
		if (statsWidth + minPadding + modelWidth <= width) {
			return stats + " ".repeat(width - statsWidth - modelWidth) + modelSummary;
		}
		const availableForModel = width - statsWidth - minPadding;
		if (availableForModel <= 0) return stats;
		const truncatedModel = truncateToWidth(modelSummary, availableForModel, "");
		const padding = " ".repeat(Math.max(0, width - statsWidth - visibleWidth(truncatedModel)));
		return stats + padding + truncatedModel;
	}

	private formatExtensionStatuses(width: number): string | undefined {
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size === 0) return undefined;
		const statusLine = Array.from(extensionStatuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text))
			.join(" ");
		return truncateToWidth(statusLine, width, theme.fg("dim", "..."));
	}

	render(width: number): string[] {
		const state = this.session.state;
		const totals = this.collectUsageTotals();
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
		const locationText = this.formatLocation();

		let stats = this.formatUsageSummary(totals, contextWindow, contextPercentValue, contextPercent);
		if (visibleWidth(stats) > width) stats = truncateToWidth(stats, width, "...");
		const modelSummary = this.formatModelSummary(visibleWidth(stats), width);
		const statsLine = this.layoutStatsLine(stats, modelSummary, width);

		// Dim the stats and the remaining padding/model separately because a colored context value resets styling.
		const dimmedStats = theme.fg("dim", stats);
		const dimmedRemainder = theme.fg("dim", statsLine.slice(stats.length));
		const location = truncateToWidth(theme.fg("dim", locationText), width, theme.fg("dim", "..."));
		const lines = [location, dimmedStats + dimmedRemainder];

		const extensionStatuses = this.formatExtensionStatuses(width);
		if (extensionStatuses !== undefined) lines.push(extensionStatuses);
		return lines;
	}
}
