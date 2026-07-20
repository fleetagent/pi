import type { ServerCapabilities } from "vscode-languageserver-protocol";
import type { ToolBackendInfo, ToolOperations } from "../tools/operations.ts";
import { waitForAbort } from "./abort.ts";
import { LspClient, type LspClientOptions, type LspConnectionState } from "./client.ts";
import type { LspServerFeatures, ResolvedLspConfiguration } from "./config.ts";
import { type LspRouteResult, LspRouter, type LspRouterOptions, type LspRouteTarget } from "./language-map.ts";
import { resolvePortablePath } from "./portable-path.ts";
import {
	type LspConnectionFactory,
	type LspConnectionFactoryRegistry,
	resolveLspConnectionFactory,
} from "./transport.ts";

export interface LspServerStatus {
	serverId: string;
	languageIds: string[];
	transport: string;
	instanceKey?: string;
	workspaceRoot?: string;
	endpoint?: string;
	rootUri?: string;
	ownership: "managed" | "attached";
	shutdownMode: "protocol" | "disconnect";
	state: LspConnectionState;
	reconnectEligible: boolean;
	capabilities?: ServerCapabilities;
	running: boolean;
	starting: boolean;
	diagnosticsCount: number;
	lastError?: string;
	lastRequestError?: string;
	stderr?: string;
	synchronizationError?: string;
}

export interface LspManagerOptions extends LspRouterOptions {
	configuration?: ResolvedLspConfiguration;
	createClient?: (options: LspClientOptions) => LspClient;
	connectionFactories?: LspConnectionFactoryRegistry;
	getToolBackendInfo?: () => ToolBackendInfo;
	getToolOperations?: () => ToolOperations;
}

export interface LspClientRoute {
	client: LspClient;
	target: LspRouteTarget;
}

export type LspToolFeature = keyof LspServerFeatures;

export interface LspClientRouteFailure {
	serverId: string;
	reason: string;
}

export interface LspClientRouteCollection {
	routes: LspClientRoute[];
	failures: LspClientRouteFailure[];
	matchedServerCount: number;
}

interface LspTransportStatus {
	lastError?: string;
	lastRequestError?: string;
	stderr: string;
	state: LspConnectionState;
	endpoint?: string;
	capabilities?: ServerCapabilities;
}

interface LspStartupWaiters {
	startup: Promise<LspClient | undefined>;
	waiters: Set<object>;
}

export type LspClientStartedListener = (route: LspClientRoute, recoverySignal?: AbortSignal) => Promise<void>;
export type LspClientsWillShutdownListener = (routes: LspClientRoute[]) => Promise<void>;

const DISABLED_CONFIGURATION: ResolvedLspConfiguration = { enabled: false, servers: [] };
const SYNCHRONIZATION_RECOVERY_TIMEOUT_MS = 3000;

export class LspManager {
	private rootDir: string;
	private readonly createClient: (options: LspClientOptions) => LspClient;
	private readonly connectionFactories: LspConnectionFactoryRegistry;
	private readonly getToolBackendInfo: (() => ToolBackendInfo) | undefined;
	private readonly getToolOperations: (() => ToolOperations) | undefined;
	private toolBackendInfo: ToolBackendInfo | undefined;
	private toolOperations: ToolOperations | undefined;
	private activeBackendIdentity: string | undefined;
	private readonly operationIds = new WeakMap<ToolOperations, number>();
	private nextOperationId = 1;
	private readonly inaccessibleRemotePathExists = async (): Promise<boolean> => false;
	private readonly router: LspRouter;
	private configuration: ResolvedLspConfiguration;
	private readonly clients = new Map<string, LspClient>();
	private readonly targets = new Map<string, LspRouteTarget>();
	private readonly transportStatuses = new Map<string, LspTransportStatus>();
	private readonly synchronizationErrors = new Map<string, string>();
	private readonly clientStartedListeners = new Set<LspClientStartedListener>();
	private readonly clientsWillShutdownListeners = new Set<LspClientsWillShutdownListener>();
	private readonly starting = new Map<string, Promise<LspClient | undefined>>();
	private readonly startupWaiters = new Map<string, LspStartupWaiters>();
	private readonly recoverySignals = new Map<string, AbortSignal>();
	private shuttingDown = false;
	private permanentlyShutDown = false;
	private pendingLifecycleOperations = 0;
	private lifecycleGeneration = 0;
	private readonly lifecycleGenerationListeners = new Set<() => void>();
	private lifecycleQueue: Promise<void> = Promise.resolve();

