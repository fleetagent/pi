import { Marked, type Token, Tokenizer, type TokenizerExtension, type Tokens } from "marked";
import { renderLatex } from "../latex.ts";
import { getCapabilities, hyperlink, isImageLine } from "../terminal-image.ts";
import type { Component } from "../tui.ts";
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.ts";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;
const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g;

function stripHtmlComments(html: string): string {
	return html.replace(HTML_COMMENT_REGEX, "");
}

class StrictStrikethroughTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2];
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

type LatexTokenType = "latex" | "latexBlock";

interface LatexToken extends Tokens.Generic {
	type: LatexTokenType;
	text: string;
	pending?: boolean;
}

function isEscaped(source: string, index: number): boolean {
	let backslashes = 0;
	for (let position = index - 1; position >= 0 && source[position] === "\\"; position--) {
		backslashes++;
	}
	return backslashes % 2 === 1;
}

function findClosingDelimiter(source: string, closing: string, start: number): number {
	let index = source.indexOf(closing, start);
	while (index >= 0 && isEscaped(source, index)) {
		index = source.indexOf(closing, index + closing.length);
	}
	return index;
}

function looksLikePendingDollarMath(source: string): boolean {
	return /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/.test(source);
}

function looksLikeShellVariableChain(content: string, following: string): boolean {
	return /^[A-Z_][A-Z0-9_]*(?:[/:.-][A-Za-z0-9_./:-]*)*$/.test(content) && /^[A-Za-z_][A-Za-z0-9_]*/.test(following);
}

function tokenizeInlineLatex(source: string): LatexToken | undefined {
	let opening = "";
	let closing = "";
	if (source.startsWith("$$")) {
		opening = "$$";
		closing = "$$";
	} else if (source.startsWith("\\(")) {
		opening = "\\(";
		closing = "\\)";
	} else if (source.startsWith("\\[")) {
		opening = "\\[";
		closing = "\\]";
	} else if (source.startsWith("$") && !/^\$\s/.test(source)) {
		opening = "$";
		closing = "$";
	} else {
		return undefined;
	}

	const closingIndex = findClosingDelimiter(source, closing, opening.length);
	if (
		closingIndex >= 0 &&
		opening === "$" &&
		(/\s$/.test(source.slice(opening.length, closingIndex)) ||
			/^\d/.test(source.slice(closingIndex + 1)) ||
			looksLikeShellVariableChain(
				source.slice(opening.length, closingIndex),
				source.slice(closingIndex + closing.length),
			) ||
			source.slice(opening.length, closingIndex).includes("`"))
	) {
		return undefined;
	}

	if (closingIndex < 0) {
		const pendingSource = source.slice(opening.length);
		if (opening.startsWith("\\") || looksLikePendingDollarMath(pendingSource)) {
			return { type: "latex", raw: source, text: pendingSource, pending: true };
		}
		return undefined;
	}

	const text = source.slice(opening.length, closingIndex);
	if (!text || text.includes("\n")) {
		return undefined;
	}

	const raw = source.slice(0, closingIndex + closing.length);
	return { type: "latex", raw, text };
}

function tokenizeBlockLatex(source: string): LatexToken | undefined {
	const dollarMatch = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(source);
	if (dollarMatch?.[1]) {
		return { type: "latexBlock", raw: dollarMatch[0], text: dollarMatch[1].trim() };
	}

	const bracketMatch = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(source);
	if (bracketMatch?.[1]) {
		return { type: "latexBlock", raw: bracketMatch[0], text: bracketMatch[1].trim() };
	}

	const pendingBracket = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
	if (pendingBracket) {
		return { type: "latexBlock", raw: pendingBracket[0], text: pendingBracket[1], pending: true };
	}
	const pendingDollar = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
	if (pendingDollar?.[1] && looksLikePendingDollarMath(pendingDollar[1])) {
		return { type: "latexBlock", raw: pendingDollar[0], text: pendingDollar[1], pending: true };
	}
	return undefined;
}

