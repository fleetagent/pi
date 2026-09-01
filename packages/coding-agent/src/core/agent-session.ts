/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Tree navigation and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, posix, sep, win32 } from "node:path";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	Agent,
	AgentContext,
	AgentEvent,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentState,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	CompactionSettings,
	PrepareNextTurnContext,
	QueueMode,
	ThinkingLevel,
} from "@fleetagent/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	ProviderHeaders,
	RetryCallbacks,
	TextContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@fleetagent/pi-ai";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRetryableAssistantError,
	modelsAreEqual,
	resetApiProviders,
	streamSimple,
	validateToolArguments,
} from "@fleetagent/pi-ai";
import { Text } from "@fleetagent/pi-tui";
import { type Static, type TSchema, Type } from "typebox";
import { theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import { sleep } from "../utils/sleep.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import { collectEntriesForBranchSummary, generateBranchSummary } from "./compaction/branch-summarization.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	calculateContextTokens,
	compact,
	estimateContextTokens,
	prepareCompaction,
	shouldCompact,
} from "./compaction/compaction.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type ExtensionErrorListener,
	ExtensionRunner,
	emitSessionShutdownEvent,
	type ShutdownHandler,
} from "./extensions/runner.ts";
import type {
	CompactOptions,
	ContextUsage,
	ExtensionCommandContextActions,
	ExtensionNavigateTreeOptions,
	ExtensionSendMessageOptions,
	ExtensionUIContext,
	InputSource,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ModelSelectSource,
	ReplacedSessionContext,
	ResourcesDiscoverReason,
	SessionBeforeCompactResult,
	SessionBeforeTreeResult,
	SessionBeforeTreeSummary,
	SessionStartEvent,
	StreamingBehavior,
	ToolDefinition,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolInfo,
	TreePreparation,
	TurnEndEvent,
	TurnStartEvent,
} from "./extensions/types.ts";
import { wrapRegisteredTools } from "./extensions/wrapper.ts";
import { capModelVisibleHookField, runHooks } from "./hooks/index.ts";
import { matchHookValue } from "./hooks/matcher.ts";
import type {
	HookAggregateResult,
	HookDiagnostic,
	HookEventName,
	HookExecutionListener,
	HookExecutionNotice,
	HookExecutionResult,
	HookInput,
	HookRunOptions,
	JsonObject,
	JsonValue,
	LoadedHooks,
	SessionEndReason,
} from "./hooks/types.ts";
import type { InstructionResource } from "./instruction-resource-loader.ts";
import {
	type LspConfigurationLayer,
	parseLspConfiguration,
	type ResolvedLspConfiguration,
	resolveLspConfiguration,
} from "./lsp/config.ts";
import {
	type LoadLspConfigurationResult,
	type LspConfigurationSourceDiagnostic,
	resolveLspConfigurationLayerPaths,
} from "./lsp/config-loader.ts";
import { formatAutoDiagnosticsForChangedFile } from "./lsp/diagnostics.ts";
import {
	createLspRuntimeState,
	createLspToolDefinitions,
	LSP_TOOL_NAMES,
	type LspRuntimeState,
	type LspSessionStatus,
} from "./lsp/integration.ts";
import type { LspConnectionFactoryRegistry } from "./lsp/transport.ts";
import {
	type BashExecutionMessage,
	type CustomMessage,
	normalizeMessageContent,
	STRUCTURED_RESPONSE_INTERNAL_CUSTOM_TYPE,
} from "./messages.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { ScopedModel } from "./model-resolver.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader, ResourcePathEntry } from "./resource-loader.ts";
import type { Rule } from "./rules.ts";
import { CURRENT_SESSION_VERSION } from "./session/constants.ts";
import { getLatestCompactionEntry } from "./session/context.ts";
import type { Session } from "./session/session.ts";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry, SessionHeader } from "./session/types.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { Skill } from "./skills.ts";
import { HIDDEN_BUILTIN_SLASH_COMMAND_NAMES, type SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, getSourceBackend, type SourceInfo } from "./source-info.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";
import { createLocalBashOperations } from "./tools/bash.ts";
import {
	DeferredRemoteToolOperations,
	LocalToolOperations,
	type ToolBackendInfo,
	type ToolOperations,
} from "./tools/operations.ts";
import type { ReadToolOperationsSelection } from "./tools/read.ts";
import { createSessionEntryGetToolDefinition, createSessionSearchToolDefinition } from "./tools/session-history.ts";
import {
	createCreateSubagentToolDefinition,
	createSubagentRunsToolDefinition,
	createSubagentToolDefinition,
	formatSubagentModelCatalog,
	type SubagentConfigRegistry,
	type SubagentModelHint,
	type SubagentRunner,
	type SubagentRunRegistry,
} from "./tools/subagent.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { createWebsearchToolDefinition, parseWebsearchToolOptions } from "./tools/websearch.ts";
import { WORKSPACE_TOOL_NAMES, WorkspaceToolHost } from "./tools/workspace-tool-host.ts";

// ============================================================================
// Skill Block Parsing
// ============================================================================

const CORE_DEFAULT_TOOL_NAMES = ["read", "bash", "edit", "write", "websearch"] as const;
const SESSION_HISTORY_TOOL_NAMES = ["session_search", "session_entry_get"] as const;
export const DEFAULT_ACTIVE_TOOL_NAMES = [
	...CORE_DEFAULT_TOOL_NAMES,
	...SESSION_HISTORY_TOOL_NAMES,
	...LSP_TOOL_NAMES,
	"subagent",
	"subagent_runs",
	"create_subagent",
] as const;

export function getDefaultActiveToolNames(): string[] {
	return [...DEFAULT_ACTIVE_TOOL_NAMES];
}

// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "agent_settled" }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

export interface ExtensionRunnerRef {
	current?: ExtensionRunner;
}

export interface SessionStatsTokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface AgentSessionConfig {
	agent: Agent;
	session: Session;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: ScopedModel[];
	/** Resource loader for skills, rules, prompts, themes, context files, system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Tool operation backend used by built-in tools. */
	toolOperations?: ToolOperations;
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** Initial active built-in tool names. Defaults to DEFAULT_ACTIVE_TOOL_NAMES. */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Tool names that must never be exposed in this session. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: ExtensionRunnerRef;
	/** Runner used to create isolated subagent sessions. */
	subagentRunner?: SubagentRunner;
	subagentRunRegistry?: SubagentRunRegistry;
	subagentConfigRegistry?: SubagentConfigRegistry;
	/** Host-controlled trust grant for project-local subagent presets. */
	trustProjectAgents?: boolean;
	/** Validated configuration for the AgentSession-owned LSP runtime. */
	lspConfiguration?: ResolvedLspConfiguration;
	/** Host-provided factories referenced by LSP transports with type `connection`. */
	lspConnectionFactories?: LspConnectionFactoryRegistry;
	/** Re-resolves settings/file-backed LSP configuration after settings reload. */
	resolveLspConfiguration?: () => Promise<LoadLspConfigurationResult>;
	/** Receives current source-attributed diagnostics after each LSP configuration re-resolution. */
	onLspConfigurationDiagnostics?: (diagnostics: readonly LspConfigurationSourceDiagnostic[]) => void;
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** Immutable Claude-compatible hook configuration snapshot for this session. */
	loadedHooks?: LoadedHooks;
	/** Receives nonfatal hook execution/runtime diagnostics. */
	onHookDiagnostic?: (diagnostic: HookDiagnostic) => void;
	/** Host restrictions applied to hook execution. */
	hookRunOptions?: Pick<HookRunOptions, "allowedHttpHookUrls" | "httpHookAllowedEnvVars">;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

export interface AgentSessionReloadResult {
	lsp?: LoadLspConfigurationResult;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: StreamingBehavior;
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
}

export type StructuredResponseScope = "latest" | "conversation";
export type StructuredResponseSource = "json" | "tool";

export interface StructuredResponseOptions<TSchemaValue extends TSchema> {
	/** TypeBox object schema for the structured response. */
	schema: TSchemaValue;
	/** Schema/tool name shown to the model. Defaults to "structured_output". */
	name?: string;
	/** Optional description for the temporary structured output tool. */
	description?: string;
	/** Maximum correction calls after an invalid response. Defaults to 2. */
	maxCorrections?: number;
	/** Source context for extraction. Defaults to the latest assistant answer. */
	scope?: StructuredResponseScope;
}

export interface StructuredResponse<T> {
	output: T;
	attempts: number;
	source: StructuredResponseSource;
	message: AssistantMessage;
}

/** Direction used when cycling through configured models. */
export type ModelCycleDirection = "forward" | "backward";

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: SessionStatsTokenTotals;
	cost: number;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

interface SessionToolEntry extends ToolDefinitionEntry {
	lazy: boolean;
	loaded: boolean;
}

interface ExtensionLspOwnership {
	configuration: ResolvedLspConfiguration;
	runtimeState: LspRuntimeState | undefined;
}

interface RuntimeLifecycleOperationToken {
	active: boolean;
	children: Set<Promise<unknown>>;
	childQueue: Promise<void>;
}

interface SessionActivityToken {
	active: boolean;
	kind: string;
}

interface PromptPreparationState {
	readonly text: string;
	readonly options: PromptOptions | undefined;
	readonly promptId: string;
	readonly expandPromptTemplates: boolean;
	readonly hookContextMessages: CustomMessage[];
	promptActivity: SessionActivityToken | undefined;
	queueIntoActiveRun: boolean;
	sessionContext: CustomMessage | undefined;
	currentText: string;
	currentImages: ImageContent[] | undefined;
	expandedText: string;
}

interface IdleWaiter {
	resolve: () => void;
	reject: (error: Error) => void;
}

interface BarrierOwnerScope {
	active: boolean;
	label: string;
}

type StructuredInternalStage = "request" | "assistant" | "tool_result" | "result";

interface StructuredInternalDetails {
	stage: StructuredInternalStage;
	schemaName: string;
	attempt: number;
	source?: StructuredResponseSource;
	validationError?: string;
}

interface HookToolOutput {
	content: (TextContent | ImageContent)[];
	details?: JsonValue;
}

interface PreToolHookExecution {
	toolCall: BeforeToolCallContext["toolCall"];
	args: unknown;
	agentContext: AgentContext;
	backend: ToolBackendInfo;
	flavor: HookPathFlavor;
	normalizedToolName: string;
	adaptToolInput: boolean;
}

type PreToolInputAdaptation = { ok: true; input: JsonObject } | { ok: false; blockResult: BeforeToolCallResult };

type ToolHookEventName = "PreToolUse" | "PostToolUse" | "PostToolUseFailure";
type PostToolHookEvent = "PostToolUse" | "PostToolUseFailure";

interface PostToolCallState {
	toolCall: AfterToolCallContext["toolCall"];
	args: unknown;
	content: AfterToolCallContext["result"]["content"];
	details: AfterToolCallContext["result"]["details"];
	isError: boolean;
}

type PostToolHookRunResult = { ok: true; hookResult: HookAggregateResult } | { ok: false };

interface SessionToolNameArgs {
	name?: string | string[];
}

interface SessionToolNameParameters {
	name: string | string[];
}

interface RequiredRequestAuth {
	apiKey: string;
	headers?: ProviderHeaders;
}

type CompactionRequestAuth = Partial<RequiredRequestAuth>;

interface LspToolResult {
	content: ToolResultMessage["content"];
	details?: unknown;
}

interface LspToolResultUpdate extends LspToolResult {
	isError?: boolean;
}

type CoreAgentEndEvent = Extract<AgentEvent, { type: "agent_end" }>;

type StructuredValidationResult<T> = { ok: true; output: T } | { ok: false; error: string };

interface StructuredAttemptContext<TSchemaValue extends TSchema> {
	tool: Tool<TSchemaValue>;
	assistantMessage: AssistantMessage;
	messages: Message[];
	schemaName: string;
	attempt: number;
}

type StructuredAttemptResult<T> = { ok: true; response: StructuredResponse<T> } | { ok: false; error: string };

interface CompactionExecutionOptions {
	abortActiveRun: boolean;
}

interface CompactionPlan extends CompactionRequestAuth {
	model: Model<Api>;
	preparation: CompactionPreparation;
	pathEntries: SessionEntry[];
}

type AutoCompactionReason = "overflow" | "threshold";
type ExtensionCompactionQueueMode = "idle" | "between-turns";

interface AutoCompactionInterception {
	cancelled: boolean;
	compaction?: CompactionResult;
}

interface ResolvedAutoCompaction {
	result: CompactionResult;
	fromExtension: boolean;
}

interface ExtensionResourcePath {
	path: string;
	extensionPath: string;
}

interface ToolRegistryRefreshOptions {
	activeToolNames?: string[];
	includeAllExtensionTools?: boolean;
}

interface BuildRuntimeOptions extends ToolRegistryRefreshOptions {
	flagValues?: Map<string, boolean | string>;
}

interface RuntimeBuildSnapshot {
	baseToolDefinitions: Map<string, ToolDefinition>;
	lspRuntimeState: LspRuntimeState | undefined;
	extensionRunner: ExtensionRunner | undefined;
	toolRegistry: Map<string, AgentTool>;
	toolDefinitions: Map<string, ToolDefinitionEntry>;
	toolPromptSnippets: Map<string, string>;
	toolPromptGuidelines: Map<string, string[]>;
	baseSystemPrompt: string;
	baseSystemPromptOptions: BuildSystemPromptOptions | undefined;
	agentTools: AgentTool[];
	agentSystemPrompt: string;
	extensionRunnerRef: ExtensionRunner | undefined;
	workspaceToolHost: WorkspaceToolHost | undefined;
}
interface StopContinuationProgressState {
	best: number;
	consecutiveNonImprovingCalls: number;
}

type SummarizationRetrySource =
	| { source: "branchSummary" }
	| { source: "compaction"; reason: "manual" | "threshold" | "overflow" };

export interface ConfigureRemoteSandboxOptions {
	type: "daemon";
	url: string;
	token?: string;
}

export interface ActivateSandboxDaemonOptions {
	url: string;
	token: string;
	expectedCwd: string;
}

export type SessionSkillRegistration = Omit<Skill, "sourceInfo" | "baseDir"> & {
	baseDir?: string;
	sourceInfo?: SourceInfo;
};

export type SessionRuleRegistration = Omit<Rule, "sourceInfo" | "baseDir"> & {
	baseDir?: string;
	sourceInfo?: SourceInfo;
};

export interface RegisterSessionToolOptions {
	lazy?: boolean;
	sourceInfo?: SourceInfo;
}

export type SendCustomMessageOptions = ExtensionSendMessageOptions;

export interface SendUserMessageOptions {
	deliverAs?: StreamingBehavior;
}

export interface QueuedMessages {
	steering: string[];
	followUp: string[];
}

export interface ExecuteBashOptions {
	excludeFromContext?: boolean;
	operations?: ToolOperations;
	record?: boolean;
	truncate?: boolean;
}

export interface RecordBashResultOptions {
	excludeFromContext?: boolean;
}

export type NavigateTreeOptions = ExtensionNavigateTreeOptions;

export interface NavigateTreeResult {
	editorText?: string;
	cancelled: boolean;
	aborted?: boolean;
	summaryEntry?: BranchSummaryEntry;
}

interface TreeNavigationSettings {
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

interface TreeExtensionPreparationResult extends TreeNavigationSettings {
	cancelled: boolean;
	extensionSummary?: SessionBeforeTreeSummary;
	fromExtension: boolean;
}

interface TreeSummaryResolution {
	cancelled: boolean;
	aborted?: boolean;
	summaryText?: string;
	summaryDetails?: unknown;
	fromExtension: boolean;
}

interface TreeTargetResolution {
	newLeafId: string | null;
	editorText?: string;
}

export interface ForkableUserMessage {
	entryId: string;
	text: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
const DEFAULT_STRUCTURED_RESPONSE_TOOL_NAME = "structured_output";
const DEFAULT_STRUCTURED_RESPONSE_CORRECTIONS = 2;
const DEFAULT_STOP_HOOK_CONTINUATION_LIMIT = 8;
const STOP_HOOK_PROGRESS_REGRESSION_TOLERANCE = 3;
const STALE_EXTENSION_CONTEXT_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CLAUDE_TOOL_NAMES: Readonly<Record<string, string>> = {
	read: "Read",
	bash: "Bash",
	edit: "Edit",
	write: "Write",
	websearch: "WebSearch",
	grep: "Grep",
	find: "Glob",
	ls: "Glob",
};
function claudeToolName(name: string): string {
	return CLAUDE_TOOL_NAMES[name] ?? name;
}

export type HookPathFlavor = "posix" | "windows";

function hookPathFlavor(backend: ToolBackendInfo): HookPathFlavor {
	if (backend.type === "remote" && backend.configured) return backend.workspace.pathFlavor;
	if (backend.type === "remote") return /^[A-Za-z]:[\\/]/.test(backend.cwd) ? "windows" : "posix";
	return process.platform === "win32" ? "windows" : "posix";
}

function hookPathHome(backend: ToolBackendInfo, flavor: HookPathFlavor): string | null {
	return backend.type === "local" && flavor === "posix" ? homedir() : null;
}

function isClaudeFileTool(name: string): boolean {
	return name === "read" || name === "edit" || name === "write";
}

export function classifyStopFailure(errorMessage: string): string {
	const normalized = errorMessage.toLowerCase();
	if (/rate[\s_-]*limit|too many requests|\b429\b/.test(normalized)) return "rate_limit";
	if (/overload|capacity|\b529\b/.test(normalized)) return "overloaded";
	if (/oauth.*org|organization.*oauth/.test(normalized)) return "oauth_org_not_allowed";
	if (/billing|credit|payment|quota.*(?:fund|spend)/.test(normalized)) return "billing_error";
	if (/model.*not[\s_-]*found|unknown model|\b404\b/.test(normalized)) return "model_not_found";
	if (/max(?:imum)?[\s_-]*output.*token|output.*token.*limit/.test(normalized)) return "max_output_tokens";
	if (/auth|unauthorized|forbidden|invalid.*(?:api[\s_-]*)?key|\b401\b|\b403\b/.test(normalized))
		return "authentication_failed";
	if (/invalid.*request|bad request|context.*(?:length|window)|\b400\b|\b422\b/.test(normalized))
		return "invalid_request";
	if (/server|internal|gateway|network|connection|timeout|\b5\d\d\b/.test(normalized)) return "server_error";
	return "unknown";
}
function resolveClaudeHookFilePath(source: string, cwd: string, flavor: HookPathFlavor, home: string | null): string {
	const isTildePath = source === "~" || source.startsWith("~/") || source.startsWith("~\\");
	if (isTildePath) {
		if (flavor !== "posix" || home === null) {
			throw new Error("cannot resolve a ~ path without a known POSIX backend home");
		}
		return posix.resolve(home, source === "~" ? "." : source.slice(2));
	}
	if (source.startsWith("~")) throw new Error("~user paths are unsupported in hook file paths");
	const api = flavor === "windows" ? win32 : posix;
	return api.resolve(cwd, source);
}

/** Adapt Pi's file-tool arguments to Claude's absolute, backend-lexical file_path shape. */
export function adaptFileToolInputForClaudeHook(
	toolName: string,
	input: JsonObject,
	cwd: string,
	flavor: HookPathFlavor,
	home: string | null = homedir(),
): JsonObject {
	if (!isClaudeFileTool(toolName)) return input;
	const source = typeof input.path === "string" ? input.path : input.file_path;
	if (typeof source !== "string") return input;
	const adapted: JsonObject = { ...input, file_path: resolveClaudeHookFilePath(source, cwd, flavor, home) };
	delete adapted.path;
	return adapted;
}

/** Reverse a Claude file_path replacement to Pi's path field before schema validation. */
export function adaptFileToolUpdatedInputFromClaudeHook(
	toolName: string,
	input: JsonObject,
	cwd: string,
	flavor: HookPathFlavor,
	home: string | null = homedir(),
): JsonObject {
	if (!isClaudeFileTool(toolName)) return input;
	if (typeof input.file_path !== "string" || "path" in input) {
		throw new Error("file-tool replacement must contain a string file_path and must not contain path");
	}
	const adapted: JsonObject = {
		...input,
		path: resolveClaudeHookFilePath(input.file_path, cwd, flavor, home),
	};
	delete adapted.file_path;
	return adapted;
}

function normalizeHookToolOutput(value: JsonValue): HookToolOutput | undefined {
	if (typeof value === "string") return { content: [{ type: "text", text: value }] };
	if (!isRecord(value) || !Array.isArray(value.content)) return undefined;
	const content: (TextContent | ImageContent)[] = [];
	for (const part of value.content) {
		if (!isRecord(part) || typeof part.type !== "string") return undefined;
		if (part.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
		else if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string")
			content.push({ type: "image", data: part.data, mimeType: part.mimeType });
		else return undefined;
	}
	return { content, ...(value.details !== undefined ? { details: value.details as JsonValue } : {}) };
}

function toJsonValue(value: unknown): JsonValue {
	if (value === undefined) return null;
	try {
		return JSON.parse(JSON.stringify(value)) as JsonValue;
	} catch {
		return String(value);
	}
}

function hookExecutionSubject(input: HookInput): string | undefined {
	switch (input.hook_event_name) {
		case "PreToolUse":
		case "PostToolUse":
		case "PostToolUseFailure":
			return input.tool_name;
		case "PreCompact":
		case "PostCompact":
			return input.trigger;
		case "SessionStart":
			return input.source;
		case "UserPromptSubmit":
		case "Stop":
		case "StopFailure":
		case "SessionEnd":
			return undefined;
	}
}

function hookExecutionLabel(result: HookExecutionResult): string {
	const handler = result.hook.handler;
	if (handler.statusMessage) return handler.statusMessage;
	if (handler.type === "command") return [handler.command, ...(handler.args ?? [])].join(" ");
	if (handler.type === "http") {
		try {
			const url = new URL(handler.url);
			return `${url.origin}${url.pathname}`;
		} catch {
			return handler.url.split(/[?#]/, 1)[0];
		}
	}
	return handler.type;
}

function hookResultContainsStructuredReason(input: HookInput, result: HookAggregateResult, reason: string): boolean {
	return result.results.some((execution) => {
		if (execution.status !== "completed" || execution.output.kind !== "json") return false;
		const output = execution.output.value;
		if (input.hook_event_name !== "SessionEnd" && output.continue === false && output.stopReason === reason) {
			return true;
		}
		if (output.reason === reason && output.decision === "block") {
			switch (input.hook_event_name) {
				case "UserPromptSubmit":
				case "PostToolUse":
				case "PostToolUseFailure":
				case "Stop":
				case "PreCompact":
					return true;
				case "SessionStart":
				case "PreToolUse":
				case "StopFailure":
				case "PostCompact":
				case "SessionEnd":
					break;
			}
		}
		const specific = output.hookSpecificOutput;
		return (
			input.hook_event_name === "PreToolUse" &&
			isRecord(specific) &&
			specific.hookEventName === input.hook_event_name &&
			specific.permissionDecision === "deny" &&
			specific.permissionDecisionReason === reason
		);
	});
}

function createHookExecutionNotice(input: HookInput, result: HookAggregateResult): HookExecutionNotice {
	const returnedPrompts = [...result.additionalContext];
	if (
		result.blocked &&
		result.reason &&
		!returnedPrompts.includes(result.reason) &&
		hookResultContainsStructuredReason(input, result, result.reason)
	) {
		returnedPrompts.push(result.reason);
	}
	return {
		event: input.hook_event_name,
		subject: hookExecutionSubject(input),
		calls: result.results.map((execution) => ({
			type: execution.hook.handler.type,
			label: hookExecutionLabel(execution),
			source: execution.hook.source,
			status: execution.status,
			exitCode: execution.exitCode,
			durationMs: execution.durationMs,
		})),
		returnedPrompts,
	};
}

function getAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function escapeXmlAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function normalizeSessionToolNames(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : [value];
	const names: string[] = [];
	const seenNames = new Set<string>();
	for (const entry of raw) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (trimmed.length > 0 && !seenNames.has(trimmed)) {
			seenNames.add(trimmed);
			names.push(trimmed);
		}
	}
	return names;
}

function getToolNameArgs(args: SessionToolNameArgs | undefined): string[] {
	const names = normalizeSessionToolNames(args?.name);
	return names.length > 0 ? names : ["..."];
}

function formatSessionToolLifecycleCall(label: string, toolNames: string[]): string {
	return (
		theme.fg("customMessageLabel", `\x1b[1m[tool]\x1b[22m `) +
		theme.fg("toolTitle", label) +
		" " +
		theme.fg("customMessageText", toolNames.join(", "))
	);
}

type SessionToolLifecycleAction = "loaded" | "unloaded";

function formatSessionToolLifecycleResult(
	action: SessionToolLifecycleAction,
	succeeded: string[],
	notFound: string[],
): string {
	const prefix = theme.fg("customMessageLabel", `\x1b[1m[tool]\x1b[22m `);
	const parts: string[] = [];
	if (succeeded.length > 0) {
		parts.push(`${theme.fg("success", action)} ${theme.fg("customMessageText", succeeded.join(", "))}`);
	}
	if (notFound.length > 0) {
		parts.push(`${theme.fg("error", "not found")} ${theme.fg("customMessageText", notFound.join(", "))}`);
	}
	if (parts.length === 0) {
		parts.push(theme.fg("error", "not found"));
	}
	return prefix + parts.join("  ");
}

function extractJsonCandidates(text: string): unknown[] {
	const candidates: unknown[] = [];
	const trimmed = text.trim();
	if (trimmed) {
		try {
			candidates.push(JSON.parse(trimmed));
		} catch {
			// Try fenced JSON blocks below.
		}
	}

	const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
	let match = fencePattern.exec(text);
	while (match) {
		try {
			candidates.push(JSON.parse(match[1].trim()));
		} catch {
			// Ignore invalid fenced blocks.
		}
		match = fencePattern.exec(text);
	}
	return candidates;
}

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly session: Session;
	readonly settingsManager: SettingsManager;

	private _scopedModels: ScopedModel[];

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _disposePromise?: Promise<void>;
	private _shutdownPreparationPromise?: Promise<void>;
	private _disposed = false;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];

	// Compaction state
	private _compactionInFlight?: Promise<unknown>;
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _extensionCompactionQueue: CompactOptions[] = [];
	private _extensionCompactionTimer: ReturnType<typeof setTimeout> | undefined = undefined;
	private _extensionCompactionActivity?: SessionActivityToken;
	private _extensionCompactionRunning = false;
	private _overflowRecoveryAttempted = false;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;

	// Bash execution state
	private readonly _bashAbortControllers = new Set<AbortController>();
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private readonly _extensionLspOwnership = new WeakMap<ExtensionRunner, ExtensionLspOwnership>();
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _workspaceToolHost?: WorkspaceToolHost;
	private _retiredWorkspaceToolHosts: WorkspaceToolHost[] = [];
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames: Set<string>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _toolOperations?: ToolOperations;
	private _runtimeToolOperations?: LocalToolOperations;
	private _subagentRunner?: SubagentRunner;
	private _subagentRunRegistry?: SubagentRunRegistry;
	private _subagentConfigRegistry?: SubagentConfigRegistry;
	private _trustProjectAgents: boolean;
	private _localResourceToolOperations?: ToolOperations;
	private _sandboxToolOperations?: DeferredRemoteToolOperations;
	private _preSandboxToolOperations?: ToolOperations;
	private _lspRuntimeState?: LspRuntimeState;
	private _lspConfiguration: ResolvedLspConfiguration;
	private readonly _lspConnectionFactories: LspConnectionFactoryRegistry;
	private readonly _resolveLspConfiguration?: () => Promise<LoadLspConfigurationResult>;
	private readonly _onLspConfigurationDiagnostics?: (diagnostics: readonly LspConfigurationSourceDiagnostic[]) => void;
	private _runtimeLifecycleQueue: Promise<void> = Promise.resolve();
	private _sandboxTransitionQueue: Promise<void> = Promise.resolve();
	private readonly _runtimeLifecycleContext = new AsyncLocalStorage<RuntimeLifecycleOperationToken>();
	private readonly _activities = new Set<SessionActivityToken>();
	private _activityGeneration = 0;
	private _activeCycle = false;
	private _settlementScheduled = false;
	private _settlementRunning = false;
	private readonly _idleWaiters = new Set<IdleWaiter>();
	private readonly _barrierOwnerContext = new AsyncLocalStorage<BarrierOwnerScope>();
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;
	private readonly _loadedHooks?: LoadedHooks;
	private _hooksEnabled = true;
	private readonly _onHookDiagnostic?: (diagnostic: HookDiagnostic) => void;
	private readonly _hookExecutionListeners = new Set<HookExecutionListener>();
	private readonly _hookRunOptions: Pick<HookRunOptions, "allowedHttpHookUrls" | "httpHookAllowedEnvVars">;
	private readonly _hookAbortController = new AbortController();
	private _hookSessionStartPromise?: Promise<CustomMessage | undefined>;
	private _hookSessionStartTerminationReason?: string;
	private _pendingHookSessionStartContext?: CustomMessage;
	private _hookSessionEnded = false;
	private _activePromptId: string | undefined;
	private _stopHookContinuations = 0;
	private _stopHookProgress: StopContinuationProgressState | undefined;
	private readonly _queuedPromptIds = new Map<string, string[]>();
	private readonly _toolStartedAt = new Map<string, number>();
	private readonly _preToolHookContext = new Map<string, string[]>();

	// Model registry for API key resolution
	private _modelRegistry: ModelRegistry;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _sessionTools: Map<string, SessionToolEntry> = new Map();
	private _sessionSkills: Map<string, Skill> = new Map();
	private _sessionRules: Map<string, Rule> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	private _systemPromptOverride?: string;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.session = config.session;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRegistry = config.modelRegistry;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._excludedToolNames = new Set(config.excludedToolNames ?? []);
		if (!config.subagentRunner) {
			this._excludedToolNames.add("subagent");
			this._excludedToolNames.add("subagent_runs");
			this._excludedToolNames.add("create_subagent");
		}
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._toolOperations = config.toolOperations;
		this._subagentRunner = config.subagentRunner;
		this._subagentRunRegistry = config.subagentRunRegistry;
		this._subagentConfigRegistry = config.subagentConfigRegistry;
		this._trustProjectAgents = config.trustProjectAgents === true;
		this._lspConfiguration = structuredClone(config.lspConfiguration ?? { enabled: false, servers: [] });
		this._lspConnectionFactories = config.lspConnectionFactories ?? {};
		this._resolveLspConfiguration = config.resolveLspConfiguration;
		this._onLspConfigurationDiagnostics = config.onLspConfigurationDiagnostics;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._loadedHooks = config.loadedHooks;
		this._onHookDiagnostic = config.onHookDiagnostic;
		this._hookRunOptions = config.hookRunOptions ?? {};

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentTurnPreparation();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames
				? this._withCurrentDefaultTools(this._initialActiveToolNames)
				: undefined,
			includeAllExtensionTools: true,
		});
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	getToolOperations(): ToolOperations {
		if (this._toolOperations) return this._toolOperations;
		const shellPath = this.settingsManager.getShellPath();
		this._runtimeToolOperations ??= new LocalToolOperations(this.session.getCwd(), { shellPath });
		this._runtimeToolOperations.setShellPath(shellPath);
		return this._runtimeToolOperations;
	}