	constructor(rootDir: string, options: LspManagerOptions = {}) {
		this.rootDir = resolvePortablePath(process.cwd(), rootDir);
		this.configuration = options.configuration ?? DISABLED_CONFIGURATION;
		this.router = new LspRouter(this.rootDir, this.configuration, { pathExists: options.pathExists });
		this.createClient = options.createClient ?? ((clientOptions) => new LspClient(clientOptions));
		this.connectionFactories = options.connectionFactories ?? {};
		this.getToolBackendInfo = options.getToolBackendInfo;
		this.getToolOperations = options.getToolOperations;
	}

	get cwd(): string {
		return this.rootDir;
	}

	get isShuttingDown(): boolean {
		return this.shuttingDown;
	}

	resolvePath(filePath: string): string {
		return resolvePortablePath(this.rootDir, filePath);
	}

	setConfiguration(configuration: ResolvedLspConfiguration): Promise<void> {
		return this.enqueueLifecycleOperation(async () => {
			const clients = [...this.clients.values()];
			await this.notifyClientsWillShutdown();
			await Promise.all(clients.map((client) => client.shutdown().catch(() => undefined)));
			await Promise.all([...this.starting.values()].map((pending) => pending.catch(() => undefined)));
			this.clients.clear();
			this.targets.clear();
			this.transportStatuses.clear();
			this.synchronizationErrors.clear();
			this.starting.clear();
			this.configuration = configuration;
			this.router.setConfiguration(configuration);
		});
	}

	clearRoutingCache(): void {
		this.router.clearCache();
	}

	async resolveTargets(filePath: string, signal?: AbortSignal): Promise<LspRouteResult> {
		const operations = this.getToolOperations?.();
		if (operations) await waitForAbort(this.setToolOperations(operations), signal);
		if (!this.configuration.enabled) return { targets: [], failures: [] };
		const backend = this.toolBackendInfo ?? this.toolOperations?.getBackendInfo?.() ?? this.getToolBackendInfo?.();
		if (!this.toolOperations && backend && backend.type !== "local") {
			this.rootDir = resolvePortablePath(process.cwd(), backend.cwd);
			this.router.setRoutingContext(this.rootDir, this.inaccessibleRemotePathExists);
		}
		const route = await waitForAbort(this.router.routeFile(filePath, signal), signal);
		if (!backend || backend.type === "local") return route;
		const targets: LspRouteTarget[] = [];
		const failures = [...route.failures];
		for (const target of route.targets) {
			const reason = this.getBackendCompatibilityReason(target, backend);
			if (reason) {
				this.targets.set(target.instanceKey, target);
				this.synchronizationErrors.set(target.instanceKey, reason);
				failures.push({ serverId: target.serverId, reason });
			} else {
				targets.push(target);
			}
		}
		return { targets, failures };
	}

	async getPrimaryTarget(filePath: string, signal?: AbortSignal): Promise<LspRouteTarget | undefined> {
		return (await this.resolveTargets(filePath, signal)).targets[0];
	}

	getRunningClient(instanceKey: string): LspClient | undefined {
		const client = this.clients.get(instanceKey);
		return client?.isInitialized === true && !client.isDisposed ? client : undefined;
	}

	setToolBackendInfo(backend: ToolBackendInfo): void {
		this.toolBackendInfo = backend;
	}

