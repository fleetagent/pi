import type { ExtensionAPI, ExtensionContext, ToolResultEvent, ToolResultEventResult } from "../extensions/types.ts";
import { isEditToolResult, isReadToolResult, isWriteToolResult } from "../extensions/types.ts";
import type { ToolBackendInfo, ToolOperations } from "../tools/operations.ts";
import type { ResolvedLspConfiguration } from "./config.ts";
import { createLspDiagnosticsTool, formatAutoDiagnosticsForChangedFile } from "./diagnostics.ts";
import { LspFileSync } from "./file-sync.ts";
import { LspManager, type LspManagerOptions, type LspServerStatus } from "./manager.ts";
import { createLspDefinitionTool, createLspHoverTool, createLspReferencesTool } from "./navigation.ts";
import { createLspCodeActionsTool, createLspRenameTool } from "./refactor.ts";

export const LSP_TOOL_NAMES = Object.freeze([
	"lsp_diagnostics",
	"lsp_hover",
	"lsp_definition",
	"lsp_references",
	"lsp_rename",
	"lsp_code_actions",
] as const);
export type LspToolName = (typeof LSP_TOOL_NAMES)[number];
export type LspRuntimeOwner = "agent-session" | "standalone" | "daemon";
export interface LspRuntimeState {
	manager: LspManager;
	fileSync: LspFileSync;
}

export interface LspSessionStatus {
	owner: LspRuntimeOwner;
	enabled: boolean;
	configuration: ResolvedLspConfiguration;
	servers: LspServerStatus[];
}

export interface LspLifecycleOptions extends LspManagerOptions {
	maxTrackedDocuments?: number;
}

export function createLspToolDefinitions(getState: () => LspRuntimeState, getOperations?: () => ToolOperations) {
	return [
		createLspDiagnosticsTool(getState, getOperations),
		createLspHoverTool(getState, getOperations),
		createLspDefinitionTool(getState, getOperations),
		createLspReferencesTool(getState, getOperations),
		createLspRenameTool(getState, getOperations),
		createLspCodeActionsTool(getState, getOperations),
	] as const;
}

export function createLspRuntimeState(cwd: string, options: LspLifecycleOptions = {}): LspRuntimeState {
	const manager = new LspManager(cwd, options);
	return {
		manager,
		fileSync: new LspFileSync(manager, options.maxTrackedDocuments),
	};
}

const standaloneRegistrations = new WeakMap<ExtensionAPI, () => LspRuntimeState>();

/**
 * Register a self-contained LSP runtime for hosts that use the extension system without AgentSession.
 * AgentSession already owns LSP tools and synchronization; extensions running inside it must use
 * `ctx.getLspStatus()` and `ctx.configureLsp()` instead of registering another runtime.
 */
export function registerStandaloneLspLifecycleHandlers(
	pi: ExtensionAPI,
	options: LspLifecycleOptions = {},
): () => LspRuntimeState {
	const existing = standaloneRegistrations.get(pi);
	if (existing) return existing;
	let state: LspRuntimeState | undefined;
	let delegatedToAgentSession = false;
	let toolsRegistered = false;
	let toolsAvailable = false;
	let toolBackendInfo: ToolBackendInfo | undefined;
	let toolOperations: ExtensionContext["toolOperations"] | undefined;
	const getState = (cwd = process.cwd()): LspRuntimeState => {
		if (delegatedToAgentSession) {
			throw new Error(
				"AgentSession already owns LSP. Use ctx.getLspStatus() and ctx.configureLsp() instead of the standalone helper.",
			);
		}
		state ??= createLspRuntimeState(cwd, {
			...options,
			getToolBackendInfo: () => toolBackendInfo ?? options.getToolBackendInfo?.() ?? { type: "local", cwd },
		});
		return state;
	};

	const registerToolsOnce = (): void => {
		if (toolsRegistered) return;
		toolsRegistered = true;
		toolsAvailable = true;
		const [diagnostics, hover, definition, references, rename, codeActions] = createLspToolDefinitions(() =>
			getState(),
		);
		pi.registerTool(diagnostics);
		pi.registerTool(hover);
		pi.registerTool(definition);
		pi.registerTool(references);
		pi.registerTool(rename);
		pi.registerTool(codeActions);
	};

	const unregisterTools = (): void => {
		if (!toolsAvailable) return;
		toolsAvailable = false;
		for (const name of LSP_TOOL_NAMES) {
			pi.unregisterTool(name);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		const previous = state;
		toolBackendInfo = ctx.toolOperations.getBackendInfo?.() ?? { type: "local", cwd: ctx.toolOperations.cwd };
		toolOperations = ctx.toolOperations;
		if (delegatedToAgentSession || ctx.getLspStatus().owner === "agent-session") {
			delegatedToAgentSession = true;
			unregisterTools();
			state = undefined;
			return previous?.manager.shutdownAll();
		}
		delegatedToAgentSession = false;
		registerToolsOnce();
		state = createLspRuntimeState(ctx.toolOperations.cwd, {
			...options,
			getToolBackendInfo: () => toolBackendInfo ?? { type: "local", cwd: ctx.toolOperations.cwd },
			getToolOperations: () => toolOperations ?? ctx.toolOperations,
		});
		return previous?.manager.shutdownAll();
	});

	pi.on("tool_result", async (event, ctx) => {
		if (delegatedToAgentSession) return undefined;
		toolOperations = ctx.toolOperations;
		toolBackendInfo = ctx.toolOperations.getBackendInfo?.() ?? { type: "local", cwd: ctx.toolOperations.cwd };
		return syncToolResult(event, ctx, getState(ctx.toolOperations.cwd));
	});

	pi.on("session_shutdown", async () => {
		const current = state;
		state = undefined;
		toolOperations = undefined;
		await current?.manager.shutdownAll();
	});

	const registration = () => getState(process.cwd());
	standaloneRegistrations.set(pi, registration);
	return registration;
}

/**
 * @deprecated Use `registerStandaloneLspLifecycleHandlers` only in standalone extension hosts. In a normal
 * AgentSession, use its built-in LSP runtime through `ctx.getLspStatus()` and `ctx.configureLsp()`.
 */
export const registerLspLifecycleHandlers = registerStandaloneLspLifecycleHandlers;

async function syncToolResult(
	event: ToolResultEvent,
	ctx: ExtensionContext,
	state: LspRuntimeState,
): Promise<ToolResultEventResult | undefined> {
	if (event.isError) return;
	const filePath = typeof event.input.path === "string" ? event.input.path : undefined;
	if (!filePath) return;

	try {
		if (isReadToolResult(event)) {
			await state.fileSync.handleFileRead(filePath, ctx.toolOperations);
			return;
		}
		if (isWriteToolResult(event) || isEditToolResult(event)) {
			await state.fileSync.handleFileWrite(filePath, ctx.toolOperations);
			const diagnostics = await formatAutoDiagnosticsForChangedFile(state, filePath);
			if (!diagnostics) return undefined;
			return {
				content: [...event.content, { type: "text" as const, text: `\n\n${diagnostics}` }],
			};
		}
	} catch {
		// LSP synchronization is best-effort and must not affect tool results.
	}
}
