import { posix, win32 } from "node:path";
import { normalizePortablePath, pathApi, pathFlavor, relativeWithin } from "./portable-path.ts";

export type LspJsonValue = null | boolean | number | string | LspJsonValue[] | { [key: string]: LspJsonValue };

export type LspConfigurationMode = "merge" | "replace";

export interface LspDocumentSelector {
	/** Language ID sent to the server in textDocument/didOpen. */
	languageId: string;
	/** Workspace-relative glob pattern used to select documents. */
	pattern: string;
	/** URI scheme to match. Defaults to file. */
	scheme?: string;
}

export interface LspSpawnTransport {
	type: "spawn";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export interface LspTcpTransport {
	type: "tcp";
	host: string;
	port: number;
}

export interface LspUnixSocketTransport {
	type: "unix";
	path: string;
}

export interface LspNamedPipeTransport {
	type: "pipe";
	path: string;
}

export interface LspProgrammaticTransport {
	type: "connection";
	/** Host-registered connection factory ID. Functions are never loaded from JSON. */
	id: string;
}

export type LspTransport =
	| LspSpawnTransport
	| LspTcpTransport
	| LspUnixSocketTransport
	| LspNamedPipeTransport
	| LspProgrammaticTransport;

export type LspWorkspaceRoot =
	| { type: "session" }
	| { type: "fixed"; path: string }
	| {
			type: "markers";
			markers: string[];
			fallback?: "session" | "none";
			stopAt?: string;
	  };

export interface LspPathMapping {
	/** Agent-visible filesystem root. Relative roots are resolved against the configuration source. */
	agentRoot: string;
	/** Absolute file URI for the same root as observed by the language server. */
	serverRootUri: string;
}

export type LspServerLifecycle = { type: "managed" } | { type: "attached"; shutdown?: "disconnect" | "protocol" };

export interface LspServerTimeouts {
	/** Zero disables the corresponding timeout. */
	connectMs?: number;
	initializeMs?: number;
	requestMs?: number;
	shutdownMs?: number;
}

export interface LspClientInfo {
	name: string;
	version?: string;
}

export type LspTraceValue = "off" | "messages" | "verbose";

export interface LspServerFeatures {
	diagnostics?: boolean;
	hover?: boolean;
	definition?: boolean;
	references?: boolean;
	rename?: boolean;
	codeActions?: boolean;
}

export interface LspConfiguredServer {
	id: string;
	enabled?: true;
	selectors: LspDocumentSelector[];
	transport: LspTransport;
	lifecycle: LspServerLifecycle;
	workspace: LspWorkspaceRoot;
	pathMappings?: LspPathMapping[];
	initializationOptions?: LspJsonValue;
	settings?: LspJsonValue;
	clientInfo?: LspClientInfo;
	locale?: string;
	trace?: LspTraceValue;
	features?: LspServerFeatures;
	priority?: number;
	timeouts?: LspServerTimeouts;
}

export interface LspDisabledServer {
	id: string;
	enabled: false;
}

export type LspServerEntry = LspConfiguredServer | LspDisabledServer;

/**
 * One externally supplied configuration layer.
 *
 * - An absent layer leaves lower-precedence configuration unchanged.
 * - `merge` (the default) replaces complete server definitions by ID.
 * - `replace` clears lower-precedence servers before applying this layer.
 * - `{ id, enabled: false }` removes a server inherited from a lower layer.
 * - `enabled: false` disables the resolved runtime without discarding server definitions.
 */
export interface LspConfigurationLayer {
	enabled?: boolean;
	mode?: LspConfigurationMode;
	servers?: LspServerEntry[];
}

export interface ResolvedLspConfiguration {
	enabled: boolean;
	servers: LspConfiguredServer[];
}

export interface LspConfigurationDiagnostic {
	severity: "error";
	path: string;
	message: string;
}

export interface ParseLspConfigurationResult {
	configuration?: LspConfigurationLayer;
	diagnostics: LspConfigurationDiagnostic[];
}

const SERVER_KEYS = new Set([
	"id",
	"enabled",
	"selectors",
	"transport",
	"lifecycle",
	"workspace",
	"pathMappings",
	"initializationOptions",
	"settings",
	"clientInfo",
	"locale",
	"trace",
	"features",
	"priority",
	"timeouts",
]);
const FEATURE_KEYS = ["diagnostics", "hover", "definition", "references", "rename", "codeActions"] as const;
const TIMEOUT_KEYS = ["connectMs", "initializeMs", "requestMs", "shutdownMs"] as const;

export function parseLspConfiguration(value: unknown): ParseLspConfigurationResult {
	const diagnostics: LspConfigurationDiagnostic[] = [];
	const object = parseObject(value, "$", diagnostics);
	if (!object) return { diagnostics };
	rejectUnknownKeys(object, new Set(["enabled", "mode", "servers"]), "$", diagnostics);

	const enabled = parseOptionalBoolean(object.enabled, "$.enabled", diagnostics);
	const mode = parseOptionalEnum(object.mode, ["merge", "replace"], "$.mode", diagnostics);
	const servers = parseServers(object.servers, diagnostics);
	if (diagnostics.length > 0) return { diagnostics };

	return {
		configuration: {
			...(enabled === undefined ? {} : { enabled }),
			...(mode === undefined ? {} : { mode }),
			...(servers === undefined ? {} : { servers }),
		},
		diagnostics,
	};
}

/** Resolve already validated layers from lowest to highest precedence. */
export function resolveLspConfiguration(
	layers: readonly (LspConfigurationLayer | undefined)[],
): ResolvedLspConfiguration {
	const servers = new Map<string, LspConfiguredServer>();
	let enabled = false;
	let hasLayer = false;

	for (const layer of layers) {
		if (!layer) continue;
		if (!hasLayer) enabled = layer.enabled ?? true;
		hasLayer = true;
		if (layer.enabled !== undefined) enabled = layer.enabled;
		if (layer.mode === "replace") servers.clear();
		for (const server of layer.servers ?? []) {
			if (server.enabled === false) servers.delete(server.id);
			else servers.set(server.id, server);
		}
	}

	return { enabled: hasLayer && enabled, servers: [...servers.values()] };
}

function parseServers(value: unknown, diagnostics: LspConfigurationDiagnostic[]): LspServerEntry[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		addError(diagnostics, "$.servers", "must be an array");
		return undefined;
	}
	const servers: LspServerEntry[] = [];
	const ids = new Set<string>();
	for (const [index, entry] of value.entries()) {
		const path = `$.servers[${index}]`;
		const server = parseServer(entry, path, diagnostics);
		if (!server) continue;
		if (ids.has(server.id)) addError(diagnostics, `${path}.id`, `duplicates server ID ${JSON.stringify(server.id)}`);
		else ids.add(server.id);
		servers.push(server);
	}
	return servers;
}