	async setToolOperations(operations: ToolOperations, signal?: AbortSignal): Promise<void> {
		const backend = operations.getBackendInfo?.() ?? { type: "local" as const, cwd: operations.cwd };
		let operationId = this.operationIds.get(operations);
		if (operationId === undefined) {
			operationId = this.nextOperationId++;
			this.operationIds.set(operations, operationId);
		}
		const identity = JSON.stringify([operationId, backend]);
		if (identity === this.activeBackendIdentity) {
			this.toolOperations = operations;
			this.toolBackendInfo = backend;
			return;
		}
		const nextRoot = resolvePortablePath(process.cwd(), operations.cwd);
		const apply = () => {
			this.toolOperations = operations;
			this.toolBackendInfo = backend;
			this.activeBackendIdentity = identity;
			this.rootDir = nextRoot;
			this.router.setRoutingContext(nextRoot, async (path) => {
				await operations.access(path, "exists");
				return true;
			});
		};
		const defaultLocalContext =
			this.activeBackendIdentity === undefined && backend.type === "local" && nextRoot === this.rootDir;
		if (defaultLocalContext || (this.clients.size === 0 && this.starting.size === 0)) {
			apply();
			return;
		}
		await waitForAbort(
			this.enqueueLifecycleOperation(async () => {
				const clients = [...this.clients.values()];
				await this.notifyClientsWillShutdown();
				await Promise.all(clients.map((client) => client.shutdown().catch(() => undefined)));
				await Promise.all([...this.starting.values()].map((pending) => pending.catch(() => undefined)));
				this.clients.clear();
				this.targets.clear();
				this.transportStatuses.clear();
				this.synchronizationErrors.clear();
				this.starting.clear();
				apply();
			}),
			signal,
		);
	}

	onClientStarted(listener: LspClientStartedListener): () => void {
		this.clientStartedListeners.add(listener);
		return () => this.clientStartedListeners.delete(listener);
	}

	onClientsWillShutdown(listener: LspClientsWillShutdownListener): () => void {
		this.clientsWillShutdownListeners.add(listener);
		return () => this.clientsWillShutdownListeners.delete(listener);
	}

	reportSynchronizationUnavailable(target: LspRouteTarget, reason: string | undefined): void {
		this.targets.set(target.instanceKey, target);
		if (reason) this.synchronizationErrors.set(target.instanceKey, reason);
		else this.synchronizationErrors.delete(target.instanceKey);
	}

	reportSynchronizationError(target: LspRouteTarget | string, error: unknown): void {
		const instanceKey = typeof target === "string" ? target : target.instanceKey;
		const resolvedTarget = typeof target === "string" ? this.targets.get(target) : target;
		if (resolvedTarget) this.targets.set(instanceKey, resolvedTarget);
		const detail = error instanceof Error ? error.message : String(error);
		const identity = resolvedTarget
			? `server ${resolvedTarget.serverId} instance ${resolvedTarget.instanceKey}`
			: `instance ${instanceKey}`;
		this.synchronizationErrors.set(instanceKey, `Synchronization failed for ${identity}: ${detail}`);
	}

	async invalidateSynchronizationClient(
		target: LspRouteTarget,
		client: LspClient,
		error: unknown,
		reconnect = true,
	): Promise<void> {
		const current = this.clients.get(target.instanceKey);
		if (current !== undefined && current !== client) {
			void client.invalidate();
			return;
		}
		if (current === client) {
			this.clients.delete(target.instanceKey);
			const transportStatus = this.transportStatuses.get(target.instanceKey);
			if (transportStatus?.state === "running") transportStatus.state = "closed";
		}
		this.reportSynchronizationError(target, error);
		void client.invalidate();
		if (!reconnect) return;
		const generation = this.lifecycleGeneration;
		queueMicrotask(() => {
			if (
				this.lifecycleGeneration !== generation ||
				this.shuttingDown ||
				!this.configuration.enabled ||
				!this.configuration.servers.some((server) => server === target.server)
			)
				return;
			const configuredTimeout = target.server.timeouts?.requestMs;
			const recoveryTimeoutMs =
				configuredTimeout !== undefined && configuredTimeout > 0
					? Math.min(configuredTimeout, SYNCHRONIZATION_RECOVERY_TIMEOUT_MS)
					: SYNCHRONIZATION_RECOVERY_TIMEOUT_MS;
			const recoverySignal = AbortSignal.timeout(recoveryTimeoutMs);
			this.recoverySignals.set(target.instanceKey, recoverySignal);
			void this.getClientForTarget(target, recoverySignal).catch(() => undefined);
		});
	}

