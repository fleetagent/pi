import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
	decodeRemoteWorkspaceMessage,
	hashRemoteWorkspaceCatalog,
	hashRemoteWorkspaceJson,
	negotiateRemoteWorkspaceHandshake,
	parseRemoteWorkspaceClientMessage,
	parseRemoteWorkspaceRequestParams,
	parseRemoteWorkspaceResult,
	REMOTE_WORKSPACE_PROTOCOL_VERSIONS,
	type RemoteWorkspaceCatalog,
	type RemoteWorkspaceClientMessage,
	type RemoteWorkspaceHandshake,
	type RemoteWorkspaceIdentity,
	type RemoteWorkspaceMethod,
	RemoteWorkspaceNegotiationError,
	type RemoteWorkspaceProtocolLimits,
	type RemoteWorkspaceServerMessage,
	type RemoteWorkspaceVersionRange,
	validateRemoteWorkspaceCatalog,
	validateRemoteWorkspaceHandshakeAck,
} from "../src/core/remote-workspace-protocol/contract.ts";
import {
	RemoteWorkspaceClientProtocol,
	RemoteWorkspaceDisconnectedError,
	type RemoteWorkspaceProtocolCloseReason,
	type RemoteWorkspaceProtocolTransport,
	RemoteWorkspaceRequestError,
	type RemoteWorkspaceServerHandler,
	RemoteWorkspaceServerProtocol,
	type RemoteWorkspaceServerRequestContext,
	RemoteWorkspaceTerminationError,
} from "../src/core/remote-workspace-protocol/session.ts";

const workspace: RemoteWorkspaceIdentity = {
	id: "workspace_fixture_1234",
	root: "/workspace",
	pathFlavor: "posix",
};

const readParameterSchema = {
	type: "object",
	properties: { path: { type: "string" } },
	required: ["path"],
	additionalProperties: false,
};

function createCatalog(generation = 1): RemoteWorkspaceCatalog {
	return {
		generation,
		tools: [
			{
				name: "read",
				executionMode: "read",
				parameterSchema: readParameterSchema,
				schemaHash: hashRemoteWorkspaceJson(readParameterSchema),
				featureFlags: [],
			},
			{
				name: "write",
				executionMode: "mutation",
				parameterSchema: {
					type: "object",
					properties: { path: { type: "string" }, content: { type: "string" } },
					required: ["path", "content"],
					additionalProperties: false,
				},
				schemaHash: "",
				featureFlags: [],
			},
		],
		operations: [
			"workspace.access",
			"workspace.read",
			"workspace.write",
			"workspace.mkdir",
			"workspace.stat",
			"workspace.exec",
			"resource.read",
			"transfer.upload",
			"transfer.download",
		],
	};
}

function validCatalog(generation = 1): RemoteWorkspaceCatalog {
	const catalog = createCatalog(generation);
	const write = catalog.tools[1];
	if (!write) throw new Error("Missing write fixture");
	write.schemaHash = hashRemoteWorkspaceJson(write.parameterSchema);
	return catalog;
}

function handshake(
	id = "handshake-1",
	versions: readonly RemoteWorkspaceVersionRange[] = REMOTE_WORKSPACE_PROTOCOL_VERSIONS,
): RemoteWorkspaceHandshake {
	return {
		type: "handshake",
		id,
		versions: versions.map((version) => ({ ...version })),
		requiredCapabilities: ["primitive_operations"],
		optionalCapabilities: ["tool_updates", "file_transfer", "catalog_refresh"],
		receiveLimits: { ...DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS },
	};
}

interface ProtocolPair {
	client: RemoteWorkspaceClientProtocol;
	server: RemoteWorkspaceServerProtocol;
	clientMessages: RemoteWorkspaceClientMessage[];
	serverMessages: RemoteWorkspaceServerMessage[];
	clientCloses: RemoteWorkspaceProtocolCloseReason[];
	serverCloses: RemoteWorkspaceProtocolCloseReason[];
}

type ProtocolPairRequiredCapability = "primitive_operations" | "file_transfer";

interface ProtocolPairOptions {
	catalog?: RemoteWorkspaceCatalog;
	clientVersions?: RemoteWorkspaceHandshake["versions"];
	serverVersions?: RemoteWorkspaceHandshake["versions"];
	clientRequiredCapabilities?: ProtocolPairRequiredCapability[];
	serverCapabilities?: string[];
	limits?: RemoteWorkspaceProtocolLimits;
	onCatalogChanged?: (generation: number) => void;
	onCatalogRefreshed?: (catalog: RemoteWorkspaceCatalog) => void | Promise<void>;
}

interface ServerHarnessOptions {
	catalog?: RemoteWorkspaceCatalog;
	capabilities?: string[];
	limits?: RemoteWorkspaceProtocolLimits;
}

function createProtocolPair(handler: RemoteWorkspaceServerHandler, options: ProtocolPairOptions = {}): ProtocolPair {
	const catalog = options.catalog ?? validCatalog();
	const localToolSchemas = new Map(catalog.tools.map((tool) => [tool.name, tool.schemaHash]));
	const clientMessages: RemoteWorkspaceClientMessage[] = [];
	const serverMessages: RemoteWorkspaceServerMessage[] = [];
	const clientCloses: RemoteWorkspaceProtocolCloseReason[] = [];
	const serverCloses: RemoteWorkspaceProtocolCloseReason[] = [];
	let client: RemoteWorkspaceClientProtocol;
	let server: RemoteWorkspaceServerProtocol;
	const clientTransport: RemoteWorkspaceProtocolTransport<RemoteWorkspaceClientMessage> = {
		send: async (message) => {
			clientMessages.push(message);
			await server.receive(JSON.stringify(message));
		},
		close: async (reason) => {
			clientCloses.push(reason);
			await server.disconnect();
		},
	};
	const serverTransport: RemoteWorkspaceProtocolTransport<RemoteWorkspaceServerMessage> = {
		send: async (message) => {
			serverMessages.push(message);
			await client.receive(JSON.stringify(message));
		},
		close: async (reason) => {
			serverCloses.push(reason);
			await client.disconnect(reason.message);
		},
	};
	client = new RemoteWorkspaceClientProtocol(clientTransport, {
		versions: options.clientVersions,
		requiredCapabilities: options.clientRequiredCapabilities ?? ["primitive_operations"],
		optionalCapabilities: ["tool_updates", "file_transfer", "catalog_refresh"],
		receiveLimits: options.limits,
		localToolSchemas,
		onCatalogChanged: (event) => options.onCatalogChanged?.(event.generation),
		onCatalogRefreshed: options.onCatalogRefreshed,
	});
	server = new RemoteWorkspaceServerProtocol(serverTransport, handler, {
		workspace,
		catalog,
		capabilities: options.serverCapabilities ?? [
			"primitive_operations",
			"tool_updates",
			"file_transfer",
			"catalog_refresh",
		],
		versions: options.serverVersions,
		limits: options.limits,
	});
	return { client, server, clientMessages, serverMessages, clientCloses, serverCloses };
}

