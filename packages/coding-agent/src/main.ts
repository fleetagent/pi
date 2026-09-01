/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * PiAgent options. PiAgent does the heavy lifting.
 */

import { createInterface } from "node:readline";
import { modelsAreEqual } from "@fleetagent/pi-ai";
import { ProcessTerminal, setKeybindings, TuiMainScreen } from "@fleetagent/pi-tui";
import chalk from "chalk";
import { type Args, parseArgs, printHelp } from "./cli/args.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { buildInitialMessage, type InitialMessageResult } from "./cli/initial-message.ts";
import { listModels } from "./cli/list-models.ts";
import { selectSession } from "./cli/session-picker.ts";
import {
	ENV_REMOTE_PROJECT_ID,
	ENV_REMOTE_SESSION_BASE_URL,
	ENV_REMOTE_SESSION_TOKEN,
	ENV_SESSION_DIR,
	expandTildePath,
	getAgentDir,
	getPackageDir,
	VERSION,
} from "./config.ts";
import { AuthStorage } from "./core/auth-storage.ts";
import { exportFromFile } from "./core/export-html/index.ts";
import type { ExtensionFactory } from "./core/extensions/types.ts";
import {
	canonicalProjectHookIdentity,
	hasProjectHookConfiguration,
	type ProjectHookTrustResult,
	ProjectHookTrustStore,
} from "./core/hooks/trust-store.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { KeybindingsManager } from "./core/keybindings.ts";
import type { LspConfigurationInput } from "./core/lsp/config-loader.ts";
import type { ModelRegistry } from "./core/model-registry.ts";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.ts";
import type { PiAgentAppMode, PiAgentDiagnostic, PiAgentSessionOptions } from "./core/pi-agent.ts";
import { isFatalPiAgentDiagnostic, PiAgent } from "./core/pi-agent.ts";
import { InMemorySessionManager } from "./core/session/in-memory-session-manager.ts";
import { LocalSessionManager } from "./core/session/local-session-manager.ts";
import { RemoteSessionManager } from "./core/session/remote-session-manager.ts";
import type { Session } from "./core/session/session.ts";
import type { SessionManager } from "./core/session/session-manager.ts";
import {
	formatMissingSessionCwdPrompt,
	getMissingSessionCwdIssue,
	MissingSessionCwdError,
	type SessionCwdIssue,
} from "./core/session-cwd.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { resetTimings, time } from "./core/timings.ts";
import {
	createRemoteToolOperations,
	DeferredRemoteToolOperations,
	type ToolOperations,
} from "./core/tools/operations.ts";
import { runDaemonCommand } from "./daemon/command.ts";
import { isDaemonCommand } from "./daemon/config.ts";
import { runMigrations, showDeprecationWarnings } from "./migrations.ts";
import { ExtensionSelectorComponent } from "./modes/interactive/components/extension-selector.ts";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.ts";
import { handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
import { isLocalPath, normalizePath, resolvePath } from "./utils/paths.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

function collectSettingsDiagnostics(settingsManager: SettingsManager, context: string): PiAgentDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, error }) => ({
		type: "warning",
		message: `(${context}, ${scope} settings) ${error.message}`,
	}));
}

function reportDiagnostics(diagnostics: readonly PiAgentDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function resolveAppMode(parsed: Args, stdinIsTTY: boolean): PiAgentAppMode {
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY) {
		return "print";
	}
	return "interactive";
}

async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
	stdinContent?: string,
): Promise<InitialMessageResult> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

/** Result from resolving a session argument */
type ResolvedSession =
	| { type: "path"; path: string } // Direct file path
	| { type: "local"; path: string } // Found in current project
	| { type: "global"; path: string; cwd: string } // Found in different project
	| { type: "not_found"; arg: string }; // Not found anywhere

/**
 * Resolve a session argument to a file path.
 * If it looks like a path, use as-is. Otherwise try to match as session ID prefix.
 */
