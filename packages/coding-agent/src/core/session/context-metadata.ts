import type { AgentMessage, CustomMessage } from "@fleetagent/pi-agent-core";
import { createCustomMessage } from "../messages.ts";
import type { SessionEntry, SessionMessageEntry } from "./types.ts";

function createMetadataNotice(content: string): CustomMessage {
	return createCustomMessage(
		"context_metadata",
		`[context metadata: ${content}]`,
		false,
		undefined,
		new Date().toISOString(),
	);
}

function findMessageEntryId(
	message: AgentMessage,
	entries: SessionMessageEntry[],
	identityIds: Map<AgentMessage, string>,
	usedIds: Set<string>,
): string | undefined {
	const id =
		identityIds.get(message) ??
		entries.find(
			(entry) =>
				!usedIds.has(entry.id) &&
				entry.message.role === message.role &&
				entry.message.timestamp === message.timestamp &&
				(message.role !== "toolResult" ||
					(entry.message.role === "toolResult" && entry.message.toolCallId === message.toolCallId)),
		)?.id;
	if (id) usedIds.add(id);
	return id;
}

interface ContextMessageIndex {
	entries: SessionMessageEntry[];
	identityIds: Map<AgentMessage, string>;
	assistantIds: Map<string, string>;
}

function indexBranchMessages(branch: SessionEntry[]): ContextMessageIndex {
	const entries = branch.filter((entry): entry is SessionMessageEntry => entry.type === "message");
	const identityIds = new Map<AgentMessage, string>();
	const assistantIds = new Map<string, string>();
	for (const entry of entries) {
		identityIds.set(entry.message, entry.id);
		if (entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type === "toolCall") assistantIds.set(block.id, entry.id);
		}
	}
	return { entries, identityIds, assistantIds };
}

/** Model-only notices are placed after complete tool-result batches to preserve provider tool-call ordering. */
export function annotateContextMetadata(messages: AgentMessage[], branch: SessionEntry[]): AgentMessage[] {
	const { entries, identityIds, assistantIds } = indexBranchMessages(branch);
	const usedIds = new Set<string>();
	const annotated: AgentMessage[] = [];
	const toolNotices: string[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		annotated.push(message);
		const entryId = findMessageEntryId(message, entries, identityIds, usedIds);
		if (message.role === "user" && entryId) {
			annotated.push(createMetadataNotice(`user entry ${entryId};`));
		} else if (message.role === "toolResult" && entryId) {
			const assistantId = assistantIds.get(message.toolCallId);
			toolNotices.push(`${message.toolName}: assistant entry ${assistantId ?? "?"}, result entry ${entryId}`);
		}
		if (toolNotices.length > 0 && messages[index + 1]?.role !== "toolResult") {
			annotated.push(createMetadataNotice(toolNotices.join("; ")));
			toolNotices.length = 0;
		}
	}
	return annotated;
}
