import { Text } from "@fleetagent/pi-tui";
import { type Static, Type } from "typebox";
import type { CodeAction, Command, Diagnostic, TextEdit, WorkspaceEdit } from "vscode-languageserver-protocol";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ToolOperations } from "../tools/operations.ts";
import { throwIfAborted } from "./abort.ts";
import type { LspRuntimeState } from "./integration.ts";
import type { LspClientRoute, LspClientRouteCollection, LspClientRouteFailure, LspToolFeature } from "./manager.ts";
import { relativePortablePath } from "./portable-path.ts";

const MAX_ACTIONS = 40;
const MAX_EDIT_LINES = 80;

const positionFields = {
	path: Type.String({ description: "File path" }),
	line: Type.Integer({ minimum: 1, description: "Line number, 1-indexed" }),
	character: Type.Integer({ minimum: 1, description: "Column number, 1-indexed" }),
};

const renameSchema = Type.Object({
	...positionFields,
	newName: Type.String({ description: "New name for the symbol" }),
});

const codeActionsSchema = Type.Object({
	...positionFields,
	endLine: Type.Optional(
		Type.Integer({ minimum: 1, description: "End line for a range selection, 1-indexed. Defaults to line." }),
	),
	endCharacter: Type.Optional(
		Type.Integer({ minimum: 1, description: "End column for a range selection, 1-indexed. Defaults to character." }),
	),
	kind: Type.Optional(Type.String({ description: "Optional action kind filter, e.g. quickfix, refactor, source." })),
});

type RenameInput = Static<typeof renameSchema>;
type CodeActionsInput = Static<typeof codeActionsSchema>;

export interface LspRenameDetails {
	fileCount: number;
	editCount: number;
	truncated?: boolean;
	conflict?: boolean;
}

export interface LspCodeActionsDetails {
	count: number;
	preferredCount: number;
}

type CodeActionResponse = (CodeAction | Command)[] | null;

type TextDocumentEditLike = {
	textDocument: { uri: string; version?: number | null };
	edits: TextEdit[];
};

interface WorkspaceEditEntry {
	path: string;
	edit: TextEdit;
	version?: number | null;
}

interface WorkspaceEditPreview {
	lines: string[];
	fileCount: number;
	editCount: number;
	truncated: boolean;
	signature: string;
	versionErrors: string[];
}

interface RenamePreviewResult {
	serverId: string;
	preview: WorkspaceEditPreview;
}

interface AggregatedAction {
	item: CodeAction | Command;
	route: LspClientRoute;
	serverIds: string[];
	preferred: boolean;
}

function toPosition(input: { line: number; character: number }): { line: number; character: number } {
	return { line: input.line - 1, character: input.character - 1 };
}

function relativeUriPath(state: LspRuntimeState, route: LspClientRoute, uri: string): string {
	const mapped = route.target.mapper.serverUriToAgentPath(uri);
	return mapped.ok ? relativePortablePath(state.manager.cwd, mapped.value) : `[unmapped URI: ${mapped.reason}]`;
}

function formatTextEdit(edit: TextEdit): string {
	const startLine = edit.range.start.line + 1;
	const startColumn = edit.range.start.character + 1;
	const endLine = edit.range.end.line + 1;
	const endColumn = edit.range.end.character + 1;
	const replacement = edit.newText.replace(/\n/g, "\\n");
	const clipped = replacement.length > 120 ? `${replacement.slice(0, 117)}...` : replacement;
	return `${startLine}:${startColumn}-${endLine}:${endColumn} -> ${JSON.stringify(clipped)}`;
}

function isTextDocumentEditLike(value: unknown): value is TextDocumentEditLike {
	return (
		typeof value === "object" &&
		value !== null &&
		"textDocument" in value &&
		"edits" in value &&
		Array.isArray((value as { edits?: unknown }).edits)
	);
}

