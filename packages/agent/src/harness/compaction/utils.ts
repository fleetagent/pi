import type {
	AssistantMessage,
	ImageContent,
	Message,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@fleetagent/pi-ai";
import type { AgentMessage } from "../../types.ts";

/** File paths touched by a session branch or compaction range. */
export interface FileOperations {
	/** Files read but not necessarily modified. */
	read: Set<string>;
	/** Files written by full-file write operations. */
	written: Set<string>;
	/** Files modified by edit operations. */
	edited: Set<string>;
}

export interface FileOperationLists {
	readFiles: string[];
	modifiedFiles: string[];
}

/** Create an empty file-operation accumulator. */
export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

type FileOperationType = "read" | "write" | "edit";

interface ExtractedFileOperation {
	type: FileOperationType;
	path: string;
}

function parseFileOperation(block: unknown): ExtractedFileOperation | undefined {
	if (typeof block !== "object" || block === null) return undefined;
	if (!("type" in block) || block.type !== "toolCall") return undefined;
	if (!("arguments" in block) || !("name" in block)) return undefined;
	const args = block.arguments as Record<string, unknown> | undefined;
	if (!args) return undefined;
	const path = typeof args.path === "string" ? args.path : undefined;
	if (!path) return undefined;
	switch (block.name) {
		case "read":
		case "write":
		case "edit":
			return { type: block.name, path };
		default:
			return undefined;
	}
}

function recordFileOperation(operation: ExtractedFileOperation, fileOps: FileOperations): void {
	switch (operation.type) {
		case "read":
			fileOps.read.add(operation.path);
			break;
		case "write":
			fileOps.written.add(operation.path);
			break;
		case "edit":
			fileOps.edited.add(operation.path);
			break;
	}
}

/** Add file operations from assistant tool calls to an accumulator. */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;
	for (const block of message.content) {
		const operation = parseFileOperation(block);
		if (operation) recordFileOperation(operation, fileOps);
	}
}

/** Compute sorted read-only and modified file lists from accumulated operations. */
export function computeFileLists(fileOps: FileOperations): FileOperationLists {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/** Format file lists as summary metadata tags. */
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

const TOOL_RESULT_MAX_CHARS = 2000;

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

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
				.map(([key, value]) => `${key}=${safeJsonStringify(value)}`)
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

/** Serialize LLM messages to plain text for summarization prompts. */
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
