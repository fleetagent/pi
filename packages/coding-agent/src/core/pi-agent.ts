import { existsSync, readFileSync } from "node:fs";
import { join, posix, resolve, win32 } from "node:path";
import { Agent, type ThinkingLevel } from "@fleetagent/pi-agent-core";
import {
	clampThinkingLevel,
	type ImageContent,
	type Message,
	type Model,
	refreshModelCatalog,
	streamSimple,
	type TextContent,
} from "@fleetagent/pi-ai";
import type { TuiMode } from "@fleetagent/pi-tui";
import chalk from "chalk";
import { getAgentDir } from "../config.ts";
import { InteractiveMode } from "../modes/interactive/interactive-mode.ts";
import { stopThemeWatcher } from "../modes/interactive/theme/theme.ts";
import { runPrintMode } from "../modes/print-mode.ts";
import { runRpcMode } from "../modes/rpc/rpc-mode.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { AgentSession, getDefaultActiveToolNames } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { AuthStorage } from "./auth-storage.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner } from "./extensions/runner.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type {
	ExtensionForkOptions,
	ExtensionNewSessionOptions,
	ExtensionSessionActionResult,
	ExtensionSwitchSessionOptions,
	ReplacedSessionContext,
	SessionForkPosition,
	SessionShutdownReason,
	SessionStartEvent,
	SessionSwitchReason,
	ToolDefinition,
} from "./extensions/types.ts";
import { freezeLoadedHooks, loadHooks } from "./hooks/config.ts";
import { canonicalProjectHookCwd, canonicalProjectHookIdentity } from "./hooks/trust-store.ts";
import type { HookDiagnostic, LoadedHooks } from "./hooks/types.ts";
import {
	type LoadLspConfigurationResult,
	type LspConfigurationInput,
	type LspConfigurationSourceDiagnostic,
	loadLspConfiguration,
} from "./lsp/config-loader.ts";
import type { LspConnectionFactoryRegistry } from "./lsp/transport.ts";
import { convertToLlm } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import { findInitialModel, type ResolveCliModelResult, resolveCliModel, type ScopedModel } from "./model-resolver.ts";
import { restoreStdout, takeOverStdout } from "./output-guard.ts";
import { DefaultResourceLoader, type DefaultResourceLoaderOptions, type ResourceLoader } from "./resource-loader.ts";
import { InMemorySessionManager } from "./session/in-memory-session-manager.ts";
import { getDefaultSessionDir } from "./session/jsonl-helpers.ts";
import { LocalSessionManager } from "./session/local-session-manager.ts";
import type { Session } from "./session/session.ts";
import type { SessionManager } from "./session/session-manager.ts";
import type { SessionContext, SessionInfo, SessionListProgress } from "./session/types.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import { InMemorySettingsStorage, SettingsManager } from "./settings-manager.ts";
import type { Skill } from "./skills.ts";
import { getSourceBackend } from "./source-info.ts";
import { isInstallTelemetryEnabled } from "./telemetry.ts";
import { printTimings, time } from "./timings.ts";
import {
	type BorrowedToolOperations,
	borrowToolOperations,
	type ToolBackendInfo,
	type ToolOperations,
} from "./tools/operations.ts";
import type {
	SubagentConfigRegistry,
	SubagentRunInfo,
	SubagentRunner,
	SubagentRunOutcome,
	SubagentRunRegistry,
	SubagentRunRequest,
} from "./tools/subagent.ts";

export type PiAgentDiagnosticType = "info" | "warning" | "error";
export type PiAgentToolExclusionMode = "all" | "builtin";

export interface PiAgentDiagnostic {
	type: PiAgentDiagnosticType;
	message: string;
	/** Whether this diagnostic must prevent application startup. Errors are fatal by default. */
	fatal?: boolean;
}