	getSynchronizationCompatibilityReason(
		target: LspRouteTarget,
		backend: ToolBackendInfo | undefined,
	): string | undefined {
		if (!backend || backend.type === "local") return undefined;
		return this.getBackendCompatibilityReason(target, backend);
	}
	getRunningClients(): LspClientRoute[] {
		const serverOrder = new Map(this.configuration.servers.map((server, index) => [server, index]));
		return [...this.clients.entries()]
			.flatMap(([instanceKey, client]) => {
				const target = this.targets.get(instanceKey);
				return target && client.isInitialized && !client.isDisposed ? [{ client, target }] : [];
			})
			.sort(
				(left, right) =>
					(right.target.server.priority ?? 0) - (left.target.server.priority ?? 0) ||
					(serverOrder.get(left.target.server) ?? Number.MAX_SAFE_INTEGER) -
						(serverOrder.get(right.target.server) ?? Number.MAX_SAFE_INTEGER) ||
					left.target.instanceKey.localeCompare(right.target.instanceKey),
			);
	}

	isStarting(instanceKey: string): boolean {
		return this.starting.has(instanceKey);
	}

	async getClientRouteForFile(filePath: string, signal?: AbortSignal): Promise<LspClientRoute | undefined> {
		const target = await this.getPrimaryTarget(filePath, signal);
		if (!target) return undefined;
		const client = await this.getClientForTarget(target, signal);
		return client ? { client, target } : undefined;
	}

	async getClientForFile(filePath: string, signal?: AbortSignal): Promise<LspClient | undefined> {
		return (await this.getClientRouteForFile(filePath, signal))?.client;
	}

	async getClientRoutesForFeature(
		filePath: string,
		feature: LspToolFeature,
		signal?: AbortSignal,
	): Promise<LspClientRouteCollection> {
		const resolved = await this.resolveTargets(filePath, signal);
		const outcomes = await waitForAbort(
			Promise.all(
				resolved.targets.map(async (target) => {
					if (target.server.features?.[feature] === false) {
						return { failure: { serverId: target.serverId, reason: `${feature} is disabled by configuration` } };
					}
					const client = await this.getClientForTarget(target, signal);
					if (!client) {
						return { failure: { serverId: target.serverId, reason: this.getTargetUnavailableReason(target) } };
					}
					const unsupported = this.getUnsupportedCapabilityReason(client.serverCapabilities, feature);
					if (unsupported) return { failure: { serverId: target.serverId, reason: unsupported } };
					return { route: { client, target } };
				}),
			),
			signal,
		);
		return {
			routes: outcomes.flatMap((outcome) => (outcome.route ? [outcome.route] : [])),
			failures: [...resolved.failures, ...outcomes.flatMap((outcome) => (outcome.failure ? [outcome.failure] : []))],
			matchedServerCount: resolved.targets.length + resolved.failures.length,
		};
	}

	async getClientForTarget(target: LspRouteTarget, signal?: AbortSignal): Promise<LspClient | undefined> {
		if (!this.configuration.enabled) return undefined;
		if (!this.configuration.servers.some((server) => server === target.server)) return undefined;
		const backend = this.toolBackendInfo ?? this.toolOperations?.getBackendInfo?.() ?? this.getToolBackendInfo?.();
		if (backend && backend.type !== "local") {
			const reason = this.getBackendCompatibilityReason(target, backend);
			if (reason) {
				this.reportSynchronizationUnavailable(target, reason);
				return undefined;
			}
		}
		if (this.shuttingDown) return undefined;
		const running = this.getRunningClient(target.instanceKey);
		if (running) return running;
		const pending = this.starting.get(target.instanceKey);
		if (pending) return this.waitForClientStartup(target.instanceKey, pending, signal);

		const generation = this.lifecycleGeneration;
		const start = this.startClient(target, generation);
		this.starting.set(target.instanceKey, start);
		void start.finally(() => {
			if (this.starting.get(target.instanceKey) === start) {
				this.starting.delete(target.instanceKey);
				this.recoverySignals.delete(target.instanceKey);
			}
			if (this.startupWaiters.get(target.instanceKey)?.startup === start) {
				this.startupWaiters.delete(target.instanceKey);
			}
		});
		return this.waitForClientStartup(target.instanceKey, start, signal);
	}

