/**
 * Extension runner - executes extensions and manages their lifecycle.
 */

import type { AgentMessage } from "@fleetagent/pi-agent-core";
import type { ImageContent, Model, ProviderHeaders } from "@fleetagent/pi-ai";
import type { KeyId } from "@fleetagent/pi-tui";
import { type Theme, theme } from "../../modes/interactive/theme/theme.ts";
import { executeBashWithOperations } from "../bash-executor.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { KeybindingsConfig } from "../keybindings.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { Session } from "../session/session.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	CompactOptions,
	ContextEvent,
	ContextEventResult,
	ContextUsage,
	Extension,
	ExtensionActions,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFlag,
	ExtensionForkOptions,
	ExtensionNavigateTreeOptions,
	ExtensionNewSessionOptions,
	ExtensionRuntime,
	ExtensionSessionActionResult,
	ExtensionShortcut,
	ExtensionSwitchSessionOptions,
	ExtensionUIContext,
	InputEvent,
	InputEventResult,
	InputSource,
	MarkdownTransformer,
	MessageEndEvent,
	MessageEndEventResult,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	RegisteredTool,
	ResolvedCommand,
	ResourcesDiscoverEvent,
	ResourcesDiscoverReason,
	ResourcesDiscoverResult,
	SessionBeforeCompactResult,
	SessionBeforeForkResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionShutdownEvent,
	StreamingBehavior,
	ToolCallEvent,
	ToolCallEventResult,
	ToolDefinition,
	ToolResultEvent,
	ToolResultEventResult,
	UserBashEvent,
	UserBashEventResult,
} from "./types.ts";

// Extension shortcuts compete with canonical keybinding ids from keybindings.json.
// Only editor-global shortcuts are reserved here. Picker-specific bindings are not.
const RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS = new Set([
	"app.interrupt",
	"app.clear",
	"app.exit",
	"app.suspend",
	"app.thinking.cycle",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.tools.expand",
	"app.thinking.toggle",
	"app.editor.external",
	"app.message.copy",
	"app.message.followUp",
	"tui.input.submit",
	"tui.select.confirm",
	"tui.select.cancel",
	"tui.input.copy",
	"tui.editor.deleteToLineEnd",
]);

type BuiltInKeyBindings = Partial<Record<KeyId, { keybinding: string; restrictOverride: boolean }>>;

const buildBuiltinKeybindings = (resolvedKeybindings: KeybindingsConfig): BuiltInKeyBindings => {
	const builtinKeybindings = {} as BuiltInKeyBindings;
	for (const [keybinding, keys] of Object.entries(resolvedKeybindings)) {
		if (keys === undefined) continue;
		const keyList = Array.isArray(keys) ? keys : [keys];
		const restrictOverride = RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS.has(keybinding);
		for (const key of keyList) {
			const normalizedKey = key.toLowerCase() as KeyId;
			// If multiple actions bind the same key, the reserved action wins so extensions
			// remain blocked by reserved shortcuts regardless of iteration order.
			const existing = builtinKeybindings[normalizedKey];
			if (existing?.restrictOverride && !restrictOverride) continue;
			builtinKeybindings[normalizedKey] = {
				keybinding,
				restrictOverride,
			};
		}
	}
	return builtinKeybindings;
};

interface MessageEndExtensionResult {
	message: AgentMessage;
	modified: boolean;
}

/** Combined result from all before_agent_start handlers */
interface BeforeAgentStartCombinedResult {
	messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPrompt?: string;
}

// pi-ignore noNearIdenticalDataStructures: Mutable extension dispatch state tracks optional in-flight attachments, while ProcessedFiles is the completed CLI file-loading result.
interface InputDispatchState {
	text: string;
	images: ImageContent[] | undefined;
}

interface BeforeAgentStartDispatchState {
	currentSystemPrompt: string;
	messages: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPromptModified: boolean;
}

interface ProviderRegistrationActions {
	registerProvider?(name: string, config: ProviderConfig): void;
	unregisterProvider?(name: string): void;
}

type ExtensionResourcePath = {
	path: string;
	extensionPath: string;
};

interface AggregatedResourcesDiscoverResult {
	skillPaths: ExtensionResourcePath[];
	rulePaths: ExtensionResourcePath[];
	promptPaths: ExtensionResourcePath[];
	themePaths: ExtensionResourcePath[];
}

