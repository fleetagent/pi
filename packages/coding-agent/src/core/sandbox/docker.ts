import { createHash, randomBytes } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { VERSION } from "../../config.ts";
import { spawnProcess } from "../../utils/child-process.ts";
import type { SandboxSettings, SettingsManager } from "../settings-manager.ts";

export const DEFAULT_SANDBOX_IMAGE = "ghcr.io/fleetagent/pi-sandbox:latest";
export const DEFAULT_SANDBOX_WORKSPACE_MOUNT = "/workspace";
export const DEFAULT_SANDBOX_DAEMON_PORT = 8787;
export const DEFAULT_SANDBOX_DOCKER_BINARY = "docker";
export const SANDBOX_LABEL_PREFIX = "ai.fleetagent.pi";
export const SANDBOX_LABEL_ENABLED = `${SANDBOX_LABEL_PREFIX}.sandbox`;
export const SANDBOX_LABEL_WORKSPACE_HASH = `${SANDBOX_LABEL_PREFIX}.workspace-hash`;
export const SANDBOX_LABEL_WORKSPACE_MOUNT = `${SANDBOX_LABEL_PREFIX}.workspace-mount`;
export const SANDBOX_LABEL_DAEMON_PORT = `${SANDBOX_LABEL_PREFIX}.daemon-port`;
export const SANDBOX_LABEL_OWNER_UID = `${SANDBOX_LABEL_PREFIX}.owner-uid`;
export const SANDBOX_LABEL_VERSION = `${SANDBOX_LABEL_PREFIX}.version`;
export const SANDBOX_LABEL_SESSION = `${SANDBOX_LABEL_PREFIX}.session`;

const reservedSandboxDaemonPorts = new Set<number>();
const sandboxPortLockPath = join(tmpdir(), `fleetagent-pi-sandbox-port-${process.getuid?.() ?? "user"}.lock`);
let sandboxStartQueue: Promise<void> = Promise.resolve();

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}
async function isSandboxPortLockStale(): Promise<boolean> {
	try {
		const owner = JSON.parse(await readFile(sandboxPortLockPath, "utf8")) as { pid?: unknown };
		return typeof owner.pid === "number" && !isProcessAlive(owner.pid);
	} catch {
		try {
			return Date.now() - (await stat(sandboxPortLockPath)).mtimeMs > 10_000;
		} catch {
			return false;
		}
	}
}

async function acquireSandboxPortLock(): Promise<() => Promise<void>> {
	const token = `${process.pid}:${randomBytes(16).toString("hex")}`;
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			const handle = await open(sandboxPortLockPath, "wx", 0o600);
			await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
			return async () => {
				await handle.close();
				try {
					const current = JSON.parse(await readFile(sandboxPortLockPath, "utf8")) as { token?: unknown };
					if (current.token === token) await unlink(sandboxPortLockPath);
				} catch {}
			};
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
			const stale = await isSandboxPortLockStale();
			if (stale) {
				await unlink(sandboxPortLockPath).catch(() => undefined);
				continue;
			}
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
		}
	}
	throw new Error("Timed out waiting for the sandbox daemon port allocation lock");
}

async function withSandboxStartLock<T>(operation: () => Promise<T>): Promise<T> {
	const previous = sandboxStartQueue;
	let release!: () => void;
	sandboxStartQueue = new Promise<void>((resolveQueue) => {
		release = resolveQueue;
	});
	await previous;
	let releaseFileLock: (() => Promise<void>) | undefined;
	try {
		releaseFileLock = await acquireSandboxPortLock();
		return await operation();
	} finally {
		try {
			await releaseFileLock?.();
		} finally {
			release();
		}
	}
}

export type SandboxCleanupBehavior = "stop" | "remove";

export interface SandboxConfig {
	image: string;
	dockerBinary: string;
	workspaceMountPath: string;
	containerNamePrefix: string;
	daemonPort: number;
	daemonHostBind: string;
	cleanup: SandboxCleanupBehavior;
	ownerUid: string | undefined;
}

export type SandboxConfigOverrides = SandboxSettings;

