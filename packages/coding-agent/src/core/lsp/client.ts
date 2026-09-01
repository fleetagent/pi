import type { ImageContent, TextContent } from "@fleetagent/pi-ai";
import type {
	ConfigurationParams,
	Diagnostic,
	InitializeParams,
	InitializeResult,
	PublishDiagnosticsParams,
	Range,
	ServerCapabilities,
	WorkspaceFolder,
} from "vscode-languageserver-protocol";
import { CodeActionKind, ResourceOperationKind, TextDocumentSyncKind } from "vscode-languageserver-protocol";
import {
	CancellationTokenSource,
	createMessageConnection,
	type MessageConnection,
} from "vscode-languageserver-protocol/node.js";
import { waitForAbort } from "./abort.ts";
import type { LspClientInfo, LspJsonValue, LspTraceValue } from "./config.ts";
import { pathApi, pathFlavor, portablePathToFileUri } from "./portable-path.ts";
import type { LspConnectionEndpoint, LspConnectionFactory, LspConnectionHandle } from "./transport.ts";

export type LspShutdownMode = "protocol" | "disconnect";
export type LspClientOwnership = "managed" | "attached";

export interface LspClientOptions {
	serverId: string;
	rootDir: string;
	/** Server-visible workspace URI; defaults to the local rootDir file URI. */
	rootUri?: string;
	languageId: string;
	connectionFactory: LspConnectionFactory;
	connectTimeoutMs?: number;
	initializeTimeoutMs?: number;
	requestTimeoutMs?: number;
	shutdownTimeoutMs?: number;
	shutdownMode?: LspShutdownMode;
	ownership?: LspClientOwnership;
	initializationOptions?: LspJsonValue;
	settings?: LspJsonValue;
	clientInfo?: LspClientInfo;
	locale?: string;
	trace?: LspTraceValue;
	onUnexpectedClose?: (error?: Error) => void;
	onTransportError?: (error: Error) => void;
	onRequestError?: (error: Error) => void;
	onStderr?: (text: string) => void;
}

export type LspConnectionState = "idle" | "connecting" | "initializing" | "running" | "closed" | "failed" | "disposed";
export interface LspDocumentSyncCapabilities {
	openClose: boolean;
	change: TextDocumentSyncKind;
	save: boolean;
	saveIncludeText: boolean;
}

export interface LspClientStartResult {
	capabilities: ServerCapabilities;
	endpoint: LspConnectionEndpoint;
}

type ToolContent = TextContent | ImageContent;

interface OperationDeadline {
	timeoutMs: number | undefined;
	expiresAt: number | undefined;
}

interface OperationWaitOptions {
	signal?: AbortSignal;
	onTimeout?: () => void;
	onAbort?: () => void;
	abortMessage?: string;
}

const MAX_INVALIDATION_CLOSE_MS = 3000;

function createDeadline(timeoutMs: number | undefined): OperationDeadline {
	return {
		timeoutMs,
		expiresAt: timeoutMs !== undefined && timeoutMs > 0 ? Date.now() + timeoutMs : undefined,
	};
}

async function waitForOperation<T>(
	promise: Promise<T>,
	deadline: OperationDeadline,
	description: string,
	options: OperationWaitOptions = {},
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const cleanup = (): void => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
		};
		const succeed = (value: T): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};
		const fail = (error: unknown): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const abort = (): void => {
			fail(new Error(options.abortMessage ?? `${description} was aborted`));
			options.onAbort?.();
		};
		promise.then(succeed, fail);
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		if (!settled && deadline.expiresAt !== undefined) {
			const remainingMs = deadline.expiresAt - Date.now();
			if (remainingMs <= 0) {
				const timeoutError = new Error(`${description} timed out after ${deadline.timeoutMs}ms`);
				fail(timeoutError);
				options.onTimeout?.();
			} else {
				timer = setTimeout(() => {
					const timeoutError = new Error(`${description} timed out after ${deadline.timeoutMs}ms`);
					fail(timeoutError);
					options.onTimeout?.();
				}, remainingMs);
			}
		}
	});
}

