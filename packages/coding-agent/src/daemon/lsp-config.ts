import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
	type LspConfigurationLayer,
	type LspConfiguredServer,
	type LspTransport,
	type LspWorkspaceRoot,
	parseLspConfiguration,
	type ResolvedLspConfiguration,
	resolveLspConfiguration,
} from "../core/lsp/config.ts";
import { resolveLspConfigurationLayerPaths } from "../core/lsp/config-loader.ts";
import { relativeWithin } from "../core/lsp/portable-path.ts";
import { type DaemonConfiguration, DaemonConfigurationError } from "./config.ts";

const DISABLED_LSP_CONFIGURATION: ResolvedLspConfiguration = { enabled: false, servers: [] };

function readJson(path: string, optional = false): unknown | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (error) {
		if (optional && error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw new DaemonConfigurationError(
			`Unable to load daemon LSP configuration ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function parseLayer(value: unknown, source: string, baseDir: string): LspConfigurationLayer {
	const parsed = parseLspConfiguration(value);
	if (!parsed.configuration) {
		throw new DaemonConfigurationError(
			`Invalid daemon LSP configuration ${source}: ${parsed.diagnostics.map((item) => `${item.path}: ${item.message}`).join("; ")}`,
		);
	}
	const resolved = parseLspConfiguration(resolveLspConfigurationLayerPaths(parsed.configuration, baseDir));
	if (!resolved.configuration) {
		throw new DaemonConfigurationError(
			`Invalid resolved daemon LSP configuration ${source}: ${resolved.diagnostics.map((item) => `${item.path}: ${item.message}`).join("; ")}`,
		);
	}
	return resolved.configuration;
}

function isMissingPathError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function validateExistingLspPath(path: string, requestedPath: string, label: string): boolean {
	let isSymbolicLink: boolean;
	try {
		isSymbolicLink = lstatSync(path).isSymbolicLink();
	} catch (error) {
		if (isMissingPathError(error)) return false;
		throw error;
	}
	if (!isSymbolicLink) return true;
	try {
		realpathSync(path);
	} catch {
		throw new DaemonConfigurationError(`${label} uses a broken symbolic link: ${requestedPath}`);
	}
	return true;
}

function findExistingLspPathAncestor(path: string, label: string): string {
	let existing = path;
	while (!validateExistingLspPath(existing, path, label)) {
		const parent = dirname(existing);
		if (parent === existing) break;
		existing = parent;
	}
	return existing;
}

function requireConfinedPath(path: string, configuration: DaemonConfiguration, label: string): string {
	const existing = findExistingLspPathAncestor(path, label);
	const canonicalExisting = realpathSync(existing);
	if (relativeWithin(configuration.workspaceRoot, canonicalExisting) === undefined) {
		throw new DaemonConfigurationError(`${label} escapes the daemon workspace: ${path}`);
	}
	if (existing === path) return canonicalExisting;
	return resolve(canonicalExisting, relative(existing, path));
}

function canonicalizeDaemonLspServer(
	server: LspConfiguredServer,
	configuration: DaemonConfiguration,
	transport: LspTransport,
	workspace: LspWorkspaceRoot,
): LspConfiguredServer {
	return {
		...server,
		transport,
		workspace,
		...(server.pathMappings
			? {
					pathMappings: server.pathMappings.map((mapping) => ({
						...mapping,
						agentRoot: requireConfinedPath(mapping.agentRoot, configuration, `LSP path mapping for ${server.id}`),
					})),
				}
			: {}),
	};
}
function canonicalizeDaemonLspTransport(server: LspConfiguredServer, configuration: DaemonConfiguration): LspTransport {
	if (server.transport.type === "connection") {
		throw new DaemonConfigurationError(
			`Daemon LSP server ${JSON.stringify(server.id)} cannot use a host-provided connection transport`,
		);
	}
	if (server.transport.type === "spawn") {
		if (!configuration.allowProcessExec) {
			throw new DaemonConfigurationError(
				`Daemon LSP server ${JSON.stringify(server.id)} requires --daemon-allow-process-exec`,
			);
		}
		return {
			...server.transport,
			...(server.transport.cwd
				? { cwd: requireConfinedPath(server.transport.cwd, configuration, `LSP cwd for ${server.id}`) }
				: {}),
			...(isAbsolute(server.transport.command)
				? {
						command: requireConfinedPath(server.transport.command, configuration, `LSP command for ${server.id}`),
					}
				: {}),
		};
	}
	if (server.transport.type === "unix") {
		return {
			...server.transport,
			path: requireConfinedPath(server.transport.path, configuration, `LSP socket for ${server.id}`),
		};
	}
	return server.transport;
}

function canonicalizeDaemonLspWorkspace(
	server: LspConfiguredServer,
	configuration: DaemonConfiguration,
): LspWorkspaceRoot {
	if (server.workspace.type === "fixed") {
		return {
			...server.workspace,
			path: requireConfinedPath(server.workspace.path, configuration, `LSP workspace for ${server.id}`),
		};
	}
	if (server.workspace.type === "markers" && server.workspace.stopAt) {
		return {
			...server.workspace,
			stopAt: requireConfinedPath(server.workspace.stopAt, configuration, `LSP marker boundary for ${server.id}`),
		};
	}
	return server.workspace;
}

function canonicalizeDaemonPolicy(
	configuration: DaemonConfiguration,
	resolved: ResolvedLspConfiguration,
): ResolvedLspConfiguration {
	const servers = resolved.servers.map((server) =>
		canonicalizeDaemonLspServer(
			server,
			configuration,
			canonicalizeDaemonLspTransport(server, configuration),
			canonicalizeDaemonLspWorkspace(server, configuration),
		),
	);
	return { enabled: resolved.enabled, servers };
}

export function loadDaemonLspConfiguration(configuration: DaemonConfiguration): ResolvedLspConfiguration {
	const layers: LspConfigurationLayer[] = [];
	if (configuration.trustProjectLsp) {
		const projectSettingsPath = resolve(configuration.workspaceRoot, ".pi", "settings.json");
		const settings = readJson(projectSettingsPath, true);
		if (settings !== undefined) {
			if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
				throw new DaemonConfigurationError(`Invalid project settings for daemon LSP: ${projectSettingsPath}`);
			}
			const lsp = (settings as { lsp?: unknown }).lsp;
			if (lsp !== undefined)
				layers.push(parseLayer(lsp, projectSettingsPath, resolve(configuration.workspaceRoot, ".pi")));
		}
	}
	if (configuration.lspConfigPath) {
		const value = readJson(configuration.lspConfigPath);
		layers.push(parseLayer(value, configuration.lspConfigPath, resolve(configuration.lspConfigPath, "..")));
	}
	const resolved = layers.length === 0 ? DISABLED_LSP_CONFIGURATION : resolveLspConfiguration(layers);
	return canonicalizeDaemonPolicy(configuration, resolved);
}
