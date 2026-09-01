/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentMessage, AgentToolResult, QueueMode, ThinkingLevel } from "@fleetagent/pi-agent-core";
import type { ImageContent, Model } from "@fleetagent/pi-ai";
import type { TSchema } from "typebox";
import type {
	ForkableUserMessage,
	ModelCycleResult,
	SessionStats,
	StructuredResponse,
} from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/compaction.ts";
import type { ExtensionInstructionRegistration, ToolDefinition, ToolInfo } from "../../core/extensions/types.ts";
import type { SessionEntry, SessionInfo, SessionTreeNode } from "../../core/session/types.ts";
import type { SlashCommandInfo } from "../../core/slash-commands.ts";
import type { ToolBackendInfo } from "../../core/tools/operations.ts";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export interface RpcToolDefinition
	extends Pick<
		ToolDefinition,
		"name" | "label" | "description" | "promptSnippet" | "promptGuidelines" | "parameters" | "executionMode"
	> {
	lazy?: boolean;
}

export interface RpcInstructionDefinition
	extends Pick<
		ExtensionInstructionRegistration,
		"name" | "description" | "filePath" | "content" | "baseDir" | "disableModelInvocation" | "tools"
	> {}

export type RpcCommandType =
	| "prompt"
	| "get_structured_response"
	| "steer"
	| "follow_up"
	| "abort"
	| "new_session"
	| "list_sessions"
	| "get_state"
	| "set_model"
	| "cycle_model"
	| "get_available_models"
	| "set_thinking_level"
	| "cycle_thinking_level"
	| "set_steering_mode"
	| "set_follow_up_mode"
	| "compact"
	| "set_auto_compaction"
	| "set_auto_retry"
	| "abort_retry"
	| "bash"
	| "abort_bash"
	| "set_remote_sandbox"
	| "clear_remote_sandbox"
	| "upload_file"
	| "download_file"
	| "get_session_stats"
	| "export_html"
	| "switch_session"
	| "fork"
	| "clone"
	| "get_fork_messages"
	| "get_entries"
	| "get_tree"
	| "get_last_assistant_text"
	| "set_session_name"
	| "get_messages"
	| "get_commands"
	| "register_skill"
	| "unregister_skill"
	| "register_rule"
	| "unregister_rule"
	| "register_tool"
	| "unregister_tool"
	| "get_available_tools"
	| "rpc_tool_result"
	| "rpc_tool_error";

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| {
			id?: string;
			type: "get_structured_response";
			schema: TSchema;
			name?: string;
			description?: string;
			maxCorrections?: number;
			scope?: "latest" | "conversation";
	  }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; sessionId?: string; parentSession?: string }
	| { id?: string; type: "list_sessions"; cursor?: string; limit?: number }

	// State
	| { id?: string; type: "get_state" }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| {
			id?: string;
			type: "bash";
			command: string;
			record?: boolean;
			truncate?: boolean;
			excludeFromContext?: boolean;
	  }
	| { id?: string; type: "abort_bash" }

	// Remote sandbox
	| { id?: string; type: "set_remote_sandbox"; backend: "daemon"; url: string; token?: string }
	| { id?: string; type: "clear_remote_sandbox" }
	| { id?: string; type: "upload_file"; sourcePath: string; destinationPath: string }
	| { id?: string; type: "download_file"; sourcePath: string; destinationPath: string }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "clone" }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_entries"; since?: string }
	| { id?: string; type: "get_tree" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }

	// Messages
	| { id?: string; type: "get_messages" }

	// Commands (available for invocation via prompt)
	| { id?: string; type: "get_commands" }

	// Session-scoped RPC instructions
	| { id?: string; type: "register_skill"; skill: RpcInstructionDefinition }
	| { id?: string; type: "unregister_skill"; name: string }
	| { id?: string; type: "register_rule"; rule: RpcInstructionDefinition }
	| { id?: string; type: "unregister_rule"; name: string }

	// Session-scoped RPC tools
	| { id?: string; type: "register_tool"; tool: RpcToolDefinition }
	| { id?: string; type: "unregister_tool"; name: string }
	| { id?: string; type: "get_available_tools" }
	| { id?: string; type: "rpc_tool_result"; requestId: string; result: AgentToolResult<unknown> }
	| { id?: string; type: "rpc_tool_error"; requestId: string; error: string };

// ============================================================================
// RPC Session List
// ============================================================================

export type RpcListSessionsOptions = {
	/** Cursor returned by the previous list_sessions response. */
	cursor?: string;
	/** Number of sessions to return. Defaults to 100 and is capped by the RPC server. */
	limit?: number;
};

export type RpcListSessionsResponse = {
	sessions: SessionInfo[];
	nextCursor?: string;
};