function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number | undefined,
	description: string,
	onTimeout?: () => void,
): Promise<T> {
	return waitForOperation(promise, createDeadline(timeoutMs), description, { onTimeout });
}

function settingsForSection(settings: LspJsonValue | undefined, section: string | undefined): LspJsonValue {
	if (settings === undefined) return null;
	if (!section) return settings;
	let current: LspJsonValue = settings;
	for (const segment of section.split(".")) {
		if (
			typeof current !== "object" ||
			current === null ||
			Array.isArray(current) ||
			!Object.hasOwn(current, segment)
		) {
			return null;
		}
		current = current[segment];
	}
	return current;
}

export class LspClient {
	readonly serverId: string;
	readonly languageId: string;
	readonly rootDir: string;
	readonly rootUri: string;

	private readonly options: LspClientOptions;
	private connectionHandle: LspConnectionHandle | undefined;
	private connection: MessageConnection | undefined;
	private capabilities: ServerCapabilities | undefined;
	private diagnostics = new Map<string, Diagnostic[]>();
	private initialized = false;
	private disposed = false;
	private closing = false;
	private startController: AbortController | undefined;
	private startPromise: Promise<LspClientStartResult> | undefined;
	private shutdownPromise: Promise<void> | undefined;
	private lifecycleGeneration = 0;
	private readonly handleClosePromises = new WeakMap<LspConnectionHandle, Promise<void>>();
	private endpoint: LspConnectionEndpoint | undefined;
	private transportError: Error | undefined;
	private requestError: Error | undefined;
	private stderr = "";
	private state: LspConnectionState = "idle";

	constructor(options: LspClientOptions) {
		this.options = options;
		this.serverId = options.serverId;
		this.languageId = options.languageId;
		this.rootDir = options.rootDir;
		this.rootUri = options.rootUri ?? portablePathToFileUri(options.rootDir);
	}

