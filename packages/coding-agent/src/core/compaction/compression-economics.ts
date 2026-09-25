import type { Api, Model } from "@fleetagent/pi-ai";
import { sessionEntryToContextMessages } from "../session/context.ts";
import type { SessionEntry } from "../session/types.ts";
import { estimateTokens } from "./compaction.ts";

export const COMPRESSION_ECONOMICS_ENTRY_TYPE = "compression_economics";
export const COMPRESSION_SAVINGS_SNAPSHOT_TYPE = "compression_savings_snapshot";

/** Approximate context and catalog-price assumptions, not provider-reported savings. */
export interface CompressionEconomicsRecord {
	version: 1;
	summaryEntryId: string;
	provider: string;
	modelId: string;
	sourceTokens: number;
	summaryTokens: number;
	removedTokens: number;
	readRate: number;
	oneTimeCost: number | null;
	breakEvenRequests: number | null;
}

interface CompressionRangeTokenCounts {
	source: number;
	suffix: number;
}

function estimateRangeTokenCounts(entries: SessionEntry[], start: number, end: number): CompressionRangeTokenCounts {
	let source = 0;
	let suffix = 0;
	for (const [index, entry] of entries.entries()) {
		for (const message of sessionEntryToContextMessages(entry)) {
			const tokens = estimateTokens(message);
			if (index >= start && index <= end) source += tokens;
			else if (index > end) suffix += tokens;
		}
	}
	return { source, suffix };
}

export function estimateCompressionEconomics(
	entries: SessionEntry[],
	startEntryId: string,
	endEntryId: string,
	model: Model<Api>,
	summary?: string,
	usingSubscription = false,
): Omit<CompressionEconomicsRecord, "version" | "summaryEntryId"> | undefined {
	const start = entries.findIndex((entry) => entry.id === startEntryId);
	const end = entries.findIndex((entry) => entry.id === endEntryId);
	if (start < 0 || end < start) return undefined;
	const { source: sourceTokens, suffix: suffixTokens } = estimateRangeTokenCounts(entries, start, end);
	const summaryTokens = summary === undefined ? Math.ceil(sourceTokens / 4) : Math.ceil(summary.length / 4);
	const removedTokens = Math.max(0, sourceTokens - summaryTokens);
	const readRate = usingSubscription ? 0 : model.cost.cacheRead > 0 ? model.cost.cacheRead : model.cost.input;
	// For automatic caching, a miss is ordinary input, not a separately reported cache write.
	// Only the suffix after the changed range may lose its cached prefix; the earlier prefix is unchanged.
	const oneTimeCost =
		!usingSubscription && model.cost.input > 0 && model.cost.output > 0
			? (summaryTokens * (model.cost.input + model.cost.output) +
					suffixTokens * Math.max(0, model.cost.input - readRate)) /
				1_000_000
			: null;
	const savingPerRequest = (removedTokens * readRate) / 1_000_000;
	return {
		provider: model.provider,
		modelId: model.id,
		sourceTokens,
		summaryTokens,
		removedTokens,
		readRate,
		oneTimeCost,
		breakEvenRequests: oneTimeCost != null && savingPerRequest > 0 ? Math.ceil(oneTimeCost / savingPerRequest) : null,
	};
}

function isEconomicsRecord(data: unknown): data is CompressionEconomicsRecord {
	if (!data || typeof data !== "object") return false;
	const record = data as Partial<CompressionEconomicsRecord>;
	return (
		record.version === 1 &&
		typeof record.summaryEntryId === "string" &&
		typeof record.provider === "string" &&
		typeof record.modelId === "string" &&
		typeof record.removedTokens === "number" &&
		Number.isFinite(record.removedTokens) &&
		record.removedTokens >= 0 &&
		typeof record.readRate === "number" &&
		Number.isFinite(record.readRate) &&
		record.readRate >= 0 &&
		(record.oneTimeCost === null || (typeof record.oneTimeCost === "number" && Number.isFinite(record.oneTimeCost)))
	);
}

interface ActiveSaving {
	summaryEntryId: string;
	provider: string;
	modelId: string;
	removedTokens: number;
	readRate: number;
}

/** Captures accrued estimates before replacing their ledger entries on an archived branch. */
export interface CompressionSavingsSnapshot {
	version: 1;
	totalRemovedTokens: number;
	liveRemovedTokens: number;
	avoidedCost: number;
	oneTimeCost: number;
	pricedRequests: number;
	activeSavings: ActiveSaving[];
}