function parseServer(
	value: unknown,
	path: string,
	diagnostics: LspConfigurationDiagnostic[],
): LspServerEntry | undefined {
	const object = parseObject(value, path, diagnostics);
	if (!object) return undefined;
	const id = parseRequiredString(object.id, `${path}.id`, diagnostics);
	if (id && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
		addError(
			diagnostics,
			`${path}.id`,
			"must start with an alphanumeric character and contain only letters, numbers, '.', '_' or '-'",
		);
	}
	const enabled = parseOptionalBoolean(object.enabled, `${path}.enabled`, diagnostics);
	if (enabled === false) {
		rejectUnknownKeys(object, new Set(["id", "enabled"]), path, diagnostics);
		return id ? { id, enabled: false } : undefined;
	}
	rejectUnknownKeys(object, SERVER_KEYS, path, diagnostics);

	const selectors = parseSelectors(object.selectors, `${path}.selectors`, diagnostics);
	const transport = parseTransport(object.transport, `${path}.transport`, diagnostics);
	const lifecycle = parseLifecycle(object.lifecycle, `${path}.lifecycle`, diagnostics);
	const workspace = parseWorkspace(object.workspace, `${path}.workspace`, diagnostics);
	const pathMappings = parsePathMappings(object.pathMappings, `${path}.pathMappings`, diagnostics);
	const initializationOptions = parseOptionalJson(
		object.initializationOptions,
		`${path}.initializationOptions`,
		diagnostics,
	);
	const settings = parseOptionalJson(object.settings, `${path}.settings`, diagnostics);
	const clientInfo = parseClientInfo(object.clientInfo, `${path}.clientInfo`, diagnostics);
	const locale = parseOptionalString(object.locale, `${path}.locale`, diagnostics);
	const trace = parseOptionalEnum(object.trace, ["off", "messages", "verbose"], `${path}.trace`, diagnostics);
	const features = parseFeatures(object.features, `${path}.features`, diagnostics);
	const priority = parseOptionalInteger(object.priority, `${path}.priority`, diagnostics);
	const timeouts = parseTimeouts(object.timeouts, `${path}.timeouts`, diagnostics);

	if (transport?.type === "spawn" && lifecycle?.type !== "managed") {
		addError(diagnostics, `${path}.lifecycle.type`, "must be 'managed' when transport.type is 'spawn'");
	}
	if (transport && transport.type !== "spawn" && transport.type !== "connection" && lifecycle?.type !== "attached") {
		addError(diagnostics, `${path}.lifecycle.type`, `must be 'attached' when transport.type is '${transport.type}'`);
	}
	if (!id || !selectors || !transport || !lifecycle || !workspace) return undefined;

	return {
		id,
		...(enabled === true ? { enabled: true as const } : {}),
		selectors,
		transport,
		lifecycle,
		workspace,
		...(pathMappings === undefined ? {} : { pathMappings }),
		...(initializationOptions === undefined ? {} : { initializationOptions }),
		...(settings === undefined ? {} : { settings }),
		...(clientInfo === undefined ? {} : { clientInfo }),
		...(locale === undefined ? {} : { locale }),
		...(trace === undefined ? {} : { trace }),
		...(features === undefined ? {} : { features }),
		...(priority === undefined ? {} : { priority }),
		...(timeouts === undefined ? {} : { timeouts }),
	};
}

