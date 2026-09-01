/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import {
	type AgentMessage,
	type CompactionDetails,
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	type ContextUsageEstimate,
	type CutPointResult,
	type StreamFn,
	type ThinkingLevel,
	uuidv7,
} from "@fleetagent/pi-agent-core";
import type {
	AssistantMessage,
	AssistantUsageInfo,
	Context,
	ImageContent,
	Model,
	ProviderHeaders,
	RetryCallbacks,
	RetryPolicy,
	SimpleStreamOptions,
	TextContent,
	Usage,
} from "@fleetagent/pi-ai";
import { completeSimple, retryAssistantCall } from "@fleetagent/pi-ai";
import { convertToLlm } from "../messages.ts";
import { buildSessionContext, sessionEntryToContextMessages } from "../session/context.ts";
import type { CompactionEntry, SessionEntry } from "../session/types.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

export type {
	CompactionDetails,
	CompactionPreparation,
	CompactionResult,
	CompactionSettings,
	ContextUsageEstimate,
	CutPointResult,
} from "@fleetagent/pi-agent-core";

// ============================================================================
// File Operation Tracking
// ============================================================================

function getPreviousCompactionDetails(
	entries: SessionEntry[],
	prevCompactionIndex: number,
): CompactionDetails | undefined {
	if (prevCompactionIndex < 0) return undefined;
	const previousCompaction = entries[prevCompactionIndex] as CompactionEntry;
	// fromHook field is kept for session file compatibility.
	if (previousCompaction.fromHook || !previousCompaction.details) return undefined;
	return previousCompaction.details as CompactionDetails;
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	const previousDetails = getPreviousCompactionDetails(entries, prevCompactionIndex);
	if (Array.isArray(previousDetails?.readFiles)) {
		for (const file of previousDetails.readFiles) fileOps.read.add(file);
	}
	if (Array.isArray(previousDetails?.modifiedFiles)) {
		for (const file of previousDetails.modifiedFiles) fileOps.edited.add(file);
	}

	// Extract from tool calls in messages
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

// ============================================================================
// Message Extraction
// ============================================================================

/** Project an entry into messages that are visible to the provider context. */
function getVisibleContextMessages(entry: SessionEntry): AgentMessage[] {
	return sessionEntryToContextMessages(entry).filter((message) => convertToLlm([message]).length > 0);
}

function getMessagesFromEntryForCompaction(entry: SessionEntry): AgentMessage[] {
	if (entry.type === "compaction") {
		return [];
	}
	return getVisibleContextMessages(entry);
}

// ============================================================================
// Types
// ============================================================================

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

// ============================================================================
// Token calculation
// ============================================================================

/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted and error messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (
			assistantMsg.stopReason !== "aborted" &&
			assistantMsg.stopReason !== "error" &&
			assistantMsg.usage &&
			calculateContextTokens(assistantMsg.usage) > 0
		) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last non-aborted assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): AssistantUsageInfo | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ============================================================================
// Cut point detection
// ============================================================================

/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
function estimateContentChars(content: string | Array<TextContent | ImageContent>): number {
	if (typeof content === "string") return content.length;
	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) chars += block.text.length;
		if (block.type === "image") chars += 4800; // Approximate one image as 1200 tokens.
	}
	return chars;
}

export function estimateTokens(message: AgentMessage): number {
	// Runtime context can contain audit-only custom messages and excluded bash
	// executions. Token accounting follows what convertToLlm sends to providers.
	if (convertToLlm([message]).length === 0) return 0;

	let chars = 0;
	switch (message.role) {
		case "user":
		case "custom":
		case "toolResult":
			return Math.ceil(estimateContentChars(message.content ?? []) / 4);
		case "assistant":
			for (const block of message.content ?? []) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		case "bashExecution":
			return Math.ceil((message.command.length + message.output.length) / 4);
		case "branchSummary":
		case "compactionSummary":
			return Math.ceil(message.summary.length / 4);
	}
	return 0;
}

function isCutPointMessage(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "assistant":
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "toolResult":
			return false;
	}
	return false;
}

function isTurnStartMessage(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "assistant":
		case "toolResult":
			return false;
	}
	return false;
}

function isTurnStartEntry(entry: SessionEntry): boolean {
	if (entry.type === "compaction") return false;
	return getVisibleContextMessages(entry).some(isTurnStartMessage);
}

/** Find context-visible cut points without separating a tool result from its call. */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (entry.type !== "compaction" && getVisibleContextMessages(entry).some(isCutPointMessage)) {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/** Find the context-visible user-like message that starts the containing turn. */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		if (isTurnStartEntry(entries[i])) return i;
	}
	return -1;
}

function findCutPointAtOrAfter(cutPoints: number[], entryIndex: number): number | undefined {
	for (const cutPoint of cutPoints) {
		if (cutPoint >= entryIndex) return cutPoint;
	}
	return undefined;
}

function findCutPointAtOrBefore(cutPoints: number[], entryIndex: number): number | undefined {
	for (let index = cutPoints.length - 1; index >= 0; index--) {
		if (cutPoints[index] <= entryIndex) return cutPoints[index];
	}
	return undefined;
}

