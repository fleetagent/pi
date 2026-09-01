/**
 * Branch summarization for tree navigation.
 *
 * When navigating to a different point in the session tree, this generates
 * a summary of the branch being left so context isn't lost.
 */

import type {
	BranchPreparation as AgentBranchPreparation,
	BranchSummaryDetails as AgentBranchSummaryDetails,
	AgentMessage,
	FileOperations,
	StreamFn,
} from "@fleetagent/pi-agent-core";
import type {
	Model,
	ProviderHeaders,
	RetryCallbacks,
	RetryPolicy,
	SimpleStreamOptions,
	TextContent,
} from "@fleetagent/pi-ai";
import { convertToLlm } from "../messages.ts";
import { sessionEntryToContextMessages } from "../session/context.ts";
import type { ReadonlySession } from "../session/session.ts";
import type { SessionEntry } from "../session/types.ts";
import { completeSummarization, estimateTokens } from "./compaction.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

// ============================================================================
// Types
// ============================================================================

export interface BranchSummaryResult {
	summary?: string;
	readFiles?: string[];
	modifiedFiles?: string[];
	aborted?: boolean;
	error?: string;
}

/** Details stored in BranchSummaryEntry.details for file tracking. */
export type BranchSummaryDetails = AgentBranchSummaryDetails;

/** Messages, file operations, and token count prepared for branch summarization. */
export type BranchPreparation = AgentBranchPreparation;

export interface CollectEntriesResult {
	/** Entries to summarize, in chronological order */
	entries: SessionEntry[];
	/** Common ancestor between old and new position, if any */
	commonAncestorId: string | null;
}

export interface GenerateBranchSummaryOptions {
	/** Model to use for summarization */
	model: Model<any>;
	/** API key for the model */
	apiKey?: string;
	/** Request headers for the model */
	headers?: ProviderHeaders;
	/** Abort signal for cancellation */
	signal: AbortSignal;
	/** Optional custom instructions for summarization */
	customInstructions?: string;
	/** If true, customInstructions replaces the default prompt instead of being appended */
	replaceInstructions?: boolean;
	/** Tokens reserved for prompt + LLM response (default 16384) */
	reserveTokens?: number;
	/** Session stream function, preserving custom provider behavior without Agent state/events. */
	streamFn?: StreamFn;
	/** Retry transient summary failures using the session retry policy. */
	retry?: RetryPolicy;
	callbacks?: RetryCallbacks;
}

// ============================================================================
// Entry Collection
// ============================================================================

/**
 * Collect entries that should be summarized when navigating from one position to another.
 *
 * Walks from oldLeafId back to the common ancestor with targetId, collecting entries
 * along the way. Does NOT stop at compaction boundaries - those are included and their
 * summaries become context.
 *
 * @param session - Session manager (read-only access)
 * @param oldLeafId - Current position (where we're navigating from)
 * @param targetId - Target position (where we're navigating to)
 * @returns Entries to summarize and the common ancestor
 */
export function collectEntriesForBranchSummary(
	session: ReadonlySession,
	oldLeafId: string | null,
	targetId: string,
): CollectEntriesResult {
	// If no old position, nothing to summarize
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	// Find common ancestor (deepest node that's on both paths)
	const oldPath = new Set(session.getBranch(oldLeafId).map((e) => e.id));
	const targetPath = session.getBranch(targetId);

	// targetPath is root-first, so iterate backwards to find deepest common ancestor
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}

	// Collect entries from old leaf back to common ancestor
	const entries: SessionEntry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		const entry = session.getEntry(current);
		if (!entry) break;
		entries.push(entry);
		current = entry.parentId;
	}

	// Reverse to get chronological order
	entries.reverse();

	return { entries, commonAncestorId };
}

// ============================================================================
// Entry to Message Conversion
// ============================================================================

/** Project an entry into messages visible to the summary provider. */
function getVisibleContextMessages(entry: SessionEntry): AgentMessage[] {
	return sessionEntryToContextMessages(entry).filter((message) => convertToLlm([message]).length > 0);
}
interface BranchMessageSelection {
	messages: AgentMessage[];
	totalTokens: number;
}

