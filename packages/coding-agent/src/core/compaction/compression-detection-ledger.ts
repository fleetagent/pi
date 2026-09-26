import { randomUUID } from "node:crypto";
import type { Session } from "../session/session.ts";
import type { SessionEntry } from "../session/types.ts";
import type { CompressionDetectionVerdict, CompressionRangeSuggestion } from "./compression-detector.ts";

export const COMPRESSION_DETECTION_ENTRY_TYPE = "compression_detection_event";

export interface CompressionDetectionVerdictEvent {
	kind: "verdict";
	model: string;
	verdict: CompressionDetectionVerdict;
	suggestion?: CompressionRangeSuggestion;
	/** Detector-rated priority for the next safe checkpoint (0–100), not confidence. */
	urgency?: number;
}

export type CompressionDetectionEvent =
	| { kind: "response"; model: string; stopReason: string; cost: number }
	| CompressionDetectionVerdictEvent;

interface DetectionEventMetadata {
	version: 1;
	eventId: string;
}

export type PersistedCompressionDetectionEvent = CompressionDetectionEvent & DetectionEventMetadata;

export interface CompressionDetectionLedger {
	cost: number;
	keep: number;
	compress: number;
	verdicts: (CompressionDetectionVerdictEvent & DetectionEventMetadata)[];
}

export function appendCompressionDetectionEvent(session: Session, event: CompressionDetectionEvent): void {
	session.appendCustomEntry(COMPRESSION_DETECTION_ENTRY_TYPE, { ...event, version: 1, eventId: randomUUID() });
}

function isDetectionEvent(value: unknown): value is PersistedCompressionDetectionEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Partial<PersistedCompressionDetectionEvent>;
	if (event.version !== 1 || typeof event.eventId !== "string" || !event.eventId || typeof event.model !== "string")
		return false;
	if (event.kind === "response")
		return (
			typeof event.stopReason === "string" &&
			typeof event.cost === "number" &&
			Number.isFinite(event.cost) &&
			event.cost >= 0
		);
	if (event.kind !== "verdict" || (event.verdict !== "COMPRESS" && event.verdict !== "CONTINUE")) return false;
	if (event.urgency !== undefined && (!Number.isInteger(event.urgency) || event.urgency < 0 || event.urgency > 100))
		return false;
	if (event.suggestion === undefined) return true;
	return (
		event.verdict === "COMPRESS" &&
		typeof event.suggestion?.startEntryId === "string" &&
		typeof event.suggestion.endEntryId === "string"
	);
}

/** Session-wide detector history, including archived branches, without counting replayed records twice. */
export function readCompressionDetectionLedger(entries: SessionEntry[]): CompressionDetectionLedger {
	const ledger: CompressionDetectionLedger = { cost: 0, keep: 0, compress: 0, verdicts: [] };
	const seen = new Set<string>();
	for (const entry of entries) {
		if (
			entry.type !== "custom" ||
			entry.customType !== COMPRESSION_DETECTION_ENTRY_TYPE ||
			!isDetectionEvent(entry.data)
		)
			continue;
		const event = entry.data;
		if (seen.has(event.eventId)) continue;
		seen.add(event.eventId);
		if (event.kind === "response") ledger.cost += event.cost;
		else {
			if (event.verdict === "COMPRESS") ledger.compress++;
			else ledger.keep++;
			ledger.verdicts.push(event);
		}
	}
	return ledger;
}
