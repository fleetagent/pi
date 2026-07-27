import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

export const REMOTE_WORKSPACE_PROTOCOL_VERSIONS = [{ major: 1, minMinor: 0, maxMinor: 0 }] as const;

export const REMOTE_WORKSPACE_CAPABILITIES = [
	"catalog_refresh",
	"tool_updates",
	"primitive_operations",
	"lsp_status",
	"file_transfer",
	"artifacts",
] as const;

export type RemoteWorkspaceCapability = (typeof REMOTE_WORKSPACE_CAPABILITIES)[number];

export const REMOTE_WORKSPACE_METHODS = [
	"catalog.get",
	"tool.invoke",
	"workspace.access",
	"workspace.read",
	"workspace.write",
	"workspace.mkdir",
	"workspace.stat",
	"workspace.readdir",
	"workspace.glob",
	"workspace.grep",
	"workspace.detect_image_mime",
	"workspace.exec",
	"lsp.status",
	"resource.read",
	"artifact.read",
	"transfer.upload",
	"transfer.download",
] as const;

export type RemoteWorkspaceMethod = (typeof REMOTE_WORKSPACE_METHODS)[number];

export const REMOTE_WORKSPACE_ERROR_CODES = [
	"invalid_request",
	"method_not_supported",
	"incompatible_version",
	"capability_mismatch",
	"schema_mismatch",
	"stale_generation",
	"not_available",
	"limit_exceeded",
	"deadline_exceeded",
	"cancelled",
	"generation_retired",
	"connection_draining",
	"result_too_large",
	"internal_error",
] as const;

export type RemoteWorkspaceErrorCode = (typeof REMOTE_WORKSPACE_ERROR_CODES)[number];
export type RemoteWorkspaceExecutionState = "not_started" | "completed" | "indeterminate";
export type RemoteWorkspacePathFlavor = "posix" | "windows";
export type RemoteWorkspaceOperationKind = "read" | "mutation" | "process" | "service";

export interface RemoteWorkspaceStructuralLimits {
	maxMessageBytes: number;
	maxStringBytes: number;
	maxDepth: number;
	maxObjectKeys: number;
	maxArrayLength: number;
	maxNodes: number;
}

export interface RemoteWorkspaceProtocolLimits extends RemoteWorkspaceStructuralLimits {
	maxRequestMs: number;
	maxTransferChunkBytes: number;
	maxPendingTransferBytes: number;
	maxPendingInboundBytes: number;
	maxPendingInboundMessages: number;
	maxPendingOutboundBytes: number;
	maxPendingOutboundMessages: number;
	maxTransferBytes: number;
	maxTransferChunks: number;
	maxActiveRequests: number;
	maxActiveTransfers: number;
	maxCancellationMs: number;
	maxTransportSendMs: number;
}

export const DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS: RemoteWorkspaceProtocolLimits = {
	maxMessageBytes: 2 * 1024 * 1024,
	maxStringBytes: 1536 * 1024,
	maxDepth: 32,
	maxObjectKeys: 4096,
	maxArrayLength: 4096,
	maxNodes: 16_384,
	maxRequestMs: 10 * 60 * 1000,
	maxTransferChunkBytes: 64 * 1024,
	maxPendingTransferBytes: 256 * 1024,
	maxPendingInboundBytes: 4 * 1024 * 1024,
	maxPendingInboundMessages: 64,
	maxPendingOutboundBytes: 4 * 1024 * 1024,
	maxPendingOutboundMessages: 128,
	maxTransferBytes: 100 * 1024 * 1024,
	maxTransferChunks: 16_384,
	maxActiveRequests: 64,
	maxActiveTransfers: 8,
	maxCancellationMs: 100,
	maxTransportSendMs: 10_000,
};

const closedObject = { additionalProperties: false } as const;
const safeIntegerOptions = { minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const RequestIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" });
const HashSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });
const CapabilitySchema = Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9_.-]*$" });
const RemoteWorkspaceMethodSchema = Type.Union([
	Type.Literal("catalog.get"),
	Type.Literal("tool.invoke"),
	Type.Literal("workspace.access"),
	Type.Literal("workspace.read"),
	Type.Literal("workspace.write"),
	Type.Literal("workspace.mkdir"),
	Type.Literal("workspace.stat"),
	Type.Literal("workspace.readdir"),
	Type.Literal("workspace.glob"),
	Type.Literal("workspace.grep"),
	Type.Literal("workspace.detect_image_mime"),
	Type.Literal("workspace.exec"),
	Type.Literal("lsp.status"),
	Type.Literal("resource.read"),
	Type.Literal("artifact.read"),
	Type.Literal("transfer.upload"),
	Type.Literal("transfer.download"),
]);

export const RemoteWorkspaceVersionRangeSchema = Type.Object(
	{
		major: Type.Integer({ minimum: 1, maximum: 65535 }),
		minMinor: Type.Integer({ minimum: 0, maximum: 65535 }),
		maxMinor: Type.Integer({ minimum: 0, maximum: 65535 }),
	},
	closedObject,
);

export type RemoteWorkspaceVersionRange = Static<typeof RemoteWorkspaceVersionRangeSchema>;

export const RemoteWorkspaceVersionSchema = Type.Object(
	{
		major: Type.Integer({ minimum: 1, maximum: 65535 }),
		minor: Type.Integer({ minimum: 0, maximum: 65535 }),
	},
	closedObject,
);

export type RemoteWorkspaceVersion = Static<typeof RemoteWorkspaceVersionSchema>;