	private async waitForClientStartup(
		instanceKey: string,
		startup: Promise<LspClient | undefined>,
		signal: AbortSignal | undefined,
	): Promise<LspClient | undefined> {
		const token = {};
		let state = this.startupWaiters.get(instanceKey);
		if (!state || state.startup !== startup) {
			state = { startup, waiters: new Set<object>() };
			this.startupWaiters.set(instanceKey, state);
		}
		state.waiters.add(token);
		try {
			return await waitForAbort(startup, signal);
		} finally {
			state.waiters.delete(token);
			if (state.waiters.size === 0 && this.startupWaiters.get(instanceKey) === state) {
				this.startupWaiters.delete(instanceKey);
				if (signal?.aborted && this.starting.get(instanceKey) === startup) {
					const orphanedClient = this.clients.get(instanceKey);
					this.starting.delete(instanceKey);
					this.recoverySignals.delete(instanceKey);
					if (this.clients.get(instanceKey) === orphanedClient) this.clients.delete(instanceKey);
					await orphanedClient?.invalidate().catch(() => undefined);
				}
			}
		}
	}
	async getUnavailableReason(filePath: string, signal?: AbortSignal): Promise<string> {
		if (!this.configuration.enabled) return "LSP is disabled.";
		const route = await this.resolveTargets(filePath, signal);
		if (route.targets.length === 0) {
			if (route.failures.length > 0)
				return route.failures.map((failure) => `${failure.serverId}: ${failure.reason}`).join("; ");
			return `No configured LSP document selector matched: ${filePath}`;
		}
		const target = route.targets[0];
		if (this.starting.has(target.instanceKey)) return `LSP server ${target.serverId} is starting. Retry shortly.`;
		const synchronizationError = this.synchronizationErrors.get(target.instanceKey);
		if (synchronizationError) return `LSP server ${target.serverId} is unavailable: ${synchronizationError}`;
		const error = this.transportStatuses.get(target.instanceKey)?.lastError;
		if (error) return `LSP server ${target.serverId} is unavailable: ${error}`;
		return `No running LSP server for ${filePath}. Call an LSP tool for this file to start it.`;
	}

	getStatus(): LspServerStatus[] {
		const runningStatuses = [...this.targets.entries()].map(([instanceKey, target]): LspServerStatus => {
			const client = this.clients.get(instanceKey);
			const transportStatus = this.transportStatuses.get(instanceKey);
			let diagnosticsCount = 0;
			if (client) {
				for (const diagnostics of client.getAllDiagnostics().values()) diagnosticsCount += diagnostics.length;
			}
			return {
				serverId: target.serverId,
				languageIds: [...new Set(target.server.selectors.map((selector) => selector.languageId))],
				transport: target.server.transport.type,
				instanceKey,
				workspaceRoot: target.workspaceRoot,
				rootUri: target.workspaceUri,
				ownership: target.server.lifecycle.type,
				shutdownMode:
					target.server.lifecycle.type === "attached" && target.server.lifecycle.shutdown !== "protocol"
						? ("disconnect" as const)
						: ("protocol" as const),
				state: client?.connectionState ?? transportStatus?.state ?? "idle",
				reconnectEligible: !this.shuttingDown && (client === undefined || !client.isDisposed),
				...(client?.connectionEndpoint || transportStatus?.endpoint
					? { endpoint: client?.connectionEndpoint?.description ?? transportStatus?.endpoint }
					: {}),
				...(client?.serverCapabilities || transportStatus?.capabilities
					? { capabilities: client?.serverCapabilities ?? transportStatus?.capabilities }
					: {}),
				running: client?.isInitialized === true && !client.isDisposed,
				starting: this.starting.has(instanceKey),
				diagnosticsCount,
				...(transportStatus?.lastError ? { lastError: transportStatus.lastError } : {}),
				...(transportStatus?.lastRequestError ? { lastRequestError: transportStatus.lastRequestError } : {}),
				...(transportStatus?.stderr ? { stderr: transportStatus.stderr } : {}),
				...(this.synchronizationErrors.get(instanceKey)
					? { synchronizationError: this.synchronizationErrors.get(instanceKey) }
					: {}),
			};
		});
		const instantiated = new Set(runningStatuses.map((status) => status.serverId));
		return [
			...runningStatuses,
			...this.configuration.servers
				.filter((server) => !instantiated.has(server.id))
				.map(
					(server): LspServerStatus => ({
						serverId: server.id,
						languageIds: [...new Set(server.selectors.map((selector) => selector.languageId))],
						transport: server.transport.type,
						ownership: server.lifecycle.type,
						shutdownMode:
							server.lifecycle.type === "attached" && server.lifecycle.shutdown !== "protocol"
								? ("disconnect" as const)
								: ("protocol" as const),
						state: "idle" as const,
						reconnectEligible: !this.shuttingDown,
						running: false,
						starting: false,
						diagnosticsCount: 0,
					}),
				),
		];
	}
	private async notifyClientStarted(
		route: LspClientRoute,
		generation: number,
		recoverySignal?: AbortSignal,
	): Promise<void> {
		for (const listener of this.clientStartedListeners) {
			if (this.lifecycleGeneration !== generation) return;
			let generationChanged!: () => void;
			const changed = new Promise<false>((resolve) => {
				generationChanged = () => resolve(false);
			});
			this.lifecycleGenerationListeners.add(generationChanged);
			if (this.lifecycleGeneration !== generation) generationChanged();
			const completed = await Promise.race([
				Promise.resolve()
					.then(() => listener(route, recoverySignal))
					.then(
						() => true,
						() => true,
					),
				changed,
			]);
			this.lifecycleGenerationListeners.delete(generationChanged);
			if (!completed || this.lifecycleGeneration !== generation) return;
		}
	}

