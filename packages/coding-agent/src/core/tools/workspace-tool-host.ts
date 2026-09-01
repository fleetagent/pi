import { isAbsolute } from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@fleetagent/pi-agent-core";
import { validateToolArguments } from "@fleetagent/pi-ai";
import type { Static, TSchema } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { type BashToolDefinition, type BashToolOptions, createBashToolDefinition } from "./bash.ts";
import { createEditToolDefinition, type EditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindToolDefinition, type FindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepToolDefinition, type GrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsToolDefinition, type LsToolDefinition, type LsToolOptions } from "./ls.ts";
import { LocalToolOperations, type ToolOperations, type WorkspaceToolExecutionOptions } from "./operations.ts";
import { resolveToCwd } from "./path-utils.ts";
import {
	createReadToolDefinition,
	type ReadToolDefinition,
	type ReadToolOperations,
	type ReadToolOptions,
} from "./read.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { createWriteToolDefinition, type WriteToolDefinition, type WriteToolOptions } from "./write.ts";

export const WORKSPACE_TOOL_NAMES = Object.freeze(["read", "bash", "edit", "write", "grep", "find", "ls"] as const);
const WORKSPACE_TOOL_NAME_SET = new Set<string>(WORKSPACE_TOOL_NAMES);
export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];
export type WorkspaceToolDefinition =
	| ReadToolDefinition
	| BashToolDefinition
	| EditToolDefinition
	| WriteToolDefinition
	| GrepToolDefinition
	| FindToolDefinition
	| LsToolDefinition;

// Heterogeneous tool registries erase per-tool schema/detail types at the lookup boundary.
type AnyAgentTool = AgentTool<any, any>;
type AnyToolDefinition = ToolDefinition<any, any, any>;

export interface WorkspaceToolOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
}

export interface WorkspaceToolHostOptions {
	cwd: string;
	operations?: ToolOperations;
	tools?: WorkspaceToolOptions;
	/** Closed tool allowlist. Defaults to all canonical workspace tools. */
	toolNames?: readonly WorkspaceToolName[];
	shellPath?: string;
	/** Dispose a caller-provided operations backend with the host. Defaults to false. */
	ownsOperations?: boolean;
	/** Maximum time to await cancellation before continuing disposal. Defaults to 5 seconds. */
	disposeTimeoutMs?: number;
	/** Called after a negotiated remote catalog refresh has completed. */
	onCatalogChanged?: () => void | Promise<void>;
	/** Additional canonical service definitions, such as daemon-owned LSP tools. */
	additionalDefinitions?: readonly AnyToolDefinition[];
}

export interface WorkspaceToolCatalogEntry {
	name: string;
	label: string;
	description: string;
	parameters: TSchema;
	executionMode: AnyToolDefinition["executionMode"];
}

export interface WorkspaceToolInvocation {
	toolCallId: string;
	arguments: unknown;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<unknown>;
	executionOptions?: WorkspaceToolExecutionOptions;
}

interface WorkspaceExecutionSelection {
	executeRemotely: boolean;
	readOperations: ReadToolOperations | undefined;
}

interface HostedToolExecution<TParams extends TSchema, TDetails> {
	name: string;
	toolCallId: string;
	params: Static<TParams>;
	signal: AbortSignal;
	onUpdate: AgentToolUpdateCallback<TDetails> | undefined;
	context: ExtensionContext;
	executionOptions: WorkspaceToolExecutionOptions | undefined;
}

function cloneObjectGraph<T>(value: T, seen = new Map<object, object>()): T {
	if (typeof value !== "object" || value === null) return value;
	const existing = seen.get(value);
	if (existing) return existing as T;
	const clone: object = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
	seen.set(value, clone);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor) continue;
		if ("value" in descriptor) descriptor.value = cloneObjectGraph(descriptor.value, seen);
		Object.defineProperty(clone, key, descriptor);
	}
	return clone as T;
}

function freezeObjectGraph(value: unknown, seen = new Set<object>()): void {
	if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value)) return;
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && "value" in descriptor) freezeObjectGraph(descriptor.value, seen);
	}
	Object.freeze(value);
}

function validateDisposeTimeout(value: number | undefined): number {
	const resolved = value ?? 5000;
	if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 60_000) {
		throw new Error("disposeTimeoutMs must be an integer from 1 through 60000");
	}
	return resolved;
}