export interface SandboxEnvironment {
	PI_SANDBOX_IMAGE?: string;
	PI_SANDBOX_DOCKER?: string;
	PI_SANDBOX_WORKSPACE_MOUNT?: string;
	PI_SANDBOX_CONTAINER_PREFIX?: string;
	PI_SANDBOX_DAEMON_PORT?: string;
	PI_SANDBOX_DAEMON_HOST_BIND?: string;
	PI_SANDBOX_CLEANUP?: string;
}

export interface SandboxStartOptions extends SandboxConfigOverrides {
	workspaceRoot: string;
	sessionId?: string;
}

export interface SandboxListOptions {
	workspaceRoot: string;
	allWorkspaces?: boolean;
}

export interface SandboxStopOptions {
	workspaceRoot: string;
	target?: string;
	currentContainerId?: string;
}

export interface DockerRunInvocation {
	command: string;
	args: string[];
	env: Record<string, string>;
	token: string;
	containerName: string;
	labels: Record<string, string>;
	workspaceRoot: string;
	workspaceHash: string;
}

export interface SandboxContainer {
	id: string;
	name: string;
	image: string;
	status: string;
	state: string | undefined;
	createdAt: string | undefined;
	workspaceRoot: string | undefined;
	workspaceMountPath: string | undefined;
	daemonPort: number | undefined;
	daemonEndpoint: string | undefined;
	labels: Record<string, string>;
}

export interface SandboxStartResult {
	containerId: string;
	containerName: string;
	workspaceRoot: string;
	workspaceMountPath: string;
	daemonUrl: string;
	daemonUrlRedacted: string;
	token: string;
	labels: Record<string, string>;
}

export type SandboxStopResult =
	| { status: "stopped"; container: SandboxContainer }
	| { status: "removed"; container: SandboxContainer }
	| { status: "already-stopped"; container: SandboxContainer }
	| { status: "not-found"; message: string };

export interface DockerCommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export interface DockerCommandOptions {
	env?: Record<string, string>;
}

export interface DockerRunner {
	run(command: string, args: string[], options?: DockerCommandOptions): Promise<DockerCommandResult>;
}
export interface ManagedSandboxContainer {
	workspaceRoot: string;
	daemonPort: number;
	ownerId?: string;
}

export interface DockerSandboxServiceOptions {
	settingsManager?: Pick<SettingsManager, "getSandboxSettings">;
	env?: SandboxEnvironment;
	runner?: DockerRunner;
	tokenGenerator?: () => string;
	portAllocator?: (host: string, preferredPort: number) => Promise<number>;
	readinessWaiter?: (host: string, port: number) => Promise<void>;
	managedContainers?: Map<string, ManagedSandboxContainer>;
}

interface DockerPsRecord {
	ID?: string;
	Names?: string;
	Image?: string;
	Status?: string;
	State?: string;
	CreatedAt?: string;
	Labels?: string;
	Ports?: string;
}

interface DockerInspectMount {
	Type?: string;
	Source?: string;
	Destination?: string;
}

interface DockerInspectPortBinding {
	HostIp?: string;
	HostPort?: string;
}

interface DockerInspectConfig {
	Image?: string;
	Labels?: Record<string, string>;
}

interface DockerInspectState {
	Status?: string;
	Running?: boolean;
	StartedAt?: string;
}

interface DockerInspectNetworkSettings {
	Ports?: Record<string, DockerInspectPortBinding[] | null>;
}

interface DockerInspectRecord {
	Id?: string;
	Name?: string;
	Config?: DockerInspectConfig;
	State?: DockerInspectState;
	Created?: string;
	Mounts?: DockerInspectMount[];
	NetworkSettings?: DockerInspectNetworkSettings;
}

class ProcessDockerRunner implements DockerRunner {
	run(command: string, args: string[], options: DockerCommandOptions = {}): Promise<DockerCommandResult> {
		return new Promise((resolveCommand, reject) => {
			const child = spawnProcess(command, args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, ...options.env },
			});
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8");
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});
			child.once("error", reject);
			child.once("close", (exitCode) => resolveCommand({ exitCode, stdout, stderr }));
		});
	}
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function parsePositiveInteger(value: string | number | undefined, settingName: string): number | undefined {
	if (value === undefined) return undefined;
	const text = String(value).trim();
	if (!/^\d+$/.test(text)) throw new Error(`Invalid ${settingName}: expected a decimal integer`);
	const parsed = Number(text);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
		throw new Error(`Invalid ${settingName}: expected a port from 1 to 65535`);
	}
	return parsed;
}