	private async notifyClientsWillShutdown(): Promise<void> {
		const routes = this.getRunningClients();
		const notifications = [...this.clientsWillShutdownListeners].map((listener) =>
			Promise.resolve()
				.then(() => listener(routes))
				.catch(() => undefined),
		);
		if (notifications.length === 0) return;
		const lifecycleTargets = routes.length > 0 ? routes.map((route) => route.target) : [...this.targets.values()];
		const timeoutMs =
			lifecycleTargets.length === 0
				? 3000
				: Math.max(...lifecycleTargets.map((target) => target.server.timeouts?.shutdownMs ?? 3000));
		const completed = Promise.all(notifications).then(() => undefined);
		if (timeoutMs === 0) {
			await completed;
			return;
		}
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				completed,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, timeoutMs);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private getUnsupportedCapabilityReason(
		capabilities: ServerCapabilities | undefined,
		feature: LspToolFeature,
	): string | undefined {
		// publishDiagnostics is a server notification and has no corresponding provider capability.
		if (feature === "diagnostics") return undefined;
		const supported =
			feature === "hover"
				? capabilities?.hoverProvider
				: feature === "definition"
					? capabilities?.definitionProvider
					: feature === "references"
						? capabilities?.referencesProvider
						: feature === "rename"
							? capabilities?.renameProvider
							: capabilities?.codeActionProvider;
		return supported ? undefined : `server does not advertise ${feature} capability`;
	}

	private getTargetUnavailableReason(target: LspRouteTarget): string {
		const synchronizationError = this.synchronizationErrors.get(target.instanceKey);
		if (synchronizationError) return synchronizationError;
		const status = this.transportStatuses.get(target.instanceKey);
		if (status?.lastError) return status.lastError;
		if (this.starting.has(target.instanceKey)) return "server is still starting";
		if (this.shuttingDown) return "LSP lifecycle shutdown or reconfiguration is in progress";
		return "server could not be started";
	}

	private getBackendCompatibilityReason(target: LspRouteTarget, backend: ToolBackendInfo): string | undefined {
		if ("configured" in backend && backend.configured === false) {
			return `ToolOperations backend ${backend.type} is not configured`;
		}
		if ((target.server.pathMappings?.length ?? 0) === 0) {
			return `ToolOperations backend ${backend.type} requires explicit LSP pathMappings`;
		}
		const mappedBackendRoot = target.mapper.agentPathToServerUri(backend.cwd);
		if (!mappedBackendRoot.ok) {
			return `ToolOperations backend root ${backend.cwd} cannot be mapped to the server workspace: ${mappedBackendRoot.reason}`;
		}
		return undefined;
	}

	shutdownAll(): Promise<void> {
		this.permanentlyShutDown = true;
		return this.enqueueLifecycleOperation(async () => {
			const clients = [...this.clients.values()];
			await this.notifyClientsWillShutdown();
			await Promise.all(clients.map((client) => client.shutdown().catch(() => undefined)));
			await Promise.all([...this.starting.values()].map((pending) => pending.catch(() => undefined)));
			this.clients.clear();
			this.targets.clear();
			this.transportStatuses.clear();
			this.synchronizationErrors.clear();
			this.starting.clear();
		});
	}

