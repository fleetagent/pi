import { createHash, randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { basename, resolve } from "node:path";
import { VERSION } from "../../config.ts";
import { spawnProcess } from "../../utils/child-process.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type {
	DockerCommandOptions,
	DockerCommandResult,
	DockerRunner,
	SandboxConfig,
	SandboxConfigOverrides,
	SandboxContainer,
	SandboxListOptions,
	SandboxStartOptions,
	SandboxStartResult,
	SandboxStopOptions,
	SandboxStopResult,
} from "./docker.ts";
import { allocateSandboxDaemonPort, redactSecrets, resolveSandboxConfig } from "./docker.ts";
export interface ManagedLimaInstance {
	workspaceRoot: string;
	daemonPort: number;
	ownerId?: string;
	managed: boolean;
}

export interface LimaSandboxServiceOptions {
	settingsManager?: Pick<SettingsManager, "getSandboxSettings">;
	env?: NodeJS.ProcessEnv;
	runner?: DockerRunner;
	portAllocator?: (host: string, preferredPort: number) => Promise<number>;
	readinessWaiter?: (host: string, port: number) => Promise<void>;
	managedInstances?: Map<string, ManagedLimaInstance>;
}

interface LimaMount {
	location?: string;
	mountPoint?: string;
	writable?: boolean;
}

interface LimaPortForward {
	guestPort?: number;
	hostPort?: number;
	hostIP?: string;
}

interface LimaConfig {
	mounts?: LimaMount[];
	portForwards?: LimaPortForward[];
}

interface LimaListRecord {
	name?: string;
	status?: string;
	arch?: string;
	vmType?: string;
	dir?: string;
	config?: LimaConfig;
}

class ProcessLimaRunner implements DockerRunner {
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

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parseLimaRecords(output: string): LimaListRecord[] {
	const text = output.trim();
	if (!text) return [];
	try {
		const parsed = JSON.parse(text) as unknown;
		return Array.isArray(parsed) ? (parsed as LimaListRecord[]) : [parsed as LimaListRecord];
	} catch {
		return text
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line) as LimaListRecord);
	}
}

function ensureLimaSuccessful(binary: string, result: DockerCommandResult, args: string[]): void {
	if (result.exitCode === 0) return;
	const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode ?? "unknown"}`;
	throw new Error(redactSecrets(`Lima command failed: ${binary} ${args.join(" ")}: ${detail}`));
}

function daemonConnectionHost(host: string): string {
	if (host === "0.0.0.0") return "127.0.0.1";
	if (host === "::") return "::1";
	return host;
}

function urlHost(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
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

async function waitForLimaDaemon(host: string, port: number): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (await canConnect(daemonConnectionHost(host), port)) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	}
	throw new Error(`Lima sandbox daemon did not become reachable on ${daemonConnectionHost(host)}:${port}`);
}

function createInstanceName(
	config: SandboxConfig,
	workspaceRoot: string,
	sessionId: string,
	daemonPort: number,
): string {
	const clean = (value: string): string =>
		value
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "workspace";
	const hash = createHash("sha256").update(resolve(workspaceRoot)).digest("hex").slice(0, 12);
	return `${clean(config.limaInstanceNamePrefix)}-${clean(basename(resolve(workspaceRoot)))}-${hash}-${clean(sessionId).slice(0, 8).replace(/-+$/, "")}-p${daemonPort}-${randomBytes(4).toString("hex")}`;
}

function findWorkspaceMount(record: LimaListRecord, workspaceMountPath: string): LimaMount | undefined {
	return record.config?.mounts?.find((mount) => mount.mountPoint === workspaceMountPath);
}

function findDaemonForward(record: LimaListRecord, preferredPort?: number): LimaPortForward | undefined {
	const namePort = Number(record.name?.match(/-p(\d+)-[a-f0-9]+$/)?.[1]);
	const daemonPort = Number.isInteger(namePort) && namePort > 0 ? namePort : preferredPort;
	const forwards = record.config?.portForwards?.filter(
		(forward) => forward.guestPort === forward.hostPort && forward.hostPort !== undefined,
	);
	return (
		forwards?.find((forward) => forward.guestPort === daemonPort) ??
		(forwards?.length === 1 ? forwards[0] : undefined)
	);
}

function toSandboxContainer(record: LimaListRecord, workspaceMountPath: string): SandboxContainer {
	const mount = findWorkspaceMount(record, workspaceMountPath);
	const forward = findDaemonForward(record);
	const daemonEndpoint = forward?.hostPort
		? `ws://${urlHost(daemonConnectionHost(forward.hostIP || "127.0.0.1"))}:${forward.hostPort}/pi/workspace`
		: undefined;
	return {
		id: record.name ?? "",
		name: record.name ?? "",
		image: `lima:${record.vmType ?? "vm"}/${record.arch ?? "unknown"}`,
		status: record.status ?? "",
		state: record.status?.toLowerCase(),
		createdAt: undefined,
		workspaceRoot: mount?.location ? resolve(mount.location) : undefined,
		workspaceMountPath: mount?.mountPoint,
		daemonPort: forward?.guestPort,
		daemonEndpoint,
		labels: { "ai.fleetagent.pi.runtime": "lima", "ai.fleetagent.pi.version": VERSION },
	};
}