function parseCleanup(value: string | undefined, settingName: string): SandboxCleanupBehavior | undefined {
	if (value === undefined) return undefined;
	if (value === "stop" || value === "remove") return value;
	throw new Error(`Invalid ${settingName}: expected stop or remove`);
}

function parseLabels(text: string | undefined): Record<string, string> {
	const labels: Record<string, string> = {};
	if (!text) return labels;
	for (const entry of text.split(",")) {
		const separator = entry.indexOf("=");
		if (separator === -1) continue;
		labels[entry.slice(0, separator)] = entry.slice(separator + 1);
	}
	return labels;
}

function sanitizeNameSegment(value: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9_.-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "workspace";
}

function getWorkspaceHash(workspaceRoot: string): string {
	return createHash("sha256").update(resolve(workspaceRoot)).digest("hex").slice(0, 16);
}

function getOwnerUid(): string | undefined {
	const uid = process.getuid?.();
	return uid === undefined ? undefined : String(uid);
}

function generateToken(): string {
	return randomBytes(32).toString("base64url");
}

async function tryReservePort(host: string, port: number): Promise<number | undefined> {
	return new Promise((resolvePort) => {
		const server = createServer();
		server.unref();
		server.once("error", () => resolvePort(undefined));
		server.listen({ host, port, exclusive: true }, () => {
			const address = server.address();
			const selectedPort = typeof address === "object" && address ? address.port : undefined;
			server.close(() => resolvePort(selectedPort));
		});
	});
}

export async function allocateSandboxDaemonPort(host: string, preferredPort: number): Promise<number> {
	const preferred = await tryReservePort(host, preferredPort);
	if (preferred !== undefined) return preferred;
	const fallback = await tryReservePort(host, 0);
	if (fallback === undefined) throw new Error(`Unable to allocate a sandbox daemon port on ${host}`);
	return fallback;
}

async function canConnect(host: string, port: number): Promise<boolean> {
	return new Promise((resolveConnection) => {
		const socket = createConnection({ host, port });
		let settled = false;
		const finish = (connected: boolean): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolveConnection(connected);
		};
		socket.setTimeout(250, () => finish(false));
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

async function waitForSandboxDaemonPort(host: string, port: number): Promise<void> {
	const connectHost = host === "0.0.0.0" ? "127.0.0.1" : host;
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (await canConnect(connectHost, port)) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	}
	throw new Error(`Sandbox daemon did not bind ${connectHost}:${port} within 15 seconds`);
}

function ensureSuccessful(result: DockerCommandResult, args: string[]): void {
	if (result.exitCode === 0) return;
	const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode ?? "unknown"}`;
	throw new Error(redactSecrets(`Docker command failed: docker ${args.join(" ")}: ${detail}`));
}

function parseJsonLines<T>(text: string): T[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as T);
}

function parseJsonArray<T>(text: string): T[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	const parsed = JSON.parse(trimmed) as unknown;
	return Array.isArray(parsed) ? (parsed as T[]) : [parsed as T];
}

function getEndpointFromPorts(
	ports: Record<string, DockerInspectPortBinding[] | null> | undefined,
	daemonPort: number,
): string | undefined {
	const bindings = ports?.[`${daemonPort}/tcp`];
	const binding = bindings?.[0];
	if (!binding?.HostPort) return undefined;
	const host = daemonConnectionHost(binding.HostIp || "127.0.0.1");
	return `ws://${urlHost(host)}:${binding.HostPort}/pi/workspace`;
}