function parseSelectors(
	value: unknown,
	path: string,
	diagnostics: LspConfigurationDiagnostic[],
): LspDocumentSelector[] | undefined {
	if (!Array.isArray(value) || value.length === 0) {
		addError(diagnostics, path, "must be a non-empty array");
		return undefined;
	}
	const selectors: LspDocumentSelector[] = [];
	const signatures = new Set<string>();
	for (const [index, entry] of value.entries()) {
		const itemPath = `${path}[${index}]`;
		const object = parseObject(entry, itemPath, diagnostics);
		if (!object) continue;
		rejectUnknownKeys(object, new Set(["languageId", "pattern", "scheme"]), itemPath, diagnostics);
		const languageId = parseRequiredString(object.languageId, `${itemPath}.languageId`, diagnostics);
		const pattern = parseRequiredString(object.pattern, `${itemPath}.pattern`, diagnostics);
		const scheme = parseOptionalString(object.scheme, `${itemPath}.scheme`, diagnostics);
		if (pattern && !isSafeRelativePath(pattern)) {
			addError(diagnostics, `${itemPath}.pattern`, "must be a workspace-relative pattern without '..' segments");
		}
		if (!languageId || !pattern) continue;
		const signature = `${scheme ?? "file"}\u0000${pattern}`;
		if (signatures.has(signature)) {
			addError(diagnostics, itemPath, "is ambiguous because another selector has the same scheme and pattern");
		} else {
			signatures.add(signature);
		}
		selectors.push({ languageId, pattern, ...(scheme === undefined ? {} : { scheme }) });
	}
	return selectors;
}

