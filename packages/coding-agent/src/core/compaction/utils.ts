/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage, FileOperationLists, FileOperations } from "@fleetagent/pi-agent-core";

export type { FileOperations } from "@fleetagent/pi-agent-core";

import type {
	AssistantMessage,
	ImageContent,
	Message,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@fleetagent/pi-ai";

// ============================================================================
// File Operation Tracking
// ============================================================================

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
function recordToolCallFileOperation(block: unknown, fileOps: FileOperations): void {
	if (typeof block !== "object" || block === null) return;
	if (!("type" in block) || block.type !== "toolCall") return;
	if (!("arguments" in block) || !("name" in block)) return;
	const args = block.arguments as Record<string, unknown> | undefined;
	if (!args) return;
	const path = typeof args.path === "string" ? args.path : undefined;
	if (!path) return;
	switch (block.name) {
		case "read":
			fileOps.read.add(path);
			break;
		case "write":
			fileOps.written.add(path);
			break;
		case "edit":
			fileOps.edited.add(path);
			break;
	}
}

export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;
	for (const block of message.content) recordToolCallFileOperation(block, fileOps);
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): FileOperationLists {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as XML tags for summary.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Truncate text to a maximum character length for summarization.
 * Keeps the beginning and appends a truncation marker.
 */
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

function joinTextBlocks(content: readonly (TextContent | ImageContent)[]): string {
	let text = "";
	for (const block of content) {
		if (block.type === "text") text += block.text;
	}
	return text;
}

function serializeUserMessage(message: UserMessage): string[] {
	const content = typeof message.content === "string" ? message.content : joinTextBlocks(message.content);
	return content ? [`[User]: ${content}`] : [];
}

function serializeAssistantMessage(message: AssistantMessage): string[] {
	const textParts: string[] = [];
	const thinkingParts: string[] = [];
	const toolCalls: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			textParts.push(block.text);
		} else if (block.type === "thinking") {
			thinkingParts.push(block.thinking);
		} else if (block.type === "toolCall") {
			const args = block.arguments as Record<string, unknown>;
			const argsText = Object.entries(args)
				.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
				.join(", ");
			toolCalls.push(`${block.name}(${argsText})`);
		}
	}

	const parts: string[] = [];
	if (thinkingParts.length > 0) parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
	if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
	if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
	return parts;
}

function serializeToolResultMessage(message: ToolResultMessage): string[] {
	const content = joinTextBlocks(message.content);
	return content ? [`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`] : [];
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Tool results are truncated to keep the summarization request within
 * reasonable token budgets. Full content is not needed for summarization.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		switch (message.role) {
			case "user":
				parts.push(...serializeUserMessage(message));
				break;
			case "assistant":
				parts.push(...serializeAssistantMessage(message));
				break;
			case "toolResult":
				parts.push(...serializeToolResultMessage(message));
				break;
		}
	}
	return parts.join("\n\n");
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
