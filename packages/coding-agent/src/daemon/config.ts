import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
	DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
	type RemoteWorkspaceProtocolLimits,
	validateRemoteWorkspaceProtocolLimits,
} from "../core/remote-workspace-protocol/contract.ts";

export const DAEMON_WEBSOCKET_PATH = "/pi/workspace";
export const DAEMON_WEBSOCKET_PROTOCOL = "pi.workspace.v1";

export interface DaemonTlsConfiguration {
	readonly cert: Buffer;
	readonly key: Buffer;
	readonly passphrase?: string;
}

export interface DaemonConfiguration {
	readonly host: string;
	readonly port: number;
	readonly workspaceRoot: string;
	readonly temporaryRoot?: string;
	readonly token?: string;
	readonly allowedOrigins: readonly string[];
	readonly tls?: DaemonTlsConfiguration;
	readonly allowInsecureTransport: boolean;
	readonly allowProcessExec: boolean;
	readonly allowRoot: boolean;
	readonly forwardedEnvironment: readonly string[];
	readonly lspConfigPath?: string;
	readonly sandboxInstructionsPath?: string;
	readonly trustProjectLsp: boolean;
	readonly maxConnections: number;
	readonly maxGlobalRequests: number;
	readonly maxGlobalTransfers: number;
	readonly maxBufferedOutputBytes: number;
	readonly maxPendingConnections: number;
	readonly handshakeTimeoutMs: number;
	readonly shutdownTimeoutMs: number;
	readonly protocolLimits: RemoteWorkspaceProtocolLimits;
}

export interface DaemonCommand {
	readonly help: boolean;
	readonly configuration?: DaemonConfiguration;
}

export class DaemonConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DaemonConfigurationError";
	}
}

interface ParsedDaemonInputs {
	help: boolean;
	host?: string;
	port?: string;
	cwd?: string;
	origins: string[];
	tlsCertPath?: string;
	tlsKeyPath?: string;
	allowInsecureTransport?: boolean;
	allowProcessExec?: boolean;
	allowRoot?: boolean;
	forwardedEnvironment: string[];
	lspConfigPath?: string;
	trustProjectLsp?: boolean;
	maxConnections?: string;
	maxPendingConnections?: string;
	handshakeTimeoutMs?: string;
	shutdownTimeoutMs?: string;
}

const BOOLEAN_VALUES = new Map<string, boolean>([
	["1", true],
	["true", true],
	["yes", true],
	["0", false],
	["false", false],
	["no", false],
]);

const VALUE_FLAGS = new Map<string, keyof ParsedDaemonInputs>([
	["--daemon-host", "host"],
	["--daemon-port", "port"],
	["--daemon-cwd", "cwd"],
	["--daemon-tls-cert", "tlsCertPath"],
	["--daemon-tls-key", "tlsKeyPath"],
	["--daemon-lsp-config", "lspConfigPath"],
	["--daemon-max-connections", "maxConnections"],
	["--daemon-max-pending-connections", "maxPendingConnections"],
	["--daemon-handshake-timeout-ms", "handshakeTimeoutMs"],
	["--daemon-shutdown-timeout-ms", "shutdownTimeoutMs"],
]);

const BOOLEAN_FLAGS = new Map<string, keyof ParsedDaemonInputs>([
	["--daemon-allow-insecure-transport", "allowInsecureTransport"],
	["--daemon-allow-process-exec", "allowProcessExec"],
	["--daemon-allow-root", "allowRoot"],
	["--daemon-trust-project-lsp", "trustProjectLsp"],
]);

function parseBoolean(value: string | undefined, name: string, fallback = false): boolean {
	if (value === undefined) return fallback;
	const parsed = BOOLEAN_VALUES.get(value.toLowerCase());
	if (parsed === undefined) throw new DaemonConfigurationError(`${name} must be one of 1, 0, true, false, yes, or no`);
	return parsed;
}

