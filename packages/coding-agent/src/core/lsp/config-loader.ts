import { readFile } from "node:fs/promises";
import { CONFIG_DIR_NAME } from "../../config.ts";
import type { SettingsManager } from "../settings-manager.ts";
import {
	type LspConfigurationLayer,
	type LspConfiguredServer,
	parseLspConfiguration,
	type ResolvedLspConfiguration,
	resolveLspConfiguration,
} from "./config.ts";
import { dirnamePortablePath, joinPortablePath, resolvePortablePath } from "./portable-path.ts";

export type LspConfigurationInputScope = "cli" | "host";
export type LspConfigurationSourceDiagnosticSeverity = "warning" | "error";

export type LspConfigurationInput =
	| {
			type: "configuration";
			configuration: LspConfigurationLayer;
			baseDir?: string;
			source?: string;
			scope?: LspConfigurationInputScope;
	  }
	| { type: "file"; path: string; scope?: LspConfigurationInputScope }
	| { type: "disabled"; source?: string; scope?: LspConfigurationInputScope };

export interface LspConfigurationSourceDiagnostic {
	severity: LspConfigurationSourceDiagnosticSeverity;
	source: string;
	path: string;
	message: string;
}

export interface LoadLspConfigurationOptions {
	settingsManager: SettingsManager;
	cwd: string;
	agentDir: string;
	inputs?: readonly LspConfigurationInput[];
	/** Host-controlled grant. Project settings cannot grant trust to active LSP transports. */
	trustProjectLspTransports?: boolean;
}

export interface LoadLspConfigurationResult {
	configuration: ResolvedLspConfiguration;
	diagnostics: LspConfigurationSourceDiagnostic[];
}

type SourceScope = "global" | "project" | LspConfigurationInputScope;

interface ConfigurationSource {
	scope: SourceScope;
	source: string;
	baseDir: string;
	value: unknown;
	order: number;
}

const SCOPE_PRECEDENCE: Record<SourceScope, number> = {
	global: 0,
	project: 1,
	cli: 2,
	host: 3,
};

interface PendingConfigurationSource {
	scope: SourceScope;
	source: string;
	baseDir: string;
	value: unknown;
}

interface ConfigurationSourceCollection {
	sources: ConfigurationSource[];
	diagnostics: LspConfigurationSourceDiagnostic[];
	nextOrder: number;
	settingsLoadFailed: boolean;
}

interface ConfigurationFileLoadResult {
	loaded: boolean;
	value?: unknown;
}

function appendConfigurationSource(
	collection: ConfigurationSourceCollection,
	source: PendingConfigurationSource,
): void {
	collection.sources.push({ ...source, order: collection.nextOrder++ });
}

function collectSettingsConfigurationSources(options: LoadLspConfigurationOptions): ConfigurationSourceCollection {
	const collection: ConfigurationSourceCollection = {
		sources: [],
		diagnostics: [],
		nextOrder: 0,
		settingsLoadFailed: false,
	};
	const globalSettingsPath = joinPortablePath(options.agentDir, "settings.json");
	const projectSettingsPath = joinPortablePath(options.cwd, CONFIG_DIR_NAME, "settings.json");
	const globalConfiguration = options.settingsManager.getGlobalLspConfiguration();
	const projectConfiguration = options.settingsManager.getProjectLspConfiguration();
	for (const [scope, source] of [
		["global", globalSettingsPath],
		["project", projectSettingsPath],
	] as const) {
		const error = options.settingsManager.getLoadError(scope);
		if (!error) continue;
		collection.settingsLoadFailed = true;
		collection.diagnostics.push({
			severity: "warning",
			source,
			path: "$",
			message: `settings could not be loaded; LSP is disabled to avoid using stale configuration: ${error.message}`,
		});
	}

	if (globalConfiguration !== undefined) {
		appendConfigurationSource(collection, {
			scope: "global",
			source: globalSettingsPath,
			baseDir: dirnamePortablePath(globalSettingsPath),
			value: globalConfiguration,
		});
	}
	if (projectConfiguration !== undefined) {
		appendConfigurationSource(collection, {
			scope: "project",
			source: projectSettingsPath,
			baseDir: dirnamePortablePath(projectSettingsPath),
			value: projectConfiguration,
		});
	}
	return collection;
}

async function loadConfigurationFile(
	filePath: string,
	diagnostics: LspConfigurationSourceDiagnostic[],
): Promise<ConfigurationFileLoadResult> {
	let content: string;
	try {
		content = await readFile(filePath, "utf8");
	} catch (error) {
		diagnostics.push({
			severity: "error",
			source: filePath,
			path: "$",
			message: `failed to read file: ${error instanceof Error ? error.message : String(error)}`,
		});
		return { loaded: false };
	}
	try {
		return { loaded: true, value: JSON.parse(content) as unknown };
	} catch (error) {
		diagnostics.push({
			severity: "error",
			source: filePath,
			path: "$",
			message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		});
		return { loaded: false };
	}
}