async function callContextHandlerAbortable<T>(fn: () => Promise<T> | T, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		throw new Error("Agent run aborted");
	}

	let cleanup = () => {};
	const abortPromise = new Promise<never>((_resolve, reject) => {
		const onAbort = () => reject(new Error("Agent run aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		cleanup = () => signal.removeEventListener("abort", onAbort);
	});

	try {
		return await Promise.race([Promise.resolve().then(fn), abortPromise]);
	} finally {
		cleanup();
	}
}

/**
 * Events handled by the generic emit() method.
 * Events with dedicated emitXxx() methods are excluded for stronger type safety.
 */
type RunnerEmitEvent = Exclude<
	ExtensionEvent,
	| ToolCallEvent
	| ToolResultEvent
	| UserBashEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| BeforeProviderHeadersEvent
	| BeforeAgentStartEvent
	| MessageEndEvent
	| ResourcesDiscoverEvent
	| InputEvent
>;

type SessionBeforeEvent = Extract<
	RunnerEmitEvent,
	{ type: "session_before_switch" | "session_before_fork" | "session_before_compact" | "session_before_tree" }
>;

type SessionBeforeEventResult =
	| SessionBeforeSwitchResult
	| SessionBeforeForkResult
	| SessionBeforeCompactResult
	| SessionBeforeTreeResult;

type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: "session_before_switch" }
	? SessionBeforeSwitchResult | undefined
	: TEvent extends { type: "session_before_fork" }
		? SessionBeforeForkResult | undefined
		: TEvent extends { type: "session_before_compact" }
			? SessionBeforeCompactResult | undefined
			: TEvent extends { type: "session_before_tree" }
				? SessionBeforeTreeResult | undefined
				: undefined;

export type ExtensionErrorListener = (error: ExtensionError) => void;

export type NewSessionHandler = (options?: ExtensionNewSessionOptions) => Promise<ExtensionSessionActionResult>;

export type ForkHandler = (entryId: string, options?: ExtensionForkOptions) => Promise<ExtensionSessionActionResult>;

export type NavigateTreeHandler = (
	targetId: string,
	options?: ExtensionNavigateTreeOptions,
) => Promise<ExtensionSessionActionResult>;

export type SwitchSessionHandler = (
	sessionPath: string,
	options?: ExtensionSwitchSessionOptions,
) => Promise<ExtensionSessionActionResult>;

export type ReloadHandler = () => Promise<void>;

export type ShutdownHandler = () => void;

/**
 * Helper function to emit session_shutdown event to extensions.
 * Returns true if the event was emitted, false if there were no handlers.
 */
export async function emitSessionShutdownEvent(
	extensionRunner: ExtensionRunner,
	event: SessionShutdownEvent,
): Promise<boolean> {
	if (extensionRunner.hasHandlers("session_shutdown")) {
		await extensionRunner.emit(event);
		return true;
	}
	return false;
}