export const RemoteWorkspaceLimitsSchema = Type.Object(
	{
		maxMessageBytes: Type.Integer({ minimum: 1024, maximum: 64 * 1024 * 1024 }),
		maxStringBytes: Type.Integer({ minimum: 1, maximum: 64 * 1024 * 1024 }),
		maxDepth: Type.Integer({ minimum: 1, maximum: 256 }),
		maxObjectKeys: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
		maxArrayLength: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
		maxNodes: Type.Integer({ minimum: 1, maximum: 2_000_000 }),
		maxRequestMs: Type.Integer({ minimum: 1, maximum: 24 * 60 * 60 * 1000 }),
		maxTransferChunkBytes: Type.Integer({ minimum: 1024, maximum: 1024 * 1024 }),
		maxPendingTransferBytes: Type.Integer({ minimum: 1024, maximum: 16 * 1024 * 1024 }),
		maxPendingInboundBytes: Type.Integer({ minimum: 1024, maximum: 64 * 1024 * 1024 }),
		maxPendingInboundMessages: Type.Integer({ minimum: 1, maximum: 100_000 }),
		maxPendingOutboundBytes: Type.Integer({ minimum: 1024, maximum: 64 * 1024 * 1024 }),
		maxPendingOutboundMessages: Type.Integer({ minimum: 1, maximum: 100_000 }),
		maxTransferBytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		maxTransferChunks: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
		maxActiveRequests: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
		maxActiveTransfers: Type.Integer({ minimum: 1, maximum: 10_000 }),
		maxCancellationMs: Type.Integer({ minimum: 1, maximum: 60_000 }),
		maxTransportSendMs: Type.Integer({ minimum: 1, maximum: 5 * 60_000 }),
	},
	closedObject,
);

export const RemoteWorkspaceIdentitySchema = Type.Object(
	{
		id: Type.String({ minLength: 16, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
		root: Type.String({ minLength: 1, maxLength: 32_768 }),
		pathFlavor: Type.Union([Type.Literal("posix"), Type.Literal("windows")]),
	},
	closedObject,
);

export type RemoteWorkspaceIdentity = Static<typeof RemoteWorkspaceIdentitySchema>;

export const RemoteWorkspaceToolCatalogEntrySchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z][A-Za-z0-9_.-]*$" }),
		executionMode: Type.Union([
			Type.Literal("read"),
			Type.Literal("mutation"),
			Type.Literal("process"),
			Type.Literal("service"),
		]),
		parameterSchema: Type.Record(Type.String({ maxLength: 256 }), Type.Unknown()),
		schemaHash: HashSchema,
		featureFlags: Type.Array(CapabilitySchema, { maxItems: 256 }),
	},
	closedObject,
);

export type RemoteWorkspaceToolCatalogEntry = Static<typeof RemoteWorkspaceToolCatalogEntrySchema>;

export const RemoteWorkspaceCatalogSchema = Type.Object(
	{
		generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		tools: Type.Array(RemoteWorkspaceToolCatalogEntrySchema, { maxItems: 1024 }),
		operations: Type.Array(RemoteWorkspaceMethodSchema, { maxItems: 256 }),
	},
	closedObject,
);

export type RemoteWorkspaceCatalog = Static<typeof RemoteWorkspaceCatalogSchema>;

export const RemoteWorkspaceHandshakeSchema = Type.Object(
	{
		type: Type.Literal("handshake"),
		id: RequestIdSchema,
		versions: Type.Array(RemoteWorkspaceVersionRangeSchema, { minItems: 1, maxItems: 16 }),
		requiredCapabilities: Type.Array(CapabilitySchema, { maxItems: 256 }),
		optionalCapabilities: Type.Array(CapabilitySchema, { maxItems: 256 }),
		receiveLimits: RemoteWorkspaceLimitsSchema,
	},
	closedObject,
);

export type RemoteWorkspaceHandshake = Static<typeof RemoteWorkspaceHandshakeSchema>;

export const RemoteWorkspaceHandshakeAckSchema = Type.Object(
	{
		type: Type.Literal("handshake_ack"),
		id: RequestIdSchema,
		version: RemoteWorkspaceVersionSchema,
		capabilities: Type.Array(CapabilitySchema, { maxItems: 256 }),
		workspace: RemoteWorkspaceIdentitySchema,
		limits: RemoteWorkspaceLimitsSchema,
		catalog: RemoteWorkspaceCatalogSchema,
		catalogHash: HashSchema,
		backendMetadata: Type.Object(
			{
				kind: Type.Literal("remote-workspace"),
				label: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
			},
			closedObject,
		),
	},
	closedObject,
);

export type RemoteWorkspaceHandshakeAck = Static<typeof RemoteWorkspaceHandshakeAckSchema>;

export const RemoteWorkspaceRequestSchema = Type.Object(
	{
		type: Type.Literal("request"),
		id: RequestIdSchema,
		method: Type.String({ minLength: 1, maxLength: 128 }),
		timeoutMs: Type.Integer({ minimum: 1, maximum: 24 * 60 * 60 * 1000 }),
		params: Type.Unknown(),
	},
	closedObject,
);

export type RemoteWorkspaceRequest = Static<typeof RemoteWorkspaceRequestSchema>;

export const RemoteWorkspaceCancelSchema = Type.Object(
	{
		type: Type.Literal("cancel"),
		id: RequestIdSchema,
		reason: Type.Optional(Type.String({ maxLength: 256 })),
	},
	closedObject,
);

export type RemoteWorkspaceCancel = Static<typeof RemoteWorkspaceCancelSchema>;