	private enqueueLifecycleOperation(operation: () => Promise<void>): Promise<void> {
		this.pendingLifecycleOperations++;
		this.lifecycleGeneration++;
		for (const listener of this.lifecycleGenerationListeners) listener();
		this.lifecycleGenerationListeners.clear();
		this.shuttingDown = true;
		const result = this.lifecycleQueue.then(operation);
		this.lifecycleQueue = result.catch(() => undefined);
		return result.finally(() => {
			this.pendingLifecycleOperations--;
			this.shuttingDown = this.permanentlyShutDown || this.pendingLifecycleOperations > 0;
		});
	}

	private async startClient(target: LspRouteTarget, generation: number): Promise<LspClient | undefined> {
		this.targets.set(target.instanceKey, target);
		const transportStatus: LspTransportStatus = { stderr: "", state: "connecting" };
		this.transportStatuses.set(target.instanceKey, transportStatus);
		let connectionFactory: LspConnectionFactory;
		try {
			connectionFactory = resolveLspConnectionFactory(target.server.transport, this.connectionFactories);
		} catch (error) {
			transportStatus.lastError = error instanceof Error ? error.message : String(error);
			transportStatus.state = "failed";
			return undefined;
		}
		const lifecycle = target.server.lifecycle;
		const client = this.createClient({
			serverId: target.serverId,
			rootDir: target.workspaceRoot,
			rootUri: target.workspaceUri,
			languageId: target.languageId,
			connectionFactory,
			connectTimeoutMs: target.server.timeouts?.connectMs,
			initializeTimeoutMs: target.server.timeouts?.initializeMs,
			requestTimeoutMs: target.server.timeouts?.requestMs,
			shutdownTimeoutMs: target.server.timeouts?.shutdownMs,
			shutdownMode: lifecycle.type === "attached" && lifecycle.shutdown !== "protocol" ? "disconnect" : "protocol",
			ownership: lifecycle.type,
			initializationOptions: target.server.initializationOptions,
			settings: target.server.settings,
			clientInfo: target.server.clientInfo,
			locale: target.server.locale,
			trace: target.server.trace,
			onStderr: (text) => {
				if (this.lifecycleGeneration === generation) {
					transportStatus.stderr = `${transportStatus.stderr}${text}`.slice(-16_384);
				}
			},
			onTransportError: (error) => {
				if (this.lifecycleGeneration === generation) transportStatus.lastError = error.message;
			},
			onRequestError: (error) => {
				if (this.lifecycleGeneration === generation) transportStatus.lastRequestError = error.message;
			},
			onUnexpectedClose: (error) => {
				if (this.lifecycleGeneration !== generation) return;
				transportStatus.lastError =
					error?.message ?? `Connection to LSP server ${target.serverId} closed unexpectedly`;
				transportStatus.state = "closed";
				if (this.clients.get(target.instanceKey) === client) this.clients.delete(target.instanceKey);
			},
		});
		this.clients.set(target.instanceKey, client);
		try {
			const result = await client.start();
			if (!this.isStartupCurrent(target, client, generation)) {
				await client.shutdown().catch(() => undefined);
				if (this.clients.get(target.instanceKey) === client) this.clients.delete(target.instanceKey);
				return undefined;
			}
			transportStatus.lastError = undefined;
			transportStatus.state = "running";
			transportStatus.endpoint = result.endpoint.description;
			transportStatus.capabilities = result.capabilities;
			await this.notifyClientStarted({ client, target }, generation, this.recoverySignals.get(target.instanceKey));
			if (!this.isStartupCurrent(target, client, generation)) {
				await client.shutdown().catch(() => undefined);
				if (this.clients.get(target.instanceKey) === client) this.clients.delete(target.instanceKey);
				return undefined;
			}
			return client;
		} catch (error) {
			if (this.lifecycleGeneration === generation) {
				transportStatus.lastError = error instanceof Error ? error.message : String(error);
				transportStatus.state = "failed";
			}
			return undefined;
		}
	}

	private isStartupCurrent(target: LspRouteTarget, client: LspClient, generation: number): boolean {
		return (
			this.lifecycleGeneration === generation &&
			!this.shuttingDown &&
			this.configuration.enabled &&
			this.configuration.servers.some((server) => server === target.server) &&
			this.clients.get(target.instanceKey) === client &&
			client.isInitialized &&
			!client.isDisposed
		);
	}
}
