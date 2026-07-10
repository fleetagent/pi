import { relative } from "node:path";
import { Text } from "@fleetagent/pi-tui";
import { type Static, Type } from "typebox";
import { type Diagnostic, DiagnosticSeverity } from "vscode-languageserver-protocol";
import type { ToolDefinition } from "../extensions/types.ts";
import type { LspRuntimeState } from "./integration.ts";

const DIAGNOSTICS_SETTLE_DELAY_MS = 250;
const AUTO_DIAGNOSTICS_MAX_ERRORS = 10;

const diagnosticsSchema = Type.Object({
	path: Type.String({
		description: "File path to get diagnostics for. Use '*' for cached diagnostics from running servers.",
	}),
});

type DiagnosticsInput = Static<typeof diagnosticsSchema>;

export interface LspDiagnosticsDetails {
	count: number;
	errors: number;
	warnings: number;
	files: number;
}

interface FormattedDiagnostics {
	text: string;
	details: LspDiagnosticsDetails;
}

function diagnosticSeverityName(severity: number | undefined): string {
	switch (severity) {
		case DiagnosticSeverity.Error:
			return "error";
		case DiagnosticSeverity.Warning:
			return "warning";
		case DiagnosticSeverity.Information:
			return "info";
		case DiagnosticSeverity.Hint:
			return "hint";
		default:
			return "unknown";
	}
}

function diagnosticLine(filePath: string, diagnostic: Diagnostic): string {
	const line = diagnostic.range.start.line + 1;
	const column = diagnostic.range.start.character + 1;
	const severity = diagnosticSeverityName(diagnostic.severity);
	const code = diagnostic.code === undefined ? "" : ` (${String(diagnostic.code)})`;
	const source = diagnostic.source ? ` [${diagnostic.source}]` : "";
	return `${filePath}:${line}:${column} ${severity}: ${diagnostic.message}${code}${source}`;
}

function summarizeDiagnostics(entries: Array<{ filePath: string; diagnostic: Diagnostic }>): LspDiagnosticsDetails {
	let errors = 0;
	let warnings = 0;
	for (const entry of entries) {
		if (entry.diagnostic.severity === DiagnosticSeverity.Error) errors++;
		else if (entry.diagnostic.severity === DiagnosticSeverity.Warning) warnings++;
	}
	return {
		count: entries.length,
		errors,
		warnings,
		files: new Set(entries.map((entry) => entry.filePath)).size,
	};
}

