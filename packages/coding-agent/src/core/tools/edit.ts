import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@fleetagent/pi-agent-core";
import { Text } from "@fleetagent/pi-tui";
import { createTwoFilesPatch } from "diff";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { applyEdits, fmtBoundaryWarning, type HTEdit, initHasher, lineHashes, resEdits } from "./hashline/index.ts";
import type { ToolBackendInfo, ToolOperations } from "./operations.ts";
import { resolveToCwd } from "./path-utils.ts";
import { formatBackendIcon, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { detectEnding, genDiff, restoreEndings, stripBOM, toLF } from "./replace-diff.ts";
import { normReq } from "./replace-normalize.ts";
import { fmtCall, getPreviewInput, type RPreview, type RRState } from "./replace-render.ts";
import { abortIf } from "./runtime.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const contentLinesSchema = Type.Array(Type.String(), {
	description:
		"Literal replacement content, one string per line. Use [] to delete the range. Do not include HASH│ prefixes from read output.",
});

const hashRangeInclusiveSchema = Type.Tuple(
	[
		Type.String({ description: "Start 3-character hash anchor from read output" }),
		Type.String({ description: "End 3-character hash anchor from read output" }),
	],
	{ description: "Inclusive hash range to replace [start_hash, end_hash]. Use hash anchors only." },
);

const editItemSchema = Type.Object(
	{
		hash_range_inclusive: hashRangeInclusiveSchema,
		content_lines: contentLinesSchema,
	},
	{ additionalProperties: false },
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		changes: Type.Array(editItemSchema, {
			description: "One or more hash-anchored replacements. All anchors must come from the same read snapshot.",
		}),
	},
	{ additionalProperties: false },
);

export type EditToolInput = Static<typeof editSchema>;

export type ReqParams = {
	path: string;
	changes: HTEdit[];
};

export type RMetrics = {
	edits_attempted: number;
	edits_noop: number;
	warnings: number;
	classification: "applied" | "noop";
	changed_lines?: { first: number; last: number };
	added_lines?: number;
	removed_lines?: number;
};

export interface ReplaceDetails {
	diff: string;
	patch: string;
	firstChangedLine?: number;
	classification?: "noop";
	metrics?: RMetrics;
}

export type EditToolDetails = ReplaceDetails;

export interface EditToolOptions {}

type EditRenderState = RRState;

type RenderableEditArgs = {
	path?: string;
	file_path?: string;
	changes?: HTEdit[];
	edits?: HTEdit[];
	hash_range_inclusive?: [string, string];
	content_lines?: string[];
};

function countDiffLines(diff: string, marker: "+" | "-"): number {
	let count = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith(marker) && !line.startsWith(`${marker}${marker}${marker}`)) {
			count++;
		}
	}
	return count;
}

function hashStoreKey(operations: ToolOperations, absolutePath: string): string {
	const backend = operations.getBackendInfo?.();
	if (!backend) return absolutePath;
	if (backend.type === "ssh") return `ssh:${backend.remote}:${absolutePath}`;
	if (backend.type === "remote" && backend.configured) return `remote:${backend.url}:${absolutePath}`;
	return absolutePath;
}

