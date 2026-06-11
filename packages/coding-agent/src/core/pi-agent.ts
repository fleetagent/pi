import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Agent, type AgentMessage, type ThinkingLevel } from "@fleetagent/pi-agent-core";
import { clampThinkingLevel, type ImageContent, type Message, type Model, streamSimple } from "@fleetagent/pi-ai";
import chalk from "chalk";
import { getAgentDir } from "../config.ts";
import { InteractiveMode, runPrintMode, runRpcMode } from "../modes/index.ts";
import { stopThemeWatcher } from "../modes/interactive/theme/theme.ts";
import { AgentSession } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { AuthStorage } from "./auth-storage.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type {
	ExtensionRunner,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolDefinition,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import { convertToLlm } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import { findInitialModel } from "./model-resolver.ts";
import { restoreStdout, takeOverStdout } from "./output-guard.ts";
import { DefaultResourceLoader, type DefaultResourceLoaderOptions, type ResourceLoader } from "./resource-loader.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import {
	getDefaultSessionDir,
	LocalSessionManager,
	type Session,
	type SessionInfo,
	type SessionListProgress,
	type SessionManager,
} from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { isInstallTelemetryEnabled } from "./telemetry.ts";
import { printTimings, time } from "./timings.ts";
import type { ToolName, ToolOperations } from "./tools/index.ts";

export interface PiAgentDiagnostic {
	type: "info" | "warning" | "error";
	message: string;
}

export interface PiAgentServices {
	cwd: string;
	agentDir: string;
	authStorage: AuthStorage;
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	resourceLoader: ResourceLoader;
	diagnostics: PiAgentDiagnostic[];
}

export interface PiAgentSessionOptions {
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	tools?: string[];
	noTools?: "all" | "builtin";
	customTools?: ToolDefinition[];
	toolOperations?: ToolOperations;
}

export interface ResolvePiAgentSessionOptionsContext {
	services: PiAgentServices;
	session: Session;
	sessionStartEvent?: SessionStartEvent;
}

export interface ResolvePiAgentSessionOptionsResult extends PiAgentSessionOptions {
	diagnostics?: PiAgentDiagnostic[];
}

export interface CreatePiAgentOptions extends PiAgentSessionOptions {
	/** Runtime mode. Default: embedded SDK usage. */
	mode?: PiAgentAppMode;
	cwd?: string;
	agentDir?: string;
	/** Session lifecycle/discovery backend. Default: local JSONL sessions for cwd. */
	sessionManager?: SessionManager;
	/** Shared auth storage reused across runtime recreation. */
	authStorage?: AuthStorage;
	settingsManager?: SettingsManager;
	modelRegistry?: ModelRegistry;
	extensionFlagValues?: Map<string, boolean | string>;
	resourceLoader?: ResourceLoader;
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
	resolveSessionOptions?: (
		context: ResolvePiAgentSessionOptionsContext,
	) => Promise<ResolvePiAgentSessionOptionsResult> | ResolvePiAgentSessionOptionsResult;
}

export interface CreatePiAgentSessionOptions {
	/** Initial active conversation state. Default: sessionManager.create(). */
	session?: Session;
	sessionStartEvent?: SessionStartEvent;
}

export type PiAgentAppMode = "embedded" | "interactive" | "print" | "json" | "rpc";

export interface RunPiAgentModeOptions {
	mode?: PiAgentAppMode;
	migratedProviders?: string[];
	initialMessage?: string;
	initialImages?: ImageContent[];
	initialMessages?: string[];
	verbose?: boolean;
	startupBenchmark?: boolean;
}

