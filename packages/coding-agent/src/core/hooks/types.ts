import type { ToolOperations } from "../tools/operations.ts";

export const HOOK_EVENT_NAMES = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"Stop",
	"StopFailure",
	"PreCompact",
	"PostCompact",
	"SessionEnd",
] as const;

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type PermissionMode = "default" | "plan" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions";
export type HookEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface HookEffort {
	level: HookEffortLevel;
}
export type SessionStartHookSource = "startup" | "resume" | "clear" | "compact" | "fork";
export type CompactionHookTrigger = "manual" | "auto";

export interface HookInputCommon {
	session_id: string;
	transcript_path: string;
	cwd: string;
	hook_event_name: HookEventName;
	prompt_id?: string;
	permission_mode?: PermissionMode;
	agent_id?: string;
	agent_type?: string;
	effort?: HookEffort;
}

export interface SessionStartHookInput extends HookInputCommon {
	hook_event_name: "SessionStart";
	source: SessionStartHookSource;
	model?: string;
	session_title?: string;
}
export interface UserPromptSubmitHookInput extends HookInputCommon {
	hook_event_name: "UserPromptSubmit";
	prompt: string;
}
export interface ToolHookInput extends HookInputCommon {
	tool_name: string;
	tool_input: JsonObject;
	tool_use_id: string;
}
export interface PreToolUseHookInput extends ToolHookInput {
	hook_event_name: "PreToolUse";
}
export interface PostToolUseHookInput extends ToolHookInput {
	hook_event_name: "PostToolUse";
	tool_response: JsonValue;
	duration_ms?: number;
}
export interface PostToolUseFailureHookInput extends ToolHookInput {
	hook_event_name: "PostToolUseFailure";
	error: string;
	is_interrupt?: boolean;
	duration_ms?: number;
}
export interface StopHookInput extends HookInputCommon {
	hook_event_name: "Stop";
	stop_hook_active: boolean;
	last_assistant_message: string;
	background_tasks?: JsonObject[];
	session_crons?: JsonObject[];
}
export interface StopFailureHookInput extends HookInputCommon {
	hook_event_name: "StopFailure";
	error: string;
	error_details?: string;
	last_assistant_message?: string;
}
export interface PreCompactHookInput extends HookInputCommon {
	hook_event_name: "PreCompact";
	trigger: CompactionHookTrigger;
	custom_instructions: string;
}
export interface PostCompactHookInput extends HookInputCommon {
	hook_event_name: "PostCompact";
	trigger: CompactionHookTrigger;
	compact_summary: string;
}
export type SessionEndReason = "clear" | "resume" | "logout" | "prompt_input_exit" | "other";

export interface SessionEndHookInput extends HookInputCommon {
	hook_event_name: "SessionEnd";
	reason: SessionEndReason;
}
export type HookInput =
	| SessionStartHookInput
	| UserPromptSubmitHookInput
	| PreToolUseHookInput
	| PostToolUseHookInput
	| PostToolUseFailureHookInput
	| StopHookInput
	| StopFailureHookInput
	| PreCompactHookInput
	| PostCompactHookInput
	| SessionEndHookInput;

export type HookCommandShell = "bash" | "powershell";
export type UnsupportedHookHandlerType = "prompt" | "agent" | "mcp_tool";

export interface HookHandlerCommon {
	timeout?: number;
	if?: string;
	statusMessage?: string;
}
export interface CommandHookHandler extends HookHandlerCommon {
	type: "command";
	command: string;
	args?: string[];
	shell?: HookCommandShell;
}
export interface HttpHookHandler extends HookHandlerCommon {
	type: "http";
	url: string;
	headers?: Record<string, string>;
	allowedEnvVars?: string[];
}
export interface UnsupportedHookHandler extends HookHandlerCommon {
	type: UnsupportedHookHandlerType;
}
export type HookHandler = CommandHookHandler | HttpHookHandler | UnsupportedHookHandler;
export interface HookGroup {
	matcher?: string;
	hooks: HookHandler[];
}
export type HookConfiguration = Partial<Record<HookEventName, HookGroup[]>>;