function formatEditCall(
	args: RenderableEditArgs | undefined,
	theme: Theme,
	backendInfo: ToolBackendInfo | undefined,
): string {
	const previewInput = getPreviewInput(args);
	if (previewInput) {
		return formatBackendIcon(backendInfo, theme) + fmtCall(previewInput, {}, false, theme).replace("replace", "edit");
	}
	const invalidArg = invalidArgText(theme);
	const rawPath = str(args?.file_path ?? args?.path);
	const path = rawPath !== null ? shortenPath(rawPath) : null;
	const pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
	return `${formatBackendIcon(backendInfo, theme)}${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
}

async function computePreview(request: ReqParams, operations: ToolOperations): Promise<RPreview> {
	try {
		await initHasher();
		const absolutePath = resolveToCwd(request.path, operations.cwd);
		await operations.access(absolutePath, "read");
		const rawContent = (await operations.readFile(absolutePath)).toString("utf-8");
		const { text } = stripBOM(rawContent);
		const originalNormalized = toLF(text);
		const originalHashes = await lineHashes(originalNormalized, hashStoreKey(operations, absolutePath));
		const result = applyEdits(
			originalNormalized,
			resEdits(request.changes),
			undefined,
			originalHashes,
			request.path,
		).content;
		if (originalNormalized === result) {
			return { error: `No changes made to ${request.path}. The edits produced identical content.` };
		}
		const resultHashes = await lineHashes(result);
		return { diff: genDiff(originalNormalized, result, 4, resultHashes, originalHashes).diff };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function normalizeEditArguments(input: unknown): EditToolInput {
	return normReq(input) as EditToolInput;
}

function assertReq(request: unknown): asserts request is ReqParams {
	if (!request || typeof request !== "object" || Array.isArray(request)) {
		throw new Error("[E_BAD_SHAPE] Edit request must be an object.");
	}
	const record = request as Record<string, unknown>;
	for (const legacyKey of ["oldText", "newText", "old_text", "new_text", "old_range", "start", "end", "lines"]) {
		if (Object.hasOwn(record, legacyKey)) {
			throw new Error(
				`[E_LEGACY_SHAPE] "${legacyKey}" is not supported. Call read first, then use {hash_range_inclusive: ["<START>", "<END>"], content_lines: [...]}.`,
			);
		}
	}
	const unknown = Object.keys(record).filter((key) => key !== "path" && key !== "changes");
	if (unknown.length > 0) {
		throw new Error(`[E_BAD_SHAPE] Edit request contains unknown or unsupported fields: ${unknown.join(", ")}.`);
	}
	if (typeof record.path !== "string" || record.path.length === 0) {
		throw new Error('[E_BAD_SHAPE] Edit request requires a non-empty "path" string.');
	}
	if (!Array.isArray(record.changes) || record.changes.length === 0) {
		throw new Error('[E_BAD_SHAPE] Edit request requires a non-empty "changes" array.');
	}
}

export function createEditToolDefinition(
	operations: ToolOperations,
	_options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a file using hash-anchored line replacements. Call read first; it returns HASH│content lines. Use hash_range_inclusive with the 3-character start/end hashes and content_lines with literal replacement lines only.",
		promptSnippet: "Edit files using hashline anchors from read output",
		promptGuidelines: [
			"Use read before edit to get HASH│content anchors.",
			"Use edit with changes: [{ hash_range_inclusive: [startHash, endHash], content_lines: [...] }].",
			"hash_range_inclusive contains only the 3-character hashes, not line numbers and not HASH│content.",
			"content_lines contains literal file content only; do not include HASH│ prefixes. Use [] to delete a range.",
			"After a successful edit, call read again before follow-up edits unless the response includes current warning anchors.",
		],
		parameters: editSchema,
		renderShell: "default",
		prepareArguments: normalizeEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal) {
			const normalized = normReq(input);
			assertReq(normalized);
			const path = normalized.path;
			const absolutePath = resolveToCwd(path, operations.cwd);
			return withFileMutationQueue(absolutePath, async () => {
				abortIf(signal);
				await initHasher();
				try {
					await operations.access(absolutePath, "readwrite");
				} catch (error) {
					const message =
						error instanceof Error && "code" in error ? `Error code: ${String(error.code)}` : String(error);
					throw new Error(`Could not edit file: ${path}. ${message}.`);
				}
				const rawContent = (await operations.readFile(absolutePath)).toString("utf-8");
				const { bom, text } = stripBOM(rawContent);
				const originalEnding = detectEnding(text);
				const originalNormalized = toLF(text);
				const storeKey = hashStoreKey(operations, absolutePath);
				const originalHashes = await lineHashes(originalNormalized, storeKey);
				const resolved = resEdits(normalized.changes);
				const anchorResult = applyEdits(originalNormalized, resolved, signal, originalHashes, path);
				const result = anchorResult.content;

				const removedHashes = new Set<string>();
				for (const edit of resolved) {
					const startLine = originalHashes.indexOf(edit.hash_range_inclusive[0].hash);
					const endLine = originalHashes.indexOf(edit.hash_range_inclusive[1].hash);
					if (startLine >= 0 && endLine >= 0) {
						for (let i = startLine; i <= endLine; i++) {
							const hash = originalHashes[i];
							if (hash) removedHashes.add(hash);
						}
					}
				}
				const resultHashes = await lineHashes(result, storeKey, {
					content: originalNormalized,
					hashes: originalHashes,
					removedHashes,
				});
				const warnings = [...(anchorResult.warnings ?? [])];
				const resultLines = result.split("\n");
				for (const warning of anchorResult.boundaryWarnings ?? []) {
					let seen = 0;
					let matchIndex = -1;
					for (let i = 0; i < resultLines.length; i++) {
						if (resultLines[i] === warning.survivingLineContent) {
							if (seen === warning.occurrence) {
								matchIndex = i;
								break;
							}
							seen++;
						}
					}
					if (matchIndex >= 0) {
						warnings.push(
							fmtBoundaryWarning({
								kind: warning.kind,
								survivingContent: warning.survivingLineContent,
								matchIndex,
								resultLines,
								resultHashes,
							}),
						);
					}
				}

				if (originalNormalized === result) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No changes made to ${path}. The edits produced identical content.`,
							},
						],
						details: {
							diff: "",
							patch: "",
							classification: "noop" as const,
							metrics: {
								edits_attempted: normalized.changes.length,
								edits_noop: anchorResult.noopEdits?.length ?? 0,
								warnings: warnings.length,
								classification: "noop" as const,
							},
						},
					};
				}

				abortIf(signal);
				await operations.writeFile(absolutePath, bom + restoreEndings(result, originalEnding));
				const diffResult = genDiff(originalNormalized, result, 2, resultHashes, originalHashes);
				const warningBlock = warnings.length > 0 ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
				return {
					content: [{ type: "text" as const, text: `Successfully replaced in ${path}.${warningBlock}` }],
					details: {
						diff: diffResult.diff,
						patch: createTwoFilesPatch(path, path, originalNormalized, result),
						firstChangedLine: anchorResult.firstChangedLine ?? diffResult.firstChangedLine,
						metrics: {
							edits_attempted: normalized.changes.length,
							edits_noop: anchorResult.noopEdits?.length ?? 0,
							warnings: warnings.length,
							classification: "applied" as const,
							...(anchorResult.firstChangedLine !== undefined && anchorResult.lastChangedLine !== undefined
								? {
										changed_lines: {
											first: anchorResult.firstChangedLine,
											last: anchorResult.lastChangedLine,
										},
									}
								: {}),
							added_lines: countDiffLines(diffResult.diff, "+"),
							removed_lines: countDiffLines(diffResult.diff, "-"),
						},
					},
				};
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const previewInput = getPreviewInput(args);
			if (!context.executionStarted && context.argsComplete && previewInput) {
				const argsKey = JSON.stringify(previewInput);
				if (context.state.argsKey !== argsKey) {
					context.state.argsKey = argsKey;
					context.state.preview = undefined;
					const generation = (context.state.previewGeneration ?? 0) + 1;
					context.state.previewGeneration = generation;
					void computePreview(previewInput, operations).then((preview) => {
						if (context.state.argsKey === argsKey && context.state.previewGeneration === generation) {
							context.state.preview = preview;
							context.invalidate();
						}
					});
				}
				text.setText(
					formatBackendIcon(operations.getBackendInfo?.(), theme) +
						fmtCall(previewInput, context.state, context.expanded, theme).replace("replace", "edit"),
				);
				return text;
			}
			text.setText(formatEditCall(args as RenderableEditArgs | undefined, theme, operations.getBackendInfo?.()));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (context.isError) {
				const errorText = result.content
					?.filter((entry) => entry.type === "text")
					.map((entry) => entry.text ?? "")
					.join("\n");
				text.setText(errorText ? `\n${theme.fg("error", errorText)}` : "");
				return text;
			}
			const diff = result.details?.diff;
			if (!diff) {
				text.setText("");
				return text;
			}
			const lines = diff.split("\n").map((line) => {
				if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("success", line);
				if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("error", line);
				return theme.fg("dim", line);
			});
			text.setText(`\n${lines.join("\n")}`);
			return text;
		},
	};
}

type CompatibleEditAgentTool = AgentTool<typeof editSchema, EditToolDetails> & {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<EditToolDetails>,
	) => Promise<AgentToolResult<EditToolDetails>>;
};

export function createEditTool(operations: ToolOperations, options?: EditToolOptions): CompatibleEditAgentTool {
	return wrapToolDefinition(createEditToolDefinition(operations, options)) as CompatibleEditAgentTool;
}