export interface PiAgentRuntimeHost {
	readonly services: PiAgentServices;
	readonly session: AgentSession;
	readonly diagnostics: readonly PiAgentDiagnostic[];
	readonly modelFallbackMessage: string | undefined;
	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void;
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void;
	switchSession(
		sessionPath: string,
		options?: { cwdOverride?: string; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }>;
	newSession(options?: {
		id?: string;
		parentSession?: string;
		setup?: (session: Session) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;
	fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }>;
	importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }>;
	listSessions(onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	listAllSessions(onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	dispose(): Promise<void>;
}

export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

function getAttributionHeaders(
	model: Model<any>,
	settingsManager: SettingsManager,
	sessionId?: string,
): Record<string, string> | undefined {
	if (
		sessionId &&
		(model.provider === "opencode" || model.provider === "opencode-go" || model.baseUrl.includes("opencode.ai"))
	) {
		return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
	}

	if (!isInstallTelemetryEnabled(settingsManager)) {
		return undefined;
	}

	if (model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai")) {
		return {
			"HTTP-Referer": "https://pi.dev",
			"X-OpenRouter-Title": "pi",
			"X-OpenRouter-Categories": "cli-agent",
		};
	}

	if (
		model.provider === "cloudflare-workers-ai" ||
		model.provider === "cloudflare-ai-gateway" ||
		model.baseUrl.includes("api.cloudflare.com") ||
		model.baseUrl.includes("gateway.ai.cloudflare.com")
	) {
		return {
			"User-Agent": "pi-coding-agent",
		};
	}

	return undefined;
}

function applyExtensionFlagValues(
	resourceLoader: ResourceLoader,
	extensionFlagValues: Map<string, boolean | string> | undefined,
): PiAgentDiagnostic[] {
	if (!extensionFlagValues) {
		return [];
	}

	const diagnostics: PiAgentDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const extension of extensionsResult.extensions) {
		for (const [name, flag] of extension.flags) {
			registeredFlags.set(name, { type: flag.type });
		}
	}

	const unknownFlags: string[] = [];
	for (const [name, value] of extensionFlagValues) {
		const flag = registeredFlags.get(name);
		if (!flag) {
			unknownFlags.push(name);
			continue;
		}
		if (flag.type === "boolean") {
			extensionsResult.runtime.flagValues.set(name, true);
			continue;
		}
		if (typeof value === "string") {
			extensionsResult.runtime.flagValues.set(name, value);
			continue;
		}
		diagnostics.push({
			type: "error",
			message: `Extension flag "--${name}" requires a value`,
		});
	}

	if (unknownFlags.length > 0) {
		diagnostics.push({
			type: "error",
			message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
		});
	}

	return diagnostics;
}

/**
 * Application-level composition root for pi's coding agent runtime.
 *
 * PiAgent owns common app services, the session lifecycle backend, and the
 * current active AgentSession. Conversation behavior stays in AgentSession;
 * session lifecycle/discovery stays in SessionManager implementations.
 */
export class PiAgent {
	private readonly initialCwd: string;
	readonly agentDir: string;
	readonly sessionManager: SessionManager;
	readonly authStorage: AuthStorage;

	private readonly options: CreatePiAgentOptions;
	private _mode: PiAgentAppMode;
	private _session?: AgentSession;
	private _services?: PiAgentServices;
	private _diagnostics: PiAgentDiagnostic[] = [];
	private _modelFallbackMessage?: string;
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private beforeSessionInvalidate?: () => void;

	private constructor(
		options: CreatePiAgentOptions,
		resolved: {
			cwd: string;
			agentDir: string;
			sessionManager: SessionManager;
			authStorage: AuthStorage;
		},
	) {
		this.options = options;
		this._mode = options.mode ?? "embedded";
		this.initialCwd = resolved.cwd;
		this.agentDir = resolved.agentDir;
		this.sessionManager = resolved.sessionManager;
		this.authStorage = resolved.authStorage;
	}

	static setupStdio(options: { mode: PiAgentAppMode }): void {
		if (options.mode !== "embedded" && options.mode !== "interactive") {
			takeOverStdout();
		}
	}

	static async create(options: CreatePiAgentOptions = {}): Promise<PiAgent> {
		const cwd = options.cwd ?? process.cwd();
		const agentDir = options.agentDir ?? getAgentDir();
		const sessionManager =
			options.sessionManager ?? new LocalSessionManager({ cwd, sessionDir: getDefaultSessionDir(cwd, agentDir) });
		const authStorage = options.authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));
		return new PiAgent(options, { cwd, agentDir, sessionManager, authStorage });
	}

	get mode(): PiAgentAppMode {
		return this._mode;
	}

	get cwd(): string {
		return this._services?.cwd ?? this.initialCwd;
	}