export const RemoteWorkspaceTransferChunkSchema = Type.Object(
	{
		type: Type.Literal("transfer_chunk"),
		id: RequestIdSchema,
		sequence: Type.Integer(safeIntegerOptions),
		dataBase64: Type.String({ minLength: 4 }),
	},
	closedObject,
);

export type RemoteWorkspaceTransferChunk = Static<typeof RemoteWorkspaceTransferChunkSchema>;

export const RemoteWorkspaceTransferFinishSchema = Type.Object(
	{
		type: Type.Literal("transfer_finish"),
		id: RequestIdSchema,
		length: Type.Integer(safeIntegerOptions),
		sha256: HashSchema,
	},
	closedObject,
);

export type RemoteWorkspaceTransferFinish = Static<typeof RemoteWorkspaceTransferFinishSchema>;

export const RemoteWorkspaceResultSchema = Type.Object(
	{
		type: Type.Literal("result"),
		id: RequestIdSchema,
		result: Type.Unknown(),
	},
	closedObject,
);

export type RemoteWorkspaceResult = Static<typeof RemoteWorkspaceResultSchema>;

export const RemoteWorkspaceProtocolErrorSchema = Type.Object(
	{
		code: Type.Union([
			Type.Literal("invalid_request"),
			Type.Literal("method_not_supported"),
			Type.Literal("incompatible_version"),
			Type.Literal("capability_mismatch"),
			Type.Literal("schema_mismatch"),
			Type.Literal("stale_generation"),
			Type.Literal("not_available"),
			Type.Literal("limit_exceeded"),
			Type.Literal("deadline_exceeded"),
			Type.Literal("cancelled"),
			Type.Literal("generation_retired"),
			Type.Literal("connection_draining"),
			Type.Literal("result_too_large"),
			Type.Literal("internal_error"),
		]),
		message: Type.String({ minLength: 1, maxLength: 4096 }),
		executionState: Type.Union([
			Type.Literal("not_started"),
			Type.Literal("completed"),
			Type.Literal("indeterminate"),
		]),
		retryable: Type.Boolean(),
		details: Type.Optional(Type.Unknown()),
	},
	closedObject,
);

export type RemoteWorkspaceProtocolError = Static<typeof RemoteWorkspaceProtocolErrorSchema>;

export const RemoteWorkspaceErrorMessageSchema = Type.Object(
	{
		type: Type.Literal("error"),
		id: RequestIdSchema,
		error: RemoteWorkspaceProtocolErrorSchema,
	},
	closedObject,
);

export type RemoteWorkspaceErrorMessage = Static<typeof RemoteWorkspaceErrorMessageSchema>;

export const RemoteWorkspaceUpdateSchema = Type.Object(
	{
		type: Type.Literal("update"),
		id: RequestIdSchema,
		sequence: Type.Integer(safeIntegerOptions),
		update: Type.Unknown(),
	},
	closedObject,
);

export type RemoteWorkspaceUpdate = Static<typeof RemoteWorkspaceUpdateSchema>;

export const RemoteWorkspaceTransferStartSchema = Type.Object(
	{
		type: Type.Literal("transfer_start"),
		id: RequestIdSchema,
		length: Type.Integer(safeIntegerOptions),
		sha256: HashSchema,
	},
	closedObject,
);

export type RemoteWorkspaceTransferStart = Static<typeof RemoteWorkspaceTransferStartSchema>;

export const RemoteWorkspaceCatalogChangedSchema = Type.Object(
	{
		type: Type.Literal("catalog_changed"),
		generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		catalogHash: HashSchema,
	},
	closedObject,
);

export type RemoteWorkspaceCatalogChanged = Static<typeof RemoteWorkspaceCatalogChangedSchema>;

export const RemoteWorkspaceClientMessageSchema = Type.Union([
	RemoteWorkspaceHandshakeSchema,
	RemoteWorkspaceRequestSchema,
	RemoteWorkspaceCancelSchema,
	RemoteWorkspaceTransferChunkSchema,
	RemoteWorkspaceTransferFinishSchema,
]);

export const RemoteWorkspaceServerMessageSchema = Type.Union([
	RemoteWorkspaceHandshakeAckSchema,
	RemoteWorkspaceResultSchema,
	RemoteWorkspaceErrorMessageSchema,
	RemoteWorkspaceUpdateSchema,
	RemoteWorkspaceTransferStartSchema,
	RemoteWorkspaceTransferChunkSchema,
	RemoteWorkspaceCatalogChangedSchema,
]);

export type RemoteWorkspaceClientMessage = Static<typeof RemoteWorkspaceClientMessageSchema>;
export type RemoteWorkspaceServerMessage = Static<typeof RemoteWorkspaceServerMessageSchema>;