	/** Snapshot of the sole AgentSession-owned LSP runtime and its configured/instantiated servers. */
	getLspStatus(): LspSessionStatus {
		const daemonOwned = this.getToolBackendInfo().type === "remote";
		const remoteStatus = daemonOwned ? this.getToolOperations().getRemoteLspStatus?.() : undefined;
		return {
			owner: daemonOwned ? "daemon" : "agent-session",
			enabled: daemonOwned ? (remoteStatus?.enabled ?? false) : this._lspConfiguration.enabled,
			configuration: daemonOwned
				? { enabled: remoteStatus?.enabled ?? false, servers: [] }
				: structuredClone(this._lspConfiguration),
			servers: daemonOwned ? (remoteStatus?.servers ?? []) : (this._lspRuntimeState?.manager.getStatus() ?? []),
		};
	}

	/** Validate and replace the AgentSession-owned LSP configuration. Relative paths resolve from the session cwd. */
	async configureLsp(configuration: LspConfigurationLayer): Promise<ResolvedLspConfiguration> {
		if (this._disposed) throw new Error("Cannot configure LSP after AgentSession disposal");
		if (this.getToolBackendInfo().type === "remote") {
			throw new Error("LSP for a daemon workspace is operator-owned and cannot be configured by AgentSession");
		}
		const parsed = parseLspConfiguration(configuration);
		if (!parsed.configuration) {
			throw new Error(
				`Invalid LSP configuration: ${parsed.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("; ")}`,
			);
		}
		const resolvedLayer = resolveLspConfigurationLayerPaths(parsed.configuration, this._cwd);
		const resolvedValidation = parseLspConfiguration(resolvedLayer);
		if (!resolvedValidation.configuration) {
			throw new Error(
				`Invalid resolved LSP configuration: ${resolvedValidation.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("; ")}`,
			);
		}
		const resolved = resolveLspConfiguration([resolvedValidation.configuration]);
		await this._enqueueRuntimeLifecycle(() => this._replaceLspRuntime(resolved));
		return structuredClone(resolved);
	}

	getToolBackendInfo(): ToolBackendInfo {
		return this.getToolOperations().getBackendInfo?.() ?? { type: "local", cwd: this._cwd };
	}

	private _getLocalResourceToolOperations(shellPath?: string): ToolOperations {
		this._localResourceToolOperations ??= new LocalToolOperations(this._cwd, { shellPath });
		return this._localResourceToolOperations;
	}

	private _getReadOperationsForPath(
		absolutePath: string,
		shellPath?: string,
	): ReadToolOperationsSelection | undefined {
		const isSameOrChild = (target: string, root: string): boolean => {
			const normalizedRoot = resolvePath(root);
			if (target === normalizedRoot) return true;
			const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
			return target.startsWith(prefix);
		};
		const resources = [
			...this.getRegisteredSkills().map((skill) => ({
				path: skill.filePath,
				baseDir: skill.baseDir,
				sourceInfo: skill.sourceInfo,
			})),
			...this.getRegisteredRules().map((rule) => ({
				path: rule.filePath,
				baseDir: rule.baseDir,
				sourceInfo: rule.sourceInfo,
			})),
			...this._resourceLoader.getPrompts().prompts.map((prompt) => ({
				path: prompt.filePath,
				baseDir: dirname(prompt.filePath),
				sourceInfo: prompt.sourceInfo,
			})),
		];
		let canonicalTarget: string;
		try {
			canonicalTarget = realpathSync(absolutePath);
		} catch {
			return undefined;
		}
		for (const resource of resources) {
			if (getSourceBackend(resource.sourceInfo) !== "local") continue;
			try {
				const resourcePath = realpathSync(resource.path);
				const baseDir = realpathSync(resource.baseDir);
				if (canonicalTarget === resourcePath || isSameOrChild(canonicalTarget, baseDir)) {
					return {
						kind: "selection",
						operations: this._getLocalResourceToolOperations(shellPath),
						path: canonicalTarget,
					};
				}
			} catch {}
		}
		return undefined;
	}

	async configureRemoteSandbox(options: ConfigureRemoteSandboxOptions): Promise<ToolBackendInfo> {
		return this._runActivity("remote backend configuration", () =>
			this._enqueueSandboxTransition(async () => {
				if (!(this._toolOperations instanceof DeferredRemoteToolOperations) || this._sandboxToolOperations) {
					throw new Error("Remote backend can only be configured when Pi is started with --remote-deferred");
				}
				const currentInfo = this._toolOperations.getBackendInfo();
				if (currentInfo.type !== "remote" || currentInfo.configured) {
					throw new Error("Remote backend is already configured");
				}
				return this._activateSessionRemoteOperations(currentInfo.cwd, (operations) =>
					operations.configureRemote(options.url, { token: options.token }),
				);
			}),
		);
	}

	async activateSandboxDaemon(options: ActivateSandboxDaemonOptions): Promise<ToolBackendInfo> {
		return this._runActivity("sandbox daemon activation", () =>
			this._enqueueSandboxTransition(() =>
				this._activateSessionRemoteOperations(options.expectedCwd, (operations) =>
					operations.configureRemote(options.url, { token: options.token, expectedCwd: options.expectedCwd }),
				),
			),
		);
	}

	private async _activateSessionRemoteOperations(
		expectedCwd: string,
		configure: (operations: DeferredRemoteToolOperations) => Promise<ToolBackendInfo>,
	): Promise<ToolBackendInfo> {
		if (this._sandboxToolOperations) throw new Error("A session sandbox backend is already active");
		const previousToolOperations = this._toolOperations;
		const operations = new DeferredRemoteToolOperations(expectedCwd);
		try {
			await configure(operations);
		} catch (error) {
			await operations.dispose();
			throw error;
		}
		this._preSandboxToolOperations = previousToolOperations;
		this._toolOperations = operations;
		this._sandboxToolOperations = operations;
		try {
			await this.applyToolOperationsBackendChange(operations);
		} catch (error) {
			this._toolOperations = previousToolOperations;
			this._sandboxToolOperations = undefined;
			this._preSandboxToolOperations = undefined;
			let rollbackError: unknown;
			try {
				await this.applyToolOperationsBackendChange(this.getToolOperations());
			} catch (caught) {
				rollbackError = caught;
			}
			await operations.dispose();
			if (rollbackError) {
				throw new AggregateError([error, rollbackError], "Sandbox activation and backend rollback both failed");
			}
			throw error;
		}
		return operations.getBackendInfo();
	}

	async clearRemoteSandbox(): Promise<void> {
		return this._runActivity("remote backend clearing", () =>
			this._enqueueSandboxTransition(async () => {
				const operations = this._sandboxToolOperations;
				if (!operations || operations !== this._toolOperations) {
					throw new Error("No session sandbox backend is active");
				}
				const previousToolOperations = this._preSandboxToolOperations;
				this._toolOperations = previousToolOperations;
				this._sandboxToolOperations = undefined;
				this._preSandboxToolOperations = undefined;
				try {
					await this.applyToolOperationsBackendChange(this.getToolOperations());
				} catch (error) {
					this._toolOperations = operations;
					this._sandboxToolOperations = operations;
					this._preSandboxToolOperations = previousToolOperations;
					try {
						await this.applyToolOperationsBackendChange(operations);
					} catch (rollbackError) {
						throw new AggregateError([error, rollbackError], "Sandbox clearing and backend rollback both failed");
					}
					throw error;
				}
				await operations.dispose();
			}),
		);
	}