export type RpcClientListSessionsResponse = {
	sessions: SessionInfo[];
	nextCursor?: string;
};

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

/** A command available for invocation via prompt */
export type RpcSlashCommand = SlashCommandInfo;

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isIdle: boolean;
	isCompacting: boolean;
	steeringMode: QueueMode;
	followUpMode: QueueMode;
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
	toolBackend: ToolBackendInfo;
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

interface RpcNewSessionResponseData {
	cancelled: boolean;
}

type RpcCycleModelResponseData = ModelCycleResult;

interface RpcAvailableModelsResponseData {
	models: Model<any>[];
}

interface RpcCycleThinkingLevelResponseData {
	level: ThinkingLevel;
}

interface RpcUploadFileResponseData {
	bytes: number;
}

interface RpcDownloadFileResponseData {
	bytes: number;
}

interface RpcExportHtmlResponseData {
	path: string;
}

interface RpcSwitchSessionResponseData {
	cancelled: boolean;
}

interface RpcForkResponseData {
	text: string;
	cancelled: boolean;
}

interface RpcCloneResponseData {
	cancelled: boolean;
}

type RpcForkMessage = ForkableUserMessage;

export interface RpcForkMessagesResponseData {
	messages: RpcForkMessage[];
}

export interface RpcEntriesResponseData {
	entries: SessionEntry[];
	leafId: string | null;
}

export interface RpcTreeResponseData {
	tree: SessionTreeNode[];
	leafId: string | null;
}

interface RpcLastAssistantTextResponseData {
	text: string | null;
}

interface RpcMessagesResponseData {
	messages: AgentMessage[];
}

interface RpcCommandsResponseData {
	commands: RpcSlashCommand[];
}

interface RpcUnregisterSkillResponseData {
	unregistered: boolean;
}

interface RpcUnregisterRuleResponseData {
	unregistered: boolean;
}

interface RpcUnregisterToolResponseData {
	unregistered: boolean;
}

interface RpcAvailableToolsResponseData {
	tools: ToolInfo[];
}

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| {
			id?: string;
			type: "response";
			command: "get_structured_response";
			success: true;
			data: StructuredResponse<unknown>;
	  }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: RpcNewSessionResponseData }
	| { id?: string; type: "response"; command: "list_sessions"; success: true; data: RpcListSessionsResponse }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model<any>;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: RpcCycleModelResponseData | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: RpcAvailableModelsResponseData;
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: RpcCycleThinkingLevelResponseData | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Remote sandbox
	| { id?: string; type: "response"; command: "set_remote_sandbox"; success: true; data: ToolBackendInfo }
	| { id?: string; type: "response"; command: "clear_remote_sandbox"; success: true; data: ToolBackendInfo }
	| { id?: string; type: "response"; command: "upload_file"; success: true; data: RpcUploadFileResponseData }
	| { id?: string; type: "response"; command: "download_file"; success: true; data: RpcDownloadFileResponseData }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: RpcExportHtmlResponseData }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: RpcSwitchSessionResponseData }
	| { id?: string; type: "response"; command: "fork"; success: true; data: RpcForkResponseData }
	| { id?: string; type: "response"; command: "clone"; success: true; data: RpcCloneResponseData }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: RpcForkMessagesResponseData;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_entries";
			success: true;
			data: RpcEntriesResponseData;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_tree";
			success: true;
			data: RpcTreeResponseData;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: RpcLastAssistantTextResponseData;
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: RpcMessagesResponseData }

	// Commands
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: RpcCommandsResponseData;
	  }

	// Session-scoped RPC instructions
	| { id?: string; type: "response"; command: "register_skill"; success: true }
	| {
			id?: string;
			type: "response";
			command: "unregister_skill";
			success: true;
			data: RpcUnregisterSkillResponseData;
	  }
	| { id?: string; type: "response"; command: "register_rule"; success: true }
	| {
			id?: string;
			type: "response";
			command: "unregister_rule";
			success: true;
			data: RpcUnregisterRuleResponseData;
	  }

	// Session-scoped RPC tools
	| { id?: string; type: "response"; command: "register_tool"; success: true }
	| {
			id?: string;
			type: "response";
			command: "unregister_tool";
			success: true;
			data: RpcUnregisterToolResponseData;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_tools";
			success: true;
			data: RpcAvailableToolsResponseData;
	  }
	| { id?: string; type: "response"; command: "rpc_tool_result"; success: true }
	| { id?: string; type: "response"; command: "rpc_tool_error"; success: true }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// RPC Tool Events (stdout)
// ============================================================================

export interface RpcToolCallRequest {
	type: "rpc_tool_call";
	requestId: string;
	toolName: string;
	toolCallId: string;
	args: unknown;
}

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };
