import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
	type LspConfigurationLayer,
	type LspConfiguredServer,
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

function requireConfinedPath(path: string, configuration: DaemonConfiguration, label: string): string {
	let existing = path;
	while (true) {
		try {
			const stat = lstatSync(existing);
			if (stat.isSymbolicLink()) {
				try {
					realpathSync(existing);
				} catch {
					throw new DaemonConfigurationError(`${label} uses a broken symbolic link: ${path}`);
				}
			}
			break;
		} catch (error) {
			if (error instanceof DaemonConfigurationError) throw error;
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			const parent = dirname(existing);
			if (parent === existing) break;
			existing = parent;
		}
	}
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
	transport: LspConfiguredServer["transport"],
	workspace: LspConfiguredServer["workspace"],
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

function canonicalizeDaemonPolicy(
	configuration: DaemonConfiguration,
	resolved: ResolvedLspConfiguration,
): ResolvedLspConfiguration {
	const servers = resolved.servers.map((server) => {
		if (server.transport.type === "connection") {
			throw new DaemonConfigurationError(
				`Daemon LSP server ${JSON.stringify(server.id)} cannot use a host-provided connection transport`,
			);
		}
		let transport: LspConfiguredServer["transport"] = server.transport;
		if (server.transport.type === "spawn") {
			if (!configuration.allowProcessExec) {
				throw new DaemonConfigurationError(
					`Daemon LSP server ${JSON.stringify(server.id)} requires --daemon-allow-process-exec`,
				);
			}
			transport = {
				...server.transport,
				...(server.transport.cwd
					? { cwd: requireConfinedPath(server.transport.cwd, configuration, `LSP cwd for ${server.id}`) }
					: {}),
				...(isAbsolute(server.transport.command)
					? {
							command: requireConfinedPath(
								server.transport.command,
								configuration,
								`LSP command for ${server.id}`,
							),
						}
					: {}),
			};
		} else if (server.transport.type === "unix") {
			transport = {
				...server.transport,
				path: requireConfinedPath(server.transport.path, configuration, `LSP socket for ${server.id}`),
			};
		}
		let workspace: LspConfiguredServer["workspace"] = server.workspace;
		if (server.workspace.type === "fixed") {
			workspace = {
				...server.workspace,
				path: requireConfinedPath(server.workspace.path, configuration, `LSP workspace for ${server.id}`),
			};
		} else if (server.workspace.type === "markers" && server.workspace.stopAt) {
			workspace = {
				...server.workspace,
				stopAt: requireConfinedPath(server.workspace.stopAt, configuration, `LSP marker boundary for ${server.id}`),
			};
		}
		return canonicalizeDaemonLspServer(server, configuration, transport, workspace);
	});
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