	async readPipedStdin(): Promise<string | undefined> {
		if (this._mode === "embedded" || this._mode === "rpc" || process.stdin.isTTY) {
			return undefined;
		}

		const stdinContent = await new Promise<string | undefined>((resolve) => {
			let data = "";
			process.stdin.setEncoding("utf8");
			process.stdin.on("data", (chunk) => {
				data += chunk;
			});
			process.stdin.on("end", () => {
				resolve(data.trim() || undefined);
			});
			process.stdin.resume();
		});

		if (stdinContent !== undefined && this._mode === "interactive") {
			this._mode = "print";
		}
		return stdinContent;
	}

	private async createServices(cwd: string): Promise<PiAgentServices> {
		const settingsManager = this.options.settingsManager ?? SettingsManager.create(cwd, this.agentDir);
		const modelRegistry =
			this.options.modelRegistry ?? ModelRegistry.create(this.authStorage, join(this.agentDir, "models.json"));
		const resourceLoader =
			this.options.resourceLoader ??
			new DefaultResourceLoader({
				...(this.options.resourceLoaderOptions ?? {}),
				cwd,
				agentDir: this.agentDir,
				settingsManager,
			});
		await resourceLoader.reload();

		const diagnostics: PiAgentDiagnostic[] = [];
		const extensionsResult = resourceLoader.getExtensions();
		for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
			try {
				modelRegistry.registerProvider(name, config);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				diagnostics.push({
					type: "error",
					message: `Extension "${extensionPath}" error: ${message}`,
				});
			}
		}
		extensionsResult.runtime.pendingProviderRegistrations = [];
		diagnostics.push(...applyExtensionFlagValues(resourceLoader, this.options.extensionFlagValues));