const EmptyParamsSchema = Type.Object({}, closedObject);
const PathParamsSchema = Type.Object({ path: Type.String({ minLength: 1, maxLength: 32_768 }) }, closedObject);
const CatalogGetParamsSchema = EmptyParamsSchema;
const ToolInvokeParamsSchema = Type.Object(
	{
		generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		catalogHash: HashSchema,
		toolName: Type.String({ minLength: 1, maxLength: 128 }),
		schemaHash: HashSchema,
		argumentsPrepared: Type.Literal(true),
		arguments: Type.Unknown(),
		executionOptions: Type.Object(
			{
				imageAutoResize: Type.Optional(Type.Boolean()),
				shellCommandPrefix: Type.Optional(Type.String({ maxLength: 32_768 })),
			},
			closedObject,
		),
	},
	closedObject,
);
const AccessParamsSchema = Type.Object(
	{
		path: Type.String({ minLength: 1, maxLength: 32_768 }),
		mode: Type.Optional(
			Type.Union([Type.Literal("exists"), Type.Literal("read"), Type.Literal("write"), Type.Literal("readwrite")]),
		),
	},
	closedObject,
);
const WriteParamsSchema = Type.Object(
	{
		path: Type.String({ minLength: 1, maxLength: 32_768 }),
		contentBase64: Type.String(),
	},
	closedObject,
);
const MkdirParamsSchema = Type.Object(
	{
		path: Type.String({ minLength: 1, maxLength: 32_768 }),
		recursive: Type.Boolean(),
	},
	closedObject,
);
const GlobParamsSchema = Type.Object(
	{
		pattern: Type.String({ minLength: 1, maxLength: 32_768 }),
		cwd: Type.String({ minLength: 1, maxLength: 32_768 }),
		ignore: Type.Array(Type.String({ maxLength: 32_768 }), { maxItems: 4096 }),
		limit: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
	},
	closedObject,
);
const GrepParamsSchema = Type.Object(
	{
		pattern: Type.String({ maxLength: 1024 * 1024 }),
		path: Type.String({ minLength: 1, maxLength: 32_768 }),
		glob: Type.Optional(Type.String({ maxLength: 32_768 })),
		ignoreCase: Type.Optional(Type.Boolean()),
		literal: Type.Optional(Type.Boolean()),
		limit: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
	},
	closedObject,
);
const ExecParamsSchema = Type.Object(
	{
		command: Type.String({ minLength: 1 }),
		cwd: Type.String({ minLength: 1, maxLength: 32_768 }),
	},
	closedObject,
);
const TransferUploadParamsSchema = Type.Object(
	{
		path: Type.String({ minLength: 1, maxLength: 32_768 }),
		length: Type.Integer(safeIntegerOptions),
		sha256: HashSchema,
		overwrite: Type.Boolean(),
	},
	closedObject,
);
const TransferDownloadParamsSchema = Type.Object(
	{
		path: Type.String({ minLength: 1, maxLength: 32_768 }),
	},
	closedObject,
);

const ToolContentSchema = Type.Union([
	Type.Object({ type: Type.Literal("text"), text: Type.String() }, closedObject),
	Type.Object(
		{
			type: Type.Literal("image"),
			data: Type.String(),
			mimeType: Type.String({ minLength: 1, maxLength: 256 }),
		},
		closedObject,
	),
]);
const ToolResultSchema = Type.Object(
	{
		content: Type.Array(ToolContentSchema),
		details: Type.Optional(Type.Unknown()),
		terminate: Type.Optional(Type.Boolean()),
	},
	closedObject,
);
const EmptyResultSchema = EmptyParamsSchema;
const LspStatusServerSchema = Type.Object(
	{
		serverId: Type.String({ minLength: 1, maxLength: 256 }),
		languageIds: Type.Array(Type.String({ maxLength: 256 }), { maxItems: 256 }),
		transport: Type.String({ minLength: 1, maxLength: 128 }),
		instanceKey: Type.Optional(Type.String({ maxLength: 4096 })),
		workspaceRoot: Type.Optional(Type.String({ maxLength: 32_768 })),
		endpoint: Type.Optional(Type.String({ maxLength: 4096 })),
		rootUri: Type.Optional(Type.String({ maxLength: 32_768 })),
		ownership: Type.Union([Type.Literal("managed"), Type.Literal("attached")]),
		shutdownMode: Type.Union([Type.Literal("protocol"), Type.Literal("disconnect")]),
		state: Type.Union([
			Type.Literal("idle"),
			Type.Literal("connecting"),
			Type.Literal("initializing"),
			Type.Literal("running"),
			Type.Literal("closed"),
			Type.Literal("failed"),
			Type.Literal("disposed"),
		]),
		reconnectEligible: Type.Boolean(),
		running: Type.Boolean(),
		starting: Type.Boolean(),
		diagnosticsCount: Type.Integer(safeIntegerOptions),
		lastError: Type.Optional(Type.String()),
		lastRequestError: Type.Optional(Type.String()),
		stderr: Type.Optional(Type.String()),
		synchronizationError: Type.Optional(Type.String()),
	},
	closedObject,
);
const LspStatusResultSchema = Type.Object(
	{ enabled: Type.Boolean(), servers: Type.Array(LspStatusServerSchema, { maxItems: 1024 }) },
	closedObject,
);
export type RemoteLspStatus = Static<typeof LspStatusResultSchema>;
const ReadResultSchema = Type.Object(
	{
		contentBase64: Type.String(),
		workspace: RemoteWorkspaceIdentitySchema,
	},
	closedObject,
);
const StatResultSchema = Type.Object(
	{
		kind: Type.Union([Type.Literal("file"), Type.Literal("directory"), Type.Literal("other")]),
		workspace: RemoteWorkspaceIdentitySchema,
	},
	closedObject,
);
const ReaddirResultSchema = Type.Object(
	{
		entries: Type.Array(Type.String({ maxLength: 32_768 }), { maxItems: 1_000_000 }),
		workspace: RemoteWorkspaceIdentitySchema,
	},
	closedObject,
);
const GlobResultSchema = Type.Object(
	{
		matches: Type.Array(Type.String({ maxLength: 32_768 }), { maxItems: 1_000_000 }),
		workspace: RemoteWorkspaceIdentitySchema,
	},
	closedObject,
);
const GrepResultSchema = Type.Object(
	{
		isDirectory: Type.Boolean(),
		matches: Type.Array(
			Type.Object(
				{
					filePath: Type.String({ minLength: 1, maxLength: 32_768 }),
					lineNumber: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
					lineText: Type.Optional(Type.String()),
				},
				closedObject,
			),
			{ maxItems: 1_000_000 },
		),
		workspace: RemoteWorkspaceIdentitySchema,
	},
	closedObject,
);
const MimeResultSchema = Type.Object(
	{
		mimeType: Type.Union([
			Type.Literal("image/jpeg"),
			Type.Literal("image/png"),
			Type.Literal("image/gif"),
			Type.Literal("image/webp"),
			Type.Null(),
		]),
		workspace: RemoteWorkspaceIdentitySchema,
	},
	closedObject,
);
const ExecResultSchema = Type.Object(
	{ exitCode: Type.Union([Type.Integer({ minimum: 0, maximum: 255 }), Type.Null()]) },
	closedObject,
);
const TransferResultSchema = Type.Object(
	{
		length: Type.Integer(safeIntegerOptions),
		sha256: HashSchema,
	},
	closedObject,
);

