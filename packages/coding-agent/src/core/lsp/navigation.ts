import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Text } from "@fleetagent/pi-tui";
import { type Static, Type } from "typebox";
import type { Hover, Location, LocationLink, MarkedString, MarkupContent } from "vscode-languageserver-protocol";
import type { ToolDefinition } from "../extensions/types.ts";
import type { LspRuntimeState } from "./integration.ts";

const MAX_REFERENCES = 80;

const positionFields = {
	path: Type.String({ description: "File path" }),
	line: Type.Number({ description: "Line number, 1-indexed" }),
	character: Type.Number({ description: "Column number, 1-indexed" }),
};

const hoverSchema = Type.Object(positionFields);
const definitionSchema = Type.Object(positionFields);
const referencesSchema = Type.Object({
	...positionFields,
	includeDeclaration: Type.Optional(
		Type.Boolean({ description: "Include the declaration in results. Defaults to true." }),
	),
});

type PositionInput = Static<typeof hoverSchema>;
type ReferencesInput = Static<typeof referencesSchema>;

export interface LspHoverDetails {
	found: boolean;
}

export interface LspLocationDetails {
	count: number;
	truncated?: boolean;
}

type DefinitionResult = Location | Location[] | LocationLink[] | null;

function toPosition(input: PositionInput): { line: number; character: number } {
	return { line: input.line - 1, character: input.character - 1 };
}

function uriToAbsolutePath(uri: string): string {
	try {
		return uri.startsWith("file://") ? fileURLToPath(uri) : uri;
	} catch {
		return uri;
	}
}

function formatRangeStart(range: { start: { line: number; character: number } }): string {
	return `${range.start.line + 1}:${range.start.character + 1}`;
}

function formatLocation(state: LspRuntimeState, location: Location): string {
	const filePath = relative(state.manager.cwd, uriToAbsolutePath(location.uri));
	return `${filePath}:${formatRangeStart(location.range)}`;
}

function formatLocationLink(state: LspRuntimeState, location: LocationLink): string {
	const filePath = relative(state.manager.cwd, uriToAbsolutePath(location.targetUri));
	return `${filePath}:${formatRangeStart(location.targetRange)}`;
}

function isLocationLinkArray(value: Location[] | LocationLink[]): value is LocationLink[] {
	return value.length > 0 && "targetUri" in value[0];
}

function normalizeDefinitionLocations(state: LspRuntimeState, result: DefinitionResult): string[] {
	if (!result) return [];
	if (!Array.isArray(result)) return [formatLocation(state, result)];
	if (result.length === 0) return [];
	if (isLocationLinkArray(result)) return result.map((location) => formatLocationLink(state, location));
	return result.map((location) => formatLocation(state, location));
}

function markedStringToText(value: MarkedString): string {
	return typeof value === "string" ? value : value.value;
}

function hoverContentsToText(contents: Hover["contents"]): string {
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) return contents.map(markedStringToText).join("\n\n");
	if ("kind" in contents) return (contents as MarkupContent).value;
	return markedStringToText(contents);
}

async function getClientAndSync(
	state: LspRuntimeState,
	input: PositionInput,
	ctx: Parameters<ToolDefinition["execute"]>[4],
) {
	const client = await state.manager.getClientForFile(input.path);
	if (!client) return undefined;
	await state.fileSync.handleFileRead(input.path, ctx.toolOperations).catch(() => undefined);
	return client;
}