const noOpUIContext: ExtensionUIContext = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWorkingVisible: () => {},
	setWorkingIndicator: () => {},
	setHiddenThinkingLabel: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	pasteToEditor: () => {},
	setEditorText: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	setEditorComponent: () => {},
	getEditorComponent: () => undefined,
	get theme() {
		return theme;
	},
	getAllThemes: () => [],
	getTheme: () => undefined,
	setTheme: (_theme: string | Theme) => ({ success: false, error: "UI not available" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

export class ExtensionRunner {
	private extensions: Extension[];
	private runtime: ExtensionRuntime;
	private uiContext: ExtensionUIContext;
	private cwd: string;
	private session: Session;
	private modelRegistry: ModelRegistry;
	private errorListeners: Set<ExtensionErrorListener> = new Set();
	private getModel: () => Model<any> | undefined = () => undefined;
	private isIdleFn: () => boolean = () => true;
	private getSignalFn: () => AbortSignal | undefined = () => undefined;
	private waitForIdleFn: () => Promise<void> = async () => {};
	private abortFn: () => void = () => {};
	private hasPendingMessagesFn: () => boolean = () => false;
	private getContextUsageFn: () => ContextUsage | undefined = () => undefined;
	private compactFn: (options?: CompactOptions) => void = () => {};
	private getSystemPromptFn: () => string = () => "";
	private getToolOperationsFn: ExtensionContextActions["getToolOperations"];
	private getToolBackendInfoFn: ExtensionContextActions["getToolBackendInfo"];
	private getLspStatusFn: ExtensionContextActions["getLspStatus"];
	private configureLspFn: ExtensionContextActions["configureLsp"];
	private execToolBackendFn: ExtensionContextActions["execToolBackend"];
	private newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	private forkHandler: ForkHandler = async () => ({ cancelled: false });
	private navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });
	private switchSessionHandler: SwitchSessionHandler = async () => ({ cancelled: false });
	private reloadHandler: ReloadHandler = async () => {};
	private shutdownHandler: ShutdownHandler = () => {};
	private shortcutDiagnostics: ResourceDiagnostic[] = [];
	private commandDiagnostics: ResourceDiagnostic[] = [];
	private staleMessage: string | undefined;

	constructor(
		extensions: Extension[],
		runtime: ExtensionRuntime,
		cwd: string,
		session: Session,
		modelRegistry: ModelRegistry,
	) {
		this.extensions = extensions;
		this.runtime = runtime;
		this.uiContext = noOpUIContext;
		this.cwd = cwd;
		this.session = session;
		this.modelRegistry = modelRegistry;
		this.getToolOperationsFn = () => {
			throw new Error("Extension tool backend is not bound yet");
		};
		this.getToolBackendInfoFn = () =>
			this.getToolOperationsFn().getBackendInfo?.() ?? { type: "local", cwd: this.cwd };
		this.getLspStatusFn = () => ({
			owner: "standalone",
			enabled: false,
			configuration: { enabled: false, servers: [] },
			servers: [],
		});
		this.configureLspFn = async () => {
			throw new Error("Extension LSP configuration is not bound yet");
		};
		this.execToolBackendFn = async (command, options) => {
			const operations = this.getToolOperationsFn();
			return executeBashWithOperations(command, options?.cwd ?? operations.cwd, operations, options);
		};
	}

	bindCore(
		actions: ExtensionActions,
		contextActions: ExtensionContextActions,
		providerActions?: ProviderRegistrationActions,
	): void {
		// Copy actions into the shared runtime (all extension APIs reference this)
		this.runtime.sendMessage = actions.sendMessage;
		this.runtime.sendUserMessage = actions.sendUserMessage;
		this.runtime.appendEntry = actions.appendEntry;
		this.runtime.setSessionName = actions.setSessionName;
		this.runtime.getSessionName = actions.getSessionName;
		this.runtime.setLabel = actions.setLabel;
		this.runtime.getActiveTools = actions.getActiveTools;
		this.runtime.getAllTools = actions.getAllTools;
		this.runtime.setActiveTools = actions.setActiveTools;
		this.runtime.refreshTools = actions.refreshTools;
		this.runtime.getCommands = actions.getCommands;
		this.runtime.setModel = actions.setModel;
		this.runtime.getThinkingLevel = actions.getThinkingLevel;
		this.runtime.setThinkingLevel = actions.setThinkingLevel;

		// Context actions (required)
		this.getModel = contextActions.getModel;
		this.isIdleFn = contextActions.isIdle;
		this.getSignalFn = contextActions.getSignal;
		this.abortFn = contextActions.abort;
		this.hasPendingMessagesFn = contextActions.hasPendingMessages;
		this.shutdownHandler = contextActions.shutdown;
		this.getContextUsageFn = contextActions.getContextUsage;
		this.compactFn = contextActions.compact;
		this.getSystemPromptFn = contextActions.getSystemPrompt;
		this.getToolOperationsFn = contextActions.getToolOperations;
		this.getToolBackendInfoFn = contextActions.getToolBackendInfo;
		this.getLspStatusFn = contextActions.getLspStatus;
		this.configureLspFn = contextActions.configureLsp;
		this.execToolBackendFn = contextActions.execToolBackend;

		// Flush provider registrations queued during extension loading
		for (const { name, config, extensionPath } of this.runtime.pendingProviderRegistrations) {
			try {
				if (providerActions?.registerProvider) {
					providerActions.registerProvider(name, config);
				} else {
					this.modelRegistry.registerProvider(name, config);
				}
			} catch (err) {
				this.emitError({
					extensionPath,
					event: "register_provider",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		this.runtime.pendingProviderRegistrations = [];

		// From this point on, provider registration/unregistration takes effect immediately
		// without requiring a /reload.
		this.runtime.registerProvider = (name, config) => {
			if (providerActions?.registerProvider) {
				providerActions.registerProvider(name, config);
				return;
			}
			this.modelRegistry.registerProvider(name, config);
		};
		this.runtime.unregisterProvider = (name) => {
			if (providerActions?.unregisterProvider) {
				providerActions.unregisterProvider(name);
				return;
			}
			this.modelRegistry.unregisterProvider(name);
		};
	}

	bindCommandContext(actions?: ExtensionCommandContextActions): void {
		if (actions) {
			this.waitForIdleFn = actions.waitForIdle;
			this.newSessionHandler = actions.newSession;
			this.forkHandler = actions.fork;
			this.navigateTreeHandler = actions.navigateTree;
			this.switchSessionHandler = actions.switchSession;
			this.reloadHandler = actions.reload;
			return;
		}

		this.waitForIdleFn = async () => {};
		this.newSessionHandler = async () => ({ cancelled: false });
		this.forkHandler = async () => ({ cancelled: false });
		this.navigateTreeHandler = async () => ({ cancelled: false });
		this.switchSessionHandler = async () => ({ cancelled: false });
		this.reloadHandler = async () => {};
	}

	setUIContext(uiContext?: ExtensionUIContext): void {
		this.uiContext = uiContext ?? noOpUIContext;
	}

	getUIContext(): ExtensionUIContext {
		return this.uiContext;
	}

	hasUI(): boolean {
		return this.uiContext !== noOpUIContext;
	}

	getExtensionPaths(): string[] {
		return this.extensions.map((e) => e.path);
	}

	/** Get all registered tools from all extensions (first registration per name wins). */
	getAllRegisteredTools(): RegisteredTool[] {
		const toolsByName = new Map<string, RegisteredTool>();
		for (const ext of this.extensions) {
			for (const tool of ext.tools.values()) {
				if (!toolsByName.has(tool.definition.name)) {
					toolsByName.set(tool.definition.name, tool);
				}
			}
		}
		return Array.from(toolsByName.values());
	}

	getAvailableRegisteredTools(): RegisteredTool[] {
		return this.getAllRegisteredTools().filter((tool) => tool.lazy === true);
	}

	loadRegisteredTool(toolName: string): boolean {
		const tool = this.getFirstRegisteredTool(toolName);
		if (tool?.lazy !== true) return false;
		tool.loaded = true;
		return true;
	}

	unloadRegisteredTool(toolName: string): boolean {
		const tool = this.getFirstRegisteredTool(toolName);
		if (tool?.lazy !== true) return false;
		tool.loaded = false;
		return true;
	}

	private getFirstRegisteredTool(toolName: string): RegisteredTool | undefined {
		for (const ext of this.extensions) {
			const tool = ext.tools.get(toolName);
			if (tool) return tool;
		}
		return undefined;
	}

	/** Get a tool definition by name. Returns undefined if not found. */
	getToolDefinition(toolName: string): ToolDefinition | undefined {
		for (const ext of this.extensions) {
			const tool = ext.tools.get(toolName);
			if (tool) {
				return tool.definition;
			}
		}
		return undefined;
	}

	getFlags(): Map<string, ExtensionFlag> {
		const allFlags = new Map<string, ExtensionFlag>();
		for (const ext of this.extensions) {
			for (const [name, flag] of ext.flags) {
				if (!allFlags.has(name)) {
					allFlags.set(name, flag);
				}
			}
		}
		return allFlags;
	}

	setFlagValue(name: string, value: boolean | string): void {
		this.runtime.flagValues.set(name, value);
	}

	getFlagValues(): Map<string, boolean | string> {
		return new Map(this.runtime.flagValues);
	}

	getShortcuts(resolvedKeybindings: KeybindingsConfig): Map<KeyId, ExtensionShortcut> {
		this.shortcutDiagnostics = [];
		const builtinKeybindings = buildBuiltinKeybindings(resolvedKeybindings);
		const extensionShortcuts = new Map<KeyId, ExtensionShortcut>();

		const addDiagnostic = (message: string, extensionPath: string) => {
			this.shortcutDiagnostics.push({ type: "warning", message, path: extensionPath });
			if (!this.hasUI()) {
				console.warn(message);
			}
		};

		for (const ext of this.extensions) {
			for (const [key, shortcut] of ext.shortcuts) {
				const normalizedKey = key.toLowerCase() as KeyId;

				const builtInKeybinding = builtinKeybindings[normalizedKey];
				if (builtInKeybinding?.restrictOverride === true) {
					addDiagnostic(
						`Extension shortcut '${key}' from ${shortcut.extensionPath} conflicts with built-in shortcut. Skipping.`,
						shortcut.extensionPath,
					);
					continue;
				}

				if (builtInKeybinding?.restrictOverride === false) {
					addDiagnostic(
						`Extension shortcut conflict: '${key}' is built-in shortcut for ${builtInKeybinding.keybinding} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
						shortcut.extensionPath,
					);
				}

				const existingExtensionShortcut = extensionShortcuts.get(normalizedKey);
				if (existingExtensionShortcut) {
					addDiagnostic(
						`Extension shortcut conflict: '${key}' registered by both ${existingExtensionShortcut.extensionPath} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
						shortcut.extensionPath,
					);
				}
				extensionShortcuts.set(normalizedKey, shortcut);
			}
		}
		return extensionShortcuts;
	}

	getShortcutDiagnostics(): ResourceDiagnostic[] {
		return this.shortcutDiagnostics;
	}

	invalidate(
		message = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
	): void {
		if (!this.staleMessage) {
			this.staleMessage = message;
			this.runtime.invalidate(message);
		}
	}

	private assertActive(): void {
		if (this.staleMessage) {
			throw new Error(this.staleMessage);
		}
	}

	onError(listener: ExtensionErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	emitError(error: ExtensionError): void {
		for (const listener of this.errorListeners) {
			listener(error);
		}
	}
	private emitHandlerError(extensionPath: string, event: string, error: unknown): void {
		this.emitError({
			extensionPath,
			event,
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
	}

	hasHandlers(eventType: string): boolean {
		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(eventType);
			if (handlers && handlers.length > 0) {
				return true;
			}
		}
		return false;
	}

	getMessageRenderer(customType: string): MessageRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.messageRenderers.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	getMarkdownTransformers(): MarkdownTransformer[] {
		return this.extensions.flatMap((extension) =>
			extension.markdownTransformer ? [extension.markdownTransformer] : [],
		);
	}

	private resolveRegisteredCommands(): ResolvedCommand[] {
		const commands: RegisteredCommand[] = [];
		const counts = new Map<string, number>();

		for (const ext of this.extensions) {
			for (const command of ext.commands.values()) {
				commands.push(command);
				counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
			}
		}

		const seen = new Map<string, number>();
		const takenInvocationNames = new Set<string>();

		return commands.map((command) => {
			const occurrence = (seen.get(command.name) ?? 0) + 1;
			seen.set(command.name, occurrence);

			let invocationName = (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name;

			if (takenInvocationNames.has(invocationName)) {
				let suffix = occurrence;
				do {
					suffix++;
					invocationName = `${command.name}:${suffix}`;
				} while (takenInvocationNames.has(invocationName));
			}

			takenInvocationNames.add(invocationName);
			return {
				...command,
				invocationName,
			};
		});
	}

	getRegisteredCommands(): ResolvedCommand[] {
		this.commandDiagnostics = [];
		return this.resolveRegisteredCommands();
	}

	getCommandDiagnostics(): ResourceDiagnostic[] {
		return this.commandDiagnostics;
	}

	getCommand(name: string): ResolvedCommand | undefined {
		return this.resolveRegisteredCommands().find((command) => command.invocationName === name);
	}

	/**
	 * Request a graceful shutdown. Called by extension tools and event handlers.
	 * The actual shutdown behavior is provided by the mode via bindExtensions().
	 */
	shutdown(): void {
		this.shutdownHandler();
	}

	/**
	 * Create an ExtensionContext for use in event handlers and tool execution.
	 * Context values are resolved at call time, so changes via bindCore/bindUI are reflected.
	 */
	createContext(): ExtensionContext {
		const runner = this;
		const getModel = this.getModel;
		return {
			get ui() {
				runner.assertActive();
				return runner.uiContext;
			},
			get hasUI() {
				runner.assertActive();
				return runner.hasUI();
			},
			get cwd() {
				runner.assertActive();
				return runner.cwd;
			},
			get toolOperations() {
				runner.assertActive();
				return runner.getToolOperationsFn();
			},
			getToolBackendInfo: () => {
				runner.assertActive();
				return runner.getToolBackendInfoFn();
			},
			getLspStatus: () => {
				runner.assertActive();
				return runner.getLspStatusFn();
			},
			configureLsp: (configuration) => {
				runner.assertActive();
				return runner.configureLspFn(configuration);
			},
			execToolBackend: (command, options) => {
				runner.assertActive();
				return runner.execToolBackendFn(command, options);
			},
			get session() {
				runner.assertActive();
				return runner.session;
			},
			get modelRegistry() {
				runner.assertActive();
				return runner.modelRegistry;
			},
			get model() {
				runner.assertActive();
				return getModel();
			},
			isIdle: () => {
				runner.assertActive();
				return runner.isIdleFn();
			},
			get signal() {
				runner.assertActive();
				return runner.getSignalFn();
			},
			abort: () => {
				runner.assertActive();
				runner.abortFn();
			},
			hasPendingMessages: () => {
				runner.assertActive();
				return runner.hasPendingMessagesFn();
			},
			shutdown: () => {
				runner.assertActive();
				runner.shutdownHandler();
			},
			getContextUsage: () => {
				runner.assertActive();
				return runner.getContextUsageFn();
			},
			compact: (options) => {
				runner.assertActive();
				runner.compactFn(options);
			},
			getSystemPrompt: () => {
				runner.assertActive();
				return runner.getSystemPromptFn();
			},
		};
	}

	createCommandContext(): ExtensionCommandContext {
		// Use property descriptors instead of object spread so the guarded getters from
		// createContext() stay lazy. A spread would eagerly read them once and freeze the
		// old values into the returned object, bypassing stale-instance checks.
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this.createContext()),
		) as ExtensionCommandContext;
		context.waitForIdle = () => {
			this.assertActive();
			return this.waitForIdleFn();
		};
		context.newSession = (options) => {
			this.assertActive();
			return this.newSessionHandler(options);
		};
		context.fork = (entryId, options) => {
			this.assertActive();
			return this.forkHandler(entryId, options);
		};
		context.navigateTree = (targetId, options) => {
			this.assertActive();
			return this.navigateTreeHandler(targetId, options);
		};
		context.switchSession = (sessionPath, options) => {
			this.assertActive();
			return this.switchSessionHandler(sessionPath, options);
		};
		context.reload = () => {
			this.assertActive();
			return this.reloadHandler();
		};
		return context;
	}

	private isSessionBeforeEvent(event: RunnerEmitEvent): event is SessionBeforeEvent {
		return (
			event.type === "session_before_switch" ||
			event.type === "session_before_fork" ||
			event.type === "session_before_compact" ||
			event.type === "session_before_tree"
		);
	}
	private async emitGenericEventToExtension(
		extension: Extension,
		event: RunnerEmitEvent,
		context: ExtensionContext,
	): Promise<SessionBeforeEventResult | undefined> {
		const handlers = extension.handlers.get(event.type);
		if (!handlers || handlers.length === 0) return undefined;
		let result: SessionBeforeEventResult | undefined;
		for (const handler of handlers) {
			try {
				const handlerResult = await handler(event, context);
				if (!this.isSessionBeforeEvent(event) || !handlerResult) continue;
				result = handlerResult as SessionBeforeEventResult;
				if (result.cancel) return result;
			} catch (error) {
				this.emitHandlerError(extension.path, event.type, error);
			}
		}
		return result;
	}

	async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
		const context = this.createContext();
		let result: SessionBeforeEventResult | undefined;
		for (const extension of this.extensions) {
			const extensionResult = await this.emitGenericEventToExtension(extension, event, context);
			if (!extensionResult) continue;
			result = extensionResult;
			if (result.cancel) return result as RunnerEmitResult<TEvent>;
		}
		return result as RunnerEmitResult<TEvent>;
	}

	private async emitMessageEndToExtension(
		extension: Extension,
		event: MessageEndEvent,
		context: ExtensionContext,
		initialMessage: AgentMessage,
	): Promise<MessageEndExtensionResult> {
		const handlers = extension.handlers.get("message_end");
		if (!handlers || handlers.length === 0) return { message: initialMessage, modified: false };

		let message = initialMessage;
		let modified = false;
		for (const handler of handlers) {
			try {
				const currentEvent: MessageEndEvent = { ...event, message };
				const handlerResult = (await handler(currentEvent, context)) as MessageEndEventResult | undefined;
				if (!handlerResult?.message) continue;
				if (handlerResult.message.role !== message.role) {
					this.emitError({
						extensionPath: extension.path,
						event: "message_end",
						error: "message_end handlers must return a message with the same role",
					});
					continue;
				}
				message = handlerResult.message;
				modified = true;
			} catch (error) {
				this.emitHandlerError(extension.path, "message_end", error);
			}
		}
		return { message, modified };
	}

	async emitMessageEnd(event: MessageEndEvent): Promise<AgentMessage | undefined> {
		const context = this.createContext();
		let currentMessage = event.message;
		let modified = false;

		for (const extension of this.extensions) {
			const extensionResult = await this.emitMessageEndToExtension(extension, event, context, currentMessage);
			currentMessage = extensionResult.message;
			modified = modified || extensionResult.modified;
		}

		return modified ? currentMessage : undefined;
	}

	private applyToolResultUpdate(event: ToolResultEvent, result: ToolResultEventResult): boolean {
		let modified = false;
		if (result.content !== undefined) {
			event.content = result.content;
			modified = true;
		}
		if (result.details !== undefined) {
			event.details = result.details;
			modified = true;
		}
		if (result.isError !== undefined) {
			event.isError = result.isError;
			modified = true;
		}
		return modified;
	}

	private async emitToolResultToExtension(
		extension: Extension,
		event: ToolResultEvent,
		context: ExtensionContext,
	): Promise<boolean> {
		const handlers = extension.handlers.get("tool_result");
		if (!handlers || handlers.length === 0) return false;
		let modified = false;
		for (const handler of handlers) {
			try {
				const result = (await handler(event, context)) as ToolResultEventResult | undefined;
				if (!result) continue;
				if (this.applyToolResultUpdate(event, result)) modified = true;
			} catch (error) {
				this.emitHandlerError(extension.path, "tool_result", error);
			}
		}
		return modified;
	}

	async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
		const context = this.createContext();
		const currentEvent: ToolResultEvent = { ...event };
		let modified = false;
		for (const extension of this.extensions) {
			const extensionModified = await this.emitToolResultToExtension(extension, currentEvent, context);
			if (extensionModified) modified = true;
		}
		if (!modified) return undefined;
		return {
			content: currentEvent.content,
			details: currentEvent.details,
			isError: currentEvent.isError,
		};
	}

	async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		const ctx = this.createContext();
		let result: ToolCallEventResult | undefined;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_call");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const handlerResult = await handler(event, ctx);

				if (handlerResult) {
					result = handlerResult as ToolCallEventResult;
					if (result.block) {
						return result;
					}
				}
			}
		}

		return result;
	}

	private async emitUserBashToExtension(
		extension: Extension,
		event: UserBashEvent,
		context: ExtensionContext,
	): Promise<UserBashEventResult | undefined> {
		const handlers = extension.handlers.get("user_bash");
		if (!handlers || handlers.length === 0) return undefined;
		for (const handler of handlers) {
			try {
				const result = await handler(event, context);
				if (result) return result as UserBashEventResult;
			} catch (error) {
				this.emitHandlerError(extension.path, "user_bash", error);
			}
		}
		return undefined;
	}

	async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		const context = this.createContext();
		for (const extension of this.extensions) {
			const result = await this.emitUserBashToExtension(extension, event, context);
			if (result) return result;
		}
		return undefined;
	}

	private async emitContextToExtension(
		extension: Extension,
		messages: AgentMessage[],
		context: ExtensionContext,
	): Promise<AgentMessage[]> {
		const handlers = extension.handlers.get("context");
		if (!handlers || handlers.length === 0) return messages;
		let currentMessages = messages;
		for (const handler of handlers) {
			try {
				const event: ContextEvent = { type: "context", messages: currentMessages };
				const handlerResult = context.signal
					? await callContextHandlerAbortable(() => handler(event, context), context.signal)
					: await handler(event, context);
				const result = handlerResult as ContextEventResult | undefined;
				if (result?.messages) currentMessages = result.messages;
			} catch (error) {
				if (context.signal?.aborted) throw error;
				this.emitHandlerError(extension.path, "context", error);
			}
		}
		return currentMessages;
	}

	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		const context = this.createContext();
		let currentMessages = structuredClone(messages);
		for (const extension of this.extensions) {
			currentMessages = await this.emitContextToExtension(extension, currentMessages, context);
		}
		return currentMessages;
	}

	private async emitBeforeProviderRequestToExtension(
		extension: Extension,
		payload: unknown,
		context: ExtensionContext,
	): Promise<unknown> {
		const handlers = extension.handlers.get("before_provider_request");
		if (!handlers || handlers.length === 0) return payload;
		let currentPayload = payload;
		for (const handler of handlers) {
			try {
				const event: BeforeProviderRequestEvent = {
					type: "before_provider_request",
					payload: currentPayload,
				};
				const handlerResult = await handler(event, context);
				if (handlerResult !== undefined) currentPayload = handlerResult;
			} catch (error) {
				this.emitHandlerError(extension.path, "before_provider_request", error);
			}
		}
		return currentPayload;
	}

	async emitBeforeProviderRequest(payload: unknown): Promise<unknown> {
		const context = this.createContext();
		let currentPayload = payload;
		for (const extension of this.extensions) {
			currentPayload = await this.emitBeforeProviderRequestToExtension(extension, currentPayload, context);
		}
		return currentPayload;
	}

	private async emitBeforeProviderHeadersToExtension(
		extension: Extension,
		headers: ProviderHeaders,
		context: ExtensionContext,
	): Promise<void> {
		const handlers = extension.handlers.get("before_provider_headers");
		if (!handlers || handlers.length === 0) return;
		for (const handler of handlers) {
			try {
				// Handlers share one mutable map; their return values are intentionally ignored.
				const event: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers };
				await handler(event, context);
			} catch (error) {
				this.emitHandlerError(extension.path, "before_provider_headers", error);
			}
		}
	}

	async emitBeforeProviderHeaders(headers: ProviderHeaders): Promise<ProviderHeaders> {
		const context = this.createContext();
		for (const extension of this.extensions) {
			await this.emitBeforeProviderHeadersToExtension(extension, headers, context);
		}
		return headers;
	}
	private async emitBeforeAgentStartToExtension(
		extension: Extension,
		prompt: string,
		images: ImageContent[] | undefined,
		systemPromptOptions: BuildSystemPromptOptions,
		context: ExtensionContext,
		state: BeforeAgentStartDispatchState,
	): Promise<void> {
		const handlers = extension.handlers.get("before_agent_start");
		if (!handlers || handlers.length === 0) return;

		for (const handler of handlers) {
			try {
				const event: BeforeAgentStartEvent = {
					type: "before_agent_start",
					prompt,
					images,
					systemPrompt: state.currentSystemPrompt,
					systemPromptOptions,
				};
				const result = (await handler(event, context)) as BeforeAgentStartEventResult | undefined;
				if (result?.message) state.messages.push(result.message);
				if (result?.systemPrompt !== undefined) {
					state.currentSystemPrompt = result.systemPrompt;
					state.systemPromptModified = true;
				}
			} catch (error) {
				this.emitHandlerError(extension.path, "before_agent_start", error);
			}
		}
	}

	async emitBeforeAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPrompt: string,
		systemPromptOptions: BuildSystemPromptOptions,
	): Promise<BeforeAgentStartCombinedResult | undefined> {
		const state: BeforeAgentStartDispatchState = {
			currentSystemPrompt: systemPrompt,
			messages: [],
			systemPromptModified: false,
		};
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this.createContext()),
		) as ExtensionContext;
		context.getSystemPrompt = () => {
			this.assertActive();
			return state.currentSystemPrompt;
		};

		for (const extension of this.extensions) {
			await this.emitBeforeAgentStartToExtension(extension, prompt, images, systemPromptOptions, context, state);
		}

		if (state.messages.length === 0 && !state.systemPromptModified) return undefined;
		return {
			messages: state.messages.length > 0 ? state.messages : undefined,
			systemPrompt: state.systemPromptModified ? state.currentSystemPrompt : undefined,
		};
	}

	private appendDiscoveredResourcePaths(
		target: ExtensionResourcePath[],
		paths: string[] | undefined,
		extensionPath: string,
	): void {
		if (!paths?.length) return;
		target.push(...paths.map((path) => ({ path, extensionPath })));
	}

	private mergeResourcesDiscoverResult(
		discovered: AggregatedResourcesDiscoverResult,
		result: ResourcesDiscoverResult | undefined,
		extensionPath: string,
	): void {
		this.appendDiscoveredResourcePaths(discovered.skillPaths, result?.skillPaths, extensionPath);
		this.appendDiscoveredResourcePaths(discovered.rulePaths, result?.rulePaths, extensionPath);
		this.appendDiscoveredResourcePaths(discovered.promptPaths, result?.promptPaths, extensionPath);
		this.appendDiscoveredResourcePaths(discovered.themePaths, result?.themePaths, extensionPath);
	}

	private async emitResourcesDiscoverToExtension(
		extension: Extension,
		cwd: string,
		reason: ResourcesDiscoverReason,
		context: ExtensionContext,
		discovered: AggregatedResourcesDiscoverResult,
	): Promise<void> {
		const handlers = extension.handlers.get("resources_discover");
		if (!handlers || handlers.length === 0) return;

		for (const handler of handlers) {
			try {
				const event: ResourcesDiscoverEvent = { type: "resources_discover", cwd, reason };
				const handlerResult = await handler(event, context);
				this.mergeResourcesDiscoverResult(
					discovered,
					handlerResult as ResourcesDiscoverResult | undefined,
					extension.path,
				);
			} catch (error) {
				this.emitHandlerError(extension.path, "resources_discover", error);
			}
		}
	}

	async emitResourcesDiscover(
		cwd: string,
		reason: ResourcesDiscoverReason,
	): Promise<AggregatedResourcesDiscoverResult> {
		const context = this.createContext();
		const discovered: AggregatedResourcesDiscoverResult = {
			skillPaths: [],
			rulePaths: [],
			promptPaths: [],
			themePaths: [],
		};

		for (const extension of this.extensions) {
			await this.emitResourcesDiscoverToExtension(extension, cwd, reason, context, discovered);
		}
		return discovered;
	}

	private async emitInputToExtension(
		extension: Extension,
		state: InputDispatchState,
		source: InputSource,
		streamingBehavior: StreamingBehavior | undefined,
		context: ExtensionContext,
	): Promise<InputEventResult | undefined> {
		for (const handler of extension.handlers.get("input") ?? []) {
			try {
				const event: InputEvent = {
					type: "input",
					text: state.text,
					images: state.images,
					source,
					streamingBehavior,
				};
				const result = (await handler(event, context)) as InputEventResult | undefined;
				if (result?.action === "handled") return result;
				if (result?.action === "transform") {
					state.text = result.text;
					state.images = result.images ?? state.images;
				}
			} catch (error) {
				this.emitError({
					extensionPath: extension.path,
					event: "input",
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
		}
		return undefined;
	}

	/** Emit input event. Transforms chain, "handled" short-circuits. */
	async emitInput(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: StreamingBehavior,
	): Promise<InputEventResult> {
		const context = this.createContext();
		const state: InputDispatchState = { text, images };
		for (const extension of this.extensions) {
			const result = await this.emitInputToExtension(extension, state, source, streamingBehavior, context);
			if (result) return result;
		}
		return state.text !== text || state.images !== images
			? { action: "transform", text: state.text, images: state.images }
			: { action: "continue" };
	}
}