async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	// If it looks like a file path, resolve it before handing it to the session manager.
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: resolvePath(sessionArg, cwd) };
	}

	// Try to match as session ID in current project first
	const localSessions = await new LocalSessionManager({ cwd: cwd, sessionDir: sessionDir }).list();
	const localMatches = localSessions.filter((s) => s.id.startsWith(sessionArg));

	if (localMatches.length >= 1) {
		return { type: "local", path: localMatches[0].path };
	}

	// Try global search across all projects
	const allSessions = await new LocalSessionManager({ cwd: process.cwd(), sessionDir }).listAll();
	const globalMatches = allSessions.filter((s) => s.id.startsWith(sessionArg));

	if (globalMatches.length >= 1) {
		const match = globalMatches[0];
		return { type: "global", path: match.path, cwd: match.cwd };
	}

	// Not found anywhere
	return { type: "not_found", arg: sessionArg };
}

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}
}

function forkSessionOrExit(sourcePath: string, cwd: string, sessionDir?: string): Session {
	try {
		return new LocalSessionManager({ cwd: cwd, sessionDir: sessionDir }).forkFrom(sourcePath);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

function openSessionOrExit(path: string, cwd: string, sessionDir?: string): Session {
	try {
		return new LocalSessionManager({ cwd, sessionDir }).openReference(path);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

interface RemoteSessionCliOptions {
	baseUrl: string;
	token: string;
	projectId?: string;
}

interface LifecycleSessionManagerOptions {
	cwd: string;
	sessionDir?: string;
	remote?: RemoteSessionCliOptions;
}

function resolveRemoteSessionCliOptions(parsed: Args): RemoteSessionCliOptions | undefined {
	const baseUrl = parsed.remoteSessionBaseUrl ?? process.env[ENV_REMOTE_SESSION_BASE_URL];
	const token = parsed.remoteSessionToken ?? process.env[ENV_REMOTE_SESSION_TOKEN];
	const projectId = parsed.remoteProjectId ?? process.env[ENV_REMOTE_PROJECT_ID];

	if (!baseUrl && !token && !projectId) {
		return undefined;
	}
	if (!baseUrl || !token) {
		console.error(
			chalk.red(
				`Error: remote sessions require both --remote-session-base-url and --remote-session-token, or ${ENV_REMOTE_SESSION_BASE_URL} and ${ENV_REMOTE_SESSION_TOKEN}`,
			),
		);
		process.exit(1);
	}

	return { baseUrl, token, projectId };
}

function createLifecycleSessionManager(options: LifecycleSessionManagerOptions): SessionManager {
	if (options.remote) {
		return new RemoteSessionManager({
			baseUrl: options.remote.baseUrl,
			token: options.remote.token,
			cwd: options.cwd,
			projectId: options.remote.projectId,
		});
	}
	return new LocalSessionManager({ cwd: options.cwd, sessionDir: options.sessionDir });
}

async function resolveRemoteInitialSession(parsed: Args, manager: SessionManager): Promise<Session> {
	if (parsed.fork) {
		return await manager.forkFrom(parsed.fork);
	}
	if (parsed.session) {
		return await manager.openReference(parsed.session);
	}
	if (parsed.resume) {
		const selectedReference = await selectSession(
			(onProgress) => manager.list(onProgress),
			(onProgress) => manager.listAll(onProgress),
		);
		if (!selectedReference) {
			console.log(chalk.dim("No session selected"));
			process.exit(0);
		}
		return await manager.openReference(selectedReference);
	}
	if (parsed.continue) {
		return await manager.continueRecent();
	}
	return await manager.create();
}

async function resolveLocalRequestedSession(sessionArg: string, cwd: string, sessionDir?: string): Promise<Session> {
	const resolved = await resolveSessionPath(sessionArg, cwd, sessionDir);
	switch (resolved.type) {
		case "path":
		case "local":
			return openSessionOrExit(resolved.path, process.cwd(), sessionDir);
		case "global": {
			console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
			const shouldFork = await promptConfirm("Fork this session into current directory?");
			if (!shouldFork) {
				console.log(chalk.dim("Aborted."));
				process.exit(0);
			}
			return forkSessionOrExit(resolved.path, cwd, sessionDir);
		}
		case "not_found":
			console.error(chalk.red(`No session found matching '${resolved.arg}'`));
			process.exit(1);
	}
}

async function resolveInitialSession(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsManager,
	remoteOptions?: RemoteSessionCliOptions,
): Promise<Session> {
	if (parsed.noSession) {
		return new InMemorySessionManager().create();
	}

	if (remoteOptions) {
		return resolveRemoteInitialSession(
			parsed,
			new RemoteSessionManager({
				baseUrl: remoteOptions.baseUrl,
				token: remoteOptions.token,
				cwd,
				projectId: remoteOptions.projectId,
			}),
		);
	}

	if (parsed.fork) {
		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(resolved.path, cwd, sessionDir);

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.session) return resolveLocalRequestedSession(parsed.session, cwd, sessionDir);

	if (parsed.resume) {
		initTheme(settingsManager.getTheme(), true);
		try {
			const selectedPath = await selectSession(
				(onProgress) => new LocalSessionManager({ cwd, sessionDir }).list(onProgress),
				(onProgress) => new LocalSessionManager({ cwd: process.cwd(), sessionDir }).listAll(onProgress),
			);
			if (!selectedPath) {
				console.log(chalk.dim("No session selected"));
				process.exit(0);
			}
			return openSessionOrExit(selectedPath, process.cwd(), sessionDir);
		} finally {
			stopThemeWatcher();
		}
	}

	if (parsed.continue) {
		return new LocalSessionManager({ cwd: cwd, sessionDir: sessionDir }).continueRecent();
	}

	return new LocalSessionManager({ cwd: cwd, sessionDir: sessionDir }).create();
}

interface SessionOptionsResolution {
	options: PiAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: PiAgentDiagnostic[];
}

function applyCliModelSelection(
	parsed: Args,
	modelRegistry: ModelRegistry,
	resolution: SessionOptionsResolution,
): void {
	if (!parsed.model) return;
	const resolved = resolveCliModel({
		cliProvider: parsed.provider,
		cliModel: parsed.model,
		modelRegistry,
	});
	if (resolved.warning) resolution.diagnostics.push({ type: "warning", message: resolved.warning });
	if (resolved.error) resolution.diagnostics.push({ type: "error", message: resolved.error });
	if (!resolved.model) return;
	resolution.options.model = resolved.model;
	if (!parsed.thinking && resolved.thinkingLevel) {
		resolution.options.thinkingLevel = resolved.thinkingLevel;
		resolution.cliThinkingFromModel = true;
	}
}

function selectDefaultScopedModel(
	scopedModels: ScopedModel[],
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
): ScopedModel {
	const savedProvider = settingsManager.getDefaultProvider();
	const savedModelId = settingsManager.getDefaultModel();
	const savedModel = savedProvider && savedModelId ? modelRegistry.find(savedProvider, savedModelId) : undefined;
	return (
		(savedModel ? scopedModels.find((scoped) => modelsAreEqual(scoped.model, savedModel)) : undefined) ??
		scopedModels[0]
	);
}

function applyCliToolSelection(parsed: Args, options: PiAgentSessionOptions): void {
	if (parsed.noTools) options.noTools = "all";
	else if (parsed.noBuiltinTools) options.noTools = "builtin";
	if (parsed.tools) options.tools = [...parsed.tools];
}

function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
): SessionOptionsResolution {
	const resolution: SessionOptionsResolution = {
		options: {},
		cliThinkingFromModel: false,
		diagnostics: [],
	};
	applyCliModelSelection(parsed, modelRegistry, resolution);
	const { options } = resolution;

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		const selected = selectDefaultScopedModel(scopedModels, modelRegistry, settingsManager);
		options.model = selected.model;
		if (!parsed.thinking && selected.thinkingLevel) options.thinkingLevel = selected.thinkingLevel;
	}

	if (parsed.thinking) options.thinkingLevel = parsed.thinking;
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((scoped) => ({
			model: scoped.model,
			thinkingLevel: scoped.thinkingLevel,
		}));
	}
	applyCliToolSelection(parsed, options);
	return resolution;
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}

async function promptForMissingSessionCwd(
	issue: SessionCwdIssue,
	settingsManager: SettingsManager,
): Promise<string | undefined> {
	initTheme(settingsManager.getTheme());
	setKeybindings(KeybindingsManager.create());

	return new Promise((resolve) => {
		const ui = new TuiMainScreen(new ProcessTerminal(), settingsManager.getShowHardwareCursor());
		ui.setClearOnShrink(settingsManager.getClearOnShrink());

		let settled = false;
		const finish = (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			ui.stop();
			resolve(result);
		};

		const selector = new ExtensionSelectorComponent(
			formatMissingSessionCwdPrompt(issue),
			["Continue", "Cancel"],
			(option) => finish(option === "Continue" ? issue.fallbackCwd : undefined),
			() => finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		ui.start();
	});
}

export type ProjectHookTrustChoice = "deny" | "once" | "always";

export async function promptForProjectHookTrust(
	cwd: string,
	identity: string,
	settingsManager: SettingsManager,
): Promise<ProjectHookTrustChoice> {
	initTheme(settingsManager.getTheme());
	setKeybindings(KeybindingsManager.create());
	const title = [
		`Project hooks were found in ${cwd}.`,
		"Project hooks execute in the active workspace: as your host user locally, or inside an active sandbox/remote backend.",
		`Trust always authorizes all current and future hook changes in ${identity}.`,
	].join("\n");

	return new Promise((resolve) => {
		const ui = new TuiMainScreen(new ProcessTerminal(), settingsManager.getShowHardwareCursor());
		ui.setClearOnShrink(settingsManager.getClearOnShrink());
		let settled = false;
		const finish = (choice: ProjectHookTrustChoice) => {
			if (settled) return;
			settled = true;
			ui.stop();
			resolve(choice);
		};
		const selector = new ExtensionSelectorComponent(
			title,
			["Don't trust", "Trust once", "Trust always"],
			(option) => {
				if (option === "Trust once") finish("once");
				else if (option === "Trust always") finish("always");
				else finish("deny");
			},
			() => finish("deny"),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		ui.start();
	});
}
export interface ProjectHookTrustPolicyOptions {
	initialCwd: string;
	initialSessionId: string;
	explicitTrust: boolean;
	interactive: boolean;
	skipInitialPrompt: boolean;
	store: ProjectHookTrustStore;
	prompt: (cwd: string, identity: string) => Promise<ProjectHookTrustChoice>;
	reportError?: (error: string | undefined) => void;
}

export interface ProjectHookTrustPolicy {
	resolveInitial(backendAllowsProjectHooks: boolean): Promise<boolean>;
	getInitialTrustedIdentity(): string | undefined;
	resolveFor(sessionCwd: string, sessionId: string): ProjectHookTrustResult;
	isTrustedFor(sessionCwd: string, sessionId: string): boolean;
}
interface ProjectHookTrustPolicyState {
	initialTrusted: boolean;
	initialTrustedIdentity: string | undefined;
	trustOnceIdentity: string | undefined;
	trustOnceSessionId: string | undefined;
	trustOnceConsumed: boolean;
}

type ProjectHookTrustErrorReporter = (error: string | undefined) => void;

function identifyInitialProjectHooks(cwd: string, reportError: ProjectHookTrustErrorReporter): string | undefined {
	try {
		return canonicalProjectHookIdentity(cwd);
	} catch (error) {
		reportError(
			`Unable to identify project hooks repository: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

function applyInitialProjectHookTrustChoice(
	choice: ProjectHookTrustChoice,
	identity: string,
	options: ProjectHookTrustPolicyOptions,
	state: ProjectHookTrustPolicyState,
	reportError: ProjectHookTrustErrorReporter,
): void {
	if (choice === "once" || choice === "always") {
		state.initialTrusted = true;
		state.initialTrustedIdentity = identity;
	}
	if (choice === "once") {
		state.trustOnceIdentity = identity;
		state.trustOnceSessionId = options.initialSessionId;
	}
	if (choice === "always") {
		const saved = options.store.trustAlwaysIdentity(identity);
		reportError(saved.error);
	}
}

async function resolveInitialProjectHookTrust(
	backendAllowsProjectHooks: boolean,
	options: ProjectHookTrustPolicyOptions,
	state: ProjectHookTrustPolicyState,
	reportError: ProjectHookTrustErrorReporter,
): Promise<boolean> {
	if (!backendAllowsProjectHooks) return state.initialTrusted;
	if (state.initialTrusted) return true;
	if (options.skipInitialPrompt) return false;
	if (!hasProjectHookConfiguration(options.initialCwd)) return false;

	const persisted = options.store.isTrusted(options.initialCwd);
	reportError(persisted.error);
	state.initialTrusted = persisted.trusted;
	state.initialTrustedIdentity = persisted.trusted ? persisted.identity : undefined;
	if (state.initialTrusted || !options.interactive) return state.initialTrusted;

	const identity = identifyInitialProjectHooks(options.initialCwd, reportError);
	if (!identity) return false;
	const choice = await options.prompt(options.initialCwd, identity);
	applyInitialProjectHookTrustChoice(choice, identity, options, state, reportError);
	return state.initialTrusted;
}

/** Orchestrates the CLI's startup and per-session project-hook trust decisions. */
export function createProjectHookTrustPolicy(options: ProjectHookTrustPolicyOptions): ProjectHookTrustPolicy {
	const state: ProjectHookTrustPolicyState = {
		initialTrusted: options.explicitTrust,
		initialTrustedIdentity: undefined,
		trustOnceIdentity: undefined,
		trustOnceSessionId: undefined,
		trustOnceConsumed: false,
	};
	const reportError = options.reportError ?? (() => {});

	return {
		resolveInitial(backendAllowsProjectHooks: boolean): Promise<boolean> {
			return resolveInitialProjectHookTrust(backendAllowsProjectHooks, options, state, reportError);
		},

		getInitialTrustedIdentity(): string | undefined {
			return state.initialTrustedIdentity;
		},

		resolveFor(sessionCwd: string, sessionId: string): ProjectHookTrustResult {
			if (options.explicitTrust) return { trusted: true };
			if (!hasProjectHookConfiguration(sessionCwd)) return { trusted: false };
			try {
				if (
					!state.trustOnceConsumed &&
					state.trustOnceIdentity &&
					state.trustOnceSessionId === sessionId &&
					canonicalProjectHookIdentity(sessionCwd) === state.trustOnceIdentity
				) {
					state.trustOnceConsumed = true;
					return { trusted: true, identity: state.trustOnceIdentity };
				}
			} catch (error) {
				const message = `Unable to identify project hooks repository: ${error instanceof Error ? error.message : String(error)}`;
				reportError(message);
				return { trusted: false, error: message };
			}
			const persisted = options.store.isTrusted(sessionCwd);
			reportError(persisted.error);
			return persisted;
		},

		isTrustedFor(sessionCwd: string, sessionId: string): boolean {
			return this.resolveFor(sessionCwd, sessionId).trusted;
		},
	};
}

export interface MainOptions {
	extensionFactories?: ExtensionFactory[];
	daemonRunner?: (args: readonly string[]) => Promise<void>;
	/** Test/embedding override for the interactive project-hook trust prompt. */
	projectHookTrustPrompt?: (cwd: string, identity: string) => Promise<ProjectHookTrustChoice>;
	/** Test/embedding override for persistent project-hook trust storage. */
	projectHookTrustStore?: ProjectHookTrustStore;
}
interface ParsedMainInvocation {
	parsed: Args;
	appMode: PiAgentAppMode;
}

interface StartupSessionResolution {
	cwd: string;
	agentDir: string;
	startupSettingsManager: SettingsManager;
	sessionDir: string | undefined;
	remoteSessionOptions: RemoteSessionCliOptions | undefined;
	initialSession: Session;
}

async function runCliPreflight(args: string[], options: MainOptions | undefined): Promise<boolean> {
	if (isDaemonCommand(args)) {
		await (options?.daemonRunner ?? runDaemonCommand)(args);
		return true;
	}
	configureHttpDispatcher();
	resetTimings();
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.PI_OFFLINE);
	if (offlineMode) {
		process.env.PI_OFFLINE = "1";
		process.env.PI_SKIP_VERSION_CHECK = "1";
	}
	if (process.platform === "win32") cleanupWindowsSelfUpdateQuarantine(getPackageDir());
	if (await handlePackageCommand(args)) return true;
	return handleConfigCommand(args);
}

function reportArgumentDiagnostics(parsed: Args): void {
	if (parsed.diagnostics.length === 0) return;
	for (const diagnostic of parsed.diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : chalk.yellow;
		console.error(color(`${diagnostic.type === "error" ? "Error" : "Warning"}: ${diagnostic.message}`));
	}
	if (parsed.diagnostics.some((diagnostic) => diagnostic.type === "error")) process.exit(1);
}

async function handleCliMetadataCommands(parsed: Args): Promise<void> {
	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}
	if (!parsed.export) return;
	let result: string;
	try {
		const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
		result = await exportFromFile(parsed.export, outputPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to export session";
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
	console.log(`Exported to: ${result}`);
	process.exit(0);
}

async function parseMainInvocation(args: string[]): Promise<ParsedMainInvocation> {
	const parsed = parseArgs(args);
	reportArgumentDiagnostics(parsed);
	time("parseArgs");
	const appMode = resolveAppMode(parsed, process.stdin.isTTY);
	PiAgent.setupStdio({ mode: appMode });
	await handleCliMetadataCommands(parsed);
	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}
	validateForkFlags(parsed);
	return { parsed, appMode };
}

async function resolveStartupSession(parsed: Args, appMode: PiAgentAppMode): Promise<StartupSessionResolution> {
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const startupSettingsManager = SettingsManager.create(cwd, agentDir);
	reportDiagnostics(collectSettingsDiagnostics(startupSettingsManager, "startup session lookup"));
	const envSessionDir = process.env[ENV_SESSION_DIR];
	const sessionDir =
		(parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
		(envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
		startupSettingsManager.getSessionDir();
	const remoteSessionOptions = resolveRemoteSessionCliOptions(parsed);
	let initialSession = await resolveInitialSession(
		parsed,
		cwd,
		sessionDir,
		startupSettingsManager,
		remoteSessionOptions,
	);
	const missingSessionCwdIssue = getMissingSessionCwdIssue(initialSession, cwd);
	if (missingSessionCwdIssue) {
		if (appMode !== "interactive") {
			console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
			process.exit(1);
		}
		const selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
		if (!selectedCwd) process.exit(0);
		initialSession = await createLifecycleSessionManager({
			cwd,
			sessionDir,
			remote: remoteSessionOptions,
		}).openReference(missingSessionCwdIssue.sessionReference!, { cwdOverride: selectedCwd });
	}
	time("resolveInitialSession");
	return { cwd, agentDir, startupSettingsManager, sessionDir, remoteSessionOptions, initialSession };
}

async function resolveStartupToolOperations(parsed: Args): Promise<ToolOperations | undefined> {
	const remoteDeferred = parsed.remoteDeferred;
	if (remoteDeferred && parsed.remote && !parsed.help) {
		console.error(chalk.red("Error: --remote-deferred and --remote cannot be used together"));
		process.exit(1);
	}
	if (parsed.remote && !parsed.help) {
		try {
			return await createRemoteToolOperations(parsed.remote);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(chalk.red(`Error: failed to initialize remote tool operations: ${message}`));
			process.exit(1);
		}
	}
	if (!remoteDeferred || parsed.help) return undefined;
	if (!parsed.remoteCwd) {
		console.error(chalk.red("Error: --remote-deferred requires --remote-cwd <path>"));
		process.exit(1);
	}
	return new DeferredRemoteToolOperations(parsed.remoteCwd);
}

function createCliLspInputs(parsed: Args, cwd: string): LspConfigurationInput[] {
	const inputs: LspConfigurationInput[] = [];
	if (parsed.lspConfig) inputs.push({ type: "file", path: resolvePath(parsed.lspConfig, cwd), scope: "cli" });
	if (parsed.noLsp) inputs.push({ type: "disabled", source: "--no-lsp", scope: "cli" });
	return inputs;
}
async function handleRuntimeInformationCommands(parsed: Args, piAgent: PiAgent): Promise<void> {
	const { modelRegistry, resourceLoader } = piAgent.services;
	if (parsed.help) {
		const extensionFlags = resourceLoader
			.getExtensions()
			.extensions.flatMap((extension) => Array.from(extension.flags.values()));
		printHelp(extensionFlags);
		process.exit(0);
	}
	if (parsed.listModels === undefined) return;
	const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
	await listModels(modelRegistry, searchPattern);
	process.exit(0);
}

async function reportRuntimeStartupDiagnostics(piAgent: PiAgent, deprecationWarnings: string[]): Promise<void> {
	if (piAgent.mode === "interactive" && deprecationWarnings.length > 0) {
		await showDeprecationWarnings(deprecationWarnings);
	}
	time("resolveModelScope");
	const hasFatalDiagnostics = piAgent.diagnostics.some(isFatalPiAgentDiagnostic);
	if (piAgent.mode !== "interactive" || hasFatalDiagnostics) reportDiagnostics(piAgent.diagnostics);
	if (hasFatalDiagnostics) process.exit(1);
	time("createAgentSession");
}

export async function main(args: string[], options?: MainOptions) {
	if (await runCliPreflight(args, options)) return;
	const { parsed, appMode } = await parseMainInvocation(args);

	// Run migrations (pass cwd for project-local migrations)
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(process.cwd());
	time("runMigrations");

	// Decide the final runtime cwd before creating cwd-bound runtime services.
	// --session and --resume may select a session from another project, so project-local
	// settings, resources, provider registrations, and models must be resolved only after
	// the target session cwd is known. The startup-cwd settings manager is used only for
	// sessionDir lookup during session selection.
	const { cwd, agentDir, startupSettingsManager, sessionDir, remoteSessionOptions, initialSession } =
		await resolveStartupSession(parsed, appMode);
	const projectHookTrustStore = options?.projectHookTrustStore ?? new ProjectHookTrustStore(agentDir);
	const reportedProjectHookTrustErrors = new Set<string>();
	const reportProjectHookTrustError = (error: string | undefined) => {
		if (!error || reportedProjectHookTrustErrors.has(error)) return;
		reportedProjectHookTrustErrors.add(error);
		console.error(chalk.yellow(`Warning: ${error}`));
	};
	const initialHookCwd = initialSession.getCwd();
	const projectHookTrustPolicy = createProjectHookTrustPolicy({
		initialCwd: initialHookCwd,
		initialSessionId: initialSession.getSessionId(),
		explicitTrust: parsed.trustProjectHooks === true,
		interactive: appMode === "interactive",
		skipInitialPrompt: parsed.help || parsed.listModels !== undefined,
		store: projectHookTrustStore,
		prompt:
			options?.projectHookTrustPrompt ??
			((promptCwd, promptIdentity) => promptForProjectHookTrust(promptCwd, promptIdentity, startupSettingsManager)),
		reportError: reportProjectHookTrustError,
	});
	const authStorage = AuthStorage.create();
	const runtimeSessionManager = parsed.noSession
		? new InMemorySessionManager(initialSession.getCwd())
		: createLifecycleSessionManager({ cwd: initialSession.getCwd(), sessionDir, remote: remoteSessionOptions });
	const toolOperations = await resolveStartupToolOperations(parsed);
	const initialHookBackend = toolOperations?.getBackendInfo?.();
	const initialProjectHooksTrusted = await projectHookTrustPolicy.resolveInitial(
		toolOperations === undefined || initialHookBackend?.type === "local",
	);
	const initialTrustedProjectHooksIdentity = projectHookTrustPolicy.getInitialTrustedIdentity();
	const backendType = toolOperations?.getBackendInfo?.()?.type;
	const instructionPathCwd = toolOperations && backendType === "remote" ? toolOperations.cwd : cwd;
	const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
	const resolvedSkillPaths = resolveCliPaths(instructionPathCwd, parsed.skills);
	const resolvedRulePaths = resolveCliPaths(instructionPathCwd, parsed.rules);
	const resolvedPromptTemplatePaths = resolveCliPaths(instructionPathCwd, parsed.promptTemplates);
	const resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
	const cliLspInputs = createCliLspInputs(parsed, cwd);
	const piAgent = await PiAgent.create({
		toolOperations,
		ownsToolOperations: toolOperations !== undefined,
		mode: appMode,
		cwd: initialSession.getCwd(),
		agentDir,
		sessionManager: runtimeSessionManager,
		authStorage,
		trustProjectHooks: initialProjectHooksTrusted,
		trustedProjectHooksIdentity: initialTrustedProjectHooksIdentity,
		extensionFlagValues: parsed.unknownFlags,
		resourceLoaderOptions: {
			toolOperations,
			additionalExtensionPaths: resolvedExtensionPaths,
			additionalSkillPaths: resolvedSkillPaths,
			additionalRulePaths: resolvedRulePaths,
			additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
			additionalThemePaths: resolvedThemePaths,
			noExtensions: parsed.noExtensions,
			noSkills: parsed.noSkills,
			noRules: parsed.noRules,
			noPromptTemplates: parsed.noPromptTemplates,
			noThemes: parsed.noThemes,
			noContextFiles: parsed.noContextFiles,
			systemPrompt: parsed.systemPrompt,
			appendSystemPrompt: parsed.appendSystemPrompt,
			extensionFactories: options?.extensionFactories,
		},
		resolveSessionOptions: async ({ services, session }) => {
			const { settingsManager, modelRegistry } = services;
			const diagnostics: PiAgentDiagnostic[] = [...collectSettingsDiagnostics(settingsManager, "runtime creation")];
			const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
			const scopedModels =
				modelPatterns && modelPatterns.length > 0 ? await resolveModelScope(modelPatterns, modelRegistry) : [];
			const { options: sessionOptions, diagnostics: sessionOptionDiagnostics } = buildSessionOptions(
				parsed,
				scopedModels,
				session.buildSessionContext().messages.length > 0,
				modelRegistry,
				settingsManager,
			);
			diagnostics.push(...sessionOptionDiagnostics);

			if (parsed.apiKey) {
				if (!sessionOptions.model) {
					diagnostics.push({
						type: "error",
						message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
					});
				} else {
					authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
				}
			}

			if (toolOperations) {
				const backend = toolOperations.getBackendInfo?.();
				let message = `Deferred remote backend mode enabled (cwd: ${toolOperations.cwd})`;
				if (backend?.type === "remote" && backend.configured) {
					message = `Remote tool operations enabled: ${backend.url} (cwd: ${backend.cwd})`;
				}
				diagnostics.push({ type: "info", message });
			}
			const projectHookTrust = projectHookTrustPolicy.resolveFor(services.cwd, session.getSessionId());

			return {
				model: sessionOptions.model,
				thinkingLevel: sessionOptions.thinkingLevel,
				scopedModels: sessionOptions.scopedModels,
				tools: sessionOptions.tools,
				noTools: sessionOptions.noTools,
				customTools: sessionOptions.customTools,
				toolOperations,
				trustProjectHooks: projectHookTrust.trusted,
				trustedProjectHooksIdentity: projectHookTrust.identity,
				lsp: cliLspInputs,
				diagnostics,
			};
		},
	});
	await piAgent.createAgentSession({ session: initialSession });
	time("createAgentSessionRuntime");
	const { settingsManager } = piAgent.services;
	await handleRuntimeInformationCommands(parsed, piAgent);

	const stdinContent = await piAgent.readPipedStdin();
	time("readPipedStdin");

	const { initialMessage, initialImages } = await prepareInitialMessage(
		parsed,
		settingsManager.getImageAutoResize(),
		stdinContent,
	);
	time("prepareInitialMessage");
	initTheme(settingsManager.getTheme(), piAgent.mode === "interactive");
	time("initTheme");

	await reportRuntimeStartupDiagnostics(piAgent, deprecationWarnings);

	await piAgent.runMode({
		migratedProviders,
		initialMessage,
		initialImages,
		initialMessages: parsed.messages,
		verbose: parsed.verbose,
		tuiMode: parsed.tuiMode,
		startupBenchmark: isTruthyEnvFlag(process.env.PI_STARTUP_BENCHMARK),
	});
}