	get isInitialized(): boolean {
		return this.initialized;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	get serverCapabilities(): ServerCapabilities | undefined {
		return this.capabilities;
	}

	get documentSyncCapabilities(): LspDocumentSyncCapabilities {
		const synchronization = this.serverCapabilities?.textDocumentSync;
		if (typeof synchronization === "number") {
			return {
				openClose: synchronization !== TextDocumentSyncKind.None,
				change: synchronization,
				save: false,
				saveIncludeText: false,
			};
		}
		if (!synchronization) {
			return { openClose: false, change: TextDocumentSyncKind.None, save: false, saveIncludeText: false };
		}
		const save = synchronization.save;
		return {
			openClose: synchronization.openClose === true,
			change: synchronization.change ?? TextDocumentSyncKind.None,
			save: save === true || typeof save === "object",
			saveIncludeText: typeof save === "object" && save.includeText === true,
		};
	}

	get connectionEndpoint(): LspConnectionEndpoint | undefined {
		return this.endpoint;
	}

	get lastTransportError(): Error | undefined {
		return this.transportError;
	}

	get lastRequestError(): Error | undefined {
		return this.requestError;
	}

	get stderrOutput(): string {
		return this.stderr;
	}

	get connectionState(): LspConnectionState {
		return this.state;
	}

	get ownership(): LspClientOwnership {
		return this.options.ownership ?? "managed";
	}

	private get workspaceFolder(): WorkspaceFolder {
		return { uri: this.rootUri, name: pathApi(pathFlavor(this.rootDir)).basename(this.rootDir) || this.rootDir };
	}

	getDiagnostics(uri: string): Diagnostic[] {
		return this.diagnostics.get(uri) ?? [];
	}

	getAllDiagnostics(): Map<string, Diagnostic[]> {
		return new Map(this.diagnostics);
	}

	start(): Promise<LspClientStartResult> {
		if (this.startPromise) return this.startPromise;
		this.startPromise = (async () => {
			try {
				return await this.startInternal();
			} finally {
				this.startPromise = undefined;
			}
		})();
		return this.startPromise;
	}

	private async connectForStartup(controller: AbortController): Promise<LspConnectionHandle> {
		let resolvedHandle: LspConnectionHandle | undefined;
		let discardHandle = false;
		const handlePromise = Promise.resolve().then(() =>
			this.options.connectionFactory({
				serverId: this.serverId,
				workspaceRoot: this.rootDir,
				workspaceUri: this.rootUri,
				signal: controller.signal,
				connectTimeoutMs: this.options.connectTimeoutMs,
				onStderr: (text) => {
					this.stderr = `${this.stderr}${text}`.slice(-16_384);
					this.options.onStderr?.(text);
				},
			}),
		);
		void handlePromise.then(
			(handle) => {
				resolvedHandle = handle;
				if (discardHandle) void this.closeConnectionHandle(handle);
			},
			() => undefined,
		);
		try {
			return await waitForOperation(
				handlePromise,
				createDeadline(this.options.connectTimeoutMs),
				`Connecting to LSP server ${this.serverId}`,
				{
					signal: controller.signal,
					onTimeout: () => controller.abort(),
					abortMessage: `LSP client startup for ${this.serverId} was aborted`,
				},
			);
		} catch (error) {
			discardHandle = true;
			controller.abort();
			if (resolvedHandle) void this.closeConnectionHandle(resolvedHandle);
			throw error;
		}
	}

	private attachConnectionHandle(handle: LspConnectionHandle): void {
		this.connectionHandle = handle;
		this.state = "initializing";
		this.endpoint = handle.endpoint;
		handle.onError((error) => {
			if (this.connectionHandle === handle) this.recordTransportError(error);
		});
		handle.onClose(() => {
			if (this.connectionHandle !== handle) return;
			this.initialized = false;
			void this.closeHandle();
			if (!this.closing) this.state = this.disposed ? "disposed" : "closed";
			this.disposeConnection();
			if (!this.disposed && !this.closing) this.options.onUnexpectedClose?.(this.transportError);
		});
		this.connection = createMessageConnection(handle.reader, handle.writer);
		this.registerConnectionHandlers();
		this.connection.listen();
	}

	private createInitializeParams(): InitializeParams {
		return {
			processId: this.ownership === "attached" ? null : process.pid,
			rootUri: this.rootUri,
			workspaceFolders: [this.workspaceFolder],
			capabilities: {
				textDocument: {
					synchronization: { didSave: true, dynamicRegistration: false },
					hover: { contentFormat: ["plaintext", "markdown"] },
					definition: {},
					references: {},
					rename: { prepareSupport: false },
					publishDiagnostics: { relatedInformation: true },
					codeAction: {
						dynamicRegistration: false,
						codeActionLiteralSupport: {
							codeActionKind: {
								valueSet: [
									CodeActionKind.Empty,
									CodeActionKind.QuickFix,
									CodeActionKind.Refactor,
									CodeActionKind.RefactorExtract,
									CodeActionKind.RefactorInline,
									CodeActionKind.RefactorRewrite,
									CodeActionKind.Source,
									CodeActionKind.SourceOrganizeImports,
									CodeActionKind.SourceFixAll,
								],
							},
						},
						isPreferredSupport: true,
						dataSupport: true,
					},
				},
				workspace: {
					configuration: true,
					workspaceFolders: true,
					workspaceEdit: {
						documentChanges: true,
						resourceOperations: [
							ResourceOperationKind.Create,
							ResourceOperationKind.Rename,
							ResourceOperationKind.Delete,
						],
					},
				},
			},
			clientInfo: this.options.clientInfo ?? { name: "@fleetagent/pi-coding-agent" },
			...(this.options.initializationOptions === undefined
				? {}
				: { initializationOptions: this.options.initializationOptions }),
			...(this.options.locale === undefined ? {} : { locale: this.options.locale }),
			...(this.options.trace === undefined ? {} : { trace: this.options.trace }),
		};
	}

	private async initializeConnection(
		generation: number,
		controller: AbortController,
		handle: LspConnectionHandle,
	): Promise<InitializeResult> {
		if (!this.connection) throw new Error(`Connection to LSP server ${this.serverId} closed during initialization`);
		const deadline = createDeadline(this.options.initializeTimeoutMs);
		const description = `Initializing LSP server ${this.serverId}`;
		const cancellation = new CancellationTokenSource();
		let result: InitializeResult;
		try {
			result = await waitForOperation(
				this.connection.sendRequest<InitializeResult>(
					"initialize",
					this.createInitializeParams(),
					cancellation.token,
				),
				deadline,
				description,
				{
					signal: controller.signal,
					onTimeout: () => cancellation.cancel(),
					onAbort: () => cancellation.cancel(),
					abortMessage: `LSP client startup for ${this.serverId} was aborted`,
				},
			);
		} finally {
			cancellation.dispose();
		}
		this.assertStartupCurrent(generation, controller, handle);
		await waitForOperation(this.connection.sendNotification("initialized", {}), deadline, description, {
			signal: controller.signal,
			abortMessage: `LSP client startup for ${this.serverId} was aborted`,
		});
		this.assertStartupCurrent(generation, controller, handle);
		if (this.options.settings !== undefined) {
			await waitForOperation(
				this.connection.sendNotification("workspace/didChangeConfiguration", { settings: this.options.settings }),
				deadline,
				description,
				{ signal: controller.signal, abortMessage: `LSP client startup for ${this.serverId} was aborted` },
			);
		}
		this.assertStartupCurrent(generation, controller, handle);
		return result;
	}

	private async recordStartupFailure(error: unknown): Promise<Error> {
		const failure = error instanceof Error ? error : new Error(String(error));
		if (!this.disposed) {
			this.state = "failed";
			this.recordTransportError(failure);
		}
		this.closing = true;
		this.disposeConnection();
		try {
			await this.closeHandle(
				createDeadline(this.options.shutdownTimeoutMs ?? 3000),
				`Closing connection to LSP server ${this.serverId}`,
			);
		} catch (closeError) {
			this.recordTransportError(closeError instanceof Error ? closeError : new Error(String(closeError)));
		} finally {
			this.closing = false;
		}
		return failure;
	}

	private async startInternal(): Promise<LspClientStartResult> {
		if (this.disposed) throw new Error(`LSP client for ${this.serverId} is disposed`);
		if (this.initialized && this.capabilities && this.endpoint) {
			return { capabilities: this.capabilities, endpoint: this.endpoint };
		}
		const generation = ++this.lifecycleGeneration;
		this.state = "connecting";
		const controller = new AbortController();
		this.startController = controller;
		this.transportError = undefined;
		try {
			const handle = await this.connectForStartup(controller);
			this.assertStartupCurrent(generation, controller);
			this.attachConnectionHandle(handle);
			const result = await this.initializeConnection(generation, controller, handle);
			this.capabilities = result.capabilities;
			this.initialized = true;
			this.state = "running";
			return { capabilities: result.capabilities, endpoint: handle.endpoint };
		} catch (error) {
			throw await this.recordStartupFailure(error);
		} finally {
			if (this.startController === controller) this.startController = undefined;
		}
	}

	private assertStartupCurrent(generation: number, controller: AbortController, handle?: LspConnectionHandle): void {
		if (this.disposed || controller.signal.aborted || this.lifecycleGeneration !== generation) {
			throw new Error(`LSP client startup for ${this.serverId} was aborted`);
		}
		if (handle !== undefined && (this.connectionHandle !== handle || !this.connection)) {
			throw new Error(`Connection to LSP server ${this.serverId} closed during initialization`);
		}
	}

	async sendRequest<TResult>(method: string, params: unknown, signal?: AbortSignal): Promise<TResult> {
		if (!this.connection || !this.initialized) throw new Error(`LSP client for ${this.serverId} is not initialized`);
		if (signal?.aborted) throw new Error(`LSP request ${method} was aborted`);
		const cancellation = new CancellationTokenSource();
		let rejectAbort: ((error: Error) => void) | undefined;
		const abortPromise = new Promise<never>((_resolve, reject) => {
			rejectAbort = reject;
		});
		const onAbort = (): void => {
			cancellation.cancel();
			rejectAbort?.(new Error(`LSP request ${method} was aborted`));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		try {
			return await withTimeout(
				Promise.race([this.connection.sendRequest<TResult>(method, params, cancellation.token), abortPromise]),
				this.options.requestTimeoutMs,
				`LSP request ${method} to ${this.serverId}`,
				() => cancellation.cancel(),
			);
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			this.requestError = failure;
			this.options.onRequestError?.(failure);
			throw failure;
		} finally {
			signal?.removeEventListener("abort", onAbort);
			cancellation.dispose();
		}
	}

	async sendNotification(method: string, params: unknown, signal?: AbortSignal): Promise<void> {
		if (!this.connection || !this.initialized) {
			throw new Error(`LSP client for ${this.serverId} is not initialized`);
		}
		try {
			await waitForAbort(this.connection.sendNotification(method, params), signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			const failure = error instanceof Error ? error : new Error(String(error));
			this.recordTransportError(failure);
			throw failure;
		}
	}

	async didOpen(uri: string, languageId: string, version: number, text: string, signal?: AbortSignal): Promise<void> {
		await this.sendNotification(
			"textDocument/didOpen",
			{
				textDocument: { uri, languageId, version, text },
			},
			signal,
		);
	}

	async didChange(uri: string, version: number, text: string, signal?: AbortSignal): Promise<void> {
		await this.sendNotification(
			"textDocument/didChange",
			{
				textDocument: { uri, version },
				contentChanges: [{ text }],
			},
			signal,
		);
	}

	async didChangeIncremental(
		uri: string,
		version: number,
		range: Range,
		text: string,
		signal?: AbortSignal,
	): Promise<void> {
		await this.sendNotification(
			"textDocument/didChange",
			{
				textDocument: { uri, version },
				contentChanges: [{ range, text }],
			},
			signal,
		);
	}

	async didSave(uri: string, text?: string, signal?: AbortSignal): Promise<void> {
		await this.sendNotification(
			"textDocument/didSave",
			{
				textDocument: { uri },
				...(text === undefined ? {} : { text }),
			},
			signal,
		);
	}

	async didClose(uri: string, signal?: AbortSignal): Promise<void> {
		await this.sendNotification("textDocument/didClose", { textDocument: { uri } }, signal);
	}

	invalidate(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.disposed = true;
		this.lifecycleGeneration++;
		this.state = "disposed";
		this.closing = true;
		this.initialized = false;
		this.startController?.abort();
		this.disposeConnection();
		const configuredTimeout = this.options.shutdownTimeoutMs;
		const timeoutMs =
			configuredTimeout !== undefined && configuredTimeout > 0
				? Math.min(configuredTimeout, MAX_INVALIDATION_CLOSE_MS)
				: MAX_INVALIDATION_CLOSE_MS;
		const invalidation = this.closeHandle(
			createDeadline(timeoutMs),
			`Invalidating connection to LSP server ${this.serverId}`,
		)
			.catch((error) => {
				this.recordTransportError(error instanceof Error ? error : new Error(String(error)));
			})
			.finally(() => {
				this.closing = false;
			});
		this.shutdownPromise = invalidation;
		return invalidation;
	}

	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		if (this.disposed) return Promise.resolve();
		const shutdown = this.shutdownInternal();
		this.shutdownPromise = shutdown;
		return shutdown;
	}

	private async requestServerShutdown(connection: MessageConnection, deadline: OperationDeadline): Promise<void> {
		const cancellation = new CancellationTokenSource();
		try {
			await waitForOperation(
				connection.sendRequest("shutdown", undefined, cancellation.token),
				deadline,
				`Shutting down LSP server ${this.serverId}`,
				{ onTimeout: () => cancellation.cancel() },
			);
		} catch (error) {
			this.recordTransportError(error instanceof Error ? error : new Error(String(error)));
		} finally {
			cancellation.dispose();
		}
	}

	private async notifyServerExit(connection: MessageConnection, deadline: OperationDeadline): Promise<void> {
		try {
			await waitForOperation(
				connection.sendNotification("exit"),
				deadline,
				`Sending exit to LSP server ${this.serverId}`,
			);
			await new Promise((resolve) => setTimeout(resolve, 50));
		} catch (error) {
			this.recordTransportError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private async shutdownInternal(): Promise<void> {
		this.disposed = true;
		this.lifecycleGeneration++;
		this.state = "disposed";
		this.closing = true;
		this.initialized = false;
		this.startController?.abort();
		const deadline = createDeadline(this.options.shutdownTimeoutMs ?? 3000);
		try {
			const connection = this.connection;
			if (connection && this.options.shutdownMode !== "disconnect") {
				await this.requestServerShutdown(connection, deadline);
				await this.notifyServerExit(connection, deadline);
			}
		} finally {
			this.disposeConnection();
			try {
				await this.closeHandle(deadline, `Closing connection to LSP server ${this.serverId}`);
			} catch (error) {
				this.recordTransportError(error instanceof Error ? error : new Error(String(error)));
			}
			this.closing = false;
		}
	}

	private registerConnectionHandlers(): void {
		this.connection?.onNotification("textDocument/publishDiagnostics", (params: PublishDiagnosticsParams) => {
			this.diagnostics.set(params.uri, params.diagnostics);
		});
		this.connection?.onRequest("workspace/configuration", (params: ConfigurationParams) =>
			params.items.map((item) => settingsForSection(this.options.settings, item.section)),
		);
		this.connection?.onRequest("workspace/workspaceFolders", () => [this.workspaceFolder]);
		this.connection?.onError((data) => {
			const candidate = data[0];
			this.recordTransportError(candidate instanceof Error ? candidate : new Error(String(candidate)));
		});
		this.connection?.onClose(() => {
			this.initialized = false;
			if (!this.disposed && !this.closing) this.state = "closed";
		});
	}

	private recordTransportError(error: Error): void {
		this.transportError = error;
		this.options.onTransportError?.(error);
	}

	private closeConnectionHandle(handle: LspConnectionHandle): Promise<void> {
		const existing = this.handleClosePromises.get(handle);
		if (existing) return existing;
		const close = (async () => {
			try {
				await handle.close();
			} catch (error) {
				this.recordTransportError(error instanceof Error ? error : new Error(String(error)));
			}
		})();
		this.handleClosePromises.set(handle, close);
		return close;
	}

	private closeHandle(deadline?: OperationDeadline, description?: string): Promise<void> {
		const handle = this.connectionHandle;
		this.connectionHandle = undefined;
		if (!handle) return Promise.resolve();
		const close = this.closeConnectionHandle(handle);
		return deadline && description ? waitForOperation(close, deadline, description) : close;
	}

	private disposeConnection(): void {
		try {
			this.connection?.dispose();
		} catch {
			// Already disposed.
		}
		this.connection = undefined;
	}
}

export function getTextFromToolContent(content: ToolContent): string | undefined {
	return content.type === "text" ? content.text : undefined;
}