const parameterValidators = {
	"catalog.get": Compile(CatalogGetParamsSchema),
	"tool.invoke": Compile(ToolInvokeParamsSchema),
	"workspace.access": Compile(AccessParamsSchema),
	"workspace.read": Compile(PathParamsSchema),
	"workspace.write": Compile(WriteParamsSchema),
	"workspace.mkdir": Compile(MkdirParamsSchema),
	"workspace.stat": Compile(PathParamsSchema),
	"workspace.readdir": Compile(PathParamsSchema),
	"workspace.glob": Compile(GlobParamsSchema),
	"workspace.grep": Compile(GrepParamsSchema),
	"workspace.detect_image_mime": Compile(PathParamsSchema),
	"workspace.exec": Compile(ExecParamsSchema),
	"lsp.status": Compile(EmptyParamsSchema),
	"resource.read": Compile(PathParamsSchema),
	"artifact.read": Compile(PathParamsSchema),
	"transfer.upload": Compile(TransferUploadParamsSchema),
	"transfer.download": Compile(TransferDownloadParamsSchema),
} satisfies Record<RemoteWorkspaceMethod, ReturnType<typeof Compile>>;

const resultValidators = {
	"catalog.get": Compile(RemoteWorkspaceCatalogSchema),
	"tool.invoke": Compile(ToolResultSchema),
	"workspace.access": Compile(EmptyResultSchema),
	"workspace.read": Compile(ReadResultSchema),
	"workspace.write": Compile(EmptyResultSchema),
	"workspace.mkdir": Compile(EmptyResultSchema),
	"workspace.stat": Compile(StatResultSchema),
	"workspace.readdir": Compile(ReaddirResultSchema),
	"workspace.glob": Compile(GlobResultSchema),
	"workspace.grep": Compile(GrepResultSchema),
	"workspace.detect_image_mime": Compile(MimeResultSchema),
	"workspace.exec": Compile(ExecResultSchema),
	"lsp.status": Compile(LspStatusResultSchema),
	"resource.read": Compile(ReadResultSchema),
	"artifact.read": Compile(TransferResultSchema),
	"transfer.upload": Compile(TransferResultSchema),
	"transfer.download": Compile(TransferResultSchema),
} satisfies Record<RemoteWorkspaceMethod, ReturnType<typeof Compile> | undefined>;

const clientMessageValidator = Compile(RemoteWorkspaceClientMessageSchema);
const serverMessageValidator = Compile(RemoteWorkspaceServerMessageSchema);
const handshakeAckValidator = Compile(RemoteWorkspaceHandshakeAckSchema);
const limitsValidator = Compile(RemoteWorkspaceLimitsSchema);

export class RemoteWorkspaceValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RemoteWorkspaceValidationError";
	}
}

function validationMessage(
	validator: { Errors(value: unknown): { instancePath: string; message: string }[] },
	value: unknown,
): string {
	const error = validator.Errors(value)[0];
	if (!error) return "value does not match the protocol schema";
	return `${error.instancePath || "/"}: ${error.message}`;
}

function parseWithValidator<T>(
	validator: { Check(value: unknown): boolean; Errors(value: unknown): { instancePath: string; message: string }[] },
	value: unknown,
	label: string,
): T {
	if (!validator.Check(value)) {
		throw new RemoteWorkspaceValidationError(`Invalid ${label}: ${validationMessage(validator, value)}`);
	}
	return value as T;
}

export function validateRemoteWorkspaceProtocolLimits(value: unknown): RemoteWorkspaceProtocolLimits {
	const limits = parseWithValidator<RemoteWorkspaceProtocolLimits>(limitsValidator, value, "protocol limits");
	if (limits.maxMessageBytes > limits.maxPendingInboundBytes) {
		throw new RemoteWorkspaceValidationError("maxMessageBytes must not exceed maxPendingInboundBytes");
	}
	if (limits.maxMessageBytes > limits.maxPendingOutboundBytes) {
		throw new RemoteWorkspaceValidationError("maxMessageBytes must not exceed maxPendingOutboundBytes");
	}
	if (limits.maxTransferChunkBytes > limits.maxPendingTransferBytes) {
		throw new RemoteWorkspaceValidationError("maxTransferChunkBytes must not exceed maxPendingTransferBytes");
	}
	if (Math.ceil((limits.maxTransferChunkBytes * 4) / 3) + 512 > limits.maxMessageBytes) {
		throw new RemoteWorkspaceValidationError("maxTransferChunkBytes must fit in one base64 protocol message");
	}
	return limits;
}