function stableSerialize(value: unknown, ancestors = new Set<object>()): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
	if (ancestors.has(value)) return '"[circular]"';
	ancestors.add(value);
	let output: string;
	if (Array.isArray(value)) {
		output = `[${value.map((item) => stableSerialize(item, ancestors)).join(",")}]`;
	} else {
		const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
		output = `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item, ancestors)}`).join(",")}}`;
	}
	ancestors.delete(value);
	return output;
}

interface ResourceOperationPreview {
	line: string;
	paths: string[];
	signature: string;
}

function normalizeResourceOperation(
	state: LspRuntimeState,
	route: LspClientRoute,
	value: unknown,
): ResourceOperationPreview {
	if (typeof value !== "object" || value === null || !("kind" in value) || typeof value.kind !== "string") {
		const signature = stableSerialize(value);
		return { line: `[unknown workspace operation: ${signature}]`, paths: [], signature };
	}
	if ((value.kind === "create" || value.kind === "delete") && "uri" in value && typeof value.uri === "string") {
		const path = relativeUriPath(state, route, value.uri);
		const options = "options" in value ? value.options : undefined;
		const signature = stableSerialize({ kind: value.kind, path, options });
		return { line: `[workspace ${value.kind}: ${path}]`, paths: [path], signature };
	}
	if (
		value.kind === "rename" &&
		"oldUri" in value &&
		typeof value.oldUri === "string" &&
		"newUri" in value &&
		typeof value.newUri === "string"
	) {
		const oldPath = relativeUriPath(state, route, value.oldUri);
		const newPath = relativeUriPath(state, route, value.newUri);
		const options = "options" in value ? value.options : undefined;
		const signature = stableSerialize({ kind: value.kind, oldPath, newPath, options });
		return { line: `[workspace rename: ${oldPath} -> ${newPath}]`, paths: [oldPath, newPath], signature };
	}
	const signature = stableSerialize(value);
	return { line: `[unknown workspace operation: ${signature}]`, paths: [], signature };
}

function collectWorkspaceEditPreview(
	state: LspRuntimeState,
	route: LspClientRoute,
	edit: WorkspaceEdit | undefined,
	validateDocumentVersions = false,
): WorkspaceEditPreview {
	if (!edit) {
		return { lines: [], fileCount: 0, editCount: 0, truncated: false, signature: "[]", versionErrors: [] };
	}
	const entries: WorkspaceEditEntry[] = [];
	const resourceOperations: ResourceOperationPreview[] = [];
	const versionErrors: string[] = [];
	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if (isTextDocumentEditLike(change)) {
				const path = relativeUriPath(state, route, change.textDocument.uri);
				const version = change.textDocument.version;
				if (validateDocumentVersions && typeof version === "number") {
					const trackedVersion = state.fileSync.getTrackedVersion(
						change.textDocument.uri,
						route.target.instanceKey,
					);
					if (trackedVersion === undefined) {
						versionErrors.push(
							`unknown tracked version for ${path}; response requires document version ${version}`,
						);
					} else if (trackedVersion !== version) {
						versionErrors.push(
							`stale document version ${version}; tracked version is ${trackedVersion} for ${path}`,
						);
					}
				}
				for (const textEdit of change.edits) entries.push({ path, edit: textEdit, version });
			} else {
				resourceOperations.push(normalizeResourceOperation(state, route, change));
			}
		}
	}
	if (edit.changes) {
		for (const [uri, edits] of Object.entries(edit.changes)) {
			const path = relativeUriPath(state, route, uri);
			for (const textEdit of edits) entries.push({ path, edit: textEdit });
		}
	}
	entries.sort(
		(left, right) =>
			left.path.localeCompare(right.path) ||
			left.edit.range.start.line - right.edit.range.start.line ||
			left.edit.range.start.character - right.edit.range.start.character ||
			left.edit.range.end.line - right.edit.range.end.line ||
			left.edit.range.end.character - right.edit.range.end.character ||
			left.edit.newText.localeCompare(right.edit.newText),
	);
	resourceOperations.sort((left, right) => left.signature.localeCompare(right.signature));
	const lines: string[] = [];
	let previousDocument: string | undefined;
	for (const entry of entries) {
		const versionLabel =
			entry.version === undefined
				? ""
				: entry.version === null
					? " (document version: unversioned)"
					: ` (document version ${entry.version})`;
		const document = `${entry.path}\u0000${versionLabel}`;
		if (document !== previousDocument) {
			lines.push(`${entry.path}${versionLabel}:`);
			previousDocument = document;
		}
		lines.push(`  ${formatTextEdit(entry.edit)}`);
	}
	for (const operation of resourceOperations) lines.push(operation.line);
	const shown = lines.slice(0, MAX_EDIT_LINES);
	return {
		lines: shown,
		fileCount: new Set([
			...entries.map((entry) => entry.path),
			...resourceOperations.flatMap((operation) => operation.paths),
		]).size,
		editCount: entries.length + resourceOperations.length,
		truncated: shown.length < lines.length,
		signature:
			entries.length === 0 && resourceOperations.length === 0
				? "[]"
				: stableSerialize({
						entries: entries.map((entry) => ({
							path: entry.path,
							range: entry.edit.range,
							newText: entry.edit.newText,
						})),
						resourceOperations: resourceOperations.map((operation) => operation.signature),
					}),
		versionErrors,
	};
}

function isCodeAction(item: CodeAction | Command): item is CodeAction {
	return typeof item.command !== "string";
}

function comparePosition(
	left: { line: number; character: number },
	right: { line: number; character: number },
): number {
	return left.line - right.line || left.character - right.character;
}

function rangesOverlap(
	left: { start: { line: number; character: number }; end: { line: number; character: number } },
	right: { start: { line: number; character: number }; end: { line: number; character: number } },
): boolean {
	return comparePosition(left.end, right.start) >= 0 && comparePosition(right.end, left.start) >= 0;
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
	input: { path: string },
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

function actionKey(item: CodeAction | Command, preview: WorkspaceEditPreview): string {
	if (isCodeAction(item)) {
		return stableSerialize({
			title: item.title,
			kind: item.kind,
			command: item.command,
			data: item.data,
			edit: preview.signature,
		});
	}
	return stableSerialize({ title: item.title, command: item.command, arguments: item.arguments });
}

export function createLspRenameTool(
	getState: () => LspRuntimeState,
	getOperations?: () => ToolOperations,
): ToolDefinition<typeof renameSchema, LspRenameDetails> {
	return {
		name: "lsp_rename",
		label: "lsp_rename",
		description:
			"Preview a rename from all capable matching LSP servers. A preview is selected only when every successful response agrees, including empty responses, and document versions are current. Conflicting or stale edits are reported without choosing one. No changes are applied.",
		promptSnippet: "Preview a symbol rename via LSP without applying changes",
		promptGuidelines: ["lsp_rename is preview-only. Apply reviewed changes with read/edit using hashline anchors."],
		parameters: renameSchema,
		async execute(_toolCallId, input: RenameInput, signal, _onUpdate, ctx) {
			const state = getState();
			const collection = await getClientsAndSync(
				state,
				input,
				getOperations?.() ?? ctx.toolOperations,
				"rename",
				signal,
			);
			if (collection.routes.length === 0) {
				return {
					content: [
						{ type: "text", text: await noCapableResult(state, input.path, "rename", collection, signal) },
					],
					details: { fileCount: 0, editCount: 0 },
				};
			}
			const outcomes = await Promise.all(
				collection.routes.map(async (route) => {
					try {
						const result = await route.client.sendRequest<WorkspaceEdit | null>(
							"textDocument/rename",
							{
								textDocument: { uri: route.target.serverUri },
								position: toPosition(input),
								newName: input.newName,
							},
							signal,
						);
						return {
							result: {
								serverId: route.target.serverId,
								preview: collectWorkspaceEditPreview(state, route, result ?? undefined, true),
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
			const previews = outcomes.flatMap((outcome) => (outcome.result ? [outcome.result] : []));
			if (previews.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No LSP server returned a rename preview. No changes were applied.${failureText(failures)}`,
						},
					],
					details: { fileCount: 0, editCount: 0 },
				};
			}
			const unsafeVersions = previews.flatMap((entry) =>
				entry.preview.versionErrors.map((reason) => `[${entry.serverId}] ${reason}`),
			);
			if (unsafeVersions.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: `Unsafe rename preview for ${JSON.stringify(input.newName)} due to stale or unknown document versions. No preview was selected and no changes were applied.\n\n${unsafeVersions.join("\n")}${failureText(failures)}`,
						},
					],
					details: {
						fileCount: Math.max(...previews.map((entry) => entry.preview.fileCount)),
						editCount: Math.max(...previews.map((entry) => entry.preview.editCount)),
						conflict: true,
					},
				};
			}
			const bySignature = new Map<string, RenamePreviewResult[]>();
			for (const preview of previews) {
				bySignature.set(preview.preview.signature, [
					...(bySignature.get(preview.preview.signature) ?? []),
					preview,
				]);
			}
			if (bySignature.size > 1) {
				const sections = [...bySignature.values()].map((group) => {
					const first = group[0];
					return first.preview.editCount === 0
						? `[${group.map((entry) => entry.serverId).join(", ")}] no edits`
						: `[${group.map((entry) => entry.serverId).join(", ")}] ${first.preview.editCount} edit(s):\n${first.preview.lines.join("\n")}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Conflicting rename previews for ${JSON.stringify(input.newName)}. No preview was selected and no changes were applied.\n\n${sections.join("\n\n")}${failureText(failures)}`,
						},
					],
					details: {
						fileCount: Math.max(...previews.map((entry) => entry.preview.fileCount)),
						editCount: Math.max(...previews.map((entry) => entry.preview.editCount)),
						conflict: true,
					},
				};
			}
			const matching = [...bySignature.values()][0];
			const selected = matching[0];
			if (selected.preview.editCount === 0) {
				const providers = matching.map((entry) => entry.serverId).join(", ");
				return {
					content: [
						{
							type: "text",
							text: `Rename preview: no edits. Successful provider(s): ${providers}. No changes were applied.${failureText(failures)}`,
						},
					],
					details: { fileCount: 0, editCount: 0 },
				};
			}
			const attribution =
				collection.matchedServerCount > 1
					? ` Selected provider(s): ${matching.map((entry) => entry.serverId).join(", ")}.`
					: "";
			const suffix = selected.preview.truncated
				? `\n[Showing ${selected.preview.lines.length} edit preview lines.]`
				: "";
			return {
				content: [
					{
						type: "text",
						text: `Rename preview for ${JSON.stringify(input.newName)}: ${selected.preview.editCount} edit(s) across ${selected.preview.fileCount} file(s).${attribution} No changes were applied.\n\n${selected.preview.lines.join("\n")}${suffix}${failureText(failures)}`,
					},
				],
				details: {
					fileCount: selected.preview.fileCount,
					editCount: selected.preview.editCount,
					...(selected.preview.truncated ? { truncated: true } : {}),
				},
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("lsp_rename"))} ${theme.fg("accent", `${args.path}:${args.line}:${args.character}`)} -> ${theme.fg("muted", args.newName)}`,
				0,
				0,
			);
		},
	};
}

export function createLspCodeActionsTool(
	getState: () => LspRuntimeState,
	getOperations?: () => ToolOperations,
): ToolDefinition<typeof codeActionsSchema, LspCodeActionsDetails> {
	return {
		name: "lsp_code_actions",
		label: "lsp_code_actions",
		description:
			"List code actions from all capable matching LSP servers. Identical actions are deduplicated, distinct actions are attributed, and edit previews are never applied.",
		promptSnippet: "List available LSP code actions and refactorings",
		promptGuidelines: [
			"lsp_code_actions is preview-only. Apply reviewed edits with read/edit using hashline anchors.",
		],
		parameters: codeActionsSchema,
		async execute(_toolCallId, input: CodeActionsInput, signal, _onUpdate, ctx) {
			const state = getState();
			const collection = await getClientsAndSync(
				state,
				input,
				getOperations?.() ?? ctx.toolOperations,
				"codeActions",
				signal,
			);
			if (collection.routes.length === 0) {
				return {
					content: [
						{ type: "text", text: await noCapableResult(state, input.path, "codeActions", collection, signal) },
					],
					details: { count: 0, preferredCount: 0 },
				};
			}
			const start = toPosition(input);
			const end = {
				line: (input.endLine ?? input.line) - 1,
				character: (input.endCharacter ?? input.character) - 1,
			};
			const outcomes = await Promise.all(
				collection.routes.map(async (route) => {
					try {
						const uri = route.target.serverUri;
						const diagnostics = route.client
							.getDiagnostics(uri)
							.filter((diagnostic: Diagnostic) => rangesOverlap(diagnostic.range, { start, end }));
						const response = await route.client.sendRequest<CodeActionResponse>(
							"textDocument/codeAction",
							{
								textDocument: { uri },
								range: { start, end },
								context: { diagnostics, only: input.kind ? [input.kind] : undefined },
							},
							signal,
						);
						return { route, items: response ?? [] };
					} catch (error) {
						rethrowIfAborted(signal);
						return {
							route,
							items: [],
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
			const aggregated = new Map<string, AggregatedAction>();
			for (const outcome of outcomes) {
				for (const item of outcome.items) {
					const preview = collectWorkspaceEditPreview(
						state,
						outcome.route,
						isCodeAction(item) ? item.edit : undefined,
					);
					const key = actionKey(item, preview);
					const existing = aggregated.get(key);
					if (existing) {
						if (!existing.serverIds.includes(outcome.route.target.serverId)) {
							existing.serverIds.push(outcome.route.target.serverId);
						}
						existing.preferred ||= isCodeAction(item) && item.isPreferred === true;
					} else {
						aggregated.set(key, {
							item,
							route: outcome.route,
							serverIds: [outcome.route.target.serverId],
							preferred: isCodeAction(item) && item.isPreferred === true,
						});
					}
				}
			}
			const actions = [...aggregated.values()];
			if (actions.length === 0) {
				return {
					content: [{ type: "text", text: `No code actions available.${failureText(failures)}` }],
					details: { count: 0, preferredCount: 0 },
				};
			}
			const preferredCount = actions.filter((action) => action.preferred).length;
			const attribute = collection.matchedServerCount > 1;
			const lines: string[] = [];
			for (const [index, action] of actions.slice(0, MAX_ACTIONS).entries()) {
				const provider = attribute ? `[${action.serverIds.join(", ")}] ` : "";
				if (isCodeAction(action.item)) {
					const kind = action.item.kind ? ` [${action.item.kind}]` : "";
					const preferred = action.preferred ? " preferred" : "";
					lines.push(`${index + 1}. ${provider}${action.item.title}${kind}${preferred}`);
					const preview = collectWorkspaceEditPreview(state, action.route, action.item.edit);
					for (const line of preview.lines.slice(0, 8)) lines.push(`   ${line}`);
					if (preview.truncated) lines.push("   [edit preview truncated]");
				} else {
					lines.push(`${index + 1}. ${provider}${action.item.title} [command-only: ${action.item.command}]`);
				}
			}
			if (actions.length > MAX_ACTIONS) lines.push(`[Showing ${MAX_ACTIONS} of ${actions.length} actions.]`);
			return {
				content: [
					{
						type: "text",
						text: `${actions.length} code action(s). No changes were applied.\n\n${lines.join("\n")}${failureText(failures)}`,
					},
				],
				details: { count: actions.length, preferredCount },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("lsp_code_actions"))} ${theme.fg("accent", `${args.path}:${args.line}:${args.character}`)}`,
				0,
				0,
			);
		},
	};
}