function createRemoteExecutionOptions(toolOptions: WorkspaceToolOptions | undefined): WorkspaceToolExecutionOptions {
	return Object.freeze({
		...(toolOptions?.read?.autoResizeImages === undefined
			? {}
			: { imageAutoResize: toolOptions.read.autoResizeImages }),
		...(toolOptions?.bash?.commandPrefix === undefined ? {} : { shellCommandPrefix: toolOptions.bash.commandPrefix }),
	});
}

/**
 * Canonical workspace-scoped tool construction and execution without an AgentSession.
 *
 * This host deliberately excludes subagents, session lifecycle tools, extensions, LSP,
 * models, prompts, conversation state, persistence, and UI. Caller-provided operations
 * are borrowed unless ownsOperations is explicitly enabled.
 */
export class WorkspaceToolHost {
	readonly operations: ToolOperations;

	private readonly definitions = new Map<string, AnyToolDefinition>();
	private readonly rawDefinitions = new Map<string, AnyToolDefinition>();
	private readonly remoteToolNames = new Set<string>();
	private readonly tools = new Map<string, AnyAgentTool>();
	private readonly ownsOperations: boolean;
	private readonly toolOptions: WorkspaceToolOptions | undefined;
	private readonly remoteExecutionOptions: WorkspaceToolExecutionOptions;
	private unsubscribeCatalog: (() => void) | undefined;
	private readonly disposeTimeoutMs: number;
	private readonly disposeController = new AbortController();
	private readonly activeInvocations = new Set<Promise<unknown>>();
	private disposePromise: Promise<void> | undefined;
	private disposed = false;

	constructor(options: WorkspaceToolHostOptions) {
		if (options.operations && options.cwd !== options.operations.cwd) {
			throw new Error(`Workspace host cwd ${options.cwd} does not match operations cwd ${options.operations.cwd}`);
		}
		this.operations = options.operations ?? new LocalToolOperations(options.cwd, { shellPath: options.shellPath });
		this.ownsOperations = options.operations ? options.ownsOperations === true : true;
		this.toolOptions = options.tools;
		this.remoteExecutionOptions = createRemoteExecutionOptions(options.tools);
		this.disposeTimeoutMs = validateDisposeTimeout(options.disposeTimeoutMs);
		const enabledNames = new Set(options.toolNames ?? WORKSPACE_TOOL_NAMES);
		for (const name of enabledNames) {
			if (!WORKSPACE_TOOL_NAME_SET.has(name)) throw new Error(`Unknown workspace tool: ${name}`);
		}
		this.registerConfiguredTools(enabledNames);
		this.registerAdditionalDefinitions(options.additionalDefinitions ?? []);
		this.unsubscribeCatalog = options.onCatalogChanged
			? this.operations.onWorkspaceToolCatalogChanged?.(options.onCatalogChanged)
			: undefined;
	}

	getDefinitions(): ReadonlyMap<string, AnyToolDefinition> {
		return new Map(this.definitions);
	}

	getDefinition(name: string): AnyToolDefinition | undefined {
		return this.definitions.get(name);
	}

	getCatalog(): WorkspaceToolCatalogEntry[] {
		return [...this.definitions.entries()].map(([name, definition]) => ({
			name,
			label: definition.label,
			description: definition.description,
			parameters: structuredClone(definition.parameters),
			executionMode: definition.executionMode,
		}));
	}

	prepareArguments(name: string, rawArguments: unknown): unknown {
		if (this.disposed) throw new Error("Workspace tool host is disposed");
		const tool = this.requireTool(name);
		return tool.prepareArguments ? tool.prepareArguments(rawArguments) : rawArguments;
	}

	async execute(name: string, invocation: WorkspaceToolInvocation): Promise<AgentToolResult<unknown>> {
		const preparedArguments = this.prepareArguments(name, invocation.arguments);
		return await this.executePrepared(name, { ...invocation, arguments: preparedArguments });
	}

	validatePreparedArguments(name: string, argumentsValue: unknown): boolean {
		const tool = this.tools.get(name);
		if (!tool || this.disposed) return false;
		try {
			validateToolArguments(tool, {
				type: "toolCall",
				id: "validate",
				name: tool.name,
				arguments: argumentsValue as Record<string, unknown>,
			});
			return true;
		} catch {
			return false;
		}
	}

