import { Marked, type Token, type Tokens, visibleWidth } from "@fleetagent/pi-tui";
import { type MermaidArt, render, type Span } from "grok-mermaid";
import type { MarkdownTransformContext, MarkdownTransformer } from "../../../core/extensions/types.ts";
import type { MermaidRenderingMode } from "../../../core/settings-manager.ts";
import type { Theme } from "../theme/theme.ts";

export type { MermaidRenderingMode } from "../../../core/settings-manager.ts";

const MAX_MERMAID_SOURCE_LENGTH = 64 * 1024;
const MAX_MERMAID_ROWS = 200;
const MAX_MERMAID_AREA = 50_000;
const MAX_MERMAID_WARNINGS = 512;
const MAX_MERMAID_WARNING_LENGTH = 4096;
const SPAN_CLASSES = new Set<Span["cls"]>(["border", "text", "edge", "edgeLabel", "title", "none"]);
const UNSAFE_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const SGR_PATTERN = /\x1b\[[0-9;]*m/g;

const markdownParser = new Marked();

type MermaidRenderer = (source: string) => unknown;

export interface MermaidTransformerOptions {
	getMode: () => MermaidRenderingMode;
	theme?: Theme;
	/** Override the renderer for deterministic fault-injection tests. */
	renderMermaid?: MermaidRenderer;
}

interface MermaidTransformRuntime {
	context: MarkdownTransformContext;
	options: MermaidTransformerOptions;
	renderMermaid: MermaidRenderer;
}

function isMermaid(token: Token): token is Tokens.Code {
	return token.type === "code" && token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

interface SourceToken {
	token: Token;
	raw: string;
}

interface NormalizedMarkdownSource {
	normalized: string;
	originalOffsets: number[];
}

interface SourceLineEndings {
	lineEnding: string;
	trailingLineEnding: string;
}

function normalizeMarkdownLineEndings(markdown: string): NormalizedMarkdownSource {
	let normalized = "";
	const originalOffsets = [0];
	for (let index = 0; index < markdown.length; ) {
		if (markdown[index] === "\r") {
			normalized += "\n";
			index += markdown[index + 1] === "\n" ? 2 : 1;
		} else {
			normalized += markdown[index];
			index++;
		}
		originalOffsets.push(index);
	}
	return { normalized, originalOffsets };
}

function lexNormalizedSource(
	original: string,
	normalized: string,
	originalOffsets?: number[],
): SourceToken[] | undefined {
	let offset = 0;
	const sourceTokens: SourceToken[] = [];
	for (const token of markdownParser.lexer(normalized)) {
		if (!normalized.startsWith(token.raw, offset)) return undefined;
		const start = offset;
		offset += token.raw.length;
		const raw = originalOffsets ? original.slice(originalOffsets[start], originalOffsets[offset]) : token.raw;
		sourceTokens.push({ token, raw });
	}
	return offset === normalized.length ? sourceTokens : undefined;
}

function lexPreservingSource(markdown: string): SourceToken[] | undefined {
	if (!markdown.includes("\r")) return lexNormalizedSource(markdown, markdown);
	const { normalized, originalOffsets } = normalizeMarkdownLineEndings(markdown);
	return lexNormalizedSource(markdown, normalized, originalOffsets);
}
function codeSpan(line: string): string {
	const content = line || "\u00a0";
	const longestBacktickRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
	const fence = "`".repeat(longestBacktickRun + 1);
	const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return `${fence}${padding}${content}${padding}${fence}`;
}

function sourceLineEndings(raw: string): SourceLineEndings {
	const trailingLineEnding = /(\r\n|\r|\n)$/.exec(raw)?.[1] ?? "";
	return {
		lineEnding: trailingLineEnding || /(\r\n|\r|\n)/.exec(raw)?.[1] || "\n",
		trailingLineEnding,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasSafeText(value: unknown): value is string {
	return typeof value === "string" && !UNSAFE_CONTROL_PATTERN.test(value);
}

function hasSafeWarnings(warnings: unknown[]): warnings is string[] {
	if (warnings.length > MAX_MERMAID_WARNINGS) {
		return false;
	}
	for (let index = 0; index < warnings.length; index++) {
		const warning = warnings[index];
		if (
			!Object.hasOwn(warnings, index) ||
			typeof warning !== "string" ||
			warning.length > MAX_MERMAID_WARNING_LENGTH ||
			!hasSafeText(warning)
		) {
			return false;
		}
	}
	return true;
}

function validateArtRow(plainRow: unknown, styledRow: unknown, artWidth: number): number | undefined {
	if (!hasSafeText(plainRow) || !Array.isArray(styledRow)) return undefined;
	const rowWidth = visibleWidth(plainRow);
	if (!Number.isSafeInteger(rowWidth) || rowWidth > artWidth) return undefined;

	let reconstructed = "";
	for (const span of styledRow) {
		if (
			!isRecord(span) ||
			!hasSafeText(span.text) ||
			typeof span.cls !== "string" ||
			!SPAN_CLASSES.has(span.cls as Span["cls"])
		) {
			return undefined;
		}
		reconstructed += span.text;
	}
	return reconstructed === plainRow ? rowWidth : undefined;
}
function validateArt(value: unknown, availableWidth: number): MermaidArt | undefined {
	if (!Number.isSafeInteger(availableWidth) || availableWidth < 0 || !isRecord(value)) {
		return undefined;
	}
	const { plain, styled, warnings, width } = value;
	if (
		!Number.isSafeInteger(width) ||
		(width as number) < 0 ||
		(width as number) > availableWidth ||
		!Array.isArray(plain) ||
		plain.length === 0 ||
		plain.length > MAX_MERMAID_ROWS ||
		!Array.isArray(styled) ||
		styled.length !== plain.length ||
		!Array.isArray(warnings) ||
		!hasSafeWarnings(warnings) ||
		(width as number) * plain.length > MAX_MERMAID_AREA
	) {
		return undefined;
	}
	const artWidth = width as number;
	let measuredWidth = 0;
	for (let rowIndex = 0; rowIndex < plain.length; rowIndex++) {
		const rowWidth = validateArtRow(plain[rowIndex], styled[rowIndex], artWidth);
		if (rowWidth === undefined) return undefined;
		measuredWidth = Math.max(measuredWidth, rowWidth);
	}
	if (measuredWidth !== artWidth) {
		return undefined;
	}
	return value as unknown as MermaidArt;
}

function styleSpan(span: Span, theme: Theme): string {
	switch (span.cls) {
		case "border":
			return theme.fg("borderMuted", span.text);
		case "text":
			return theme.fg("text", span.text);
		case "edge":
			return theme.fg("accent", span.text);
		case "edgeLabel":
			return theme.fg("muted", span.text);
		case "title":
			return theme.fg("accent", theme.bold(span.text));
		case "none":
			return span.text;
	}
}

function isSgrOnlyStyle(styled: string, plain: string): boolean {
	return styled.replace(SGR_PATTERN, "") === plain;
}

function themedLines(art: MermaidArt, theme: Theme): string[] | undefined {
	const lines: string[] = [];
	for (let rowIndex = 0; rowIndex < art.styled.length; rowIndex++) {
		let line = "";
		for (const span of art.styled[rowIndex] ?? []) {
			const styled = styleSpan(span, theme);
			if (!isSgrOnlyStyle(styled, span.text)) {
				return undefined;
			}
			line += styled;
		}
		if (visibleWidth(line) !== visibleWidth(art.plain[rowIndex] ?? "")) {
			return undefined;
		}
		lines.push(line);
	}
	return lines;
}

function renderWarning(art: MermaidArt, theme: Theme | undefined): string | undefined {
	const suffix = art.warnings.length > 1 ? ` (+${art.warnings.length - 1} more)` : "";
	const warning = `Mermaid diagram not rendered: ${art.warnings[0]}${suffix}`;
	if (!theme) {
		return codeSpan(warning);
	}
	const styledWarning = theme.fg("warning", warning);
	return isSgrOnlyStyle(styledWarning, warning) ? codeSpan(styledWarning) : undefined;
}

function transformMermaidSourceToken(sourceToken: SourceToken, runtime: MermaidTransformRuntime): string {
	const { token, raw } = sourceToken;
	if (!isMermaid(token) || raw.length > MAX_MERMAID_SOURCE_LENGTH) return raw;
	try {
		const art = validateArt(runtime.renderMermaid(token.text), runtime.context.availableWidth);
		if (!art) return raw;
		const { lineEnding, trailingLineEnding } = sourceLineEndings(raw);
		if (!runtime.context.isStreaming && art.warnings.length > 0) {
			const warning = renderWarning(art, runtime.options.theme);
			const separator = trailingLineEnding ? "" : lineEnding;
			const suffix = trailingLineEnding ? `  ${trailingLineEnding}` : "";
			return warning ? `${raw}${separator}${warning}${suffix}` : raw;
		}
		const lines = runtime.options.theme ? themedLines(art, runtime.options.theme) : art.plain;
		if (!lines) return raw;
		const hardBreak = `  ${lineEnding}`;
		const suffix = trailingLineEnding ? `  ${trailingLineEnding}` : "";
		return `${lines.map(codeSpan).join(hardBreak)}${suffix}`;
	} catch {
		return raw;
	}
}

function shouldRenderMermaid(mode: MermaidRenderingMode, context: MarkdownTransformContext): boolean {
	return (
		mode !== "off" && context.messageType !== "assistant-thinking" && (!context.isStreaming || mode === "streaming")
	);
}

/** Create a pure transformer that replaces eligible top-level Mermaid fences with bounded terminal art. */
export function createMermaidMarkdownTransformer(options: MermaidTransformerOptions): MarkdownTransformer {
	const renderMermaid = options.renderMermaid ?? (render as MermaidRenderer);
	return (markdown, context) => {
		const mode = options.getMode();
		if (!shouldRenderMermaid(mode, context)) return markdown;
		try {
			const sourceTokens = lexPreservingSource(markdown);
			if (!sourceTokens) return markdown;
			const runtime: MermaidTransformRuntime = { context, options, renderMermaid };
			return sourceTokens.map((sourceToken) => transformMermaidSourceToken(sourceToken, runtime)).join("");
		} catch {
			return markdown;
		}
	};
}
