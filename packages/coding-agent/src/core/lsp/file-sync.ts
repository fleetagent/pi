import { type Position, type Range, TextDocumentSyncKind } from "vscode-languageserver-protocol";
import type { ToolOperations } from "../tools/operations.ts";
import { throwIfAborted, waitForAbort } from "./abort.ts";
import type { LspClient } from "./client.ts";
import type { LspRouteTarget } from "./language-map.ts";
import type { LspClientRoute, LspManager } from "./manager.ts";
import { pathComparisonValue, resolvePortablePath } from "./portable-path.ts";

export interface LspTrackedDocument {
	uri: string;
	languageId: string;
	instanceKey: string;
	version: number;
}

export interface LspSynchronizationFailure {
	instanceKey: string;
	serverId: string;
	reason: string;
}

export interface LspSynchronizationResult {
	failures: LspSynchronizationFailure[];
	lifecycleCancelled?: true;
}

interface IncrementalDocumentChange {
	range: Range;
	text: string;
}

interface OpenDocument {
	agentPath: string;
	content: string;
	operations: ToolOperations;
}

interface SynchronizationContentReadContext {
	operations: ToolOperations;
	callerSignal: AbortSignal | undefined;
	lifecycleSignal: AbortSignal;
	routes: readonly LspClientRoute[];
	failures: LspSynchronizationFailure[];
}

interface ClientSynchronizationContext {
	document: OpenDocument;
	target: LspRouteTarget;
	client: LspClient;
	written: boolean;
	callerSignal: AbortSignal | undefined;
	lifecycleSignal: AbortSignal;
	reconnectOnFailure: boolean;
}

interface ClientDocumentState extends LspTrackedDocument {
	agentPath: string;
	client: LspClient;
	target: LspRouteTarget;
	content: string;
	opened: boolean;
	closing?: boolean;
}

const DEFAULT_MAX_TRACKED_DOCUMENTS = 100;
const MAX_SYNCHRONIZATION_NOTIFICATION_MS = 3000;

function resolveOperationsPath(filePath: string, operations: ToolOperations): string {
	return resolvePortablePath(operations.cwd, filePath);
}

function positionAt(text: string, offset: number): Position {
	let line = 0;
	let lineStart = 0;
	for (let index = 0; index < offset; index++) {
		if (text.charCodeAt(index) === 10) {
			line++;
			lineStart = index + 1;
		}
	}
	return { line, character: offset - lineStart };
}

function createIncrementalChange(previous: string, next: string): IncrementalDocumentChange {
	let prefix = 0;
	while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < previous.length - prefix &&
		suffix < next.length - prefix &&
		previous[previous.length - suffix - 1] === next[next.length - suffix - 1]
	) {
		suffix++;
	}
	return {
		range: {
			start: positionAt(previous, prefix),
			end: positionAt(previous, previous.length - suffix),
		},
		text: next.slice(prefix, next.length - suffix),
	};
}

export class LspFileSync {
	private readonly manager: LspManager;
	private readonly maxTrackedDocuments: number;
	private readonly openDocuments = new Map<string, OpenDocument>();
	private readonly clientDocuments = new Map<string, ClientDocumentState>();
	private readonly indeterminateClients = new Set<LspClient>();
	private readonly pendingSaveReplays = new Map<string, Set<string>>();
	private synchronizationQueue: Promise<void> = Promise.resolve();
	private acceptingSynchronization = true;
	private lifecycleController = new AbortController();

	constructor(manager: LspManager, maxTrackedDocuments = DEFAULT_MAX_TRACKED_DOCUMENTS) {
		this.manager = manager;
		this.maxTrackedDocuments = maxTrackedDocuments;
		this.manager.onClientStarted((route, recoverySignal) => {
			if (this.manager.isShuttingDown) return Promise.resolve();
			if (this.lifecycleController.signal.aborted) this.lifecycleController = new AbortController();
			this.acceptingSynchronization = true;
			const lifecycleSignal = this.lifecycleController.signal;
			const replaySignal = recoverySignal ? AbortSignal.any([lifecycleSignal, recoverySignal]) : lifecycleSignal;
			const replay = this.enqueue(() => this.replayForClient(route, replaySignal));
			if (!recoverySignal) return replay;
			return replay.catch(async (error) => {
				await this.manager.invalidateSynchronizationClient(route.target, route.client, error, false);
				throw error;
			});
		});
		this.manager.onClientsWillShutdown((routes) => {
			this.acceptingSynchronization = false;
			this.lifecycleController.abort();
			return this.enqueue(() => this.closeForShutdown(routes));
		});
	}