function parseTransport(
	value: unknown,
	path: string,
	diagnostics: LspConfigurationDiagnostic[],
): LspTransport | undefined {
	const object = parseObject(value, path, diagnostics);
	if (!object) return undefined;
	const type = parseRequiredString(object.type, `${path}.type`, diagnostics);
	switch (type) {
		case "spawn": {
			rejectUnknownKeys(object, new Set(["type", "command", "args", "env", "cwd"]), path, diagnostics);
			const command = parseRequiredString(object.command, `${path}.command`, diagnostics);
			const args = parseOptionalStringArray(object.args, `${path}.args`, diagnostics);
			const env = parseOptionalStringRecord(object.env, `${path}.env`, diagnostics);
			const cwd = parseOptionalString(object.cwd, `${path}.cwd`, diagnostics);
			return command
				? { type, command, ...(args ? { args } : {}), ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) }
				: undefined;
		}
		case "tcp": {
			rejectUnknownKeys(object, new Set(["type", "host", "port"]), path, diagnostics);
			const host = parseRequiredString(object.host, `${path}.host`, diagnostics);
			const port = parseOptionalInteger(object.port, `${path}.port`, diagnostics);
			if (port === undefined) addError(diagnostics, `${path}.port`, "is required and must be an integer");
			else if (port < 1 || port > 65535) addError(diagnostics, `${path}.port`, "must be between 1 and 65535");
			return host && port !== undefined ? { type, host, port } : undefined;
		}
		case "unix": {
			rejectUnknownKeys(object, new Set(["type", "path"]), path, diagnostics);
			const endpointPath = parseRequiredString(object.path, `${path}.path`, diagnostics);
			if (endpointPath && !posix.isAbsolute(endpointPath) && !isSafeRelativePath(endpointPath)) {
				addError(diagnostics, `${path}.path`, "must be absolute or a safe source-relative Unix socket path");
			}
			return endpointPath ? { type, path: endpointPath } : undefined;
		}
		case "pipe": {
			rejectUnknownKeys(object, new Set(["type", "path"]), path, diagnostics);
			const endpointPath = parseRequiredString(object.path, `${path}.path`, diagnostics);
			if (endpointPath && !isAbsoluteNamedPipe(endpointPath)) {
				addError(
					diagnostics,
					`${path}.path`,
					"must be an absolute Windows named-pipe path such as \\\\.\\pipe\\server",
				);
			}
			return endpointPath ? { type, path: endpointPath } : undefined;
		}
		case "connection": {
			rejectUnknownKeys(object, new Set(["type", "id"]), path, diagnostics);
			const id = parseRequiredString(object.id, `${path}.id`, diagnostics);
			return id ? { type, id } : undefined;
		}
		default:
			if (type)
				addError(diagnostics, `${path}.type`, "must be one of 'spawn', 'tcp', 'unix', 'pipe', or 'connection'");
			return undefined;
	}
}

function parseLifecycle(
	value: unknown,
	path: string,
	diagnostics: LspConfigurationDiagnostic[],
): LspServerLifecycle | undefined {
	const object = parseObject(value, path, diagnostics);
	if (!object) return undefined;
	const type = parseRequiredString(object.type, `${path}.type`, diagnostics);
	if (type === "managed") {
		rejectUnknownKeys(object, new Set(["type"]), path, diagnostics);
		return { type };
	}
	if (type === "attached") {
		rejectUnknownKeys(object, new Set(["type", "shutdown"]), path, diagnostics);
		const shutdown = parseOptionalEnum(object.shutdown, ["disconnect", "protocol"], `${path}.shutdown`, diagnostics);
		return { type, ...(shutdown === undefined ? {} : { shutdown }) };
	}
	if (type) addError(diagnostics, `${path}.type`, "must be 'managed' or 'attached'");
	return undefined;
}

function parseWorkspace(
	value: unknown,
	path: string,
	diagnostics: LspConfigurationDiagnostic[],
): LspWorkspaceRoot | undefined {
	const object = parseObject(value, path, diagnostics);
	if (!object) return undefined;
	const type = parseRequiredString(object.type, `${path}.type`, diagnostics);
	if (type === "session") {
		rejectUnknownKeys(object, new Set(["type"]), path, diagnostics);
		return { type };
	}
	if (type === "fixed") {
		rejectUnknownKeys(object, new Set(["type", "path"]), path, diagnostics);
		const fixedPath = parseRequiredString(object.path, `${path}.path`, diagnostics);
		return fixedPath ? { type, path: fixedPath } : undefined;
	}
	if (type === "markers") {
		rejectUnknownKeys(object, new Set(["type", "markers", "fallback", "stopAt"]), path, diagnostics);
		const markers = parseRequiredUniqueRelativePaths(object.markers, `${path}.markers`, diagnostics);
		const fallback = parseOptionalEnum(object.fallback, ["session", "none"], `${path}.fallback`, diagnostics);
		const stopAt = parseOptionalString(object.stopAt, `${path}.stopAt`, diagnostics);
		return markers
			? {
					type,
					markers,
					...(fallback === undefined ? {} : { fallback }),
					...(stopAt === undefined ? {} : { stopAt }),
				}
			: undefined;
	}
	if (type) addError(diagnostics, `${path}.type`, "must be 'session', 'fixed', or 'markers'");
	return undefined;
}