export type HookSettingsSourceKind = "user" | "project" | "local" | "host";
export interface HookSettingsSource {
	kind: HookSettingsSourceKind;
	path: string;
}
export type HookDiagnosticCode =
	| "read"
	| "parse"
	| "schema"
	| "unsupported-handler"
	| "invalid-regex"
	| "execution"
	| "policy"
	| "malformed-output"
	| "system-message"
	| "unsupported-update"
	| "continuation-cap";

export type HookDiagnosticLevel = "warning" | "error";

export interface HookDiagnostic {
	level: HookDiagnosticLevel;
	code: HookDiagnosticCode;
	message: string;
	source?: HookSettingsSource;
	event?: HookEventName;
}
export interface LoadedHookHandler {
	event: HookEventName;
	matcher?: string;
	handler: HookHandler;
	source: HookSettingsSource;
	order: number;
	/** Effective settings-policy environment allowlist for this HTTP hook. */
	httpHookAllowedEnvVars?: readonly string[];
}
export interface LoadedHooks {
	readonly handlers: readonly LoadedHookHandler[];
	readonly diagnostics: readonly HookDiagnostic[];
	readonly sources: readonly HookSettingsSource[];
}

export interface HookStructuredOutput {
	continue?: boolean;
	stopReason?: string;
	suppressOutput?: boolean;
	systemMessage?: string;
	terminalSequence?: string;
	decision?: string;
	reason?: string;
	hookSpecificOutput?: JsonObject;
}
export type HookOutputClassification =
	| { kind: "empty" }
	| { kind: "text"; text: string; malformedJson: boolean }
	| { kind: "json"; value: HookStructuredOutput };
export type HookExecutionStatus = "completed" | "timeout" | "cancelled" | "error" | "unsupported";

export interface HookExecutionResult {
	hook: LoadedHookHandler;
	status: HookExecutionStatus;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	output: HookOutputClassification;
	blocking: boolean;
	blockingReason?: string;
	durationMs: number;
	diagnostic?: HookDiagnostic;
}

export interface HookRunOptions {
	/** Active workspace backend used for project/local hook isolation. */
	toolOperations?: Pick<ToolOperations, "cwd" | "exec" | "getBackendInfo">;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	maxOutputBytes?: number;
	fetch?: typeof globalThis.fetch;
	/** Internal/test platform override for process-tree termination behavior. */
	platform?: NodeJS.Platform;
	/** Internal/test override for Windows process-tree termination. Return false to request direct-child fallback. */
	terminateWindowsProcessTree?: (pid: number) => boolean;
	/** Shared timeout override (used for SessionEnd matching handlers). */
	timeoutSeconds?: number;
	/** Host ceiling for HTTP destinations. Omitted means no additional host restriction. */
	allowedHttpHookUrls?: readonly string[];
	/** Host ceiling for HTTP header environment interpolation. */
	httpHookAllowedEnvVars?: readonly string[];
}
export type HookPermissionDecision = "allow" | "ask" | "defer" | "deny";

export interface HookAggregateResult {
	continue: boolean;
	blocked: boolean;
	reason?: string;
	additionalContext: string[];
	systemMessages: string[];
	plainText: string[];
	permissionDecision?: HookPermissionDecision;
	updatedInput?: JsonObject;
	updatedToolOutput?: JsonValue;
	sessionTitle?: string;
	initialUserMessage?: string;
	/** Aggregate remaining-work metric reported by Stop hooks. Lower values indicate progress. */
	stopContinuationProgress?: number;
	reloadSkills?: boolean;
	results: HookExecutionResult[];
}

/** Sanitized completed handler call for host UI rendering. */
export interface HookExecutionCallNotice {
	type: HookHandler["type"];
	label: string;
	source: HookSettingsSource;
	status: HookExecutionStatus;
	exitCode: number | null;
	durationMs: number;
}

/** One completed hook event execution, exposed to host UI observers without session persistence. */
export interface HookExecutionNotice {
	event: HookEventName;
	subject?: string;
	calls: HookExecutionCallNotice[];
	returnedPrompts: string[];
}

export type HookExecutionListener = (notice: HookExecutionNotice) => void;
