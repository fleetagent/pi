import { createHash, type Hash, randomBytes } from "node:crypto";
import {
	DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
	decodeCanonicalBase64,
	decodeRemoteWorkspaceMessage,
	getRemoteWorkspaceMethodKind,
	hashRemoteWorkspaceCatalog,
	isRemoteWorkspaceMethod,
	negotiateRemoteWorkspaceHandshake,
	parseRemoteWorkspaceClientMessage,
	parseRemoteWorkspaceRequestParams,
	parseRemoteWorkspaceResult,
	parseRemoteWorkspaceServerMessage,
	REMOTE_WORKSPACE_PROTOCOL_VERSIONS,
	type RemoteWorkspaceCapability,
	type RemoteWorkspaceCatalog,
	type RemoteWorkspaceCatalogChanged,
	type RemoteWorkspaceClientMessage,
	type RemoteWorkspaceErrorCode,
	type RemoteWorkspaceErrorMessage,
	type RemoteWorkspaceExecutionState,
	type RemoteWorkspaceHandshake,
	type RemoteWorkspaceHandshakeAck,
	type RemoteWorkspaceIdentity,
	type RemoteWorkspaceMethod,
	RemoteWorkspaceNegotiationError,
	type RemoteWorkspaceNegotiationOptions,
	type RemoteWorkspaceOperationKind,
	type RemoteWorkspaceProtocolError,
	type RemoteWorkspaceProtocolLimits,
	type RemoteWorkspaceRequest,
	type RemoteWorkspaceResult,
	type RemoteWorkspaceServerMessage,
	type RemoteWorkspaceTransferChunk,
	type RemoteWorkspaceTransferStart,
	type RemoteWorkspaceUpdate,
	RemoteWorkspaceValidationError,
	type RemoteWorkspaceVersionRange,
	validateRemoteWorkspaceCatalog,
	validateRemoteWorkspaceHandshakeAck,
	validateRemoteWorkspaceLocalToolSchemas,
	validateRemoteWorkspaceProtocolLimits,
} from "./contract.ts";

export type RemoteWorkspaceProtocolCloseCode =
	| "protocol_error"
	| "invalid_payload"
	| "message_too_large"
	| "policy_violation"
	| "normal";
export type RemoteWorkspaceCancellationErrorCode = Extract<RemoteWorkspaceErrorCode, "cancelled" | "deadline_exceeded">;

export interface RemoteWorkspaceProtocolCloseReason {
	code: RemoteWorkspaceProtocolCloseCode;
	message: string;
}

/** Transport framing is intentionally outside protocol dispatch. Inbound frames must call receive() with raw payload bytes. */
export interface RemoteWorkspaceProtocolTransport<Message> {
	send(message: Message): Promise<void>;
	close(reason: RemoteWorkspaceProtocolCloseReason): void | Promise<void>;
}

export class RemoteWorkspaceRequestError extends Error {
	readonly code: RemoteWorkspaceErrorCode;
	readonly executionState: RemoteWorkspaceExecutionState;
	readonly retryable: boolean;
	readonly details: unknown;

	constructor(error: RemoteWorkspaceProtocolError) {
		super(error.message);
		this.name = "RemoteWorkspaceRequestError";
		this.code = error.code;
		this.executionState = error.executionState;
		this.retryable = error.retryable;
		this.details = error.details;
	}
}

export class RemoteWorkspaceDisconnectedError extends Error {
	readonly executionState: RemoteWorkspaceExecutionState;

	constructor(message: string, executionState: RemoteWorkspaceExecutionState) {
		super(message);
		this.name = "RemoteWorkspaceDisconnectedError";
		this.executionState = executionState;
	}
}

export class RemoteWorkspaceTerminationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RemoteWorkspaceTerminationError";
	}
}

class RemoteWorkspaceTransportError extends Error {
	constructor(error: unknown) {
		super(error instanceof Error ? error.message : String(error));
		this.name = "RemoteWorkspaceTransportError";
	}
}

export interface RemoteWorkspaceTransferMetadata {
	length: number;
	sha256: string;
}

type RemoteWorkspaceRequestMessage =
	| RemoteWorkspaceUpdate
	| RemoteWorkspaceTransferStart
	| RemoteWorkspaceTransferChunk
	| RemoteWorkspaceErrorMessage
	| RemoteWorkspaceResult;

export type RemoteWorkspaceTypedRequest = RemoteWorkspaceRequest & { method: RemoteWorkspaceMethod };

export type RemoteWorkspaceUploadRequest = RemoteWorkspaceRequest & { method: "transfer.upload" };

export interface RemoteWorkspaceRequestOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	onUpdate?: (update: unknown) => void | Promise<void>;
	onTransferStart?: (metadata: RemoteWorkspaceTransferMetadata) => void | Promise<void>;
	onTransferChunk?: (chunk: Buffer) => void | Promise<void>;
}

export interface RemoteWorkspaceRequestHandle {
	readonly id: string;
	readonly result: Promise<unknown>;
	sendTransferChunk(chunk: Uint8Array): Promise<void>;
	finishTransfer(length: number, sha256: string): Promise<void>;
	cancel(reason?: string): Promise<void>;
}

interface ClientUploadState {
	expectedLength: number;
	expectedSha256: string;
	bytes: number;
	pendingBytes: number;
	chunks: number;
	pendingChunks: number;
	hash: Hash;
	finished: boolean;
	queue: Promise<void>;
}

interface ClientDownloadState {
	expectedLength: number;
	expectedSha256: string;
	bytes: number;
	chunks: number;
	hash: Hash;
}

interface ClientPendingRequest {
	method: RemoteWorkspaceMethod;
	kind: RemoteWorkspaceOperationKind;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	deadlineTimer: NodeJS.Timeout;
	cancelTimer?: NodeJS.Timeout;
	cancelSent: boolean;
	signal?: AbortSignal;
	onAbort?: () => void;
	onUpdate?: (update: unknown) => void;
	onTransferStart?: (metadata: RemoteWorkspaceTransferMetadata) => void;
	onTransferChunk?: (chunk: Buffer) => void;
	nextUpdateSequence: number;
	nextIncomingTransferSequence: number;
	nextOutgoingTransferSequence: number;
	upload?: ClientUploadState;
	download?: ClientDownloadState;
}

export interface RemoteWorkspaceClientProtocolOptions {
	versions?: readonly RemoteWorkspaceVersionRange[];
	requiredCapabilities?: readonly RemoteWorkspaceCapability[];
	optionalCapabilities?: readonly RemoteWorkspaceCapability[];
	receiveLimits?: RemoteWorkspaceProtocolLimits;
	localToolSchemas?: ReadonlyMap<string, string>;
	handshakeTimeoutMs?: number;
	tombstoneMs?: number;
	maxTombstones?: number;
	onCatalogChanged?: (event: RemoteWorkspaceCatalogChanged) => void;
	onCatalogRefreshed?: (catalog: RemoteWorkspaceCatalog) => void | Promise<void>;
}

function classifyValidationClose(error: unknown): RemoteWorkspaceProtocolCloseCode {
	return error instanceof RemoteWorkspaceValidationError && error.message.includes("exceeds")
		? "message_too_large"
		: "invalid_payload";
}

interface PreparedProtocolMessage<Message> {
	message: Message;
	bytes: number;
}

