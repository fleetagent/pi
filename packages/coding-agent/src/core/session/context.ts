import type { AgentMessage } from "@fleetagent/pi-agent-core";
import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
	normalizeMessageContent,
} from "../messages.ts";
import type { CompactionEntry, SessionContext, SessionEntry } from "./types.ts";

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

/** Project one persisted session entry into runtime context messages. */
export function sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[] {
	if (entry.type === "message") {
		return [normalizeMessageContent(entry.message)];
	}
	if (entry.type === "custom_message") {
		return [createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp)];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
	}
	if (entry.type === "compaction" && entry.summary) {
		return [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp)];
	}
	return [];
}

// pi-ignore noNearIdenticalDataStructures: Coding-agent persisted entries and agent harness storage entries use package-owned context pipelines that evolve independently.
interface SessionPathState {
	thinkingLevel: string;
	model: SessionContext["model"];
}

function traceSessionPath(leaf: SessionEntry, byId: Map<string, SessionEntry>): SessionEntry[] {
	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.unshift(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return path;
}

function inspectSessionPath(path: SessionEntry[]): SessionPathState {
	let thinkingLevel = "off";
	let model: SessionContext["model"] = null;
	for (const entry of path) {
		switch (entry.type) {
			case "thinking_level_change":
				thinkingLevel = entry.thinkingLevel;
				break;
			case "model_change":
				model = { provider: entry.provider, modelId: entry.modelId };
				break;
			case "message":
				if (entry.message.role === "assistant") {
					model = { provider: entry.message.provider, modelId: entry.message.model };
				}
				break;
		}
	}
	return { thinkingLevel, model };
}
function applyCompressionReplacement(visible: SessionEntry[], entry: SessionEntry): boolean {
	if (entry.type !== "custom_message" || entry.customType !== "compress_context") return false;
	const details = entry.details;
	if (
		!details ||
		typeof details !== "object" ||
		!("replacementVersion" in details) ||
		details.replacementVersion !== 1
	)
		return false;
	const startEntryId = "startEntryId" in details ? details.startEntryId : undefined;
	const endEntryId = "endEntryId" in details ? details.endEntryId : undefined;
	if (typeof startEntryId !== "string" || typeof endEntryId !== "string") return false;
	const startIndex = visible.findIndex((candidate) => candidate.id === startEntryId);
	const endIndex = visible.findIndex((candidate) => candidate.id === endEntryId);
	if (startIndex < 0 || endIndex < startIndex) return false;
	visible.splice(startIndex, endIndex - startIndex + 1, entry);
	return true;
}

/** Return entries in model-visible order, applying append-only range replacements at their declared positions. */
export function projectSessionContextEntries(path: SessionEntry[]): SessionEntry[] {
	const compaction = getLatestCompactionEntry(path);
	const compactionIndex = compaction ? path.findIndex((entry) => entry.id === compaction.id) : -1;
	const firstKeptIndex = compaction
		? path.findIndex((entry, index) => index < compactionIndex && entry.id === compaction.firstKeptEntryId)
		: -1;
	const ordered = compaction
		? [
				compaction,
				...(firstKeptIndex < 0 ? [] : path.slice(firstKeptIndex, compactionIndex)),
				...path.slice(compactionIndex + 1),
			]
		: path;
	const visible: SessionEntry[] = [];
	for (const entry of ordered) {
		if (entry.type === "compaction" && entry.id !== compaction?.id) continue;
		if (applyCompressionReplacement(visible, entry)) continue;
		visible.push(entry);
	}
	return visible;
}

/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Handles compaction and branch summaries along the path.
 */
export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionContext {
	if (leafId === null) return { messages: [], thinkingLevel: "off", model: null };

	const entriesById = byId ?? new Map(entries.map((entry) => [entry.id, entry]));
	const requestedLeaf = leafId ? entriesById.get(leafId) : undefined;
	const leaf = requestedLeaf ?? entries[entries.length - 1];
	if (!leaf) return { messages: [], thinkingLevel: "off", model: null };

	const path = traceSessionPath(leaf, entriesById);
	const { thinkingLevel, model } = inspectSessionPath(path);
	const messages = projectSessionContextEntries(path).flatMap(sessionEntryToContextMessages);
	return { messages, thinkingLevel, model };
}