const LATEX_MARKDOWN_EXTENSIONS: readonly TokenizerExtension[] = [
	{
		name: "latexBlock",
		level: "block",
		start(source) {
			const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source);
			return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : undefined;
		},
		tokenizer: tokenizeBlockLatex,
	},
	{
		name: "latex",
		level: "inline",
		start(source) {
			const indices = [source.indexOf("$"), source.indexOf("\\("), source.indexOf("\\[")].filter(
				(index) => index >= 0,
			);
			return indices.length > 0 ? Math.min(...indices) : undefined;
		},
		tokenizer: tokenizeInlineLatex,
	},
];

const markdownParser = new Marked();
markdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});
markdownParser.use({ extensions: [...LATEX_MARKDOWN_EXTENSIONS] });

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
	/** Foreground color function */
	color?: (text: string) => string;
	/** Background color function */
	bgColor?: (text: string) => string;
	/** Bold text */
	bold?: boolean;
	/** Italic text */
	italic?: boolean;
	/** Strikethrough text */
	strikethrough?: boolean;
	/** Underline text */
	underline?: boolean;
}

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
	/** Prefix applied to each rendered code block line (default: "  ") */
	codeBlockIndent?: string;
}

export interface MarkdownOptions {
	/** Preserve source ordered-list markers instead of normalizing them from the list start. */
	preserveOrderedListMarkers?: boolean;
	/** Preserve source backslash escapes instead of normalizing escaped punctuation. */
	preserveBackslashEscapes?: boolean;
	/** Transform source Markdown before parsing, with the exact width available for content. */
	transform?: (markdown: string, availableWidth: number) => string;
	/** Render supported LaTeX math expressions as Unicode text (default: true). */
	renderLatex?: boolean;
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

interface TableColumnMeasurements {
	naturalWidths: number[];
	minimumWidths: number[];
}

export class Markdown implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private defaultTextStyle?: DefaultTextStyle;
	private theme: MarkdownTheme;
	private options: MarkdownOptions;
	private defaultStylePrefix?: string;

