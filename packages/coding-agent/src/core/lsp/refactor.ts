import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Text } from "@fleetagent/pi-tui";
import { type Static, Type } from "typebox";
import type { CodeAction, Command, Diagnostic, TextEdit, WorkspaceEdit } from "vscode-languageserver-protocol";
import type { ToolDefinition } from "../extensions/types.ts";
import type { LspRuntimeState } from "./integration.ts";

const MAX_ACTIONS = 40;
const MAX_EDIT_LINES = 80;

const positionFields = {
	path: Type.String({ description: "File path" }),
	line: Type.Number({ description: "Line number, 1-indexed" }),
	character: Type.Number({ description: "Column number, 1-indexed" }),
};

const renameSchema = Type.Object({
	...positionFields,
	newName: Type.String({ description: "New name for the symbol" }),
});

const codeActionsSchema = Type.Object({
	...positionFields,
	endLine: Type.Optional(Type.Number({ description: "End line for a range selection, 1-indexed. Defaults to line." })),
	endCharacter: Type.Optional(
		Type.Number({ description: "End column for a range selection, 1-indexed. Defaults to character." }),
	),
	kind: Type.Optional(Type.String({ description: "Optional action kind filter, e.g. quickfix, refactor, source." })),
});

type RenameInput = Static<typeof renameSchema>;
type CodeActionsInput = Static<typeof codeActionsSchema>;

export interface LspRenameDetails {
	fileCount: number;
	editCount: number;
	truncated?: boolean;
}

export interface LspCodeActionsDetails {
	count: number;
	preferredCount: number;
}

type CodeActionResponse = (CodeAction | Command)[] | null;

type TextDocumentEditLike = {
	textDocument: { uri: string };
	edits: TextEdit[];
};

function toPosition(input: { line: number; character: number }): { line: number; character: number } {
	return { line: input.line - 1, character: input.character - 1 };
}

function uriToAbsolutePath(uri: string): string {
	try {
		return uri.startsWith("file://") ? fileURLToPath(uri) : uri;
	} catch {
		return uri;
	}
}

function relativeUriPath(state: LspRuntimeState, uri: string): string {
	return relative(state.manager.cwd, uriToAbsolutePath(uri));
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

function collectWorkspaceEditLines(
	state: LspRuntimeState,
	edit: WorkspaceEdit | undefined,
): { lines: string[]; fileCount: number; editCount: number; truncated: boolean } {
	if (!edit) return { lines: [], fileCount: 0, editCount: 0, truncated: false };
	const lines: string[] = [];
	let fileCount = 0;
	let editCount = 0;

	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if (!isTextDocumentEditLike(change)) continue;
			fileCount++;
			lines.push(`${relativeUriPath(state, change.textDocument.uri)}:`);
			for (const textEdit of change.edits) {
				editCount++;
				lines.push(`  ${formatTextEdit(textEdit)}`);
			}
		}
	}

	if (edit.changes) {
		for (const [uri, edits] of Object.entries(edit.changes)) {
			fileCount++;
			lines.push(`${relativeUriPath(state, uri)}:`);
			for (const textEdit of edits) {
				editCount++;
				lines.push(`  ${formatTextEdit(textEdit)}`);
			}
		}
	}

	const shown = lines.slice(0, MAX_EDIT_LINES);
	return { lines: shown, fileCount, editCount, truncated: shown.length < lines.length };
}

function isCodeAction(item: CodeAction | Command): item is CodeAction {
	return "kind" in item || "edit" in item || "diagnostics" in item || "isPreferred" in item;
}

function rangeContainsPosition(
	range: { start: { line: number; character: number }; end: { line: number; character: number } },
	line: number,
	character: number,
): boolean {
	if (line < range.start.line || line > range.end.line) return false;
	if (line === range.start.line && character < range.start.character) return false;
	if (line === range.end.line && character > range.end.character) return false;
	return true;
}

async function getClientAndSync(
	state: LspRuntimeState,
	input: { path: string },
	ctx: Parameters<ToolDefinition["execute"]>[4],
) {
	const client = await state.manager.getClientForFile(input.path);
	if (!client) return undefined;
	await state.fileSync.handleFileRead(input.path, ctx.toolOperations).catch(() => undefined);
	return client;
}

