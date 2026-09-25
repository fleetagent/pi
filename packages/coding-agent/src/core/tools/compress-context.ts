import type { Static } from "typebox";
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { HOOK_EXECUTION_CUSTOM_TYPE } from "../hooks/types.ts";
import { STRUCTURED_RESPONSE_INTERNAL_CUSTOM_TYPE } from "../messages.ts";
import { getLatestCompactionEntry, projectSessionContextEntries } from "../session/context.ts";
import type { ReadonlySession } from "../session/session.ts";
import type { SessionEntry } from "../session/types.ts";
import { abortIf } from "./runtime.ts";

const schema = Type.Object(
	{
		startEntryId: Type.String({ description: "ID of the first message to replace" }),
		endEntryId: Type.Optional(
			Type.String({
				description:
					"Inclusive last message to replace; must precede the current user request. Omit to compress through the last eligible entry.",
			}),
		),
		summary: Type.String({ description: "Replacement context for the selected range" }),
	},
	{ additionalProperties: false },
);

export type CompressContextInput = Static<typeof schema>;
export interface PendingContextCompression {
	toolCallId: string;
	startEntryId: string;
	endEntryId?: string;
	summary: string;
	assistantEntryId: string;
}

function isContextEntry(entry: SessionEntry, compactionId: string | undefined, toolCallId: string): boolean {
	if (entry.type === "custom_message") {
		return (
			entry.customType !== STRUCTURED_RESPONSE_INTERNAL_CUSTOM_TYPE &&
			entry.customType !== HOOK_EXECUTION_CUSTOM_TYPE
		);
	}
	if (entry.type === "compaction") return entry.id === compactionId && entry.summary.length > 0;
	if (entry.type === "branch_summary") return true;
	if (entry.type !== "message") return false;
	const message = entry.message;
	if (message.role === "bashExecution") return !message.excludeFromContext;
	if (message.role === "custom") {
		return (
			message.customType !== STRUCTURED_RESPONSE_INTERNAL_CUSTOM_TYPE &&
			message.customType !== HOOK_EXECUTION_CUSTOM_TYPE
		);
	}
	if (message.role === "assistant") {
		return !message.content.some((block) => block.type === "toolCall" && block.id === toolCallId);
	}
	return true;
}

/** Collect entries in model-context order, excluding the currently executing tool call. */
export function getCompressibleEntries(session: ReadonlySession, toolCallId: string): SessionEntry[] {
	const path = session.getBranch();
	const compaction = getLatestCompactionEntry(path);
	return projectSessionContextEntries(path).filter((entry) => isContextEntry(entry, compaction?.id, toolCallId));
}

function hasUnmatchedToolCall(entries: SessionEntry[]): boolean {
	const pending = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "assistant") {
			for (const block of entry.message.content) {
				if (block.type === "toolCall") pending.add(block.id);
			}
		} else if (entry.message.role === "toolResult") {
			pending.delete(entry.message.toolCallId);
		}
	}
	return pending.size > 0;
}

function validateCompressionRange(entries: SessionEntry[], startEntryId: string, endEntryId?: string): void {
	const startIndex = entries.findIndex((entry) => entry.id === startEntryId);
	if (startIndex < 0) throw new Error("startEntryId must be a message in the current model context.");
	const endIndex = endEntryId ? entries.findIndex((entry) => entry.id === endEntryId) : entries.length - 1;
	if (endIndex < 0) throw new Error("endEntryId must be a message in the current model context.");
	if (endIndex < startIndex) throw new Error("endEntryId must not precede startEntryId.");
	const start = entries[startIndex];
	if (start.type === "message" && start.message.role === "toolResult") {
		throw new Error("Cannot start compression at a tool result; start at its assistant tool call instead.");
	}
	if (hasUnmatchedToolCall(entries.slice(0, startIndex))) {
		throw new Error("Cannot leave an unmatched tool call in the preserved prefix; start at its assistant message.");
	}
	if (endIndex - startIndex + 1 < 2)
		throw new Error("compress_context requires at least two messages in the selected range.");
	if (hasUnmatchedToolCall(entries.slice(startIndex, endIndex + 1))) {
		throw new Error("Cannot split a tool call from its result; include all results in the selected range.");
	}
}

/** Validate a detector suggestion against the live branch, returning a reason for a corrective retry. */
export function getSuggestedCompressionRangeError(
	session: ReadonlySession,
	startEntryId: string,
	endEntryId: string,
): string | undefined {
	try {
		validateCompressionRange(getCompressibleEntries(session, ""), startEntryId, endEntryId);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : "Invalid range.";
	}
}

/** Validate an advisory against the current branch before showing it to the primary agent. */
export function isValidSuggestedCompressionRange(
	session: ReadonlySession,
	startEntryId: string,
	endEntryId: string,
): boolean {
	return getSuggestedCompressionRangeError(session, startEntryId, endEntryId) === undefined;
}

export function createCompressContextToolDefinition(
	session: ReadonlySession,
	schedule: (request: PendingContextCompression) => void,
): ToolDefinition<typeof schema> {
	return {
		name: "compress_context",
		label: "compress_context",
		description:
			"Replace at least two messages from startEntryId through optional inclusive endEntryId with your own summary. endEntryId must be before the current user request; do not use the current user's ID from context metadata as the end. Omit endEntryId to compress through the last entry before that request. The earlier prefix, current request, tool call, result, and any later messages remain in order. Use a user or assistant tool-call entry ID from model-only context metadata for the start, not a tool-result ID.",
		promptSnippet: "Summarize a bounded range or the active session tail",
		promptGuidelines: [
			"Pass startEntryId and a non-empty summary; add endEntryId to retain later messages. Keep tool calls paired with their results and preserve important decisions.",
		],
		parameters: schema,
		executionMode: "sequential",
		async execute(toolCallId, { startEntryId, endEntryId, summary }: CompressContextInput, signal) {
			abortIf(signal);
			if (!startEntryId || !summary.trim()) {
				throw new Error("Provide startEntryId and a non-empty summary to compress.");
			}
			const assistant = session.getLeafEntry();
			const branch = session.getBranch();
			const isCurrentCall =
				assistant?.type === "message" &&
				assistant.message.role === "assistant" &&
				assistant.message.content.some((block) => block.type === "toolCall" && block.id === toolCallId);
			const triggerIndex = isCurrentCall
				? branch
						.slice(0, -1)
						.map((entry) => entry.type === "message" && entry.message.role === "user")
						.lastIndexOf(true)
				: -1;
			const eligibleIds = new Set(branch.slice(0, triggerIndex).map((entry) => entry.id));
			if (endEntryId && triggerIndex >= 0 && endEntryId === branch[triggerIndex]?.id) {
				throw new Error(
					"endEntryId is the current user request; omit endEntryId to compress through the last entry before it.",
				);
			}
			const entries = getCompressibleEntries(session, toolCallId).filter(
				(entry) => triggerIndex < 0 || eligibleIds.has(entry.id),
			);
			validateCompressionRange(entries, startEntryId, endEntryId);
			if (
				assistant?.type !== "message" ||
				assistant.message.role !== "assistant" ||
				assistant.message.content.filter((block) => block.type === "toolCall").length !== 1 ||
				!assistant.message.content.some((block) => block.type === "toolCall" && block.id === toolCallId)
			)
				throw new Error("compress_context must be the only tool call in its assistant message.");
			abortIf(signal);
			schedule({ toolCallId, startEntryId, endEntryId, summary: summary.trim(), assistantEntryId: assistant.id });
			return {
				content: [{ type: "text", text: "Compression complete. Continue with the current request." }],
				details: undefined,
			};
		},
	};
}