function parsePathMappings(
	value: unknown,
	path: string,
	diagnostics: LspConfigurationDiagnostic[],
): LspPathMapping[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		addError(diagnostics, path, "must be an array");
		return undefined;
	}
	const mappings: LspPathMapping[] = [];
	const agentRoots = new Set<string>();
	const serverRoots = new Set<string>();
	for (const [index, entry] of value.entries()) {
		const itemPath = `${path}[${index}]`;
		const object = parseObject(entry, itemPath, diagnostics);
		if (!object) continue;
		rejectUnknownKeys(object, new Set(["agentRoot", "serverRootUri"]), itemPath, diagnostics);
		const agentRoot = parseRequiredString(object.agentRoot, `${itemPath}.agentRoot`, diagnostics);
		const serverRootUri = parseRequiredString(object.serverRootUri, `${itemPath}.serverRootUri`, diagnostics);
		if (serverRootUri && !isAbsoluteFileUri(serverRootUri)) {
			addError(
				diagnostics,
				`${itemPath}.serverRootUri`,
				"must be an absolute file URI without query or fragment components",
			);
		}
		if (!agentRoot || !serverRootUri) continue;
		const normalizedAgentRoot = normalizeAgentRoot(agentRoot);
		const normalizedServerRoot = canonicalFileUri(serverRootUri);
		if (agentRoots.has(normalizedAgentRoot))
			addError(diagnostics, `${itemPath}.agentRoot`, "duplicates another mapping root");
		if (normalizedServerRoot && serverRoots.has(normalizedServerRoot)) {
			addError(diagnostics, `${itemPath}.serverRootUri`, "duplicates another mapping root");
		}
		agentRoots.add(normalizedAgentRoot);
		if (normalizedServerRoot) serverRoots.add(normalizedServerRoot);
		mappings.push({ agentRoot, serverRootUri });
	}
	for (let index = 0; index < mappings.length; index++) {
		for (let previous = 0; previous < index; previous++) {
			if (!pathMappingsAreReversible(mappings[previous], mappings[index])) {
				addError(
					diagnostics,
					`${path}[${index}].agentRoot`,
					`overlaps mapping ${previous} without an equivalent server URI relationship`,
				);
				addError(
					diagnostics,
					`${path}[${index}].serverRootUri`,
					`overlaps mapping ${previous} without an equivalent agent path relationship`,
				);
			}
		}
	}
	return mappings;
}

function parseClientInfo(
	value: unknown,
	path: string,
	diagnostics: LspConfigurationDiagnostic[],
): LspClientInfo | undefined {
	if (value === undefined) return undefined;
	const object = parseObject(value, path, diagnostics);
	if (!object) return undefined;
	rejectUnknownKeys(object, new Set(["name", "version"]), path, diagnostics);
	const name = parseRequiredString(object.name, `${path}.name`, diagnostics);
	const version = parseOptionalString(object.version, `${path}.version`, diagnostics);
	return name ? { name, ...(version === undefined ? {} : { version }) } : undefined;
}

function parseFeatures(
	value: unknown,
	path: string,
	diagnostics: LspConfigurationDiagnostic[],
): LspServerFeatures | undefined {
	if (value === undefined) return undefined;
	const object = parseObject(value, path, diagnostics);
	if (!object) return undefined;
	rejectUnknownKeys(object, new Set(FEATURE_KEYS), path, diagnostics);
	const features: LspServerFeatures = {};
	for (const key of FEATURE_KEYS) {
		const setting = parseOptionalBoolean(object[key], `${path}.${key}`, diagnostics);
		if (setting !== undefined) features[key] = setting;
	}
	return features;
}