export function assertRemoteWorkspaceJsonStructure(
	value: unknown,
	limits: RemoteWorkspaceStructuralLimits = DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
): void {
	const pending: { value: unknown; depth: number }[] = [{ value, depth: 1 }];
	let nodes = 0;
	let objectKeys = 0;
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) break;
		nodes++;
		if (nodes > limits.maxNodes) throw new RemoteWorkspaceValidationError("Protocol value exceeds node limit");
		if (current.depth > limits.maxDepth)
			throw new RemoteWorkspaceValidationError("Protocol value exceeds depth limit");
		const currentValue = current.value;
		if (currentValue === null || typeof currentValue === "boolean") continue;
		if (typeof currentValue === "number") {
			if (!Number.isFinite(currentValue))
				throw new RemoteWorkspaceValidationError("Protocol numbers must be finite");
			continue;
		}
		if (typeof currentValue === "string") {
			if (Buffer.byteLength(currentValue, "utf8") > limits.maxStringBytes) {
				throw new RemoteWorkspaceValidationError("Protocol string exceeds byte limit");
			}
			continue;
		}
		if (Array.isArray(currentValue)) {
			if (currentValue.length > limits.maxArrayLength) {
				throw new RemoteWorkspaceValidationError("Protocol array exceeds item limit");
			}
			for (let index = currentValue.length - 1; index >= 0; index--) {
				pending.push({ value: currentValue[index], depth: current.depth + 1 });
			}
			continue;
		}
		if (typeof currentValue !== "object") {
			throw new RemoteWorkspaceValidationError("Protocol values must be JSON-compatible");
		}
		const prototype = Object.getPrototypeOf(currentValue);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new RemoteWorkspaceValidationError("Protocol objects must be plain JSON objects");
		}
		const entries = Object.entries(currentValue);
		if (entries.length > limits.maxObjectKeys) {
			throw new RemoteWorkspaceValidationError("Protocol object exceeds key limit");
		}
		objectKeys += entries.length;
		if (objectKeys > limits.maxObjectKeys) {
			throw new RemoteWorkspaceValidationError("Protocol value exceeds total key limit");
		}
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (!entry) continue;
			if (Buffer.byteLength(entry[0], "utf8") > limits.maxStringBytes) {
				throw new RemoteWorkspaceValidationError("Protocol object key exceeds byte limit");
			}
			pending.push({ value: entry[1], depth: current.depth + 1 });
		}
	}
}