export function createLspRenameTool(
	getState: () => LspRuntimeState,
): ToolDefinition<typeof renameSchema, LspRenameDetails> {
	return {
		name: "lsp_rename",
		label: "lsp_rename",
		description:
			"Preview a symbol rename at a file position. Returns planned edits across files but does not apply changes. Line and character are 1-indexed.",
		promptSnippet: "Preview a symbol rename via LSP without applying changes",
		promptGuidelines: ["lsp_rename is preview-only. Apply reviewed changes with read/edit using hashline anchors."],
		parameters: renameSchema,
		async execute(_toolCallId, input: RenameInput, _signal, _onUpdate, ctx) {
			const state = getState();
			const client = await getClientAndSync(state, input, ctx);
			if (!client) {
				return {
					content: [{ type: "text", text: state.manager.getUnavailableReason(input.path) }],
					details: { fileCount: 0, editCount: 0 },
				};
			}

			const result = await client.sendRequest<WorkspaceEdit | null>("textDocument/rename", {
				textDocument: { uri: state.manager.getFileUri(input.path) },
				position: toPosition(input),
				newName: input.newName,
			});
			const preview = collectWorkspaceEditLines(state, result ?? undefined);
			if (preview.editCount === 0) {
				return {
					content: [{ type: "text", text: "Rename preview: no edits. No changes were applied." }],
					details: { fileCount: 0, editCount: 0 },
				};
			}
			const suffix = preview.truncated ? `\n[Showing ${preview.lines.length} edit preview lines.]` : "";
			return {
				content: [
					{
						type: "text",
						text: `Rename preview for ${JSON.stringify(input.newName)}: ${preview.editCount} edit(s) across ${preview.fileCount} file(s). No changes were applied.\n\n${preview.lines.join("\n")}${suffix}`,
					},
				],
				details: {
					fileCount: preview.fileCount,
					editCount: preview.editCount,
					...(preview.truncated ? { truncated: true } : {}),
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
): ToolDefinition<typeof codeActionsSchema, LspCodeActionsDetails> {
	return {
		name: "lsp_code_actions",
		label: "lsp_code_actions",
		description:
			"List available LSP code actions at a position or range. Returns action titles and edit previews where available; does not apply changes.",
		promptSnippet: "List quick fixes and refactorings available from LSP",
		promptGuidelines: [
			"lsp_code_actions is preview-only. Apply reviewed edits with read/edit using hashline anchors.",
		],
		parameters: codeActionsSchema,
		async execute(_toolCallId, input: CodeActionsInput, _signal, _onUpdate, ctx) {
			const state = getState();
			const client = await getClientAndSync(state, input, ctx);
			if (!client) {
				return {
					content: [{ type: "text", text: state.manager.getUnavailableReason(input.path) }],
					details: { count: 0, preferredCount: 0 },
				};
			}

			const start = toPosition(input);
			const end = {
				line: (input.endLine ?? input.line) - 1,
				character: (input.endCharacter ?? input.character) - 1,
			};
			const uri = state.manager.getFileUri(input.path);
			const diagnostics = client
				.getDiagnostics(uri)
				.filter((diagnostic: Diagnostic) => rangeContainsPosition(diagnostic.range, start.line, start.character));
			const response = await client.sendRequest<CodeActionResponse>("textDocument/codeAction", {
				textDocument: { uri },
				range: { start, end },
				context: { diagnostics, only: input.kind ? [input.kind] : undefined },
			});

			const items = response ?? [];
			if (items.length === 0) {
				return {
					content: [{ type: "text", text: "No code actions available." }],
					details: { count: 0, preferredCount: 0 },
				};
			}

			let preferredCount = 0;
			const lines: string[] = [];
			for (const [index, item] of items.slice(0, MAX_ACTIONS).entries()) {
				if (isCodeAction(item)) {
					if (item.isPreferred) preferredCount++;
					const kind = item.kind ? ` [${item.kind}]` : "";
					const preferred = item.isPreferred ? " preferred" : "";
					lines.push(`${index + 1}. ${item.title}${kind}${preferred}`);
					const preview = collectWorkspaceEditLines(state, item.edit);
					for (const line of preview.lines.slice(0, 8)) lines.push(`   ${line}`);
					if (preview.truncated) lines.push("   [edit preview truncated]");
				} else {
					lines.push(`${index + 1}. ${item.title} [command-only: ${item.command}]`);
				}
			}
			if (items.length > MAX_ACTIONS) lines.push(`[Showing ${MAX_ACTIONS} of ${items.length} actions.]`);

			return {
				content: [
					{
						type: "text",
						text: `${items.length} code action(s). No changes were applied.\n\n${lines.join("\n")}`,
					},
				],
				details: { count: items.length, preferredCount },
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