	private _enqueueSandboxTransition<T>(operation: () => Promise<T>): Promise<T> {
		const result = this._sandboxTransitionQueue.then(operation, operation);
		this._sandboxTransitionQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async uploadFile(sourcePath: string, destinationPath: string): Promise<void> {
		return this._runActivity("remote file upload", async () => {
			const operations = this.getToolOperations();
			if (!operations.uploadFile) throw new Error("Active sandbox backend does not support file upload");
			await operations.uploadFile(sourcePath, destinationPath);
		});
	}

	async downloadFile(sourcePath: string, destinationPath: string): Promise<void> {
		return this._runActivity("remote file download", async () => {
			const operations = this.getToolOperations();
			if (!operations.downloadFile) throw new Error("Active sandbox backend does not support file download");
			await operations.downloadFile(sourcePath, destinationPath);
		});
	}

	private async applyToolOperationsBackendChange(operations: ToolOperations): Promise<void> {
		this._resourceLoader.setToolOperations?.(operations);
		await this._lspRuntimeState?.manager.setToolOperations(operations);
		await this.reload();
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<RequiredRequestAuth> {
		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		if (!result.ok) {
			if (result.error.startsWith("No API key found")) {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw new Error(result.error);
		}
		if (result.apiKey) {
			return { apiKey: result.apiKey, headers: result.headers };
		}

		const isOAuth = this._modelRegistry.isUsingOAuth(model);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getCompactionRequestAuth(model: Model<any>): Promise<CompactionRequestAuth> {
		if (this.agent.streamFn === streamSimple) {
			return this._getRequiredRequestAuth(model);
		}

		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		return result.ok ? { apiKey: result.apiKey, headers: result.headers } : {};
	}

	private _hookCommon(event: HookEventName, promptId = this._activePromptId) {
		const reference = this.session.getSessionReference();
		const hostPathApi = process.platform === "win32" ? win32 : posix;
		return {
			session_id: this.sessionId,
			// Session references are host-owned. Normalize lexically; never probe a remote filesystem.
			transcript_path: reference ? (process.platform === "win32" ? win32 : posix).normalize(reference) : "",
			cwd: hostPathApi.normalize(this._cwd),
			hook_event_name: event,
			...(promptId ? { prompt_id: promptId } : {}),
		};
	}
	private _emitHookExecution(notice: HookExecutionNotice): void {
		for (const listener of [...this._hookExecutionListeners]) {
			try {
				listener(notice);
			} catch {
				// UI observers must not affect hook behavior.
			}
		}
	}
	private async _runHook(input: HookInput, activeSignal?: AbortSignal): Promise<HookAggregateResult> {
		const loadedHooks = this._loadedHooks;
		if (!this._hooksEnabled || !loadedHooks || loadedHooks.handlers.length === 0) {
			return {
				continue: true,
				blocked: false,
				additionalContext: [],
				systemMessages: [],
				plainText: [],
				results: [],
			};
		}
		const signals = [this._hookAbortController.signal, activeSignal].filter(
			(signal): signal is AbortSignal => signal !== undefined,
		);
		const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
		const aggregate = await runHooks(loadedHooks, input, {
			...this._hookRunOptions,
			signal,
			toolOperations: this.getToolOperations(),
		});
		for (const result of aggregate.results) {
			if (result.diagnostic) this._onHookDiagnostic?.(result.diagnostic);
		}
		for (const message of aggregate.systemMessages) {
			this._reportHookDiagnostic({
				level: "warning",
				code: "system-message",
				event: input.hook_event_name,
				message: `Hook systemMessage: ${message}`,
			});
		}
		if (aggregate.results.length > 0) this._emitHookExecution(createHookExecutionNotice(input, aggregate));
		return aggregate;
	}

	private _hasMatchingToolHook(event: ToolHookEventName, toolName: string): boolean {
		if (!this._hooksEnabled) return false;
		const handlerMayMatchTool = (condition: string | undefined): boolean => {
			if (condition === undefined) return true;
			const open = condition.indexOf("(");
			return open < 1
				? matchHookValue(condition, toolName).matches
				: condition.endsWith(")") && condition.slice(0, open) === toolName;
		};
		return (
			this._loadedHooks?.handlers.some(
				(handler) =>
					handler.event === event &&
					matchHookValue(handler.matcher, toolName).matches &&
					handlerMayMatchTool(handler.handler.if),
			) ?? false
		);
	}

	private _hookContextMessage(context: readonly string[]): CustomMessage | undefined {
		if (context.length === 0) return undefined;
		return {
			role: "custom",
			customType: "claude-hook-context",
			content: [{ type: "text", text: context.join("\n\n") }],
			display: false,
			timestamp: Date.now(),
		};
	}

	private async _ensureHookSessionStarted(promptId: string): Promise<CustomMessage | undefined> {
		this._hookSessionStartPromise ??= (async () => {
			const reason = this._sessionStartEvent.reason;
			const source =
				reason === "resume" ? "resume" : reason === "fork" ? "fork" : reason === "new" ? "clear" : "startup";
			const result = await this._runHook({
				...this._hookCommon("SessionStart", promptId),
				hook_event_name: "SessionStart",
				source,
				model: this.model ? `${this.model.provider}/${this.model.id}` : undefined,
				session_title: this.sessionName,
			});
			if (!result.continue) {
				this._hookSessionStartTerminationReason = result.reason ?? "Session start terminated by hook";
				throw new Error(this._hookSessionStartTerminationReason);
			}
			this._pendingHookSessionStartContext = this._hookContextMessage(result.additionalContext);
			return this._pendingHookSessionStartContext;
		})();
		return await this._hookSessionStartPromise;
	}

	private _reportHookDiagnostic(diagnostic: HookDiagnostic): void {
		this._onHookDiagnostic?.(diagnostic);
	}

	private _adaptPreToolHookInput(execution: PreToolHookExecution): PreToolInputAdaptation {
		try {
			const jsonArgs = toJsonValue(execution.args) as JsonObject;
			const input = execution.adaptToolInput
				? adaptFileToolInputForClaudeHook(
						execution.toolCall.name,
						jsonArgs,
						execution.backend.cwd,
						execution.flavor,
						hookPathHome(execution.backend, execution.flavor),
					)
				: jsonArgs;
			return { ok: true, input };
		} catch (error) {
			const reason = `Hook file path adaptation failed closed: ${error instanceof Error ? error.message : String(error)}`;
			this._reportHookDiagnostic({ level: "error", code: "policy", event: "PreToolUse", message: reason });
			return { ok: false, blockResult: { block: true, reason } };
		}
	}

	private _resolvePreToolHookPolicy(hookResult: HookAggregateResult): BeforeToolCallResult | undefined {
		if (!hookResult.continue) {
			this.agent.abort();
			return { block: true, reason: hookResult.reason ?? "Hook terminated the active agent loop" };
		}
		if (hookResult.permissionDecision === "ask" || hookResult.permissionDecision === "defer") {
			const reason =
				hookResult.permissionDecision === "ask"
					? "Tool execution blocked: hook requested permission, but no permission engine is available"
					: "Tool execution blocked: hook deferred permission, but no permission engine is available";
			return {
				block: true,
				reason: capModelVisibleHookField([reason, ...hookResult.additionalContext].join("\n\n")),
			};
		}
		if (!hookResult.blocked && hookResult.permissionDecision !== "deny") return undefined;
		const feedback = [
			...new Set(
				[hookResult.reason, ...hookResult.additionalContext].filter(
					(value): value is string => value !== undefined && value.length > 0,
				),
			),
		];
		return {
			block: true,
			reason: feedback.length
				? capModelVisibleHookField(feedback.map(capModelVisibleHookField).join("\n\n"))
				: "Tool execution denied by hook",
		};
	}

	private _applyPreToolHookInputUpdate(
		execution: PreToolHookExecution,
		hookResult: HookAggregateResult,
	): BeforeToolCallResult | undefined {
		if (!hookResult.updatedInput) return undefined;
		const tool = execution.agentContext.tools?.find((candidate) => candidate.name === execution.toolCall.name);
		const mutableArgs = execution.args;
		if (!tool || !isRecord(mutableArgs)) {
			this._reportHookDiagnostic({
				level: "error",
				code: "unsupported-update",
				event: "PreToolUse",
				message: `Hook replaced input for ${execution.toolCall.name}, but validated replacement is unsupported`,
			});
			return { block: true, reason: "Hook tool input replacement could not be validated" };
		}
		try {
			const replacement = execution.adaptToolInput
				? adaptFileToolUpdatedInputFromClaudeHook(
						execution.toolCall.name,
						hookResult.updatedInput,
						execution.backend.cwd,
						execution.flavor,
						hookPathHome(execution.backend, execution.flavor),
					)
				: hookResult.updatedInput;
			const validated = validateToolArguments(tool, { ...execution.toolCall, arguments: replacement });
			if (!isRecord(validated)) throw new Error("replacement did not validate to an object");
			for (const key of Object.keys(mutableArgs)) delete mutableArgs[key];
			Object.assign(mutableArgs, validated);
			return undefined;
		} catch (error) {
			this._reportHookDiagnostic({
				level: "error",
				code: "unsupported-update",
				event: "PreToolUse",
				message: `Hook replacement for ${execution.toolCall.name} failed validation: ${error instanceof Error ? error.message : String(error)}`,
			});
			return { block: true, reason: "Hook tool input replacement failed validation" };
		}
	}

	private async _emitExtensionToolCall(execution: PreToolHookExecution): Promise<BeforeToolCallResult | undefined> {
		const runner = this._extensionRunner;
		if (!runner.hasHandlers("tool_call")) return undefined;
		try {
			const extensionResult = await runner.emitToolCall({
				type: "tool_call",
				toolName: execution.toolCall.name,
				toolCallId: execution.toolCall.id,
				input: execution.args as Record<string, unknown>,
			});
			if (extensionResult?.block) {
				this._toolStartedAt.delete(execution.toolCall.id);
				this._preToolHookContext.delete(execution.toolCall.id);
			}
			return extensionResult;
		} catch (error) {
			this._toolStartedAt.delete(execution.toolCall.id);
			this._preToolHookContext.delete(execution.toolCall.id);
			if (error instanceof Error) throw error;
			throw new Error(`Extension failed, blocking execution: ${String(error)}`);
		}
	}

	private async _handleBeforeToolCall(
		{ toolCall, args, context: agentContext }: BeforeToolCallContext,
		signal?: AbortSignal,
	): Promise<BeforeToolCallResult | undefined> {
		const backend = this.getToolBackendInfo();
		const flavor = hookPathFlavor(backend);
		const normalizedToolName = claudeToolName(toolCall.name);
		const execution: PreToolHookExecution = {
			toolCall,
			args,
			agentContext,
			backend,
			flavor,
			normalizedToolName,
			adaptToolInput: this._hasMatchingToolHook("PreToolUse", normalizedToolName),
		};
		const adaptation = this._adaptPreToolHookInput(execution);
		if (!adaptation.ok) return adaptation.blockResult;
		const hookResult = await this._runHook(
			{
				...this._hookCommon("PreToolUse"),
				hook_event_name: "PreToolUse",
				tool_name: normalizedToolName,
				tool_input: adaptation.input,
				tool_use_id: toolCall.id,
			},
			signal,
		);
		const policyBlock = this._resolvePreToolHookPolicy(hookResult);
		if (policyBlock) return policyBlock;
		const updateBlock = this._applyPreToolHookInputUpdate(execution, hookResult);
		if (updateBlock) return updateBlock;
		this._toolStartedAt.set(toolCall.id, Date.now());
		if (hookResult.additionalContext.length > 0) {
			this._preToolHookContext.set(toolCall.id, [...hookResult.additionalContext]);
		}
		return this._emitExtensionToolCall(execution);
	}

	private async _applyExtensionToolResult(state: PostToolCallState): Promise<void> {
		const runner = this._extensionRunner;
		if (!runner.hasHandlers("tool_result")) return;
		const extensionResult = await runner.emitToolResult({
			type: "tool_result",
			toolName: state.toolCall.name,
			toolCallId: state.toolCall.id,
			input: state.args as Record<string, unknown>,
			content: state.content,
			details: state.details,
			isError: state.isError,
		});
		if (!extensionResult) return;
		state.content = extensionResult.content ?? state.content;
		state.details = extensionResult.details;
		state.isError = extensionResult.isError ?? state.isError;
	}

	private async _runPostToolHook(
		state: PostToolCallState,
		started: number | undefined,
		signal?: AbortSignal,
	): Promise<PostToolHookRunResult> {
		const event: PostToolHookEvent = state.isError ? "PostToolUseFailure" : "PostToolUse";
		const normalizedToolName = claudeToolName(state.toolCall.name);
		const backend = this.getToolBackendInfo();
		const flavor = hookPathFlavor(backend);
		const jsonArgs = toJsonValue(state.args) as JsonObject;
		let toolInput = jsonArgs;
		if (this._hasMatchingToolHook(event, normalizedToolName)) {
			try {
				toolInput = adaptFileToolInputForClaudeHook(
					state.toolCall.name,
					jsonArgs,
					backend.cwd,
					flavor,
					hookPathHome(backend, flavor),
				);
			} catch (error) {
				this._preToolHookContext.delete(state.toolCall.id);
				this._reportHookDiagnostic({
					level: "warning",
					code: "execution",
					event,
					message: `Skipped ${event} for ${state.toolCall.name}: ${error instanceof Error ? error.message : String(error)}`,
				});
				return { ok: false };
			}
		}
		const common = {
			...this._hookCommon(event),
			tool_name: normalizedToolName,
			tool_input: toolInput,
			tool_use_id: state.toolCall.id,
			...(started ? { duration_ms: Date.now() - started } : {}),
		};
		const hookResult = state.isError
			? await this._runHook(
					{
						...common,
						hook_event_name: "PostToolUseFailure",
						error: state.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n"),
					},
					signal,
				)
			: await this._runHook(
					{
						...common,
						hook_event_name: "PostToolUse",
						tool_response: toJsonValue({ content: state.content, details: state.details }),
					},
					signal,
				);
		return { ok: true, hookResult };
	}

	private _applyPostToolOutputUpdate(state: PostToolCallState, hookResult: HookAggregateResult): void {
		if (hookResult.updatedToolOutput === undefined) return;
		const builtIn = Object.hasOwn(CLAUDE_TOOL_NAMES, state.toolCall.name);
		const replacement =
			builtIn && typeof hookResult.updatedToolOutput !== "string"
				? undefined
				: normalizeHookToolOutput(hookResult.updatedToolOutput);
		if (replacement) {
			state.content = replacement.content;
			if (replacement.details !== undefined) state.details = replacement.details;
			return;
		}
		this._reportHookDiagnostic({
			level: "warning",
			code: "unsupported-update",
			event: state.isError ? "PostToolUseFailure" : "PostToolUse",
			message: builtIn
				? "Unsupported built-in tool output replacement was ignored; only a string replacement is safe"
				: "Invalid tool output replacement was ignored; expected a string or { content } result shape",
		});
	}

	private _finalizePostToolHookResult(state: PostToolCallState, hookResult: HookAggregateResult): AfterToolCallResult {
		const feedback = [
			...(this._preToolHookContext.get(state.toolCall.id) ?? []),
			...hookResult.additionalContext,
			...(hookResult.blocked && hookResult.reason ? [hookResult.reason] : []),
		];
		this._preToolHookContext.delete(state.toolCall.id);
		if (feedback.length > 0) {
			state.content = [
				...state.content,
				{ type: "text", text: `Hook feedback:\n${[...new Set(feedback)].join("\n\n")}` },
			];
		}
		if (!hookResult.continue) this.agent.abort();
		return { content: state.content, details: state.details, isError: state.isError };
	}

	private async _handleAfterToolCall(
		{ toolCall, args, result, isError }: AfterToolCallContext,
		signal?: AbortSignal,
	): Promise<AfterToolCallResult> {
		this._loadAssociatedToolsForReadToolCall(toolCall.name, args, isError);
		const lspResult = await this._syncLspToolResult(toolCall.name, args, result, isError);
		const state: PostToolCallState = {
			toolCall,
			args,
			content: lspResult?.content ?? result.content,
			details: lspResult?.details ?? result.details,
			isError: lspResult?.isError ?? isError,
		};
		await this._applyExtensionToolResult(state);
		const started = this._toolStartedAt.get(toolCall.id);
		this._toolStartedAt.delete(toolCall.id);
		const hookRun = await this._runPostToolHook(state, started, signal);
		if (!hookRun.ok) {
			return { content: state.content, details: state.details, isError: state.isError };
		}
		this._applyPostToolOutputUpdate(state, hookRun.hookResult);
		return this._finalizePostToolHookResult(state, hookRun.hookResult);
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = (context, signal) => this._handleBeforeToolCall(context, signal);

		// Deterministic post order: built-in LSP synchronization, extension tool_result, then Claude PostToolUse*.
		this.agent.afterToolCall = (context, signal) => this._handleAfterToolCall(context, signal);
	}

	private _beginActivity(kind: string): SessionActivityToken {
		const token: SessionActivityToken = { active: true, kind };
		this._activities.add(token);
		this._activityGeneration++;
		this._activeCycle = true;
		return token;
	}

	private _endActivity(token: SessionActivityToken): void {
		if (!token.active) return;
		token.active = false;
		this._activities.delete(token);
		this._activityGeneration++;
		this._scheduleSettlementCheck();
	}

	private _runActivity<T>(kind: string, operation: () => Promise<T>): Promise<T> {
		if (this._disposed) return Promise.reject(new Error("Agent session is disposed"));
		const token = this._beginActivity(kind);
		const owner: BarrierOwnerScope = { active: true, label: kind };
		return this._barrierOwnerContext.run(owner, async () => {
			try {
				return await operation();
			} finally {
				owner.active = false;
				this._endActivity(token);
			}
		});
	}

	private _runSynchronousActivity<T>(kind: string, operation: () => T): T {
		const token = this._beginActivity(kind);
		try {
			return this._runBarrierCallback(kind, operation);
		} finally {
			this._endActivity(token);
		}
	}

	private _runAsyncBarrierCallback<T>(label: string, callback: () => Promise<T>): Promise<T> {
		const owner: BarrierOwnerScope = { active: true, label };
		return this._barrierOwnerContext.run(owner, async () => {
			try {
				return await callback();
			} finally {
				owner.active = false;
			}
		});
	}

	private _runBarrierCallback<T>(label: string, callback: () => T): T {
		const owner: BarrierOwnerScope = { active: true, label };
		return this._barrierOwnerContext.run(owner, () => {
			try {
				return callback();
			} finally {
				owner.active = false;
			}
		});
	}

	private _isSettledPredicate(): boolean {
		return (
			this._activities.size === 0 &&
			!this.agent.state.isStreaming &&
			this._retryAbortController === undefined &&
			this._compactionInFlight === undefined &&
			this._compactionAbortController === undefined &&
			this._autoCompactionAbortController === undefined &&
			this._branchSummaryAbortController === undefined &&
			this._extensionCompactionQueue.length === 0 &&
			this._extensionCompactionTimer === undefined &&
			!this._extensionCompactionRunning &&
			this._bashAbortControllers.size === 0 &&
			this._pendingBashMessages.length === 0 &&
			this._steeringMessages.length === 0 &&
			this._followUpMessages.length === 0 &&
			!this.agent.hasQueuedMessages()
		);
	}

	private _scheduleSettlementCheck(): void {
		if (this._settlementScheduled || this._settlementRunning) return;
		this._settlementScheduled = true;
		queueMicrotask(() => {
			this._settlementScheduled = false;
			void this._drainSettlement();
		});
	}
	private _isCurrentSettlementGeneration(generation: number): boolean {
		return this._isSettledPredicate() && generation === this._activityGeneration;
	}

	private async _finishSettledAgentCycle(generation: number): Promise<boolean> {
		if (!this._activeCycle) return true;
		await this._runAsyncBarrierCallback("agent_settled extension handler", () =>
			this._extensionRunner.emit({ type: "agent_settled" }),
		);
		if (!this._isCurrentSettlementGeneration(generation)) return false;
		this._emitAgentSettled();
		if (!this._isCurrentSettlementGeneration(generation)) return false;
		this._activeCycle = false;
		return true;
	}

	private async _drainSettlement(): Promise<void> {
		if (this._settlementRunning) return;
		this._settlementRunning = true;
		try {
			let finished = false;
			while (this._isSettledPredicate()) {
				const generation = this._activityGeneration;
				if (!(await this._finishSettledAgentCycle(generation))) continue;
				finished = true;
				break;
			}
			if (!finished) return;
			for (const waiter of this._idleWaiters) waiter.resolve();
			this._idleWaiters.clear();
		} finally {
			this._settlementRunning = false;
			if ((this._activeCycle || this._idleWaiters.size > 0) && this._isSettledPredicate()) {
				this._scheduleSettlementCheck();
			}
		}
	}

	private _runRuntimeLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
		const token: RuntimeLifecycleOperationToken = {
			active: true,
			children: new Set(),
			childQueue: Promise.resolve(),
		};
		return this._runtimeLifecycleContext.run(token, async () => {
			try {
				return await this._runAsyncBarrierCallback("runtime lifecycle operation", operation);
			} finally {
				while (token.children.size > 0) {
					await Promise.allSettled([...token.children]);
				}
				token.active = false;
			}
		});
	}

	private _enqueueRuntimeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
		const activity = this._beginActivity("runtime lifecycle");
		const currentToken = this._runtimeLifecycleContext.getStore();
		if (currentToken?.active) {
			const child = currentToken.childQueue.then(() => this._runRuntimeLifecycleOperation(operation));
			currentToken.childQueue = child.then(
				() => undefined,
				() => undefined,
			);
			currentToken.children.add(child);
			void child.then(
				() => {
					currentToken.children.delete(child);
					this._endActivity(activity);
				},
				() => {
					currentToken.children.delete(child);
					this._endActivity(activity);
				},
			);
			return child;
		}
		const result = this._runtimeLifecycleQueue.then(() => this._runRuntimeLifecycleOperation(operation));
		this._runtimeLifecycleQueue = result.then(
			() => undefined,
			() => undefined,
		);
		void result.then(
			() => this._endActivity(activity),
			() => this._endActivity(activity),
		);
		return result;
	}

	private async _syncLspToolResult(
		toolName: string,
		args: unknown,
		result: LspToolResult,
		isError: boolean,
	): Promise<LspToolResultUpdate | undefined> {
		const runtime = this._lspRuntimeState;
		if (isError || !runtime || typeof args !== "object" || args === null || !("path" in args)) {
			return undefined;
		}
		const filePath = typeof args.path === "string" ? args.path : undefined;
		if (!filePath) return undefined;

		try {
			if (toolName === "read") {
				await runtime.fileSync.handleFileRead(filePath, this.getToolOperations());
				return undefined;
			}

			if (toolName === "write" || toolName === "edit") {
				await runtime.fileSync.handleFileWrite(filePath, this.getToolOperations());
				const diagnostics = await formatAutoDiagnosticsForChangedFile(runtime, filePath);
				if (!diagnostics) return undefined;
				return {
					content: [...result.content, { type: "text" as const, text: `\n\n${diagnostics}` }],
					details: result.details,
					isError,
				};
			}
		} catch {
			// LSP synchronization is best-effort and must not affect tool results.
		}

		return undefined;
	}
	private _loadAssociatedInstructionTools(resource: InstructionResource): void {
		for (const toolName of resource.tools ?? []) {
			this.loadSessionTool(toolName);
		}
	}

	private _loadAssociatedToolsForReadToolCall(toolName: string, args: unknown, isError: boolean): void {
		if (toolName !== "read" || isError || typeof args !== "object" || args === null) {
			return;
		}
		const readArgs = args as { path?: unknown; file_path?: unknown };
		const rawPath = typeof readArgs.path === "string" ? readArgs.path : readArgs.file_path;
		if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
			return;
		}

		const readPath = canonicalizePath(resolvePath(rawPath, this._cwd));
		for (const skill of this.getRegisteredSkills()) {
			if (canonicalizePath(resolvePath(skill.filePath, this._cwd)) === readPath) {
				this._loadAssociatedInstructionTools(skill);
			}
		}
		for (const rule of this.getRegisteredRules()) {
			if (canonicalizePath(resolvePath(rule.filePath, this._cwd)) === readPath) {
				this._loadAssociatedInstructionTools(rule);
			}
		}
	}

	private _installAgentTurnPreparation(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const previousUpdate = await previousPrepareNextTurnWithContext?.(turn, signal);
			const compacted = await this._drainExtensionCompactionQueue("between-turns");

			// Always rebuild the loop context so session-driven changes to the active
			// tool set and system prompt (e.g. load_tool / unload_tool) take effect on
			// the next turn within the same run instead of waiting for a new prompt.
			return {
				...previousUpdate,
				context: this._buildCurrentAgentContext(compacted ? undefined : (previousUpdate?.context ?? turn.context)),
			} satisfies AgentLoopTurnUpdate;
		};
	}