function collectCumulativeFileOperations(entries: SessionEntry[], fileOps: FileOperations): void {
	for (const entry of entries) {
		if (entry.type !== "branch_summary" || entry.fromHook || !entry.details) continue;
		const details = entry.details as BranchSummaryDetails;
		if (Array.isArray(details.readFiles)) {
			for (const filePath of details.readFiles) fileOps.read.add(filePath);
		}
		if (Array.isArray(details.modifiedFiles)) {
			for (const filePath of details.modifiedFiles) fileOps.edited.add(filePath);
		}
	}
}

function selectBranchMessages(
	entries: SessionEntry[],
	tokenBudget: number,
	fileOps: FileOperations,
): BranchMessageSelection {
	const messages: AgentMessage[] = [];
	let totalTokens = 0;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		const entryMessages = getVisibleContextMessages(entry);
		if (entryMessages.length === 0) continue;
		for (const message of entryMessages) extractFileOpsFromMessage(message, fileOps);
		const tokens = entryMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			const isExistingSummary = entry.type === "compaction" || entry.type === "branch_summary";
			if (isExistingSummary && totalTokens < tokenBudget * 0.9) {
				messages.unshift(...entryMessages);
				totalTokens += tokens;
			}
			break;
		}
		messages.unshift(...entryMessages);
		totalTokens += tokens;
	}
	return { messages, totalTokens };
}
/**
 * Prepare entries for summarization with token budget.
 *
 * Walks entries from NEWEST to OLDEST, adding messages until we hit the token budget.
 * This ensures we keep the most recent context when the branch is too long.
 *
 * Also collects file operations from:
 * - Tool calls in assistant messages
 * - Existing branch_summary entries' details (for cumulative tracking)
 *
 * @param entries - Entries in chronological order
 * @param tokenBudget - Maximum tokens to include (0 = no limit)
 */
export function prepareBranchEntries(entries: SessionEntry[], tokenBudget: number = 0): BranchPreparation {
	const fileOps = createFileOps();
	collectCumulativeFileOperations(entries, fileOps);
	const { messages, totalTokens } = selectBranchMessages(entries, tokenBudget, fileOps);
	return { messages, fileOps, totalTokens };
}

// ============================================================================
// Summary Generation
// ============================================================================

const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * Generate a summary of abandoned branch entries.
 *
 * @param entries - Session entries to summarize (chronological order)
 * @param options - Generation options
 */
export async function generateBranchSummary(
	entries: SessionEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
	const {
		model,
		apiKey,
		headers,
		signal,
		customInstructions,
		replaceInstructions,
		reserveTokens = 16384,
		streamFn,
		retry,
		callbacks,
	} = options;

	// Token budget = context window minus reserved space for prompt + response
	const contextWindow = model.contextWindow || 128000;
	const tokenBudget = contextWindow - reserveTokens;

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	if (messages.length === 0) {
		return { summary: "No content to summarize" };
	}

	// Transform to LLM-compatible messages, then serialize to text
	// Serialization prevents the model from treating it as a conversation to continue
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);

	// Build prompt
	let instructions: string;
	if (replaceInstructions && customInstructions) {
		instructions = customInstructions;
	} else if (customInstructions) {
		instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
	} else {
		instructions = BRANCH_SUMMARY_PROMPT;
	}
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	// Keep summary calls detached from Agent state/events while preserving the active stream implementation.
	const context = { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages };
	const requestOptions: SimpleStreamOptions = { apiKey, headers, signal, maxTokens: 2048 };
	const response = await completeSummarization(model, context, requestOptions, streamFn, retry, callbacks);

	// Check if aborted or errored
	if (response.stopReason === "aborted") {
		return { aborted: true };
	}
	if (response.stopReason === "error") {
		return { error: response.errorMessage || "Summarization failed" };
	}

	let summary = response.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	// Prepend preamble to provide context about the branch summary
	summary = BRANCH_SUMMARY_PREAMBLE + summary;

	// Compute file lists and append to summary
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return {
		summary: summary || "No summary generated",
		readFiles,
		modifiedFiles,
	};
}