function selectTokenBudgetCutIndex(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
	cutPoints: number[],
): number {
	let accumulatedTokens = 0;
	for (let index = endIndex - 1; index >= startIndex; index--) {
		const messageTokens = getVisibleContextMessages(entries[index]).reduce(
			(sum, message) => sum + estimateTokens(message),
			0,
		);
		if (messageTokens === 0) continue;
		accumulatedTokens += messageTokens;
		if (accumulatedTokens < keepRecentTokens) continue;
		return findCutPointAtOrAfter(cutPoints, index) ?? findCutPointAtOrBefore(cutPoints, index) ?? cutPoints[0];
	}
	return cutPoints[0];
}

function includeLeadingMetadataEntries(entries: SessionEntry[], startIndex: number, cutIndex: number): number {
	let normalizedCutIndex = cutIndex;
	while (normalizedCutIndex > startIndex) {
		const previousEntry = entries[normalizedCutIndex - 1];
		if (previousEntry.type === "compaction" || getVisibleContextMessages(previousEntry).length > 0) break;
		normalizedCutIndex--;
	}
	return normalizedCutIndex;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	const selectedCutIndex = selectTokenBudgetCutIndex(entries, startIndex, endIndex, keepRecentTokens, cutPoints);
	const cutIndex = includeLeadingMetadataEntries(entries, startIndex, selectedCutIndex);

	// User-like context entries start a turn; assistant cut points split one.
	const cutEntry = entries[cutIndex];
	const startsTurn = isTurnStartEntry(cutEntry);
	const turnStartIndex = startsTurn ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !startsTurn && turnStartIndex !== -1,
	};
}

// ============================================================================
// Summarization
// ============================================================================

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

function createSummarizationOptions(
	model: Model<any>,
	maxTokens: number,
	apiKey: string | undefined,
	headers: ProviderHeaders | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = { maxTokens, signal, apiKey, headers };
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel;
	}
	return options;
}

export async function completeSummarization(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const requestOptions: SimpleStreamOptions = {
		...options,
		cacheRetention: "none",
		sessionId: uuidv7(),
	};
	const produce = async (): Promise<AssistantMessage> => {
		if (!streamFn) return completeSimple(model, context, requestOptions);
		const stream = await streamFn(model, context, requestOptions);
		return stream.result();
	};
	return retryAssistantCall(produce, retry, requestOptions.signal, callbacks);
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: ProviderHeaders,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<string> {
	const maxTokens = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);

	// Use update prompt if we have a previous summary, otherwise initial prompt
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	// Serialize conversation to text so model doesn't try to continue it
	// Convert to LLM messages first (handles custom types like bashExecution, custom, etc.)
	const llmMessages = convertToLlm(currentMessages);
	const conversationText = serializeConversation(llmMessages);

	// Build the prompt with conversation wrapped in tags
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const completionOptions = createSummarizationOptions(model, maxTokens, apiKey, headers, signal, thinkingLevel);

	const response = await completeSummarization(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		completionOptions,
		streamFn,
		retry,
		callbacks,
	);

	if (response.stopReason === "error") {
		throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	const textContent = response.content
		.filter((content): content is TextContent => content.type === "text")
		.map((c) => c.text)
		.join("\n");

	return textContent;
}

// ============================================================================
// Compaction Preparation (for extensions)

function collectMessagesForCompaction(entries: SessionEntry[], startIndex: number, endIndex: number): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let index = startIndex; index < endIndex; index++) {
		messages.push(...getMessagesFromEntryForCompaction(entries[index]));
	}
	return messages;
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	const boundaryEnd = pathEntries.length;

	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);

	// Get UUID of first kept entry
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	const messagesToSummarize = collectMessagesForCompaction(pathEntries, boundaryStart, historyEnd);
	const turnPrefixMessages = cutPoint.isSplitTurn
		? collectMessagesForCompaction(pathEntries, cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex)
		: [];

	// Extract file operations from messages and previous compaction
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	// Include file operations from a split turn's prefix.
	for (const message of turnPrefixMessages) {
		extractFileOpsFromMessage(message, fileOps);
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	};
}

// ============================================================================
// Main compaction function
// ============================================================================

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - Session adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	headers?: ProviderHeaders,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	// Generate summaries and merge into one
	let summary: string;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		const historyResult =
			messagesToSummarize.length > 0
				? await generateSummary(
						messagesToSummarize,
						model,
						settings.reserveTokens,
						apiKey,
						headers,
						signal,
						customInstructions,
						previousSummary,
						thinkingLevel,
						streamFn,
						retry,
						callbacks,
					)
				: "No prior history.";
		const turnPrefixResult = await generateTurnPrefixSummary(
			turnPrefixMessages,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			signal,
			thinkingLevel,
			streamFn,
			retry,
			callbacks,
		);
		// Merge into single summary
		summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
	} else {
		// Just generate history summary
		summary = await generateSummary(
			messagesToSummarize,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			retry,
			callbacks,
		);
	}

	// Compute file lists and append to summary
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	};
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: ProviderHeaders,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<string> {
	const maxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	); // Smaller budget for turn prefix
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const response = await completeSummarization(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		createSummarizationOptions(model, maxTokens, apiKey, headers, signal, thinkingLevel),
		streamFn,
		retry,
		callbacks,
	);

	if (response.stopReason === "error") {
		throw new Error(`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`);
	}

	return response.content
		.filter((content): content is TextContent => content.type === "text")
		.map((c) => c.text)
		.join("\n");
}
