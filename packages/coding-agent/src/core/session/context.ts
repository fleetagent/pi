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
	if (entry.type === "compaction") {
		return [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp)];
	}
	return [];
}

// pi-ignore noNearIdenticalDataStructures: Coding-agent persisted entries and agent harness storage entries use package-owned context pipelines that evolve independently.
interface SessionPathState {
	thinkingLevel: string;
	model: SessionContext["model"];
	compaction: CompactionEntry | null;
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
	let compaction: CompactionEntry | null = null;
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
			case "compaction":
				compaction = entry;
		}
	}
	return { thinkingLevel, model, compaction };
}

function appendSessionContextMessages(
	messages: AgentMessage[],
	path: SessionEntry[],
	startIndex: number,
	endIndex: number,
): void {
	for (let index = startIndex; index < endIndex; index++) {
		const entry = path[index];
		// The active compaction summary is inserted explicitly. Older compaction
		// entries in the retained path must not become additional context summaries.
		if (entry.type !== "compaction") messages.push(...sessionEntryToContextMessages(entry));
	}
}

function buildSessionContextMessages(path: SessionEntry[], compaction: CompactionEntry | null): AgentMessage[] {
	const messages: AgentMessage[] = [];
	if (!compaction) {
		appendSessionContextMessages(messages, path, 0, path.length);
		return messages;
	}

	messages.push(createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp));
	const compactionIndex = path.findIndex((entry) => entry.type === "compaction" && entry.id === compaction.id);
	const firstKeptIndex = path.findIndex(
		(entry, index) => index < compactionIndex && entry.id === compaction.firstKeptEntryId,
	);
	if (firstKeptIndex >= 0) appendSessionContextMessages(messages, path, firstKeptIndex, compactionIndex);
	appendSessionContextMessages(messages, path, compactionIndex + 1, path.length);
	return messages;
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
	const { thinkingLevel, model, compaction } = inspectSessionPath(path);
	return { messages: buildSessionContextMessages(path, compaction), thinkingLevel, model };
}