export function isFatalPiAgentDiagnostic(diagnostic: PiAgentDiagnostic): boolean {
	return diagnostic.type === "error" && diagnostic.fatal !== false;
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

interface HookDiscoveryResolution {
	cwd: string;
	discoverProjectHooks: boolean;
}

interface SessionModelResolution {
	model: Model<any> | undefined;
	fallbackMessage: string | undefined;
}

interface ExtensionRunnerReference {
	current?: ExtensionRunner;
}

interface BuiltAgentSession {
	session: AgentSession;
	services: PiAgentServices;
	baseDiagnostics: PiAgentDiagnostic[];
	lspDiagnostics: PiAgentDiagnostic[];
	modelFallbackMessage?: string;
}

function formatLspConfigurationDiagnostics(
	diagnostics: readonly LspConfigurationSourceDiagnostic[],
): PiAgentDiagnostic[] {
	return diagnostics.map((diagnostic) => ({
		type: diagnostic.severity,
		...(diagnostic.severity === "error" ? { fatal: false } : {}),
		message: `LSP configuration (${diagnostic.source}) ${diagnostic.path}: ${diagnostic.message}`,
	}));
}

function formatHookDiagnostic(diagnostic: HookDiagnostic): PiAgentDiagnostic {
	const source = diagnostic.source ? ` (${diagnostic.source.kind}: ${diagnostic.source.path})` : "";
	return {
		type: diagnostic.level,
		fatal: false,
		message: `Hook ${diagnostic.code}${source}: ${diagnostic.message}`,
	};
}

export interface PiAgentHooksOptions {
	/** Disable automatic trusted-user Pi and Claude-compatible hook discovery. Default: true. */
	enabled?: boolean;
	/** Override the home directory used for Claude compatibility discovery; native hooks use the active agentDir. */
	home?: string;
	/** Host ceiling for HTTP hook destinations. */
	allowedHttpHookUrls?: readonly string[];
	/** Host ceiling for HTTP hook header environment interpolation. */
	httpHookAllowedEnvVars?: readonly string[];
	/** Host-injected snapshot; cloned and frozen before use instead of reading settings files. */
	snapshot?: LoadedHooks;
}

export interface PiAgentSessionOptions {
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	scopedModels?: ScopedModel[];
	tools?: string[];
	excludedTools?: string[];
	/** Trust project-local subagent presets without an interactive host prompt. */
	trustProjectAgents?: boolean;
	/** Explicit host trust grant for project Pi and Claude-compatible hooks. Ignored by non-local backends. */
	trustProjectHooks?: boolean;
	/** Optional canonical repository identity constraining the project-hook trust grant. */
	trustedProjectHooksIdentity?: string;
	/** LSP layers or files supplied by a CLI, SDK, or host. Host scope is the default. */
	lsp?: LspConfigurationInput | LspConfigurationInput[];
	/** Host-provided factories referenced by LSP transports with type `connection`. */
	lspConnectionFactories?: LspConnectionFactoryRegistry;
	/** Trust active LSP transports from project settings after applying a host-controlled approval policy. */
	trustProjectLspTransports?: boolean;
	noTools?: PiAgentToolExclusionMode;
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
	/** Dispose toolOperations with this top-level PiAgent. Child sessions and subagents always borrow it. */
	ownsToolOperations?: boolean;
	/** Runtime mode. Default: embedded SDK usage. */
	mode?: PiAgentAppMode;
	cwd?: string;
	agentDir?: string;
	/** Claude-compatible host-local hooks, or false to disable them. */
	hooks?: false | PiAgentHooksOptions;
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
export interface PiAgentSwitchSessionOptions extends ExtensionSwitchSessionOptions {
	cwdOverride?: string;
}

export interface PiAgentForkResult extends ExtensionSessionActionResult {
	selectedText?: string;
}

export interface PiAgentStdioOptions {
	mode: PiAgentAppMode;
}

interface PiAgentResolvedDependencies {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	authStorage: AuthStorage;
}

interface ForkPreparationOptions {
	position: SessionForkPosition;
}

interface MutableSubagentRunRegistry extends SubagentRunRegistry {
	upsert(run: SubagentRunInfo): void;
	get(runId: string): SubagentRunInfo | undefined;
}

interface EmbeddedSubagentChildState {
	child: PiAgent;
	session: AgentSession;
	run: SubagentRunInfo;
	toolOperations: ToolOperations;
	backendIdentity: string;
}

interface EmbeddedSubagentRuntimeState {
	nextRunNumber: number;
	children: Map<string, EmbeddedSubagentChildState>;
}

interface EmbeddedSubagentRunnerContext {
	services: PiAgentServices;
	excludedTools: string[];
	registry: MutableSubagentRunRegistry;
	runtime: EmbeddedSubagentRuntimeState;
}

interface EmbeddedSubagentRequestContext {
	resolvedModel: ResolveCliModelResult | undefined;
	toolOperations: ToolOperations;
	backendInfo: ToolBackendInfo | undefined;
	backendIdentity: string;
}

type EmbeddedSubagentRequestResolution =
	| { context: EmbeddedSubagentRequestContext; failure?: never }
	| { context?: never; failure: SubagentRunOutcome };

interface PreparedEmbeddedSubagentChild {
	childState: EmbeddedSubagentChildState;
	runId: string;
	failure?: never;
}

type EmbeddedSubagentChildPreparation =
	| PreparedEmbeddedSubagentChild
	| { childState?: never; runId?: never; failure: SubagentRunOutcome };

type EmbeddedSubagentChildCreation =
	| { childState: EmbeddedSubagentChildState; failure?: never }
	| { childState?: never; failure: SubagentRunOutcome };

type EmbeddedSubagentSkillSelection =
	| { skills: Skill[]; failure?: never }
	| { skills?: never; failure: SubagentRunOutcome };

type EmbeddedSubagentSkillPreload =
	| { blocks: string[]; failure?: never }
	| { blocks?: never; failure: SubagentRunOutcome };

interface EmbeddedSubagentOutputState {
	lastOutput: string | undefined;
}

export type PiAgentAppMode = "embedded" | "interactive" | "print" | "json" | "rpc";

export interface RunPiAgentModeOptions {
	mode?: PiAgentAppMode;
	migratedProviders?: string[];
	initialMessage?: string;
	initialImages?: ImageContent[];
	initialMessages?: string[];
	verbose?: boolean;
	/** Startup-only interactive renderer choice. Defaults to the persisted setting. */
	tuiMode?: TuiMode;
	startupBenchmark?: boolean;
}

export interface PiAgentRuntimeHost {
	readonly services: PiAgentServices;
	readonly session: AgentSession;
	readonly diagnostics: readonly PiAgentDiagnostic[];
	readonly modelFallbackMessage: string | undefined;
	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void;
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void;
	switchSession(sessionPath: string, options?: PiAgentSwitchSessionOptions): Promise<ExtensionSessionActionResult>;
	newSession(options?: ExtensionNewSessionOptions): Promise<ExtensionSessionActionResult>;
	fork(entryId: string, options?: ExtensionForkOptions): Promise<PiAgentForkResult>;
	importFromJsonl(inputPath: string, cwdOverride?: string): Promise<ExtensionSessionActionResult>;
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

function isSubagentCwdConfined(cwd: string, operations: ToolOperations, backend: ToolBackendInfo | undefined): boolean {
	if (backend?.type === "local") return true;
	if (backend === undefined) return posix.normalize(cwd) === posix.normalize(operations.cwd);
	const pathApi =
		backend?.type === "remote" && backend.configured && backend.workspace.pathFlavor === "windows" ? win32 : posix;
	const relative = pathApi.relative(pathApi.normalize(operations.cwd), pathApi.normalize(cwd));
	return (
		relative === "" ||
		(relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative))
	);
}

function extractUserMessageText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function blockImagesInMessage(message: Message): Message {
	if (message.role !== "user" && message.role !== "toolResult") return message;
	const { content } = message;
	if (!Array.isArray(content) || !content.some((part) => part.type === "image")) return message;
	const filteredContent = content
		.map((part) => (part.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : part))
		.filter(
			(part, index, parts) =>
				!(
					part.type === "text" &&
					part.text === "Image reading is disabled." &&
					index > 0 &&
					parts[index - 1].type === "text" &&
					(parts[index - 1] as TextContent).text === "Image reading is disabled."
				),
		);
	return { ...message, content: filteredContent };
}

function asLspInputs(input: LspConfigurationInput | LspConfigurationInput[] | undefined): LspConfigurationInput[] {
	return input === undefined ? [] : Array.isArray(input) ? input : [input];
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

async function runInteractiveAppMode(
	runtimeHost: PiAgentRuntimeHost,
	modelFallbackMessage: string | undefined,
	options: RunPiAgentModeOptions,
): Promise<void> {
	const interactiveMode = new InteractiveMode(runtimeHost, {
		migratedProviders: options.migratedProviders,
		modelFallbackMessage,
		initialMessage: options.initialMessage,
		initialImages: options.initialImages,
		initialMessages: options.initialMessages,
		verbose: options.verbose,
		tuiMode: options.tuiMode,
	});
	if (options.startupBenchmark) {
		await interactiveMode.init();
		time("interactiveMode.init");
		// Give the TUI's stdin handler a brief chance to consume terminal query replies
		// (Kitty keyboard protocol, device attributes, cell size) before restoring the terminal.
		await new Promise((resolve) => setTimeout(resolve, 150));
		interactiveMode.stop();
		stopThemeWatcher();
		printTimings();
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
	private _baseDiagnostics: PiAgentDiagnostic[] = [];
	private _lspDiagnostics: PiAgentDiagnostic[] = [];
	private _modelFallbackMessage?: string;
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private readonly borrowedToolOperations: BorrowedToolOperations | undefined;
	private toolOperationsDisposed = false;
	private disposePromise: Promise<void> | undefined;
	private readonly subagentCleanupCallbacks = new Set<() => Promise<void>>();

	private constructor(options: CreatePiAgentOptions, resolved: PiAgentResolvedDependencies) {
		this.options = options;
		this.borrowedToolOperations = options.toolOperations ? borrowToolOperations(options.toolOperations) : undefined;
		this._mode = options.mode ?? "embedded";
		this.initialCwd = resolved.cwd;
		this.agentDir = resolved.agentDir;
		this.sessionManager = resolved.sessionManager;
		this.authStorage = resolved.authStorage;
	}

	static setupStdio(options: PiAgentStdioOptions): void {
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
		if (process.env.PI_MODEL_CATALOG_URL) {
			await refreshModelCatalog().catch(() => undefined);
		}
		const modelRegistry =
			this.options.modelRegistry ?? ModelRegistry.create(this.authStorage, join(this.agentDir, "models.json"));
		const resourceLoader =
			this.options.resourceLoader ??
			new DefaultResourceLoader({
				...(this.options.resourceLoaderOptions ?? {}),
				cwd,
				agentDir: this.agentDir,
				settingsManager,
				toolOperations: this.options.resourceLoaderOptions?.toolOperations
					? borrowToolOperations(this.options.resourceLoaderOptions.toolOperations)
					: this.borrowedToolOperations,
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
	private createSubagentRunRegistry(): MutableSubagentRunRegistry {
		const runs = new Map<string, SubagentRunInfo>();
		return {
			list: () => Array.from(runs.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
			upsert: (run) => runs.set(run.runId, structuredClone(run)),
			get: (runId) => runs.get(runId),
		};
	}

	private createSubagentConfigRegistry(): SubagentConfigRegistry {
		const configs = new Map<string, Parameters<SubagentConfigRegistry["upsert"]>[0]>();
		return {
			list: () => Array.from(configs.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
			upsert: (config) => configs.set(config.name, structuredClone(config)),
			get: (name) => configs.get(name),
		};
	}

	private resolveEmbeddedSubagentRequest(
		request: SubagentRunRequest,
		services: PiAgentServices,
	): EmbeddedSubagentRequestResolution {
		const resolvedModel = request.model
			? resolveCliModel({ cliModel: request.model, modelRegistry: services.modelRegistry })
			: undefined;
		if (resolvedModel?.error) return { failure: { exitCode: 1, stderr: resolvedModel.error } };
		const toolOperations = request.toolOperations;
		if (!toolOperations) {
			return { failure: { exitCode: 1, stderr: "Subagents require explicit workspace tool operations" } };
		}
		const backendInfo = toolOperations.getBackendInfo?.();
		if (backendInfo?.type === "remote" && !backendInfo.configured) {
			return { failure: { exitCode: 1, stderr: "Subagents cannot run with an unconfigured remote backend" } };
		}
		if (!isSubagentCwdConfined(request.cwd, toolOperations, backendInfo)) {
			return {
				failure: {
					exitCode: 1,
					stderr: `Sandboxed subagent cwd must stay within the sandbox workspace root: ${toolOperations.cwd}`,
				},
			};
		}
		const backendIdentity = JSON.stringify(backendInfo ?? { type: "unknown", cwd: toolOperations.cwd });
		return { context: { resolvedModel, toolOperations, backendInfo, backendIdentity } };
	}

	private selectEmbeddedSubagentSkills(
		request: SubagentRunRequest,
		services: PiAgentServices,
	): EmbeddedSubagentSkillSelection {
		const requestedSkills = request.skills ?? [];
		const loadedSkills = services.resourceLoader.getSkills().skills;
		const skillsByName = new Map<string, Skill>();
		for (const skill of loadedSkills) {
			if (!skillsByName.has(skill.name)) skillsByName.set(skill.name, skill);
		}
		const missingSkills: string[] = [];
		const skills: Skill[] = [];
		for (const name of requestedSkills) {
			const skill = skillsByName.get(name);
			if (skill) skills.push(skill);
			else missingSkills.push(name);
		}
		if (missingSkills.length > 0) {
			return { failure: { exitCode: 1, stderr: `Unknown subagent skill(s): ${missingSkills.join(", ")}` } };
		}
		return { skills };
	}

	private async loadEmbeddedSubagentSkillContent(
		skill: Skill,
		toolOperations: ToolOperations,
		backendInfo: ToolBackendInfo | undefined,
	): Promise<string> {
		if (skill.content !== undefined) return skill.content;
		if (backendInfo?.type === "local") return readFileSync(skill.filePath, "utf-8");
		if (getSourceBackend(skill.sourceInfo) === "local") {
			throw new Error("local skill files are unavailable to a sandboxed subagent");
		}
		return (await toolOperations.readFile(skill.filePath)).toString("utf-8");
	}

	private async preloadEmbeddedSubagentSkills(
		skills: Skill[],
		context: EmbeddedSubagentRequestContext,
	): Promise<EmbeddedSubagentSkillPreload> {
		const blocks: string[] = [];
		for (const skill of skills) {
			try {
				const content = await this.loadEmbeddedSubagentSkillContent(
					skill,
					context.toolOperations,
					context.backendInfo,
				);
				blocks.push(
					`<preloaded-skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${stripFrontmatter(content).trim()}\n</preloaded-skill>`,
				);
			} catch (error) {
				return {
					failure: {
						exitCode: 1,
						stderr: `Failed to preload subagent skill ${skill.name}: ${error instanceof Error ? error.message : String(error)}`,
					},
				};
			}
		}
		return { blocks };
	}

	private async createEmbeddedSubagentChild(
		request: SubagentRunRequest,
		requestContext: EmbeddedSubagentRequestContext,
		runnerContext: EmbeddedSubagentRunnerContext,
		runId: string,
	): Promise<EmbeddedSubagentChildCreation> {
		const settingsStorage = new InMemorySettingsStorage();
		settingsStorage.withLock("global", () =>
			JSON.stringify(runnerContext.services.settingsManager.getGlobalSettings()),
		);
		settingsStorage.withLock("project", () =>
			JSON.stringify(runnerContext.services.settingsManager.getProjectSettings()),
		);
		const settingsManager = SettingsManager.fromStorage(settingsStorage);
		const selection = this.selectEmbeddedSubagentSkills(request, runnerContext.services);
		if (selection.failure) return selection;
		const preload = await this.preloadEmbeddedSubagentSkills(selection.skills, requestContext);
		if (preload.failure) return preload;

		const childExcludedTools = new Set([
			"subagent",
			"subagent_runs",
			"create_subagent",
			...runnerContext.excludedTools,
		]);
		const requestedTools = request.tools ?? getDefaultActiveToolNames();
		const skillTools = selection.skills.flatMap((skill) => skill.tools ?? []);
		const tools = Array.from(new Set([...requestedTools, ...skillTools])).filter(
			(name) => !childExcludedTools.has(name),
		);
		const child = await PiAgent.create({
			mode: "embedded",
			cwd: request.cwd,
			agentDir: runnerContext.services.agentDir,
			sessionManager: new InMemorySessionManager(request.cwd),
			authStorage: runnerContext.services.authStorage,
			modelRegistry: runnerContext.services.modelRegistry,
			settingsManager,
			model: requestContext.resolvedModel?.model,
			thinkingLevel: requestContext.resolvedModel?.thinkingLevel,
			tools,
			excludedTools: Array.from(childExcludedTools),
			toolOperations: requestContext.toolOperations,
			resourceLoaderOptions: {
				toolOperations: requestContext.toolOperations,
				noExtensions: true,
				noSkills: true,
				noRules: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPrompt: "",
				appendSystemPrompt: [],
				systemPromptOverride: () => undefined,
				appendSystemPromptOverride: () => [request.systemPrompt, ...preload.blocks],
			},
		});
		const session = await child.createAgentSession();
		const now = new Date().toISOString();
		const run: SubagentRunInfo = {
			runId,
			sessionReference: session.sessionReference,
			status: "running",
			agent: request.agent,
			task: request.task,
			cwd: request.cwd,
			model: request.model,
			createdAt: now,
			updatedAt: now,
		};
		const childState: EmbeddedSubagentChildState = {
			child,
			session,
			run,
			toolOperations: requestContext.toolOperations,
			backendIdentity: requestContext.backendIdentity,
		};
		runnerContext.runtime.children.set(runId, childState);
		runnerContext.registry.upsert(run);
		return { childState };
	}

	private async prepareEmbeddedSubagentChild(
		request: SubagentRunRequest,
		requestContext: EmbeddedSubagentRequestContext,
		runnerContext: EmbeddedSubagentRunnerContext,
	): Promise<EmbeddedSubagentChildPreparation> {
		const continuedRunId = request.continueSession;
		const childState = continuedRunId ? runnerContext.runtime.children.get(continuedRunId) : undefined;
		if (request.continueSession && !childState) {
			return { failure: { exitCode: 1, stderr: `Unknown subagent run id: ${request.continueSession}` } };
		}
		if (
			childState &&
			(childState.toolOperations !== requestContext.toolOperations ||
				childState.backendIdentity !== requestContext.backendIdentity)
		) {
			await childState.child.dispose();
			runnerContext.runtime.children.delete(childState.run.runId);
			childState.run = { ...childState.run, status: "failed", updatedAt: new Date().toISOString() };
			runnerContext.registry.upsert(childState.run);
			return {
				failure: {
					exitCode: 1,
					stderr: "The parent workspace backend changed; start a new subagent instead of continuing this run",
				},
			};
		}
		if (!childState) {
			const runId = `subagent:${runnerContext.runtime.nextRunNumber++}`;
			const creation = await this.createEmbeddedSubagentChild(request, requestContext, runnerContext, runId);
			if (creation.failure) return creation;
			return { childState: creation.childState, runId };
		}
		childState.run = {
			...childState.run,
			status: "running",
			task: request.task,
			updatedAt: new Date().toISOString(),
		};
		runnerContext.registry.upsert(childState.run);
		return { childState, runId: childState.run.runId };
	}

	private subscribeToEmbeddedSubagentRun(
		childState: EmbeddedSubagentChildState,
		request: SubagentRunRequest,
		output: EmbeddedSubagentOutputState,
		registry: MutableSubagentRunRegistry,
	): () => void {
		return childState.session.subscribe((event) => {
			if (event.type !== "message_end") return;
			if (event.message.role === "assistant" || event.message.role === "toolResult") {
				request.onMessage(event.message as Message);
			}
			if (event.message.role !== "assistant") return;
			output.lastOutput =
				event.message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n") || output.lastOutput;
			childState.run = {
				...childState.run,
				lastOutput: output.lastOutput,
				updatedAt: new Date().toISOString(),
			};
			registry.upsert(childState.run);
		});
	}

	private async executeEmbeddedSubagentRun(
		request: SubagentRunRequest,
		preparation: PreparedEmbeddedSubagentChild,
		registry: MutableSubagentRunRegistry,
	): Promise<SubagentRunOutcome> {
		const { childState, runId } = preparation;
		const session = childState.session;
		const output: EmbeddedSubagentOutputState = { lastOutput: childState.run.lastOutput };
		let unsubscribe: (() => void) | undefined;
		const abort = (): void => {
			void session.abort();
		};
		try {
			unsubscribe = this.subscribeToEmbeddedSubagentRun(childState, request, output, registry);
			if (request.signal?.aborted) {
				return {
					exitCode: 1,
					stderr: "Subagent was aborted",
					runId,
					sessionReference: session.sessionReference,
				};
			}
			request.signal?.addEventListener("abort", abort, { once: true });
			await session.prompt(request.prompt);
			const status = request.signal?.aborted ? "failed" : "completed";
			childState.run = {
				...childState.run,
				status,
				lastOutput: output.lastOutput,
				updatedAt: new Date().toISOString(),
			};
			registry.upsert(childState.run);
			return {
				exitCode: request.signal?.aborted ? 1 : 0,
				stderr: "",
				runId,
				sessionReference: session.sessionReference,
			};
		} catch (error) {
			childState.run = {
				...childState.run,
				status: "failed",
				updatedAt: new Date().toISOString(),
			};
			registry.upsert(childState.run);
			return {
				exitCode: 1,
				stderr: error instanceof Error ? error.message : String(error),
				runId,
				sessionReference: session.sessionReference,
			};
		} finally {
			request.signal?.removeEventListener("abort", abort);
			unsubscribe?.();
		}
	}

	private async runEmbeddedSubagent(
		request: SubagentRunRequest,
		runnerContext: EmbeddedSubagentRunnerContext,
	): Promise<SubagentRunOutcome> {
		const resolution = this.resolveEmbeddedSubagentRequest(request, runnerContext.services);
		if (resolution.failure) return resolution.failure;
		const preparation = await this.prepareEmbeddedSubagentChild(request, resolution.context, runnerContext);
		if (preparation.failure) return preparation.failure;
		return this.executeEmbeddedSubagentRun(request, preparation, runnerContext.registry);
	}

	private createEmbeddedSubagentRunner(
		services: PiAgentServices,
		excludedTools: string[],
		registry: MutableSubagentRunRegistry,
	): SubagentRunner {
		const runtime: EmbeddedSubagentRuntimeState = { nextRunNumber: 1, children: new Map() };
		const runnerContext: EmbeddedSubagentRunnerContext = { services, excludedTools, registry, runtime };
		const cleanup = async (): Promise<void> => {
			for (const { child } of runtime.children.values()) await child.dispose();
			runtime.children.clear();
		};
		this.subagentCleanupCallbacks.add(cleanup);
		return (request) => this.runEmbeddedSubagent(request, runnerContext);
	}

	private resolveHookDiscovery(
		services: PiAgentServices,
		resolvedOptions: ResolvePiAgentSessionOptionsResult,
		diagnostics: PiAgentDiagnostic[],
	): HookDiscoveryResolution {
		const hookOperations = resolvedOptions.toolOperations ?? this.borrowedToolOperations;
		const customHookOperationsSupplied =
			resolvedOptions.toolOperations !== undefined || this.borrowedToolOperations !== undefined;
		const hookBackend = hookOperations?.getBackendInfo?.();
		const trustProjectHooks = resolvedOptions.trustProjectHooks ?? this.options.trustProjectHooks;
		const trustedIdentity = resolvedOptions.trustedProjectHooksIdentity ?? this.options.trustedProjectHooksIdentity;
		let cwd = services.cwd;
		let discoverProjectHooks =
			trustProjectHooks === true && (!customHookOperationsSupplied || hookBackend?.type === "local");
		if (!discoverProjectHooks) return { cwd, discoverProjectHooks };
		try {
			cwd = canonicalProjectHookCwd(services.cwd);
			if (trustedIdentity && canonicalProjectHookIdentity(cwd) !== trustedIdentity) {
				discoverProjectHooks = false;
				diagnostics.push({
					type: "warning",
					message: "Project hook trust identity changed before hook loading; project hooks were not loaded",
				});
			}
		} catch (error) {
			discoverProjectHooks = false;
			diagnostics.push({
				type: "warning",
				message: `Unable to canonicalize project hooks path; project hooks were not loaded: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
		return { cwd, discoverProjectHooks };
	}

	private async loadSessionHooks(
		services: PiAgentServices,
		resolvedOptions: ResolvePiAgentSessionOptionsResult,
		diagnostics: PiAgentDiagnostic[],
	): Promise<LoadedHooks | undefined> {
		const hookOptions = this.options.hooks;
		const discovery = this.resolveHookDiscovery(services, resolvedOptions, diagnostics);
		if (hookOptions === false || hookOptions?.enabled === false) return undefined;
		const loadedHooks = hookOptions?.snapshot
			? freezeLoadedHooks(hookOptions.snapshot)
			: await loadHooks({
					cwd: discovery.cwd,
					home: hookOptions?.home,
					agentDir: services.agentDir,
					sources: discovery.discoverProjectHooks ? ["user", "project", "local"] : ["user"],
				});
		diagnostics.push(...loadedHooks.diagnostics.map(formatHookDiagnostic));
		return loadedHooks;
	}

	private mergeSessionOptions(resolvedOptions: ResolvePiAgentSessionOptionsResult): PiAgentSessionOptions {
		return {
			model: resolvedOptions.model ?? this.options.model,
			thinkingLevel: resolvedOptions.thinkingLevel ?? this.options.thinkingLevel,
			scopedModels: resolvedOptions.scopedModels ?? this.options.scopedModels,
			tools: resolvedOptions.tools ?? this.options.tools,
			excludedTools: resolvedOptions.excludedTools ?? this.options.excludedTools,
			noTools: resolvedOptions.noTools ?? this.options.noTools,
			customTools: resolvedOptions.customTools ?? this.options.customTools,
			toolOperations: resolvedOptions.toolOperations
				? borrowToolOperations(resolvedOptions.toolOperations)
				: this.borrowedToolOperations,
			trustProjectAgents: resolvedOptions.trustProjectAgents ?? this.options.trustProjectAgents,
			trustProjectHooks: resolvedOptions.trustProjectHooks ?? this.options.trustProjectHooks,
			trustProjectLspTransports: resolvedOptions.trustProjectLspTransports ?? this.options.trustProjectLspTransports,
			lspConnectionFactories: resolvedOptions.lspConnectionFactories ?? this.options.lspConnectionFactories,
		};
	}

	private resolveSessionLspConfiguration(
		services: PiAgentServices,
		sessionOptions: PiAgentSessionOptions,
		inputs: LspConfigurationInput[],
	): Promise<LoadLspConfigurationResult> {
		if (sessionOptions.toolOperations?.getBackendInfo?.().type === "remote") {
			return Promise.resolve({ configuration: { enabled: false, servers: [] }, diagnostics: [] });
		}
		return loadLspConfiguration({
			settingsManager: services.settingsManager,
			cwd: services.cwd,
			agentDir: services.agentDir,
			inputs,
			trustProjectLspTransports: sessionOptions.trustProjectLspTransports,
		});
	}

	private async resolveSessionModel(
		services: PiAgentServices,
		sessionOptions: PiAgentSessionOptions,
		existingSession: SessionContext,
	): Promise<SessionModelResolution> {
		let model = sessionOptions.model;
		let fallbackMessage: string | undefined;
		if (model) model = services.modelRegistry.find(model.provider, model.id) ?? model;
		if (!model && existingSession.messages.length > 0 && existingSession.model) {
			const restoredModel = services.modelRegistry.find(
				existingSession.model.provider,
				existingSession.model.modelId,
			);
			if (restoredModel && services.modelRegistry.hasConfiguredAuth(restoredModel)) model = restoredModel;
			if (!model)
				fallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
		if (model) return { model, fallbackMessage };
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: existingSession.messages.length > 0,
			defaultProvider: services.settingsManager.getDefaultProvider(),
			defaultModelId: services.settingsManager.getDefaultModel(),
			defaultThinkingLevel: services.settingsManager.getDefaultThinkingLevel(),
			modelRegistry: services.modelRegistry,
		});
		model = result.model;
		if (!model) fallbackMessage = formatNoModelsAvailableMessage();
		else if (fallbackMessage) fallbackMessage += `. Using ${model.provider}/${model.id}`;
		return { model, fallbackMessage };
	}

	private resolveSessionThinkingLevel(
		services: PiAgentServices,
		activeSession: Session,
		existingSession: SessionContext,
		configuredLevel: ThinkingLevel | undefined,
		model: Model<any> | undefined,
	): ThinkingLevel {
		const hasExistingSession = existingSession.messages.length > 0;
		const hasThinkingEntry = activeSession.getBranch().some((entry) => entry.type === "thinking_level_change");
		let thinkingLevel = configuredLevel;
		if (thinkingLevel === undefined && hasExistingSession) {
			thinkingLevel = hasThinkingEntry
				? (existingSession.thinkingLevel as ThinkingLevel)
				: (services.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
		}
		thinkingLevel ??= services.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		return model ? (clampThinkingLevel(model, thinkingLevel) as ThinkingLevel) : "off";
	}

	private createCoreAgent(
		services: PiAgentServices,
		activeSession: Session,
		model: Model<any> | undefined,
		thinkingLevel: ThinkingLevel,
		extensionRunnerRef: ExtensionRunnerReference,
	): Agent {
		return new Agent({
			initialState: { systemPrompt: "", model, thinkingLevel, tools: [] },
			convertToLlm: (messages) => {
				const converted = convertToLlm(messages);
				return services.settingsManager.getBlockImages() ? converted.map(blockImagesInMessage) : converted;
			},
			streamFn: async (streamModel, context, options) => {
				const auth = await services.modelRegistry.getApiKeyAndHeaders(streamModel);
				if (!auth.ok) throw new Error(auth.error);
				const providerRetrySettings = services.settingsManager.getProviderRetrySettings();
				const timeoutMs =
					options?.timeoutMs ??
					providerRetrySettings.timeoutMs ??
					(streamModel.api === "openai-codex-responses"
						? services.settingsManager.getHttpIdleTimeoutMs()
						: undefined);
				const websocketConnectTimeoutMs =
					options?.websocketConnectTimeoutMs ?? services.settingsManager.getWebSocketConnectTimeoutMs();
				const attributionHeaders = getAttributionHeaders(streamModel, services.settingsManager, options?.sessionId);
				let headers =
					attributionHeaders || auth.headers || options?.headers
						? { ...attributionHeaders, ...auth.headers, ...options?.headers }
						: undefined;
				const runner = extensionRunnerRef.current;
				if (runner?.hasHandlers("before_provider_headers")) {
					headers = await runner.emitBeforeProviderHeaders(headers ?? {});
				}
				return streamSimple(streamModel, context, {
					...options,
					apiKey: auth.apiKey,
					timeoutMs,
					websocketConnectTimeoutMs,
					maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
					headers,
				});
			},
			onPayload: async (payload) => {
				const runner = extensionRunnerRef.current;
				return runner?.hasHandlers("before_provider_request") ? runner.emitBeforeProviderRequest(payload) : payload;
			},
			onResponse: async (response) => {
				const runner = extensionRunnerRef.current;
				if (!runner?.hasHandlers("after_provider_response")) return;
				await runner.emit({ type: "after_provider_response", status: response.status, headers: response.headers });
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
	}

	private async buildAgentSession(
		activeSession: Session,
		sessionStartEvent?: SessionStartEvent,
	): Promise<BuiltAgentSession> {
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
		const loadedHooks = await this.loadSessionHooks(services, resolvedOptions, diagnostics);
		const sessionOptions = this.mergeSessionOptions(resolvedOptions);
		const lspInputs = [...asLspInputs(this.options.lsp), ...asLspInputs(resolvedOptions.lsp)];
		const resolveSessionLspConfiguration = () =>
			this.resolveSessionLspConfiguration(services, sessionOptions, lspInputs);
		const lspResult = await resolveSessionLspConfiguration();
		const lspDiagnostics = formatLspConfigurationDiagnostics(lspResult.diagnostics);
		const baseDiagnostics = [...diagnostics];

		const existingSession = activeSession.buildSessionContext();
		const hasExistingSession = existingSession.messages.length > 0;
		const hasThinkingEntry = activeSession.getBranch().some((entry) => entry.type === "thinking_level_change");
		const modelResolution = await this.resolveSessionModel(services, sessionOptions, existingSession);
		const { model } = modelResolution;
		const thinkingLevel = this.resolveSessionThinkingLevel(
			services,
			activeSession,
			existingSession,
			sessionOptions.thinkingLevel,
			model,
		);

		const defaultActiveToolNames = getDefaultActiveToolNames();
		const allowedToolNames = sessionOptions.tools ?? (sessionOptions.noTools === "all" ? [] : undefined);
		const initialActiveToolNames: string[] = sessionOptions.tools
			? [...sessionOptions.tools]
			: sessionOptions.noTools
				? []
				: defaultActiveToolNames;
		const extensionRunnerRef: ExtensionRunnerReference = {};
		const agent = this.createCoreAgent(services, activeSession, model, thinkingLevel, extensionRunnerRef);

		if (hasExistingSession) {
			agent.state.messages = existingSession.messages;
			if (!hasThinkingEntry) activeSession.appendThinkingLevelChange(thinkingLevel);
		} else {
			if (model) activeSession.appendModelChange(model.provider, model.id);
			activeSession.appendThinkingLevelChange(thinkingLevel);
		}

		const subagentRunRegistry = this.createSubagentRunRegistry();
		const subagentConfigRegistry = this.createSubagentConfigRegistry();
		const hookOptions = this.options.hooks;
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
				excludedToolNames: sessionOptions.excludedTools,
				allowedToolNames,
				subagentRunner: this.createEmbeddedSubagentRunner(
					services,
					sessionOptions.excludedTools ?? [],
					subagentRunRegistry,
				),
				subagentRunRegistry,
				subagentConfigRegistry,
				trustProjectAgents: sessionOptions.trustProjectAgents,
				lspConfiguration: lspResult.configuration,
				lspConnectionFactories: sessionOptions.lspConnectionFactories,
				resolveLspConfiguration: resolveSessionLspConfiguration,
				onLspConfigurationDiagnostics: (nextDiagnostics) => {
					this.setLspConfigurationDiagnostics(nextDiagnostics);
				},
				extensionRunnerRef,
				sessionStartEvent,
				loadedHooks,
				hookRunOptions: hookOptions
					? {
							allowedHttpHookUrls: hookOptions.allowedHttpHookUrls,
							httpHookAllowedEnvVars: hookOptions.httpHookAllowedEnvVars,
						}
					: undefined,
				onHookDiagnostic: (diagnostic) => this.addHookDiagnostic(diagnostic),
			}),
			services,
			baseDiagnostics,
			lspDiagnostics,
			modelFallbackMessage: modelResolution.fallbackMessage,
		};
	}

	private apply(result: BuiltAgentSession): void {
		this._session = result.session;
		this._services = result.services;
		this._baseDiagnostics = result.baseDiagnostics;
		this._lspDiagnostics = result.lspDiagnostics;
		this._diagnostics = [...this._baseDiagnostics, ...this._lspDiagnostics];
		this._modelFallbackMessage = result.modelFallbackMessage;
	}

	private setLspConfigurationDiagnostics(diagnostics: readonly LspConfigurationSourceDiagnostic[]): void {
		this._lspDiagnostics = formatLspConfigurationDiagnostics(diagnostics);
		this._diagnostics = [...this._baseDiagnostics, ...this._lspDiagnostics];
	}

	private addHookDiagnostic(diagnostic: HookDiagnostic): void {
		const formatted = formatHookDiagnostic(diagnostic);
		this._baseDiagnostics = [...this._baseDiagnostics, formatted];
		this._diagnostics = [...this._baseDiagnostics, ...this._lspDiagnostics];
	}

	private shouldValidateSessionCwdOnHost(): boolean {
		const backendInfo = this.borrowedToolOperations?.getBackendInfo?.();
		return backendInfo === undefined || backendInfo.type === "local";
	}

	async createAgentSession(options: CreatePiAgentSessionOptions = {}): Promise<AgentSession> {
		const initialSession = options.session ?? (await this.sessionManager.create());
		if (this.shouldValidateSessionCwdOnHost()) {
			assertSessionCwdExists(initialSession, initialSession.getCwd());
		}
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
		reason: SessionSwitchReason,
		targetSessionReference?: string,
	): Promise<ExtensionSessionActionResult> {
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
		options: ForkPreparationOptions,
	): Promise<ExtensionSessionActionResult> {
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

	private async flushSession(session: AgentSession): Promise<void> {
		const flushPendingSync = (session.session as { flushPendingSync?: () => Promise<void> }).flushPendingSync;
		if (flushPendingSync) {
			await flushPendingSync.call(session.session);
		}
	}

	private async replaceCurrentSession(
		result: BuiltAgentSession,
		reason: SessionShutdownReason,
		targetSessionReference: string | undefined,
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>,
	): Promise<void> {
		const previousSession = this.session;
		try {
			await previousSession.emitHookSessionEnd(
				reason === "new" ? "clear" : reason === "resume" ? "resume" : "other",
			);
			await emitSessionShutdownEvent(previousSession.extensionRunner, {
				type: "session_shutdown",
				reason,
				targetSessionReference,
				targetSessionFile: targetSessionReference,
			});
			await this.flushSession(previousSession);
			this.beforeSessionInvalidate?.();
		} catch (error) {
			await result.session.dispose();
			throw error;
		}
		await previousSession.dispose();
		this.apply(result);
		await this.finishSessionReplacement(withSession);
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
		options?: PiAgentSwitchSessionOptions,
	): Promise<ExtensionSessionActionResult> {
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionReference = this.session.sessionReference;
		const nextSession = await this.sessionManager.openReference(sessionPath, { cwdOverride: options?.cwdOverride });
		if (this.shouldValidateSessionCwdOnHost()) {
			assertSessionCwdExists(nextSession, this.services.cwd);
		}
		const result = await this.buildAgentSession(nextSession, {
			type: "session_start",
			reason: "resume",
			previousSessionReference,
			previousSessionFile: previousSessionReference,
		});
		await this.replaceCurrentSession(result, "resume", nextSession.getSessionReference(), options?.withSession);
		return { cancelled: false };
	}

	async newSession(options?: ExtensionNewSessionOptions): Promise<ExtensionSessionActionResult> {
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionReference = this.session.sessionReference;
		const nextSession = await this.sessionManager.create({
			id: options?.id,
			parentSession: options?.parentSession,
		});

		if (options?.setup) {
			await options.setup(nextSession);
		}
		const result = await this.buildAgentSession(nextSession, {
			type: "session_start",
			reason: "new",
			previousSessionReference,
			previousSessionFile: previousSessionReference,
		});
		await this.replaceCurrentSession(result, "new", nextSession.getSessionReference(), options?.withSession);
		return { cancelled: false };
	}

	async fork(entryId: string, options?: ExtensionForkOptions): Promise<PiAgentForkResult> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const activeAgentSession = this.session;
		const selectedEntry = activeAgentSession.session.getEntry(entryId);
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

		const previousSessionReference = activeAgentSession.sessionReference;
		const activeSession = activeAgentSession.session;
		let nextSession: Session;
		try {
			nextSession = await activeSession.forkSubSession(targetLeafId);
		} catch (error) {
			if (!(error instanceof Error && error.message === "Session manager unavailable")) {
				throw error;
			}
			nextSession = await this.sessionManager.forkSession(activeSession, targetLeafId);
		}
		const result = await this.buildAgentSession(nextSession, {
			type: "session_start",
			reason: "fork",
			previousSessionReference,
			previousSessionFile: previousSessionReference,
		});
		await this.replaceCurrentSession(result, "fork", nextSession.getSessionReference(), options?.withSession);
		return { cancelled: false, selectedText };
	}

	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<ExtensionSessionActionResult> {
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
		if (this.shouldValidateSessionCwdOnHost()) {
			assertSessionCwdExists(nextSession, this.services.cwd);
		}
		const result = await this.buildAgentSession(nextSession, {
			type: "session_start",
			reason: "resume",
			previousSessionReference,
			previousSessionFile: previousSessionReference,
		});
		await this.replaceCurrentSession(result, "resume", nextSession.getSessionReference());
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
			await runInteractiveAppMode(this, this.modelFallbackMessage, options);
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

	dispose(): Promise<void> {
		this.disposePromise ??= this.disposeRuntime();
		return this.disposePromise;
	}

	private async disposeRuntime(): Promise<void> {
		try {
			if (this._session) {
				await this.session.emitHookSessionEnd("prompt_input_exit");
				await emitSessionShutdownEvent(this.session.extensionRunner, {
					type: "session_shutdown",
					reason: "quit",
				});
				await this.flushSession(this.session);
				this.beforeSessionInvalidate?.();
				await this.session.dispose();
				this._session = undefined;
			}
		} finally {
			if (this.options.ownsToolOperations && !this.toolOperationsDisposed) {
				this.toolOperationsDisposed = true;
				await this.options.toolOperations?.dispose?.();
			}
			for (const cleanup of this.subagentCleanupCallbacks) await cleanup();
			this.subagentCleanupCallbacks.clear();
		}
	}
}
