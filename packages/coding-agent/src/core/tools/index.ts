export {
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createSshToolOperations,
	DeferredSshToolOperations,
	type DeferredSshToolOperationsConfigureOptions,
	LocalToolOperations,
	type LocalToolOperationsOptions,
	type ParsedSshTarget,
	SshToolOperations,
	type SshToolOperationsOptions,
	type ToolAccessMode,
	type ToolBackendInfo,
	type ToolExecOptions,
	type ToolFileStat,
	type ToolGlobOptions,
	type ToolGrepMatch,
	type ToolGrepOptions,
	type ToolGrepResult,
	type ToolOperations,
} from "./operations.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@fleetagent/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import type { ToolOperations } from "./operations.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
export const allToolNames: Set<ToolName> = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
}

export function createToolDefinition(toolName: ToolName, operations: ToolOperations, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(operations, options?.read);
		case "bash":
			return createBashToolDefinition(operations, options?.bash);
		case "edit":
			return createEditToolDefinition(operations, options?.edit);
		case "write":
			return createWriteToolDefinition(operations, options?.write);
		case "grep":
			return createGrepToolDefinition(operations, options?.grep);
		case "find":
			return createFindToolDefinition(operations, options?.find);
		case "ls":
			return createLsToolDefinition(operations, options?.ls);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, operations: ToolOperations, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(operations, options?.read);
		case "bash":
			return createBashTool(operations, options?.bash);
		case "edit":
			return createEditTool(operations, options?.edit);
		case "write":
			return createWriteTool(operations, options?.write);
		case "grep":
			return createGrepTool(operations, options?.grep);
		case "find":
			return createFindTool(operations, options?.find);
		case "ls":
			return createLsTool(operations, options?.ls);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(operations: ToolOperations, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(operations, options?.read),
		createBashToolDefinition(operations, options?.bash),
		createEditToolDefinition(operations, options?.edit),
		createWriteToolDefinition(operations, options?.write),
	];
}

export function createReadOnlyToolDefinitions(operations: ToolOperations, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(operations, options?.read),
		createGrepToolDefinition(operations, options?.grep),
		createFindToolDefinition(operations, options?.find),
		createLsToolDefinition(operations, options?.ls),
	];
}

export function createAllToolDefinitions(
	operations: ToolOperations,
	options?: ToolsOptions,
): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(operations, options?.read),
		bash: createBashToolDefinition(operations, options?.bash),
		edit: createEditToolDefinition(operations, options?.edit),
		write: createWriteToolDefinition(operations, options?.write),
		grep: createGrepToolDefinition(operations, options?.grep),
		find: createFindToolDefinition(operations, options?.find),
		ls: createLsToolDefinition(operations, options?.ls),
	};
}

export function createCodingTools(operations: ToolOperations, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(operations, options?.read),
		createBashTool(operations, options?.bash),
		createEditTool(operations, options?.edit),
		createWriteTool(operations, options?.write),
	];
}

export function createReadOnlyTools(operations: ToolOperations, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(operations, options?.read),
		createGrepTool(operations, options?.grep),
		createFindTool(operations, options?.find),
		createLsTool(operations, options?.ls),
	];
}

export function createAllTools(operations: ToolOperations, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(operations, options?.read),
		bash: createBashTool(operations, options?.bash),
		edit: createEditTool(operations, options?.edit),
		write: createWriteTool(operations, options?.write),
		grep: createGrepTool(operations, options?.grep),
		find: createFindTool(operations, options?.find),
		ls: createLsTool(operations, options?.ls),
	};
}