function selectLimaSandbox(instances: SandboxContainer[], target: string | undefined): SandboxContainer | undefined {
	if (!target) return instances.length === 1 ? instances[0] : undefined;
	return instances.find((instance) => instance.name === target || instance.id.startsWith(target));
}

export class LimaSandboxService {
	private readonly settingsManager: Pick<SettingsManager, "getSandboxSettings"> | undefined;
	private readonly env: NodeJS.ProcessEnv;
	private readonly runner: DockerRunner;
	private readonly portAllocator: (host: string, preferredPort: number) => Promise<number>;
	private readonly readinessWaiter: (host: string, port: number) => Promise<void>;
	private readonly managedInstances: Map<string, ManagedLimaInstance>;

	constructor(options: LimaSandboxServiceOptions = {}) {
		this.settingsManager = options.settingsManager;
		this.env = options.env ?? process.env;
		this.runner = options.runner ?? new ProcessLimaRunner();
		this.portAllocator = options.portAllocator ?? allocateSandboxDaemonPort;
		this.readinessWaiter = options.readinessWaiter ?? waitForLimaDaemon;
		this.managedInstances = options.managedInstances ?? new Map();
	}

	resolveConfig(overrides: SandboxConfigOverrides = {}): SandboxConfig {
		return resolveSandboxConfig(this.settingsManager?.getSandboxSettings(), this.env, overrides);
	}

	private async listRecords(config: SandboxConfig, name?: string): Promise<LimaListRecord[]> {
		const args = ["list", "--json", ...(name ? [name] : [])];
		try {
			const result = await this.runner.run(config.limaBinary, args);
			if (
				name &&
				result.exitCode !== 0 &&
				/unmatched|not found|does not exist/i.test(`${result.stderr}\n${result.stdout}`)
			) {
				return [];
			}
			ensureLimaSuccessful(config.limaBinary, result, args);
			return parseLimaRecords(result.stdout);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(redactSecrets(`Lima is unavailable or not reachable via ${config.limaBinary}: ${message}`));
		}
	}

	private async startInstance(
		config: SandboxConfig,
		workspaceRoot: string,
		name: string,
		daemonPort: number,
	): Promise<void> {
		const mountExpression = `.mounts = [{"location":${JSON.stringify(workspaceRoot)},"mountPoint":${JSON.stringify(config.workspaceMountPath)},"writable":true}]`;
		const forwardExpression = `.portForwards += [{"guestPort":${daemonPort},"hostPort":${daemonPort},"hostIP":${JSON.stringify(config.daemonHostBind)}}]`;
		const args = [
			"start",
			"--tty=false",
			"--name",
			name,
			"--mount-none",
			"--set",
			mountExpression,
			"--set",
			forwardExpression,
			config.limaTemplate,
		];
		ensureLimaSuccessful(config.limaBinary, await this.runner.run(config.limaBinary, args), args);
	}

