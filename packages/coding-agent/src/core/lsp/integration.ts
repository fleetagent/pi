import type { ExtensionAPI, ExtensionContext, ToolResultEvent, ToolResultEventResult } from "../extensions/types.ts";
import { isEditToolResult, isReadToolResult, isWriteToolResult } from "../extensions/types.ts";
import { createLspDiagnosticsTool, formatAutoDiagnosticsForChangedFile } from "./diagnostics.ts";
import { LspFileSync } from "./file-sync.ts";
import { LspManager, type LspManagerOptions } from "./manager.ts";
import { createLspDefinitionTool, createLspHoverTool, createLspReferencesTool } from "./navigation.ts";
import { createLspCodeActionsTool, createLspRenameTool } from "./refactor.ts";

export interface LspRuntimeState {
	manager: LspManager;
	fileSync: LspFileSync;
}

export interface LspLifecycleOptions extends LspManagerOptions {
	maxTrackedDocuments?: number;
}

export function createLspRuntimeState(cwd: string, options: LspLifecycleOptions = {}): LspRuntimeState {
	const manager = new LspManager(cwd, options);
	return {
		manager,
		fileSync: new LspFileSync(manager, options.maxTrackedDocuments),
	};
}

export function registerLspLifecycleHandlers(
	pi: ExtensionAPI,
	options: LspLifecycleOptions = {},
): () => LspRuntimeState {
	let state: LspRuntimeState | undefined;

	const getState = (cwd = process.cwd()): LspRuntimeState => {
		state ??= createLspRuntimeState(cwd, options);
		return state;
	};

	pi.registerTool(createLspDiagnosticsTool(() => getState()));
	pi.registerTool(createLspHoverTool(() => getState()));
	pi.registerTool(createLspDefinitionTool(() => getState()));
	pi.registerTool(createLspReferencesTool(() => getState()));
	pi.registerTool(createLspRenameTool(() => getState()));
	pi.registerTool(createLspCodeActionsTool(() => getState()));

	pi.on("session_start", (_event, ctx) => {
		state = createLspRuntimeState(ctx.cwd, options);
	});

	pi.on("tool_result", async (event, ctx) => {
		return syncToolResult(event, ctx, getState(ctx.cwd));
	});

	pi.on("session_shutdown", async () => {
		const current = state;
		state = undefined;
		await current?.manager.shutdownAll();
	});

	return () => getState(process.cwd());
}

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