	// Cache for rendered output
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
		this.defaultTextStyle = defaultTextStyle;
		this.options = options ? { ...options } : {};
	}

	setText(text: string): void {
		this.text = text;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private renderMarkdownTokens(text: string, contentWidth: number): string[] {
		const tokens = markdownParser.lexer(text);
		const renderedLines: string[] = [];
		for (let index = 0; index < tokens.length; index++) {
			const tokenLines = this.renderToken(tokens[index], contentWidth, tokens[index + 1]?.type);
			for (const tokenLine of tokenLines) renderedLines.push(tokenLine);
		}
		return renderedLines;
	}

	private wrapRenderedLines(renderedLines: string[], contentWidth: number): string[] {
		const wrappedLines: string[] = [];
		for (const line of renderedLines) {
			if (isImageLine(line)) {
				wrappedLines.push(line);
				continue;
			}
			for (const wrappedLine of wrapTextWithAnsi(line, contentWidth)) wrappedLines.push(wrappedLine);
		}
		return wrappedLines;
	}

	private padRenderedLines(lines: string[], width: number, paddingX: number): string[] {
		const margin = " ".repeat(paddingX);
		const bgFn = this.defaultTextStyle?.bgColor;
		const contentLines: string[] = [];
		for (const line of lines) {
			if (isImageLine(line)) {
				contentLines.push(line);
				continue;
			}

			const lineWithMargins = margin + line + margin;
			if (bgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
				continue;
			}
			const paddingNeeded = Math.max(0, width - visibleWidth(lineWithMargins));
			contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
		}
		return contentLines;
	}

	private createVerticalPadding(width: number): string[] {
		const bgFn = this.defaultTextStyle?.bgColor;
		const emptyLine = " ".repeat(width);
		const emptyLines: string[] = [];
		for (let index = 0; index < this.paddingY; index++) {
			emptyLines.push(bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine);
		}
		return emptyLines;
	}

	private cacheRenderedLines(width: number, lines: string[]): void {
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = lines;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const effectivePaddingX = Math.min(this.paddingX, Math.floor(Math.max(0, width - 1) / 2));
		const contentWidth = Math.max(1, width - effectivePaddingX * 2);
		const text = this.options.transform?.(this.text, contentWidth) ?? this.text;
		if (!text || text.trim() === "") {
			const result: string[] = [];
			this.cacheRenderedLines(width, result);
			return result;
		}

		const normalizedText = text.replace(/\t/g, "   ");
		const renderedLines = this.renderMarkdownTokens(normalizedText, contentWidth);
		const wrappedLines = this.wrapRenderedLines(renderedLines, contentWidth);
		const contentLines = this.padRenderedLines(wrappedLines, width, effectivePaddingX);
		const verticalPadding = this.createVerticalPadding(width);
		const result = verticalPadding.concat(contentLines, verticalPadding);
		this.cacheRenderedLines(width, result);
		return result.length > 0 ? result : [""];
	}

	/**
	 * Apply default text style to a string.
	 * This is the base styling applied to all text content.
	 * NOTE: Background color is NOT applied here - it's applied at the padding stage
	 * to ensure it extends to the full line width.
	 */
	private applyDefaultStyle(text: string): string {
		if (!this.defaultTextStyle) {
			return text;
		}

		let styled = text;

		// Apply foreground color (NOT background - that's applied at padding stage)
		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		// Apply text decorations using this.theme
		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		return styled;
	}

	private getDefaultStylePrefix(): string {
		if (!this.defaultTextStyle) {
			return "";
		}

		if (this.defaultStylePrefix !== undefined) {
			return this.defaultStylePrefix;
		}

		const sentinel = "\u0000";
		let styled = sentinel;

		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		const sentinelIndex = styled.indexOf(sentinel);
		this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.defaultStylePrefix;
	}

	private getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	private getDefaultInlineStyleContext(): InlineStyleContext {
		return {
			applyText: (text: string) => this.applyDefaultStyle(text),
			stylePrefix: this.getDefaultStylePrefix(),
		};
	}

	private shouldAppendBlockSpacing(nextTokenType?: string): boolean {
		return Boolean(nextTokenType && nextTokenType !== "space");
	}

	private renderHeadingToken(token: Tokens.Heading, nextTokenType?: string): string[] {
		const headingPrefix = `${"#".repeat(token.depth)} `;
		const headingStyle =
			token.depth === 1
				? (text: string) => this.theme.heading(this.theme.bold(this.theme.underline(text)))
				: (text: string) => this.theme.heading(this.theme.bold(text));
		const styleContext: InlineStyleContext = {
			applyText: headingStyle,
			stylePrefix: this.getStylePrefix(headingStyle),
		};
		const headingText = this.renderInlineTokens(token.tokens || [], styleContext);
		const styledHeading = token.depth >= 3 ? headingStyle(headingPrefix) + headingText : headingText;
		return this.shouldAppendBlockSpacing(nextTokenType) ? [styledHeading, ""] : [styledHeading];
	}

	private renderParagraphToken(
		token: Tokens.Paragraph,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines = [this.renderInlineTokens(token.tokens || [], styleContext)];
		if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") lines.push("");
		return lines;
	}

	private renderLatexBlockToken(token: LatexToken, width: number, nextTokenType?: string): string[] {
		const candidate =
			!token.pending && this.options.renderLatex !== false ? renderLatex(token.text, { display: true }) : undefined;
		const rendered = candidate?.split("\n").every((line) => visibleWidth(line) <= width)
			? candidate
			: token.raw.trim();
		const lines = rendered.split("\n").map((line) => this.applyDefaultStyle(line));
		if (this.shouldAppendBlockSpacing(nextTokenType)) lines.push("");
		return lines;
	}

	private renderCodeToken(token: Tokens.Code, nextTokenType?: string): string[] {
		const indent = this.theme.codeBlockIndent ?? "  ";
		const lines = [this.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`)];
		if (this.theme.highlightCode) {
			for (const highlightedLine of this.theme.highlightCode(token.text, token.lang)) {
				lines.push(`${indent}${highlightedLine}`);
			}
		} else {
			for (const codeLine of token.text.split("\n")) {
				lines.push(`${indent}${this.theme.codeBlock(codeLine)}`);
			}
		}
		lines.push(this.theme.codeBlockBorder("```"));
		if (this.shouldAppendBlockSpacing(nextTokenType)) lines.push("");
		return lines;
	}

	private renderBlockquoteToken(token: Tokens.Blockquote, width: number, nextTokenType?: string): string[] {
		const quoteStyle = (text: string) => this.theme.quote(this.theme.italic(text));
		const quoteStylePrefix = this.getStylePrefix(quoteStyle);
		const quoteContentWidth = Math.max(1, width - 2);
		const quoteStyleContext: InlineStyleContext = {
			applyText: (text: string) => text,
			stylePrefix: quoteStylePrefix,
		};
		const renderedQuoteLines: string[] = [];
		const quoteTokens = token.tokens || [];
		for (let index = 0; index < quoteTokens.length; index++) {
			renderedQuoteLines.push(
				...this.renderToken(quoteTokens[index], quoteContentWidth, quoteTokens[index + 1]?.type, quoteStyleContext),
			);
		}
		while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
			renderedQuoteLines.pop();
		}

		const lines: string[] = [];
		for (const quoteLine of renderedQuoteLines) {
			const lineWithReappliedStyle = quoteStylePrefix
				? quoteLine.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`)
				: quoteLine;
			for (const wrappedLine of wrapTextWithAnsi(quoteStyle(lineWithReappliedStyle), quoteContentWidth)) {
				lines.push(this.theme.quoteBorder("│ ") + wrappedLine);
			}
		}
		if (this.shouldAppendBlockSpacing(nextTokenType)) lines.push("");
		return lines;
	}

	private renderHorizontalRule(width: number, nextTokenType?: string): string[] {
		const lines = [this.theme.hr("─".repeat(Math.min(width, 80)))];
		if (this.shouldAppendBlockSpacing(nextTokenType)) lines.push("");
		return lines;
	}

	private renderHtmlBlock(token: Token): string[] {
		if (!("raw" in token) || typeof token.raw !== "string") return [];
		const visibleHtml = stripHtmlComments(token.raw).trim();
		return visibleHtml ? [this.applyDefaultStyle(visibleHtml)] : [];
	}

	private renderFallbackToken(token: Token): string[] {
		return "text" in token && typeof token.text === "string" ? [token.text] : [];
	}

	private renderToken(
		token: Token,
		width: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		switch (token.type) {
			case "heading":
				return this.renderHeadingToken(token as Tokens.Heading, nextTokenType);
			case "paragraph":
				return this.renderParagraphToken(token as Tokens.Paragraph, nextTokenType, styleContext);
			case "text":
				return [this.renderInlineTokens([token], styleContext)];
			case "latexBlock":
				return this.renderLatexBlockToken(token as LatexToken, width, nextTokenType);
			case "code":
				return this.renderCodeToken(token as Tokens.Code, nextTokenType);
			case "list":
				return this.renderList(token as Tokens.List, 0, width, styleContext);
			case "table":
				return this.renderTable(token as Tokens.Table, width, nextTokenType, styleContext);
			case "blockquote":
				return this.renderBlockquoteToken(token as Tokens.Blockquote, width, nextTokenType);
			case "hr":
				return this.renderHorizontalRule(width, nextTokenType);
			case "html":
				return this.renderHtmlBlock(token);
			case "space":
				return [""];
			default:
				return this.renderFallbackToken(token);
		}
	}

	private applyInlineText(text: string, styleContext: InlineStyleContext): string {
		return text
			.split("\n")
			.map((segment) => styleContext.applyText(segment))
			.join("\n");
	}

	private renderInlineLinkToken(token: Tokens.Link, styleContext: InlineStyleContext): string {
		const linkText = this.renderInlineTokens(token.tokens || [], styleContext);
		const styledLink = this.theme.link(this.theme.underline(linkText));
		if (getCapabilities().hyperlinks) {
			// OSC 8: render as a clickable hyperlink. The URL is not printed inline,
			// so we always show only the link text regardless of whether it matches href.
			return hyperlink(styledLink, token.href) + styleContext.stylePrefix;
		}

		// Fallback: print URL in parentheses when text differs from href.
		// Compare raw token.text (not styled) against href for the equality check.
		// For mailto: links strip the prefix (autolinked emails use text="foo@bar.com"
		// but href="mailto:foo@bar.com").
		const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
		if (token.text === token.href || token.text === hrefForComparison) {
			return styledLink + styleContext.stylePrefix;
		}
		return styledLink + this.theme.linkUrl(` (${token.href})`) + styleContext.stylePrefix;
	}

	private renderInlineLatexToken(token: LatexToken, styleContext: InlineStyleContext): string {
		const rendered =
			!token.pending && this.options.renderLatex !== false ? (renderLatex(token.text) ?? token.raw) : token.raw;
		return this.applyInlineText(rendered, styleContext);
	}

	private renderInlineTextToken(token: Tokens.Text, styleContext: InlineStyleContext): string {
		// Text tokens in list items can have nested tokens for inline formatting.
		return token.tokens?.length
			? this.renderInlineTokens(token.tokens, styleContext)
			: this.applyInlineText(token.text, styleContext);
	}

	private renderInlineHtmlToken(token: Token, styleContext: InlineStyleContext): string {
		if (!("raw" in token) || typeof token.raw !== "string") return "";
		const visibleHtml = stripHtmlComments(token.raw);
		return visibleHtml ? this.applyInlineText(visibleHtml, styleContext) : "";
	}

	private renderInlineFallbackToken(token: Token, styleContext: InlineStyleContext): string {
		if (!("text" in token) || typeof token.text !== "string") return "";
		return this.applyInlineText(token.text, styleContext);
	}

	private renderInlineToken(token: Token, styleContext: InlineStyleContext): string {
		const { stylePrefix } = styleContext;
		switch (token.type) {
			case "latex":
				return this.renderInlineLatexToken(token as LatexToken, styleContext);
			case "escape":
				return this.applyInlineText(this.options.preserveBackslashEscapes ? token.raw : token.text, styleContext);
			case "text":
				return this.renderInlineTextToken(token as Tokens.Text, styleContext);
			case "paragraph":
				return this.renderInlineTokens(token.tokens || [], styleContext);
			case "strong":
				return this.theme.bold(this.renderInlineTokens(token.tokens || [], styleContext)) + stylePrefix;
			case "em":
				return this.theme.italic(this.renderInlineTokens(token.tokens || [], styleContext)) + stylePrefix;
			case "codespan":
				return this.theme.code(token.text) + stylePrefix;
			case "link":
				return this.renderInlineLinkToken(token as Tokens.Link, styleContext);
			case "br":
				return "\n";
			case "del":
				return this.theme.strikethrough(this.renderInlineTokens(token.tokens || [], styleContext)) + stylePrefix;
			case "html":
				return this.renderInlineHtmlToken(token, styleContext);
			default:
				return this.renderInlineFallbackToken(token, styleContext);
		}
	}

	private renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
		const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
		let result = "";
		for (const token of tokens) {
			result += this.renderInlineToken(token, resolvedStyleContext);
		}

		while (resolvedStyleContext.stylePrefix && result.endsWith(resolvedStyleContext.stylePrefix)) {
			result = result.slice(0, -resolvedStyleContext.stylePrefix.length);
		}
		return result;
	}

	private getOrderedListMarker(item: Tokens.ListItem): string | undefined {
		const match = /^(?: {0,3})(\d{1,9}[.)])[ \t]+/.exec(item.raw);
		return match ? `${match[1]} ` : undefined;
	}

	private getListItemMarker(token: Tokens.List, item: Tokens.ListItem, index: number, startNumber: number): string {
		if (!token.ordered) return "- ";
		if (this.options.preserveOrderedListMarkers) {
			return this.getOrderedListMarker(item) ?? `${startNumber + index}. `;
		}
		return `${startNumber + index}. `;
	}

	private renderListItem(
		token: Tokens.List,
		item: Tokens.ListItem,
		index: number,
		startNumber: number,
		depth: number,
		width: number,
		styleContext?: InlineStyleContext,
	): string[] {
		const indent = "    ".repeat(depth);
		const bullet = this.getListItemMarker(token, item, index, startNumber);
		const taskMarker = item.task ? `[${item.checked ? "x" : " "}] ` : "";
		const marker = bullet + taskMarker;
		const firstPrefix = indent + this.theme.listBullet(marker);
		const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
		const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
		const lines: string[] = [];
		let renderedAnyLine = false;

		for (const itemToken of item.tokens) {
			if (itemToken.type === "list") {
				lines.push(...this.renderList(itemToken as Tokens.List, depth + 1, width, styleContext));
				renderedAnyLine = true;
				continue;
			}

			const itemLines = this.renderToken(itemToken, itemWidth, undefined, styleContext);
			const wrappedItemLines = itemLines.flatMap((line) => wrapTextWithAnsi(line, itemWidth));
			for (const wrappedLine of wrappedItemLines) {
				const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
				lines.push(linePrefix + wrappedLine);
				renderedAnyLine = true;
			}
		}

		if (!renderedAnyLine) lines.push(firstPrefix);
		return lines;
	}

	/**
	 * Render a list with proper nesting support
	 */
	private renderList(token: Tokens.List, depth: number, width: number, styleContext?: InlineStyleContext): string[] {
		const lines: string[] = [];
		const startNumber = typeof token.start === "number" ? token.start : 1;
		for (let index = 0; index < token.items.length; index++) {
			lines.push(...this.renderListItem(token, token.items[index], index, startNumber, depth, width, styleContext));
		}
		return lines;
	}

	/**
	 * Get the visible width of the longest word in a string.
	 */
	private getLongestWordWidth(text: string, maxWidth?: number): number {
		const words = text.split(/\s+/).filter((word) => word.length > 0);
		let longest = 0;
		for (const word of words) {
			longest = Math.max(longest, visibleWidth(word));
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	/**
	 * Wrap a table cell to fit into a column.
	 *
	 * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
	 * consistently with the rest of the renderer.
	 */
	private wrapCellText(text: string, maxWidth: number): string[] {
		return wrapTextWithAnsi(text, Math.max(1, maxWidth));
	}

	/**
	 * Render a table with width-aware cell wrapping.
	 * Cells that don't fit are wrapped to multiple lines.
	 */
	private measureTableColumns(
		token: Tokens.Table,
		styleContext: InlineStyleContext | undefined,
	): TableColumnMeasurements {
		const naturalWidths: number[] = [];
		const minimumWidths: number[] = [];
		const maxUnbrokenWordWidth = 30;
		for (let column = 0; column < token.header.length; column++) {
			const headerText = this.renderInlineTokens(token.header[column].tokens || [], styleContext);
			naturalWidths[column] = visibleWidth(headerText);
			minimumWidths[column] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		for (const row of token.rows) {
			for (let column = 0; column < row.length; column++) {
				const cellText = this.renderInlineTokens(row[column].tokens || [], styleContext);
				naturalWidths[column] = Math.max(naturalWidths[column] || 0, visibleWidth(cellText));
				minimumWidths[column] = Math.max(
					minimumWidths[column] || 1,
					this.getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}
		return { naturalWidths, minimumWidths };
	}

	private fitMinimumTableColumnWidths(minimumWidths: number[], availableForCells: number): number[] {
		if (minimumWidths.reduce((total, width) => total + width, 0) <= availableForCells) return minimumWidths;
		const fittedWidths = new Array(minimumWidths.length).fill(1);
		const remaining = availableForCells - minimumWidths.length;
		if (remaining <= 0) return fittedWidths;
		const totalWeight = minimumWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
		const growth = minimumWidths.map((width) => {
			const weight = Math.max(0, width - 1);
			return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
		});
		for (let column = 0; column < minimumWidths.length; column++) fittedWidths[column] += growth[column] ?? 0;
		const allocated = growth.reduce((total, width) => total + width, 0);
		let leftover = remaining - allocated;
		for (let column = 0; leftover > 0 && column < minimumWidths.length; column++) {
			fittedWidths[column]++;
			leftover--;
		}
		return fittedWidths;
	}

	private distributeRemainingTableWidth(
		columnWidths: number[],
		naturalWidths: number[],
		remainingWidth: number,
	): void {
		let remaining = remainingWidth;
		while (remaining > 0) {
			let grew = false;
			for (let column = 0; column < columnWidths.length && remaining > 0; column++) {
				if (columnWidths[column] >= naturalWidths[column]) continue;
				columnWidths[column]++;
				remaining--;
				grew = true;
			}
			if (!grew) break;
		}
	}

	private calculateTableColumnWidths(
		naturalWidths: number[],
		minimumWidths: number[],
		availableForCells: number,
		borderOverhead: number,
	): number[] {
		const fittedMinimumWidths = this.fitMinimumTableColumnWidths(minimumWidths, availableForCells);
		const totalNaturalWidth = naturalWidths.reduce((total, width) => total + width, 0) + borderOverhead;
		if (totalNaturalWidth <= availableForCells + borderOverhead) {
			return naturalWidths.map((width, column) => Math.max(width, fittedMinimumWidths[column]));
		}
		const minimumCellsWidth = fittedMinimumWidths.reduce((total, width) => total + width, 0);
		const totalGrowPotential = naturalWidths.reduce(
			(total, width, column) => total + Math.max(0, width - fittedMinimumWidths[column]),
			0,
		);
		const extraWidth = Math.max(0, availableForCells - minimumCellsWidth);
		const columnWidths = fittedMinimumWidths.map((minimumWidth, column) => {
			const growthPotential = Math.max(0, naturalWidths[column] - minimumWidth);
			const growth = totalGrowPotential > 0 ? Math.floor((growthPotential / totalGrowPotential) * extraWidth) : 0;
			return minimumWidth + growth;
		});
		const allocated = columnWidths.reduce((total, width) => total + width, 0);
		this.distributeRemainingTableWidth(columnWidths, naturalWidths, availableForCells - allocated);
		return columnWidths;
	}

	private renderTableBorder(columnWidths: number[], left: string, junction: string, right: string): string {
		return `${left}─${columnWidths.map((width) => "─".repeat(width)).join(`─${junction}─`)}─${right}`;
	}

	private renderTableCellLines(
		cells: Tokens.TableCell[],
		columnWidths: number[],
		styleContext: InlineStyleContext | undefined,
	): string[][] {
		return cells.map((cell, column) => {
			const text = this.renderInlineTokens(cell.tokens || [], styleContext);
			return this.wrapCellText(text, columnWidths[column]);
		});
	}

	// pi-ignore noExcessiveCollectionIterations: Every rendered table line must format each column once, so this rectangular traversal is linear in the emitted cell slots.
	private appendTableRow(lines: string[], cellLines: string[][], columnWidths: number[], bold: boolean): void {
		const lineCount = Math.max(...cellLines.map((cell) => cell.length));
		for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
			const rowParts = cellLines.map((columnLines, column) => {
				const text = columnLines[lineIndex] || "";
				const padded = text + " ".repeat(Math.max(0, columnWidths[column] - visibleWidth(text)));
				return bold ? this.theme.bold(padded) : padded;
			});
			lines.push(`│ ${rowParts.join(" │ ")} │`);
		}
	}

	private renderTable(
		token: Tokens.Table,
		availableWidth: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const columnCount = token.header.length;
		if (columnCount === 0) return [];
		const borderOverhead = 3 * columnCount + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < columnCount) {
			const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
			if (nextTokenType && nextTokenType !== "space") fallbackLines.push("");
			return fallbackLines;
		}

		const measurements = this.measureTableColumns(token, styleContext);
		const columnWidths = this.calculateTableColumnWidths(
			measurements.naturalWidths,
			measurements.minimumWidths,
			availableForCells,
			borderOverhead,
		);
		const lines = [this.renderTableBorder(columnWidths, "┌", "┬", "┐")];
		this.appendTableRow(
			lines,
			this.renderTableCellLines(token.header, columnWidths, styleContext),
			columnWidths,
			true,
		);
		const separator = this.renderTableBorder(columnWidths, "├", "┼", "┤");
		lines.push(separator);
		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			this.appendTableRow(
				lines,
				this.renderTableCellLines(token.rows[rowIndex], columnWidths, styleContext),
				columnWidths,
				false,
			);
			if (rowIndex < token.rows.length - 1) lines.push(separator);
		}
		lines.push(this.renderTableBorder(columnWidths, "└", "┴", "┘"));
		if (nextTokenType && nextTokenType !== "space") lines.push("");
		return lines;
	}
}