	private async ensurePi(config: SandboxConfig, name: string, managed: boolean): Promise<void> {
		const checkArgs = ["shell", "--tty=false", name, "sh", "-lc", "command -v pi >/dev/null"];
		const check = await this.runner.run(config.limaBinary, checkArgs);
		if (check.exitCode === 0) return;
		if (!managed) {
			throw new Error(
				`Lima instance ${name} does not provide pi; install @fleetagent/pi-coding-agent in the VM first`,
			);
		}
		const packageSpec = `@fleetagent/pi-coding-agent@${VERSION}`;
		const script = `set -eu; sudo apt-get update; sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm; sudo npm install -g ${shellQuote(packageSpec)}`;
		const args = ["shell", "--tty=false", name, "sh", "-lc", script];
		ensureLimaSuccessful(config.limaBinary, await this.runner.run(config.limaBinary, args), args);
	}

	private async startDaemon(config: SandboxConfig, name: string): Promise<string> {
		const pidFile = `.cache/pi/sandbox-daemon-${config.daemonPort}.pid`;
		const logFile = `.cache/pi/sandbox-daemon-${config.daemonPort}.log`;
		const script = [
			"set -eu",
			`mkdir -p "$HOME/.cache/pi"`,
			`if test -f "$HOME/${pidFile}"; then old_pid="$(cat "$HOME/${pidFile}")"; kill "$old_pid" 2>/dev/null || true; fi`,
			`token="$(head -c 32 /dev/urandom | base64 | tr -d '\\n')"`,
			`nohup env PI_DAEMON_TOKEN="$token" pi --daemon --daemon-host 127.0.0.1 --daemon-allow-insecure-transport --daemon-port ${config.daemonPort} --daemon-cwd ${shellQuote(config.workspaceMountPath)} --daemon-allow-root --daemon-allow-process-exec >"$HOME/${logFile}" 2>&1 </dev/null &`,
			`echo $! >"$HOME/${pidFile}"`,
			`printf 'PI_SANDBOX_TOKEN=%s\\n' "$token"`,
		].join("\n");
		const args = ["shell", "--tty=false", "--workdir", config.workspaceMountPath, name, "sh", "-lc", script];
		const result = await this.runner.run(config.limaBinary, args);
		ensureLimaSuccessful(config.limaBinary, result, args);
		const token = result.stdout.match(/(?:^|\n)PI_SANDBOX_TOKEN=([^\r\n]+)/)?.[1];
		if (!token) throw new Error(`Lima instance ${name} started the daemon without returning an authentication token`);
		return token;
	}

	private async prepareExistingInstance(
		config: SandboxConfig,
		record: LimaListRecord,
		name: string,
		workspaceRoot: string,
	): Promise<void> {
		const mount = findWorkspaceMount(record, config.workspaceMountPath);
		if (!mount || resolve(mount.location ?? "") !== workspaceRoot || !mount.writable) {
			throw new Error(
				`Lima instance ${name} must mount ${workspaceRoot} read-write at ${config.workspaceMountPath}`,
			);
		}
		if (record.status?.toLowerCase() === "running") return;
		const args = ["start", "--tty=false", name];
		ensureLimaSuccessful(config.limaBinary, await this.runner.run(config.limaBinary, args), args);
	}