function parseTimeouts(
	value: unknown,
	path: string,
	diagnostics: LspConfigurationDiagnostic[],
): LspServerTimeouts | undefined {
	if (value === undefined) return undefined;
	const object = parseObject(value, path, diagnostics);
	if (!object) return undefined;
	rejectUnknownKeys(object, new Set(TIMEOUT_KEYS), path, diagnostics);
	const timeouts: LspServerTimeouts = {};
	for (const key of TIMEOUT_KEYS) {
		const timeout = parseOptionalInteger(object[key], `${path}.${key}`, diagnostics);
		if (timeout !== undefined) {
			if (timeout < 0) addError(diagnostics, `${path}.${key}`, "must be zero or a positive integer");
			else timeouts[key] = timeout;
		}
	}
	return timeouts;
}

function parseOptionalJson(
	value: unknown,
	path: string,
	diagnostics: LspConfigurationDiagnostic[],
): LspJsonValue | undefined {
	if (value === undefined) return undefined;
	const result = parseJson(value, path, diagnostics, new Set<object>());
	return result.ok ? result.value : undefined;
}

function parseJson(
	value: unknown,
	path: string,
	diagnostics: LspConfigurationDiagnostic[],
	ancestors: Set<object>,
): { ok: true; value: LspJsonValue } | { ok: false } {
	if (value === null || typeof value === "string" || typeof value === "boolean") return { ok: true, value };
	if (typeof value === "number") {
		if (Number.isFinite(value)) return { ok: true, value };
		addError(diagnostics, path, "must contain only finite JSON numbers");
		return { ok: false };
	}
	if (typeof value !== "object") {
		addError(diagnostics, path, "must be valid JSON data");
		return { ok: false };
	}
	if (ancestors.has(value)) {
		addError(diagnostics, path, "must not contain circular references");
		return { ok: false };
	}
	ancestors.add(value);
	if (Array.isArray(value)) {
		const output: LspJsonValue[] = [];
		let valid = true;
		for (const [index, item] of value.entries()) {
			const parsed = parseJson(item, `${path}[${index}]`, diagnostics, ancestors);
			if (parsed.ok) output.push(parsed.value);
			else valid = false;
		}
		ancestors.delete(value);
		return valid ? { ok: true, value: output } : { ok: false };
	}
	const output: { [key: string]: LspJsonValue } = {};
	let valid = true;
	for (const [key, item] of Object.entries(value)) {
		const parsed = parseJson(item, `${path}.${key}`, diagnostics, ancestors);
		if (parsed.ok) output[key] = parsed.value;
		else valid = false;
	}
	ancestors.delete(value);
	return valid ? { ok: true, value: output } : { ok: false };
}

function parseObject(
	value: unknown,
	path: string,
	diagnostics: LspConfigurationDiagnostic[],
): Record<string, unknown> | undefined {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	addError(diagnostics, path, "must be an object");
	return undefined;
}

function parseRequiredString(
	value: unknown,
	path: string,
	diagnostics: LspConfigurationDiagnostic[],
): string | undefined {
	if (typeof value !== "string" || value.trim().length === 0) {
		addError(diagnostics, path, "is required and must be a non-empty string");
		return undefined;
	}
	return value;
}

function parseOptionalString(
	value: unknown,
	path: string,
	diagnostics: LspConfigurationDiagnostic[],
): string | undefined {
	if (value === undefined) return undefined;
	return parseRequiredString(value, path, diagnostics);
}

function parseOptionalBoolean(
	value: unknown,
	path: string,
	diagnostics: LspConfigurationDiagnostic[],
): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		addError(diagnostics, path, "must be a boolean");
		return undefined;
	}
	return value;
}

function parseOptionalInteger(
	value: unknown,
	path: string,
	diagnostics: LspConfigurationDiagnostic[],
): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value)) {
		addError(diagnostics, path, "must be a safe integer");
		return undefined;
	}
	return value as number;
}