function parseInteger(
	value: string | undefined,
	name: string,
	minimum: number,
	maximum: number,
	fallback: number,
): number {
	if (value === undefined) return fallback;
	if (!/^(0|[1-9][0-9]*)$/.test(value)) {
		throw new DaemonConfigurationError(`${name} must be a decimal integer from ${minimum} to ${maximum}`);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new DaemonConfigurationError(`${name} must be a decimal integer from ${minimum} to ${maximum}`);
	}
	return parsed;
}

function setSingleton(
	inputs: ParsedDaemonInputs,
	key: keyof ParsedDaemonInputs,
	value: string | boolean,
	flag: string,
): void {
	if (inputs[key] !== undefined) throw new DaemonConfigurationError(`${flag} may only be specified once`);
	(inputs as Record<keyof ParsedDaemonInputs, unknown>)[key] = value;
}

function requireFlagValue(args: readonly string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (value === undefined || value.startsWith("-")) throw new DaemonConfigurationError(`${flag} requires a value`);
	return value;
}

function parseInputs(args: readonly string[]): ParsedDaemonInputs {
	if (args[0] !== "--daemon") throw new DaemonConfigurationError("Daemon command must start with --daemon");
	const inputs: ParsedDaemonInputs = { help: false, origins: [], forwardedEnvironment: [] };
	for (let index = 1; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--help" || argument === "-h") {
			inputs.help = true;
			continue;
		}
		if (argument === "--daemon-origin" || argument === "--daemon-env") {
			const value = requireFlagValue(args, index, argument);
			if (argument === "--daemon-origin") inputs.origins.push(value);
			else inputs.forwardedEnvironment.push(value);
			index++;
			continue;
		}
		const valueKey = VALUE_FLAGS.get(argument);
		if (valueKey) {
			setSingleton(inputs, valueKey, requireFlagValue(args, index, argument), argument);
			index++;
			continue;
		}
		const booleanKey = BOOLEAN_FLAGS.get(argument);
		if (booleanKey) {
			setSingleton(inputs, booleanKey, true, argument);
			continue;
		}
		throw new DaemonConfigurationError(
			argument.startsWith("-")
				? `Unknown or incompatible option in daemon mode: ${argument}`
				: `Daemon mode does not accept positional arguments: ${argument}`,
		);
	}
	return inputs;
}

function parseOrigin(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new DaemonConfigurationError(`Invalid daemon Origin: ${value}`);
	}
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username !== "" ||
		url.password !== "" ||
		url.pathname !== "/" ||
		url.search !== "" ||
		url.hash !== "" ||
		value !== url.origin
	) {
		throw new DaemonConfigurationError(
			`Daemon origins must be exact HTTP(S) origins without paths or wildcards: ${value}`,
		);
	}
	return url.origin;
}

function parseEnvironmentNames(values: readonly string[]): string[] {
	const names = values
		.flatMap((value) => value.split(","))
		.map((value) => value.trim())
		.filter(Boolean);
	const seen = new Set<string>();
	for (const name of names) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
			throw new DaemonConfigurationError(`Invalid daemon environment name: ${name}`);
		const identity = process.platform === "win32" ? name.toLowerCase() : name;
		if (seen.has(identity)) throw new DaemonConfigurationError(`Duplicate daemon environment name: ${name}`);
		seen.add(identity);
	}
	return names;
}