function formatDiagnosticEntries(entries: Array<{ filePath: string; diagnostic: Diagnostic }>): FormattedDiagnostics {
	const details = summarizeDiagnostics(entries);
	if (entries.length === 0) {
		return { text: "No diagnostics.", details };
	}
	const other = entries.length - details.errors - details.warnings;
	const summary = [
		`${entries.length} diagnostic(s)`,
		details.errors > 0 ? `${details.errors} error(s)` : undefined,
		details.warnings > 0 ? `${details.warnings} warning(s)` : undefined,
		other > 0 ? `${other} other` : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(", ");
	return {
		text: `${summary}\n\n${entries.map((entry) => diagnosticLine(entry.filePath, entry.diagnostic)).join("\n")}`,
		details,
	};
}

function uriToPath(uri: string): string {
	if (uri.startsWith("file://")) {
		return new URL(uri).pathname;
	}
	return uri;
}

async function delay(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

export function createLspDiagnosticsTool(
	getState: () => LspRuntimeState,
): ToolDefinition<typeof diagnosticsSchema, LspDiagnosticsDetails> {
	return {
		name: "lsp_diagnostics",
		label: "lsp_diagnostics",
		description:
			"Get compiler and language-server diagnostics for a file. Calling this on a TypeScript/JavaScript file lazily starts the configured LSP server.",
		promptSnippet: "Get compiler and language-server diagnostics for a source file",
		promptGuidelines: [
			"Use lsp_diagnostics after code edits when an LSP server is available to check for compiler/type errors.",
			"Use path='*' only to inspect cached diagnostics from already-running LSP servers.",
		],
		parameters: diagnosticsSchema,
		async execute(_toolCallId, params: DiagnosticsInput, _signal, _onUpdate, ctx) {
			const state = getState();
			if (params.path === "*") {
				return {
					content: [{ type: "text", text: formatWorkspaceDiagnostics(state).text }],
					details: formatWorkspaceDiagnostics(state).details,
				};
			}

			const client = await state.manager.getClientForFile(params.path);
			if (!client) {
				return {
					content: [{ type: "text", text: state.manager.getUnavailableReason(params.path) }],
					details: { count: 0, errors: 0, warnings: 0, files: 0 },
				};
			}

			await state.fileSync.handleFileRead(params.path, ctx.toolOperations).catch(() => undefined);
			await delay(DIAGNOSTICS_SETTLE_DELAY_MS);
			const uri = state.manager.getFileUri(params.path);
			const relativePath = relative(state.manager.cwd, state.manager.resolvePath(params.path));
			const diagnostics = client
				.getDiagnostics(uri)
				.map((diagnostic) => ({ filePath: relativePath, diagnostic }))
				.sort(compareDiagnostics);
			const formatted = formatDiagnosticEntries(diagnostics);
			return { content: [{ type: "text", text: formatted.text }], details: formatted.details };
		},
		renderCall(args, theme) {
			const path = args.path === "*" ? "cached workspace" : args.path;
			return new Text(`${theme.fg("toolTitle", theme.bold("lsp_diagnostics"))} ${theme.fg("accent", path)}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details;
			if (details.count === 0) return new Text(theme.fg("success", "No diagnostics"), 0, 0);
			const parts = [`${details.count} diagnostic(s)`];
			if (details.errors > 0) parts.push(`${details.errors} error(s)`);
			if (details.warnings > 0) parts.push(`${details.warnings} warning(s)`);
			return new Text(theme.fg(details.errors > 0 ? "error" : "warning", parts.join(", ")), 0, 0);
		},
	};
}

export async function formatAutoDiagnosticsForChangedFile(
	state: LspRuntimeState,
	filePath: string,
): Promise<string | undefined> {
	const languageId = state.manager.getLanguageId(filePath);
	if (!languageId) return undefined;
	const client = state.manager.getRunningClient(languageId);
	if (!client) return undefined;

	await delay(DIAGNOSTICS_SETTLE_DELAY_MS);
	const uri = state.manager.getFileUri(filePath);
	const relativePath = relative(state.manager.cwd, state.manager.resolvePath(filePath));
	const errors = client
		.getDiagnostics(uri)
		.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error)
		.map((diagnostic) => ({ filePath: relativePath, diagnostic }))
		.sort(compareDiagnostics);
	if (errors.length === 0) return undefined;

	const shown = errors.slice(0, AUTO_DIAGNOSTICS_MAX_ERRORS);
	const lines = shown.map((entry) => diagnosticLine(entry.filePath, entry.diagnostic));
	if (errors.length > shown.length) {
		lines.push(`... and ${errors.length - shown.length} more error(s)`);
	}
	return `LSP: ${errors.length} error(s) in ${relativePath}:\n${lines.join("\n")}`;
}

function formatWorkspaceDiagnostics(state: LspRuntimeState): FormattedDiagnostics {
	const entries: Array<{ filePath: string; diagnostic: Diagnostic }> = [];
	for (const status of state.manager.getStatus()) {
		if (!status.running) continue;
		const client = state.manager.getRunningClient(status.languageId);
		if (!client) continue;
		for (const [uri, diagnostics] of client.getAllDiagnostics()) {
			const filePath = relative(state.manager.cwd, uriToPath(uri));
			for (const diagnostic of diagnostics) {
				entries.push({ filePath, diagnostic });
			}
		}
	}
	return formatDiagnosticEntries(entries.sort(compareDiagnostics));
}

function compareDiagnostics(
	left: { filePath: string; diagnostic: Diagnostic },
	right: { filePath: string; diagnostic: Diagnostic },
): number {
	const severity = (left.diagnostic.severity ?? 99) - (right.diagnostic.severity ?? 99);
	if (severity !== 0) return severity;
	const path = left.filePath.localeCompare(right.filePath);
	if (path !== 0) return path;
	const line = left.diagnostic.range.start.line - right.diagnostic.range.start.line;
	if (line !== 0) return line;
	return left.diagnostic.range.start.character - right.diagnostic.range.start.character;
}
