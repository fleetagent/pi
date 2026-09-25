import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@fleetagent/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import {
	estimateCompressionCatchUp,
	estimateCompressionSavings,
} from "../../../core/compaction/compression-economics.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { readUsageLedger, type UsageLedger } from "../../../core/session/usage-ledger.ts";
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

	private formatLocation(): string {
		let location = formatCwdForFooter(this.session.session.getCwd(), process.env.HOME || process.env.USERPROFILE);
		const branch = this.footerData.getGitBranch();
		if (branch) location = `${location} (${branch})`;
		const sessionName = this.session.session.getSessionName();
		if (sessionName) location = `${location} • ${sessionName}`;
		return location;
	}

	private formatContextUsage(
		contextWindow: number,
		contextTokens: number | null,
		contextPercentValue: number,
		contextPercent: string,
	): string {
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const display =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `ctx ~${formatTokens(contextTokens ?? (contextPercentValue * contextWindow) / 100)}/${formatTokens(contextWindow)} (${contextPercent}%)${autoIndicator}`;
		if (contextPercentValue > 90) return theme.fg("error", display);
		if (contextPercentValue > 70) return theme.fg("warning", display);
		return display;
	}

	private formatCompressionSavings(): string[] {
		const branch = this.session.session.getBranch();
		const savings = estimateCompressionSavings(branch);
		const parts: string[] = [];
		if (savings.totalRemovedTokens) parts.push(`~${formatTokens(savings.totalRemovedTokens)} fewer cumulative`);
		if (savings.oneTimeCost > 0 && savings.remainingToBreakEven > 0) {
			parts.push(`(est $${savings.remainingToBreakEven.toFixed(4)} to break even)`);
			const model = this.session.state.model;
			if (model) {
				const catchUp = estimateCompressionCatchUp(branch, model, this.session.modelRegistry.isUsingOAuth(model));
				if (catchUp.cachedTurns != null || catchUp.newInputTurns != null)
					parts.push(`(cache ~${catchUp.cachedTurns ?? "?"}/new ~${catchUp.newInputTurns ?? "?"} turns)`);
			}
		} else if (savings.netAvoidedCost > 0) parts.push(`(est $${savings.netAvoidedCost.toFixed(4)} net avoided)`);
		return parts;
	}

	private countSessionCompressions(): number {
		// Replayed summaries retain their original fromId, so count each completed operation once across all branches.
		const compressions = new Set<string>();
		for (const entry of this.session.session.getEntries()) {
			if (entry.type !== "custom_message" || entry.customType !== "compress_context") continue;
			const details = entry.details;
			const fromId = details && typeof details === "object" && "fromId" in details ? details.fromId : undefined;
			compressions.add(typeof fromId === "string" ? fromId : entry.id);
		}
		return compressions.size;
	}

	private formatUsageSummary(
		totals: UsageLedger,
		contextWindow: number,
		contextTokens: number | null,
		contextPercentValue: number,
		contextPercent: string,
	): string {
		const parts: string[] = [
			this.formatContextUsage(contextWindow, contextTokens, contextPercentValue, contextPercent),
		];
		if (totals.requests) parts.push("total");
		if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
		if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
		if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
		if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
		const state = this.session.state;
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		const counts = this.session.getCompressionDetectionCounts();
		const compressionCount = this.countSessionCompressions();
		const detectionCost = this.session.getCompressionDetectionCost();
		const showDetection = !!(
			this.session.settingsManager.getCompressionDetectionModel() ||
			counts.keep ||
			counts.compress ||
			detectionCost
		);
		if (totals.requests) {
			parts.push(
				usingSubscription
					? `catalog $${totals.catalogCost.toFixed(3)} (sub)`
					: `catalog $${totals.catalogCost.toFixed(3)}`,
			);
		} else if (usingSubscription) parts.push("sub");
		if (showDetection) parts.push(`(detect est $${detectionCost.toFixed(4)} total)`);
		if (showDetection || compressionCount) parts.push(`D${counts.keep}/${counts.compress} C${compressionCount}`);
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
		const totals = readUsageLedger(this.session.session.getEntries());
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent != null ? contextPercentValue.toFixed(1) : "?";
		const locationText = this.formatLocation();

		let stats = this.formatUsageSummary(
			totals,
			contextWindow,
			contextUsage?.tokens ?? null,
			contextPercentValue,
			contextPercent,
		);
		if (visibleWidth(stats) > width) stats = truncateToWidth(stats, width, "...");
		const modelSummary = this.formatModelSummary(visibleWidth(stats), width);
		const statsLine = this.layoutStatsLine(stats, modelSummary, width);

		// Dim the stats and the remaining padding/model separately because a colored context value resets styling.
		const dimmedStats = theme.fg("dim", stats);
		const dimmedRemainder = theme.fg("dim", statsLine.slice(stats.length));
		const location = truncateToWidth(theme.fg("dim", locationText), width, theme.fg("dim", "..."));
		const lines = [location, dimmedStats + dimmedRemainder];
		const savings = this.formatCompressionSavings().join(" ");
		if (savings) lines.push(theme.fg("dim", truncateToWidth(savings, width, "...")));
		const extensionStatuses = this.formatExtensionStatuses(width);
		if (extensionStatuses !== undefined) lines.push(extensionStatuses);
		return lines;
	}
}