async function resolveConfinedRoot(value: string, startupCwd: string, label: string): Promise<string> {
	const candidate = isAbsolute(value) ? value : resolve(startupCwd, value);
	let canonical: string;
	try {
		canonical = await realpath(candidate);
		if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
	} catch (error) {
		throw new DaemonConfigurationError(
			`Daemon ${label} must be an existing directory: ${candidate} (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	return canonical;
}

async function readTlsFile(path: string, label: string, startupCwd: string): Promise<Buffer> {
	const resolvedPath = isAbsolute(path) ? path : resolve(startupCwd, path);
	try {
		const content = await readFile(resolvedPath);
		if (content.byteLength === 0) throw new Error("file is empty");
		return content;
	} catch (error) {
		throw new DaemonConfigurationError(
			`Unable to read daemon TLS ${label} file ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function validateToken(token: string | undefined): string | undefined {
	if (token === undefined) return undefined;
	const bytes = Buffer.byteLength(token, "utf8");
	if (bytes < 32 || bytes > 1024 || !/\S/u.test(token) || /[\r\n]/u.test(token)) {
		throw new DaemonConfigurationError(
			"PI_DAEMON_TOKEN must contain 32 to 1024 UTF-8 bytes, include a non-whitespace character, and contain no line breaks",
		);
	}
	return token;
}

function isRootProcess(): boolean {
	return process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0;
}

export function isDaemonCommand(args: readonly string[]): boolean {
	return args[0] === "--daemon";
}
interface DaemonEndpointConfiguration {
	host: string;
	port: number;
}

interface DaemonWorkspaceRootsConfiguration {
	allowRoot: boolean;
	workspaceRoot: string;
	temporaryRoot: string | undefined;
}

interface DaemonTransportSecurityConfiguration {
	token: string | undefined;
	allowedOrigins: string[];
	tls: DaemonTlsConfiguration | undefined;
}

interface DaemonCapacityConfiguration {
	maxGlobalRequests: number;
	maxGlobalTransfers: number;
	maxBufferedOutputBytes: number;
	protocolLimits: RemoteWorkspaceProtocolLimits;
}

function resolveDaemonEndpoint(
	inputs: ParsedDaemonInputs,
	environment: NodeJS.ProcessEnv,
): DaemonEndpointConfiguration {
	const host = inputs.host ?? environment.PI_DAEMON_HOST ?? "127.0.0.1";
	if (host.length === 0 || /\s/u.test(host)) {
		throw new DaemonConfigurationError("Daemon host must be a non-empty IP address");
	}
	const port = parseInteger(inputs.port ?? environment.PI_DAEMON_PORT, "PI_DAEMON_PORT/--daemon-port", 1, 65535, 8787);
	return { host, port };
}

async function resolveDaemonWorkspaceRoots(
	inputs: ParsedDaemonInputs,
	environment: NodeJS.ProcessEnv,
	startupCwd: string,
): Promise<DaemonWorkspaceRootsConfiguration> {
	const allowRoot = inputs.allowRoot ?? parseBoolean(environment.PI_DAEMON_ALLOW_ROOT, "PI_DAEMON_ALLOW_ROOT");
	if (isRootProcess() && !allowRoot) {
		throw new DaemonConfigurationError(
			"Refusing to run the workspace daemon as root; use --daemon-allow-root only inside an intentional OS sandbox",
		);
	}
	const workspaceRoot = await resolveConfinedRoot(
		inputs.cwd ?? environment.PI_DAEMON_CWD ?? startupCwd,
		startupCwd,
		"workspace root",
	);
	const temporaryRoot = environment.PI_DAEMON_TEMP_ROOT
		? await resolveConfinedRoot(environment.PI_DAEMON_TEMP_ROOT, startupCwd, "temporary root")
		: undefined;
	return { allowRoot, workspaceRoot, temporaryRoot };
}

async function resolveDaemonTransportSecurity(
	inputs: ParsedDaemonInputs,
	environment: NodeJS.ProcessEnv,
	startupCwd: string,
): Promise<DaemonTransportSecurityConfiguration> {
	const token = validateToken(environment.PI_DAEMON_TOKEN);
	const allowedOrigins = [
		...(environment.PI_DAEMON_ORIGINS?.split(",")
			.map((value) => value.trim())
			.filter(Boolean) ?? []),
		...inputs.origins,
	].map(parseOrigin);
	if (new Set(allowedOrigins).size !== allowedOrigins.length) {
		throw new DaemonConfigurationError("Daemon origins must be unique");
	}
	const tlsCertPath = inputs.tlsCertPath ?? environment.PI_DAEMON_TLS_CERT;
	const tlsKeyPath = inputs.tlsKeyPath ?? environment.PI_DAEMON_TLS_KEY;
	if ((tlsCertPath === undefined) !== (tlsKeyPath === undefined)) {
		throw new DaemonConfigurationError("Daemon TLS requires both a certificate and private key");
	}
	const tls =
		tlsCertPath && tlsKeyPath
			? Object.freeze({
					cert: await readTlsFile(tlsCertPath, "certificate", startupCwd),
					key: await readTlsFile(tlsKeyPath, "private key", startupCwd),
					passphrase: environment.PI_DAEMON_TLS_PASSPHRASE,
				})
			: undefined;
	return { token, allowedOrigins, tls };
}

function resolveDaemonCapacity(environment: NodeJS.ProcessEnv): DaemonCapacityConfiguration {
	const maxConnectionRequests = parseInteger(
		environment.PI_DAEMON_MAX_CONNECTION_REQUESTS,
		"PI_DAEMON_MAX_CONNECTION_REQUESTS",
		1,
		10_000_000,
		DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS.maxActiveRequests,
	);
	const maxGlobalRequests = parseInteger(
		environment.PI_DAEMON_MAX_GLOBAL_REQUESTS,
		"PI_DAEMON_MAX_GLOBAL_REQUESTS",
		1,
		10_000_000,
		maxConnectionRequests,
	);
	if (maxGlobalRequests < maxConnectionRequests) {
		throw new DaemonConfigurationError(
			"PI_DAEMON_MAX_GLOBAL_REQUESTS must be at least PI_DAEMON_MAX_CONNECTION_REQUESTS",
		);
	}
	const maxConnectionTransfers = parseInteger(
		environment.PI_DAEMON_MAX_CONNECTION_UPLOADS,
		"PI_DAEMON_MAX_CONNECTION_UPLOADS",
		1,
		10_000,
		DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS.maxActiveTransfers,
	);
	const maxGlobalTransfers = parseInteger(
		environment.PI_DAEMON_MAX_GLOBAL_UPLOADS,
		"PI_DAEMON_MAX_GLOBAL_UPLOADS",
		1,
		10_000,
		maxConnectionTransfers,
	);
	if (maxGlobalTransfers < maxConnectionTransfers) {
		throw new DaemonConfigurationError(
			"PI_DAEMON_MAX_GLOBAL_UPLOADS must be at least PI_DAEMON_MAX_CONNECTION_UPLOADS",
		);
	}
	const maxMessageBytes = parseInteger(
		environment.PI_DAEMON_MAX_FRAME_BYTES,
		"PI_DAEMON_MAX_FRAME_BYTES",
		1024,
		64 * 1024 * 1024,
		DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS.maxMessageBytes,
	);
	const maxTransferBytes = parseInteger(
		environment.PI_DAEMON_MAX_UPLOAD_BYTES,
		"PI_DAEMON_MAX_UPLOAD_BYTES",
		1,
		Number.MAX_SAFE_INTEGER,
		DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS.maxTransferBytes,
	);
	const maxBufferedOutputBytes = parseInteger(
		environment.PI_DAEMON_MAX_BUFFERED_OUTPUT_BYTES,
		"PI_DAEMON_MAX_BUFFERED_OUTPUT_BYTES",
		1024,
		64 * 1024 * 1024,
		8 * 1024 * 1024,
	);
	const protocolLimits = validateRemoteWorkspaceProtocolLimits({
		...DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
		maxMessageBytes,
		maxStringBytes: Math.min(DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS.maxStringBytes, maxMessageBytes),
		maxPendingInboundBytes: Math.max(
			DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS.maxPendingInboundBytes,
			maxMessageBytes,
		),
		maxTransferBytes,
		maxActiveRequests: maxConnectionRequests,
		maxActiveTransfers: Math.min(maxConnectionTransfers, maxGlobalTransfers),
	});
	return { maxGlobalRequests, maxGlobalTransfers, maxBufferedOutputBytes, protocolLimits };
}

export async function parseDaemonCommand(
	args: readonly string[],
	environment: NodeJS.ProcessEnv = process.env,
	startupCwd = process.cwd(),
): Promise<DaemonCommand> {
	const inputs = parseInputs(args);
	if (inputs.help) return { help: true };

	const { host, port } = resolveDaemonEndpoint(inputs, environment);
	const { allowRoot, workspaceRoot, temporaryRoot } = await resolveDaemonWorkspaceRoots(
		inputs,
		environment,
		startupCwd,
	);
	const { token, allowedOrigins, tls } = await resolveDaemonTransportSecurity(inputs, environment, startupCwd);
	const { maxGlobalRequests, maxGlobalTransfers, maxBufferedOutputBytes, protocolLimits } =
		resolveDaemonCapacity(environment);

	const allowInsecureTransport =
		inputs.allowInsecureTransport ??
		parseBoolean(environment.PI_DAEMON_ALLOW_INSECURE_TRANSPORT, "PI_DAEMON_ALLOW_INSECURE_TRANSPORT");
	const allowProcessExec =
		inputs.allowProcessExec ?? parseBoolean(environment.PI_DAEMON_ALLOW_PROCESS_EXEC, "PI_DAEMON_ALLOW_PROCESS_EXEC");
	const trustProjectLsp =
		inputs.trustProjectLsp ?? parseBoolean(environment.PI_DAEMON_TRUST_PROJECT_LSP, "PI_DAEMON_TRUST_PROJECT_LSP");
	const forwardedEnvironment = parseEnvironmentNames([
		...(environment.PI_DAEMON_ENV?.split(",") ?? []),
		...inputs.forwardedEnvironment,
	]);
	const maxConnections = parseInteger(
		inputs.maxConnections ?? environment.PI_DAEMON_MAX_CONNECTIONS,
		"PI_DAEMON_MAX_CONNECTIONS/--daemon-max-connections",
		1,
		100_000,
		64,
	);
	const maxPendingConnections = parseInteger(
		inputs.maxPendingConnections ?? environment.PI_DAEMON_MAX_PENDING_CONNECTIONS,
		"PI_DAEMON_MAX_PENDING_CONNECTIONS/--daemon-max-pending-connections",
		1,
		100_000,
		64,
	);
	const handshakeTimeoutMs = parseInteger(
		inputs.handshakeTimeoutMs ?? environment.PI_DAEMON_HANDSHAKE_TIMEOUT_MS,
		"PI_DAEMON_HANDSHAKE_TIMEOUT_MS/--daemon-handshake-timeout-ms",
		100,
		5 * 60_000,
		10_000,
	);
	const shutdownTimeoutMs = parseInteger(
		inputs.shutdownTimeoutMs ?? environment.PI_DAEMON_SHUTDOWN_TIMEOUT_MS,
		"PI_DAEMON_SHUTDOWN_TIMEOUT_MS/--daemon-shutdown-timeout-ms",
		100,
		5 * 60_000,
		10_000,
	);

	return {
		help: false,
		configuration: Object.freeze({
			host,
			port,
			workspaceRoot,
			temporaryRoot,
			token,
			allowedOrigins: Object.freeze(allowedOrigins),
			tls,
			allowInsecureTransport,
			allowProcessExec,
			allowRoot,
			forwardedEnvironment: Object.freeze(forwardedEnvironment),
			lspConfigPath:
				inputs.lspConfigPath || environment.PI_DAEMON_LSP_CONFIG
					? resolve(startupCwd, inputs.lspConfigPath ?? environment.PI_DAEMON_LSP_CONFIG!)
					: undefined,
			trustProjectLsp,
			sandboxInstructionsPath: environment.PI_DAEMON_SANDBOX_INSTRUCTIONS
				? resolve(startupCwd, environment.PI_DAEMON_SANDBOX_INSTRUCTIONS)
				: undefined,
			maxConnections,
			maxGlobalRequests,
			maxGlobalTransfers,
			maxBufferedOutputBytes,
			maxPendingConnections,
			handshakeTimeoutMs,
			shutdownTimeoutMs,
			protocolLimits: Object.freeze({ ...protocolLimits }),
		}),
	};
}
