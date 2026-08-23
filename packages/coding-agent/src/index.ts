// Core session management

export type { TuiMode } from "@fleetagent/pi-tui";
// Config paths
export { getAgentDir, VERSION } from "./config.ts";
export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type AgentSessionReloadResult,
	type ModelCycleResult,
	type ParsedSkillBlock,
	type PromptOptions,
	parseSkillBlock,
	type SessionStats,
	type StructuredResponse,
	type StructuredResponseOptions,
} from "./core/agent-session.ts";
// Auth and model registry
export {
	type ApiKeyCredential,
	type AuthCredential,
	type AuthStatus,
	AuthStorage,
	type AuthStorageBackend,
	FileAuthStorageBackend,
	InMemoryAuthStorageBackend,
	type OAuthCredential,
} from "./core/auth-storage.ts";
// Compaction
export {
	type BranchPreparation,
	type BranchSummaryResult,
	type CollectEntriesResult,
	collectEntriesForBranchSummary,
	type GenerateBranchSummaryOptions,
	generateBranchSummary,
	prepareBranchEntries,
} from "./core/compaction/branch-summarization.ts";
export {
	type CompactionResult,
	type CutPointResult,
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	generateSummary,
	getLastAssistantUsage,
	shouldCompact,
} from "./core/compaction/compaction.ts";
export { type FileOperations, serializeConversation } from "./core/compaction/utils.ts";
export { createEventBus, type EventBus, type EventBusController } from "./core/event-bus.ts";
export { createExtensionRuntime, discoverAndLoadExtensions } from "./core/extensions/loader.ts";
export { ExtensionRunner } from "./core/extensions/runner.ts";
// Extension system
export type {
	AgentEndEvent,
	AgentSettledEvent,
	AgentStartEvent,
	AgentToolResult,
	AgentToolUpdateCallback,
	AppKeybinding,
	AutocompleteProviderFactory,
	BashResult,
	BashToolCallEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	BuildSystemPromptOptions,
	CompactOptions,
	ContextEvent,
	ContextUsage,
	CustomToolCallEvent,
	EditToolCallEvent,
	ExecOptions,
	ExecResult,
	Extension,
	ExtensionActions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFactory,
	ExtensionFlag,
	ExtensionHandler,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionToolBackendExecOptions,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	FindToolCallEvent,
	GrepToolCallEvent,
	InputEvent,
	InputEventResult,
	InputSource,
	KeybindingsManager,
	LoadExtensionsResult,
	LsToolCallEvent,
	MarkdownTransformContext,
	MarkdownTransformer,
	MessageRenderer,
	MessageRenderOptions,
	ProviderConfig,
	ProviderModelConfig,
	ReadToolCallEvent,
	RegisteredCommand,
	RegisteredTool,
	ResolvedCommand,
	SessionBeforeCompactEvent,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionBeforeTreeEvent,
	SessionCompactEvent,
	SessionInfoChangedEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionTreeEvent,
	SubagentToolCallEvent,
	TerminalInputHandler,
	ToolCallEvent,
	ToolCallEventResult,
	ToolDefinition,
	ToolExecutionMode,
	ToolInfo,
	ToolRenderResultOptions,
	ToolResultEvent,
	TurnEndEvent,
	TurnStartEvent,
	UserBashEvent,
	UserBashEventResult,
	WebsearchToolCallEvent,
	WebsearchToolResultEvent,
	WidgetPlacement,
	WorkingIndicatorOptions,
	WriteToolCallEvent,
} from "./core/extensions/types.ts";
export {
	defineTool,
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isReadToolResult,
	isSubagentToolResult,
	isToolCallEventType,
	isWebsearchToolResult,
	isWriteToolResult,
} from "./core/extensions/types.ts";
export { wrapRegisteredTool, wrapRegisteredTools } from "./core/extensions/wrapper.ts";
// Footer data provider (git branch + extension statuses - data not otherwise available to extensions)
export type { ReadonlyFooterDataProvider } from "./core/footer-data-provider.ts";
export {
	formatInstructionResourcesForPrompt,
	type InstructionResource,
	type InstructionResourceFrontmatter,
	InstructionResourceLoader,
	type InstructionResourceLoaderConfig,
	type InstructionResourceLoaderOptions,
	type InstructionResourceLoaderWithOperationsOptions,
} from "./core/instruction-resource-loader.ts";
export {
	LspClient,
	type LspClientOptions,
	type LspClientStartResult,
	type LspConnectionState,
	type LspDocumentSyncCapabilities,
} from "./core/lsp/client.ts";
export {
	type LspClientInfo,
	type LspConfigurationDiagnostic,
	type LspConfigurationLayer,
	type LspConfigurationMode,
	type LspConfiguredServer,
	type LspDisabledServer,
	type LspDocumentSelector,
	type LspJsonValue,
	type LspNamedPipeTransport,
	type LspPathMapping,
	type LspProgrammaticTransport,
	type LspServerEntry,
	type LspServerFeatures,
	type LspServerLifecycle,
	type LspServerTimeouts,
	type LspSpawnTransport,
	type LspTcpTransport,
	type LspTraceValue,
	type LspTransport,
	type LspUnixSocketTransport,
	type LspWorkspaceRoot,
	type ParseLspConfigurationResult,
	parseLspConfiguration,
	type ResolvedLspConfiguration,
	resolveLspConfiguration,
} from "./core/lsp/config.ts";
export {
	type LoadLspConfigurationOptions,
	type LoadLspConfigurationResult,
	type LspConfigurationInput,
	type LspConfigurationInputScope,
	type LspConfigurationSourceDiagnostic,
	loadLspConfiguration,
	resolveLspConfigurationLayerPaths,
} from "./core/lsp/config-loader.ts";
export {
	createLspDiagnosticsTool,
	formatAutoDiagnosticsForChangedFile,
	type LspDiagnosticsDetails,
} from "./core/lsp/diagnostics.ts";
export {
	LspFileSync,
	type LspSynchronizationFailure,
	type LspSynchronizationResult,
	type LspTrackedDocument,
} from "./core/lsp/file-sync.ts";
export {
	createLspRuntimeState,
	createLspToolDefinitions,
	LSP_TOOL_NAMES,
	type LspLifecycleOptions,
	type LspRuntimeState,
	type LspSessionStatus,
	type LspToolName,
	registerLspLifecycleHandlers,
	registerStandaloneLspLifecycleHandlers,
} from "./core/lsp/integration.ts";
export {
	LspPathMapper,
	type LspPathMappingResult,
	type LspRouteFailure,
	type LspRouteResult,
	LspRouter,
	type LspRouterOptions,
	type LspRouteTarget,
} from "./core/lsp/language-map.ts";
export {
	type LspClientRoute,
	type LspClientRouteCollection,
	type LspClientRouteFailure,
	type LspClientStartedListener,
	type LspClientsWillShutdownListener,
	LspManager,
	type LspManagerOptions,
	type LspServerStatus,
	type LspToolFeature,
} from "./core/lsp/manager.ts";
export {
	createLspDefinitionTool,
	createLspHoverTool,
	createLspReferencesTool,
	type LspHoverDetails,
	type LspLocationDetails,
} from "./core/lsp/navigation.ts";
export {
	createLspCodeActionsTool,
	createLspRenameTool,
	type LspCodeActionsDetails,
	type LspRenameDetails,
} from "./core/lsp/refactor.ts";
export {
	createManagedStdioConnectionFactory,
	createNamedPipeConnectionFactory,
	createTcpConnectionFactory,
	createUnixSocketConnectionFactory,
	type LspConnectionDisposalMode,
	type LspConnectionEndpoint,
	type LspConnectionFactory,
	type LspConnectionFactoryContext,
	type LspConnectionFactoryRegistry,
	type LspConnectionHandle,
	resolveLspConnectionFactory,
} from "./core/lsp/transport.ts";
export { convertToLlm } from "./core/messages.ts";
export { ModelRegistry } from "./core/model-registry.ts";
export type {
	PackageManager,
	PathMetadata,
	ProgressCallback,
	ProgressEvent,
	ResolvedPaths,
	ResolvedResource,
} from "./core/package-manager.ts";
export { DefaultPackageManager } from "./core/package-manager.ts";
export {
	type CreatePiAgentOptions,
	PiAgent,
	type PiAgentDiagnostic,
	type PiAgentRuntimeHost,
	type PiAgentServices,
	type PiAgentSessionOptions,
	type ResolvePiAgentSessionOptionsContext,
	type ResolvePiAgentSessionOptionsResult,
} from "./core/pi-agent.ts";
export type { PromptTemplate } from "./core/prompt-templates.ts";
export type {
	ProjectContextFile,
	ResourceCollision,
	ResourceDiagnostic,
	ResourceLoader,
} from "./core/resource-loader.ts";
export { DefaultResourceLoader, loadProjectContextFiles } from "./core/resource-loader.ts";
// Rules
export {
	formatRulesForPrompt,
	type LoadRulesFromDirOptions,
	type LoadRulesOptions,
	type LoadRulesResult,
	type LoadRulesWithOperationsOptions,
	loadRules,
	loadRulesFromDir,
	type Rule,
	type RuleFrontmatter,
	RuleLoader,
} from "./core/rules.ts";
export { CURRENT_SESSION_VERSION } from "./core/session/constants.ts";
export { buildSessionContext, getLatestCompactionEntry } from "./core/session/context.ts";
export { InMemorySessionManager } from "./core/session/in-memory-session-manager.ts";
export {
	JsonlDecodeError,
	type JsonlDecodeKind,
	type JsonlErrorPhase,
	JsonlSessionError,
	type JsonlSessionErrorCode,
	type JsonlWriteOutcome,
} from "./core/session/jsonl-errors.ts";
export { LocalSessionManager } from "./core/session/local-session-manager.ts";
export { migrateSessionEntries, parseSessionEntries } from "./core/session/migrations.ts";
export {
	RemoteSessionClient,
	RemoteSessionClientError,
	type RemoteSessionClientOptions,
	type RemoteSessionOperation,
	RemoteSessionProtocolError,
} from "./core/session/remote-session-client.ts";
export { RemoteSessionManager } from "./core/session/remote-session-manager.ts";
export type { SessionManager } from "./core/session/session-manager.ts";
export { SessionAlreadyExistsError } from "./core/session/stores/jsonl-session-store.ts";
export type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	CustomMessageEntry,
	FileEntry,
	ModelChangeEntry,
	NewSessionOptions,
	SessionContext,
	SessionEntry,
	SessionEntryBase,
	SessionHeader,
	SessionInfo,
	SessionInfoEntry,
	SessionMessageEntry,
	SessionTreeNode,
	ThinkingLevelChangeEntry,
} from "./core/session/types.ts";
export {
	type CompactionSettings,
	type FullscreenExitOutput,
	type ImageSettings,
	type MarkdownSettings,
	type MermaidRenderingMode,
	type PackageSource,
	type RetrySettings,
	SettingsManager,
	type ToolSettings,
} from "./core/settings-manager.ts";
// Skills
export {
	formatSkillsForPrompt,
	type LoadSkillsFromDirOptions,
	type LoadSkillsOptions,
	type LoadSkillsResult,
	type LoadSkillsWithOperationsOptions,
	loadSkills,
	loadSkillsFromDir,
	type Skill,
	type SkillFrontmatter,
	SkillLoader,
} from "./core/skills.ts";
export type { SlashCommandInfo, SlashCommandSource } from "./core/slash-commands.ts";
export type { SourceInfo } from "./core/source-info.ts";
export { createSyntheticSourceInfo } from "./core/source-info.ts";
// Tools
export {
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./core/tools/bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./core/tools/edit.ts";
export { withFileMutationQueue } from "./core/tools/file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./core/tools/find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./core/tools/grep.ts";
export { createCodingTools, createReadOnlyTools, type ToolsOptions } from "./core/tools/index.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./core/tools/ls.ts";
export {
	createRemoteToolOperations,
	createSshToolOperations,
	DeferredRemoteToolOperations,
	type DeferredRemoteToolOperationsConfigureSshOptions,
	LocalToolOperations,
	type LocalToolOperationsOptions,
	type ParsedSshTarget,
	RemoteToolOperations,
	SshToolOperations,
	type SshToolOperationsOptions,
	type ToolAccessMode,
	type ToolBackendInfo,
	type ToolExecOptions,
	type ToolFileStat,
	type ToolGlobOptions,
	type ToolGrepMatch,
	type ToolGrepOptions,
	type ToolGrepResult,
	type ToolOperations,
} from "./core/tools/operations.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOperations,
	type ReadToolOperationsSelection,
	type ReadToolOptions,
} from "./core/tools/read.ts";
export {
	createSessionEntryGetTool,
	createSessionEntryGetToolDefinition,
	createSessionSearchTool,
	createSessionSearchToolDefinition,
	type SessionEntryGetToolDetails,
	type SessionEntryGetToolInput,
	type SessionSearchMatch,
	type SessionSearchScope,
	type SessionSearchToolDetails,
	type SessionSearchToolInput,
} from "./core/tools/session-history.ts";
export {
	createSubagentTool,
	createSubagentToolDefinition,
	type SubagentDetails,
	type SubagentResult,
	type SubagentRunInfo,
	type SubagentRunner,
	type SubagentRunOutcome,
	type SubagentRunRegistry,
	type SubagentRunRequest,
	type SubagentRunsToolInput,
	type SubagentStatus,
	type SubagentToolInput,
	type SubagentToolOptions,
	type SubagentUsageStats,
} from "./core/tools/subagent.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./core/tools/truncate.ts";
export {
	createWebsearchTool,
	createWebsearchToolDefinition,
	parseBraveSearchResponse,
	parseDuckDuckGoResponse,
	parseFirecrawlSearchResponse,
	parseWebsearchToolOptions,
	type WebsearchProvider,
	type WebsearchResultItem,
	type WebsearchToolDetails,
	type WebsearchToolInput,
	type WebsearchToolOptions,
} from "./core/tools/websearch.ts";
export {
	WORKSPACE_TOOL_NAMES,
	type WorkspaceToolCatalogEntry,
	type WorkspaceToolDefinition,
	WorkspaceToolHost,
	type WorkspaceToolHostOptions,
	type WorkspaceToolInvocation,
	type WorkspaceToolName,
	type WorkspaceToolOptions,
} from "./core/tools/workspace-tool-host.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteToolInput,
	type WriteToolOptions,
} from "./core/tools/write.ts";
export type { WorkspaceIdentity } from "./core/workspace-identity.ts";
// Main entry point
export { type MainOptions, main } from "./main.ts";
// UI components for extensions
export { AssistantMessageComponent } from "./modes/interactive/components/assistant-message.ts";
export { BashExecutionComponent } from "./modes/interactive/components/bash-execution.ts";
export { BorderedLoader } from "./modes/interactive/components/bordered-loader.ts";
export { BranchSummaryMessageComponent } from "./modes/interactive/components/branch-summary-message.ts";
export { CompactionSummaryMessageComponent } from "./modes/interactive/components/compaction-summary-message.ts";
export { CustomEditor } from "./modes/interactive/components/custom-editor.ts";
export { CustomMessageComponent } from "./modes/interactive/components/custom-message.ts";
export { type RenderDiffOptions, renderDiff } from "./modes/interactive/components/diff.ts";
export { DynamicBorder } from "./modes/interactive/components/dynamic-border.ts";
export { ExtensionEditorComponent } from "./modes/interactive/components/extension-editor.ts";
export { ExtensionInputComponent } from "./modes/interactive/components/extension-input.ts";
export { ExtensionSelectorComponent } from "./modes/interactive/components/extension-selector.ts";
export { FooterComponent } from "./modes/interactive/components/footer.ts";
export { keyHint, keyText, rawKeyHint } from "./modes/interactive/components/keybinding-hints.ts";
export { LoginDialogComponent } from "./modes/interactive/components/login-dialog.ts";
export { ModelSelectorComponent } from "./modes/interactive/components/model-selector.ts";
export { OAuthSelectorComponent } from "./modes/interactive/components/oauth-selector.ts";
export { SessionSelectorComponent } from "./modes/interactive/components/session-selector.ts";
export {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "./modes/interactive/components/settings-selector.ts";
export { ShowImagesSelectorComponent } from "./modes/interactive/components/show-images-selector.ts";
export { SkillInvocationMessageComponent } from "./modes/interactive/components/skill-invocation-message.ts";
export { ThemeSelectorComponent } from "./modes/interactive/components/theme-selector.ts";
export { ThinkingSelectorComponent } from "./modes/interactive/components/thinking-selector.ts";
export { ToolExecutionComponent, type ToolExecutionOptions } from "./modes/interactive/components/tool-execution.ts";
export { TreeSelectorComponent } from "./modes/interactive/components/tree-selector.ts";
export { UserMessageComponent } from "./modes/interactive/components/user-message.ts";
export { UserMessageSelectorComponent } from "./modes/interactive/components/user-message-selector.ts";
export { truncateToVisualLines, type VisualTruncateResult } from "./modes/interactive/components/visual-truncate.ts";
// Run modes for programmatic SDK usage
export { InteractiveMode, type InteractiveModeOptions } from "./modes/interactive/interactive-mode.ts";
// Theme utilities for custom tools and extensions
export {
	getLanguageFromPath,
	getMarkdownTheme,
	getSelectListTheme,
	getSettingsListTheme,
	highlightCode,
	initTheme,
	Theme,
	type ThemeColor,
} from "./modes/interactive/theme/theme.ts";
export type { JsonAgentSessionEvent } from "./modes/json-event.ts";
export { type PrintModeOptions, runPrintMode } from "./modes/print-mode.ts";
export {
	type ModelInfo,
	RpcClient,
	type RpcClientOptions,
	type RpcEventListener,
	type RpcToolHandler,
} from "./modes/rpc/rpc-client.ts";
export { runRpcMode } from "./modes/rpc/rpc-mode.ts";
export type {
	RpcClientListSessionsResponse,
	RpcCommand,
	RpcInstructionDefinition,
	RpcListSessionsOptions,
	RpcListSessionsResponse,
	RpcResponse,
	RpcSessionState,
	RpcToolCallRequest,
	RpcToolDefinition,
} from "./modes/rpc/rpc-types.ts";
// Clipboard utilities
export { copyToClipboard } from "./utils/clipboard.ts";
export { parseFrontmatter, stripFrontmatter } from "./utils/frontmatter.ts";
// Shell utilities
export { getShellConfig } from "./utils/shell.ts";