	get trackedCount(): number {
		return this.openDocuments.size;
	}

	getTrackedVersion(uri: string, instanceKey?: string): number | undefined {
		for (const document of this.clientDocuments.values()) {
			if (document.uri === uri && (instanceKey === undefined || document.instanceKey === instanceKey)) {
				return document.version;
			}
		}
		return undefined;
	}

	async handleFileRead(filePath: string, operations: ToolOperations, signal?: AbortSignal): Promise<void> {
		await this.synchronizeFileRead(filePath, operations, signal);
	}

	async synchronizeFileRead(
		filePath: string,
		operations: ToolOperations,
		signal?: AbortSignal,
	): Promise<LspSynchronizationResult> {
		return this.synchronizeFile(filePath, operations, false, signal);
	}

	async handleFileWrite(filePath: string, operations: ToolOperations, signal?: AbortSignal): Promise<void> {
		await this.synchronizeFile(filePath, operations, true, signal);
	}

	closeAll(): Promise<void> {
		this.acceptingSynchronization = false;
		this.lifecycleController.abort();
		return this.enqueue(() => this.closeForShutdown(this.manager.getRunningClients()));
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.synchronizationQueue.then(operation, operation);
		this.synchronizationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async synchronizeFile(
		filePath: string,
		operations: ToolOperations,
		written: boolean,
		signal: AbortSignal | undefined,
	): Promise<LspSynchronizationResult> {
		throwIfAborted(signal);
		if (!this.acceptingSynchronization) return { failures: [], lifecycleCancelled: true };
		await waitForAbort(this.manager.setToolOperations(operations, signal), signal);
		if (!this.acceptingSynchronization) return { failures: [], lifecycleCancelled: true };
		const lifecycleSignal = this.lifecycleController.signal;
		const result = this.enqueue(() => this.synchronize(filePath, operations, written, signal, lifecycleSignal));
		return this.waitForQueuedSynchronization(result, signal, lifecycleSignal);
	}

	private async readSynchronizationContent(
		absolutePath: string,
		context: SynchronizationContentReadContext,
	): Promise<string | undefined> {
		try {
			return await this.waitForSynchronization(
				this.readUtf8(absolutePath, context.operations),
				context.callerSignal,
				context.lifecycleSignal,
			);
		} catch (error) {
			if (this.isSynchronizationAborted(context.callerSignal, context.lifecycleSignal)) throw error;
			for (const { target } of context.routes) {
				this.manager.reportSynchronizationError(target, error);
				context.failures.push(this.synchronizationFailure(target, error));
			}
			return undefined;
		}
	}

	private async synchronize(
		filePath: string,
		operations: ToolOperations,
		written: boolean,
		callerSignal: AbortSignal | undefined,
		lifecycleSignal: AbortSignal,
	): Promise<LspSynchronizationResult> {
		const failures: LspSynchronizationFailure[] = [];
		this.throwIfSynchronizationAborted(callerSignal, lifecycleSignal);
		const absolutePath = resolveOperationsPath(filePath, operations);
		const route = await this.waitForSynchronization(
			this.manager.resolveTargets(absolutePath, callerSignal),
			callerSignal,
			lifecycleSignal,
		);
		this.throwIfSynchronizationAborted(callerSignal, lifecycleSignal);
		const compatibleTargets = route.targets.filter((target) => {
			const reason = this.manager.getSynchronizationCompatibilityReason(target, operations.getBackendInfo?.());
			if (reason) this.manager.reportSynchronizationUnavailable(target, reason);
			return reason === undefined;
		});
		const documentKey = pathComparisonValue(absolutePath);
		const existingDocument = this.openDocuments.get(documentKey);
		const runningTargets = compatibleTargets.flatMap((target) => {
			const client = this.manager.getRunningClient(target.instanceKey);
			return client ? [{ client, target }] : [];
		});
		if (!existingDocument && runningTargets.length === 0) return { failures };

		const content = await this.readSynchronizationContent(absolutePath, {
			operations,
			callerSignal,
			lifecycleSignal,
			routes: runningTargets,
			failures,
		});
		if (content === undefined) return { failures };
		this.throwIfSynchronizationAborted(callerSignal, lifecycleSignal);
		const document: OpenDocument = existingDocument ?? { agentPath: absolutePath, content, operations };
		document.content = content;
		document.operations = operations;
		this.touchOpenDocument(documentKey, document);

		try {
			for (const { client, target } of runningTargets) {
				this.throwIfSynchronizationAborted(callerSignal, lifecycleSignal);
				try {
					await this.synchronizeClient(document, target, client, written, callerSignal, lifecycleSignal);
					this.manager.reportSynchronizationUnavailable(target, undefined);
				} catch (error) {
					if (this.isSynchronizationAborted(callerSignal, lifecycleSignal)) throw error;
					this.manager.reportSynchronizationError(target, error);
					failures.push(this.synchronizationFailure(target, error));
				}
			}
		} finally {
			await this.evictOldestDocuments(lifecycleSignal);
		}
		return { failures };
	}

	private async openClientDocument(
		context: ClientSynchronizationContext,
		key: string,
		saveDocumentKey: string | undefined,
	): Promise<void> {
		const { document, target, client, callerSignal, lifecycleSignal, reconnectOnFailure } = context;
		const capabilities = client.documentSyncCapabilities;
		const state: ClientDocumentState = {
			agentPath: document.agentPath,
			uri: target.serverUri,
			languageId: target.languageId,
			instanceKey: target.instanceKey,
			version: 1,
			client,
			target,
			content: document.content,
			opened: false,
		};
		if (capabilities.openClose) {
			await this.sendSynchronizationNotification(
				target,
				client,
				(signal) => client.didOpen(state.uri, state.languageId, state.version, document.content, signal),
				callerSignal,
				lifecycleSignal,
				reconnectOnFailure,
				saveDocumentKey,
			);
			state.opened = true;
		}
		this.clientDocuments.set(key, state);
		if (context.written && capabilities.save) {
			await this.sendSynchronizationNotification(
				target,
				client,
				(signal) => client.didSave(state.uri, capabilities.saveIncludeText ? document.content : undefined, signal),
				callerSignal,
				lifecycleSignal,
				reconnectOnFailure,
				saveDocumentKey,
			);
		}
	}

	private async synchronizeClient(
		document: OpenDocument,
		target: LspRouteTarget,
		client: LspClient,
		written: boolean,
		callerSignal: AbortSignal | undefined,
		lifecycleSignal: AbortSignal,
		reconnectOnFailure = true,
	): Promise<void> {
		const capabilities = client.documentSyncCapabilities;
		const supported =
			capabilities.openClose || capabilities.change !== TextDocumentSyncKind.None || capabilities.save;
		const key = this.clientDocumentKey(target.instanceKey, document.agentPath);
		const saveDocumentKey = written && capabilities.save ? pathComparisonValue(document.agentPath) : undefined;
		if (!supported) {
			this.clientDocuments.delete(key);
			return;
		}

		let state = this.clientDocuments.get(key);
		if (state?.client === client && state.closing) {
			const closingState = state;
			await this.sendSynchronizationNotification(
				target,
				client,
				(signal) => client.didClose(closingState.uri, signal),
				callerSignal,
				lifecycleSignal,
				reconnectOnFailure,
				saveDocumentKey,
			);
			this.clientDocuments.delete(key);
			state = undefined;
		}
		if (!state || state.client !== client) {
			await this.openClientDocument(
				{ document, target, client, written, callerSignal, lifecycleSignal, reconnectOnFailure },
				key,
				saveDocumentKey,
			);
			return;
		}

		const previousContent = state.content;
		if (previousContent !== document.content && capabilities.change !== TextDocumentSyncKind.None) {
			const nextVersion = state.version + 1;
			this.throwIfSynchronizationAborted(callerSignal, lifecycleSignal);
			if (capabilities.change === TextDocumentSyncKind.Incremental) {
				const change = createIncrementalChange(previousContent, document.content);
				await this.sendSynchronizationNotification(
					target,
					client,
					(signal) => client.didChangeIncremental(state.uri, nextVersion, change.range, change.text, signal),
					callerSignal,
					lifecycleSignal,
					reconnectOnFailure,
					saveDocumentKey,
				);
			} else {
				await this.sendSynchronizationNotification(
					target,
					client,
					(signal) => client.didChange(state.uri, nextVersion, document.content, signal),
					callerSignal,
					lifecycleSignal,
					reconnectOnFailure,
					saveDocumentKey,
				);
			}
			state.version = nextVersion;
			state.content = document.content;
		}
		if (written && capabilities.save) {
			await this.sendSynchronizationNotification(
				target,
				client,
				(signal) => client.didSave(state.uri, capabilities.saveIncludeText ? document.content : undefined, signal),
				callerSignal,
				lifecycleSignal,
				reconnectOnFailure,
				saveDocumentKey,
			);
		}
	}

	private async sendSynchronizationNotification(
		target: LspRouteTarget,
		client: LspClient,
		send: (signal: AbortSignal) => Promise<void>,
		callerSignal: AbortSignal | undefined,
		lifecycleSignal: AbortSignal,
		reconnectOnFailure: boolean,
		saveDocumentKey?: string,
	): Promise<void> {
		this.throwIfSynchronizationAborted(callerSignal, lifecycleSignal);
		const configuredTimeout = target.server.timeouts?.requestMs;
		const timeoutMs =
			configuredTimeout !== undefined && configuredTimeout > 0
				? Math.min(configuredTimeout, MAX_SYNCHRONIZATION_NOTIFICATION_MS)
				: MAX_SYNCHRONIZATION_NOTIFICATION_MS;
		const signals = [lifecycleSignal, AbortSignal.timeout(timeoutMs)];
		if (callerSignal) signals.push(callerSignal);
		const signal = AbortSignal.any(signals);
		try {
			await waitForAbort(send(signal), signal);
		} catch (error) {
			if (saveDocumentKey) {
				const pending = this.pendingSaveReplays.get(target.instanceKey) ?? new Set<string>();
				pending.add(saveDocumentKey);
				this.pendingSaveReplays.set(target.instanceKey, pending);
			}
			this.indeterminateClients.add(client);
			this.discardClientDocuments(client);
			try {
				await this.manager.invalidateSynchronizationClient(
					target,
					client,
					error,
					reconnectOnFailure && !lifecycleSignal.aborted,
				);
			} finally {
				this.indeterminateClients.delete(client);
			}
			throw error;
		}
	}
	private async replayDocumentForClient(
		document: OpenDocument,
		route: LspClientRoute,
		lifecycleSignal: AbortSignal,
	): Promise<void> {
		throwIfAborted(lifecycleSignal);
		const content = await waitForAbort(this.readUtf8(document.agentPath, document.operations), lifecycleSignal);
		throwIfAborted(lifecycleSignal);
		document.content = content;
		const routed = await this.manager.resolveTargets(document.agentPath, lifecycleSignal);
		const target = routed.targets.find((candidate) => candidate.instanceKey === route.target.instanceKey);
		if (!target) return;
		const reason = this.manager.getSynchronizationCompatibilityReason(target, document.operations.getBackendInfo?.());
		if (reason) {
			this.manager.reportSynchronizationUnavailable(target, reason);
			return;
		}
		const pendingSaves = this.pendingSaveReplays.get(target.instanceKey);
		const documentKey = pathComparisonValue(document.agentPath);
		const replaySave = pendingSaves?.has(documentKey) === true;
		await this.synchronizeClient(document, target, route.client, replaySave, undefined, lifecycleSignal, false);
		if (replaySave) pendingSaves?.delete(documentKey);
	}

	private async replayForClient(route: LspClientRoute, lifecycleSignal: AbortSignal): Promise<void> {
		let replayError: unknown;
		for (const document of this.openDocuments.values()) {
			try {
				await this.replayDocumentForClient(document, route, lifecycleSignal);
			} catch (error) {
				if (lifecycleSignal.aborted) throw error;
				replayError = error;
				this.manager.reportSynchronizationError(route.target, error);
				if (route.client.isDisposed) break;
			}
		}
		if (this.pendingSaveReplays.get(route.target.instanceKey)?.size === 0) {
			this.pendingSaveReplays.delete(route.target.instanceKey);
		}
		if (replayError === undefined) this.manager.reportSynchronizationUnavailable(route.target, undefined);
		else this.manager.reportSynchronizationError(route.target, replayError);
	}

	private touchOpenDocument(key: string, document: OpenDocument): void {
		this.openDocuments.delete(key);
		this.openDocuments.set(key, document);
	}

	private clearPendingSaveReplaysForDocument(
		documentKey: string,
		pendingReplaysByDocument: Map<string, Set<string>[]>,
	): void {
		const replaySets = pendingReplaysByDocument.get(documentKey);
		if (!replaySets) return;
		for (const pending of replaySets) pending.delete(documentKey);
		pendingReplaysByDocument.delete(documentKey);
	}

	private async evictOldestDocuments(lifecycleSignal: AbortSignal): Promise<void> {
		if (this.openDocuments.size <= this.maxTrackedDocuments) return;
		const pendingReplaysByDocument = new Map<string, Set<string>[]>();
		for (const pending of this.pendingSaveReplays.values()) {
			for (const documentKey of pending) {
				const replaySets = pendingReplaysByDocument.get(documentKey) ?? [];
				replaySets.push(pending);
				pendingReplaysByDocument.set(documentKey, replaySets);
			}
		}
		while (this.openDocuments.size > this.maxTrackedDocuments) {
			throwIfAborted(lifecycleSignal);
			const oldest = this.openDocuments.entries().next();
			if (oldest.done) return;
			const documentKey = oldest.value[0];
			this.openDocuments.delete(documentKey);
			this.clearPendingSaveReplaysForDocument(documentKey, pendingReplaysByDocument);
			await this.closeDocumentStates(documentKey, undefined, lifecycleSignal);
		}
	}

	private async closeDocumentStates(
		documentKey: string,
		allowedClients: Set<LspClient> | undefined,
		signal: AbortSignal,
	): Promise<void> {
		for (const [key, state] of [...this.clientDocuments.entries()]) {
			if (
				pathComparisonValue(state.agentPath) !== documentKey ||
				(allowedClients && !allowedClients.has(state.client))
			)
				continue;
			state.closing = true;
			if (state.opened && state.client.isInitialized && !state.client.isDisposed) {
				try {
					await this.sendSynchronizationNotification(
						state.target,
						state.client,
						(notificationSignal) => state.client.didClose(state.uri, notificationSignal),
						undefined,
						signal,
						true,
					);
				} catch (error) {
					if (signal.aborted) throw error;
					continue;
				}
			}
			this.clientDocuments.delete(key);
		}
	}

	private discardClientDocuments(client: LspClient): void {
		for (const [key, state] of this.clientDocuments) {
			if (state.client === client) this.clientDocuments.delete(key);
		}
	}

	private async closeForShutdown(routes: LspClientRoute[]): Promise<void> {
		const clients = new Set(routes.map((route) => route.client));
		const states = [...this.clientDocuments.values()].filter((state) => clients.has(state.client));
		this.openDocuments.clear();
		this.clientDocuments.clear();
		await Promise.all(
			states.map(async (state) => {
				if (
					!state.opened ||
					!state.client.isInitialized ||
					state.client.isDisposed ||
					this.indeterminateClients.has(state.client)
				)
					return;
				const configuredTimeout = state.target.server.timeouts?.shutdownMs;
				const timeoutMs =
					configuredTimeout !== undefined && configuredTimeout > 0
						? Math.min(configuredTimeout, MAX_SYNCHRONIZATION_NOTIFICATION_MS)
						: MAX_SYNCHRONIZATION_NOTIFICATION_MS;
				const signal = AbortSignal.timeout(timeoutMs);
				await waitForAbort(state.client.didClose(state.uri, signal), signal).catch(() => undefined);
			}),
		);
		this.indeterminateClients.clear();
		this.pendingSaveReplays.clear();
	}

	private clientDocumentKey(instanceKey: string, uri: string): string {
		return `${instanceKey}\u0000${pathComparisonValue(uri)}`;
	}

	private async readUtf8(absolutePath: string, operations: ToolOperations): Promise<string> {
		return (await operations.readFile(absolutePath)).toString("utf-8");
	}

	private throwIfSynchronizationAborted(callerSignal: AbortSignal | undefined, lifecycleSignal: AbortSignal): void {
		throwIfAborted(lifecycleSignal);
		throwIfAborted(callerSignal);
	}

	private isSynchronizationAborted(callerSignal: AbortSignal | undefined, lifecycleSignal: AbortSignal): boolean {
		return lifecycleSignal.aborted || callerSignal?.aborted === true;
	}

	private async waitForQueuedSynchronization(
		operation: Promise<LspSynchronizationResult>,
		callerSignal: AbortSignal | undefined,
		lifecycleSignal: AbortSignal,
	): Promise<LspSynchronizationResult> {
		try {
			return await waitForAbort(operation, callerSignal);
		} catch (error) {
			if (lifecycleSignal.aborted && callerSignal?.aborted !== true) {
				return { failures: [], lifecycleCancelled: true };
			}
			throw error;
		}
	}

	private synchronizationFailure(target: LspRouteTarget, error: unknown): LspSynchronizationFailure {
		return {
			instanceKey: target.instanceKey,
			serverId: target.serverId,
			reason: error instanceof Error ? error.message : String(error),
		};
	}

	private async waitForSynchronization<T>(
		operation: PromiseLike<T>,
		callerSignal: AbortSignal | undefined,
		lifecycleSignal: AbortSignal,
	): Promise<T> {
		return waitForAbort(waitForAbort(operation, callerSignal), lifecycleSignal);
	}
}