	private _buildCurrentAgentContext(previousContext?: AgentContext): AgentContext {
		return {
			systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
			messages: previousContext?.messages ?? this.agent.state.messages.slice(),
			tools: this.agent.state.tools.slice(),
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		this._runBarrierCallback(`public ${event.type} listener`, () => {
			for (const listener of this._eventListeners) listener(event);
		});
	}

	private _emitAgentSettled(): void {
		for (const listener of [...this._eventListeners]) {
			try {
				this._runBarrierCallback("public agent_settled listener", () => listener({ type: "agent_settled" }));
			} catch (error) {
				try {
					this._extensionRunner.emitError({
						extensionPath: "<session-subscriber>",
						event: "agent_settled",
						error: error instanceof Error ? error.message : String(error),
					});
				} catch {
					// Subscriber diagnostics must never prevent settlement or later listeners.
				}
			}
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	private _consumeStartedQueuedMessage(event: AgentEvent): void {
		if (event.type !== "message_start" || event.message.role !== "user") return;
		this._overflowRecoveryAttempted = false;
		const messageText = this._getUserMessageText(event.message);
		if (!messageText) return;

		const queuedIds = this._queuedPromptIds.get(messageText);
		const queuedId = queuedIds?.shift();
		if (queuedId) this._activePromptId = queuedId;
		if (queuedIds?.length === 0) this._queuedPromptIds.delete(messageText);

		const steeringIndex = this._steeringMessages.indexOf(messageText);
		if (steeringIndex !== -1) {
			this._steeringMessages.splice(steeringIndex, 1);
			this._emitQueueUpdate();
			return;
		}
		const followUpIndex = this._followUpMessages.indexOf(messageText);
		if (followUpIndex === -1) return;
		this._followUpMessages.splice(followUpIndex, 1);
		this._emitQueueUpdate();
	}

	private _persistCompletedMessage(message: AgentMessage): void {
		if (message.role === "custom") {
			this.session.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
			return;
		}
		if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
			this.session.appendMessage(message);
		}
	}

	private _updateRetryStateAfterAssistantMessage(message: AgentMessage): void {
		if (message.role !== "assistant") return;
		const assistantMessage = message as AssistantMessage;
		this._lastAssistantMessage = assistantMessage;
		if (assistantMessage.stopReason === "error") return;
		this._overflowRecoveryAttempted = false;
		if (this._retryAttempt === 0) return;
		this._emit({
			type: "auto_retry_end",
			success: true,
			attempt: this._retryAttempt,
		});
		this._retryAttempt = 0;
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// afterToolCall can be skipped when a prepared call is aborted. Never retain per-run tool state.
		if (event.type === "agent_end") {
			this._toolStartedAt.clear();
			this._preToolHookContext.clear();
		}
		this._consumeStartedQueuedMessage(event);

		// Extensions observe the event before public session listeners.
		await this._runAsyncBarrierCallback(`extension ${event.type} handler`, () => this._emitExtensionEvent(event));
		this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);
		if (event.type === "agent_end") this._scheduleExtensionCompactions();

		if (event.type === "message_end") {
			this._persistCompletedMessage(event.message);
			this._updateRetryStateAfterAssistantMessage(event.message);
		}
	};

	private _willRetryAfterAgentEnd(event: CoreAgentEndEvent): boolean {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	/** Extract text content from a message */
	private _getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const content = message.content;
		if (typeof content === "string") return content;
		const textBlocks = content.filter((c) => c.type === "text");
		return textBlocks.map((c) => (c as TextContent).text).join("");
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// Session persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				this._replaceMessageInPlace(event.message, normalizeMessageContent(replacement));
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/** Subscribe to completed hook executions for host UI rendering. Notices are not persisted or added to model context. */
	subscribeToHookExecutions(listener: HookExecutionListener): () => void {
		this._hookExecutionListeners.add(listener);
		return () => this._hookExecutionListeners.delete(listener);
	}

	/** Whether this session will dispatch subsequent configured hook events. */
	get hooksEnabled(): boolean {
		return this._hooksEnabled;
	}

	/** Enable or disable subsequent hook dispatches for this session. Active hook executions are not cancelled. */
	setHooksEnabled(enabled: boolean): void {
		this._hooksEnabled = enabled;
	}
	/** Disconnect from agent events during disposal. */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/** Emit the bounded host-local SessionEnd hook once before replacement/disposal. */
	async emitHookSessionEnd(reason: SessionEndReason): Promise<void> {
		if (this._hookSessionEnded) return;
		this._hookSessionEnded = true;
		await this._runHook({
			...this._hookCommon("SessionEnd"),
			hook_event_name: "SessionEnd",
			reason,
		});
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): Promise<void> {
		this._disposed = true;
		this._disposePromise ??= this._dispose();
		return this._disposePromise;
	}

	/** Stop new prompt admission, abort active work, and wait for the session boundary. */
	prepareForShutdown(): Promise<void> {
		this._disposed = true;
		this._shutdownPreparationPromise ??= this._prepareForShutdown();
		return this._shutdownPreparationPromise;
	}

	private async _prepareForShutdown(): Promise<void> {
		this._hookAbortController.abort();
		if (this._steeringMessages.length > 0 || this._followUpMessages.length > 0 || this.agent.hasQueuedMessages()) {
			this.clearQueue();
		}
		for (const abort of [
			() => this.abortRetry(),
			() => this.abortCompaction(),
			() => this.abortBranchSummary(),
			() => this.abortBash(),
			() => this.agent.abort(),
		]) {
			try {
				abort();
			} catch {
				// Shutdown continues if an abort hook throws.
			}
		}

		if (this._extensionCompactionTimer !== undefined) {
			clearTimeout(this._extensionCompactionTimer);
			this._extensionCompactionTimer = undefined;
		}
		this._extensionCompactionQueue = [];
		if (this._extensionCompactionActivity) {
			this._endActivity(this._extensionCompactionActivity);
			this._extensionCompactionActivity = undefined;
		}
		await this._runtimeLifecycleQueue;
		await this.waitForIdle();
	}

	private async _dispose(): Promise<void> {
		await this.prepareForShutdown();
		await this._sandboxTransitionQueue;

		this._extensionRunner.invalidate(STALE_EXTENSION_CONTEXT_MESSAGE);
		this._disconnectFromAgent();
		this._eventListeners = [];
		this._hookExecutionListeners.clear();
		cleanupSessionResources(this.sessionId);

		const localResourceToolOperations = this._localResourceToolOperations;
		const lspRuntimeState = this._lspRuntimeState;
		const workspaceToolHost = this._workspaceToolHost;
		const retiredWorkspaceToolHosts = this._retiredWorkspaceToolHosts;
		const sandboxToolOperations = this._sandboxToolOperations;
		this._localResourceToolOperations = undefined;
		this._lspRuntimeState = undefined;
		this._workspaceToolHost = undefined;
		this._retiredWorkspaceToolHosts = [];
		this._sandboxToolOperations = undefined;
		this._preSandboxToolOperations = undefined;
		await Promise.allSettled([
			Promise.resolve().then(() => localResourceToolOperations?.dispose?.()),
			Promise.resolve().then(() => lspRuntimeState?.manager.shutdownAll()),
			Promise.resolve().then(() => workspaceToolHost?.dispose()),
			Promise.resolve().then(() => sandboxToolOperations?.dispose()),
			...retiredWorkspaceToolHosts.map((host) => Promise.resolve().then(() => host.dispose())),
		]);
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Whether the underlying Agent is currently streaming a response. */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming;
	}

	private get _hasActiveAgentRun(): boolean {
		if (this.agent.state.isStreaming) return true;
		for (const activity of this._activities) {
			if (activity.kind === "agent run") return true;
		}
		return false;
	}

	private _hasPromptAdmission(excluded?: SessionActivityToken): boolean {
		for (const activity of this._activities) {
			if (activity !== excluded && activity.kind === "prompt admission") return true;
		}
		return false;
	}

	private get _isAgentRunActive(): boolean {
		return this._hasActiveAgentRun || this._hasPromptAdmission();
	}

	/** Whether all session-owned work and settlement callbacks have completed. */
	get isIdle(): boolean {
		return this._isSettledPredicate() && !this._activeCycle && !this._settlementRunning && !this._settlementScheduled;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values())
			.filter(({ definition }) => this._isToolPermitted(definition.name))
			.map(({ definition, sourceInfo }) => ({
				name: definition.name,
				description: definition.description,
				parameters: definition.parameters,
				sourceInfo,
			}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		if (!this._isToolPermitted(name)) return undefined;
		return this._toolDefinitions.get(name)?.definition ?? this._sessionTools.get(name)?.definition;
	}

	getRegisteredSkills(): Skill[] {
		const sessionSkillNames = new Set(this._sessionSkills.keys());
		return [
			...Array.from(this._sessionSkills.values()),
			...this._resourceLoader.getSkills().skills.filter((skill) => !sessionSkillNames.has(skill.name)),
		];
	}

	getRegisteredRules(): Rule[] {
		const sessionRuleNames = new Set(this._sessionRules.keys());
		return [
			...Array.from(this._sessionRules.values()),
			...this._resourceLoader.getRules().rules.filter((rule) => !sessionRuleNames.has(rule.name)),
		];
	}

	registerSessionSkill(skill: SessionSkillRegistration): void {
		const filePath = skill.filePath || `<session-skill:${skill.name}>`;
		const baseDir = skill.baseDir || (skill.filePath ? dirname(skill.filePath) : this._cwd);
		this._sessionSkills.set(skill.name, {
			...skill,
			filePath,
			baseDir,
			sourceInfo: skill.sourceInfo ?? createSyntheticSourceInfo(filePath, { source: "session", baseDir }),
		});
		this.setActiveToolsByName(this.getActiveToolNames());
	}

	unregisterSessionSkill(name: string): boolean {
		const deleted = this._sessionSkills.delete(name);
		if (deleted) {
			this.setActiveToolsByName(this.getActiveToolNames());
		}
		return deleted;
	}

	registerSessionRule(rule: SessionRuleRegistration): void {
		const filePath = rule.filePath || `<session-rule:${rule.name}>`;
		const baseDir = rule.baseDir || (rule.filePath ? dirname(rule.filePath) : this._cwd);
		this._sessionRules.set(rule.name, {
			...rule,
			filePath,
			baseDir,
			sourceInfo: rule.sourceInfo ?? createSyntheticSourceInfo(filePath, { source: "session", baseDir }),
		});
		this.setActiveToolsByName(this.getActiveToolNames());
	}

	unregisterSessionRule(name: string): boolean {
		const deleted = this._sessionRules.delete(name);
		if (deleted) {
			this.setActiveToolsByName(this.getActiveToolNames());
		}
		return deleted;
	}

	registerSessionTool(definition: ToolDefinition, options: RegisterSessionToolOptions = {}): void {
		if (!this._isToolPermitted(definition.name)) return;
		this._sessionTools.set(definition.name, {
			definition,
			sourceInfo:
				options.sourceInfo ?? createSyntheticSourceInfo(`<session:${definition.name}>`, { source: "session" }),
			lazy: options.lazy === true,
			loaded: options.lazy !== true,
		});
		this._refreshToolRegistry();
		if (options.lazy === true) {
			const activeTools = new Set(this.getActiveToolNames());
			activeTools.add("load_tool");
			activeTools.add("unload_tool");
			this.setActiveToolsByName(Array.from(activeTools));
		}
	}

	unregisterSessionTool(name: string): boolean {
		const deleted = this._sessionTools.delete(name);
		if (deleted) {
			this._refreshToolRegistry();
		}
		return deleted;
	}

	loadSessionTool(name: string): boolean {
		return this._runSynchronousActivity("lazy tool load", () => this._loadSessionTool(name));
	}

	private _loadSessionTool(name: string): boolean {
		if (!this._isToolPermitted(name)) return false;
		const tool = this._sessionTools.get(name);
		if (tool) {
			if (!tool.loaded) {
				tool.loaded = true;
				this._refreshToolRegistry();
			}
			return true;
		}
		const loaded = this._extensionRunner.loadRegisteredTool(name);
		if (loaded) {
			this._refreshToolRegistry();
		}
		return loaded;
	}

	unloadSessionTool(name: string): boolean {
		return this._runSynchronousActivity("lazy tool unload", () => this._unloadSessionTool(name));
	}

	private _unloadSessionTool(name: string): boolean {
		if (!this._isToolPermitted(name)) return false;
		const tool = this._sessionTools.get(name);
		if (tool) {
			if (tool.loaded) {
				tool.loaded = false;
				this._refreshToolRegistry();
			}
			return true;
		}
		const unloaded = this._extensionRunner.unloadRegisteredTool(name);
		if (unloaded) {
			this._refreshToolRegistry();
		}
		return unloaded;
	}

	getAvailableSessionTools(): ToolInfo[] {
		return [...Array.from(this._sessionTools.values()), ...this._extensionRunner.getAvailableRegisteredTools()]
			.filter(({ definition }) => this._isToolPermitted(definition.name))
			.map(({ definition, sourceInfo }) => ({
				name: definition.name,
				description: definition.description,
				parameters: definition.parameters,
				sourceInfo,
			}));
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._compactionInFlight !== undefined ||
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): QueueMode {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): QueueMode {
		return this.agent.followUpMode;
	}

	/** Current session reference, or undefined for ephemeral sessions. */
	get sessionReference(): string | undefined {
		return this.session.getSessionReference();
	}

	/** Current local session file path, or undefined for non-file-backed sessions. Prefer sessionReference for backend-neutral code. */
	get sessionFile(): string | undefined {
		return this.sessionReference;
	}

	/** Current session ID */
	get sessionId(): string {
		return this.session.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.session.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<ScopedModel> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: ScopedModel[]): void {
		this._scopedModels = scopedModels;
		this._refreshModelDependentRuntime();
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPromptParts = [...loaderAppendSystemPrompt];
		const availableToolsPrompt = this._buildAvailableToolsPrompt();
		if (availableToolsPrompt) {
			appendSystemPromptParts.push(availableToolsPrompt);
		}
		const appendSystemPrompt = appendSystemPromptParts.length > 0 ? appendSystemPromptParts.join("\n\n") : undefined;
		const loadedSkills = this.getRegisteredSkills();
		const loadedRules = this.getRegisteredRules();
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = {
			cwd: this._toolOperations?.cwd ?? this._cwd,
			skills: loadedSkills,
			rules: loadedRules,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
		};
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	private _buildAvailableToolsPrompt(): string | undefined {
		const tools = [
			...Array.from(this._sessionTools.values()).filter((tool) => tool.lazy),
			...this._extensionRunner.getAvailableRegisteredTools(),
		].filter((tool) => this._isToolPermitted(tool.definition.name));
		if (tools.length === 0) {
			return undefined;
		}

		const lines = [
			"<available-tools>",
			"These tools are session-scoped and can be loaded into the active tool context with load_tool when needed, then unloaded with unload_tool when no longer needed.",
		];
		for (const tool of tools) {
			const loaded = tool.loaded ? ' loaded="true"' : "";
			lines.push(
				`  <tool name="${escapeXmlAttribute(tool.definition.name)}"${loaded} description="${escapeXmlAttribute(
					tool.definition.description,
				)}" />`,
			);
		}
		lines.push("</available-tools>");
		return lines.join("\n");
	}

	private _refreshBaseSystemPrompt(): void {
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
	}

	private _getSubagentModels(): Model<any>[] {
		return this._scopedModels.length > 0
			? this._scopedModels.map((scoped) => scoped.model)
			: this._modelRegistry.getAvailable();
	}

	private _resolveSubagentModelHint(hint: SubagentModelHint): string | undefined {
		const currentModel = this.model;
		if (!currentModel) return undefined;
		const formatModel = (model: Model<any>): string => `${model.provider}/${model.id}`;
		if (hint === "same-as-parent") return formatModel(currentModel);
		const candidates = this._getSubagentModels().filter((model) => model.provider === currentModel.provider);
		if (candidates.length === 0) return undefined;
		const cost = (model: Model<any>): number => model.cost.input + model.cost.output;
		const byCost = [...candidates].sort((a, b) => cost(a) - cost(b));
		if (hint === "cheapest" || hint === "fastest") return formatModel(byCost[0]);
		if (hint === "large-context") {
			return formatModel([...candidates].sort((a, b) => b.contextWindow - a.contextWindow)[0]);
		}
		if (hint === "best-reasoning") {
			const reasoning = candidates.filter((model) => model.reasoning);
			return formatModel(
				(reasoning.length > 0 ? reasoning : candidates).sort(
					(a, b) => b.contextWindow + b.maxTokens - (a.contextWindow + a.maxTokens),
				)[0],
			);
		}
		if (hint === "strongest") {
			return formatModel(
				[...candidates].sort(
					(a, b) =>
						Number(b.reasoning) - Number(a.reasoning) ||
						b.contextWindow + b.maxTokens - (a.contextWindow + a.maxTokens),
				)[0],
			);
		}
		const reasoningByCost = byCost.find((model) => model.reasoning);
		return formatModel(reasoningByCost ?? byCost[0]);
	}

	private _refreshModelDependentRuntime(): void {
		if (!this._baseToolsOverride && this._baseToolDefinitions.has("subagent")) {
			this._baseToolDefinitions.set(
				"subagent",
				createSubagentToolDefinition({
					runner: this._subagentRunner,
					modelCatalog: formatSubagentModelCatalog(this.model, this._getSubagentModels()),
					resolveModelHint: (hint) => this._resolveSubagentModelHint(hint),
					trustProjectAgents: this._trustProjectAgents,
					runRegistry: this._subagentRunRegistry,
					configRegistry: this._subagentConfigRegistry,
				}) as unknown as ToolDefinition,
			);
			this._refreshToolRegistry({ activeToolNames: this.getActiveToolNames() });
			return;
		}
		this._refreshBaseSystemPrompt();
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private async _continueAgentIfReady(): Promise<boolean> {
		const lastMessage = this.agent.state.messages.at(-1);
		if (lastMessage?.role === "assistant" && !this.agent.hasQueuedMessages()) {
			return false;
		}
		await this.agent.continue();
		return true;
	}

	private _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		return this._runActivity("agent run", async () => {
			try {
				await this.agent.prompt(messages);
				while (await this._handlePostAgentRun()) {
					if (!(await this._continueAgentIfReady())) break;
				}
			} finally {
				this._systemPromptOverride = undefined;
				this._flushPendingBashMessages();
			}
		});
	}

	private _finishFailedRetry(message: AssistantMessage): void {
		if (message.stopReason !== "error" || this._retryAttempt <= 0) return;
		this._emit({
			type: "auto_retry_end",
			success: false,
			attempt: this._retryAttempt,
			finalError: message.errorMessage,
		});
		this._retryAttempt = 0;
	}
	private _resetStopHookContinuationState(): void {
		this._stopHookContinuations = 0;
		this._stopHookProgress = undefined;
	}

	private _recordStopHookProgress(progress: number | undefined): boolean {
		if (progress === undefined) {
			this._stopHookProgress = undefined;
			return false;
		}
		if (!this._stopHookProgress || progress < this._stopHookProgress.best) {
			this._stopHookProgress = { best: progress, consecutiveNonImprovingCalls: 0 };
			return true;
		}
		this._stopHookProgress.consecutiveNonImprovingCalls++;
		return this._stopHookProgress.consecutiveNonImprovingCalls <= STOP_HOOK_PROGRESS_REGRESSION_TOLERANCE;
	}

	private async _runStopFailureHook(message: AssistantMessage): Promise<void> {
		const details = message.errorMessage ?? "Assistant response failed";
		await this._runHook({
			...this._hookCommon("StopFailure"),
			hook_event_name: "StopFailure",
			error: classifyStopFailure(details),
			error_details: details,
			last_assistant_message: getAssistantText(message),
		});
		this._resetStopHookContinuationState();
	}

	private async _runStopHook(message: AssistantMessage): Promise<boolean> {
		const stopResult = await this._runHook({
			...this._hookCommon("Stop"),
			hook_event_name: "Stop",
			stop_hook_active: this._stopHookContinuations > 0,
			last_assistant_message: getAssistantText(message),
		});
		if (!stopResult.continue) {
			// Aggregate termination is not a request for another model turn.
			this._resetStopHookContinuationState();
			return false;
		}
		if (!stopResult.blocked) {
			this._resetStopHookContinuationState();
			return false;
		}
		const progressAllowsExtendedContinuation = this._recordStopHookProgress(stopResult.stopContinuationProgress);
		if (this._stopHookContinuations >= DEFAULT_STOP_HOOK_CONTINUATION_LIMIT && !progressAllowsExtendedContinuation) {
			this._reportHookDiagnostic({
				level: "warning",
				code: "continuation-cap",
				event: "Stop",
				message: `Stop hook continuation limit (${DEFAULT_STOP_HOOK_CONTINUATION_LIMIT}) reached without recent progress; settling the session`,
			});
			this._resetStopHookContinuationState();
			return false;
		}
		const values = [stopResult.reason, ...stopResult.additionalContext].filter((value): value is string =>
			Boolean(value),
		);
		const feedback =
			capModelVisibleHookField([...new Set(values)].join("\n\n")) || "A Stop hook requested another model turn.";
		this._stopHookContinuations++;
		this.agent.followUp({
			role: "custom",
			customType: "claude-stop-hook-feedback",
			content: [{ type: "text", text: feedback }],
			display: false,
			timestamp: Date.now(),
		});
		return true;
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const message = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		if (!message) return false;

		// A user abort is not an assistant stop/failure lifecycle event.
		if (message.stopReason === "aborted") {
			this._resetStopHookContinuationState();
			return this.agent.hasQueuedMessages();
		}
		if (this._isRetryableError(message) && (await this._prepareRetry(message))) return true;
		this._finishFailedRetry(message);
		if (await this._checkCompaction(message)) return true;
		if (message.stopReason === "error") await this._runStopFailureHook(message);
		else if (await this._runStopHook(message)) return true;

		// The agent loop drains both queues before emitting agent_end. Any messages
		// here were queued by agent_end extension handlers and need a continuation.
		return this.agent.hasQueuedMessages();
	}

	getStructuredResponse<TSchemaValue extends TSchema>(
		options: StructuredResponseOptions<TSchemaValue>,
	): Promise<StructuredResponse<Static<TSchemaValue>>> {
		return this._runActivity("structured response", () => this._getStructuredResponse(options));
	}
	private _requireStructuredResponseModel(): Model<Api> {
		if (this._isAgentRunActive) {
			throw new Error("Agent is already processing. Wait for completion before requesting structured output.");
		}
		const model = this.model;
		if (!model) throw new Error(formatNoModelSelectedMessage());
		if (!this._modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(formatNoApiKeyFoundMessage(model.provider));
		}
		return model;
	}
	private async _getStructuredResponse<TSchemaValue extends TSchema>(
		options: StructuredResponseOptions<TSchemaValue>,
	): Promise<StructuredResponse<Static<TSchemaValue>>> {
		const model = this._requireStructuredResponseModel();

		const schemaName = options.name ?? DEFAULT_STRUCTURED_RESPONSE_TOOL_NAME;
		const tool: Tool<TSchemaValue> = {
			name: schemaName,
			description:
				options.description ??
				"Return the requested structured response. Call this tool exactly once with arguments matching the schema.",
			parameters: options.schema,
		};
		const lastAssistant = this._findLastAssistantMessage();
		if (!lastAssistant) {
			throw new Error("No assistant response is available to structure.");
		}

		const direct = this._tryParseStructuredAssistantText(tool, lastAssistant);
		if (direct.ok) {
			this._appendStructuredInternalEntry(
				"result",
				schemaName,
				0,
				"Validated structured response from assistant JSON.",
				{
					stage: "result",
					schemaName,
					attempt: 0,
					source: "json",
				},
			);
			return { output: direct.output, attempts: 0, source: "json", message: lastAssistant };
		}

		const maxCorrections = options.maxCorrections ?? DEFAULT_STRUCTURED_RESPONSE_CORRECTIONS;
		const maxAttempts = maxCorrections + 1;
		const { apiKey, headers } = await this._getRequiredRequestAuth(model);
		const messages = this._buildStructuredResponseMessages(options.scope ?? "latest", lastAssistant, schemaName);
		let lastError = direct.error;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const requestText =
				attempt === 1
					? `Extract the structured response by calling ${schemaName} exactly once.`
					: `Correct the structured response by calling ${schemaName} exactly once.\n\nValidation error:\n${lastError}`;
			const userMessage: Message = {
				role: "user",
				content: [{ type: "text", text: requestText }],
				timestamp: Date.now(),
			};
			messages.push(userMessage);
			this._appendStructuredInternalEntry("request", schemaName, attempt, requestText, {
				stage: "request",
				schemaName,
				attempt,
				validationError: attempt === 1 ? undefined : lastError,
			});

			const responseStream = await this.agent.streamFn(
				model,
				{
					systemPrompt:
						"You are a structured data extraction assistant. Do not answer in prose. Use the provided tool to return the structured data.",
					messages,
					tools: [tool],
				},
				{
					apiKey,
					headers,
					sessionId: this.agent.sessionId,
					transport: this.agent.transport,
					thinkingBudgets: this.agent.thinkingBudgets,
					maxRetryDelayMs: this.agent.maxRetryDelayMs,
				},
			);
			const assistantMessage = await responseStream.result();
			messages.push(assistantMessage);
			this._appendStructuredInternalEntry(
				"assistant",
				schemaName,
				attempt,
				this._formatStructuredAssistantLog(assistantMessage),
				{
					stage: "assistant",
					schemaName,
					attempt,
				},
			);

			const attemptResult = this._evaluateStructuredResponseAttempt({
				tool,
				assistantMessage,
				messages,
				schemaName,
				attempt,
			});
			if (attemptResult.ok) return attemptResult.response;
			lastError = attemptResult.error;
		}

		throw new Error(`Structured response validation failed after ${maxAttempts} attempt(s):\n${lastError}`);
	}
	private _evaluateStructuredResponseAttempt<TSchemaValue extends TSchema>({
		tool,
		assistantMessage,
		messages,
		schemaName,
		attempt,
	}: StructuredAttemptContext<TSchemaValue>): StructuredAttemptResult<Static<TSchemaValue>> {
		const toolCall = assistantMessage.content.find(
			(block): block is ToolCall => block.type === "toolCall" && block.name === schemaName,
		);
		if (toolCall) {
			const validation = this._validateStructuredArguments(tool, toolCall.arguments);
			if (validation.ok) {
				this._appendStructuredInternalEntry("result", schemaName, attempt, "Validated structured tool response.", {
					stage: "result",
					schemaName,
					attempt,
					source: "tool",
				});
				return {
					ok: true,
					response: { output: validation.output, attempts: attempt, source: "tool", message: assistantMessage },
				};
			}
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: validation.error }],
				isError: true,
				timestamp: Date.now(),
			};
			messages.push(toolResult);
			this._appendStructuredInternalEntry("tool_result", schemaName, attempt, validation.error, {
				stage: "tool_result",
				schemaName,
				attempt,
				validationError: validation.error,
			});
			return { ok: false, error: validation.error };
		}

		const textValidation = this._tryParseStructuredAssistantText(tool, assistantMessage);
		if (!textValidation.ok) return textValidation;
		this._appendStructuredInternalEntry("result", schemaName, attempt, "Validated structured JSON response.", {
			stage: "result",
			schemaName,
			attempt,
			source: "json",
		});
		return {
			ok: true,
			response: { output: textValidation.output, attempts: attempt, source: "json", message: assistantMessage },
		};
	}