export function decodeRemoteWorkspaceMessage(
	payload: string | Uint8Array,
	limits: RemoteWorkspaceStructuralLimits = DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
): unknown {
	const bytes = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
	if (bytes.byteLength > limits.maxMessageBytes) {
		throw new RemoteWorkspaceValidationError("Protocol message exceeds byte limit");
	}
	const text = typeof payload === "string" ? payload : new TextDecoder("utf-8", { fatal: true }).decode(payload);
	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch (error) {
		throw new RemoteWorkspaceValidationError(
			`Protocol message is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	assertRemoteWorkspaceJsonStructure(value, limits);
	return value;
}

export function parseRemoteWorkspaceClientMessage(
	value: unknown,
	limits: RemoteWorkspaceStructuralLimits = DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
): RemoteWorkspaceClientMessage {
	assertRemoteWorkspaceJsonStructure(value, limits);
	return parseWithValidator<RemoteWorkspaceClientMessage>(clientMessageValidator, value, "client message");
}

export function parseRemoteWorkspaceServerMessage(
	value: unknown,
	limits: RemoteWorkspaceStructuralLimits = DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
): RemoteWorkspaceServerMessage {
	assertRemoteWorkspaceJsonStructure(value, limits);
	return parseWithValidator<RemoteWorkspaceServerMessage>(serverMessageValidator, value, "server message");
}

export function isRemoteWorkspaceMethod(method: string): method is RemoteWorkspaceMethod {
	return (REMOTE_WORKSPACE_METHODS as readonly string[]).includes(method);
}

export function parseRemoteWorkspaceRequestParams(
	method: RemoteWorkspaceMethod,
	value: unknown,
	limits: RemoteWorkspaceStructuralLimits = DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
): unknown {
	assertRemoteWorkspaceJsonStructure(value, limits);
	const parsed = parseWithValidator(parameterValidators[method], value, `${method} params`);
	if (method === "workspace.write") {
		decodeCanonicalBase64((parsed as { contentBase64: string }).contentBase64, limits.maxMessageBytes);
	}
	return parsed;
}

export function parseRemoteWorkspaceResult(
	method: RemoteWorkspaceMethod,
	value: unknown,
	limits: RemoteWorkspaceStructuralLimits = DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
): unknown {
	assertRemoteWorkspaceJsonStructure(value, limits);
	const validator = resultValidators[method];
	const parsed = validator ? parseWithValidator(validator, value, `${method} result`) : value;
	if (method === "workspace.read" || method === "resource.read") {
		decodeCanonicalBase64((parsed as { contentBase64: string }).contentBase64, limits.maxMessageBytes);
	}
	return parsed;
}

export function parseRemoteWorkspaceToolResult(
	value: unknown,
	limits: RemoteWorkspaceStructuralLimits = DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
): unknown {
	assertRemoteWorkspaceJsonStructure(value, limits);
	return parseWithValidator(Compile(ToolResultSchema), value, "tool result");
}

export function decodeCanonicalBase64(value: string, maxBytes: number): Buffer {
	if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
		throw new RemoteWorkspaceValidationError("Transfer data is not canonical base64");
	}
	const decoded = Buffer.from(value, "base64");
	if (decoded.byteLength > maxBytes) throw new RemoteWorkspaceValidationError("Transfer chunk exceeds byte limit");
	if (decoded.toString("base64") !== value) {
		throw new RemoteWorkspaceValidationError("Transfer data is not canonical base64");
	}
	return decoded;
}

function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new RemoteWorkspaceValidationError("Cannot hash a non-finite number");
		return JSON.stringify(value);
	}
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	if (typeof value !== "object" || value === undefined) {
		throw new RemoteWorkspaceValidationError("Cannot hash a non-JSON value");
	}
	const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

export function hashRemoteWorkspaceJson(value: unknown): string {
	assertRemoteWorkspaceJsonStructure(value);
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function hashRemoteWorkspaceCatalog(catalog: RemoteWorkspaceCatalog): string {
	return hashRemoteWorkspaceJson(catalog);
}

function assertUnique(values: readonly string[], label: string): void {
	if (new Set(values).size !== values.length) throw new RemoteWorkspaceValidationError(`${label} contains duplicates`);
}

export function validateRemoteWorkspaceCatalog(catalog: RemoteWorkspaceCatalog): void {
	parseWithValidator(Compile(RemoteWorkspaceCatalogSchema), catalog, "tool catalog");
	assertUnique(catalog.operations, "Catalog operations");
	assertUnique(
		catalog.tools.map((tool) => tool.name),
		"Catalog tool names",
	);
	for (const tool of catalog.tools) {
		assertUnique(tool.featureFlags, `Feature flags for ${tool.name}`);
		if (hashRemoteWorkspaceJson(tool.parameterSchema) !== tool.schemaHash) {
			throw new RemoteWorkspaceValidationError(`Schema hash mismatch for tool ${tool.name}`);
		}
	}
}

export function validateRemoteWorkspaceLocalToolSchemas(
	catalog: RemoteWorkspaceCatalog,
	localToolSchemas: ReadonlyMap<string, string>,
): void {
	for (const tool of catalog.tools) {
		const localHash = localToolSchemas.get(tool.name);
		if (localHash !== undefined && localHash !== tool.schemaHash) {
			throw new RemoteWorkspaceValidationError(
				`Remote schema does not match the local canonical schema for ${tool.name}`,
			);
		}
	}
}

export function validateRemoteWorkspaceHandshakeAck(
	ack: unknown,
	offer: RemoteWorkspaceHandshake,
	localToolSchemas: ReadonlyMap<string, string> = new Map(),
): RemoteWorkspaceHandshakeAck {
	const parsed = parseWithValidator<RemoteWorkspaceHandshakeAck>(handshakeAckValidator, ack, "handshake response");
	validateRemoteWorkspaceProtocolLimits(offer.receiveLimits);
	validateRemoteWorkspaceProtocolLimits(parsed.limits);
	const selected = offer.versions.some(
		(range) =>
			range.major === parsed.version.major &&
			range.minMinor <= parsed.version.minor &&
			range.maxMinor >= parsed.version.minor,
	);
	if (!selected)
		throw new RemoteWorkspaceValidationError("Server selected a protocol version outside the offered range");
	const offeredCapabilities = new Set([...offer.requiredCapabilities, ...offer.optionalCapabilities]);
	for (const capability of parsed.capabilities) {
		if (!offeredCapabilities.has(capability)) {
			throw new RemoteWorkspaceValidationError(`Server selected an unoffered capability: ${capability}`);
		}
	}
	for (const capability of offer.requiredCapabilities) {
		if (!parsed.capabilities.includes(capability)) {
			throw new RemoteWorkspaceValidationError(`Server omitted required capability: ${capability}`);
		}
	}
	assertUnique(parsed.capabilities, "Negotiated capabilities");
	validateRemoteWorkspaceCatalog(parsed.catalog);
	if (hashRemoteWorkspaceCatalog(parsed.catalog) !== parsed.catalogHash) {
		throw new RemoteWorkspaceValidationError("Catalog hash does not match the negotiated catalog");
	}
	validateRemoteWorkspaceLocalToolSchemas(parsed.catalog, localToolSchemas);
	for (const key of Object.keys(offer.receiveLimits) as (keyof RemoteWorkspaceProtocolLimits)[]) {
		if (parsed.limits[key] > offer.receiveLimits[key]) {
			throw new RemoteWorkspaceValidationError(`Server increased negotiated limit: ${key}`);
		}
	}
	return parsed;
}

export interface RemoteWorkspaceNegotiationOptions {
	serverVersions: readonly RemoteWorkspaceVersionRange[];
	serverCapabilities: readonly string[];
	requiredClientCapabilities?: readonly string[];
	serverLimits: RemoteWorkspaceProtocolLimits;
}

export interface RemoteWorkspaceNegotiationResult {
	version: RemoteWorkspaceVersion;
	capabilities: string[];
	limits: RemoteWorkspaceProtocolLimits;
}

export class RemoteWorkspaceNegotiationError extends Error {
	readonly code: "incompatible_version" | "capability_mismatch";

	constructor(code: "incompatible_version" | "capability_mismatch", message: string) {
		super(message);
		this.name = "RemoteWorkspaceNegotiationError";
		this.code = code;
	}
}

function validateVersionRanges(ranges: readonly RemoteWorkspaceVersionRange[], label: string): void {
	for (const range of ranges) {
		if (range.minMinor > range.maxMinor) {
			throw new RemoteWorkspaceNegotiationError("incompatible_version", `${label} has an inverted minor range`);
		}
	}
}

export function negotiateRemoteWorkspaceHandshake(
	handshake: RemoteWorkspaceHandshake,
	options: RemoteWorkspaceNegotiationOptions,
): RemoteWorkspaceNegotiationResult {
	validateRemoteWorkspaceProtocolLimits(handshake.receiveLimits);
	validateRemoteWorkspaceProtocolLimits(options.serverLimits);
	validateVersionRanges(handshake.versions, "Client version offer");
	validateVersionRanges(options.serverVersions, "Server version offer");
	assertUnique(handshake.requiredCapabilities, "Required capabilities");
	assertUnique(handshake.optionalCapabilities, "Optional capabilities");
	const duplicateOffer = handshake.requiredCapabilities.find((capability) =>
		handshake.optionalCapabilities.includes(capability),
	);
	if (duplicateOffer) {
		throw new RemoteWorkspaceNegotiationError(
			"capability_mismatch",
			`Capability is both required and optional: ${duplicateOffer}`,
		);
	}
	const candidates: RemoteWorkspaceVersion[] = [];
	for (const client of handshake.versions) {
		for (const server of options.serverVersions) {
			if (client.major !== server.major) continue;
			const minMinor = Math.max(client.minMinor, server.minMinor);
			const maxMinor = Math.min(client.maxMinor, server.maxMinor);
			if (minMinor <= maxMinor) candidates.push({ major: client.major, minor: maxMinor });
		}
	}
	candidates.sort((left, right) => right.major - left.major || right.minor - left.minor);
	const version = candidates[0];
	if (!version) {
		throw new RemoteWorkspaceNegotiationError(
			"incompatible_version",
			"No compatible remote workspace protocol version",
		);
	}
	const serverCapabilities = new Set(options.serverCapabilities);
	for (const capability of handshake.requiredCapabilities) {
		if (!serverCapabilities.has(capability)) {
			throw new RemoteWorkspaceNegotiationError(
				"capability_mismatch",
				`Server does not support required capability: ${capability}`,
			);
		}
	}
	const clientCapabilities = new Set([...handshake.requiredCapabilities, ...handshake.optionalCapabilities]);
	for (const capability of options.requiredClientCapabilities ?? []) {
		if (!clientCapabilities.has(capability)) {
			throw new RemoteWorkspaceNegotiationError(
				"capability_mismatch",
				`Client does not support required capability: ${capability}`,
			);
		}
	}
	const capabilities = Array.from(clientCapabilities)
		.filter((capability) => serverCapabilities.has(capability))
		.sort();
	const clientLimits = handshake.receiveLimits;
	const serverLimits = options.serverLimits;
	return {
		version,
		capabilities,
		limits: {
			maxMessageBytes: Math.min(clientLimits.maxMessageBytes, serverLimits.maxMessageBytes),
			maxStringBytes: Math.min(clientLimits.maxStringBytes, serverLimits.maxStringBytes),
			maxDepth: Math.min(clientLimits.maxDepth, serverLimits.maxDepth),
			maxObjectKeys: Math.min(clientLimits.maxObjectKeys, serverLimits.maxObjectKeys),
			maxArrayLength: Math.min(clientLimits.maxArrayLength, serverLimits.maxArrayLength),
			maxNodes: Math.min(clientLimits.maxNodes, serverLimits.maxNodes),
			maxRequestMs: Math.min(clientLimits.maxRequestMs, serverLimits.maxRequestMs),
			maxTransferChunkBytes: Math.min(clientLimits.maxTransferChunkBytes, serverLimits.maxTransferChunkBytes),
			maxPendingTransferBytes: Math.min(clientLimits.maxPendingTransferBytes, serverLimits.maxPendingTransferBytes),
			maxPendingInboundBytes: Math.min(clientLimits.maxPendingInboundBytes, serverLimits.maxPendingInboundBytes),
			maxPendingInboundMessages: Math.min(
				clientLimits.maxPendingInboundMessages,
				serverLimits.maxPendingInboundMessages,
			),
			maxPendingOutboundBytes: Math.min(clientLimits.maxPendingOutboundBytes, serverLimits.maxPendingOutboundBytes),
			maxPendingOutboundMessages: Math.min(
				clientLimits.maxPendingOutboundMessages,
				serverLimits.maxPendingOutboundMessages,
			),
			maxTransferBytes: Math.min(clientLimits.maxTransferBytes, serverLimits.maxTransferBytes),
			maxTransferChunks: Math.min(clientLimits.maxTransferChunks, serverLimits.maxTransferChunks),
			maxActiveRequests: Math.min(clientLimits.maxActiveRequests, serverLimits.maxActiveRequests),
			maxActiveTransfers: Math.min(clientLimits.maxActiveTransfers, serverLimits.maxActiveTransfers),
			maxCancellationMs: Math.min(clientLimits.maxCancellationMs, serverLimits.maxCancellationMs),
			maxTransportSendMs: Math.min(clientLimits.maxTransportSendMs, serverLimits.maxTransportSendMs),
		},
	};
}

export function getRemoteWorkspaceMethodKind(method: RemoteWorkspaceMethod): RemoteWorkspaceOperationKind {
	switch (method) {
		case "workspace.write":
		case "workspace.mkdir":
		case "transfer.upload":
			return "mutation";
		case "workspace.exec":
			return "process";
		case "tool.invoke":
			return "service";
		default:
			return "read";
	}
}