export function createLspHoverTool(
	getState: () => LspRuntimeState,
): ToolDefinition<typeof hoverSchema, LspHoverDetails> {
	return {
		name: "lsp_hover",
		label: "lsp_hover",
		description:
			"Get hover/type information and documentation for a symbol at a file position. Line and character are 1-indexed.",
		promptSnippet: "Get type information and documentation for a symbol via LSP",
		parameters: hoverSchema,
		async execute(_toolCallId, input: PositionInput, _signal, _onUpdate, ctx) {
			const state = getState();
			const client = await getClientAndSync(state, input, ctx);
			if (!client) {
				return {
					content: [{ type: "text", text: state.manager.getUnavailableReason(input.path) }],
					details: { found: false },
				};
			}
			const result = await client.sendRequest<Hover | null>("textDocument/hover", {
				textDocument: { uri: state.manager.getFileUri(input.path) },
				position: toPosition(input),
			});
			if (!result) return { content: [{ type: "text", text: "No hover information." }], details: { found: false } };
			const text = hoverContentsToText(result.contents).trim();
			return {
				content: [{ type: "text", text: text || "No hover information." }],
				details: { found: text.length > 0 },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("lsp_hover"))} ${theme.fg("accent", `${args.path}:${args.line}:${args.character}`)}`,
				0,
				0,
			);
		},
	};
}

export function createLspDefinitionTool(
	getState: () => LspRuntimeState,
): ToolDefinition<typeof definitionSchema, LspLocationDetails> {
	return {
		name: "lsp_definition",
		label: "lsp_definition",
		description:
			"Go to the definition of a symbol at a file position. Returns compact relative file locations. Line and character are 1-indexed.",
		promptSnippet: "Find the definition of a symbol via LSP",
		parameters: definitionSchema,
		async execute(_toolCallId, input: PositionInput, _signal, _onUpdate, ctx) {
			const state = getState();
			const client = await getClientAndSync(state, input, ctx);
			if (!client) {
				return {
					content: [{ type: "text", text: state.manager.getUnavailableReason(input.path) }],
					details: { count: 0 },
				};
			}
			const result = await client.sendRequest<DefinitionResult>("textDocument/definition", {
				textDocument: { uri: state.manager.getFileUri(input.path) },
				position: toPosition(input),
			});
			const locations = normalizeDefinitionLocations(state, result);
			if (locations.length === 0)
				return { content: [{ type: "text", text: "No definition found." }], details: { count: 0 } };
			return {
				content: [
					{
						type: "text",
						text:
							locations.length === 1 ? `Definition: ${locations[0]}` : `Definitions:\n${locations.join("\n")}`,
					},
				],
				details: { count: locations.length },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("lsp_definition"))} ${theme.fg("accent", `${args.path}:${args.line}:${args.character}`)}`,
				0,
				0,
			);
		},
	};
}

export function createLspReferencesTool(
	getState: () => LspRuntimeState,
): ToolDefinition<typeof referencesSchema, LspLocationDetails> {
	return {
		name: "lsp_references",
		label: "lsp_references",
		description:
			"Find references to a symbol at a file position. Returns capped compact relative file locations. Line and character are 1-indexed.",
		promptSnippet: "Find references to a symbol via LSP",
		parameters: referencesSchema,
		async execute(_toolCallId, input: ReferencesInput, _signal, _onUpdate, ctx) {
			const state = getState();
			const client = await getClientAndSync(state, input, ctx);
			if (!client) {
				return {
					content: [{ type: "text", text: state.manager.getUnavailableReason(input.path) }],
					details: { count: 0 },
				};
			}
			const result = await client.sendRequest<Location[] | null>("textDocument/references", {
				textDocument: { uri: state.manager.getFileUri(input.path) },
				position: toPosition(input),
				context: { includeDeclaration: input.includeDeclaration ?? true },
			});
			const locations = (result ?? []).map((location) => formatLocation(state, location));
			if (locations.length === 0)
				return { content: [{ type: "text", text: "No references found." }], details: { count: 0 } };
			const shown = locations.slice(0, MAX_REFERENCES);
			const truncated = shown.length < locations.length;
			const suffix = truncated ? `\n\n[Showing ${shown.length} of ${locations.length} references.]` : "";
			return {
				content: [{ type: "text", text: `${locations.length} reference(s):\n${shown.join("\n")}${suffix}` }],
				details: { count: locations.length, ...(truncated ? { truncated } : {}) },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("lsp_references"))} ${theme.fg("accent", `${args.path}:${args.line}:${args.character}`)}`,
				0,
				0,
			);
		},
	};
}