function isSavingsSnapshot(data: unknown): data is CompressionSavingsSnapshot {
	if (!data || typeof data !== "object") return false;
	const snapshot = data as Partial<CompressionSavingsSnapshot>;
	return (
		snapshot.version === 1 &&
		Number.isFinite(snapshot.totalRemovedTokens) &&
		Number.isFinite(snapshot.liveRemovedTokens) &&
		Number.isFinite(snapshot.avoidedCost) &&
		Number.isFinite(snapshot.oneTimeCost) &&
		Number.isFinite(snapshot.pricedRequests) &&
		Array.isArray(snapshot.activeSavings) &&
		snapshot.activeSavings.every(
			(saving: unknown) =>
				!!saving &&
				typeof saving === "object" &&
				typeof (saving as ActiveSaving).summaryEntryId === "string" &&
				typeof (saving as ActiveSaving).provider === "string" &&
				typeof (saving as ActiveSaving).modelId === "string" &&
				Number.isFinite((saving as ActiveSaving).removedTokens) &&
				Number.isFinite((saving as ActiveSaving).readRate),
		)
	);
}

export interface CompressionSavingsEstimate {
	totalRemovedTokens: number;
	liveRemovedTokens: number;
	avoidedCost: number;
	oneTimeCost: number;
	netAvoidedCost: number;
	remainingToBreakEven: number;
	pricedRequests: number;
}
export interface CompressionCatchUpEstimate {
	cachedTurns: number | null;
	newInputTurns: number | null;
}

/** Approximate future requests to recover outstanding compression cost at two input-price scenarios. */
export function estimateCompressionCatchUp(
	branch: SessionEntry[],
	model: Model<Api>,
	usingSubscription: boolean,
): CompressionCatchUpEstimate {
	const state = createCompressionSavingsSnapshot(branch);
	const remaining = Math.max(0, state.oneTimeCost - state.avoidedCost);
	const tokens = state.activeSavings.reduce(
		(total, saving) =>
			total + (saving.provider === model.provider && saving.modelId === model.id ? saving.removedTokens : 0),
		0,
	);
	if (usingSubscription || !remaining || !tokens) return { cachedTurns: null, newInputTurns: null };
	return {
		cachedTurns:
			model.cost.cacheRead > 0 ? Math.ceil((remaining * 1_000_000) / (tokens * model.cost.cacheRead)) : null,
		newInputTurns: model.cost.input > 0 ? Math.ceil((remaining * 1_000_000) / (tokens * model.cost.input)) : null,
	};
}

/** Replay persisted estimates in branch order, without counting archived or replayed provider calls twice. */
export function estimateCompressionSavings(branch: SessionEntry[]): CompressionSavingsEstimate {
	const { activeSavings: _activeSavings, version: _version, ...totals } = createCompressionSavingsSnapshot(branch);
	return {
		...totals,
		netAvoidedCost: Math.max(0, totals.avoidedCost - totals.oneTimeCost),
		remainingToBreakEven: Math.max(0, totals.oneTimeCost - totals.avoidedCost),
	};
}

function creditAssistantRequest(state: CompressionSavingsSnapshot, provider: string, modelId: string): void {
	let saved = 0;
	for (const saving of state.activeSavings) {
		if (provider === saving.provider && modelId === saving.modelId)
			saved += (saving.removedTokens * saving.readRate) / 1_000_000;
	}
	if (saved > 0) {
		state.pricedRequests++;
		state.avoidedCost += saved;
	}
}

function applyEconomicsRecord(state: CompressionSavingsSnapshot, data: unknown): void {
	if (!isEconomicsRecord(data)) return;
	const { summaryEntryId, provider, modelId, removedTokens, readRate, oneTimeCost } = data;
	state.totalRemovedTokens += removedTokens;
	state.liveRemovedTokens += removedTokens;
	state.oneTimeCost += oneTimeCost ?? 0;
	state.activeSavings.push({ summaryEntryId, provider, modelId, removedTokens, readRate });
}

export function createCompressionSavingsSnapshot(branch: SessionEntry[]): CompressionSavingsSnapshot {
	let state: CompressionSavingsSnapshot = {
		version: 1,
		totalRemovedTokens: 0,
		liveRemovedTokens: 0,
		avoidedCost: 0,
		oneTimeCost: 0,
		pricedRequests: 0,
		activeSavings: [],
	};
	for (const entry of branch) {
		if (entry.type === "compaction") {
			state.liveRemovedTokens = 0;
			state.activeSavings = [];
		} else if (entry.type === "custom" && entry.customType === COMPRESSION_SAVINGS_SNAPSHOT_TYPE) {
			if (isSavingsSnapshot(entry.data)) state = { ...entry.data, activeSavings: [...entry.data.activeSavings] };
		} else if (entry.type === "custom" && entry.customType === COMPRESSION_ECONOMICS_ENTRY_TYPE) {
			applyEconomicsRecord(state, entry.data);
		} else if (entry.type === "message" && entry.message.role === "assistant" && !entry.replayedFromId) {
			creditAssistantRequest(state, entry.message.provider, entry.message.model);
		}
	}
	return state;
}
