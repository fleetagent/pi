import { Text } from "@fleetagent/pi-tui";
import { type Static, Type } from "typebox";
import { type Diagnostic, DiagnosticSeverity } from "vscode-languageserver-protocol";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { AgentToolResult, ToolDefinition } from "../extensions/types.ts";
import type { ToolOperations } from "../tools/operations.ts";
import { throwIfAborted } from "./abort.ts";
import type { LspRuntimeState } from "./integration.ts";
import type { LspClientRoute, LspClientRouteFailure } from "./manager.ts";
import { relativePortablePath } from "./portable-path.ts";

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
	unavailable?: true;
}

interface DiagnosticEntry {
	filePath: string;
	diagnostic: Diagnostic;
	sources: string[];
	identity: string;
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

function diagnosticLine(entry: DiagnosticEntry, attribute: boolean): string {
	const line = entry.diagnostic.range.start.line + 1;
	const column = entry.diagnostic.range.start.character + 1;
	const severity = diagnosticSeverityName(entry.diagnostic.severity);
	const code = entry.diagnostic.code === undefined ? "" : ` (${String(entry.diagnostic.code)})`;
	const source = entry.diagnostic.source ? ` [${entry.diagnostic.source}]` : "";
	const providers = attribute ? ` {LSP: ${entry.sources.join(", ")}}` : "";
	return `${entry.filePath}:${line}:${column} ${severity}: ${entry.diagnostic.message}${code}${source}${providers}`;
}

function createDiagnosticEntry(
	route: LspClientRoute,
	filePath: string,
	diagnostic: Diagnostic,
	source: string,
): DiagnosticEntry {
	const relatedInformation = diagnostic.relatedInformation?.map((information) => {
		const mapped = route.target.mapper.serverUriToAgentPath(information.location.uri);
		return {
			message: information.message,
			location: {
				uri: mapped.ok ? mapped.value : `[unmapped URI: ${mapped.reason}]`,
				range: information.location.range,
			},
		};
	});
	const identity = JSON.stringify({
		filePath,
		range: diagnostic.range,
		severity: diagnostic.severity,
		code: diagnostic.code,
		codeDescription: diagnostic.codeDescription,
		source: diagnostic.source,
		message: diagnostic.message,
		tags: diagnostic.tags,
		relatedInformation,
		data: diagnostic.data,
	});
	return { filePath, diagnostic, sources: [source], identity };
}

function mergeDiagnosticEntries(entries: readonly DiagnosticEntry[]): DiagnosticEntry[] {
	const merged = new Map<string, DiagnosticEntry>();
	for (const entry of entries) {
		const key = entry.identity;
		const existing = merged.get(key);
		if (existing) {
			for (const source of entry.sources) {
				if (!existing.sources.includes(source)) existing.sources.push(source);
			}
		} else {
			merged.set(key, { ...entry, sources: [...entry.sources] });
		}
	}
	return [...merged.values()];
}

function summarizeDiagnostics(entries: readonly DiagnosticEntry[]): LspDiagnosticsDetails {
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

function formatDiagnosticEntries(entries: DiagnosticEntry[], attribute: boolean): FormattedDiagnostics {
	const details = summarizeDiagnostics(entries);
	if (entries.length === 0) return { text: "No diagnostics.", details };
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
		text: `${summary}\n\n${entries.map((entry) => diagnosticLine(entry, attribute)).join("\n")}`,
		details,
	};
}

function failureText(failures: readonly LspClientRouteFailure[]): string {
	const unique = [
		...new Map(failures.map((failure) => [`${failure.serverId}\u0000${failure.reason}`, failure])).values(),
	];
	return unique.length === 0
		? ""
		: `\n\nUnavailable or unsupported servers:\n${unique.map((failure) => `- ${failure.serverId}: ${failure.reason}`).join("\n")}`;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	await new Promise<void>((resolve, reject) => {
		const onAbort = (): void => {
			clearTimeout(timer);
			try {
				throwIfAborted(signal);
			} catch (error) {
				reject(error);
			}
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function cachedWorkspaceDiagnostics(state: LspRuntimeState): AgentToolResult<LspDiagnosticsDetails> {
	const routes = state.manager
		.getRunningClients()
		.filter((route) => route.target.server.features?.diagnostics !== false);
	if (routes.length === 0) {
		return {
			content: [{ type: "text", text: "No capable running LSP server is available for cached diagnostics." }],
			details: { count: 0, errors: 0, warnings: 0, files: 0, unavailable: true },
		};
	}
	const formatted = formatWorkspaceDiagnostics(state, routes);
	return { content: [{ type: "text", text: formatted.text }], details: formatted.details };
}

function renderCompactDiagnosticsResult(details: LspDiagnosticsDetails, theme: Theme): Text {
	if (details.count === 0) {
		return new Text(
			theme.fg(
				details.unavailable ? "error" : "success",
				details.unavailable ? "LSP unavailable" : "No diagnostics",
			),
			0,
			0,
		);
	}
	const parts = [`${details.count} diagnostic(s)`];
	if (details.errors > 0) parts.push(`${details.errors} error(s)`);
	if (details.warnings > 0) parts.push(`${details.warnings} warning(s)`);
	return new Text(theme.fg(details.errors > 0 ? "error" : "warning", parts.join(", ")), 0, 0);
}

export function createLspDiagnosticsTool(
	getState: () => LspRuntimeState,
	getOperations?: () => ToolOperations,
): ToolDefinition<typeof diagnosticsSchema, LspDiagnosticsDetails> {
	return {
		name: "lsp_diagnostics",
		label: "lsp_diagnostics",
		description:
			"Get diagnostics from all matching configured LSP servers for a file. Identical diagnostics are deduplicated and distinct providers are attributed. Use '*' for cached diagnostics from running instances.",
		promptSnippet: "Get diagnostics for a source file from configured language servers",
		promptGuidelines: [
			"Use lsp_diagnostics after code edits when a matching language server is available.",
			"Use path='*' only to inspect cached diagnostics from already-running LSP servers.",
		],
		parameters: diagnosticsSchema,
		async execute(_toolCallId, params: DiagnosticsInput, signal, _onUpdate, ctx) {
			throwIfAborted(signal);
			const state = getState();
			const operations = getOperations?.() ?? ctx.toolOperations;
			await state.manager.setToolOperations(operations, signal);
			if (params.path === "*") return cachedWorkspaceDiagnostics(state);
			let collection = await state.manager.getClientRoutesForFeature(params.path, "diagnostics", signal);
			if (collection.routes.length === 0) {
				const message =
					collection.matchedServerCount === 0
						? await state.manager.getUnavailableReason(params.path, signal)
						: `No capable LSP server is available for diagnostics.${failureText(collection.failures)}`;
				return {
					content: [{ type: "text", text: message }],
					details: { count: 0, errors: 0, warnings: 0, files: 0, unavailable: true },
				};
			}
			const synchronization = await state.fileSync.synchronizeFileRead(params.path, operations, signal);
			if (synchronization.lifecycleCancelled) {
				collection = {
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
			if (synchronization.failures.length > 0) {
				const failedInstances = new Set(synchronization.failures.map((failure) => failure.instanceKey));
				collection = {
					...collection,
					routes: collection.routes.filter((route) => !failedInstances.has(route.target.instanceKey)),
					failures: [
						...collection.failures,
						...synchronization.failures.map((failure) => ({
							serverId: failure.serverId,
							reason: failure.reason,
						})),
					],
				};
			}
			if (collection.routes.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No capable LSP server is available for diagnostics.${failureText(collection.failures)}`,
						},
					],
					details: { count: 0, errors: 0, warnings: 0, files: 0, unavailable: true },
				};
			}
			await delay(DIAGNOSTICS_SETTLE_DELAY_MS, signal);
			const relativePath = relativePortablePath(state.manager.cwd, state.manager.resolvePath(params.path));
			const entries = mergeDiagnosticEntries(
				collection.routes.flatMap((route) =>
					route.client
						.getDiagnostics(route.target.serverUri)
						.map((diagnostic) => createDiagnosticEntry(route, relativePath, diagnostic, route.target.serverId)),
				),
			).sort(compareDiagnostics);
			const formatted = formatDiagnosticEntries(entries, collection.matchedServerCount > 1);
			return {
				content: [{ type: "text", text: `${formatted.text}${failureText(collection.failures)}` }],
				details: formatted.details,
			};
		},
		renderCall(args, theme) {
			const path = args.path === "*" ? "cached workspace" : args.path;
			return new Text(`${theme.fg("toolTitle", theme.bold("lsp_diagnostics"))} ${theme.fg("accent", path)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details;
			if (expanded) {
				const output = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
				return new Text(theme.fg(details.unavailable ? "error" : "toolOutput", output), 0, 0);
			}
			return renderCompactDiagnosticsResult(details, theme);
		},
	};
}

export async function formatAutoDiagnosticsForChangedFile(
	state: LspRuntimeState,
	filePath: string,
): Promise<string | undefined> {
	const targets = (await state.manager.resolveTargets(filePath)).targets;
	const routes = targets.flatMap((target) => {
		if (target.server.features?.diagnostics === false) return [];
		const client = state.manager.getRunningClient(target.instanceKey);
		return client ? [{ client, target }] : [];
	});
	if (routes.length === 0) return undefined;
	await delay(DIAGNOSTICS_SETTLE_DELAY_MS);
	const relativePath = relativePortablePath(state.manager.cwd, state.manager.resolvePath(filePath));
	const errors = mergeDiagnosticEntries(
		routes.flatMap((route) =>
			route.client
				.getDiagnostics(route.target.serverUri)
				.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error)
				.map((diagnostic) => createDiagnosticEntry(route, relativePath, diagnostic, route.target.serverId)),
		),
	).sort(compareDiagnostics);
	if (errors.length === 0) return undefined;
	const shown = errors.slice(0, AUTO_DIAGNOSTICS_MAX_ERRORS);
	const lines = shown.map((entry) => diagnosticLine(entry, routes.length > 1));
	if (errors.length > shown.length) lines.push(`... and ${errors.length - shown.length} more error(s)`);
	return `LSP: ${errors.length} error(s) in ${relativePath}:\n${lines.join("\n")}`;
}

function formatWorkspaceDiagnostics(state: LspRuntimeState, routes: readonly LspClientRoute[]): FormattedDiagnostics {
	const entries: DiagnosticEntry[] = [];
	for (const route of routes) {
		if (route.target.server.features?.diagnostics === false) continue;
		const identity = `server=${route.target.serverId} root=${route.target.workspaceRoot}`;
		for (const [uri, diagnostics] of route.client.getAllDiagnostics()) {
			const mapped = route.target.mapper.serverUriToAgentPath(uri);
			const filePath = mapped.ok
				? relativePortablePath(state.manager.cwd, mapped.value)
				: `[unmapped URI: ${mapped.reason}]`;
			for (const diagnostic of diagnostics)
				entries.push(createDiagnosticEntry(route, filePath, diagnostic, identity));
		}
	}
	return formatDiagnosticEntries(mergeDiagnosticEntries(entries).sort(compareDiagnostics), true);
}

function compareDiagnostics(left: DiagnosticEntry, right: DiagnosticEntry): number {
	const severity = (left.diagnostic.severity ?? 99) - (right.diagnostic.severity ?? 99);
	if (severity !== 0) return severity;
	const path = left.filePath.localeCompare(right.filePath);
	if (path !== 0) return path;
	const line = left.diagnostic.range.start.line - right.diagnostic.range.start.line;
	if (line !== 0) return line;
	const character = left.diagnostic.range.start.character - right.diagnostic.range.start.character;
	if (character !== 0) return character;
	return left.diagnostic.message.localeCompare(right.diagnostic.message);
}