	private _buildStructuredResponseMessages(
		scope: StructuredResponseScope,
		lastAssistant: AssistantMessage,
		schemaName: string,
	): Message[] {
		if (scope === "conversation") {
			return this.agent.state.messages.filter(
				(message): message is Message =>
					message.role === "user" || message.role === "assistant" || message.role === "toolResult",
			);
		}

		return [
			{
				role: "user",
				content: [
					{
						type: "text",
						text:
							`Extract structured data from the latest assistant response below. Call ${schemaName} exactly once.\n\n` +
							`<assistant_response>\n${getAssistantText(lastAssistant)}\n</assistant_response>`,
					},
				],
				timestamp: Date.now(),
			},
		];
	}

	private _tryParseStructuredAssistantText<TSchemaValue extends TSchema>(
		tool: Tool<TSchemaValue>,
		message: AssistantMessage,
	): StructuredValidationResult<Static<TSchemaValue>> {
		const text = getAssistantText(message);
		for (const candidate of extractJsonCandidates(text)) {
			if (!isRecord(candidate)) {
				continue;
			}
			const validation = this._validateStructuredArguments(tool, candidate);
			if (validation.ok) {
				return validation;
			}
		}
		return { ok: false, error: "Assistant response did not contain valid JSON matching the requested schema." };
	}