export function redactSecrets(value: string): string {
	return value
		.replace(/(PI_DAEMON_TOKEN=)[^\s,;]+/g, "$1[REDACTED]")
		.replace(/(Authorization:\s*Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
		.replace(/([?&]token=)[^\s&]+/gi, "$1[REDACTED]");
}

export function resolveSandboxConfig(
	settings: SandboxSettings | undefined,
	env: SandboxEnvironment = {},
	overrides: SandboxConfigOverrides = {},
): SandboxConfig {
	const image =
		nonEmpty(overrides.image) ?? nonEmpty(env.PI_SANDBOX_IMAGE) ?? nonEmpty(settings?.image) ?? DEFAULT_SANDBOX_IMAGE;
	const dockerBinary =
		nonEmpty(overrides.dockerBinary) ??
		nonEmpty(env.PI_SANDBOX_DOCKER) ??
		nonEmpty(settings?.dockerBinary) ??
		DEFAULT_SANDBOX_DOCKER_BINARY;
	const workspaceMountPath =
		nonEmpty(overrides.workspaceMountPath) ??
		nonEmpty(env.PI_SANDBOX_WORKSPACE_MOUNT) ??
		nonEmpty(settings?.workspaceMountPath) ??
		DEFAULT_SANDBOX_WORKSPACE_MOUNT;
	const containerNamePrefix =
		nonEmpty(overrides.containerNamePrefix) ??
		nonEmpty(env.PI_SANDBOX_CONTAINER_PREFIX) ??
		nonEmpty(settings?.containerNamePrefix) ??
		"pi-sandbox";
	const daemonPort =
		overrides.daemonPort ??
		parsePositiveInteger(env.PI_SANDBOX_DAEMON_PORT, "PI_SANDBOX_DAEMON_PORT") ??
		parsePositiveInteger(settings?.daemonPort, "sandbox.daemonPort") ??
		DEFAULT_SANDBOX_DAEMON_PORT;
	const daemonHostBind =
		nonEmpty(overrides.daemonHostBind) ??
		nonEmpty(env.PI_SANDBOX_DAEMON_HOST_BIND) ??
		nonEmpty(settings?.daemonHostBind) ??
		"127.0.0.1";
	const cleanup =
		overrides.cleanup ??
		parseCleanup(env.PI_SANDBOX_CLEANUP, "PI_SANDBOX_CLEANUP") ??
		parseCleanup(settings?.cleanup, "sandbox.cleanup") ??
		"stop";
	return {
		image,
		dockerBinary,
		workspaceMountPath,
		containerNamePrefix,
		daemonPort,
		daemonHostBind,
		cleanup,
		ownerUid: getOwnerUid(),
	};
}

function dockerPublishHost(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function daemonConnectionHost(host: string): string {
	if (host === "0.0.0.0") return "127.0.0.1";
	if (host === "::") return "::1";
	return host;
}

function urlHost(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function createSandboxLabels(
	config: SandboxConfig,
	workspaceRoot: string,
	sessionId: string,
): Record<string, string> {
	const labels: Record<string, string> = {
		[SANDBOX_LABEL_ENABLED]: "true",
		[SANDBOX_LABEL_WORKSPACE_HASH]: getWorkspaceHash(workspaceRoot),
		[SANDBOX_LABEL_WORKSPACE_MOUNT]: config.workspaceMountPath,
		[SANDBOX_LABEL_DAEMON_PORT]: String(config.daemonPort),
		[SANDBOX_LABEL_VERSION]: VERSION,
		[SANDBOX_LABEL_SESSION]: sessionId,
	};
	if (config.ownerUid) labels[SANDBOX_LABEL_OWNER_UID] = config.ownerUid;
	return labels;
}

export function createSandboxContainerName(
	config: SandboxConfig,
	workspaceRoot: string,
	sessionId: string,
	instanceId?: string,
): string {
	const base = `${sanitizeNameSegment(config.containerNamePrefix)}-${sanitizeNameSegment(basename(resolve(workspaceRoot)))}-${getWorkspaceHash(workspaceRoot)}-${sanitizeNameSegment(sessionId).slice(0, 16)}`;
	return instanceId ? `${base}-${sanitizeNameSegment(instanceId).slice(0, 8)}` : base;
}

export function buildDockerRunInvocation(
	config: SandboxConfig,
	options: SandboxStartOptions,
	token: string = generateToken(),
): DockerRunInvocation {
	const workspaceRoot = resolve(options.workspaceRoot);
	const sessionId = options.sessionId ?? randomBytes(8).toString("hex");
	const labels = createSandboxLabels(config, workspaceRoot, sessionId);
	const containerName = createSandboxContainerName(
		config,
		workspaceRoot,
		sessionId,
		createHash("sha256").update(token).digest("hex"),
	);
	const args = [
		"run",
		"--detach",
		"--network",
		"bridge",
		"--publish",
		`${dockerPublishHost(config.daemonHostBind)}:${config.daemonPort}:${config.daemonPort}`,
		"--name",
		containerName,
		"--workdir",
		config.workspaceMountPath,
		"--mount",
		`type=bind,source=${workspaceRoot},target=${config.workspaceMountPath}`,
		"--env",
		"PI_DAEMON_TOKEN",
	];
	for (const [key, value] of Object.entries(labels)) args.push("--label", `${key}=${value}`);
	args.push(
		config.image,
		"pi",
		"--daemon",
		"--daemon-host",
		"0.0.0.0",
		"--daemon-allow-insecure-transport",
		"--daemon-port",
		String(config.daemonPort),
		"--daemon-cwd",
		config.workspaceMountPath,
		"--daemon-allow-root",
		"--daemon-allow-process-exec",
	);
	return {
		command: config.dockerBinary,
		args,
		env: { PI_DAEMON_TOKEN: token },
		token,
		containerName,
		labels,
		workspaceRoot,
		workspaceHash: labels[SANDBOX_LABEL_WORKSPACE_HASH],
	};
}

export class DockerSandboxService {
	private readonly settingsManager: Pick<SettingsManager, "getSandboxSettings"> | undefined;
	private readonly env: SandboxEnvironment;
	private readonly runner: DockerRunner;
	private readonly tokenGenerator: () => string;
	private readonly portAllocator: (host: string, preferredPort: number) => Promise<number>;
	private readonly readinessWaiter: (host: string, port: number) => Promise<void>;
	private readonly managedContainers: Map<string, ManagedSandboxContainer>;

	constructor(options: DockerSandboxServiceOptions = {}) {
		this.settingsManager = options.settingsManager;
		this.env = options.env ?? process.env;
		this.runner = options.runner ?? new ProcessDockerRunner();
		this.tokenGenerator = options.tokenGenerator ?? generateToken;
		this.portAllocator = options.portAllocator ?? allocateSandboxDaemonPort;
		this.readinessWaiter = options.readinessWaiter ?? waitForSandboxDaemonPort;
		this.managedContainers = options.managedContainers ?? new Map();
	}

	resolveConfig(overrides: SandboxConfigOverrides = {}): SandboxConfig {
		return resolveSandboxConfig(this.settingsManager?.getSandboxSettings(), this.env, overrides);
	}

	buildStartInvocation(options: SandboxStartOptions): DockerRunInvocation {
		return buildDockerRunInvocation(this.resolveConfig(options), options, this.tokenGenerator());
	}

	async checkDockerAvailable(config: SandboxConfig = this.resolveConfig()): Promise<void> {
		const args = ["version", "--format", "{{.Server.Version}}"];
		try {
			ensureSuccessful(await this.runner.run(config.dockerBinary, args), args);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				redactSecrets(`Docker is unavailable or not reachable via ${config.dockerBinary}: ${message}`),
			);
		}
	}

	private async reserveDaemonPort(config: SandboxConfig): Promise<number> {
		for (let attempt = 0; attempt < 16; attempt++) {
			const preferredPort = reservedSandboxDaemonPorts.has(config.daemonPort) ? 0 : config.daemonPort;
			const candidate = await this.portAllocator(config.daemonHostBind, preferredPort);
			if (!reservedSandboxDaemonPorts.has(candidate)) return candidate;
		}
		throw new Error("Unable to reserve a unique sandbox daemon port");
	}

	private async waitForStartedSandbox(config: SandboxConfig, containerId: string): Promise<void> {
		try {
			await this.readinessWaiter(config.daemonHostBind, config.daemonPort);
		} catch (error) {
			const cleanupArgs = ["rm", "--force", containerId];
			const cleanupResult = await this.runner.run(config.dockerBinary, cleanupArgs);
			if (cleanupResult.exitCode !== 0) {
				const cleanupError = new Error(
					cleanupResult.stderr.trim() || cleanupResult.stdout.trim() || "Failed to remove unready sandbox",
				);
				throw new AggregateError([error, cleanupError], "Sandbox readiness and cleanup both failed");
			}
			this.managedContainers.delete(containerId);
			throw error;
		}
	}

	private async startWithReservedPort(options: SandboxStartOptions, daemonPort: number): Promise<SandboxStartResult> {
		const effectiveOptions = { ...options, daemonPort };
		const config = this.resolveConfig(effectiveOptions);
		const invocation = buildDockerRunInvocation(config, effectiveOptions, this.tokenGenerator());
		await this.checkDockerAvailable(config);
		const runResult = await this.runner.run(invocation.command, invocation.args, { env: invocation.env });
		ensureSuccessful(runResult, invocation.args);
		const containerId = runResult.stdout.trim();
		this.managedContainers.set(containerId, {
			workspaceRoot: invocation.workspaceRoot,
			daemonPort: config.daemonPort,
			ownerId: options.sessionId,
		});
		await this.waitForStartedSandbox(config, containerId);
		const daemonHost = daemonConnectionHost(config.daemonHostBind);
		const daemonUrl = `ws://${urlHost(daemonHost)}:${config.daemonPort}/pi/workspace`;
		return {
			containerId,
			containerName: invocation.containerName,
			workspaceRoot: invocation.workspaceRoot,
			workspaceMountPath: config.workspaceMountPath,
			daemonUrl,
			daemonUrlRedacted: redactSecrets(daemonUrl),
			token: invocation.token,
			labels: invocation.labels,
		};
	}

	private async startLocked(options: SandboxStartOptions): Promise<SandboxStartResult> {
		const configured = this.resolveConfig(options);
		const daemonPort = await this.reserveDaemonPort(configured);
		reservedSandboxDaemonPorts.add(daemonPort);
		try {
			return await this.startWithReservedPort(options, daemonPort);
		} catch (error) {
			if (![...this.managedContainers.values()].some((container) => container.daemonPort === daemonPort)) {
				reservedSandboxDaemonPorts.delete(daemonPort);
			}
			throw error;
		}
	}

	async start(options: SandboxStartOptions): Promise<SandboxStartResult> {
		return withSandboxStartLock(() => this.startLocked(options));
	}

	async list(options: SandboxListOptions): Promise<SandboxContainer[]> {
		const config = this.resolveConfig();
		const args = [
			"container",
			"ls",
			"--all",
			"--filter",
			`label=${SANDBOX_LABEL_ENABLED}=true`,
			...(config.ownerUid ? ["--filter", `label=${SANDBOX_LABEL_OWNER_UID}=${config.ownerUid}`] : []),
		];
		if (!options.allWorkspaces) {
			args.push("--filter", `label=${SANDBOX_LABEL_WORKSPACE_HASH}=${getWorkspaceHash(options.workspaceRoot)}`);
		}
		args.push("--format", "{{json .}}");
		const result = await this.runner.run(config.dockerBinary, args);
		ensureSuccessful(result, args);
		const rows = parseJsonLines<DockerPsRecord>(result.stdout);
		return rows.filter((row) => row.ID || row.Names).map((row) => this.containerFromPsRecord(row));
	}
	private forgetManagedContainer(reference: string, workspaceRoot: string): void {
		const canonicalWorkspaceRoot = resolve(workspaceRoot);
		for (const [containerId, container] of this.managedContainers) {
			if (container.workspaceRoot === canonicalWorkspaceRoot && containerIdsMatch(containerId, reference)) {
				this.managedContainers.delete(containerId);
				reservedSandboxDaemonPorts.delete(container.daemonPort);
			}
		}
	}

	private forgetStoppedContainer(container: SandboxContainer, workspaceRoot: string): void {
		this.forgetManagedContainer(container.id, workspaceRoot);
		if (container.daemonPort !== undefined) reservedSandboxDaemonPorts.delete(container.daemonPort);
	}

	async stop(options: SandboxStopOptions): Promise<SandboxStopResult> {
		const containers = await this.list({ workspaceRoot: options.workspaceRoot });
		const selected = selectStopTarget(containers, options.target, options.currentContainerId);
		if (!selected) {
			const requestedId = options.currentContainerId ?? options.target;
			if (requestedId) this.forgetManagedContainer(requestedId, options.workspaceRoot);
			return { status: "not-found", message: "No matching Pi sandbox container found" };
		}
		const config = this.resolveConfig();
		if (selected.state && selected.state !== "running" && config.cleanup === "stop") {
			this.forgetStoppedContainer(selected, options.workspaceRoot);
			return { status: "already-stopped", container: selected };
		}
		const args = [
			config.cleanup === "remove" ? "rm" : "stop",
			...(config.cleanup === "remove" ? ["--force"] : []),
			selected.id,
		];
		const result = await this.runner.run(config.dockerBinary, args);
		if (result.exitCode !== 0) {
			const output = `${result.stderr}\n${result.stdout}`;
			if (/No such container|not found/i.test(output)) {
				this.forgetStoppedContainer(selected, options.workspaceRoot);
				return { status: "not-found", message: "Sandbox container no longer exists" };
			}
			ensureSuccessful(result, args);
		}
		this.forgetStoppedContainer(selected, options.workspaceRoot);
		return { status: config.cleanup === "remove" ? "removed" : "stopped", container: selected };
	}

	async stopManagedContainers(): Promise<void> {
		await withSandboxStartLock(async () => {
			const failures: unknown[] = [];
			for (const [containerId, container] of [...this.managedContainers]) {
				try {
					await this.stop({
						workspaceRoot: container.workspaceRoot,
						target: containerId,
						currentContainerId: containerId,
					});
					this.managedContainers.delete(containerId);
					reservedSandboxDaemonPorts.delete(container.daemonPort);
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length > 0) throw new AggregateError(failures, "Failed to stop managed sandbox containers");
		});
	}

	private containerFromPsRecord(row: DockerPsRecord): SandboxContainer {
		const labels = parseLabels(row.Labels);
		const daemonPort = parsePositiveInteger(
			labels[`${SANDBOX_LABEL_PREFIX}.daemon-port`] ?? undefined,
			"daemon port",
		);
		return {
			id: row.ID ?? "",
			name: row.Names ?? "",
			image: row.Image ?? "",
			status: row.Status ?? "",
			state: row.State,
			createdAt: row.CreatedAt,
			workspaceRoot: undefined,
			workspaceMountPath: labels[SANDBOX_LABEL_WORKSPACE_MOUNT],
			daemonPort,
			daemonEndpoint: row.Ports ? redactSecrets(row.Ports) : undefined,
			labels,
		};
	}
}

export function parseDockerPortOutput(output: string): string {
	const firstLine = output.trim().split(/\r?\n/)[0];
	const match = firstLine?.match(/^(?<host>.+):(?<port>\d+)$/);
	if (!match?.groups) throw new Error(`Unable to parse Docker daemon port output: ${output.trim()}`);
	const host = match.groups.host === "0.0.0.0" ? "127.0.0.1" : match.groups.host;
	return `ws://${host}:${match.groups.port}/pi/workspace`;
}

export function parseDockerInspectContainers(
	output: string,
	daemonPort = DEFAULT_SANDBOX_DAEMON_PORT,
): SandboxContainer[] {
	return parseJsonArray<DockerInspectRecord>(output).map((record) => {
		const labels = record.Config?.Labels ?? {};
		const mountPath = labels[SANDBOX_LABEL_WORKSPACE_MOUNT] ?? DEFAULT_SANDBOX_WORKSPACE_MOUNT;
		const mount = record.Mounts?.find((candidate) => candidate.Destination === mountPath);
		const name = record.Name?.replace(/^\//, "") ?? "";
		return {
			id: record.Id ?? "",
			name,
			image: record.Config?.Image ?? "",
			status: record.State?.Status ?? "",
			state: record.State?.Running ? "running" : record.State?.Status,
			createdAt: record.State?.StartedAt ?? record.Created,
			workspaceRoot: mount?.Source,
			workspaceMountPath: mount?.Destination ?? mountPath,
			daemonPort,
			daemonEndpoint: getEndpointFromPorts(record.NetworkSettings?.Ports, daemonPort),
			labels,
		};
	});
}
function containerIdsMatch(left: string, right: string): boolean {
	return left === right || left.startsWith(right) || right.startsWith(left);
}

function selectStopTarget(
	containers: SandboxContainer[],
	target: string | undefined,
	currentContainerId: string | undefined,
): SandboxContainer | undefined {
	if (target) {
		return containers.find((container) => containerIdsMatch(container.id, target) || container.name === target);
	}
	if (currentContainerId) {
		const current = containers.find((container) => containerIdsMatch(container.id, currentContainerId));
		if (current) return current;
	}
	return containers.length === 1 ? containers[0] : undefined;
}