		return {
			cwd,
			agentDir: this.agentDir,
			authStorage: this.authStorage,
			settingsManager,
			modelRegistry,
			resourceLoader,
			diagnostics,
		};
	}

	private async buildAgentSession(
		activeSession: Session,
		sessionStartEvent?: SessionStartEvent,
	): Promise<{
		session: AgentSession;
		services: PiAgentServices;
		diagnostics: PiAgentDiagnostic[];
		modelFallbackMessage?: string;
	}> {
		const services = await this.createServices(activeSession.getCwd());
		const diagnostics: PiAgentDiagnostic[] = [
			...services.diagnostics,
			...services.resourceLoader.getExtensions().errors.map(({ path, error }) => ({
				type: "error" as const,
				message: `Failed to load extension "${path}": ${error}`,
			})),
		];
		const resolvedOptions =
			(await this.options.resolveSessionOptions?.({ services, session: activeSession, sessionStartEvent })) ?? {};
		diagnostics.push(...(resolvedOptions.diagnostics ?? []));
		const sessionOptions: PiAgentSessionOptions = {
			model: resolvedOptions.model ?? this.options.model,
			thinkingLevel: resolvedOptions.thinkingLevel ?? this.options.thinkingLevel,
			scopedModels: resolvedOptions.scopedModels ?? this.options.scopedModels,
			tools: resolvedOptions.tools ?? this.options.tools,
			noTools: resolvedOptions.noTools ?? this.options.noTools,
			customTools: resolvedOptions.customTools ?? this.options.customTools,
			toolOperations: resolvedOptions.toolOperations ?? this.options.toolOperations,
		};

		const existingSession = activeSession.buildSessionContext();
		const hasExistingSession = existingSession.messages.length > 0;
		const hasThinkingEntry = activeSession.getBranch().some((entry) => entry.type === "thinking_level_change");

		let model = sessionOptions.model;
		let modelFallbackMessage: string | undefined;

		if (model) {
			model = services.modelRegistry.find(model.provider, model.id) ?? model;
		}

		if (!model && hasExistingSession && existingSession.model) {
			const restoredModel = services.modelRegistry.find(
				existingSession.model.provider,
				existingSession.model.modelId,
			);
			if (restoredModel && services.modelRegistry.hasConfiguredAuth(restoredModel)) {
				model = restoredModel;
			}
			if (!model) {
				modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
			}
		}

		if (!model) {
			const result = await findInitialModel({
				scopedModels: [],
				isContinuing: hasExistingSession,
				defaultProvider: services.settingsManager.getDefaultProvider(),
				defaultModelId: services.settingsManager.getDefaultModel(),
				defaultThinkingLevel: services.settingsManager.getDefaultThinkingLevel(),
				modelRegistry: services.modelRegistry,
			});
			model = result.model;
			if (!model) {
				modelFallbackMessage = formatNoModelsAvailableMessage();
			} else if (modelFallbackMessage) {
				modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
			}
		}

		let thinkingLevel = sessionOptions.thinkingLevel;
		if (thinkingLevel === undefined && hasExistingSession) {
			thinkingLevel = hasThinkingEntry
				? (existingSession.thinkingLevel as ThinkingLevel)
				: (services.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
		}
		if (thinkingLevel === undefined) {
			thinkingLevel = services.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		thinkingLevel = model ? (clampThinkingLevel(model, thinkingLevel) as ThinkingLevel) : "off";

		const defaultActiveToolNames: ToolName[] = ["read", "bash", "edit", "write"];
		const allowedToolNames = sessionOptions.tools ?? (sessionOptions.noTools === "all" ? [] : undefined);
		const initialActiveToolNames: string[] = sessionOptions.tools
			? [...sessionOptions.tools]
			: sessionOptions.noTools
				? []
				: defaultActiveToolNames;

		const extensionRunnerRef: { current?: ExtensionRunner } = {};
		const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
			const converted = convertToLlm(messages);
			if (!services.settingsManager.getBlockImages()) {
				return converted;
			}
			return converted.map((msg) => {
				if (msg.role === "user" || msg.role === "toolResult") {
					const content = msg.content;
					if (Array.isArray(content)) {
						const hasImages = content.some((c) => c.type === "image");
						if (hasImages) {
							const filteredContent = content
								.map((c) =>
									c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
								)
								.filter(
									(c, i, arr) =>
										!(
											c.type === "text" &&
											c.text === "Image reading is disabled." &&
											i > 0 &&
											arr[i - 1].type === "text" &&
											(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
										),
								);
							return { ...msg, content: filteredContent };
						}
					}
				}
				return msg;
			});
		};

		const agent = new Agent({
			initialState: {
				systemPrompt: "",
				model,
				thinkingLevel,
				tools: [],
			},
			convertToLlm: convertToLlmWithBlockImages,
			streamFn: async (model, context, options) => {
				const auth = await services.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok) {
					throw new Error(auth.error);
				}
				const providerRetrySettings = services.settingsManager.getProviderRetrySettings();
				const timeoutMs =
					options?.timeoutMs ??
					providerRetrySettings.timeoutMs ??
					(model.api === "openai-codex-responses" ? services.settingsManager.getHttpIdleTimeoutMs() : undefined);
				const websocketConnectTimeoutMs =
					options?.websocketConnectTimeoutMs ?? services.settingsManager.getWebSocketConnectTimeoutMs();
				const attributionHeaders = getAttributionHeaders(model, services.settingsManager, options?.sessionId);
				return streamSimple(model, context, {
					...options,
					apiKey: auth.apiKey,
					timeoutMs,
					websocketConnectTimeoutMs,
					maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
					headers:
						attributionHeaders || auth.headers || options?.headers
							? { ...attributionHeaders, ...auth.headers, ...options?.headers }
							: undefined,
				});
			},
			onPayload: async (payload) => {
				const runner = extensionRunnerRef.current;
				if (!runner?.hasHandlers("before_provider_request")) {
					return payload;
				}
				return runner.emitBeforeProviderRequest(payload);
			},
			onResponse: async (response) => {
				const runner = extensionRunnerRef.current;
				if (!runner?.hasHandlers("after_provider_response")) {
					return;
				}
				await runner.emit({
					type: "after_provider_response",
					status: response.status,
					headers: response.headers,
				});
			},
			sessionId: activeSession.getSessionId(),
			transformContext: async (messages) => {
				const runner = extensionRunnerRef.current;
				return runner ? runner.emitContext(messages) : messages;
			},
			steeringMode: services.settingsManager.getSteeringMode(),
			followUpMode: services.settingsManager.getFollowUpMode(),
			transport: services.settingsManager.getTransport(),
			thinkingBudgets: services.settingsManager.getThinkingBudgets(),
			maxRetryDelayMs: services.settingsManager.getProviderRetrySettings().maxRetryDelayMs,
		});

		if (hasExistingSession) {
			agent.state.messages = existingSession.messages;
			if (!hasThinkingEntry) {
				activeSession.appendThinkingLevelChange(thinkingLevel);
			}
		} else {
			if (model) {
				activeSession.appendModelChange(model.provider, model.id);
			}
			activeSession.appendThinkingLevelChange(thinkingLevel);
		}

		return {
			session: new AgentSession({
				agent,
				session: activeSession,
				settingsManager: services.settingsManager,
				cwd: services.cwd,
				scopedModels: sessionOptions.scopedModels,
				resourceLoader: services.resourceLoader,
				customTools: sessionOptions.customTools,
				toolOperations: sessionOptions.toolOperations,
				modelRegistry: services.modelRegistry,
				initialActiveToolNames,
				allowedToolNames,
				extensionRunnerRef,
				sessionStartEvent,
			}),
			services,
			diagnostics,
			modelFallbackMessage,
		};
	}

	private apply(result: {
		session: AgentSession;
		services: PiAgentServices;
		diagnostics: PiAgentDiagnostic[];
		modelFallbackMessage?: string;
	}): void {
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
	}

	async createAgentSession(options: CreatePiAgentSessionOptions = {}): Promise<AgentSession> {
		const initialSession = options.session ?? (await this.sessionManager.create());
		assertSessionCwdExists(initialSession, initialSession.getCwd());
		this.apply(await this.buildAgentSession(initialSession, options.sessionStartEvent));
		return this.session;
	}

	get runtime(): PiAgent {
		if (!this._session) {
			throw new Error("PiAgent session has not been created. Call createAgentSession() first.");
		}
		return this;
	}

	get services(): PiAgentServices {
		if (!this._services) {
			throw new Error("PiAgent services have not been created. Call createAgentSession() first.");
		}
		return this._services;
	}

	get session(): AgentSession {
		if (!this._session) {
			throw new Error("PiAgent session has not been created. Call createAgentSession() first.");
		}
		return this._session;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	get settingsManager(): SettingsManager {
		return this.services.settingsManager;
	}

	get modelRegistry(): ModelRegistry {
		return this.services.modelRegistry;
	}

	get resourceLoader(): ResourceLoader {
		return this.services.resourceLoader;
	}

	get diagnostics(): readonly PiAgentDiagnostic[] {
		return this._diagnostics;
	}

	get currentCwd(): string {
		return this.services.cwd;
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionReference?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionReference,
			targetSessionFile: targetSessionReference,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private async flushActiveSession(): Promise<void> {
		const flushPendingSync = (this.session.session as { flushPendingSync?: () => Promise<void> }).flushPendingSync;
		if (flushPendingSync) {
			await flushPendingSync.call(this.session.session);
		}
	}

	private async teardownCurrent(
		reason: SessionShutdownEvent["reason"],
		targetSessionReference?: string,
	): Promise<void> {
		await emitSessionShutdownEvent(this.session.extensionRunner, {
			type: "session_shutdown",
			reason,
			targetSessionReference,
			targetSessionFile: targetSessionReference,
		});
		await this.flushActiveSession();
		this.beforeSessionInvalidate?.();
		this.session.dispose();
	}

	private async finishSessionReplacement(withSession?: (ctx: ReplacedSessionContext) => Promise<void>): Promise<void> {
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
		if (withSession) {
			await withSession(this.session.createReplacedSessionContext());
		}
	}

	async switchSession(
		sessionPath: string,
		options?: { cwdOverride?: string; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionReference = this.session.sessionReference;
		const nextSession = await this.sessionManager.openReference(sessionPath, { cwdOverride: options?.cwdOverride });
		assertSessionCwdExists(nextSession, this.services.cwd);
		await this.teardownCurrent("resume", nextSession.getSessionReference());
		this.apply(
			await this.buildAgentSession(nextSession, {
				type: "session_start",
				reason: "resume",
				previousSessionReference,
				previousSessionFile: previousSessionReference,
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async newSession(options?: {
		id?: string;
		parentSession?: string;
		setup?: (session: Session) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionReference = this.session.sessionReference;
		const activeSession = this.session.session;
		const newSessionOptions = {
			id: options?.id,
			parentSession: options?.parentSession ?? activeSession.getSessionReference(),
		};
		let nextSession: Session;
		try {
			nextSession = await activeSession.createSubSession(newSessionOptions);
		} catch (error) {
			if (!(error instanceof Error && error.message === "Session manager unavailable")) {
				throw error;
			}
			nextSession = await this.sessionManager.create(newSessionOptions);
		}

		await this.teardownCurrent("new", nextSession.getSessionReference());
		this.apply(
			await this.buildAgentSession(nextSession, {
				type: "session_start",
				reason: "new",
				previousSessionReference,
				previousSessionFile: previousSessionReference,
			}),
		);
		if (options?.setup) {
			await options.setup(this.session.session);
			this.session.agent.state.messages = this.session.session.buildSessionContext().messages;
		}
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this.session.session.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const previousSessionReference = this.session.sessionReference;
		const activeSession = this.session.session;
		let nextSession: Session;
		try {
			nextSession = await activeSession.forkSubSession(targetLeafId);
		} catch (error) {
			if (!(error instanceof Error && error.message === "Session manager unavailable")) {
				throw error;
			}
			nextSession = await this.sessionManager.forkSession(activeSession, targetLeafId);
		}
		await this.teardownCurrent("fork", nextSession.getSessionReference());
		this.apply(
			await this.buildAgentSession(nextSession, {
				type: "session_start",
				reason: "fork",
				previousSessionReference,
				previousSessionFile: previousSessionReference,
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false, selectedText };
	}

	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolve(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		const beforeResult = await this.emitBeforeSwitch("resume", resolvedPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionReference = this.session.sessionReference;
		const nextSession = await this.sessionManager.importJsonl(resolvedPath, { cwdOverride: cwdOverride });
		assertSessionCwdExists(nextSession, this.services.cwd);
		await this.teardownCurrent("resume", nextSession.getSessionReference());
		this.apply(
			await this.buildAgentSession(nextSession, {
				type: "session_start",
				reason: "resume",
				previousSessionReference,
				previousSessionFile: previousSessionReference,
			}),
		);
		await this.finishSessionReplacement();
		return { cancelled: false };
	}

	async runMode(options: RunPiAgentModeOptions = {}): Promise<void> {
		const mode = options.mode ?? this._mode;
		if (mode === "embedded") {
			return;
		}

		if (mode !== "interactive" && !this.session.model) {
			console.error(chalk.red(formatNoModelsAvailableMessage()));
			process.exit(1);
		}

		if (options.startupBenchmark && mode !== "interactive") {
			console.error(chalk.red("Error: PI_STARTUP_BENCHMARK only supports interactive mode"));
			process.exit(1);
		}

		if (mode === "rpc") {
			printTimings();
			await runRpcMode(this);
			return;
		}

		if (mode === "interactive") {
			const interactiveMode = new InteractiveMode(this, {
				migratedProviders: options.migratedProviders,
				modelFallbackMessage: this.modelFallbackMessage,
				initialMessage: options.initialMessage,
				initialImages: options.initialImages,
				initialMessages: options.initialMessages,
				verbose: options.verbose,
			});
			if (options.startupBenchmark) {
				await interactiveMode.init();
				time("interactiveMode.init");
				printTimings();
				interactiveMode.stop();
				stopThemeWatcher();
				if (process.stdout.writableLength > 0) {
					await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
				}
				if (process.stderr.writableLength > 0) {
					await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
				}
				return;
			}

			printTimings();
			await interactiveMode.run();
			return;
		}

		printTimings();
		const exitCode = await runPrintMode(this, {
			mode: mode === "json" ? "json" : "text",
			messages: options.initialMessages,
			initialMessage: options.initialMessage,
			initialImages: options.initialImages,
		});
		stopThemeWatcher();
		restoreStdout();
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
	}

	createSession(): Session | Promise<Session> {
		return this.sessionManager.create();
	}

	openSessionReference(reference: string): Session | Promise<Session> {
		return this.sessionManager.openReference(reference);
	}

	continueRecentSession(): Session | Promise<Session> {
		return this.sessionManager.continueRecent();
	}

	forkSessionFrom(reference: string): Session | Promise<Session> {
		return this.sessionManager.forkFrom(reference);
	}

	async listSessions(onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		return this.sessionManager.list(onProgress);
	}

	async listAllSessions(onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		return this.sessionManager.listAll(onProgress);
	}

	async dispose(): Promise<void> {
		if (!this._session) {
			return;
		}
		await emitSessionShutdownEvent(this.session.extensionRunner, {
			type: "session_shutdown",
			reason: "quit",
		});
		await this.flushActiveSession();
		this.beforeSessionInvalidate?.();
		this.session.dispose();
		this._session = undefined;
	}
}