	private _validateStructuredArguments<TSchemaValue extends TSchema>(
		tool: Tool<TSchemaValue>,
		arguments_: Record<string, unknown>,
	): StructuredValidationResult<Static<TSchemaValue>> {
		try {
			const output = validateToolArguments(tool, {
				type: "toolCall",
				id: "structured-response-validation",
				name: tool.name,
				arguments: arguments_,
			}) as Static<TSchemaValue>;
			return { ok: true, output };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private _appendStructuredInternalEntry(
		stage: StructuredInternalStage,
		schemaName: string,
		attempt: number,
		content: string,
		details: StructuredInternalDetails,
	): void {
		this.session.appendCustomMessageEntry(STRUCTURED_RESPONSE_INTERNAL_CUSTOM_TYPE, content, false, {
			...details,
			stage,
			schemaName,
			attempt,
		});
	}

	private _formatStructuredAssistantLog(message: AssistantMessage): string {
		const parts = message.content.map((block) => {
			if (block.type === "text") {
				return block.text;
			}
			if (block.type === "thinking") {
				return "[thinking omitted]";
			}
			return `tool:${block.name} ${JSON.stringify(block.arguments)}`;
		});
		return parts.join("\n");
	}

	private async _runPromptAdmission(state: PromptPreparationState): Promise<boolean> {
		if (this._disposed) throw new Error("Agent session is disposed");
		// Reject every prompt submission, including extension commands, before hooks or message mutation.
		// _compactionInFlight is set synchronously, before manual compaction aborts an active agent run.
		if (this._compactionInFlight !== undefined) {
			throw new Error(
				"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
			);
		}
		state.queueIntoActiveRun = this._hasActiveAgentRun;
		if (!state.queueIntoActiveRun && this._hasPromptAdmission()) {
			throw new Error("Agent is already processing. Wait for prompt admission to complete.");
		}

		// Admission is synchronous and precedes hooks so concurrent first prompts cannot race SessionStart.
		state.promptActivity = this._beginActivity("prompt admission");
		this._resetStopHookContinuationState();
		state.sessionContext = await this._ensureHookSessionStarted(state.promptId);
		if (state.sessionContext) state.hookContextMessages.push(state.sessionContext);
		const promptHook = await this._runHook({
			...this._hookCommon("UserPromptSubmit", state.promptId),
			hook_event_name: "UserPromptSubmit",
			prompt: state.text,
		});
		if (promptHook.blocked || !promptHook.continue) {
			throw new Error(promptHook.reason ?? "Prompt submission blocked by hook");
		}
		const promptContext = this._hookContextMessage(promptHook.additionalContext);
		if (promptContext) state.hookContextMessages.push(promptContext);

		// Hooks run before extension commands, input interception, and template expansion.
		if (state.expandPromptTemplates && state.text.startsWith("/")) {
			const handled = await this._tryExecuteExtensionCommand(state.text, () => {
				// Session-replacing extension commands must not wait on their own admission token.
				if (state.promptActivity) this._endActivity(state.promptActivity);
				state.promptActivity = undefined;
			});
			if (handled) {
				state.options?.preflightResult?.(true);
				return true;
			}
		}
		if (this._disposed) throw new Error("Agent session is disposed");
		return false;
	}

	private async _interceptPromptInput(state: PromptPreparationState): Promise<boolean> {
		if (!this._extensionRunner.hasHandlers("input")) return false;
		const inputResult = await this._runAsyncBarrierCallback("extension input handler", () =>
			this._extensionRunner.emitInput(
				state.currentText,
				state.currentImages,
				state.options?.source ?? "interactive",
				state.queueIntoActiveRun ? state.options?.streamingBehavior : undefined,
			),
		);
		if (inputResult.action === "handled") {
			state.options?.preflightResult?.(true);
			return true;
		}
		if (inputResult.action === "transform") {
			state.currentText = inputResult.text;
			state.currentImages = inputResult.images ?? state.currentImages;
		}
		return false;
	}

	private _expandPromptInput(state: PromptPreparationState): void {
		state.queueIntoActiveRun = this._hasActiveAgentRun;
		if (!state.queueIntoActiveRun && this._hasPromptAdmission(state.promptActivity)) {
			throw new Error("Agent is already processing. Wait for prompt admission to complete.");
		}
		state.expandedText = state.currentText;
		if (!state.expandPromptTemplates) return;
		state.expandedText = this._expandSkillCommand(state.expandedText);
		state.expandedText = this._expandRuleCommand(state.expandedText);
		state.expandedText = expandPromptTemplate(state.expandedText, [...this.promptTemplates]);
	}

	private async _queuePromptIntoActiveRun(state: PromptPreparationState): Promise<boolean> {
		if (!state.queueIntoActiveRun) return false;
		const streamingBehavior = state.options?.streamingBehavior;
		if (!streamingBehavior) {
			throw new Error(
				"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
			);
		}
		if (streamingBehavior === "followUp") {
			await this._queueFollowUp(state.expandedText, state.currentImages, state.hookContextMessages, state.promptId);
		} else {
			await this._queueSteer(state.expandedText, state.currentImages, state.hookContextMessages, state.promptId);
		}
		if (state.sessionContext) this._pendingHookSessionStartContext = undefined;
		state.options?.preflightResult?.(true);
		return true;
	}

	private _validatePromptModelAuthentication(): void {
		const model = this.model;
		if (!model) throw new Error(formatNoModelSelectedMessage());
		if (this._modelRegistry.hasConfiguredAuth(model)) return;
		if (this._modelRegistry.isUsingOAuth(model)) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _resumeAfterPromptCompaction(): Promise<void> {
		const lastAssistant = this._findLastAssistantMessage();
		if (!lastAssistant || !(await this._checkCompaction(lastAssistant, false))) return;
		try {
			if (!(await this._continueAgentIfReady())) return;
			while (await this._handlePostAgentRun()) {
				if (!(await this._continueAgentIfReady())) break;
			}
		} finally {
			this._flushPendingBashMessages();
		}
	}

	private async _buildPromptMessages(state: PromptPreparationState): Promise<AgentMessage[]> {
		const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: state.expandedText }];
		if (state.currentImages) userContent.push(...state.currentImages);
		const messages: AgentMessage[] = [
			{ role: "user", content: userContent, timestamp: Date.now() },
			...state.hookContextMessages,
			...this._pendingNextTurnMessages,
		];
		if (state.sessionContext) this._pendingHookSessionStartContext = undefined;
		this._pendingNextTurnMessages = [];

		const result = await this._runAsyncBarrierCallback("extension before_agent_start handler", () =>
			this._extensionRunner.emitBeforeAgentStart(
				state.expandedText,
				state.currentImages,
				this._baseSystemPrompt,
				this._baseSystemPromptOptions,
			),
		);
		if (result?.messages) {
			for (const msg of result.messages) {
				messages.push({
					role: "custom",
					customType: msg.customType,
					content: msg.content ?? [],
					display: msg.display,
					details: msg.details,
					timestamp: Date.now(),
				});
			}
		}
		if (result?.systemPrompt !== undefined) {
			this._systemPromptOverride = result.systemPrompt;
			this.agent.state.systemPrompt = result.systemPrompt;
		} else {
			this._systemPromptOverride = undefined;
			this.agent.state.systemPrompt = this._baseSystemPrompt;
		}
		return messages;
	}

	private async _preparePrompt(state: PromptPreparationState): Promise<AgentMessage[] | undefined> {
		if (await this._runPromptAdmission(state)) return undefined;
		if (await this._interceptPromptInput(state)) return undefined;
		this._expandPromptInput(state);
		if (await this._queuePromptIntoActiveRun(state)) return undefined;
		this._flushPendingBashMessages();
		this._validatePromptModelAuthentication();
		await this._resumeAfterPromptCompaction();
		return this._buildPromptMessages(state);
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming, when no compaction is active
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 * @throws Error if manual or extension-requested compaction is in progress
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		const promptId = randomUUID();
		const state: PromptPreparationState = {
			text,
			options,
			promptId,
			expandPromptTemplates: options?.expandPromptTemplates ?? true,
			hookContextMessages: [],
			promptActivity: undefined,
			queueIntoActiveRun: false,
			sessionContext: undefined,
			currentText: text,
			currentImages: options?.images,
			expandedText: text,
		};
		try {
			let messages: AgentMessage[] | undefined;
			try {
				messages = await this._preparePrompt(state);
			} catch (error) {
				options?.preflightResult?.(false);
				throw error;
			}
			if (!messages) return;
			options?.preflightResult?.(true);
			this._activePromptId = promptId;
			await this._runAgentPrompt(messages);
		} finally {
			if (this._activePromptId === promptId) this._activePromptId = undefined;
			if (state.promptActivity) this._endActivity(state.promptActivity);
		}
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string, onFound?: () => void): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;
		onFound?.();

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.getRegisteredSkills().find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			this._loadAssociatedInstructionTools(skill);
			const content = skill.content ?? readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	private _expandRuleCommand(text: string): string {
		if (!text.startsWith("/rule:")) return text;

		const spaceIndex = text.indexOf(" ");
		const ruleName = spaceIndex === -1 ? text.slice(6) : text.slice(6, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const rule = this.getRegisteredRules().find((r) => r.name === ruleName);
		if (!rule) return text; // Unknown rule, pass through

		try {
			this._loadAssociatedInstructionTools(rule);
			const content = rule.content ?? readFileSync(rule.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const ruleBlock = `<rule name="${rule.name}" location="${rule.filePath}">\nReferences are relative to ${rule.baseDir}.\n\n${body}\n</rule>`;
			return args ? `${ruleBlock}\n\n${args}` : ruleBlock;
		} catch (err) {
			this._extensionRunner.emitError({
				extensionPath: rule.filePath,
				event: "rule_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text;
		}
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill/rule commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}
		if (!this._hasActiveAgentRun) throw new Error("Cannot steer while the agent is idle");

		// Expand skill/rule commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = this._expandRuleCommand(expandedText);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueSteer(expandedText, images);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill/rule commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}
		if (!this._hasActiveAgentRun) throw new Error("Cannot queue a follow-up while the agent is idle");

		// Expand skill/rule commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = this._expandRuleCommand(expandedText);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(expandedText, images);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(
		text: string,
		images?: ImageContent[],
		hookContexts: CustomMessage[] = [],
		promptId?: string,
	): Promise<void> {
		if (this._disposed || !this._hasActiveAgentRun) throw new Error("Cannot steer without an active agent run");
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
		for (const context of hookContexts) this.agent.steer(context);
		if (promptId) {
			const ids = this._queuedPromptIds.get(text) ?? [];
			ids.push(promptId);
			this._queuedPromptIds.set(text, ids);
		}
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(
		text: string,
		images?: ImageContent[],
		hookContexts: CustomMessage[] = [],
		promptId?: string,
	): Promise<void> {
		if (this._disposed || !this._hasActiveAgentRun) {
			throw new Error("Cannot queue a follow-up without an active agent run");
		}
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
		});
		for (const context of hookContexts) this.agent.followUp(context);
		if (promptId) {
			const ids = this._queuedPromptIds.get(text) ?? [];
			ids.push(promptId);
			this._queuedPromptIds.set(text, ids);
		}
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: SendCustomMessageOptions,
	): Promise<void> {
		return this._runActivity("custom message", () => this._sendCustomMessage(message, options));
	}

	private async _sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: SendCustomMessageOptions,
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this._isAgentRunActive) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this._runAgentPrompt(appMessage);
		} else {
			this.agent.state.messages.push(appMessage);
			this.session.appendCustomMessageEntry(
				appMessage.customType,
				appMessage.content,
				appMessage.display,
				appMessage.details,
			);
			await this._emit({ type: "message_start", message: appMessage });
			await this._emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: SendUserMessageOptions,
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): QueuedMessages {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		this._activityGeneration++;
		this._scheduleSettlementCheck();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this.abortRetry();
		this.agent.abort();
		if (this._barrierOwnerContext.getStore()?.active) return;
		await this.waitForIdle();
	}

	private async _abortAgentAndDrain(): Promise<void> {
		this.abortRetry();
		this.agent.abort();
		await this.agent.waitForIdle();
	}

	/** Wait for the full AgentSession lifecycle to settle. */
	waitForIdle(): Promise<void> {
		const owner = this._barrierOwnerContext.getStore();
		if (owner?.active) {
			throw new Error(
				`AgentSession.waitForIdle() cannot be awaited from ${owner.label} because it is part of the same settlement barrier`,
			);
		}
		return new Promise<void>((resolve, reject) => {
			this._idleWaiters.add({ resolve, reject });
			this._scheduleSettlementCheck();
		});
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: ModelSelectSource,
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured, saves to session and settings.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>): Promise<void> {
		if (!this._modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = model;
		this.session.appendModelChange(model.provider, model.id);
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);
		this._refreshModelDependentRuntime();

		await this._emitModelSelect(model, previousModel, "set");
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: ModelCycleDirection = "forward"): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction);
		}
		return this._cycleAvailableModel(direction);
	}

	private async _cycleScopedModel(direction: ModelCycleDirection): Promise<ModelCycleResult | undefined> {
		const scopedModels = this._scopedModels.filter((scoped) => this._modelRegistry.hasConfiguredAuth(scoped.model));
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);

		// Apply model
		this.agent.state.model = next.model;
		this.session.appendModelChange(next.model.provider, next.model.id);
		this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		// Apply thinking level.
		// - Explicit scoped model thinking level overrides current session level
		// - Undefined scoped model thinking level inherits the current session preference
		// setThinkingLevel clamps to model capabilities.
		this.setThinkingLevel(thinkingLevel);
		this._refreshModelDependentRuntime();

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(direction: ModelCycleDirection): Promise<ModelCycleResult | undefined> {
		const availableModels = await this._modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = nextModel;
		this.session.appendModelChange(nextModel.provider, nextModel.id);
		this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);
		this._refreshModelDependentRuntime();

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes.
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.session.appendThinkingLevelChange(effectiveLevel);
			if (this.supportsThinking() || effectiveLevel !== "off") {
				this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		return this.thinkingLevel;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: QueueMode): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: QueueMode): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/** Queue extension-triggered compaction outside the currently active agent turn. */
	private _requestExtensionCompaction(options?: CompactOptions): void {
		this._extensionCompactionActivity ??= this._beginActivity("extension compaction request");
		this._extensionCompactionQueue.push(options ?? {});
		if (this._isAgentRunActive) return;
		this._scheduleExtensionCompactions();
	}

	private _scheduleExtensionCompactions(): void {
		const alreadyScheduled = this._extensionCompactionTimer !== undefined;
		if (this._extensionCompactionRunning || alreadyScheduled || this._extensionCompactionQueue.length === 0) {
			return;
		}
		this._extensionCompactionTimer = setTimeout(() => {
			this._extensionCompactionTimer = undefined;
			void this._drainExtensionCompactionQueue();
		}, 0);
	}

	private async _drainExtensionCompactionQueue(mode: ExtensionCompactionQueueMode = "idle"): Promise<boolean> {
		if (this._extensionCompactionRunning) {
			return false;
		}
		this._extensionCompactionRunning = true;
		let compacted = false;
		try {
			while (mode === "between-turns" || !this._isAgentRunActive) {
				const options = this._extensionCompactionQueue.shift();
				if (!options) {
					break;
				}
				compacted = (await this._runRequestedExtensionCompaction(options, mode === "idle")) || compacted;
			}
		} finally {
			this._extensionCompactionRunning = false;
		}
		if (mode === "idle" && !this._isAgentRunActive) this._scheduleExtensionCompactions();
		if (
			this._extensionCompactionQueue.length === 0 &&
			this._extensionCompactionTimer === undefined &&
			!this._extensionCompactionRunning &&
			this._extensionCompactionActivity
		) {
			this._endActivity(this._extensionCompactionActivity);
			this._extensionCompactionActivity = undefined;
		}
		return compacted;
	}

	private async _runRequestedExtensionCompaction(options: CompactOptions, abortActiveRun: boolean): Promise<boolean> {
		try {
			const result = await this._compactSession(options.customInstructions, { abortActiveRun });
			options.onComplete?.(result);
			return true;
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			options.onError?.(err);
			return false;
		}
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		return this._compactSession(customInstructions, { abortActiveRun: true });
	}

	private async _runWithCompactionGuard<T>(operation: () => Promise<T>): Promise<T> {
		if (this._disposed) {
			throw new Error("Agent session is disposed");
		}
		if (this._compactionInFlight) {
			throw new Error("Compaction already in progress");
		}
		const inFlight = this._runActivity("compaction", async () => {
			await Promise.resolve();
			if (this._disposed) throw new Error("Agent session is disposed");
			return operation();
		});
		this._compactionInFlight = inFlight;
		try {
			return await inFlight;
		} finally {
			if (this._compactionInFlight === inFlight) {
				this._compactionInFlight = undefined;
				this._scheduleSettlementCheck();
			}
		}
	}

	private _compactSession(
		customInstructions: string | undefined,
		options: CompactionExecutionOptions,
	): Promise<CompactionResult> {
		return this._runWithCompactionGuard(() => this._compactSessionUnlocked(customInstructions, options));
	}

	private async _prepareForManualCompaction(options: CompactionExecutionOptions): Promise<void> {
		if (!options.abortActiveRun) return;
		await this._abortAgentAndDrain();
		if (this._disposed) throw new Error("Agent session is disposed");
	}

	private async _buildManualCompactionPlan(): Promise<CompactionPlan> {
		const model = this.model;
		if (!model) throw new Error(formatNoModelSelectedMessage());
		const auth = await this._getCompactionRequestAuth(model);
		const pathEntries = this.session.getBranch();
		const preparation = prepareCompaction(pathEntries, this.settingsManager.getCompactionSettings());
		if (!preparation) {
			const lastEntry = pathEntries[pathEntries.length - 1];
			if (lastEntry?.type === "compaction") throw new Error("Already compacted");
			throw new Error("Nothing to compact (session too small)");
		}
		return { ...auth, model, preparation, pathEntries };
	}

	private async _runManualCompactionInterceptors(
		plan: CompactionPlan,
		customInstructions: string | undefined,
		signal: AbortSignal,
	): Promise<CompactionResult | undefined> {
		const preHook = await this._runHook({
			...this._hookCommon("PreCompact"),
			hook_event_name: "PreCompact",
			trigger: "manual",
			custom_instructions: customInstructions ?? "",
		});
		if (preHook.blocked || !preHook.continue) throw new Error(preHook.reason ?? "Compaction blocked by hook");
		if (!this._extensionRunner.hasHandlers("session_before_compact")) return undefined;
		const result = (await this._extensionRunner.emit({
			type: "session_before_compact",
			preparation: plan.preparation,
			branchEntries: plan.pathEntries,
			customInstructions,
			signal,
		})) as SessionBeforeCompactResult | undefined;
		if (result?.cancel) throw new Error("Compaction cancelled");
		return result?.compaction;
	}

	private async _resolveManualCompaction(
		plan: CompactionPlan,
		customInstructions: string | undefined,
		extensionCompaction: CompactionResult | undefined,
		signal: AbortSignal,
	): Promise<CompactionResult> {
		if (extensionCompaction) return extensionCompaction;
		return compact(
			plan.preparation,
			plan.model,
			plan.apiKey,
			plan.headers,
			customInstructions,
			signal,
			this.thinkingLevel,
			this.agent.streamFn,
			this.settingsManager.getRetrySettings(),
			this._summarizationRetryCallbacks({ source: "compaction", reason: "manual" }),
		);
	}

	private async _commitManualCompaction(result: CompactionResult, fromExtension: boolean): Promise<void> {
		this.session.appendCompaction(
			result.summary,
			result.firstKeptEntryId,
			result.tokensBefore,
			result.details,
			fromExtension,
		);
		const newEntries = this.session.getEntries();
		this.agent.state.messages = this.session.buildSessionContext().messages;
		const savedCompactionEntry = newEntries.find(
			(entry): entry is CompactionEntry => entry.type === "compaction" && entry.summary === result.summary,
		);
		if (savedCompactionEntry) {
			await this._extensionRunner.emit({
				type: "session_compact",
				compactionEntry: savedCompactionEntry,
				fromExtension,
			});
		}
		await this._runHook({
			...this._hookCommon("PostCompact"),
			hook_event_name: "PostCompact",
			trigger: "manual",
			compact_summary: result.summary,
		});
	}

	private async _compactSessionUnlocked(
		customInstructions: string | undefined,
		options: CompactionExecutionOptions,
	): Promise<CompactionResult> {
		await this._prepareForManualCompaction(options);
		const abortController = new AbortController();
		this._compactionAbortController = abortController;
		this._emit({ type: "compaction_start", reason: "manual" });
		try {
			const plan = await this._buildManualCompactionPlan();
			const extensionCompaction = await this._runManualCompactionInterceptors(
				plan,
				customInstructions,
				abortController.signal,
			);
			const result = await this._resolveManualCompaction(
				plan,
				customInstructions,
				extensionCompaction,
				abortController.signal,
			);
			if (abortController.signal.aborted) throw new Error("Compaction cancelled");
			const fromExtension = extensionCompaction !== undefined;
			await this._commitManualCompaction(result, fromExtension);
			const compactionResult: CompactionResult = {
				summary: result.summary,
				firstKeptEntryId: result.firstKeptEntryId,
				tokensBefore: result.tokensBefore,
				details: result.details,
			};
			// compaction_end listeners may submit queued prompts, so expose idle state before notifying them.
			this._compactionAbortController = undefined;
			this._compactionInFlight = undefined;
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			this._compactionAbortController = undefined;
			this._compactionInFlight = undefined;
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			throw error;
		} finally {
			this._compactionAbortController = undefined;
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	private _isAtOrBeforeCompactionBoundary(timestamp: number, compactionEntry: CompactionEntry | null): boolean {
		return compactionEntry !== null && timestamp <= new Date(compactionEntry.timestamp).getTime();
	}

	private async _runOverflowCompactionRecovery(): Promise<boolean> {
		if (this._overflowRecoveryAttempted) {
			this._emit({
				type: "compaction_end",
				reason: "overflow",
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage:
					"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
			});
			return false;
		}
		this._overflowRecoveryAttempted = true;
		// Keep the persisted error in session history, but remove it from retry context.
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}
		return await this._runAutoCompaction("overflow", true);
	}

	private _resolveCompactionThresholdTokens(
		assistantMessage: AssistantMessage,
		compactionEntry: CompactionEntry | null,
	): number | undefined {
		if (assistantMessage.stopReason !== "error") return calculateContextTokens(assistantMessage.usage);
		const messages = this.agent.state.messages;
		const estimate = estimateContextTokens(messages);
		if (estimate.lastUsageIndex === null) return undefined;
		// Kept pre-compaction usage reflects the old context and must not trigger another compaction.
		const usageMessage = messages[estimate.lastUsageIndex];
		if (
			usageMessage.role === "assistant" &&
			this._isAtOrBeforeCompactionBoundary((usageMessage as AssistantMessage).timestamp, compactionEntry)
		) {
			return undefined;
		}
		return estimate.tokens;
	}

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Two cases:
	 * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
	 * 2. Threshold: Context over threshold, compact, NO auto-retry (user continues manually)
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;
		const contextWindow = this.model?.contextWindow ?? 0;
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;
		const compactionEntry = getLatestCompactionEntry(this.session.getBranch());
		if (this._isAtOrBeforeCompactionBoundary(assistantMessage.timestamp, compactionEntry)) return false;
		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
			return await this._runOverflowCompactionRecovery();
		}
		const contextTokens = this._resolveCompactionThresholdTokens(assistantMessage, compactionEntry);
		if (contextTokens === undefined || !shouldCompact(contextTokens, contextWindow, settings)) return false;
		return await this._runAutoCompaction("threshold", false);
	}

	/**
	 * Internal: Run auto-compaction with events.
	 */
	private _runAutoCompaction(reason: AutoCompactionReason, willRetry: boolean): Promise<boolean> {
		if (this._compactionInFlight || this._disposed) return Promise.resolve(false);
		return this._runWithCompactionGuard(() => this._runAutoCompactionUnlocked(reason, willRetry));
	}

	private _emitAutoCompactionWithoutResult(
		reason: AutoCompactionReason,
		aborted: boolean,
		errorMessage?: string,
	): void {
		this._emit({
			type: "compaction_end",
			reason,
			result: undefined,
			aborted,
			willRetry: false,
			...(errorMessage === undefined ? {} : { errorMessage }),
		});
	}

	private async _buildAutoCompactionPlan(
		reason: AutoCompactionReason,
		settings: CompactionSettings,
	): Promise<CompactionPlan | undefined> {
		const model = this.model;
		if (!model) {
			this._emitAutoCompactionWithoutResult(reason, false);
			return undefined;
		}
		let auth: CompactionRequestAuth;
		if (this.agent.streamFn === streamSimple) {
			const authResult = await this._modelRegistry.getApiKeyAndHeaders(model);
			if (!authResult.ok || !authResult.apiKey) {
				this._emitAutoCompactionWithoutResult(reason, false);
				return undefined;
			}
			auth = { apiKey: authResult.apiKey, headers: authResult.headers };
		} else {
			auth = await this._getCompactionRequestAuth(model);
		}
		const pathEntries = this.session.getBranch();
		const preparation = prepareCompaction(pathEntries, settings);
		if (!preparation) {
			this._emitAutoCompactionWithoutResult(reason, false);
			return undefined;
		}
		return { ...auth, model, preparation, pathEntries };
	}

	private async _runAutoCompactionInterceptors(
		plan: CompactionPlan,
		signal: AbortSignal,
	): Promise<AutoCompactionInterception> {
		const preHook = await this._runHook({
			...this._hookCommon("PreCompact"),
			hook_event_name: "PreCompact",
			trigger: "auto",
			custom_instructions: "",
		});
		if (preHook.blocked || !preHook.continue) return { cancelled: true };
		if (!this._extensionRunner.hasHandlers("session_before_compact")) return { cancelled: false };
		const extensionResult = (await this._extensionRunner.emit({
			type: "session_before_compact",
			preparation: plan.preparation,
			branchEntries: plan.pathEntries,
			customInstructions: undefined,
			signal,
		})) as SessionBeforeCompactResult | undefined;
		if (extensionResult?.cancel) return { cancelled: true };
		return { cancelled: false, compaction: extensionResult?.compaction };
	}

	private async _resolveAutoCompaction(
		plan: CompactionPlan,
		interception: AutoCompactionInterception,
		reason: AutoCompactionReason,
		signal: AbortSignal,
	): Promise<ResolvedAutoCompaction> {
		if (interception.compaction) return { result: interception.compaction, fromExtension: true };
		const result = await compact(
			plan.preparation,
			plan.model,
			plan.apiKey,
			plan.headers,
			undefined,
			signal,
			this.thinkingLevel,
			this.agent.streamFn,
			this.settingsManager.getRetrySettings(),
			this._summarizationRetryCallbacks({ source: "compaction", reason }),
		);
		return { result, fromExtension: false };
	}

	private async _commitAutoCompaction(compaction: ResolvedAutoCompaction): Promise<void> {
		const { result, fromExtension } = compaction;
		this.session.appendCompaction(
			result.summary,
			result.firstKeptEntryId,
			result.tokensBefore,
			result.details,
			fromExtension,
		);
		const newEntries = this.session.getEntries();
		this.agent.state.messages = this.session.buildSessionContext().messages;
		const savedCompactionEntry = newEntries.find(
			(entry): entry is CompactionEntry => entry.type === "compaction" && entry.summary === result.summary,
		);
		if (savedCompactionEntry) {
			await this._extensionRunner.emit({
				type: "session_compact",
				compactionEntry: savedCompactionEntry,
				fromExtension,
			});
		}
		await this._runHook({
			...this._hookCommon("PostCompact"),
			hook_event_name: "PostCompact",
			trigger: "auto",
			compact_summary: result.summary,
		});
	}

	private async _runAutoCompactionUnlocked(reason: AutoCompactionReason, willRetry: boolean): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		this._emit({ type: "compaction_start", reason });
		const abortController = new AbortController();
		this._autoCompactionAbortController = abortController;

		try {
			const plan = await this._buildAutoCompactionPlan(reason, settings);
			if (!plan) return false;
			const interception = await this._runAutoCompactionInterceptors(plan, abortController.signal);
			if (interception.cancelled) {
				this._emitAutoCompactionWithoutResult(reason, true);
				return false;
			}
			const compaction = await this._resolveAutoCompaction(plan, interception, reason, abortController.signal);
			if (abortController.signal.aborted) {
				this._emitAutoCompactionWithoutResult(reason, true);
				return false;
			}
			await this._commitAutoCompaction(compaction);
			this._emit({ type: "compaction_end", reason, result: compaction.result, aborted: false, willRetry });

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMessage = messages[messages.length - 1];
				if (lastMessage?.role === "assistant" && (lastMessage as AssistantMessage).stopReason === "error") {
					this.agent.state.messages = messages.slice(0, -1);
				}
				return true;
			}
			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			this._emitAutoCompactionWithoutResult(
				reason,
				false,
				reason === "overflow"
					? `Context overflow recovery failed: ${errorMessage}`
					: `Auto-compaction failed: ${errorMessage}`,
			);
			return false;
		} finally {
			this._autoCompactionAbortController = undefined;
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	bindExtensions(bindings: ExtensionBindings): Promise<void> {
		return this._runActivity("extension binding", () => this._bindExtensions(bindings));
	}

	private async _bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: ResourcesDiscoverReason): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, rulePaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && rulePaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			rulePaths: this.buildExtensionResourcePaths(rulePaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
	}

	private buildExtensionResourcePaths(entries: ExtensionResourcePath[]): ResourcePathEntry[] {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRegistry.find(currentModel.provider, currentModel.id);
		if (refreshedModel && refreshedModel !== currentModel) {
			this.agent.state.model = refreshedModel;
		}
		this._refreshModelDependentRuntime();
	}

	private _updateCurrentRunnerLspOwnership(): void {
		const ownership = this._extensionLspOwnership.get(this._extensionRunner);
		if (!ownership) return;
		ownership.configuration = structuredClone(this._lspConfiguration);
		ownership.runtimeState = this._lspRuntimeState;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getToolOperations = (): ToolOperations => this.getToolOperations();
		const boundLspOwnership: ExtensionLspOwnership = {
			runtimeState: this._lspRuntimeState,
			configuration: structuredClone(this._lspConfiguration),
		};
		this._extensionLspOwnership.set(runner, boundLspOwnership);
		const getBoundLspStatus = (): LspSessionStatus =>
			runner === this._extensionRunner
				? this.getLspStatus()
				: {
						owner: "agent-session",
						enabled: boundLspOwnership.configuration.enabled,
						configuration: structuredClone(boundLspOwnership.configuration),
						servers: boundLspOwnership.runtimeState?.manager.getStatus() ?? [],
					};

		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner
				.getRegisteredCommands()
				.filter((command) => !HIDDEN_BUILTIN_SLASH_COMMAND_NAMES.has(command.name))
				.map((command) => ({
					name: command.invocationName,
					description: command.description,
					source: "extension",
					sourceInfo: command.sourceInfo,
				}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this.getRegisteredSkills().map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			const rules: SlashCommandInfo[] = this.getRegisteredRules().map((rule) => ({
				name: `rule:${rule.name}`,
				description: rule.description,
				source: "rule",
				sourceInfo: rule.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills, ...rules];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					this.session.appendCustomEntry(customType, data);
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.session.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.session.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				getAvailableTools: () => this.getAvailableSessionTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				unregisterTool: (name) => this.unregisterSessionTool(name),
				loadTool: (name) => this.loadSessionTool(name),
				unloadTool: (name) => this.unloadSessionTool(name),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this.modelRegistry.hasConfiguredAuth(model)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				isIdle: () => this.isIdle,
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					this._requestExtensionCompaction(options);
				},
				getSystemPrompt: () => this.systemPrompt,
				getToolOperations,
				getToolBackendInfo: () => this.getToolBackendInfo(),
				getLspStatus: getBoundLspStatus,
				configureLsp: (configuration) => {
					if (runner !== this._extensionRunner) throw new Error(STALE_EXTENSION_CONTEXT_MESSAGE);
					return this.configureLsp(configuration);
				},
				execToolBackend: (command, options) =>
					this._runActivity("extension backend command", async () => {
						const operations = getToolOperations();
						const prefix = this.settingsManager.getShellCommandPrefix();
						const resolvedCommand = prefix ? `${prefix}\n${command}` : command;
						return executeBashWithOperations(
							resolvedCommand,
							options?.cwd ?? operations.cwd,
							operations,
							options,
						);
					}),
			},
			{
				registerProvider: (name, config) => {
					this._modelRegistry.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRegistry.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _createLoadToolDefinition(): ToolDefinition {
		const parameters = Type.Object({
			name: Type.Union([Type.String(), Type.Array(Type.String())], {
				description:
					"Name of the available session-scoped tool to load, or an array of names to load several at once",
			}),
		});
		return {
			name: "load_tool",
			label: "Load tool",
			description:
				"Load one or more session-scoped available tools into the active tool context for subsequent turns. Pass a single name or an array of names to load several in one call.",
			promptSnippet:
				"Use load_tool to load session-scoped available tools listed in <available-tools> before calling them; pass an array of names to load several at once.",
			parameters,
			renderCall: (args: unknown) => {
				return new Text(
					formatSessionToolLifecycleCall("load", getToolNameArgs(args as SessionToolNameArgs | undefined)),
					0,
					0,
				);
			},
			renderResult: (result, _options, _theme, context) => {
				const details = result.details as { loaded?: string[]; notFound?: string[] } | undefined;
				const loaded = details?.loaded ?? getToolNameArgs(context.args as SessionToolNameArgs | undefined);
				return new Text(formatSessionToolLifecycleResult("loaded", loaded, details?.notFound ?? []), 0, 0);
			},
			executionMode: "sequential",
			execute: async (_toolCallId, params: SessionToolNameParameters) => {
				const names = normalizeSessionToolNames(params.name);
				const loaded: string[] = [];
				const notFound: string[] = [];
				for (const name of names) {
					if (this.loadSessionTool(name)) loaded.push(name);
					else notFound.push(name);
				}
				const parts: string[] = [];
				if (loaded.length > 0) {
					parts.push(
						`Loaded tool${loaded.length > 1 ? "s" : ""}: ${loaded.join(", ")}. ${loaded.length > 1 ? "They are" : "It is"} now active and can be called.`,
					);
				}
				if (notFound.length > 0) {
					parts.push(`Tool${notFound.length > 1 ? "s" : ""} not found in this session: ${notFound.join(", ")}.`);
				}
				if (parts.length === 0) {
					parts.push("No tool names provided.");
				}
				return {
					content: [{ type: "text", text: parts.join(" ") }],
					details: { names, loaded, notFound },
				};
			},
		};
	}

	private _createUnloadToolDefinition(): ToolDefinition {
		const parameters = Type.Object({
			name: Type.Union([Type.String(), Type.Array(Type.String())], {
				description: "Name of the session-scoped tool to unload, or an array of names to unload several at once",
			}),
		});
		return {
			name: "unload_tool",
			label: "Unload tool",
			description:
				"Unload one or more session-scoped tools from the active tool context while keeping them available in this session. Pass a single name or an array of names.",
			promptSnippet:
				"Use unload_tool to remove session-scoped loaded tools from active context when no longer needed; pass an array of names to unload several at once.",
			parameters,
			renderCall: (args: unknown) => {
				return new Text(
					formatSessionToolLifecycleCall("unload", getToolNameArgs(args as SessionToolNameArgs | undefined)),
					0,
					0,
				);
			},
			renderResult: (result, _options, _theme, context) => {
				const details = result.details as { unloaded?: string[]; notFound?: string[] } | undefined;
				const unloaded = details?.unloaded ?? getToolNameArgs(context.args as SessionToolNameArgs | undefined);
				return new Text(formatSessionToolLifecycleResult("unloaded", unloaded, details?.notFound ?? []), 0, 0);
			},
			executionMode: "sequential",
			execute: async (_toolCallId, params: SessionToolNameParameters) => {
				const names = normalizeSessionToolNames(params.name);
				const unloaded: string[] = [];
				const notFound: string[] = [];
				for (const name of names) {
					if (this.unloadSessionTool(name)) unloaded.push(name);
					else notFound.push(name);
				}
				const parts: string[] = [];
				if (unloaded.length > 0) {
					parts.push(`Unloaded tool${unloaded.length > 1 ? "s" : ""}: ${unloaded.join(", ")}.`);
				}
				if (notFound.length > 0) {
					parts.push(`Tool${notFound.length > 1 ? "s" : ""} not found in this session: ${notFound.join(", ")}.`);
				}
				if (parts.length === 0) {
					parts.push("No tool names provided.");
				}
				return {
					content: [{ type: "text", text: parts.join(" ") }],
					details: { names, unloaded, notFound },
				};
			},
		};
	}

	private _resolveRefreshedActiveToolNames(
		options: ToolRegistryRefreshOptions | undefined,
		previousRegistryNames: Set<string>,
		previousActiveToolNames: string[],
		wrappedExtensionTools: AgentTool[],
		hasAvailableSessionTools: boolean,
	): string[] {
		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => this._isToolPermitted(name));
		if (this._allowedToolNames) {
			nextActiveToolNames.push(
				...Array.from(this._toolRegistry.keys()).filter((toolName) => this._allowedToolNames?.has(toolName)),
			);
		} else if (options?.includeAllExtensionTools) {
			nextActiveToolNames.push(...wrappedExtensionTools.map((tool) => tool.name));
		} else if (!options?.activeToolNames) {
			nextActiveToolNames.push(
				...Array.from(this._toolRegistry.keys()).filter((toolName) => !previousRegistryNames.has(toolName)),
			);
		}
		if (hasAvailableSessionTools) nextActiveToolNames.push("load_tool", "unload_tool");
		return nextActiveToolNames;
	}

	private _refreshToolRegistry(options?: ToolRegistryRefreshOptions): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const isAllowedTool = (name: string): boolean => this._isToolPermitted(name);
		const lifecycleToolNames = new Set(["load_tool", "unload_tool"]);
		const hasAvailableSessionTools = this.getAvailableSessionTools().length > 0;
		const isVisibleBaseTool = (name: string): boolean =>
			isAllowedTool(name) && (hasAvailableSessionTools || !lifecycleToolNames.has(name));
		const registeredTools = this._extensionRunner
			.getAllRegisteredTools()
			.filter((tool) => tool.lazy !== true || tool.loaded === true);
		const activeSessionTools = Array.from(this._sessionTools.values()).filter((tool) => !tool.lazy || tool.loaded);
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
			...activeSessionTools,
		].filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isVisibleBaseTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isVisibleBaseTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = this._resolveRefreshedActiveToolNames(
			options,
			previousRegistryNames,
			previousActiveToolNames,
			wrappedExtensionTools,
			hasAvailableSessionTools,
		);
		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	private _registerLspToolDefinitions(getState: () => LspRuntimeState, getOperations?: () => ToolOperations): void {
		for (const definition of createLspToolDefinitions(getState, getOperations)) {
			this._baseToolDefinitions.set(definition.name, definition as unknown as ToolDefinition);
		}
	}

	private async _replaceLspRuntime(configuration: ResolvedLspConfiguration): Promise<void> {
		const nextConfiguration = structuredClone(configuration);
		const previous = this._lspRuntimeState;
		if (previous && nextConfiguration.enabled && !this._baseToolsOverride) {
			await previous.manager.setConfiguration(nextConfiguration);
			this._lspConfiguration = nextConfiguration;
			this._updateCurrentRunnerLspOwnership();
			return;
		}
		const operations = this.getToolOperations();
		const next =
			nextConfiguration.enabled && !this._baseToolsOverride
				? createLspRuntimeState(operations.cwd, {
						configuration: nextConfiguration,
						connectionFactories: this._lspConnectionFactories,
						getToolBackendInfo: () => operations.getBackendInfo?.() ?? { type: "local", cwd: operations.cwd },
						getToolOperations: () => operations,
					})
				: undefined;
		this._lspConfiguration = nextConfiguration;
		this._lspRuntimeState = next;
		this._updateCurrentRunnerLspOwnership();
		for (const name of LSP_TOOL_NAMES) this._baseToolDefinitions.delete(name);
		if (next) this._registerLspToolDefinitions(() => next);
		this._refreshToolRegistry({ activeToolNames: this._withCurrentDefaultTools(this.getActiveToolNames()) });
		await previous?.manager.shutdownAll();
	}
	private _createWorkspaceToolHost(operations: ToolOperations): WorkspaceToolHost {
		const shellPath = this.settingsManager.getShellPath();
		const daemonOwnedLsp = operations.getBackendInfo?.().type === "remote";
		return new WorkspaceToolHost({
			cwd: operations.cwd,
			operations,
			tools: {
				read: {
					autoResizeImages: this.settingsManager.getImageAutoResize(),
					operationsForPath: (path) => this._getReadOperationsForPath(path, shellPath),
				},
				bash: { commandPrefix: this.settingsManager.getShellCommandPrefix() },
			},
			additionalDefinitions: daemonOwnedLsp
				? createLspToolDefinitions(
						() => {
							throw new Error("Remote LSP proxy attempted local execution");
						},
						() => operations,
					)
				: undefined,
			onCatalogChanged: () => this._refreshRemoteWorkspaceToolCatalog(),
		});
	}

	private _refreshRemoteWorkspaceToolCatalog(): Promise<void> {
		if (this._disposed || this._baseToolsOverride) return Promise.resolve();
		return this._enqueueRuntimeLifecycle(async () => {
			if (this._disposed || this._baseToolsOverride) return;
			const previous = this._workspaceToolHost;
			const next = this._createWorkspaceToolHost(this.getToolOperations());
			const activeToolNames = this.getActiveToolNames();
			for (const name of [...WORKSPACE_TOOL_NAMES, ...LSP_TOOL_NAMES]) this._baseToolDefinitions.delete(name);
			for (const [name, definition] of next.getDefinitions()) {
				this._baseToolDefinitions.set(name, definition as unknown as ToolDefinition);
			}
			this._workspaceToolHost = next;
			this._refreshToolRegistry({ activeToolNames: this._withCurrentDefaultTools(activeToolNames) });
			if (previous) {
				previous.detachCatalogListener();
				this._retiredWorkspaceToolHosts.push(previous);
			}
		});
	}

	private _captureRuntimeBuildSnapshot(): RuntimeBuildSnapshot {
		return {
			baseToolDefinitions: this._baseToolDefinitions,
			lspRuntimeState: this._lspRuntimeState,
			extensionRunner: this._extensionRunner as ExtensionRunner | undefined,
			toolRegistry: this._toolRegistry,
			toolDefinitions: this._toolDefinitions,
			toolPromptSnippets: this._toolPromptSnippets,
			toolPromptGuidelines: this._toolPromptGuidelines,
			baseSystemPrompt: this._baseSystemPrompt,
			baseSystemPromptOptions: this._baseSystemPromptOptions as BuildSystemPromptOptions | undefined,
			agentTools: this.agent.state.tools,
			agentSystemPrompt: this.agent.state.systemPrompt,
			extensionRunnerRef: this._extensionRunnerRef?.current,
			workspaceToolHost: this._workspaceToolHost,
		};
	}

	private _createRuntimeBaseToolDefinitions(
		workspaceToolHost: WorkspaceToolHost | undefined,
	): Record<string, ToolDefinition> {
		if (this._baseToolsOverride) {
			return Object.fromEntries(
				Object.entries(this._baseToolsOverride).map(([name, tool]) => [
					name,
					createToolDefinitionFromAgentTool(tool),
				]),
			);
		}
		return {
			...Object.fromEntries(workspaceToolHost?.getDefinitions() ?? []),
			session_search: createSessionSearchToolDefinition(this.session) as unknown as ToolDefinition,
			session_entry_get: createSessionEntryGetToolDefinition(this.session) as unknown as ToolDefinition,
			websearch: createWebsearchToolDefinition(
				parseWebsearchToolOptions(this.settingsManager.getToolSettings("websearch")),
			) as unknown as ToolDefinition,
			subagent: createSubagentToolDefinition({
				runner: this._subagentRunner,
				modelCatalog: formatSubagentModelCatalog(this.model, this._getSubagentModels()),
				resolveModelHint: (hint) => this._resolveSubagentModelHint(hint),
				trustProjectAgents: this._trustProjectAgents,
				runRegistry: this._subagentRunRegistry,
				configRegistry: this._subagentConfigRegistry,
			}) as unknown as ToolDefinition,
			subagent_runs: createSubagentRunsToolDefinition(this._subagentRunRegistry) as unknown as ToolDefinition,
			create_subagent: createCreateSubagentToolDefinition(this._subagentConfigRegistry) as unknown as ToolDefinition,
		};
	}

	private _initializeRuntimeLsp(operations: ToolOperations): void {
		const daemonOwnedLsp = operations.getBackendInfo?.().type === "remote";
		if (daemonOwnedLsp || this._baseToolsOverride || !this._lspConfiguration.enabled) {
			this._lspRuntimeState = undefined;
			return;
		}
		this._lspRuntimeState = createLspRuntimeState(operations.cwd, {
			configuration: this._lspConfiguration,
			connectionFactories: this._lspConnectionFactories,
			getToolBackendInfo: () => operations.getBackendInfo?.() ?? { type: "local", cwd: operations.cwd },
			getToolOperations: () => operations,
		});
		this._registerLspToolDefinitions(() => {
			if (!this._lspRuntimeState) throw new Error("LSP was disabled while a tool call was in progress");
			return this._lspRuntimeState;
		});
	}

	private _restoreRuntimeBuildSnapshot(
		snapshot: RuntimeBuildSnapshot,
		workspaceToolHost: WorkspaceToolHost | undefined,
	): void {
		const failedExtensionRunner = this._extensionRunner as ExtensionRunner | undefined;
		const failedLspRuntimeState = this._lspRuntimeState;
		this._workspaceToolHost = snapshot.workspaceToolHost;
		this._baseToolDefinitions = snapshot.baseToolDefinitions;
		this._lspRuntimeState = snapshot.lspRuntimeState;
		this._toolRegistry = snapshot.toolRegistry;
		this._toolDefinitions = snapshot.toolDefinitions;
		this._toolPromptSnippets = snapshot.toolPromptSnippets;
		this._toolPromptGuidelines = snapshot.toolPromptGuidelines;
		this._baseSystemPrompt = snapshot.baseSystemPrompt;
		if (snapshot.baseSystemPromptOptions) this._baseSystemPromptOptions = snapshot.baseSystemPromptOptions;
		this.agent.state.tools = snapshot.agentTools;
		this.agent.state.systemPrompt = snapshot.agentSystemPrompt;
		if (failedExtensionRunner !== snapshot.extensionRunner) {
			failedExtensionRunner?.invalidate(STALE_EXTENSION_CONTEXT_MESSAGE);
			this._extensionErrorUnsubscriber?.();
			this._extensionErrorUnsubscriber = undefined;
			this._extensionRunner = snapshot.extensionRunner as ExtensionRunner;
			if (snapshot.extensionRunner) this._applyExtensionBindings(snapshot.extensionRunner);
		}
		if (this._extensionRunnerRef) this._extensionRunnerRef.current = snapshot.extensionRunnerRef;
		if (failedLspRuntimeState && failedLspRuntimeState !== snapshot.lspRuntimeState) {
			void failedLspRuntimeState.manager.shutdownAll();
		}
		void workspaceToolHost?.dispose();
	}

	private _buildRuntime(options: BuildRuntimeOptions): void {
		const operations = this.getToolOperations();
		const snapshot = this._captureRuntimeBuildSnapshot();
		const workspaceToolHost = this._baseToolsOverride ? undefined : this._createWorkspaceToolHost(operations);
		try {
			const baseToolDefinitions = this._createRuntimeBaseToolDefinitions(workspaceToolHost);
			this._baseToolDefinitions = new Map(Object.entries(baseToolDefinitions));
			this._initializeRuntimeLsp(operations);

			this._baseToolDefinitions.set("load_tool", this._createLoadToolDefinition());
			this._baseToolDefinitions.set("unload_tool", this._createUnloadToolDefinition());

			const extensionsResult = this._resourceLoader.getExtensions();
			if (options.flagValues) {
				for (const [name, value] of options.flagValues) {
					extensionsResult.runtime.flagValues.set(name, value);
				}
			}

			this._extensionRunner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				this._cwd,
				this.session,
				this._modelRegistry,
			);
			if (this._extensionRunnerRef) {
				this._extensionRunnerRef.current = this._extensionRunner;
			}
			this._bindExtensionCore(this._extensionRunner);
			this._applyExtensionBindings(this._extensionRunner);
			this._workspaceToolHost = workspaceToolHost;

			const defaultActiveToolNames = this._baseToolsOverride
				? Object.keys(this._baseToolsOverride)
				: getDefaultActiveToolNames();
			const baseActiveToolNames = this._withCurrentDefaultTools(options.activeToolNames ?? defaultActiveToolNames);
			this._refreshToolRegistry({
				activeToolNames: baseActiveToolNames,
				includeAllExtensionTools: options.includeAllExtensionTools,
			});
		} catch (error) {
			this._restoreRuntimeBuildSnapshot(snapshot, workspaceToolHost);
			throw error;
		}
	}

	private _withCurrentDefaultTools(activeToolNames: string[]): string[] {
		if (this._baseToolsOverride || this._allowedToolNames) {
			return activeToolNames.filter((name) => !this._excludedToolNames.has(name));
		}
		const active = new Set(activeToolNames);
		const usesDefaultCoreTools = CORE_DEFAULT_TOOL_NAMES.every((toolName) => active.has(toolName));
		const expanded = usesDefaultCoreTools
			? [...activeToolNames, ...getDefaultActiveToolNames().filter((toolName) => !active.has(toolName))]
			: activeToolNames;
		return expanded.filter((toolName) => !this._excludedToolNames.has(toolName));
	}
	private _isToolPermitted(name: string): boolean {
		return !this._excludedToolNames.has(name) && (!this._allowedToolNames || this._allowedToolNames.has(name));
	}

	reload(): Promise<AgentSessionReloadResult> {
		if (this._disposed) return Promise.reject(new Error("Cannot reload after AgentSession disposal"));
		return this._enqueueRuntimeLifecycle(() => this._reload());
	}

	private async _reload(): Promise<AgentSessionReloadResult> {
		const previousRunner = this._extensionRunner;
		const previousLspRuntimeState = this._lspRuntimeState;
		const previousWorkspaceToolHost = this._workspaceToolHost;
		const previousRetiredWorkspaceToolHosts = [...this._retiredWorkspaceToolHosts];
		const previousFlagValues = previousRunner.getFlagValues();
		await this.settingsManager.reload();
		let lspResult: LoadLspConfigurationResult | undefined;
		if (this._resolveLspConfiguration) {
			lspResult = await this._resolveLspConfiguration();
			this._lspConfiguration = structuredClone(lspResult.configuration);
			this._onLspConfigurationDiagnostics?.(structuredClone(lspResult.diagnostics));
		}
		await this._resourceLoader.reload();
		resetApiProviders();
		const activeToolNames = this._withCurrentDefaultTools(this.getActiveToolNames());
		this._buildRuntime({
			activeToolNames,
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});
		this._retiredWorkspaceToolHosts = [];
		try {
			await emitSessionShutdownEvent(previousRunner, { type: "session_shutdown", reason: "reload" });
		} finally {
			previousRunner.invalidate(STALE_EXTENSION_CONTEXT_MESSAGE);
			await Promise.all([
				previousLspRuntimeState?.manager.shutdownAll(),
				previousWorkspaceToolHost?.dispose(),
				...previousRetiredWorkspaceToolHosts.map((host) => host.dispose()),
			]);
		}

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
		return lspResult ? { lsp: structuredClone(lspResult) } : {};
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, this.model?.contextWindow ?? 0)) return false;
		return isRetryableAssistantError(message);
	}

	private _summarizationRetryCallbacks(source: SummarizationRetrySource): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this._emit({ type: "summarization_retry_attempt_start", ...source });
			},
			onRetryFinished: () => {
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session unless options.record is false.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.operations Custom ToolOperations for remote execution
	 * @param options.record If false, result won't be stored in agent state or session history
	 * @param options.truncate If false, returned output won't be truncated
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: ExecuteBashOptions,
	): Promise<BashResult> {
		return this._runActivity("bash execution", async () => {
			const abortController = new AbortController();
			this._bashAbortControllers.add(abortController);

			// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
			const prefix = this.settingsManager.getShellCommandPrefix();
			const shellPath = this.settingsManager.getShellPath();
			const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

			try {
				const operations =
					options?.operations ??
					this._toolOperations ??
					createLocalBashOperations({ cwd: this.session.getCwd(), shellPath });
				const result = await executeBashWithOperations(resolvedCommand, operations.cwd, operations, {
					onChunk,
					signal: abortController.signal,
					truncate: options?.truncate,
				});

				if (options?.record !== false) this._recordBashResult(command, result, options);
				return result;
			} finally {
				this._bashAbortControllers.delete(abortController);
			}
		});
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: RecordBashResultOptions): void {
		if (this._disposed) throw new Error("Agent session is disposed");
		this._runSynchronousActivity("bash result recording", () => this._recordBashResult(command, result, options));
	}

	private _recordBashResult(command: string, result: BashResult, options?: RecordBashResultOptions): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this._isAgentRunActive) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.session.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const controller of this._bashAbortControllers) controller.abort();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.session.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	private async _prepareTreeNavigation(
		preparation: TreePreparation,
		settings: TreeNavigationSettings,
		shouldSummarize: boolean,
		signal: AbortSignal,
	): Promise<TreeExtensionPreparationResult> {
		if (!this._extensionRunner.hasHandlers("session_before_tree")) {
			return { ...settings, cancelled: false, fromExtension: false };
		}
		const result = (await this._extensionRunner.emit({
			type: "session_before_tree",
			preparation,
			signal,
		})) as SessionBeforeTreeResult | undefined;
		if (result?.cancel) return { ...settings, cancelled: true, fromExtension: false };
		return {
			customInstructions: result?.customInstructions ?? settings.customInstructions,
			replaceInstructions: result?.replaceInstructions ?? settings.replaceInstructions,
			label: result?.label ?? settings.label,
			cancelled: false,
			extensionSummary: shouldSummarize ? result?.summary : undefined,
			fromExtension: shouldSummarize && result?.summary !== undefined,
		};
	}

	private async _resolveTreeSummary(
		entriesToSummarize: SessionEntry[],
		shouldSummarize: boolean,
		preparation: TreeExtensionPreparationResult,
		signal: AbortSignal,
	): Promise<TreeSummaryResolution> {
		if (preparation.extensionSummary) {
			return {
				cancelled: false,
				summaryText: preparation.extensionSummary.summary,
				summaryDetails: preparation.extensionSummary.details,
				fromExtension: true,
			};
		}
		if (!shouldSummarize || entriesToSummarize.length === 0) {
			return { cancelled: false, fromExtension: false };
		}
		const model = this.model!;
		const { apiKey, headers } = await this._getCompactionRequestAuth(model);
		const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
		const result = await generateBranchSummary(entriesToSummarize, {
			model,
			apiKey,
			headers,
			signal,
			customInstructions: preparation.customInstructions,
			replaceInstructions: preparation.replaceInstructions,
			reserveTokens: branchSummarySettings.reserveTokens,
			streamFn: this.agent.streamFn,
			retry: this.settingsManager.getRetrySettings(),
			callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
		});
		if (result.aborted) return { cancelled: true, aborted: true, fromExtension: false };
		if (result.error) throw new Error(result.error);
		return {
			cancelled: false,
			summaryText: result.summary,
			summaryDetails: {
				readFiles: result.readFiles || [],
				modifiedFiles: result.modifiedFiles || [],
			},
			fromExtension: false,
		};
	}

	private _resolveTreeTarget(targetEntry: SessionEntry, targetId: string): TreeTargetResolution {
		if (targetEntry.type === "message" && targetEntry.message.role === "user") {
			return {
				newLeafId: targetEntry.parentId,
				editorText: this._extractUserMessageText(targetEntry.message),
			};
		}
		if (targetEntry.type === "custom_message") {
			const editorText =
				typeof targetEntry.content === "string"
					? targetEntry.content
					: targetEntry.content
							.filter((content): content is TextContent => content.type === "text")
							.map((content) => content.text)
							.join("");
			return { newLeafId: targetEntry.parentId, editorText };
		}
		return { newLeafId: targetId };
	}

	private _switchTreeLeaf(
		targetId: string,
		newLeafId: string | null,
		summary: TreeSummaryResolution,
		label: string | undefined,
	): BranchSummaryEntry | undefined {
		let summaryEntry: BranchSummaryEntry | undefined;
		if (summary.summaryText) {
			const summaryId = this.session.branchWithSummary(
				newLeafId,
				summary.summaryText,
				summary.summaryDetails,
				summary.fromExtension,
			);
			summaryEntry = this.session.getEntry(summaryId) as BranchSummaryEntry;
			if (label) this.session.appendLabelChange(summaryId, label);
		} else if (newLeafId === null) {
			this.session.resetLeaf();
		} else {
			this.session.branch(newLeafId);
		}
		if (label && !summary.summaryText) this.session.appendLabelChange(targetId, label);
		return summaryEntry;
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.session.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.session.getSessionName() } as const;
		void this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	navigateTree(targetId: string, options: NavigateTreeOptions = {}): Promise<NavigateTreeResult> {
		return this._runActivity("tree navigation", () => this._navigateTree(targetId, options));
	}

	private async _navigateTree(targetId: string, options: NavigateTreeOptions = {}): Promise<NavigateTreeResult> {
		const oldLeafId = this.session.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.session.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.session,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		const navigationSettings: TreeNavigationSettings = {
			customInstructions: options.customInstructions,
			replaceInstructions: options.replaceInstructions,
			label: options.label,
		};

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions: navigationSettings.customInstructions,
			replaceInstructions: navigationSettings.replaceInstructions,
			label: navigationSettings.label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			const extensionPreparation = await this._prepareTreeNavigation(
				preparation,
				navigationSettings,
				options.summarize ?? false,
				this._branchSummaryAbortController.signal,
			);
			if (extensionPreparation.cancelled) return { cancelled: true };
			const summary = await this._resolveTreeSummary(
				entriesToSummarize,
				options.summarize ?? false,
				extensionPreparation,
				this._branchSummaryAbortController.signal,
			);
			if (summary.cancelled) return { cancelled: true, aborted: summary.aborted };
			const { newLeafId, editorText } = this._resolveTreeTarget(targetEntry, targetId);
			const summaryEntry = this._switchTreeLeaf(targetId, newLeafId, summary, extensionPreparation.label);

			// Update agent state
			const sessionContext = this.session.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.session.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summary.summaryText ? summary.fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): ForkableUserMessage[] {
		const entries = this.session.getEntries();
		const result: ForkableUserMessage[] = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this._extractUserMessageText(entry.message);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	private _extractUserMessageText(message: UserMessage): string {
		const { content } = message;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("");
		}
		return "";
	}

	/**
	 * Get session statistics.
	 */
	getSessionStats(): SessionStats {
		const state = this.state;
		const userMessages = state.messages.filter((m) => m.role === "user").length;
		const assistantMessages = state.messages.filter((m) => m.role === "assistant").length;
		const toolResults = state.messages.filter((m) => m.role === "toolResult").length;

		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalCost += assistantMsg.usage.cost.total;
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: state.messages.length,
			tokens: {
				input: totalInput,
				output: totalOutput,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
			},
			cost: totalCost,
			contextUsage: this.getContextUsage(),
		};
	}

	private _hasUsableAssistantUsageAfterCompaction(
		branchEntries: SessionEntry[],
		latestCompaction: CompactionEntry,
	): boolean {
		const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
		for (let index = branchEntries.length - 1; index > compactionIndex; index--) {
			const entry = branchEntries[index];
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const assistant = entry.message;
			if (assistant.stopReason === "aborted" || assistant.stopReason === "error") continue;
			return calculateContextTokens(assistant.usage) > 0;
		}
		return false;
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.session.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction && !this._hasUsableAssistantUsageAfterCompaction(branchEntries, latestCompaction)) {
			return { tokens: null, contextWindow, percent: null };
		}

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const themeName = this.settingsManager.getTheme();

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.session.getCwd(),
		});

		return await exportSessionToHtml(this.session, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		const filePath = resolvePath(
			outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
			process.cwd(),
		);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.session.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.session.getCwd(),
		};

		const branchEntries = this.session.getBranch();
		const lines = [JSON.stringify(header)];

		// Re-chain parentIds to form a linear sequence
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