	async start(options: SandboxStartOptions): Promise<SandboxStartResult> {
		if (options.image) throw new Error("Docker images are not supported by the Lima sandbox runtime");
		const workspaceRoot = resolve(options.workspaceRoot);
		const config = this.resolveConfig(options);
		const existingName = options.name?.trim();
		const records = existingName ? await this.listRecords(config, existingName) : [];
		if (existingName && records.length === 0) throw new Error(`Lima instance not found: ${existingName}`);
		const managed = !existingName;
		const existing = records[0];
		if (existing) await this.prepareExistingInstance(config, existing, existingName!, workspaceRoot);
		const configuredForward = existing ? findDaemonForward(existing, config.daemonPort) : undefined;
		if (configuredForward && configuredForward.guestPort !== configuredForward.hostPort) {
			throw new Error(
				`Lima instance ${existingName} must forward the sandbox daemon on the same guest and host port`,
			);
		}
		const daemonPort =
			configuredForward?.hostPort ?? (await this.portAllocator(config.daemonHostBind, config.daemonPort));
		const name =
			existingName ?? createInstanceName(config, workspaceRoot, options.sessionId ?? "session", daemonPort);
		const effectiveConfig = { ...config, daemonPort };
		if (managed) await this.startInstance(effectiveConfig, workspaceRoot, name, daemonPort);
		try {
			await this.ensurePi(effectiveConfig, name, managed);
			const token = await this.startDaemon(effectiveConfig, name);
			this.managedInstances.set(name, { workspaceRoot, daemonPort, ownerId: options.sessionId, managed });
			await this.readinessWaiter(config.daemonHostBind, daemonPort);
			const daemonUrl = `ws://${urlHost(daemonConnectionHost(config.daemonHostBind))}:${daemonPort}/pi/workspace`;
			return {
				containerId: name,
				containerName: name,
				workspaceRoot,
				workspaceMountPath: config.workspaceMountPath,
				daemonUrl,
				daemonUrlRedacted: daemonUrl,
				token,
				labels: { "ai.fleetagent.pi.runtime": "lima", "ai.fleetagent.pi.version": VERSION },
			};
		} catch (error) {
			if (managed) await this.removeInstance(effectiveConfig, name).catch(() => undefined);
			throw error;
		}
	}

	async list(options: SandboxListOptions): Promise<SandboxContainer[]> {
		const config = this.resolveConfig();
		const workspaceRoot = resolve(options.workspaceRoot);
		return (await this.listRecords(config))
			.map((record) => toSandboxContainer(record, config.workspaceMountPath))
			.filter(
				(instance) => instance.workspaceRoot && (options.allWorkspaces || instance.workspaceRoot === workspaceRoot),
			);
	}

	private async stopDaemon(config: SandboxConfig, name: string, daemonPort: number): Promise<void> {
		const pidFile = `.cache/pi/sandbox-daemon-${daemonPort}.pid`;
		const script = `if test -f "$HOME/${pidFile}"; then pid="$(cat "$HOME/${pidFile}")"; kill "$pid" 2>/dev/null || true; rm -f "$HOME/${pidFile}"; fi`;
		const args = ["shell", "--tty=false", name, "sh", "-lc", script];
		ensureLimaSuccessful(config.limaBinary, await this.runner.run(config.limaBinary, args), args);
	}

	private async removeInstance(config: SandboxConfig, name: string): Promise<void> {
		const args = ["delete", "--force", name];
		ensureLimaSuccessful(config.limaBinary, await this.runner.run(config.limaBinary, args), args);
	}

	async stop(options: SandboxStopOptions): Promise<SandboxStopResult> {
		const config = this.resolveConfig();
		const instances = await this.list({ workspaceRoot: options.workspaceRoot });
		const selected = selectLimaSandbox(instances, options.target ?? options.currentContainerId);
		if (!selected) return { status: "not-found", message: "No matching Pi Lima sandbox found" };
		const tracked = this.managedInstances.get(selected.name);
		const ownsInstance = tracked?.managed || selected.name.startsWith(`${config.limaInstanceNamePrefix}-`);
		if (selected.state !== "running") {
			if (ownsInstance && config.cleanup === "remove") {
				await this.removeInstance(config, selected.name);
				this.managedInstances.delete(selected.name);
				return { status: "removed", container: selected };
			}
			this.managedInstances.delete(selected.name);
			return { status: "already-stopped", container: selected };
		}
		await this.stopDaemon(config, selected.name, tracked?.daemonPort ?? selected.daemonPort ?? config.daemonPort);
		if (ownsInstance) {
			const args = config.cleanup === "remove" ? ["delete", "--force", selected.name] : ["stop", selected.name];
			ensureLimaSuccessful(config.limaBinary, await this.runner.run(config.limaBinary, args), args);
		}
		this.managedInstances.delete(selected.name);
		return { status: ownsInstance && config.cleanup === "remove" ? "removed" : "stopped", container: selected };
	}

	async stopManagedInstances(): Promise<void> {
		const failures: unknown[] = [];
		for (const [name, instance] of [...this.managedInstances]) {
			try {
				await this.stop({ workspaceRoot: instance.workspaceRoot, target: name, currentContainerId: name });
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length > 0) throw new AggregateError(failures, "Failed to stop managed Lima sandbox instances");
	}
}
