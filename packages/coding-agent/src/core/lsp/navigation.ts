import { Text } from "@fleetagent/pi-tui";
import { type Static, Type } from "typebox";
import type { Hover, Location, LocationLink, MarkedString, MarkupContent } from "vscode-languageserver-protocol";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ToolOperations } from "../tools/operations.ts";
import { throwIfAborted } from "./abort.ts";
import type { LspRuntimeState } from "./integration.ts";
import type {
	LspClientRoute,
	LspClientRouteCollection,
	LspClientRouteFailure,
	LspManager,
	LspToolFeature,
} from "./manager.ts";
import { relativePortablePath } from "./portable-path.ts";

const MAX_REFERENCES = 80;

const positionFields = {
	path: Type.String({ description: "File path" }),
	line: Type.Integer({ minimum: 1, description: "Line number, 1-indexed" }),
	character: Type.Integer({ minimum: 1, description: "Column number, 1-indexed" }),
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

interface NormalizedLocation {
	key: string;
	value: string;
}

interface AttributedLocation {
	value: string;
	serverIds: string[];
}

function toPosition(input: PositionInput): { line: number; character: number } {
	return { line: input.line - 1, character: input.character - 1 };
}

function formatMappedUri(manager: LspManager, route: LspClientRoute, uri: string): string {
	const mapped = route.target.mapper.serverUriToAgentPath(uri);
	return mapped.ok ? relativePortablePath(manager.cwd, mapped.value) : `[unmapped URI: ${mapped.reason}]`;
}

function formatRangeStart(range: { start: { line: number; character: number } }): string {
	return `${range.start.line + 1}:${range.start.character + 1}`;
}

function normalizeLocation(state: LspRuntimeState, route: LspClientRoute, location: Location): NormalizedLocation {
	const path = formatMappedUri(state.manager, route, location.uri);
	return {
		key: JSON.stringify({ path, range: location.range }),
		value: `${path}:${formatRangeStart(location.range)}`,
	};
}

function normalizeLocationLink(
	state: LspRuntimeState,
	route: LspClientRoute,
	location: LocationLink,
): NormalizedLocation {
	const path = formatMappedUri(state.manager, route, location.targetUri);
	return {
		key: JSON.stringify({ path, range: location.targetSelectionRange }),
		value: `${path}:${formatRangeStart(location.targetSelectionRange)}`,
	};
}

function isLocationLinkArray(value: Location[] | LocationLink[]): value is LocationLink[] {
	return value.length > 0 && "targetUri" in value[0];
}

function normalizeDefinitionLocations(
	state: LspRuntimeState,
	route: LspClientRoute,
	result: DefinitionResult,
): NormalizedLocation[] {
	if (!result) return [];
	if (!Array.isArray(result)) return [normalizeLocation(state, route, result)];
	if (result.length === 0) return [];
	if (isLocationLinkArray(result)) return result.map((location) => normalizeLocationLink(state, route, location));
	return result.map((location) => normalizeLocation(state, route, location));
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

function failureText(failures: readonly LspClientRouteFailure[]): string {
	const unique = [
		...new Map(failures.map((failure) => [`${failure.serverId}\u0000${failure.reason}`, failure])).values(),
	];
	return unique.length === 0
		? ""
		: `\n\nUnavailable or unsupported servers:\n${unique.map((failure) => `- ${failure.serverId}: ${failure.reason}`).join("\n")}`;
}

async function getClientsAndSync(
	state: LspRuntimeState,
	input: PositionInput,
	operations: ToolOperations,
	feature: LspToolFeature,
	signal?: AbortSignal,
): Promise<LspClientRouteCollection> {
	await state.manager.setToolOperations(operations, signal);
	const collection = await state.manager.getClientRoutesForFeature(input.path, feature, signal);
	if (collection.routes.length > 0) {
		const result = await state.fileSync.synchronizeFileRead(input.path, operations, signal);
		if (result.lifecycleCancelled) {
			return {
				...collection,
				routes: [],
				failures: [
					...collection.failures,
					...collection.routes.map((route) => ({
						serverId: route.target.serverId,
						reason: "synchronization was cancelled by an LSP lifecycle change",
					})),
				],
			};
		}
		if (result.failures.length > 0) {
			const failedInstances = new Set(result.failures.map((failure) => failure.instanceKey));
			return {
				...collection,
				routes: collection.routes.filter((route) => !failedInstances.has(route.target.instanceKey)),
				failures: [
					...collection.failures,
					...result.failures.map((failure) => ({ serverId: failure.serverId, reason: failure.reason })),
				],
			};
		}
	}
	return collection;
}

async function noCapableResult(
	state: LspRuntimeState,
	path: string,
	feature: LspToolFeature,
	collection: LspClientRouteCollection,
	signal?: AbortSignal,
): Promise<string> {
	if (collection.matchedServerCount === 0) return state.manager.getUnavailableReason(path, signal);
	return `No capable LSP server is available for ${feature}.${failureText(collection.failures)}`;
}

function rethrowIfAborted(signal: AbortSignal | undefined): void {
	throwIfAborted(signal);
}

function mergeAttributedLocations(
	entries: Array<{ serverId: string; values: NormalizedLocation[] }>,
): AttributedLocation[] {
	const merged = new Map<string, AttributedLocation>();
	for (const entry of entries) {
		for (const location of entry.values) {
			const existing = merged.get(location.key);
			if (existing) {
				if (!existing.serverIds.includes(entry.serverId)) existing.serverIds.push(entry.serverId);
			} else {
				merged.set(location.key, { value: location.value, serverIds: [entry.serverId] });
			}
		}
	}
	return [...merged.values()];
}

function attributedLine(location: AttributedLocation, attribute: boolean): string {
	return attribute ? `[${location.serverIds.join(", ")}] ${location.value}` : location.value;
}

export function createLspHoverTool(
	getState: () => LspRuntimeState,
	getOperations?: () => ToolOperations,
): ToolDefinition<typeof hoverSchema, LspHoverDetails> {
	return {
		name: "lsp_hover",
		label: "lsp_hover",
		description:
			"Get hover information from the highest-priority capable LSP server at a file position. Falls back deterministically when a higher-priority server fails or returns no result. Line and character are 1-indexed.",
		promptSnippet: "Get hover information and documentation for a symbol via LSP",
		parameters: hoverSchema,
		async execute(_toolCallId, input: PositionInput, signal, _onUpdate, ctx) {
			const state = getState();
			const collection = await getClientsAndSync(
				state,
				input,
				getOperations?.() ?? ctx.toolOperations,
				"hover",
				signal,
			);
			if (collection.routes.length === 0) {
				return {
					content: [{ type: "text", text: await noCapableResult(state, input.path, "hover", collection, signal) }],
					details: { found: false },
				};
			}
			const failures = [...collection.failures];
			for (const route of collection.routes) {
				try {
					const result = await route.client.sendRequest<Hover | null>(
						"textDocument/hover",
						{ textDocument: { uri: route.target.serverUri }, position: toPosition(input) },
						signal,
					);
					if (!result) continue;
					const hover = hoverContentsToText(result.contents).trim();
					if (!hover) continue;
					const prefix = collection.matchedServerCount > 1 ? `Hover from ${route.target.serverId}:\n` : "";
					return {
						content: [{ type: "text", text: `${prefix}${hover}${failureText(failures)}` }],
						details: { found: true },
					};
				} catch (error) {
					rethrowIfAborted(signal);
					failures.push({
						serverId: route.target.serverId,
						reason: error instanceof Error ? error.message : String(error),
					});
				}
			}
			return {
				content: [{ type: "text", text: `No hover information.${failureText(failures)}` }],
				details: { found: false },
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
	getOperations?: () => ToolOperations,
): ToolDefinition<typeof definitionSchema, LspLocationDetails> {
	return {
		name: "lsp_definition",
		label: "lsp_definition",
		description:
			"Find definitions across all capable matching LSP servers. Identical locations are deduplicated and distinct results are attributed to server IDs. Line and character are 1-indexed.",
		promptSnippet: "Find definitions for a symbol via LSP",
		parameters: definitionSchema,
		async execute(_toolCallId, input: PositionInput, signal, _onUpdate, ctx) {
			const state = getState();
			const collection = await getClientsAndSync(
				state,
				input,
				getOperations?.() ?? ctx.toolOperations,
				"definition",
				signal,
			);
			if (collection.routes.length === 0) {
				return {
					content: [
						{ type: "text", text: await noCapableResult(state, input.path, "definition", collection, signal) },
					],
					details: { count: 0 },
				};
			}
			const outcomes = await Promise.all(
				collection.routes.map(async (route) => {
					try {
						const result = await route.client.sendRequest<DefinitionResult>(
							"textDocument/definition",
							{ textDocument: { uri: route.target.serverUri }, position: toPosition(input) },
							signal,
						);
						return {
							result: {
								serverId: route.target.serverId,
								values: normalizeDefinitionLocations(state, route, result),
							},
						};
					} catch (error) {
						rethrowIfAborted(signal);
						return {
							failure: {
								serverId: route.target.serverId,
								reason: error instanceof Error ? error.message : String(error),
							} satisfies LspClientRouteFailure,
						};
					}
				}),
			);
			const failures = [
				...collection.failures,
				...outcomes.flatMap((outcome) => (outcome.failure ? [outcome.failure] : [])),
			];
			const locations = mergeAttributedLocations(
				outcomes.flatMap((outcome) => (outcome.result ? [outcome.result] : [])),
			);
			if (locations.length === 0) {
				return {
					content: [{ type: "text", text: `No definition found.${failureText(failures)}` }],
					details: { count: 0 },
				};
			}
			const attribute = collection.matchedServerCount > 1;
			const lines = locations.map((location) => attributedLine(location, attribute));
			const body = locations.length === 1 ? `Definition: ${lines[0]}` : `Definitions:\n${lines.join("\n")}`;
			return {
				content: [{ type: "text", text: `${body}${failureText(failures)}` }],
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
	getOperations?: () => ToolOperations,
): ToolDefinition<typeof referencesSchema, LspLocationDetails> {
	return {
		name: "lsp_references",
		label: "lsp_references",
		description:
			"Find references across all capable matching LSP servers. Identical locations are deduplicated, distinct results are attributed, and output is capped. Line and character are 1-indexed.",
		promptSnippet: "Find references to a symbol via LSP",
		parameters: referencesSchema,
		async execute(_toolCallId, input: ReferencesInput, signal, _onUpdate, ctx) {
			const state = getState();
			const collection = await getClientsAndSync(
				state,
				input,
				getOperations?.() ?? ctx.toolOperations,
				"references",
				signal,
			);
			if (collection.routes.length === 0) {
				return {
					content: [
						{ type: "text", text: await noCapableResult(state, input.path, "references", collection, signal) },
					],
					details: { count: 0 },
				};
			}
			const outcomes = await Promise.all(
				collection.routes.map(async (route) => {
					try {
						const result = await route.client.sendRequest<Location[] | null>(
							"textDocument/references",
							{
								textDocument: { uri: route.target.serverUri },
								position: toPosition(input),
								context: { includeDeclaration: input.includeDeclaration ?? true },
							},
							signal,
						);
						return {
							result: {
								serverId: route.target.serverId,
								values: (result ?? []).map((location) => normalizeLocation(state, route, location)),
							},
						};
					} catch (error) {
						rethrowIfAborted(signal);
						return {
							failure: {
								serverId: route.target.serverId,
								reason: error instanceof Error ? error.message : String(error),
							} satisfies LspClientRouteFailure,
						};
					}
				}),
			);
			const failures = [
				...collection.failures,
				...outcomes.flatMap((outcome) => (outcome.failure ? [outcome.failure] : [])),
			];
			const locations = mergeAttributedLocations(
				outcomes.flatMap((outcome) => (outcome.result ? [outcome.result] : [])),
			);
			if (locations.length === 0) {
				return {
					content: [{ type: "text", text: `No references found.${failureText(failures)}` }],
					details: { count: 0 },
				};
			}
			const shown = locations.slice(0, MAX_REFERENCES);
			const truncated = shown.length < locations.length;
			const attribute = collection.matchedServerCount > 1;
			const suffix = truncated ? `\n\n[Showing ${shown.length} of ${locations.length} references.]` : "";
			return {
				content: [
					{
						type: "text",
						text: `${locations.length} reference(s):\n${shown.map((location) => attributedLine(location, attribute)).join("\n")}${suffix}${failureText(failures)}`,
					},
				],
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