function parseOptionalEnum<const T extends string>(
	value: unknown,
	allowed: readonly T[],
	path: string,
	diagnostics: LspConfigurationDiagnostic[],
): T | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && allowed.includes(value as T)) return value as T;
	addError(diagnostics, path, `must be one of ${allowed.map((item) => JSON.stringify(item)).join(", ")}`);
	return undefined;
}

function parseOptionalStringArray(
	value: unknown,
	path: string,
	diagnostics: LspConfigurationDiagnostic[],
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		addError(diagnostics, path, "must be an array of strings");
		return undefined;
	}
	const output: string[] = [];
	for (const [index, item] of value.entries()) {
		if (typeof item !== "string") addError(diagnostics, `${path}[${index}]`, "must be a string");
		else output.push(item);
	}
	return output;
}

function parseOptionalStringRecord(
	value: unknown,
	path: string,
	diagnostics: LspConfigurationDiagnostic[],
): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	const object = parseObject(value, path, diagnostics);
	if (!object) return undefined;
	const output: Record<string, string> = {};
	for (const [key, item] of Object.entries(object)) {
		if (typeof item !== "string") addError(diagnostics, `${path}.${key}`, "must be a string");
		else output[key] = item;
	}
	return output;
}

function parseRequiredUniqueRelativePaths(
	value: unknown,
	path: string,
	diagnostics: LspConfigurationDiagnostic[],
): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0) {
		addError(diagnostics, path, "must be a non-empty array of relative paths");
		return undefined;
	}
	const output: string[] = [];
	const seen = new Set<string>();
	for (const [index, item] of value.entries()) {
		const itemPath = `${path}[${index}]`;
		const marker = parseRequiredString(item, itemPath, diagnostics);
		if (!marker) continue;
		if (!isSafeRelativePath(marker)) addError(diagnostics, itemPath, "must be a relative path without '..' segments");
		if (seen.has(marker)) addError(diagnostics, itemPath, "duplicates another marker");
		else seen.add(marker);
		output.push(marker);
	}
	return output;
}

function rejectUnknownKeys(
	object: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	path: string,
	diagnostics: LspConfigurationDiagnostic[],
): void {
	for (const key of Object.keys(object)) {
		if (!allowed.has(key)) addError(diagnostics, `${path}.${key}`, "is not a recognized property");
	}
}

function isSafeRelativePath(value: string): boolean {
	if (posix.isAbsolute(value) || win32.isAbsolute(value)) return false;
	return !value.split(/[\\/]/).includes("..");
}

interface MappingRootRelation {
	direction: "left-parent" | "right-parent" | "equal";
	relative: string;
	caseInsensitive: boolean;
}

function agentRootRelation(left: string, right: string): MappingRootRelation | undefined {
	const leftFlavor = pathFlavor(left);
	const rightFlavor = pathFlavor(right);
	if (leftFlavor !== rightFlavor) return undefined;
	const normalizedLeft = normalizePortablePath(left, leftFlavor);
	const normalizedRight = normalizePortablePath(right, rightFlavor);
	const comparableLeft = leftFlavor === "windows" ? normalizedLeft.toLowerCase() : normalizedLeft;
	const comparableRight = rightFlavor === "windows" ? normalizedRight.toLowerCase() : normalizedRight;
	if (comparableLeft === comparableRight) {
		return { direction: "equal", relative: "", caseInsensitive: leftFlavor === "windows" };
	}
	const fromLeft = relativeWithin(normalizedLeft, normalizedRight);
	if (fromLeft !== undefined) {
		return {
			direction: "left-parent",
			relative: fromLeft.replace(/\\/g, "/"),
			caseInsensitive: leftFlavor === "windows",
		};
	}
	const fromRight = relativeWithin(normalizedRight, normalizedLeft);
	return fromRight === undefined
		? undefined
		: {
				direction: "right-parent",
				relative: fromRight.replace(/\\/g, "/"),
				caseInsensitive: leftFlavor === "windows",
			};
}