function createServerHarness(
	handler: RemoteWorkspaceServerHandler = defaultHandler(),
	options: ServerHarnessOptions = {},
) {
	const messages: RemoteWorkspaceServerMessage[] = [];
	const closes: RemoteWorkspaceProtocolCloseReason[] = [];
	const server = new RemoteWorkspaceServerProtocol(
		{
			send: async (message) => {
				messages.push(message);
			},
			close: (reason) => {
				closes.push(reason);
			},
		},
		handler,
		{
			workspace,
			catalog: options.catalog ?? validCatalog(),
			capabilities: options.capabilities ?? [
				"primitive_operations",
				"tool_updates",
				"file_transfer",
				"catalog_refresh",
			],
			limits: options.limits,
		},
	);
	return { server, messages, closes };
}

function statResult() {
	return { kind: "file", workspace } as const;
}

function defaultHandler(overrides: Partial<RemoteWorkspaceServerHandler> = {}): RemoteWorkspaceServerHandler {
	return {
		handleRequest: async (request) => {
			switch (request.method) {
				case "workspace.stat":
					return statResult();
				case "workspace.read":
				case "resource.read":
					return { contentBase64: Buffer.from("fixture").toString("base64"), workspace };
				case "workspace.access":
				case "workspace.write":
				case "workspace.mkdir":
					return {};
				case "tool.invoke":
					return { content: [{ type: "text", text: "ok" }] };
				default:
					return {};
			}
		},
		validateToolArguments: (_toolName, value) =>
			typeof value === "object" && value !== null && "path" in value && typeof value.path === "string",
		...overrides,
	};
}

