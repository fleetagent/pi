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
	if (!byId) {
		byId = new Map<string, SessionEntry>();
		for (const entry of entries) {
			byId.set(entry.id, entry);
		}
	}

	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		return { messages: [], thinkingLevel: "off", model: null };
	}
	if (leafId) {
		leaf = byId.get(leafId);
	}
	if (!leaf) {
		leaf = entries[entries.length - 1];
	}

	if (!leaf) {
		return { messages: [], thinkingLevel: "off", model: null };
	}

	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.unshift(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}

	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;
	let compaction: CompactionEntry | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		} else if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	const messages: AgentMessage[] = [];

	const appendMessages = (entry: SessionEntry) => {
		// The active compaction summary is inserted explicitly below. Older compaction
		// entries in the retained path must not become additional context summaries.
		if (entry.type !== "compaction") {
			messages.push(...sessionEntryToContextMessages(entry));
		}
	};

	if (compaction) {
		messages.push(createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp));

		const compactionIdx = path.findIndex((entry) => entry.type === "compaction" && entry.id === compaction.id);

		let foundFirstKept = false;
		for (let i = 0; i < compactionIdx; i++) {
			const entry = path[i];
			if (entry.id === compaction.firstKeptEntryId) {
				foundFirstKept = true;
			}
			if (foundFirstKept) {
				appendMessages(entry);
			}
		}

		for (let i = compactionIdx + 1; i < path.length; i++) {
			appendMessages(path[i]);
		}
	} else {
		for (const entry of path) {
			appendMessages(entry);
		}
	}

	return { messages, thinkingLevel, model };
}