function serializeProtocolMessage(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) throw new Error("Value is not JSON-serializable");
		return serialized;
	} catch (error) {
		throw new RemoteWorkspaceValidationError(
			`Protocol value is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function prepareClientOutbound(
	message: RemoteWorkspaceClientMessage,
	limits: RemoteWorkspaceProtocolLimits,
): PreparedProtocolMessage<RemoteWorkspaceClientMessage> {
	const serialized = serializeProtocolMessage(message);
	const decoded = decodeRemoteWorkspaceMessage(serialized, limits);
	return { message: parseRemoteWorkspaceClientMessage(decoded, limits), bytes: Buffer.byteLength(serialized, "utf8") };
}

function prepareServerOutbound(
	message: RemoteWorkspaceServerMessage,
	limits: RemoteWorkspaceProtocolLimits,
): PreparedProtocolMessage<RemoteWorkspaceServerMessage> {
	const serialized = serializeProtocolMessage(message);
	const decoded = decodeRemoteWorkspaceMessage(serialized, limits);
	return { message: parseRemoteWorkspaceServerMessage(decoded, limits), bytes: Buffer.byteLength(serialized, "utf8") };
}

function cloneCatalog(catalog: RemoteWorkspaceCatalog): RemoteWorkspaceCatalog {
	const cloned = JSON.parse(serializeProtocolMessage(catalog)) as RemoteWorkspaceCatalog;
	validateRemoteWorkspaceCatalog(cloned);
	return cloned;
}

function cloneHandshakeAck(ack: RemoteWorkspaceHandshakeAck): RemoteWorkspaceHandshakeAck {
	return JSON.parse(serializeProtocolMessage(ack)) as RemoteWorkspaceHandshakeAck;
}

const WORKSPACE_IDENTITY_RESULT_METHODS = new Set<RemoteWorkspaceMethod>([
	"workspace.read",
	"workspace.stat",
	"workspace.readdir",
	"workspace.glob",
	"workspace.grep",
	"workspace.detect_image_mime",
	"resource.read",
]);

function cloneWorkspaceIdentity(workspace: RemoteWorkspaceIdentity): RemoteWorkspaceIdentity {
	return JSON.parse(serializeProtocolMessage(workspace)) as RemoteWorkspaceIdentity;
}

function assertResultWorkspaceIdentity(
	method: RemoteWorkspaceMethod,
	result: unknown,
	expected: RemoteWorkspaceIdentity,
): void {
	if (!WORKSPACE_IDENTITY_RESULT_METHODS.has(method)) return;
	const actual = (result as { workspace: RemoteWorkspaceIdentity }).workspace;
	if (actual.id !== expected.id || actual.root !== expected.root || actual.pathFlavor !== expected.pathFlavor) {
		throw new RemoteWorkspaceValidationError(`Result workspace identity does not match negotiation for ${method}`);
	}
}

function validateConfiguredInteger(value: number, label: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new RemoteWorkspaceValidationError(`${label} must be an integer from ${minimum} to ${maximum}`);
	}
	return value;
}

function boundedCloseReason(reason: RemoteWorkspaceProtocolCloseReason): RemoteWorkspaceProtocolCloseReason {
	let message = reason.message;
	while (Buffer.byteLength(message, "utf8") > 120) message = message.slice(0, -1);
	return { code: reason.code, message: message || reason.code };
}

function methodCapability(method: RemoteWorkspaceMethod): RemoteWorkspaceCapability | undefined {
	if (method === "catalog.get" || method === "tool.invoke") return undefined;
	if (method === "lsp.status") return "lsp_status";
	if (method === "transfer.upload" || method === "transfer.download") return "file_transfer";
	if (method === "artifact.read") return "artifacts";
	return "primitive_operations";
}

async function settlesWithinDeadline(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		promise.then(
			() => {
				clearTimeout(timer);
				resolve(true);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function isTransferMethod(method: RemoteWorkspaceMethod): boolean {
	return method === "transfer.upload" || method === "transfer.download" || method === "artifact.read";
}

function payloadByteLength(payload: string | Uint8Array): number {
	return typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : payload.byteLength;
}

export class RemoteWorkspaceClientProtocol {
	private readonly transport: RemoteWorkspaceProtocolTransport<RemoteWorkspaceClientMessage>;
	private readonly versions: readonly RemoteWorkspaceVersionRange[];
	private readonly requiredCapabilities: readonly RemoteWorkspaceCapability[];
	private readonly optionalCapabilities: readonly RemoteWorkspaceCapability[];
	private readonly receiveLimits: RemoteWorkspaceProtocolLimits;
	private localToolSchemas: ReadonlyMap<string, string>;
	private readonly handshakeTimeoutMs: number;
	private readonly tombstoneMs: number;
	private readonly maxTombstones: number;
	private readonly onCatalogChanged: ((event: RemoteWorkspaceCatalogChanged) => void) | undefined;
	private readonly onCatalogRefreshed: ((catalog: RemoteWorkspaceCatalog) => void | Promise<void>) | undefined;
	private readonly connectionPrefix = randomBytes(16).toString("base64url");
	private readonly pending = new Map<string, ClientPendingRequest>();
	private readonly tombstones = new Map<string, number>();
	private nextId = 1;
	private handshakeId: string | undefined;
	private handshakeOffer: RemoteWorkspaceHandshake | undefined;
	private handshakeResolve: ((value: RemoteWorkspaceHandshakeAck) => void) | undefined;
	private handshakeReject: ((error: Error) => void) | undefined;
	private handshakeTimer: NodeJS.Timeout | undefined;
	private negotiated: RemoteWorkspaceHandshakeAck | undefined;
	private latestCatalogEvent: RemoteWorkspaceCatalogChanged | undefined;
	private catalogRefreshPromise: Promise<void> | undefined;
	private catalogRefreshing = false;
	private receiveQueue: Promise<void> = Promise.resolve();
	private sendQueue: Promise<void> = Promise.resolve();
	private pendingReceiveBytes = 0;
	private pendingReceiveMessages = 0;
	private pendingOutboundBytes = 0;
	private pendingOutboundMessages = 0;
	private pendingTransferBytes = 0;
	private closed = false;

	constructor(
		transport: RemoteWorkspaceProtocolTransport<RemoteWorkspaceClientMessage>,
		options: RemoteWorkspaceClientProtocolOptions = {},
	) {
		this.transport = transport;
		this.versions = options.versions ?? REMOTE_WORKSPACE_PROTOCOL_VERSIONS;
		this.requiredCapabilities = options.requiredCapabilities ?? [];
		this.optionalCapabilities = options.optionalCapabilities ?? [];
		this.receiveLimits = {
			...validateRemoteWorkspaceProtocolLimits(options.receiveLimits ?? DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS),
		};
		this.localToolSchemas = new Map(options.localToolSchemas ?? []);
		this.handshakeTimeoutMs = validateConfiguredInteger(
			options.handshakeTimeoutMs ?? 10_000,
			"handshakeTimeoutMs",
			1,
			5 * 60_000,
		);
		this.tombstoneMs = validateConfiguredInteger(
			options.tombstoneMs ?? 5 * 60 * 1000,
			"tombstoneMs",
			1,
			24 * 60 * 60 * 1000,
		);
		this.maxTombstones = validateConfiguredInteger(options.maxTombstones ?? 65_536, "maxTombstones", 1, 1_000_000);
		this.onCatalogChanged = options.onCatalogChanged;
		this.onCatalogRefreshed = options.onCatalogRefreshed;
	}

	get handshake(): RemoteWorkspaceHandshakeAck | undefined {
		return this.negotiated ? cloneHandshakeAck(this.negotiated) : undefined;
	}

	setLocalToolSchemas(schemas: ReadonlyMap<string, string>): void {
		const copy = new Map(schemas);
		if (this.negotiated) validateRemoteWorkspaceLocalToolSchemas(this.negotiated.catalog, copy);
		this.localToolSchemas = copy;
	}

	async start(): Promise<RemoteWorkspaceHandshakeAck> {
		if (this.closed) throw new Error("Remote workspace protocol client is closed");
		if (this.negotiated) return cloneHandshakeAck(this.negotiated);
		if (this.handshakeResolve) throw new Error("Remote workspace protocol handshake is already in progress");
		const id = this.createId();
		const offer: RemoteWorkspaceHandshake = {
			type: "handshake",
			id,
			versions: this.versions.map((version) => ({ ...version })),
			requiredCapabilities: [...this.requiredCapabilities],
			optionalCapabilities: [...this.optionalCapabilities],
			receiveLimits: { ...this.receiveLimits },
		};
		this.handshakeId = id;
		this.handshakeOffer = offer;
		const result = new Promise<RemoteWorkspaceHandshakeAck>((resolve, reject) => {
			this.handshakeResolve = resolve;
			this.handshakeReject = reject;
			this.handshakeTimer = setTimeout(() => {
				this.failHandshake(new Error("Remote workspace handshake timed out"));
				void this.closeWithReason({ code: "policy_violation", message: "Handshake timed out" }).catch(
					() => undefined,
				);
			}, this.handshakeTimeoutMs);
		});
		try {
			await this.send(offer);
		} catch (error) {
			this.failHandshake(error instanceof Error ? error : new Error(String(error)));
			await this.closeWithReason({ code: "protocol_error", message: "Handshake send failed" });
		}
		return result;
	}

	waitForCatalogRefresh(): Promise<void> {
		return this.catalogRefreshPromise ?? Promise.resolve();
	}

	request(
		method: RemoteWorkspaceMethod,
		params: unknown,
		options: RemoteWorkspaceRequestOptions = {},
	): Promise<unknown> {
		if (method === "tool.invoke" && this.catalogRefreshPromise) {
			return this.catalogRefreshPromise.then(() => this.beginRequest(method, params, options).result);
		}
		return this.beginRequest(method, params, options).result;
	}

	beginRequest(
		method: RemoteWorkspaceMethod,
		params: unknown,
		options: RemoteWorkspaceRequestOptions = {},
	): RemoteWorkspaceRequestHandle {
		if (this.closed) throw new Error("Remote workspace protocol client is closed");
		const negotiated = this.negotiated;
		if (!negotiated) throw new Error("Remote workspace protocol handshake has not completed");
		if (method === "tool.invoke" && this.catalogRefreshing) {
			throw new Error("Remote workspace tool catalog refresh is in progress");
		}
		parseRemoteWorkspaceRequestParams(method, params, negotiated.limits);
		this.assertMethodAvailable(method, params, negotiated);
		if (this.pending.size >= negotiated.limits.maxActiveRequests) {
			throw new Error("Remote workspace active request limit reached");
		}
		if (isTransferMethod(method) && this.activeTransferCount() >= negotiated.limits.maxActiveTransfers) {
			throw new Error("Remote workspace active transfer limit reached");
		}
		const timeoutMs = options.timeoutMs ?? negotiated.limits.maxRequestMs;
		if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > negotiated.limits.maxRequestMs) {
			throw new Error(`Invalid remote workspace timeout: ${timeoutMs}`);
		}
		if (options.signal?.aborted) throw new Error("Remote workspace request aborted before send");
		const id = this.createId();
		let resolveResult: (value: unknown) => void = () => undefined;
		let rejectResult: (error: Error) => void = () => undefined;
		const result = new Promise<unknown>((resolve, reject) => {
			resolveResult = resolve;
			rejectResult = reject;
		});
		const kind = this.requestKind(method);
		const pending: ClientPendingRequest = {
			method,
			kind,
			resolve: resolveResult,
			reject: rejectResult,
			deadlineTimer: setTimeout(() => {
				void this.requestCancellation(id, "deadline_exceeded", "Remote workspace request timed out");
			}, timeoutMs + 25),
			cancelSent: false,
			signal: options.signal,
			onUpdate: options.onUpdate,
			onTransferStart: options.onTransferStart,
			onTransferChunk: options.onTransferChunk,
			nextUpdateSequence: 0,
			nextIncomingTransferSequence: 0,
			nextOutgoingTransferSequence: 0,
			...(method === "transfer.upload" ? { upload: this.createClientUploadState(params) } : {}),
		};
		if (options.signal) {
			pending.onAbort = () => {
				void this.requestCancellation(id, "cancelled", "Remote workspace request cancelled");
			};
			options.signal.addEventListener("abort", pending.onAbort, { once: true });
		}
		this.pending.set(id, pending);
		const request: RemoteWorkspaceRequest = { type: "request", id, method, timeoutMs, params };
		void this.send(request).catch((error: unknown) => this.handleTransportFailure(error));
		return {
			id,
			result,
			sendTransferChunk: (chunk) => this.queueUploadChunk(id, chunk),
			finishTransfer: (length, sha256) => this.queueUploadFinish(id, length, sha256),
			cancel: (reason) => this.requestCancellation(id, "cancelled", reason ?? "Remote workspace request cancelled"),
		};
	}

	receive(payload: string | Uint8Array): Promise<void> {
		if (this.closed) return Promise.resolve();
		const limits = this.negotiated?.limits ?? this.receiveLimits;
		const bytes = payloadByteLength(payload);
		if (
			bytes > limits.maxMessageBytes ||
			this.pendingReceiveMessages >= limits.maxPendingInboundMessages ||
			this.pendingReceiveBytes + bytes > limits.maxPendingInboundBytes
		) {
			return this.protocolFailure(
				new Error("Remote workspace inbound queue exceeds negotiated limits"),
				"message_too_large",
			);
		}
		const queuedPayload = typeof payload === "string" ? payload : Uint8Array.from(payload);
		this.pendingReceiveMessages++;
		this.pendingReceiveBytes += bytes;
		const operation = this.receiveQueue.then(() => this.receivePayload(queuedPayload));
		const tracked = operation.finally(() => {
			this.pendingReceiveMessages--;
			this.pendingReceiveBytes -= bytes;
		});
		this.receiveQueue = tracked.catch(() => undefined);
		return tracked;
	}

	async disconnect(message = "Remote workspace connection closed"): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.failHandshake(new RemoteWorkspaceDisconnectedError(message, "not_started"));
		for (const [id, pending] of this.pending) {
			const state = pending.kind === "read" ? "not_started" : "indeterminate";
			this.rejectPending(id, new RemoteWorkspaceDisconnectedError(message, state), true);
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		await this.closeWithReason({ code: "normal", message: "Client closed" });
	}

	private async decodeServerMessage(payload: string | Uint8Array): Promise<RemoteWorkspaceServerMessage | undefined> {
		try {
			const limits = this.negotiated?.limits ?? this.receiveLimits;
			const decoded = decodeRemoteWorkspaceMessage(payload, limits);
			return parseRemoteWorkspaceServerMessage(decoded, limits);
		} catch (error) {
			await this.protocolFailure(error, classifyValidationClose(error));
			return undefined;
		}
	}

	private async handleHandshakeAck(message: RemoteWorkspaceHandshakeAck): Promise<void> {
		if (!this.handshakeId || message.id !== this.handshakeId || !this.handshakeOffer || !this.handshakeResolve) {
			await this.protocolFailure(new Error("Unexpected handshake response"));
			return;
		}
		try {
			const ack = validateRemoteWorkspaceHandshakeAck(message, this.handshakeOffer, this.localToolSchemas);
			this.negotiated = cloneHandshakeAck(ack);
			const resolve = this.handshakeResolve;
			this.clearHandshake();
			this.addTombstone(message.id);
			resolve(cloneHandshakeAck(ack));
		} catch (error) {
			this.failHandshake(error instanceof Error ? error : new Error(String(error)));
			await this.closeWithReason({ code: "protocol_error", message: "Invalid handshake response" });
		}
	}

	private async handleCatalogChanged(message: RemoteWorkspaceCatalogChanged): Promise<void> {
		if (!this.negotiated?.capabilities.includes("catalog_refresh")) {
			await this.protocolFailure(new Error("Unnegotiated catalog event"));
			return;
		}
		this.catalogRefreshing = true;
		try {
			this.onCatalogChanged?.(message);
		} catch (error) {
			await this.protocolFailure(error);
			return;
		}
		this.latestCatalogEvent = message;
		this.scheduleCatalogRefresh();
	}

	private handleHandshakeError(message: RemoteWorkspaceErrorMessage): boolean {
		if (!this.handshakeId || message.id !== this.handshakeId) return false;
		this.addTombstone(message.id);
		this.failHandshake(new RemoteWorkspaceRequestError(message.error));
		return true;
	}

	private async findPendingRequest(message: RemoteWorkspaceRequestMessage): Promise<ClientPendingRequest | undefined> {
		const pending = this.pending.get(message.id);
		if (pending) return pending;
		this.pruneTombstones();
		if (!this.tombstones.has(message.id)) {
			await this.protocolFailure(new Error(`Response for unknown request ID: ${message.id}`));
		}
		return undefined;
	}

	private async handleRequestUpdate(message: RemoteWorkspaceUpdate, pending: ClientPendingRequest): Promise<void> {
		if (!this.negotiated?.capabilities.includes("tool_updates") || message.sequence !== pending.nextUpdateSequence) {
			await this.protocolFailure(new Error(`Out-of-order or unnegotiated update for request ${message.id}`));
			return;
		}
		pending.nextUpdateSequence++;
		try {
			await pending.onUpdate?.(message.update);
		} catch (error) {
			await this.failClientCallback(message.id, error);
		}
	}

	private async handleTransferStart(
		message: RemoteWorkspaceTransferStart,
		pending: ClientPendingRequest,
	): Promise<void> {
		if (
			(pending.method !== "transfer.download" && pending.method !== "artifact.read") ||
			pending.download ||
			message.length > (this.negotiated?.limits.maxTransferBytes ?? 0)
		) {
			await this.protocolFailure(new Error(`Invalid transfer start for ${pending.method}`));
			return;
		}
		pending.download = {
			expectedLength: message.length,
			expectedSha256: message.sha256,
			bytes: 0,
			chunks: 0,
			hash: createHash("sha256"),
		};
		try {
			await pending.onTransferStart?.({ length: message.length, sha256: message.sha256 });
		} catch (error) {
			await this.failClientCallback(message.id, error);
		}
	}

	private async handleTransferChunk(
		message: RemoteWorkspaceTransferChunk,
		pending: ClientPendingRequest,
	): Promise<void> {
		const download = pending.download;
		if (!download || message.sequence !== pending.nextIncomingTransferSequence) {
			await this.protocolFailure(new Error(`Out-of-order transfer chunk for request ${message.id}`));
			return;
		}
		const limits = this.negotiated?.limits ?? this.receiveLimits;
		let chunk: Buffer;
		try {
			chunk = decodeCanonicalBase64(message.dataBase64, limits.maxTransferChunkBytes);
		} catch (error) {
			await this.protocolFailure(error, "invalid_payload");
			return;
		}
		if (
			download.chunks + 1 > limits.maxTransferChunks ||
			download.bytes + chunk.byteLength > limits.maxTransferBytes ||
			download.bytes + chunk.byteLength > download.expectedLength
		) {
			await this.protocolFailure(
				new Error(`Transfer exceeds declared or negotiated limits for request ${message.id}`),
				"message_too_large",
			);
			return;
		}
		download.chunks++;
		download.bytes += chunk.byteLength;
		download.hash.update(chunk);
		pending.nextIncomingTransferSequence++;
		try {
			await pending.onTransferChunk?.(chunk);
		} catch (error) {
			await this.failClientCallback(message.id, error);
		}
	}

	private async handleRequestResult(message: RemoteWorkspaceResult, pending: ClientPendingRequest): Promise<void> {
		try {
			const limits = this.negotiated?.limits ?? this.receiveLimits;
			const result = parseRemoteWorkspaceResult(pending.method, message.result, limits);
			assertResultWorkspaceIdentity(pending.method, result, this.negotiated!.workspace);
			this.verifyClientTransferResult(pending, result);
			this.resolvePending(message.id, result);
		} catch (error) {
			await this.protocolFailure(error);
		}
	}

	private async handlePendingMessage(
		message: RemoteWorkspaceRequestMessage,
		pending: ClientPendingRequest,
	): Promise<void> {
		switch (message.type) {
			case "update":
				await this.handleRequestUpdate(message, pending);
				return;
			case "transfer_start":
				await this.handleTransferStart(message, pending);
				return;
			case "transfer_chunk":
				await this.handleTransferChunk(message, pending);
				return;
			case "error":
				this.rejectPending(message.id, new RemoteWorkspaceRequestError(message.error), true);
				return;
			case "result":
				await this.handleRequestResult(message, pending);
				return;
		}
	}

	private async receivePayload(payload: string | Uint8Array): Promise<void> {
		if (this.closed) return;
		const message = await this.decodeServerMessage(payload);
		if (!message) return;
		if (message.type === "handshake_ack") {
			await this.handleHandshakeAck(message);
			return;
		}
		if (message.type === "catalog_changed") {
			await this.handleCatalogChanged(message);
			return;
		}
		if (message.type === "error" && this.handleHandshakeError(message)) return;
		const pending = await this.findPendingRequest(message);
		if (!pending) return;
		await this.handlePendingMessage(message, pending);
	}

	private assertMethodAvailable(
		method: RemoteWorkspaceMethod,
		params: unknown,
		ack: RemoteWorkspaceHandshakeAck,
	): void {
		const capabilities = new Set(ack.capabilities);
		const capability = methodCapability(method);
		if (capability && !capabilities.has(capability)) {
			throw new Error(`Remote workspace capability was not negotiated: ${capability}`);
		}
		if (method === "artifact.read" && !capabilities.has("file_transfer")) {
			throw new Error("Remote workspace artifact reads require file transfer capability");
		}
		if (method !== "catalog.get" && method !== "tool.invoke" && !ack.catalog.operations.includes(method)) {
			throw new Error(`Remote workspace operation is not available: ${method}`);
		}
		if (method !== "tool.invoke") return;
		const invocation = params as { toolName: string; schemaHash: string };
		const remoteTool = ack.catalog.tools.find((tool) => tool.name === invocation.toolName);
		const localHash = this.localToolSchemas.get(invocation.toolName);
		if (!remoteTool || !localHash)
			throw new Error(`Remote tool has no matching local canonical definition: ${invocation.toolName}`);
		for (const featureFlag of remoteTool.featureFlags) {
			if (!capabilities.has(featureFlag)) {
				throw new Error(`Remote tool requires an unnegotiated capability: ${featureFlag}`);
			}
		}
		if (remoteTool.schemaHash !== localHash || invocation.schemaHash !== localHash) {
			throw new Error(`Remote tool schema does not match the local canonical definition: ${invocation.toolName}`);
		}
	}

	private requestKind(method: RemoteWorkspaceMethod): RemoteWorkspaceOperationKind {
		return method === "tool.invoke" ? "mutation" : getRemoteWorkspaceMethodKind(method);
	}

	private createClientUploadState(params: unknown): ClientUploadState {
		const upload = params as { length: number; sha256: string };
		if (upload.length > (this.negotiated?.limits.maxTransferBytes ?? 0)) {
			throw new Error("Remote workspace upload exceeds negotiated total-byte limit");
		}
		return {
			expectedLength: upload.length,
			expectedSha256: upload.sha256,
			bytes: 0,
			pendingBytes: 0,
			chunks: 0,
			pendingChunks: 0,
			hash: createHash("sha256"),
			finished: false,
			queue: Promise.resolve(),
		};
	}

	private queueUploadChunk(id: string, chunk: Uint8Array): Promise<void> {
		const pending = this.requireUploadRequest(id);
		const upload = pending.upload!;
		const limits = this.negotiated!.limits;
		if (chunk.byteLength > limits.maxTransferChunkBytes) {
			throw new Error("Remote workspace transfer chunk exceeds limit");
		}
		if (
			this.pendingTransferBytes + chunk.byteLength > limits.maxPendingTransferBytes ||
			upload.pendingBytes + chunk.byteLength > limits.maxPendingTransferBytes ||
			upload.bytes + upload.pendingBytes + chunk.byteLength > limits.maxTransferBytes ||
			upload.bytes + upload.pendingBytes + chunk.byteLength > upload.expectedLength ||
			upload.chunks + upload.pendingChunks + 1 > limits.maxTransferChunks
		) {
			throw new Error("Remote workspace pending upload exceeds negotiated limits");
		}
		const copiedChunk = Buffer.from(chunk);
		upload.pendingBytes += copiedChunk.byteLength;
		this.pendingTransferBytes += copiedChunk.byteLength;
		upload.pendingChunks++;
		const operation = upload.queue.then(async () => {
			try {
				if (upload.finished) throw new Error("Remote workspace upload is already finished");
				await this.send({
					type: "transfer_chunk",
					id,
					sequence: pending.nextOutgoingTransferSequence,
					dataBase64: copiedChunk.toString("base64"),
				});
				pending.nextOutgoingTransferSequence++;
				upload.chunks++;
				upload.bytes += copiedChunk.byteLength;
				upload.hash.update(copiedChunk);
			} finally {
				upload.pendingBytes -= copiedChunk.byteLength;
				this.pendingTransferBytes -= copiedChunk.byteLength;
				upload.pendingChunks--;
			}
		});
		upload.queue = operation.catch(() => undefined);
		return operation.catch(async (error: unknown) => {
			if (error instanceof RemoteWorkspaceTransportError) await this.handleTransportFailure(error);
			else await this.requestCancellation(id, "cancelled", error instanceof Error ? error.message : String(error));
			throw error;
		});
	}

	private queueUploadFinish(id: string, length: number, sha256: string): Promise<void> {
		const pending = this.requireUploadRequest(id);
		const upload = pending.upload!;
		const operation = upload.queue.then(async () => {
			if (upload.finished) throw new Error("Remote workspace upload is already finished");
			const digest = upload.hash.digest("hex");
			if (
				length !== upload.expectedLength ||
				sha256 !== upload.expectedSha256 ||
				upload.bytes !== upload.expectedLength ||
				digest !== upload.expectedSha256
			) {
				throw new Error("Remote workspace upload length or SHA-256 does not match its declaration");
			}
			upload.finished = true;
			await this.send({ type: "transfer_finish", id, length, sha256 });
		});
		upload.queue = operation.catch(() => undefined);
		return operation.catch(async (error: unknown) => {
			if (error instanceof RemoteWorkspaceTransportError) await this.handleTransportFailure(error);
			else await this.requestCancellation(id, "cancelled", error instanceof Error ? error.message : String(error));
			throw error;
		});
	}

	private verifyClientTransferResult(pending: ClientPendingRequest, result: unknown): void {
		if (pending.method === "transfer.upload") {
			const upload = pending.upload;
			const metadata = result as { length: number; sha256: string };
			if (
				!upload?.finished ||
				metadata.length !== upload.expectedLength ||
				metadata.sha256 !== upload.expectedSha256
			) {
				throw new RemoteWorkspaceValidationError("Upload terminal result does not match the verified upload");
			}
			return;
		}
		if (pending.method !== "transfer.download" && pending.method !== "artifact.read") return;
		const download = pending.download;
		const metadata = result as { length: number; sha256: string };
		if (!download) throw new RemoteWorkspaceValidationError("Download completed without transfer metadata");
		const digest = download.hash.digest("hex");
		if (
			download.bytes !== download.expectedLength ||
			digest !== download.expectedSha256 ||
			metadata.length !== download.expectedLength ||
			metadata.sha256 !== download.expectedSha256
		) {
			throw new RemoteWorkspaceValidationError("Download length or SHA-256 verification failed");
		}
	}

	private scheduleCatalogRefresh(): void {
		if (this.catalogRefreshPromise || this.closed) return;
		this.catalogRefreshPromise = Promise.resolve()
			.then(async () => {
				while (this.latestCatalogEvent && !this.closed) {
					const expected = this.latestCatalogEvent;
					this.latestCatalogEvent = undefined;
					const catalog = (await this.beginRequest("catalog.get", {}).result) as RemoteWorkspaceCatalog;
					validateRemoteWorkspaceCatalog(catalog);
					validateRemoteWorkspaceLocalToolSchemas(catalog, this.localToolSchemas);
					const catalogHash = hashRemoteWorkspaceCatalog(catalog);
					if (catalog.generation !== expected.generation || catalogHash !== expected.catalogHash) {
						if (this.latestCatalogEvent) continue;
						throw new RemoteWorkspaceValidationError("Catalog refresh does not match the advertised generation");
					}
					if (!this.negotiated) throw new Error("Remote workspace handshake disappeared during refresh");
					this.negotiated = { ...this.negotiated, catalog, catalogHash };
					await this.onCatalogRefreshed?.(cloneCatalog(catalog));
				}
			})
			.catch((error: unknown) => this.protocolFailure(error))
			.finally(() => {
				this.catalogRefreshPromise = undefined;
				if (this.latestCatalogEvent && !this.closed) this.scheduleCatalogRefresh();
				else this.catalogRefreshing = false;
			});
	}

	private activeTransferCount(): number {
		let count = 0;
		for (const pending of this.pending.values()) if (isTransferMethod(pending.method)) count++;
		return count;
	}

	private createId(): string {
		return `${this.connectionPrefix}:${this.nextId++}`;
	}

	private requireUploadRequest(id: string): ClientPendingRequest {
		const pending = this.pending.get(id);
		if (!pending?.upload || pending.method !== "transfer.upload") throw new Error(`No active upload request: ${id}`);
		return pending;
	}

	private async requestCancellation(
		id: string,
		code: RemoteWorkspaceCancellationErrorCode,
		message: string,
	): Promise<void> {
		const pending = this.pending.get(id);
		if (!pending || pending.cancelSent) return;
		pending.cancelSent = true;
		const cancellationMs = this.negotiated?.limits.maxCancellationMs ?? 1000;
		pending.cancelTimer = setTimeout(() => {
			const executionState = pending.kind === "read" ? "not_started" : "indeterminate";
			this.rejectPending(
				id,
				new RemoteWorkspaceRequestError({ code, message, executionState, retryable: false }),
				true,
			);
			void this.closeWithReason({
				code: "policy_violation",
				message: `Remote workspace cancellation was not acknowledged: ${id}`,
			}).catch(() => this.disconnect("Remote workspace cancellation was not acknowledged"));
		}, cancellationMs + 500);
		try {
			const sent = await settlesWithinDeadline(
				this.send({ type: "cancel", id, reason: message }),
				cancellationMs + 250,
			);
			if (!sent) throw new RemoteWorkspaceTransportError("Cancellation send timed out");
		} catch (error) {
			await this.handleTransportFailure(error);
			return;
		}
		if (!this.pending.has(id) && pending.cancelTimer) clearTimeout(pending.cancelTimer);
	}

	private async failClientCallback(id: string, error: unknown): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		const executionState = this.pending.get(id)?.kind === "read" ? "not_started" : "indeterminate";
		await this.requestCancellation(id, "cancelled", "Client callback failed");
		this.rejectPending(
			id,
			new RemoteWorkspaceRequestError({
				code: "internal_error",
				message: `Remote workspace client callback failed: ${message}`,
				executionState,
				retryable: false,
			}),
			true,
		);
		await this.closeWithReason({
			code: "policy_violation",
			message: `Remote workspace client callback failed for ${id}`,
		}).catch(() => this.disconnect("Remote workspace client callback failed"));
	}

	private resolvePending(id: string, value: unknown): void {
		const pending = this.takePending(id);
		if (pending) pending.resolve(value);
	}

	private rejectPending(id: string, error: Error, tombstone: boolean): void {
		const pending = this.takePending(id, tombstone);
		if (pending) pending.reject(error);
	}

	private takePending(id: string, tombstone = true): ClientPendingRequest | undefined {
		const pending = this.pending.get(id);
		if (!pending) return undefined;
		this.pending.delete(id);
		clearTimeout(pending.deadlineTimer);
		if (pending.cancelTimer) clearTimeout(pending.cancelTimer);
		if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
		if (tombstone) this.addTombstone(id);
		return pending;
	}

	private addTombstone(id: string): void {
		this.pruneTombstones();
		if (this.tombstones.size >= this.maxTombstones) {
			void this.protocolFailure(new Error("Remote workspace tombstone limit exceeded"), "policy_violation").catch(
				() => undefined,
			);
			return;
		}
		this.tombstones.set(id, performance.now() + this.tombstoneMs);
	}

	private pruneTombstones(): void {
		const now = performance.now();
		for (const [id, expiresAt] of this.tombstones) if (expiresAt <= now) this.tombstones.delete(id);
	}

	private clearHandshake(): void {
		if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
		this.handshakeTimer = undefined;
		this.handshakeId = undefined;
		this.handshakeOffer = undefined;
		this.handshakeResolve = undefined;
		this.handshakeReject = undefined;
	}

	private failHandshake(error: Error): void {
		const reject = this.handshakeReject;
		this.clearHandshake();
		reject?.(error);
	}

	private send(message: RemoteWorkspaceClientMessage): Promise<void> {
		const limits = this.negotiated?.limits ?? this.receiveLimits;
		const prepared = prepareClientOutbound(message, limits);
		const estimatedBytes = prepared.bytes;
		if (
			this.pendingOutboundMessages >= limits.maxPendingOutboundMessages ||
			this.pendingOutboundBytes + estimatedBytes > limits.maxPendingOutboundBytes
		) {
			return Promise.reject(
				new RemoteWorkspaceValidationError("Remote workspace client outbound queue exceeds limits"),
			);
		}
		this.pendingOutboundMessages++;
		this.pendingOutboundBytes += estimatedBytes;
		const operation = this.sendQueue.then(async () => {
			if (this.closed) throw new RemoteWorkspaceTransportError("Remote workspace protocol client is closed");
			try {
				const sent = await settlesWithinDeadline(this.transport.send(prepared.message), limits.maxTransportSendMs);
				if (!sent) throw new RemoteWorkspaceTransportError("Remote workspace client transport send timed out");
			} catch (error) {
				throw error instanceof RemoteWorkspaceTransportError ? error : new RemoteWorkspaceTransportError(error);
			}
		});
		const tracked = operation.finally(() => {
			this.pendingOutboundMessages--;
			this.pendingOutboundBytes -= estimatedBytes;
		});
		this.sendQueue = tracked.catch(() => undefined);
		return tracked;
	}

	private async handleTransportFailure(error: unknown): Promise<void> {
		const message = `Remote workspace transport failed: ${error instanceof Error ? error.message : String(error)}`;
		try {
			await this.closeWithReason({ code: "protocol_error", message });
		} catch {
			await this.disconnect(message);
		}
	}

	private async protocolFailure(
		error: unknown,
		code: RemoteWorkspaceProtocolCloseCode = "protocol_error",
	): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		try {
			await this.closeWithReason({ code, message });
		} catch {
			await this.disconnect(message);
		}
	}

	private async closeWithReason(reason: RemoteWorkspaceProtocolCloseReason): Promise<void> {
		if (this.closed) return;
		await this.disconnect(reason.message);
		const sendDeadline = this.negotiated?.limits.maxTransportSendMs ?? this.receiveLimits.maxTransportSendMs;
		const sendsStopped = await settlesWithinDeadline(this.sendQueue, sendDeadline);
		const closed = await settlesWithinDeadline(
			Promise.resolve(this.transport.close(boundedCloseReason(reason))),
			sendDeadline,
		);
		if (!sendsStopped || !closed) {
			throw new RemoteWorkspaceTerminationError("Remote workspace client transport shutdown timed out");
		}
	}
}

export interface RemoteWorkspaceServerRequestContext {
	readonly signal: AbortSignal;
	readonly request: RemoteWorkspaceTypedRequest;
	markSideEffectStarted(): void;
	markCommitted(): void;
	sendUpdate(update: unknown): Promise<void>;
	startTransfer(length: number, sha256: string): Promise<void>;
	sendTransferChunk(chunk: Uint8Array): Promise<void>;
}

export interface RemoteWorkspaceServerHandler {
	handleRequest(request: RemoteWorkspaceTypedRequest, context: RemoteWorkspaceServerRequestContext): Promise<unknown>;
	handleUploadChunk?(
		request: RemoteWorkspaceUploadRequest,
		chunk: Buffer,
		sequence: number,
		context: RemoteWorkspaceServerRequestContext,
	): Promise<void>;
	handleUploadFinish?(
		request: RemoteWorkspaceUploadRequest,
		metadata: RemoteWorkspaceTransferMetadata,
		context: RemoteWorkspaceServerRequestContext,
	): Promise<void>;
	validateToolArguments(toolName: string, value: unknown): boolean;
}

export interface RemoteWorkspaceServerProtocolOptions {
	workspace: RemoteWorkspaceIdentity;
	catalog: RemoteWorkspaceCatalog;
	capabilities: readonly string[];
	requiredClientCapabilities?: readonly string[];
	versions?: readonly RemoteWorkspaceVersionRange[];
	limits?: RemoteWorkspaceProtocolLimits;
	backendLabel?: string;
	invalidRequestStrikes?: number;
	tombstoneMs?: number;
	maxTombstones?: number;
}

interface ServerTransferState {
	expectedLength: number;
	expectedSha256: string;
	bytes: number;
	pendingBytes: number;
	chunks: number;
	hash: Hash;
	finishing: boolean;
	finished: boolean;
}

interface ServerActiveRequest {
	request: RemoteWorkspaceTypedRequest;
	controller: AbortController;
	context: RemoteWorkspaceServerRequestContext;
	timer: NodeJS.Timeout;
	kind: RemoteWorkspaceOperationKind;
	sideEffectStarted: boolean;
	committed: boolean;
	nextUpdateSequence: number;
	nextIncomingTransferSequence: number;
	nextOutgoingTransferSequence: number;
	pendingOutgoingTransferBytes: number;
	incomingTransfer?: ServerTransferState;
	outgoingTransfer?: ServerTransferState;
	inboundQueue: Promise<void>;
	outboundQueue: Promise<void>;
	handlerSettled: Promise<void>;
	resolveHandlerSettled: () => void;
	handlerDone: boolean;
	cancellationError?: RemoteWorkspaceProtocolError;
	settled: boolean;
}

export class RemoteWorkspaceServerProtocol {
	private readonly transport: RemoteWorkspaceProtocolTransport<RemoteWorkspaceServerMessage>;
	private readonly handler: RemoteWorkspaceServerHandler;
	private readonly workspace: RemoteWorkspaceIdentity;
	private readonly negotiation: RemoteWorkspaceNegotiationOptions;
	private readonly backendLabel: string | undefined;
	private readonly invalidRequestStrikes: number;
	private readonly tombstoneMs: number;
	private readonly maxTombstones: number;
	private readonly active = new Map<string, ServerActiveRequest>();
	private readonly tombstones = new Map<string, number>();
	private catalog: RemoteWorkspaceCatalog;
	private catalogHash: string;
	private limits: RemoteWorkspaceProtocolLimits;
	private negotiatedCapabilities = new Set<string>();
	private receiveQueue: Promise<void> = Promise.resolve();
	private sendQueue: Promise<void> = Promise.resolve();
	private disconnectPromise: Promise<void> | undefined;
	private transportFailurePromise: Promise<void> | undefined;
	private pendingReceiveBytes = 0;
	private pendingReceiveMessages = 0;
	private pendingOutboundBytes = 0;
	private pendingOutboundMessages = 0;
	private pendingTransferBytes = 0;
	private handshaken = false;
	private closed = false;
	private draining = false;
	private strikes = 0;

	constructor(
		transport: RemoteWorkspaceProtocolTransport<RemoteWorkspaceServerMessage>,
		handler: RemoteWorkspaceServerHandler,
		options: RemoteWorkspaceServerProtocolOptions,
	) {
		const catalog = cloneCatalog(options.catalog);
		this.validateCatalogCapabilities(catalog, new Set(options.capabilities));
		this.transport = transport;
		this.handler = handler;
		this.workspace = cloneWorkspaceIdentity(options.workspace);
		this.catalog = catalog;
		this.catalogHash = hashRemoteWorkspaceCatalog(catalog);
		this.limits = {
			...validateRemoteWorkspaceProtocolLimits(options.limits ?? DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS),
		};
		this.negotiation = {
			serverVersions: options.versions ?? REMOTE_WORKSPACE_PROTOCOL_VERSIONS,
			serverCapabilities: options.capabilities,
			requiredClientCapabilities: options.requiredClientCapabilities,
			serverLimits: this.limits,
		};
		this.backendLabel = options.backendLabel;
		this.invalidRequestStrikes = validateConfiguredInteger(
			options.invalidRequestStrikes ?? 3,
			"invalidRequestStrikes",
			1,
			100,
		);
		this.tombstoneMs = validateConfiguredInteger(
			options.tombstoneMs ?? 5 * 60 * 1000,
			"tombstoneMs",
			1,
			24 * 60 * 60 * 1000,
		);
		this.maxTombstones = validateConfiguredInteger(options.maxTombstones ?? 65_536, "maxTombstones", 1, 1_000_000);
	}

	get handshakeComplete(): boolean {
		return this.handshaken;
	}

	receive(payload: string | Uint8Array): Promise<void> {
		if (this.closed) return Promise.resolve();
		const bytes = payloadByteLength(payload);
		if (
			bytes > this.limits.maxMessageBytes ||
			this.pendingReceiveMessages >= this.limits.maxPendingInboundMessages ||
			this.pendingReceiveBytes + bytes > this.limits.maxPendingInboundBytes
		) {
			return this.closeWithReason({ code: "message_too_large", message: "Inbound protocol queue exceeds limits" });
		}
		const queuedPayload = typeof payload === "string" ? payload : Uint8Array.from(payload);
		this.pendingReceiveMessages++;
		this.pendingReceiveBytes += bytes;
		const operation = this.receiveQueue.then(() => this.receivePayload(queuedPayload));
		const tracked = operation.finally(() => {
			this.pendingReceiveMessages--;
			this.pendingReceiveBytes -= bytes;
		});
		this.receiveQueue = tracked.catch(() => undefined);
		return tracked;
	}

	publishCatalog(catalog: RemoteWorkspaceCatalog): Promise<void> {
		if (this.closed) return Promise.reject(new Error("Remote workspace protocol server is closed"));
		const clonedCatalog = cloneCatalog(catalog);
		const operation = this.receiveQueue.then(() => this.publishCatalogNow(clonedCatalog));
		this.receiveQueue = operation.catch(() => undefined);
		return operation;
	}

	private async publishCatalogNow(catalog: RemoteWorkspaceCatalog): Promise<void> {
		if (this.closed) throw new Error("Remote workspace protocol server is closed");
		this.validateCatalogCapabilities(catalog, new Set(this.negotiation.serverCapabilities));
		if (catalog.generation <= this.catalog.generation)
			throw new Error("Remote workspace catalog generation must increase");
		for (const [id, active] of Array.from(this.active)) {
			if (active.kind !== "process" && active.kind !== "service") continue;
			await this.cancelActive(
				id,
				this.createError("generation_retired", "Remote workspace generation retired", "not_started", false),
				true,
			);
		}
		this.catalog = catalog;
		this.catalogHash = hashRemoteWorkspaceCatalog(catalog);
		if (this.handshaken && this.negotiatedCapabilities.has("catalog_refresh")) {
			await this.send({ type: "catalog_changed", generation: catalog.generation, catalogHash: this.catalogHash });
		}
	}

	async beginDrain(message = "Remote workspace connection is draining"): Promise<void> {
		if (this.closed) return;
		this.draining = true;
		await Promise.all(
			Array.from(this.active.keys()).map((id) =>
				this.cancelActive(id, this.createError("connection_draining", message, "not_started", false), false),
			),
		);
	}

	disconnect(): Promise<void> {
		return this.disconnectInternal(true);
	}

	private disconnectInternal(observeReceiveQueue: boolean): Promise<void> {
		if (this.disconnectPromise) return this.disconnectPromise;
		if (this.closed) return Promise.resolve();
		this.closed = true;
		const activeRequests = Array.from(this.active.values());
		for (const active of activeRequests) {
			clearTimeout(active.timer);
			active.controller.abort();
		}
		const queuedSends = this.sendQueue;
		const queuedReceives = this.receiveQueue;
		this.disconnectPromise = Promise.all([
			...activeRequests.map(async (active) => {
				const termination = Promise.all([active.handlerSettled, active.inboundQueue, active.outboundQueue]).then(
					() => undefined,
				);
				const stopped = await this.settlesWithin(termination, this.limits.maxCancellationMs);
				active.settled = true;
				this.active.delete(active.request.id);
				return stopped;
			}),
			settlesWithinDeadline(queuedSends, this.limits.maxTransportSendMs),
			...(observeReceiveQueue ? [settlesWithinDeadline(queuedReceives, this.limits.maxCancellationMs)] : []),
		]).then((results) => {
			if (results.some((stopped) => !stopped)) {
				throw new RemoteWorkspaceTerminationError(
					"Remote workspace handlers did not terminate before the disconnect deadline",
				);
			}
		});
		return this.disconnectPromise;
	}

	private async receivePayload(payload: string | Uint8Array): Promise<void> {
		if (this.closed) return;
		let decoded: unknown;
		try {
			decoded = decodeRemoteWorkspaceMessage(payload, this.limits);
		} catch (error) {
			await this.closeWithReason({ code: classifyValidationClose(error), message: this.errorMessage(error) });
			return;
		}
		let message: RemoteWorkspaceClientMessage;
		try {
			message = parseRemoteWorkspaceClientMessage(decoded, this.limits);
		} catch (error) {
			await this.handleInvalidMessage(decoded, error);
			return;
		}
		if (!this.handshaken) {
			if (message.type !== "handshake") {
				await this.closeWithReason({ code: "protocol_error", message: "Request received before handshake" });
				return;
			}
			await this.handleHandshake(message);
			return;
		}
		if (message.type === "handshake") {
			await this.closeWithReason({ code: "protocol_error", message: "Duplicate handshake" });
			return;
		}
		if (message.type === "cancel") {
			await this.handleCancel(message.id);
			return;
		}
		if (message.type === "transfer_chunk") {
			await this.handleUploadChunk(message.id, message.sequence, message.dataBase64);
			return;
		}
		if (message.type === "transfer_finish") {
			await this.handleUploadFinish(message.id, message.length, message.sha256);
			return;
		}
		await this.handleRequest(message);
	}
	private async handleRequestValidationFailure(requestId: string, error: unknown): Promise<void> {
		this.addTombstone(requestId);
		const semantic = error instanceof RemoteWorkspaceRequestError;
		if (!semantic) this.strikes++;
		const protocolError = semantic
			? {
					code: error.code,
					message: error.message,
					executionState: error.executionState,
					retryable: error.retryable,
					...(error.details === undefined ? {} : { details: error.details }),
				}
			: this.createError("invalid_request", this.errorMessage(error), "not_started", false);
		await this.send({ type: "error", id: requestId, error: protocolError });
		if (this.strikes >= this.invalidRequestStrikes) {
			await this.closeWithReason({ code: "policy_violation", message: "Too many invalid requests" });
		}
	}

	private async handleHandshake(handshake: RemoteWorkspaceHandshake): Promise<void> {
		if (this.isDuplicateId(handshake.id)) {
			await this.closeWithReason({ code: "protocol_error", message: `Duplicate request ID: ${handshake.id}` });
			return;
		}
		try {
			const negotiated = negotiateRemoteWorkspaceHandshake(handshake, this.negotiation);
			this.limits = negotiated.limits;
			this.negotiatedCapabilities = new Set(negotiated.capabilities);
			this.handshaken = true;
			this.addTombstone(handshake.id);
			await this.send({
				type: "handshake_ack",
				id: handshake.id,
				version: negotiated.version,
				capabilities: negotiated.capabilities,
				workspace: this.workspace,
				limits: negotiated.limits,
				catalog: this.catalog,
				catalogHash: this.catalogHash,
				backendMetadata: {
					kind: "remote-workspace",
					...(this.backendLabel ? { label: this.backendLabel } : {}),
				},
			});
		} catch (error) {
			const protocolError =
				error instanceof RemoteWorkspaceNegotiationError
					? this.createError(error.code, error.message, "not_started", false)
					: this.createError("invalid_request", this.errorMessage(error), "not_started", false);
			await this.send({ type: "error", id: handshake.id, error: protocolError }).catch(() => undefined);
			await this.closeWithReason({ code: "policy_violation", message: protocolError.message });
		}
	}

	private async handleRequest(request: RemoteWorkspaceRequest): Promise<void> {
		if (this.isDuplicateId(request.id)) {
			await this.closeWithReason({ code: "protocol_error", message: `Duplicate request ID: ${request.id}` });
			return;
		}
		if (this.draining) {
			this.addTombstone(request.id);
			await this.sendError(request.id, "connection_draining", "Connection is draining", "not_started", false);
			return;
		}
		if (!isRemoteWorkspaceMethod(request.method)) {
			this.addTombstone(request.id);
			await this.sendError(
				request.id,
				"method_not_supported",
				`Unsupported method: ${request.method}`,
				"not_started",
				false,
			);
			return;
		}
		const typedRequest = request as RemoteWorkspaceTypedRequest;
		try {
			parseRemoteWorkspaceRequestParams(typedRequest.method, typedRequest.params, this.limits);
			this.assertMethodAvailable(typedRequest);
			this.validateCatalogRequest(typedRequest);
		} catch (error) {
			await this.handleRequestValidationFailure(request.id, error);
			return;
		}
		if (this.active.size >= this.limits.maxActiveRequests) {
			this.addTombstone(request.id);
			await this.sendError(request.id, "limit_exceeded", "Active request limit reached", "not_started", true);
			return;
		}
		if (isTransferMethod(typedRequest.method) && this.activeTransferCount() >= this.limits.maxActiveTransfers) {
			this.addTombstone(request.id);
			await this.sendError(request.id, "limit_exceeded", "Active transfer limit reached", "not_started", true);
			return;
		}
		const controller = new AbortController();
		const active = this.createActiveRequest(
			typedRequest,
			controller,
			Math.min(request.timeoutMs, this.limits.maxRequestMs),
		);
		this.active.set(request.id, active);
		if (typedRequest.method === "catalog.get") {
			await this.completeActive(request.id, this.catalog);
			return;
		}
		this.startHandler(active);
	}

	private createActiveRequest(
		request: RemoteWorkspaceTypedRequest,
		controller: AbortController,
		timeoutMs: number,
	): ServerActiveRequest {
		let active: ServerActiveRequest;
		const context: RemoteWorkspaceServerRequestContext = {
			signal: controller.signal,
			request,
			markSideEffectStarted: () => {
				if (!active.settled) active.sideEffectStarted = true;
			},
			markCommitted: () => {
				if (!active.settled) {
					active.sideEffectStarted = true;
					active.committed = true;
				}
			},
			sendUpdate: (update) => {
				if (!this.negotiatedCapabilities.has("tool_updates")) {
					return Promise.reject(
						new RemoteWorkspaceRequestError(
							this.createError("not_available", "Tool updates were not negotiated", "not_started", false),
						),
					);
				}
				let prepared: PreparedProtocolMessage<RemoteWorkspaceServerMessage>;
				try {
					prepared = prepareServerOutbound(
						{ type: "update", id: request.id, sequence: active.nextUpdateSequence, update },
						this.limits,
					);
				} catch (error) {
					return Promise.reject(
						new RemoteWorkspaceRequestError(
							this.createError(
								"result_too_large",
								this.errorMessage(error),
								this.executionStateFromActive(active),
								false,
							),
						),
					);
				}
				try {
					const queued = this.queueActiveOutbound(active, prepared.bytes, async () => {
						if (!active.settled) await this.sendPrepared(prepared, true);
					});
					active.nextUpdateSequence++;
					return queued;
				} catch (error) {
					return Promise.reject(error);
				}
			},
			startTransfer: (length, sha256) => {
				const prepared = prepareServerOutbound(
					{ type: "transfer_start", id: request.id, length, sha256 },
					this.limits,
				);
				return this.queueActiveOutbound(active, prepared.bytes, async () => {
					if (active.settled || active.outgoingTransfer)
						throw new Error("Transfer has already started or settled");
					if (!this.negotiatedCapabilities.has("file_transfer"))
						throw new Error("File transfer was not negotiated");
					if (length > this.limits.maxTransferBytes) throw new Error("Transfer exceeds total-byte limit");
					active.outgoingTransfer = {
						expectedLength: length,
						expectedSha256: sha256,
						bytes: 0,
						pendingBytes: 0,
						chunks: 0,
						hash: createHash("sha256"),
						finishing: false,
						finished: false,
					};
					await this.sendPrepared(prepared, true);
				});
			},
			sendTransferChunk: (chunk) => {
				if (chunk.byteLength > this.limits.maxTransferChunkBytes) {
					return Promise.reject(new Error("Transfer chunk exceeds limit"));
				}
				if (
					active.pendingOutgoingTransferBytes + chunk.byteLength > this.limits.maxPendingTransferBytes ||
					this.pendingTransferBytes + chunk.byteLength > this.limits.maxPendingTransferBytes
				) {
					return Promise.reject(new Error("Pending transfer chunks exceed limit"));
				}
				const copiedChunk = Buffer.from(chunk);
				const prepared = prepareServerOutbound(
					{
						type: "transfer_chunk",
						id: request.id,
						sequence: active.nextOutgoingTransferSequence,
						dataBase64: copiedChunk.toString("base64"),
					},
					this.limits,
				);
				active.pendingOutgoingTransferBytes += copiedChunk.byteLength;
				this.pendingTransferBytes += copiedChunk.byteLength;
				try {
					const queued = this.queueActiveOutbound(active, prepared.bytes, async () => {
						const transfer = active.outgoingTransfer;
						if (active.settled || !transfer || transfer.finished)
							throw new Error("Transfer has not started or has settled");
						if (
							transfer.chunks + 1 > this.limits.maxTransferChunks ||
							transfer.bytes + copiedChunk.byteLength > this.limits.maxTransferBytes ||
							transfer.bytes + copiedChunk.byteLength > transfer.expectedLength
						) {
							throw new Error("Transfer exceeds declared or negotiated limits");
						}
						await this.sendPrepared(prepared, true);
						transfer.chunks++;
						transfer.bytes += copiedChunk.byteLength;
						transfer.hash.update(copiedChunk);
					});
					active.nextOutgoingTransferSequence++;
					return queued.finally(() => {
						active.pendingOutgoingTransferBytes -= copiedChunk.byteLength;
						this.pendingTransferBytes -= copiedChunk.byteLength;
					});
				} catch (error) {
					active.pendingOutgoingTransferBytes -= copiedChunk.byteLength;
					this.pendingTransferBytes -= copiedChunk.byteLength;
					return Promise.reject(error);
				}
			},
		};
		let resolveHandlerSettled: () => void = () => undefined;
		const handlerSettled = new Promise<void>((resolve) => {
			resolveHandlerSettled = resolve;
		});
		const timer = setTimeout(() => {
			void this.cancelActive(
				request.id,
				this.createError("deadline_exceeded", "Remote workspace request deadline exceeded", "not_started", false),
				false,
			).catch(() => undefined);
		}, timeoutMs);
		active = {
			request,
			controller,
			context,
			timer,
			kind: this.requestKind(request),
			sideEffectStarted: false,
			committed: false,
			nextUpdateSequence: 0,
			nextIncomingTransferSequence: 0,
			nextOutgoingTransferSequence: 0,
			pendingOutgoingTransferBytes: 0,
			outboundQueue: Promise.resolve(),
			inboundQueue: Promise.resolve(),
			handlerSettled,
			resolveHandlerSettled,
			handlerDone: false,
			...(request.method === "transfer.upload"
				? { incomingTransfer: this.createServerUploadState(request.params) }
				: {}),
			settled: false,
		};
		return active;
	}

	private startHandler(active: ServerActiveRequest): void {
		void (async () => {
			try {
				const result = await this.handler.handleRequest(active.request, active.context);
				active.handlerDone = true;
				active.resolveHandlerSettled();
				if (active.settled) return;
				if (active.cancellationError) return;
				await this.completeActive(active.request.id, result);
			} catch (error) {
				active.handlerDone = true;
				active.resolveHandlerSettled();
				if (active.settled) return;
				if (active.cancellationError) return;
				await this.handleHandlerFailure(active.request.id, error);
			}
		})();
	}

	private queueActiveOutbound<T>(
		active: ServerActiveRequest,
		estimatedBytes: number,
		operation: () => Promise<T>,
	): Promise<T> {
		if (this.closed || active.settled || this.active.get(active.request.id) !== active) {
			throw new RemoteWorkspaceRequestError(
				this.createError(
					"connection_draining",
					"Remote workspace request is no longer active",
					this.executionStateFromActive(active),
					false,
				),
			);
		}
		if (
			this.pendingOutboundMessages >= this.limits.maxPendingOutboundMessages ||
			this.pendingOutboundBytes + estimatedBytes > this.limits.maxPendingOutboundBytes
		) {
			throw new RemoteWorkspaceRequestError(
				this.createError("limit_exceeded", "Remote workspace outbound queue exceeds limits", "not_started", false),
			);
		}
		this.pendingOutboundMessages++;
		this.pendingOutboundBytes += estimatedBytes;
		const queued = active.outboundQueue.then(operation);
		const result = queued.finally(() => {
			this.pendingOutboundMessages--;
			this.pendingOutboundBytes -= estimatedBytes;
		});
		active.outboundQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async cancelActive(
		id: string,
		error: RemoteWorkspaceProtocolError,
		requireTermination: boolean,
	): Promise<void> {
		const active = this.active.get(id);
		if (!active || active.settled) return;
		active.cancellationError ??= error;
		active.controller.abort();
		const termination = Promise.all([active.handlerSettled, active.inboundQueue, active.outboundQueue]).then(
			() => undefined,
		);
		const handlerStopped = await this.settlesWithin(termination, this.limits.maxCancellationMs);
		if (handlerStopped) {
			await this.finalizeCancellation(active);
			return;
		}
		if (requireTermination) {
			await this.closeUnconfirmedCancellation(id);
			throw new Error(`Remote workspace request did not stop before generation retirement: ${id}`);
		}
		await this.closeUnconfirmedCancellation(id);
	}

	private async finalizeCancellation(active: ServerActiveRequest): Promise<void> {
		if (active.settled || !active.cancellationError) return;
		await active.outboundQueue;
		if (active.settled) return;
		await this.failActive(active.request.id, {
			...active.cancellationError,
			executionState: this.executionStateFromActive(active),
		});
	}

	private async closeUnconfirmedCancellation(id: string): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.draining = true;
		const activeRequests = Array.from(this.active.values());
		for (const active of activeRequests) {
			clearTimeout(active.timer);
			active.controller.abort();
			active.settled = true;
		}
		await Promise.all([
			settlesWithinDeadline(
				Promise.all(
					activeRequests.flatMap((active) => [active.handlerSettled, active.inboundQueue, active.outboundQueue]),
				).then(() => undefined),
				this.limits.maxCancellationMs,
			),
			settlesWithinDeadline(this.sendQueue, this.limits.maxTransportSendMs),
		]);
		this.active.clear();
		const closed = await settlesWithinDeadline(
			Promise.resolve(
				this.transport.close(
					boundedCloseReason({
						code: "policy_violation",
						message: `Remote workspace request did not stop after cancellation: ${id}`,
					}),
				),
			),
			this.limits.maxTransportSendMs,
		).catch(() => false);
		if (!closed) throw new RemoteWorkspaceTerminationError("Remote workspace transport close timed out");
		throw new RemoteWorkspaceTerminationError(`Remote workspace request did not terminate: ${id}`);
	}

	private settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
		return new Promise((resolve) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				resolve(false);
			}, timeoutMs);
			promise.then(() => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(true);
			});
		});
	}

	private assertMethodAvailable(request: RemoteWorkspaceTypedRequest): void {
		const capability = methodCapability(request.method);
		if (capability && !this.negotiatedCapabilities.has(capability)) {
			throw new RemoteWorkspaceRequestError(
				this.createError("not_available", `Capability was not negotiated: ${capability}`, "not_started", false),
			);
		}
		if (request.method === "artifact.read" && !this.negotiatedCapabilities.has("file_transfer")) {
			throw new RemoteWorkspaceRequestError(
				this.createError("not_available", "Artifact reads require file transfer", "not_started", false),
			);
		}
		if (
			request.method !== "catalog.get" &&
			request.method !== "tool.invoke" &&
			!this.catalog.operations.includes(request.method)
		) {
			throw new RemoteWorkspaceRequestError(
				this.createError("not_available", `Operation is not advertised: ${request.method}`, "not_started", false),
			);
		}
		if (request.method === "transfer.upload") {
			const upload = request.params as { length: number };
			if (upload.length > this.limits.maxTransferBytes) {
				throw new RemoteWorkspaceRequestError(
					this.createError("limit_exceeded", "Upload exceeds total-byte limit", "not_started", false),
				);
			}
		}
	}

	private validateCatalogRequest(request: RemoteWorkspaceTypedRequest): void {
		if (request.method !== "tool.invoke") return;
		const params = request.params as {
			generation: number;
			catalogHash: string;
			toolName: string;
			schemaHash: string;
			arguments: unknown;
		};
		if (params.generation !== this.catalog.generation || params.catalogHash !== this.catalogHash) {
			throw new RemoteWorkspaceRequestError(
				this.createError("stale_generation", "Tool catalog generation is stale", "not_started", true),
			);
		}
		const tool = this.catalog.tools.find((entry) => entry.name === params.toolName);
		if (!tool) {
			throw new RemoteWorkspaceRequestError(
				this.createError("not_available", `Tool is not available: ${params.toolName}`, "not_started", false),
			);
		}
		for (const featureFlag of tool.featureFlags) {
			if (!this.negotiatedCapabilities.has(featureFlag)) {
				throw new RemoteWorkspaceRequestError(
					this.createError(
						"not_available",
						`Tool ${params.toolName} requires unnegotiated capability ${featureFlag}`,
						"not_started",
						false,
					),
				);
			}
		}
		if (tool.schemaHash !== params.schemaHash) {
			throw new RemoteWorkspaceRequestError(
				this.createError("schema_mismatch", `Schema mismatch for tool ${params.toolName}`, "not_started", false),
			);
		}
		if (!this.handler.validateToolArguments(params.toolName, params.arguments)) {
			throw new RemoteWorkspaceValidationError(`Arguments do not match the canonical schema for ${params.toolName}`);
		}
	}

	private requestKind(request: RemoteWorkspaceTypedRequest): RemoteWorkspaceOperationKind {
		if (request.method !== "tool.invoke") return getRemoteWorkspaceMethodKind(request.method);
		const params = request.params as { toolName: string };
		return this.catalog.tools.find((tool) => tool.name === params.toolName)?.executionMode ?? "service";
	}

	private createServerUploadState(params: unknown): ServerTransferState {
		const upload = params as { length: number; sha256: string };
		if (upload.length > this.limits.maxTransferBytes) {
			throw new RemoteWorkspaceRequestError(
				this.createError("limit_exceeded", "Upload exceeds total-byte limit", "not_started", false),
			);
		}
		return {
			expectedLength: upload.length,
			expectedSha256: upload.sha256,
			bytes: 0,
			pendingBytes: 0,
			chunks: 0,
			hash: createHash("sha256"),
			finishing: false,
			finished: false,
		};
	}

	private async handleUploadChunk(id: string, sequence: number, dataBase64: string): Promise<void> {
		const active = this.active.get(id);
		if (!active) {
			await this.handleUnknownCorrelatedId(id, "upload chunk");
			return;
		}
		const transfer = active.incomingTransfer;
		if (!transfer || transfer.finished || sequence !== active.nextIncomingTransferSequence) {
			await this.closeWithReason({ code: "protocol_error", message: `Out-of-order upload chunk for ${id}` });
			return;
		}
		let chunk: Buffer;
		try {
			chunk = decodeCanonicalBase64(dataBase64, this.limits.maxTransferChunkBytes);
			if (
				transfer.chunks + 1 > this.limits.maxTransferChunks ||
				transfer.bytes + chunk.byteLength > this.limits.maxTransferBytes ||
				transfer.bytes + chunk.byteLength > transfer.expectedLength ||
				transfer.pendingBytes + chunk.byteLength > this.limits.maxPendingTransferBytes ||
				this.pendingTransferBytes + chunk.byteLength > this.limits.maxPendingTransferBytes
			) {
				throw new RemoteWorkspaceValidationError("Upload exceeds declared or negotiated limits");
			}
		} catch (error) {
			await this.cancelActive(
				id,
				this.createError("limit_exceeded", this.errorMessage(error), "not_started", false),
				false,
			);
			return;
		}
		active.nextIncomingTransferSequence++;
		transfer.chunks++;
		transfer.bytes += chunk.byteLength;
		transfer.pendingBytes += chunk.byteLength;
		this.pendingTransferBytes += chunk.byteLength;
		transfer.hash.update(chunk);
		const operation = active.inboundQueue
			.then(async () => {
				if (active.settled) return;
				await this.handler.handleUploadChunk?.(
					active.request as RemoteWorkspaceUploadRequest,
					chunk,
					sequence,
					active.context,
				);
			})
			.finally(() => {
				transfer.pendingBytes -= chunk.byteLength;
				this.pendingTransferBytes -= chunk.byteLength;
			});
		active.inboundQueue = operation.catch(() => undefined);
		void operation.catch(async (error: unknown) => {
			if (this.active.get(id) === active) await this.handleHandlerFailure(id, error);
		});
	}

	private async handleUploadFinish(id: string, length: number, sha256: string): Promise<void> {
		const active = this.active.get(id);
		if (!active) {
			await this.handleUnknownCorrelatedId(id, "upload finish");
			return;
		}
		const transfer = active.incomingTransfer;
		if (!transfer || transfer.finishing || transfer.finished) {
			await this.closeWithReason({ code: "protocol_error", message: `Unexpected upload finish for ${id}` });
			return;
		}
		transfer.finishing = true;
		const digest = transfer.hash.digest("hex");
		if (
			length !== transfer.expectedLength ||
			sha256 !== transfer.expectedSha256 ||
			transfer.bytes !== transfer.expectedLength ||
			digest !== transfer.expectedSha256
		) {
			await this.cancelActive(
				id,
				this.createError("invalid_request", "Upload length or SHA-256 verification failed", "not_started", false),
				false,
			);
			return;
		}
		const operation = active.inboundQueue.then(async () => {
			if (active.settled) return;
			await this.handler.handleUploadFinish?.(
				active.request as RemoteWorkspaceUploadRequest,
				{ length, sha256 },
				active.context,
			);
			transfer.finished = true;
		});
		active.inboundQueue = operation.catch(() => undefined);
		void operation.catch(async (error: unknown) => {
			if (this.active.get(id) === active) await this.handleHandlerFailure(id, error);
		});
	}

	private async handleCancel(id: string): Promise<void> {
		if (this.active.has(id)) {
			await this.cancelActive(
				id,
				this.createError("cancelled", "Remote workspace request cancelled", "not_started", false),
				false,
			);
			return;
		}
		this.pruneTombstones();
		if (this.tombstones.has(id)) return;
		await this.closeWithReason({ code: "protocol_error", message: `Cancellation for unknown request ID: ${id}` });
	}

	private async completeActive(id: string, result: unknown): Promise<void> {
		const active = this.active.get(id);
		if (!active || active.settled) return;
		await Promise.all([active.outboundQueue, active.inboundQueue]);
		if (active.settled) return;
		if (active.cancellationError) return;
		try {
			const validated = parseRemoteWorkspaceResult(active.request.method, result, this.limits);
			assertResultWorkspaceIdentity(active.request.method, validated, this.workspace);
			this.verifyServerTransferResult(active, validated);
			this.takeActive(id);
			try {
				await this.send({ type: "result", id, result: validated });
			} catch (error) {
				if (!(error instanceof RemoteWorkspaceValidationError)) throw error;
				await this.send({
					type: "error",
					id,
					error: this.createError(
						"result_too_large",
						error.message,
						active.kind === "read" ? "not_started" : active.committed ? "completed" : "indeterminate",
						false,
					),
				});
			}
		} catch (error) {
			await this.handleHandlerFailure(id, error);
		}
	}

	private verifyServerTransferResult(active: ServerActiveRequest, result: unknown): void {
		if (active.request.method === "transfer.upload") {
			const transfer = active.incomingTransfer;
			const metadata = result as { length: number; sha256: string };
			if (
				!transfer?.finished ||
				metadata.length !== transfer.expectedLength ||
				metadata.sha256 !== transfer.expectedSha256
			) {
				throw new RemoteWorkspaceValidationError("Upload completed without verified terminal metadata");
			}
			return;
		}
		if (active.request.method !== "transfer.download" && active.request.method !== "artifact.read") return;
		const transfer = active.outgoingTransfer;
		const metadata = result as { length: number; sha256: string };
		if (!transfer) throw new RemoteWorkspaceValidationError("Download completed without transfer metadata");
		const digest = transfer.hash.digest("hex");
		transfer.finished = true;
		if (
			transfer.bytes !== transfer.expectedLength ||
			digest !== transfer.expectedSha256 ||
			metadata.length !== transfer.expectedLength ||
			metadata.sha256 !== transfer.expectedSha256
		) {
			throw new RemoteWorkspaceValidationError("Download length or SHA-256 verification failed");
		}
	}

	private async handleHandlerFailure(id: string, error: unknown): Promise<void> {
		if (error instanceof RemoteWorkspaceRequestError) {
			await this.failActive(id, {
				code: error.code,
				message: error.message,
				executionState: this.reconcileExecutionState(id, error.executionState),
				retryable: error.retryable,
				...(error.details === undefined ? {} : { details: error.details }),
			});
			return;
		}
		await this.failActive(
			id,
			this.createError(
				"internal_error",
				"Remote workspace request handler failed",
				this.executionStateFor(id),
				false,
			),
		);
	}

	private async failActive(id: string, error: RemoteWorkspaceProtocolError): Promise<void> {
		const active = this.takeActive(id);
		if (!active) return;
		active.controller.abort();
		const [handlerStopped, outboundStopped, inboundStopped] = await Promise.all([
			settlesWithinDeadline(active.handlerSettled, this.limits.maxCancellationMs),
			settlesWithinDeadline(active.outboundQueue, this.limits.maxTransportSendMs),
			settlesWithinDeadline(active.inboundQueue, this.limits.maxCancellationMs),
		]);
		if (!handlerStopped || !outboundStopped || !inboundStopped) {
			await this.failServerTransport(new RemoteWorkspaceTransportError("Request callback queue did not drain"));
			return;
		}
		const boundedError: RemoteWorkspaceProtocolError = {
			...error,
			message: error.message.slice(0, 4096) || error.code,
		};
		try {
			await this.send({ type: "error", id, error: boundedError });
		} catch (sendError) {
			if (sendError instanceof RemoteWorkspaceTransportError) return;
			await this.send({
				type: "error",
				id,
				error: this.createError(
					"internal_error",
					"Remote workspace error details exceeded protocol limits",
					boundedError.executionState,
					false,
				),
			}).catch(() => undefined);
		}
	}

	private takeActive(id: string): ServerActiveRequest | undefined {
		const active = this.active.get(id);
		if (!active || active.settled) return undefined;
		active.settled = true;
		this.active.delete(id);
		clearTimeout(active.timer);
		this.addTombstone(id);
		return active;
	}

	private executionStateFor(id: string): RemoteWorkspaceExecutionState {
		const active = this.active.get(id);
		return active ? this.executionStateFromActive(active) : "not_started";
	}

	private executionStateFromActive(active: ServerActiveRequest): RemoteWorkspaceExecutionState {
		if (active.committed) return "completed";
		if (active.sideEffectStarted) return "indeterminate";
		return "not_started";
	}

	private reconcileExecutionState(id: string, reported: RemoteWorkspaceExecutionState): RemoteWorkspaceExecutionState {
		const active = this.active.get(id);
		if (!active) return reported;
		if (active.committed) return "completed";
		if (active.sideEffectStarted && reported === "not_started") return "indeterminate";
		return reported;
	}

	private async handleInvalidMessage(value: unknown, error: unknown): Promise<void> {
		const id = this.usableId(value);
		if (!id) {
			await this.closeWithReason({ code: "invalid_payload", message: this.errorMessage(error) });
			return;
		}
		if (this.isDuplicateId(id)) {
			await this.closeWithReason({ code: "protocol_error", message: `Duplicate request ID: ${id}` });
			return;
		}
		this.addTombstone(id);
		this.strikes++;
		await this.sendError(id, "invalid_request", this.errorMessage(error), "not_started", false).catch(
			() => undefined,
		);
		if (this.strikes >= this.invalidRequestStrikes) {
			await this.closeWithReason({ code: "policy_violation", message: "Too many invalid requests" });
		}
	}

	private usableId(value: unknown): string | undefined {
		if (!value || typeof value !== "object" || !("id" in value)) return undefined;
		const id = (value as { id?: unknown }).id;
		return typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? id : undefined;
	}

	private async handleUnknownCorrelatedId(id: string, label: string): Promise<void> {
		this.pruneTombstones();
		if (this.tombstones.has(id)) return;
		await this.closeWithReason({ code: "protocol_error", message: `${label} for unknown request ID: ${id}` });
	}

	private isDuplicateId(id: string): boolean {
		this.pruneTombstones();
		return this.active.has(id) || this.tombstones.has(id);
	}

	private addTombstone(id: string): void {
		this.pruneTombstones();
		if (this.tombstones.size >= this.maxTombstones) {
			void this.closeWithReason({
				code: "policy_violation",
				message: "Request tombstone limit exceeded",
			}).catch(() => undefined);
			return;
		}
		this.tombstones.set(id, performance.now() + this.tombstoneMs);
	}

	private pruneTombstones(): void {
		const now = performance.now();
		for (const [id, expiresAt] of this.tombstones) if (expiresAt <= now) this.tombstones.delete(id);
	}

	private activeTransferCount(): number {
		let count = 0;
		for (const active of this.active.values()) if (isTransferMethod(active.request.method)) count++;
		return count;
	}

	private validateCatalogCapabilities(catalog: RemoteWorkspaceCatalog, capabilities: ReadonlySet<string>): void {
		for (const method of catalog.operations) {
			const capability = methodCapability(method);
			if (capability && !capabilities.has(capability)) {
				throw new RemoteWorkspaceValidationError(`Catalog operation ${method} requires capability ${capability}`);
			}
			if (method === "artifact.read" && !capabilities.has("file_transfer")) {
				throw new RemoteWorkspaceValidationError("Artifact reads require file transfer capability");
			}
		}
		for (const tool of catalog.tools) {
			for (const featureFlag of tool.featureFlags) {
				if (!capabilities.has(featureFlag)) {
					throw new RemoteWorkspaceValidationError(
						`Tool ${tool.name} requires unsupported capability ${featureFlag}`,
					);
				}
			}
		}
	}

	private createError(
		code: RemoteWorkspaceErrorCode,
		message: string,
		executionState: RemoteWorkspaceExecutionState,
		retryable: boolean,
	): RemoteWorkspaceProtocolError {
		return { code, message: message.slice(0, 4096) || code, executionState, retryable };
	}

	private sendError(
		id: string,
		code: RemoteWorkspaceErrorCode,
		message: string,
		executionState: RemoteWorkspaceExecutionState,
		retryable: boolean,
	): Promise<void> {
		return this.send({ type: "error", id, error: this.createError(code, message, executionState, retryable) });
	}

	private send(message: RemoteWorkspaceServerMessage, preReserved = false): Promise<void> {
		if (this.closed) return Promise.reject(new Error("Remote workspace protocol server is closed"));
		return this.sendPrepared(prepareServerOutbound(message, this.limits), preReserved);
	}

	private sendPrepared(
		prepared: PreparedProtocolMessage<RemoteWorkspaceServerMessage>,
		preReserved = false,
	): Promise<void> {
		if (this.closed) return Promise.reject(new Error("Remote workspace protocol server is closed"));
		const estimatedBytes = prepared.bytes;
		if (
			!preReserved &&
			(this.pendingOutboundMessages >= this.limits.maxPendingOutboundMessages ||
				this.pendingOutboundBytes + estimatedBytes > this.limits.maxPendingOutboundBytes)
		) {
			const error = new RemoteWorkspaceTransportError("Remote workspace outbound queue exceeds negotiated limits");
			void this.failServerTransport(error);
			return Promise.reject(error);
		}
		if (!preReserved) {
			this.pendingOutboundMessages++;
			this.pendingOutboundBytes += estimatedBytes;
		}
		const operation = this.sendQueue.then(async () => {
			if (this.closed) throw new RemoteWorkspaceTransportError("Remote workspace protocol server is closed");
			try {
				const sent = await settlesWithinDeadline(
					this.transport.send(prepared.message),
					this.limits.maxTransportSendMs,
				);
				if (!sent) throw new RemoteWorkspaceTransportError("Remote workspace transport send timed out");
			} catch (error) {
				throw error instanceof RemoteWorkspaceTransportError ? error : new RemoteWorkspaceTransportError(error);
			}
		});
		const tracked = operation.finally(() => {
			if (!preReserved) {
				this.pendingOutboundMessages--;
				this.pendingOutboundBytes -= estimatedBytes;
			}
		});
		this.sendQueue = tracked.catch(() => undefined);
		return tracked.catch(async (error: unknown) => {
			if (error instanceof RemoteWorkspaceTransportError) await this.failServerTransport(error);
			throw error;
		});
	}

	private failServerTransport(error: RemoteWorkspaceTransportError): Promise<void> {
		this.transportFailurePromise ??= this.failServerTransportNow(error);
		return this.transportFailurePromise;
	}

	private async failServerTransportNow(error: RemoteWorkspaceTransportError): Promise<void> {
		const activeRequests = Array.from(this.active.values());
		this.closed = true;
		this.draining = true;
		for (const active of activeRequests) {
			clearTimeout(active.timer);
			active.controller.abort();
			active.settled = true;
		}
		await settlesWithinDeadline(
			Promise.all(
				activeRequests.flatMap((active) => [active.handlerSettled, active.inboundQueue, active.outboundQueue]),
			).then(() => undefined),
			this.limits.maxCancellationMs,
		).catch(() => false);
		this.active.clear();
		await settlesWithinDeadline(
			Promise.resolve(this.transport.close(boundedCloseReason({ code: "protocol_error", message: error.message }))),
			this.limits.maxTransportSendMs,
		).catch(() => false);
	}

	private errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private async closeWithReason(reason: RemoteWorkspaceProtocolCloseReason): Promise<void> {
		if (this.closed) return;
		let terminationError: unknown;
		try {
			await this.disconnectInternal(false);
		} catch (error) {
			terminationError = error;
		}
		const closed = await settlesWithinDeadline(
			Promise.resolve(this.transport.close(boundedCloseReason(reason))),
			this.limits.maxTransportSendMs,
		).catch(() => false);
		if (!closed && !terminationError) {
			terminationError = new RemoteWorkspaceTerminationError("Remote workspace transport close timed out");
		}
		if (terminationError) throw terminationError;
	}
}