async function appendConfigurationInput(
	input: LspConfigurationInput,
	options: LoadLspConfigurationOptions,
	collection: ConfigurationSourceCollection,
): Promise<void> {
	const scope = input.scope ?? "host";
	if (input.type === "disabled") {
		appendConfigurationSource(collection, {
			scope,
			source: input.source ?? (scope === "cli" ? "--no-lsp" : "host LSP override"),
			baseDir: options.cwd,
			value: { enabled: false },
		});
		return;
	}
	if (input.type === "configuration") {
		appendConfigurationSource(collection, {
			scope,
			source: input.source ?? (scope === "cli" ? "CLI LSP configuration" : "host LSP configuration"),
			baseDir: resolvePortablePath(options.cwd, input.baseDir ?? "."),
			value: input.configuration,
		});
		return;
	}

	const filePath = resolvePortablePath(options.cwd, input.path);
	const loaded = await loadConfigurationFile(filePath, collection.diagnostics);
	if (!loaded.loaded) return;
	appendConfigurationSource(collection, {
		scope,
		source: filePath,
		baseDir: dirnamePortablePath(filePath),
		value: loaded.value,
	});
}

function resolveConfigurationSource(
	source: ConfigurationSource,
	trustProjectLspTransports: boolean | undefined,
	diagnostics: LspConfigurationSourceDiagnostic[],
): LspConfigurationLayer | undefined {
	const parsed = parseLspConfiguration(source.value);
	for (const diagnostic of parsed.diagnostics) diagnostics.push({ ...diagnostic, source: source.source });
	if (!parsed.configuration) return undefined;
	const resolvedLayer = resolveLspConfigurationLayerPaths(parsed.configuration, source.baseDir);
	const resolved = parseLspConfiguration(resolvedLayer);
	for (const diagnostic of resolved.diagnostics) diagnostics.push({ ...diagnostic, source: source.source });
	if (!resolved.configuration) return undefined;
	return source.scope === "project" && !trustProjectLspTransports
		? blockUntrustedProjectTransports(resolved.configuration, source.source, diagnostics)
		: resolved.configuration;
}
/**
 * Load and resolve LSP configuration in deterministic order:
 * global settings < project settings < CLI inputs < SDK/host inputs.
 */
export async function loadLspConfiguration(options: LoadLspConfigurationOptions): Promise<LoadLspConfigurationResult> {
	const collection = collectSettingsConfigurationSources(options);
	for (const input of options.inputs ?? []) await appendConfigurationInput(input, options, collection);
	collection.sources.sort(
		(left, right) => SCOPE_PRECEDENCE[left.scope] - SCOPE_PRECEDENCE[right.scope] || left.order - right.order,
	);

	const layers: LspConfigurationLayer[] = [];
	for (const source of collection.sources) {
		const layer = resolveConfigurationSource(source, options.trustProjectLspTransports, collection.diagnostics);
		if (layer) layers.push(layer);
	}
	const hasErrors = collection.diagnostics.some((diagnostic) => diagnostic.severity === "error");
	const configuration =
		collection.settingsLoadFailed || hasErrors ? { enabled: false, servers: [] } : resolveLspConfiguration(layers);
	return { configuration, diagnostics: collection.diagnostics };
}

export function resolveLspConfigurationLayerPaths(
	layer: LspConfigurationLayer,
	baseDir: string,
): LspConfigurationLayer {
	return {
		...layer,
		servers: layer.servers?.map((server) => {
			if (server.enabled === false) return server;
			return resolveServerPaths(server, baseDir);
		}),
	};
}

function resolveServerPaths(server: LspConfiguredServer, baseDir: string): LspConfiguredServer {
	const transport =
		server.transport.type === "spawn"
			? {
					...server.transport,
					command: isPathLikeCommand(server.transport.command)
						? resolvePortablePath(baseDir, server.transport.command)
						: server.transport.command,
					...(server.transport.cwd ? { cwd: resolveIfRelative(baseDir, server.transport.cwd) } : {}),
				}
			: server.transport.type === "unix"
				? { ...server.transport, path: resolveIfRelative(baseDir, server.transport.path) }
				: server.transport;
	const workspace =
		server.workspace.type === "fixed"
			? { ...server.workspace, path: resolveIfRelative(baseDir, server.workspace.path) }
			: server.workspace.type === "markers" && server.workspace.stopAt
				? { ...server.workspace, stopAt: resolveIfRelative(baseDir, server.workspace.stopAt) }
				: server.workspace;

	return {
		...server,
		transport,
		workspace,
		pathMappings: server.pathMappings?.map((mapping) => ({
			...mapping,
			agentRoot: resolveIfRelative(baseDir, mapping.agentRoot),
		})),
	};
}

function blockUntrustedProjectTransports(
	layer: LspConfigurationLayer,
	source: string,
	diagnostics: LspConfigurationSourceDiagnostic[],
): LspConfigurationLayer {
	if (layer.enabled === true) {
		diagnostics.push({
			severity: "warning",
			source,
			path: "$.enabled",
			message: "blocked project LSP activation; the host must set trustProjectLspTransports to allow it",
		});
	}
	return {
		...(layer.enabled === false ? { enabled: false } : {}),
		...(layer.mode === undefined ? {} : { mode: layer.mode }),
		...(layer.servers === undefined
			? {}
			: {
					servers: layer.servers.filter((server, index) => {
						if (server.enabled === false) return true;
						diagnostics.push({
							severity: "warning",
							source,
							path: `$.servers[${index}].transport`,
							message: `blocked project LSP ${server.transport.type} transport for server ${JSON.stringify(server.id)}; the host must set trustProjectLspTransports to allow it`,
						});
						return false;
					}),
				}),
	};
}

function resolveIfRelative(baseDir: string, value: string): string {
	return resolvePortablePath(baseDir, value);
}

function isPathLikeCommand(command: string): boolean {
	return command.startsWith(".") || command.includes("/") || command.includes("\\");
}