function serverRootRelation(leftValue: string, rightValue: string): MappingRootRelation | undefined {
	if (!canonicalFileUri(leftValue) || !canonicalFileUri(rightValue)) return undefined;
	const left = new URL(leftValue);
	const right = new URL(rightValue);
	if (left.hostname.toLowerCase() !== right.hostname.toLowerCase()) return undefined;
	const leftSegments = left.pathname
		.split("/")
		.filter(Boolean)
		.map((segment) => decodeURIComponent(segment));
	const rightSegments = right.pathname
		.split("/")
		.filter(Boolean)
		.map((segment) => decodeURIComponent(segment));
	const caseInsensitive =
		left.hostname.length > 0 ||
		right.hostname.length > 0 ||
		leftSegments[0]?.endsWith(":") === true ||
		rightSegments[0]?.endsWith(":") === true;
	const comparable = (segment: string) => (caseInsensitive ? segment.toLowerCase() : segment);
	let shared = 0;
	while (
		shared < leftSegments.length &&
		shared < rightSegments.length &&
		comparable(leftSegments[shared]) === comparable(rightSegments[shared])
	) {
		shared++;
	}
	if (shared < Math.min(leftSegments.length, rightSegments.length)) return undefined;
	if (leftSegments.length === rightSegments.length) return { direction: "equal", relative: "", caseInsensitive };
	return leftSegments.length < rightSegments.length
		? { direction: "left-parent", relative: rightSegments.slice(shared).join("/"), caseInsensitive }
		: { direction: "right-parent", relative: leftSegments.slice(shared).join("/"), caseInsensitive };
}

function pathMappingsAreReversible(left: LspPathMapping, right: LspPathMapping): boolean {
	const agent = agentRootRelation(left.agentRoot, right.agentRoot);
	const server = serverRootRelation(left.serverRootUri, right.serverRootUri);
	if (!agent || !server) return agent === undefined && server === undefined;
	if (agent.direction !== server.direction) return false;
	return agent.caseInsensitive && server.caseInsensitive
		? agent.relative.toLowerCase() === server.relative.toLowerCase()
		: agent.relative === server.relative;
}

function normalizeAgentRoot(value: string): string {
	const flavor = pathFlavor(value);
	const api = pathApi(flavor);
	const normalized = normalizePortablePath(value, flavor);
	const root = api.parse(normalized).root;
	const trailingSeparator = flavor === "windows" ? /[\\/]+$/ : /\/+$/;
	const withoutTrailingSeparators = normalized === root ? normalized : normalized.replace(trailingSeparator, "");
	return flavor === "windows" ? withoutTrailingSeparators.toLowerCase() : withoutTrailingSeparators;
}

function isAbsoluteNamedPipe(value: string): boolean {
	const lower = value.toLowerCase();
	const prefixes = ["\\\\.\\pipe\\", "\\\\?\\pipe\\"];
	return prefixes.some((prefix) => lower.startsWith(prefix) && value.length > prefix.length);
}

function canonicalFileUri(value: string): string | undefined {
	if (!/^file:\//i.test(value)) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "file:" || url.pathname.length === 0 || url.search !== "" || url.hash !== "")
			return undefined;
		const segments = url.pathname
			.split("/")
			.filter(Boolean)
			.map((segment) => decodeURIComponent(segment));
		if (segments.some((segment) => segment.includes("/") || segment === "." || segment === "..")) return undefined;
		if (url.hostname && segments.length === 0) return undefined;
		if (segments[0]?.endsWith(":") && segments.length === 1 && !url.pathname.endsWith("/")) return undefined;
		const driveRoot = segments[0]?.endsWith(":") && segments.length === 1;
		url.pathname = `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}${driveRoot ? "/" : ""}`;
		url.hostname = url.hostname.toLowerCase();
		return url.toString();
	} catch {
		return undefined;
	}
}

function isAbsoluteFileUri(value: string): boolean {
	return canonicalFileUri(value) !== undefined;
}

function addError(diagnostics: LspConfigurationDiagnostic[], path: string, message: string): void {
	diagnostics.push({ severity: "error", path, message });
}