	async executePrepared(name: string, invocation: WorkspaceToolInvocation): Promise<AgentToolResult<unknown>> {
		if (this.disposed) throw new Error("Workspace tool host is disposed");
		const tool = this.requireTool(name);
		const params = validateToolArguments(tool, {
			type: "toolCall",
			id: invocation.toolCallId,
			name: tool.name,
			arguments: invocation.arguments as Record<string, unknown>,
		});
		return await this.runDefinition(
			name,
			invocation.toolCallId,
			params,
			invocation.signal,
			invocation.onUpdate,
			undefined as unknown as ExtensionContext,
			invocation.executionOptions,
		);
	}

	detachCatalogListener(): void {
		this.unsubscribeCatalog?.();
		this.unsubscribeCatalog = undefined;
	}

	waitForIdle(timeoutMs = this.disposeTimeoutMs): Promise<boolean> {
		if (this.activeInvocations.size === 0) return Promise.resolve(true);
		return new Promise((resolve) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(value);
			};
			const timer = setTimeout(() => finish(false), timeoutMs);
			timer.unref?.();
			void Promise.allSettled([...this.activeInvocations]).then(() => finish(true));
		});
	}

	dispose(): Promise<void> {
		this.disposed = true;
		this.disposePromise ??= this.disposeHost();
		return this.disposePromise;
	}

	private registerConfiguredTools(enabledNames: ReadonlySet<WorkspaceToolName>): void {
		const toolOptions = this.toolOptions;
		if (enabledNames.has("read")) this.register("read", createReadToolDefinition(this.operations, toolOptions?.read));
		if (enabledNames.has("bash")) this.register("bash", createBashToolDefinition(this.operations, toolOptions?.bash));
		if (enabledNames.has("edit")) this.register("edit", createEditToolDefinition(this.operations, toolOptions?.edit));
		if (enabledNames.has("write"))
			this.register("write", createWriteToolDefinition(this.operations, toolOptions?.write));
		if (enabledNames.has("grep")) this.register("grep", createGrepToolDefinition(this.operations, toolOptions?.grep));
		if (enabledNames.has("find")) this.register("find", createFindToolDefinition(this.operations, toolOptions?.find));
		if (enabledNames.has("ls")) this.register("ls", createLsToolDefinition(this.operations, toolOptions?.ls));
	}
	private selectWorkspaceExecution(name: string, params: unknown): WorkspaceExecutionSelection {
		const executeRemotely = this.remoteToolNames.has(name);
		const operationsForPath = this.toolOptions?.read?.operationsForPath;
		if (!executeRemotely || name !== "read" || !operationsForPath) {
			return { executeRemotely, readOperations: undefined };
		}
		const readPath = (params as { path?: unknown }).path;
		if (typeof readPath !== "string" || !isAbsolute(readPath)) {
			return { executeRemotely, readOperations: undefined };
		}
		const absolutePath = resolveToCwd(readPath, this.operations.cwd);
		const readOperations = operationsForPath(absolutePath);
		return { executeRemotely: !readOperations, readOperations };
	}

	private resolveLocalDefinition<TParams extends TSchema, TDetails>(
		request: HostedToolExecution<TParams, TDetails>,
		definition: ToolDefinition<TParams, TDetails>,
		readOperations: ReadToolOperations | undefined,
	): ToolDefinition<TParams, TDetails> {
		if (request.name === "read" && (readOperations || request.executionOptions?.imageAutoResize !== undefined)) {
			return createReadToolDefinition(this.operations, {
				...this.toolOptions?.read,
				...(request.executionOptions?.imageAutoResize === undefined
					? {}
					: { autoResizeImages: request.executionOptions.imageAutoResize }),
				...(readOperations ? { operationsForPath: () => readOperations } : {}),
			}) as unknown as ToolDefinition<TParams, TDetails>;
		}
		if (request.executionOptions?.shellCommandPrefix !== undefined && request.name === "bash") {
			return createBashToolDefinition(this.operations, {
				...this.toolOptions?.bash,
				commandPrefix: request.executionOptions.shellCommandPrefix,
			}) as unknown as ToolDefinition<TParams, TDetails>;
		}
		return definition;
	}

	private startRemoteExecution<TParams extends TSchema, TDetails>(
		request: HostedToolExecution<TParams, TDetails>,
	): Promise<AgentToolResult<TDetails>> {
		if (!this.operations.executeWorkspaceTool) {
			throw new Error(`Remote workspace executor is unavailable: ${request.name}`);
		}
		return Promise.resolve().then(
			async () =>
				(await this.operations.executeWorkspaceTool!(request.name, {
					toolCallId: request.toolCallId,
					arguments: request.params,
					signal: request.signal,
					onUpdate: request.onUpdate as AgentToolUpdateCallback<unknown> | undefined,
					executionOptions: request.executionOptions ?? this.remoteExecutionOptions,
				})) as AgentToolResult<TDetails>,
		);
	}

	private startLocalExecution<TParams extends TSchema, TDetails>(
		request: HostedToolExecution<TParams, TDetails>,
		definition: ToolDefinition<TParams, TDetails>,
	): Promise<AgentToolResult<TDetails>> {
		return Promise.resolve().then(() =>
			definition.execute(request.toolCallId, request.params, request.signal, request.onUpdate, request.context),
		);
	}

	private trackExecution<TDetails>(execution: Promise<AgentToolResult<TDetails>>): Promise<AgentToolResult<TDetails>> {
		this.activeInvocations.add(execution);
		void execution.then(
			() => this.activeInvocations.delete(execution),
			() => this.activeInvocations.delete(execution),
		);
		return execution;
	}

	private registerAdditionalDefinitions(definitions: readonly AnyToolDefinition[]): void {
		for (const definition of definitions) {
			if (this.definitions.has(definition.name)) throw new Error(`Duplicate hosted tool: ${definition.name}`);
			this.register(definition.name, definition);
		}
	}

	private register<TParams extends TSchema, TDetails, TState>(
		name: string,
		definition: ToolDefinition<TParams, TDetails, TState>,
	): void {
		const canonicalDefinition: ToolDefinition<TParams, TDetails, TState> = {
			...definition,
			parameters: cloneObjectGraph(definition.parameters),
		};
		freezeObjectGraph(canonicalDefinition);
		const execute: ToolDefinition<TParams, TDetails, TState>["execute"] = (
			toolCallId,
			params,
			signal,
			onUpdate,
			context,
		) => this.runDefinition<TParams, TDetails>(name, toolCallId, params, signal, onUpdate, context, undefined);
		const execution = this.operations.resolveWorkspaceToolExecution?.(name, canonicalDefinition.parameters);
		if (execution === "unavailable") return;
		if (execution === "remote") this.remoteToolNames.add(name);
		const hostedDefinition: ToolDefinition<TParams, TDetails, TState> = Object.freeze({
			...canonicalDefinition,
			execute,
		});
		this.rawDefinitions.set(name, canonicalDefinition);
		this.definitions.set(name, hostedDefinition as unknown as WorkspaceToolDefinition);
		this.tools.set(name, wrapToolDefinition(canonicalDefinition));
	}

	private async runDefinition<TParams extends TSchema, TDetails>(
		name: string,
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		context: ExtensionContext,
		executionOptions: WorkspaceToolExecutionOptions | undefined,
	): Promise<AgentToolResult<TDetails>> {
		if (this.disposed) throw new Error("Workspace tool host is disposed");
		const definition = this.requireRawDefinition(name) as ToolDefinition<TParams, TDetails>;
		const combinedSignal = signal
			? AbortSignal.any([signal, this.disposeController.signal])
			: this.disposeController.signal;
		if (combinedSignal.aborted) throw new Error("Operation aborted");
		const selection = this.selectWorkspaceExecution(name, params);
		const request: HostedToolExecution<TParams, TDetails> = {
			name,
			toolCallId,
			params,
			signal: combinedSignal,
			onUpdate,
			context,
			executionOptions,
		};
		const execution = selection.executeRemotely
			? this.startRemoteExecution(request)
			: this.startLocalExecution(
					request,
					this.resolveLocalDefinition(request, definition, selection.readOperations),
				);
		return await this.trackExecution(execution);
	}

	private async disposeHost(): Promise<void> {
		this.detachCatalogListener();
		this.disposeController.abort();
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				Promise.allSettled([...this.activeInvocations]),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, this.disposeTimeoutMs);
					timer.unref?.();
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
		if (this.ownsOperations) await this.operations.dispose?.();
	}

	private requireRawDefinition(name: string): AnyToolDefinition {
		const definition = this.rawDefinitions.get(name);
		if (!definition) throw new Error(`Unknown or non-workspace tool: ${name}`);
		return definition;
	}

	private requireTool(name: string): AnyAgentTool {
		const tool = this.tools.get(name);
		if (!tool) throw new Error(`Unknown or non-workspace tool: ${name}`);
		return tool;
	}
}