async function expectRequestError(promise: Promise<unknown>, code: string, executionState: string): Promise<void> {
	await expect(promise).rejects.toMatchObject({ code, executionState });
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for protocol condition");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

describe("remote workspace protocol contract", () => {
	it("hashes schemas and catalogs canonically and validates catalog integrity", () => {
		expect(hashRemoteWorkspaceJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
			hashRemoteWorkspaceJson({ a: { c: 3, d: 4 }, b: 2 }),
		);
		const catalog = validCatalog();
		expect(() => validateRemoteWorkspaceCatalog(catalog)).not.toThrow();
		expect(hashRemoteWorkspaceCatalog(catalog)).toMatch(/^[0-9a-f]{64}$/);
		catalog.tools[0]!.schemaHash = "0".repeat(64);
		expect(() => validateRemoteWorkspaceCatalog(catalog)).toThrow(/Schema hash mismatch/);
	});

	it("fatally decodes UTF-8 and enforces iterative structural bounds", () => {
		expect(decodeRemoteWorkspaceMessage(Buffer.from('{"ok":true}'))).toEqual({ ok: true });
		expect(() => decodeRemoteWorkspaceMessage(Uint8Array.from([0xc3, 0x28]))).toThrow();
		expect(() =>
			decodeRemoteWorkspaceMessage('{"value":"toolong"}', {
				...DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
				maxStringBytes: 5,
			}),
		).toThrow(/string exceeds/);
		expect(() =>
			decodeRemoteWorkspaceMessage('{"a":{"b":{"c":1}}}', {
				...DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
				maxDepth: 3,
			}),
		).toThrow(/depth/);
		expect(() =>
			decodeRemoteWorkspaceMessage('{"a":1,"b":2}', {
				...DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
				maxObjectKeys: 1,
			}),
		).toThrow(/key/);
		expect(() =>
			decodeRemoteWorkspaceMessage("[1,2]", {
				...DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
				maxArrayLength: 1,
			}),
		).toThrow(/array/);
		expect(() =>
			decodeRemoteWorkspaceMessage('{"a":1,"b":2}', {
				...DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
				maxNodes: 2,
			}),
		).toThrow(/node/);
	});

	it("rejects unknown fields and validates every method's parameters and results", () => {
		expect(() => parseRemoteWorkspaceClientMessage({ ...handshake(), unexpected: true })).toThrow(
			/Invalid client message/,
		);
		const validParams: Record<RemoteWorkspaceMethod, unknown> = {
			"catalog.get": {},
			"tool.invoke": {
				generation: 1,
				catalogHash: "0".repeat(64),
				toolName: "read",
				schemaHash: "1".repeat(64),
				argumentsPrepared: true,
				arguments: { path: "a" },
				executionOptions: {},
			},
			"workspace.access": { path: "a", mode: "read" },
			"workspace.read": { path: "a" },
			"workspace.write": { path: "a", contentBase64: "YQ==" },
			"workspace.mkdir": { path: "a", recursive: true },
			"workspace.stat": { path: "a" },
			"workspace.readdir": { path: "a" },
			"workspace.glob": { pattern: "*.ts", cwd: "/workspace", ignore: [], limit: 10 },
			"workspace.grep": { pattern: "x", path: "/workspace", limit: 10 },
			"workspace.detect_image_mime": { path: "a" },
			"workspace.exec": { command: "pwd", cwd: "/workspace" },
			"lsp.status": {},
			"resource.read": { path: ".pi/SYSTEM.md" },
			"artifact.read": { path: "pi-artifact://workspace_fixture_1234/id" },
			"transfer.upload": { path: "a", length: 1, sha256: "0".repeat(64), overwrite: false },
			"transfer.download": { path: "a" },
		};
		for (const [method, params] of Object.entries(validParams) as [RemoteWorkspaceMethod, unknown][]) {
			expect(() => parseRemoteWorkspaceRequestParams(method, params), method).not.toThrow();
			expect(
				() => parseRemoteWorkspaceRequestParams(method, { ...(params as object), unexpected: true }),
				method,
			).toThrow();
		}
		expect(() => parseRemoteWorkspaceResult("lsp.status", { enabled: false, servers: [] })).not.toThrow();
		expect(() => parseRemoteWorkspaceResult("workspace.stat", statResult())).not.toThrow();
		expect(() => parseRemoteWorkspaceResult("workspace.stat", { ...statResult(), extra: true })).toThrow();
		expect(() =>
			parseRemoteWorkspaceResult("tool.invoke", {
				content: [{ type: "text", text: "ok" }],
				details: { arbitrary: ["json"] },
				terminate: false,
			}),
		).not.toThrow();
		expect(() => parseRemoteWorkspaceResult("tool.invoke", { content: [{ type: "bogus" }] })).toThrow();
	});

	it("negotiates the highest common version, capabilities, and receive limits", () => {
		const offer = handshake("h", [
			{ major: 1, minMinor: 0, maxMinor: 4 },
			{ major: 2, minMinor: 0, maxMinor: 3 },
		]);
		const result = negotiateRemoteWorkspaceHandshake(offer, {
			serverVersions: [
				{ major: 1, minMinor: 2, maxMinor: 8 },
				{ major: 2, minMinor: 0, maxMinor: 1 },
			],
			serverCapabilities: ["primitive_operations", "tool_updates"],
			serverLimits: { ...DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS, maxRequestMs: 5000 },
		});
		expect(result.version).toEqual({ major: 2, minor: 1 });
		expect(result.capabilities).toEqual(["primitive_operations", "tool_updates"]);
		expect(result.limits.maxRequestMs).toBe(5000);
	});

	it("rejects incompatible versions and capabilities before dispatch", async () => {
		const handler = defaultHandler({ handleRequest: vi.fn(defaultHandler().handleRequest) });
		const pair = createProtocolPair(handler, {
			clientVersions: [{ major: 2, minMinor: 0, maxMinor: 0 }],
			serverVersions: [{ major: 1, minMinor: 0, maxMinor: 0 }],
		});
		await expect(pair.client.start()).rejects.toMatchObject({ code: "incompatible_version" });
		expect(handler.handleRequest).not.toHaveBeenCalled();
		expect(pair.serverCloses).toHaveLength(1);

		const offer = handshake();
		offer.requiredCapabilities = ["unknown_required"];
		expect(() =>
			negotiateRemoteWorkspaceHandshake(offer, {
				serverVersions: REMOTE_WORKSPACE_PROTOCOL_VERSIONS,
				serverCapabilities: ["primitive_operations"],
				serverLimits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
			}),
		).toThrow(RemoteWorkspaceNegotiationError);
	});

	it("rejects unoffered capabilities and local canonical schema mismatches", () => {
		const offer = handshake();
		const catalog = validCatalog();
		const ack = {
			type: "handshake_ack" as const,
			id: offer.id,
			version: { major: 1, minor: 0 },
			capabilities: ["primitive_operations"],
			workspace,
			limits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
			catalog,
			catalogHash: hashRemoteWorkspaceCatalog(catalog),
			backendMetadata: { kind: "remote-workspace" as const },
		};
		expect(() =>
			validateRemoteWorkspaceHandshakeAck({ ...ack, capabilities: ["primitive_operations", "artifacts"] }, offer),
		).toThrow(/unoffered capability/);
		expect(() => validateRemoteWorkspaceHandshakeAck(ack, offer, new Map([["read", "0".repeat(64)]]))).toThrow(
			/local canonical schema/,
		);
	});
});

describe("remote workspace protocol sessions", () => {
	it("shares one contract across handshake, catalog, invocation, updates, and results", async () => {
		const updates: unknown[] = [];
		const handler = defaultHandler({
			handleRequest: async (request, context) => {
				if (request.method === "tool.invoke") {
					await Promise.all([
						context.sendUpdate({ kind: "output", text: "first" }),
						context.sendUpdate({ kind: "output", text: "second" }),
					]);
					return { content: [{ type: "text", text: "done" }] };
				}
				return statResult();
			},
		});
		const pair = createProtocolPair(handler);
		const ack = await pair.client.start();
		expect(ack.workspace).toEqual(workspace);
		expect(ack.catalogHash).toBe(hashRemoteWorkspaceCatalog(ack.catalog));
		expect(await pair.client.request("workspace.stat", { path: "a" })).toEqual(statResult());
		const read = ack.catalog.tools.find((tool) => tool.name === "read")!;
		const result = await pair.client.request(
			"tool.invoke",
			{
				generation: ack.catalog.generation,
				catalogHash: ack.catalogHash,
				toolName: read.name,
				schemaHash: read.schemaHash,
				argumentsPrepared: true,
				arguments: { path: "a" },
				executionOptions: {},
			},
			{
				onUpdate: (update) => {
					updates.push(update);
				},
			},
		);
		expect(updates).toEqual([
			{ kind: "output", text: "first" },
			{ kind: "output", text: "second" },
		]);
		expect(result).toEqual({ content: [{ type: "text", text: "done" }] });
	});

	it("rejects pre-handshake operations, duplicate IDs, and unknown methods deterministically", async () => {
		const early = createServerHarness();
		await early.server.receive(
			JSON.stringify({
				type: "request",
				id: "early",
				method: "workspace.stat",
				timeoutMs: 100,
				params: { path: "a" },
			}),
		);
		expect(early.closes).toEqual([{ code: "protocol_error", message: "Request received before handshake" }]);

		const duplicate = createServerHarness();
		await duplicate.server.receive(JSON.stringify(handshake("same")));
		await duplicate.server.receive(
			JSON.stringify({
				type: "request",
				id: "same",
				method: "workspace.stat",
				timeoutMs: 100,
				params: { path: "a" },
			}),
		);
		expect(duplicate.closes.at(-1)?.message).toContain("Duplicate request ID");

		const unknown = createServerHarness();
		await unknown.server.receive(JSON.stringify(handshake()));
		await unknown.server.receive(
			JSON.stringify({ type: "request", id: "unknown", method: "no.such.method", timeoutMs: 100, params: {} }),
		);
		expect(unknown.messages.at(-1)).toMatchObject({
			type: "error",
			id: "unknown",
			error: { code: "method_not_supported", executionState: "not_started" },
		});
		expect(unknown.closes).toHaveLength(0);
	});

	it("classifies fatal UTF-8 and oversized ingress before dispatch", async () => {
		const invalidUtf8 = createServerHarness();
		await invalidUtf8.server.receive(Uint8Array.from([0xc3, 0x28]));
		expect(invalidUtf8.closes).toEqual([expect.objectContaining({ code: "invalid_payload" })]);

		const limits = {
			...DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
			maxMessageBytes: 2048,
			maxTransferChunkBytes: 1024,
		};
		const oversized = createServerHarness(defaultHandler(), { limits });
		await oversized.server.receive(JSON.stringify({ padding: "x".repeat(2048) }));
		expect(oversized.closes).toEqual([expect.objectContaining({ code: "message_too_large" })]);
	});

	it("rejects known but unavailable or unnegotiated operations before dispatch", async () => {
		const handleRequest = vi.fn(defaultHandler().handleRequest);
		const catalog = validCatalog();
		catalog.operations = catalog.operations.filter((method) => method !== "workspace.exec");
		const unavailable = createServerHarness(defaultHandler({ handleRequest }), { catalog });
		await unavailable.server.receive(JSON.stringify(handshake()));
		await unavailable.server.receive(
			JSON.stringify({
				type: "request",
				id: "disabled-exec",
				method: "workspace.exec",
				timeoutMs: 100,
				params: { command: "pwd", cwd: "/workspace" },
			}),
		);
		expect(unavailable.messages.at(-1)).toMatchObject({
			type: "error",
			error: { code: "not_available", executionState: "not_started" },
		});
		expect(handleRequest).not.toHaveBeenCalled();

		const unnegotiated = createServerHarness(defaultHandler({ handleRequest }));
		const offer = handshake("without-transfer");
		offer.optionalCapabilities = ["tool_updates", "catalog_refresh"];
		await unnegotiated.server.receive(JSON.stringify(offer));
		await unnegotiated.server.receive(
			JSON.stringify({
				type: "request",
				id: "disabled-transfer",
				method: "transfer.download",
				timeoutMs: 100,
				params: { path: "a" },
			}),
		);
		expect(unnegotiated.messages.at(-1)).toMatchObject({ type: "error", error: { code: "not_available" } });
		expect(handleRequest).not.toHaveBeenCalled();

		const flaggedCatalog = validCatalog();
		flaggedCatalog.tools[0]!.featureFlags = ["artifacts"];
		const flagged = createProtocolPair(defaultHandler({ handleRequest }), {
			catalog: flaggedCatalog,
			serverCapabilities: ["primitive_operations", "tool_updates", "file_transfer", "catalog_refresh", "artifacts"],
		});
		const ack = await flagged.client.start();
		const read = ack.catalog.tools[0]!;
		expect(() =>
			flagged.client.request("tool.invoke", {
				generation: ack.catalog.generation,
				catalogHash: ack.catalogHash,
				toolName: read.name,
				schemaHash: read.schemaHash,
				argumentsPrepared: true,
				arguments: { path: "a" },
				executionOptions: {},
			}),
		).toThrow(/unnegotiated capability/);
	});

	it("bounds malformed requests with strikes and closes malformed messages without usable IDs", async () => {
		const malformed = createServerHarness();
		await malformed.server.receive(JSON.stringify(handshake()));
		for (const id of ["bad-1", "bad-2", "bad-3"]) {
			await malformed.server.receive(
				JSON.stringify({
					type: "request",
					id,
					method: "workspace.stat",
					timeoutMs: 100,
					params: { path: "a" },
					extra: true,
				}),
			);
		}
		expect(malformed.messages.filter((message) => message.type === "error")).toHaveLength(3);
		expect(malformed.closes.at(-1)).toMatchObject({ code: "policy_violation" });

		const missingId = createServerHarness();
		await missingId.server.receive(JSON.stringify({ type: "handshake", versions: [] }));
		expect(missingId.closes).toEqual([expect.objectContaining({ code: "invalid_payload" })]);
	});

	it("validates catalog generation, schema hash, and canonical arguments before dispatch", async () => {
		const handleRequest = vi.fn(defaultHandler().handleRequest);
		const pair = createProtocolPair(defaultHandler({ handleRequest }));
		const ack = await pair.client.start();
		const read = ack.catalog.tools[0]!;
		const base = {
			generation: ack.catalog.generation,
			catalogHash: ack.catalogHash,
			toolName: read.name,
			schemaHash: read.schemaHash,
			argumentsPrepared: true as const,
			arguments: { path: "a" },
			executionOptions: {},
		};
		await expectRequestError(
			pair.client.request("tool.invoke", { ...base, generation: 999 }),
			"stale_generation",
			"not_started",
		);
		expect(() => pair.client.request("tool.invoke", { ...base, schemaHash: "0".repeat(64) })).toThrow(
			/local canonical definition/,
		);
		await expectRequestError(
			pair.client.request("tool.invoke", { ...base, arguments: { wrong: true } }),
			"invalid_request",
			"not_started",
		);
		expect(handleRequest).not.toHaveBeenCalled();
	});

	it("correlates streamed uploads and downloads with strict sequence numbers", async () => {
		const uploaded: Buffer[] = [];
		let finishUpload: ((value: unknown) => void) | undefined;
		const handler = defaultHandler({
			handleRequest: async (request, context) => {
				if (request.method === "transfer.upload") {
					return new Promise((resolve) => {
						finishUpload = resolve;
					});
				}
				if (request.method === "transfer.download") {
					const content = Buffer.from("download");
					const sha256 = createHash("sha256").update(content).digest("hex");
					await context.startTransfer(content.length, sha256);
					await context.sendTransferChunk(content.subarray(0, 4));
					await context.sendTransferChunk(content.subarray(4));
					return { length: content.length, sha256 };
				}
				return statResult();
			},
			handleUploadChunk: async (_request, chunk) => {
				uploaded.push(chunk);
			},
			handleUploadFinish: async (_request, metadata, context) => {
				context.markCommitted();
				finishUpload?.(metadata);
			},
		});
		const pair = createProtocolPair(handler);
		await pair.client.start();
		const uploadSha256 = createHash("sha256").update("abcdef").digest("hex");
		const upload = pair.client.beginRequest("transfer.upload", {
			path: "file",
			length: 6,
			sha256: uploadSha256,
			overwrite: false,
		});
		await upload.sendTransferChunk(Buffer.from("abc"));
		await upload.sendTransferChunk(Buffer.from("def"));
		await upload.finishTransfer(6, uploadSha256);
		expect(await upload.result).toEqual({ length: 6, sha256: uploadSha256 });
		expect(Buffer.concat(uploaded).toString()).toBe("abcdef");

		const downloaded: Buffer[] = [];
		const starts: unknown[] = [];
		const result = await pair.client.request(
			"transfer.download",
			{ path: "file" },
			{
				onTransferStart: (metadata) => {
					starts.push(metadata);
				},
				onTransferChunk: (chunk) => {
					downloaded.push(chunk);
				},
			},
		);
		expect(starts).toHaveLength(1);
		expect(Buffer.concat(downloaded).toString()).toBe("download");
		expect(result).toMatchObject({ length: 8 });
	});

	it("rejects transfer metadata mismatches and out-of-order chunks", async () => {
		const uploadPair = createProtocolPair(
			defaultHandler({
				handleRequest: async (request) =>
					request.method === "transfer.upload" ? new Promise(() => undefined) : statResult(),
			}),
		);
		await uploadPair.client.start();
		const expectedSha = createHash("sha256").update("abc").digest("hex");
		const upload = uploadPair.client.beginRequest("transfer.upload", {
			path: "file",
			length: 3,
			sha256: expectedSha,
			overwrite: false,
		});
		await upload.sendTransferChunk(Buffer.from("abc"));
		const uploadResult = expect(upload.result).rejects.toEqual(
			expect.objectContaining({ executionState: "indeterminate" }),
		);
		await expect(upload.finishTransfer(3, "0".repeat(64))).rejects.toThrow(/SHA-256/);
		await uploadResult;

		const raw = createServerHarness(
			defaultHandler({
				handleRequest: async (_request, context) => {
					await new Promise<void>((resolve) => {
						if (context.signal.aborted) resolve();
						else context.signal.addEventListener("abort", () => resolve(), { once: true });
					});
					return {};
				},
			}),
		);
		await raw.server.receive(JSON.stringify(handshake()));
		await raw.server.receive(
			JSON.stringify({
				type: "request",
				id: "upload-sequence",
				method: "transfer.upload",
				timeoutMs: 1000,
				params: {
					path: "file",
					length: 1,
					sha256: createHash("sha256").update("a").digest("hex"),
					overwrite: false,
				},
			}),
		);
		await raw.server.receive(
			JSON.stringify({ type: "transfer_chunk", id: "upload-sequence", sequence: 1, dataBase64: "YQ==" }),
		);
		expect(raw.closes.at(-1)?.message).toContain("Out-of-order upload chunk");

		const downloadPair = createProtocolPair(
			defaultHandler({
				handleRequest: async (request, context) => {
					if (request.method !== "transfer.download") return statResult();
					await context.startTransfer(1, "0".repeat(64));
					await context.sendTransferChunk(Buffer.from("a"));
					return { length: 1, sha256: "0".repeat(64) };
				},
			}),
		);
		await downloadPair.client.start();
		await expectRequestError(
			downloadPair.client.request("transfer.download", { path: "file" }),
			"internal_error",
			"not_started",
		);
	});

	it("processes cancellation while an upload callback is blocked", async () => {
		const pair = createProtocolPair(
			defaultHandler({
				handleRequest: async (request, context) => {
					if (request.method !== "transfer.upload") return statResult();
					await new Promise<void>((resolve) => {
						if (context.signal.aborted) resolve();
						else context.signal.addEventListener("abort", () => resolve(), { once: true });
					});
					return { length: 1, sha256: createHash("sha256").update("a").digest("hex") };
				},
				handleUploadChunk: async () => new Promise(() => undefined),
			}),
		);
		await pair.client.start();
		const controller = new AbortController();
		const sha256 = createHash("sha256").update("a").digest("hex");
		const upload = pair.client.beginRequest(
			"transfer.upload",
			{ path: "file", length: 1, sha256, overwrite: false },
			{ signal: controller.signal },
		);
		await upload.sendTransferChunk(Buffer.from("a"));
		controller.abort();
		await expect(upload.result).rejects.toEqual(expect.objectContaining({ executionState: "indeterminate" }));
		expect(pair.serverCloses.at(-1)).toMatchObject({ code: "policy_violation" });
	});

	it("cancels, times out, tombstones late messages, and classifies disconnects", async () => {
		let processContext: RemoteWorkspaceServerRequestContext | undefined;
		const pair = createProtocolPair(
			defaultHandler({
				handleRequest: async (request, context) => {
					if (request.method === "workspace.exec") {
						processContext = context;
						context.markSideEffectStarted();
						return new Promise(() => undefined);
					}
					return new Promise(() => undefined);
				},
			}),
		);
		await pair.client.start();
		const controller = new AbortController();
		const process = pair.client.request(
			"workspace.exec",
			{ command: "sleep", cwd: "/workspace" },
			{ signal: controller.signal, timeoutMs: 1000 },
		);
		controller.abort();
		await expect(process).rejects.toEqual(expect.objectContaining({ executionState: "indeterminate" }));
		expect(processContext?.signal.aborted).toBe(true);
		expect(pair.serverCloses.at(-1)).toMatchObject({ code: "policy_violation" });

		const disconnectPair = createProtocolPair(
			defaultHandler({ handleRequest: async () => new Promise(() => undefined) }),
		);
		await disconnectPair.client.start();
		const read = disconnectPair.client.request("workspace.read", { path: "a" }, { timeoutMs: 1000 });
		const write = disconnectPair.client.request(
			"workspace.write",
			{ path: "a", contentBase64: "YQ==" },
			{ timeoutMs: 1000 },
		);
		await disconnectPair.client.disconnect("fixture disconnect");
		await expect(read).rejects.toEqual(expect.objectContaining({ executionState: "not_started" }));
		await expect(write).rejects.toEqual(expect.objectContaining({ executionState: "indeterminate" }));
	});

	it("uses handler termination to report authoritative cancellation state", async () => {
		const createCancellablePair = (committed: boolean) =>
			createProtocolPair(
				defaultHandler({
					handleRequest: async (_request, context) => {
						if (committed) context.markCommitted();
						await new Promise<void>((resolve) => {
							if (context.signal.aborted) resolve();
							else context.signal.addEventListener("abort", () => resolve(), { once: true });
						});
						return {};
					},
				}),
			);

		const beforeCommit = createCancellablePair(false);
		await beforeCommit.client.start();
		const beforeController = new AbortController();
		const before = beforeCommit.client.request(
			"workspace.write",
			{ path: "a", contentBase64: "YQ==" },
			{ signal: beforeController.signal },
		);
		beforeController.abort();
		await expectRequestError(before, "cancelled", "not_started");
		const tombstoned = beforeCommit.clientMessages.find((message) => message.type === "cancel");
		if (!tombstoned) throw new Error("Missing cancellation message");
		await beforeCommit.client.receive(
			JSON.stringify({
				type: "error",
				id: tombstoned.id,
				error: { code: "cancelled", message: "late", executionState: "not_started", retryable: false },
			}),
		);
		expect(beforeCommit.clientCloses).toHaveLength(0);

		const afterCommit = createCancellablePair(true);
		await afterCommit.client.start();
		const afterController = new AbortController();
		const after = afterCommit.client.request(
			"workspace.write",
			{ path: "a", contentBase64: "YQ==" },
			{ signal: afterController.signal },
		);
		afterController.abort();
		await expectRequestError(after, "cancelled", "completed");
	});

	it("closes instead of fabricating a terminal state for an uncooperative deadline", async () => {
		const pair = createProtocolPair(
			defaultHandler({
				handleRequest: async (_request, context) => {
					context.markCommitted();
					return new Promise(() => undefined);
				},
			}),
		);
		await pair.client.start();
		const request = pair.client.request("workspace.write", { path: "a", contentBase64: "YQ==" }, { timeoutMs: 20 });
		await expect(request).rejects.toEqual(expect.objectContaining({ executionState: "indeterminate" }));
		expect(pair.serverCloses.at(-1)).toMatchObject({ code: "policy_violation" });
	});

	it("publishes immutable catalog generations and rejects stale calls without dispatch", async () => {
		const generations: number[] = [];
		const handleRequest = vi.fn(defaultHandler().handleRequest);
		const pair = createProtocolPair(defaultHandler({ handleRequest }), {
			onCatalogChanged: (generation) => generations.push(generation),
		});
		const ack = await pair.client.start();
		await pair.server.publishCatalog(validCatalog(2));
		expect(generations).toEqual([2]);
		const read = ack.catalog.tools[0]!;
		await expectRequestError(
			pair.client.request("tool.invoke", {
				generation: ack.catalog.generation,
				catalogHash: ack.catalogHash,
				toolName: read.name,
				schemaHash: read.schemaHash,
				argumentsPrepared: true,
				arguments: { path: "a" },
				executionOptions: {},
			}),
			"stale_generation",
			"not_started",
		);
		expect(handleRequest).not.toHaveBeenCalled();
	});

	it("keeps catalog refresh pending until the local proxy swap completes", async () => {
		let releaseRefresh: () => void = () => undefined;
		const refreshGate = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		let refreshStarted: () => void = () => undefined;
		const started = new Promise<void>((resolve) => {
			refreshStarted = resolve;
		});
		const pair = createProtocolPair(defaultHandler(), {
			onCatalogRefreshed: async () => {
				refreshStarted();
				await refreshGate;
			},
		});
		await pair.client.start();
		const publishing = pair.server.publishCatalog(validCatalog(2));
		await started;
		let swapCompleted = false;
		const waiting = pair.client.waitForCatalogRefresh().then(() => {
			swapCompleted = true;
		});
		await Promise.resolve();
		expect(swapCompleted).toBe(false);
		releaseRefresh();
		await Promise.all([publishing, waiting]);
		expect(pair.client.handshake?.catalog.generation).toBe(2);
	});

	it("retires process-backed calls before publishing a replacement catalog", async () => {
		let markStarted: () => void = () => undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const pair = createProtocolPair(
			defaultHandler({
				handleRequest: async (request, context) => {
					if (request.method === "workspace.exec") {
						context.markSideEffectStarted();
						markStarted();
						return new Promise((resolve) => {
							if (context.signal.aborted) resolve({ exitCode: null });
							else context.signal.addEventListener("abort", () => resolve({ exitCode: null }), { once: true });
						});
					}
					return statResult();
				},
			}),
		);
		await pair.client.start();
		const running = pair.client.request("workspace.exec", { command: "sleep", cwd: "/workspace" });
		await started;
		await pair.server.publishCatalog(validCatalog(2));
		await expectRequestError(running, "generation_retired", "indeterminate");
	});

	it("bounds queued upload chunks and inbound payload bursts before dispatch", async () => {
		const limits = {
			...DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
			maxTransferChunkBytes: 1024,
			maxPendingTransferBytes: 1024,
			maxPendingInboundMessages: 1,
		};
		const pair = createProtocolPair(
			defaultHandler({
				handleRequest: async (request, context) => {
					if (request.method !== "transfer.upload") return statResult();
					await new Promise<void>((resolve) => {
						if (context.signal.aborted) resolve();
						else context.signal.addEventListener("abort", () => resolve(), { once: true });
					});
					return { length: 2048, sha256: createHash("sha256").update(Buffer.alloc(2048, 97)).digest("hex") };
				},
				handleUploadChunk: async () => new Promise(() => undefined),
			}),
			{ limits },
		);
		await pair.client.start();
		const controller = new AbortController();
		const upload = pair.client.beginRequest(
			"transfer.upload",
			{
				path: "file",
				length: 2048,
				sha256: createHash("sha256").update(Buffer.alloc(2048, 97)).digest("hex"),
				overwrite: false,
			},
			{ signal: controller.signal },
		);
		const firstChunk = upload.sendTransferChunk(Buffer.alloc(1024, 97));
		expect(() => upload.sendTransferChunk(Buffer.alloc(1024, 97))).toThrow(/pending upload/);
		await firstChunk;
		controller.abort();
		await expect(upload.result).rejects.toEqual(expect.objectContaining({ executionState: "indeterminate" }));

		const ingress = createServerHarness(defaultHandler(), { limits });
		const first = ingress.server.receive(JSON.stringify(handshake("queued-first")));
		const second = ingress.server.receive(JSON.stringify(handshake("queued-second")));
		await Promise.allSettled([first, second]);
		expect(ingress.closes.at(-1)).toMatchObject({ code: "message_too_large" });
	});

	it("bounds outbound streams and client inbound queues", async () => {
		const outboundLimits = {
			...DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
			maxMessageBytes: 3000,
			maxTransferChunkBytes: 1024,
			maxPendingOutboundBytes: 4096,
			maxPendingOutboundMessages: 1,
		};
		const outbound = createProtocolPair(
			defaultHandler({
				handleRequest: async (request, context) => {
					if (request.method !== "tool.invoke") return statResult();
					await Promise.all([
						context.sendUpdate({ text: "a".repeat(500) }),
						context.sendUpdate({ text: "b".repeat(500) }),
					]);
					return { content: [] };
				},
			}),
			{ limits: outboundLimits },
		);
		const ack = await outbound.client.start();
		const read = ack.catalog.tools[0]!;
		await expectRequestError(
			outbound.client.request("tool.invoke", {
				generation: ack.catalog.generation,
				catalogHash: ack.catalogHash,
				toolName: read.name,
				schemaHash: read.schemaHash,
				argumentsPrepared: true,
				arguments: { path: "a" },
				executionOptions: {},
			}),
			"limit_exceeded",
			"not_started",
		);

		const inboundLimits = {
			...DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
			maxMessageBytes: 8192,
			maxTransferChunkBytes: 4096,
			maxPendingInboundBytes: 8192,
		};
		const inbound = createProtocolPair(
			defaultHandler({
				handleRequest: async (_request, context) => {
					await new Promise<void>((resolve) => {
						if (context.signal.aborted) resolve();
						else context.signal.addEventListener("abort", () => resolve(), { once: true });
					});
					return statResult();
				},
			}),
			{ limits: inboundLimits },
		);
		await inbound.client.start();
		const pending = inbound.client.request("workspace.stat", { path: "a" });
		await waitForCondition(() => inbound.clientMessages.some((message) => message.type === "request"));
		const request = inbound.clientMessages.find((message) => message.type === "request");
		if (request?.type !== "request") throw new Error("Missing request");
		const first = inbound.client.receive(
			JSON.stringify({ type: "update", id: request.id, sequence: 0, update: { text: "a".repeat(5000) } }),
		);
		const second = inbound.client.receive(
			JSON.stringify({ type: "update", id: request.id, sequence: 1, update: { text: "b".repeat(5000) } }),
		);
		await Promise.allSettled([first, second]);
		await expect(pending).rejects.toBeInstanceOf(RemoteWorkspaceDisconnectedError);
		expect(inbound.clientCloses.at(-1)).toMatchObject({ code: "message_too_large" });
	});

	it("reports uncooperative server disconnect termination", async () => {
		const harness = createServerHarness(defaultHandler({ handleRequest: async () => new Promise(() => undefined) }));
		await harness.server.receive(JSON.stringify(handshake()));
		await harness.server.receive(
			JSON.stringify({
				type: "request",
				id: "never-stops",
				method: "workspace.stat",
				timeoutMs: 1000,
				params: { path: "a" },
			}),
		);
		await expect(harness.server.disconnect()).rejects.toBeInstanceOf(RemoteWorkspaceTerminationError);
	});

	it("bounds and closes a stalled terminal-result transport", async () => {
		let blockSends = false;
		let markSendStarted: () => void = () => undefined;
		const sendStarted = new Promise<void>((resolve) => {
			markSendStarted = resolve;
		});
		const closes: RemoteWorkspaceProtocolCloseReason[] = [];
		const server = new RemoteWorkspaceServerProtocol(
			{
				send: async () => {
					if (!blockSends) return;
					markSendStarted();
					return new Promise(() => undefined);
				},
				close: (reason) => {
					closes.push(reason);
				},
			},
			defaultHandler(),
			{
				workspace,
				catalog: validCatalog(),
				capabilities: ["primitive_operations", "tool_updates", "file_transfer", "catalog_refresh"],
				limits: { ...DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS, maxTransportSendMs: 20 },
			},
		);
		await server.receive(JSON.stringify(handshake()));
		blockSends = true;
		await server.receive(
			JSON.stringify({
				type: "request",
				id: "blocked-result",
				method: "workspace.stat",
				timeoutMs: 1000,
				params: { path: "a" },
			}),
		);
		await sendStarted;
		await server.disconnect().catch(() => undefined);
		expect(closes.at(-1)).toMatchObject({ code: "protocol_error" });
	});

	it("bounds active requests and classifies request send failures conservatively", async () => {
		const limits = { ...DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS, maxActiveRequests: 1 };
		const bounded = createServerHarness(defaultHandler({ handleRequest: async () => new Promise(() => undefined) }), {
			limits,
		});
		await bounded.server.receive(JSON.stringify(handshake()));
		await bounded.server.receive(
			JSON.stringify({
				type: "request",
				id: "first-active",
				method: "workspace.stat",
				timeoutMs: 1000,
				params: { path: "a" },
			}),
		);
		await bounded.server.receive(
			JSON.stringify({
				type: "request",
				id: "over-limit",
				method: "workspace.stat",
				timeoutMs: 1000,
				params: { path: "b" },
			}),
		);
		expect(bounded.messages.at(-1)).toMatchObject({ type: "error", error: { code: "limit_exceeded" } });

		const catalog = validCatalog();
		const sent: RemoteWorkspaceClientMessage[] = [];
		const closes: RemoteWorkspaceProtocolCloseReason[] = [];
		let failSend = false;
		const client = new RemoteWorkspaceClientProtocol(
			{
				send: async (message) => {
					if (failSend) throw new Error("fixture send failure");
					sent.push(message);
				},
				close: (reason) => {
					closes.push(reason);
				},
			},
			{
				optionalCapabilities: ["primitive_operations"],
				localToolSchemas: new Map(catalog.tools.map((tool) => [tool.name, tool.schemaHash])),
			},
		);
		const starting = client.start();
		await waitForCondition(() => sent.length > 0);
		const offer = sent[0];
		if (offer?.type !== "handshake") throw new Error("Missing handshake");
		await client.receive(
			JSON.stringify({
				type: "handshake_ack",
				id: offer.id,
				version: { major: 1, minor: 0 },
				capabilities: ["primitive_operations"],
				workspace,
				limits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
				catalog,
				catalogHash: hashRemoteWorkspaceCatalog(catalog),
				backendMetadata: { kind: "remote-workspace" },
			}),
		);
		await starting;
		failSend = true;
		const failed = client.request("workspace.write", { path: "a", contentBase64: "YQ==" });
		await expect(failed).rejects.toEqual(expect.objectContaining({ executionState: "indeterminate" }));
		expect(closes.at(-1)?.message).toContain("fixture send failure");
	});

	it("bounds handler-provided error details with a terminal fallback", async () => {
		const pair = createProtocolPair(
			defaultHandler({
				handleRequest: async () => {
					throw new RemoteWorkspaceRequestError({
						code: "internal_error",
						message: "fixture",
						executionState: "not_started",
						retryable: false,
						details: { oversized: "x".repeat(DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS.maxMessageBytes) },
					});
				},
			}),
		);
		await pair.client.start();
		await expectRequestError(pair.client.request("workspace.stat", { path: "a" }), "internal_error", "not_started");
		expect(
			pair.serverMessages.some(
				(message) => message.type === "error" && message.error.message.includes("exceeded protocol limits"),
			),
		).toBe(true);

		const committed = createProtocolPair(
			defaultHandler({
				handleRequest: async (_request, context) => {
					context.markCommitted();
					throw new RemoteWorkspaceRequestError({
						code: "internal_error",
						message: "reported too weakly",
						executionState: "not_started",
						retryable: false,
					});
				},
			}),
		);
		await committed.client.start();
		await expectRequestError(
			committed.client.request("workspace.write", { path: "a", contentBase64: "YQ==" }),
			"internal_error",
			"completed",
		);
	});

	it("closes on unknown responses and out-of-order updates without settling another request", async () => {
		const sent: RemoteWorkspaceClientMessage[] = [];
		const closes: RemoteWorkspaceProtocolCloseReason[] = [];
		const catalog = validCatalog();
		const client = new RemoteWorkspaceClientProtocol(
			{
				send: async (message) => {
					sent.push(message);
				},
				close: (reason) => {
					closes.push(reason);
				},
			},
			{
				optionalCapabilities: ["primitive_operations", "tool_updates"],
				localToolSchemas: new Map(catalog.tools.map((tool) => [tool.name, tool.schemaHash])),
			},
		);
		const starting = client.start();
		await waitForCondition(() => sent.length > 0);
		const offer = sent[0];
		if (offer?.type !== "handshake") throw new Error("Missing handshake offer");
		await client.receive(
			JSON.stringify({
				type: "handshake_ack",
				id: offer.id,
				version: { major: 1, minor: 0 },
				capabilities: ["primitive_operations", "tool_updates"],
				workspace,
				limits: DEFAULT_REMOTE_WORKSPACE_PROTOCOL_LIMITS,
				catalog,
				catalogHash: hashRemoteWorkspaceCatalog(catalog),
				backendMetadata: { kind: "remote-workspace" },
			}),
		);
		await starting;
		const request = client.request("workspace.stat", { path: "a" }, { onUpdate: () => undefined });
		await waitForCondition(() => sent.some((message) => message.type === "request"));
		const requestMessage = sent.find((message) => message.type === "request");
		if (requestMessage?.type !== "request") throw new Error("Missing request");
		await client.receive(JSON.stringify({ type: "update", id: requestMessage.id, sequence: 1, update: {} }));
		await expect(request).rejects.toBeInstanceOf(RemoteWorkspaceDisconnectedError);
		expect(closes.at(-1)?.code).toBe("protocol_error");

		const other = new RemoteWorkspaceClientProtocol({
			send: async () => undefined,
			close: (reason) => {
				closes.push(reason);
			},
		});
		await other.receive(JSON.stringify({ type: "result", id: "never-seen", result: {} }));
		expect(closes.at(-1)?.message).toContain("unknown request ID");
	});
});
