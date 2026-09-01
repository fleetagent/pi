import hljs from "highlight.js/lib/index.js";
import { decodeHtmlEntityAt } from "./html.ts";

export type HighlightFormatter = (text: string) => string;
export type HighlightTheme = Partial<Record<string, HighlightFormatter>>;

export interface HighlightOptions {
	language?: string;
	ignoreIllegals?: boolean;
	languageSubset?: string[];
	theme?: HighlightTheme;
}

const SPAN_CLOSE = "</span>";
const HIGHLIGHT_CLASS_PREFIX = "hljs-";

function getScopeFromSpanTag(tag: string): string | undefined {
	const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
	const classValue = match?.[1] ?? match?.[2];
	if (!classValue) {
		return undefined;
	}

	for (const className of classValue.split(/\s+/)) {
		if (className.startsWith(HIGHLIGHT_CLASS_PREFIX)) {
			return className.slice(HIGHLIGHT_CLASS_PREFIX.length);
		}
	}

	return undefined;
}

function getScopeFormatter(scope: string, theme: HighlightTheme): HighlightFormatter | undefined {
	const exact = theme[scope];
	if (exact) {
		return exact;
	}

	const dotIndex = scope.indexOf(".");
	if (dotIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dotIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	const dashIndex = scope.indexOf("-");
	if (dashIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dashIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	return undefined;
}

function getActiveFormatter(scopes: Array<string | undefined>, theme: HighlightTheme): HighlightFormatter | undefined {
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i];
		if (!scope) {
			continue;
		}
		const formatter = getScopeFormatter(scope, theme);
		if (formatter) {
			return formatter;
		}
	}
	return theme.default;
}

interface HighlightSpanOpenTag {
	endIndex: number;
	scope: string | undefined;
}

function isSpanOpenTagStart(html: string, index: number): boolean {
	if (!html.startsWith("<span", index)) {
		return false;
	}
	const nextChar = html[index + "<span".length];
	return nextChar === ">" || nextChar === " " || nextChar === "\t" || nextChar === "\n" || nextChar === "\r";
}
function parseSpanOpenTag(html: string, index: number): HighlightSpanOpenTag | null {
	if (!isSpanOpenTagStart(html, index)) return null;
	const endIndex = html.indexOf(">", index + 5);
	if (endIndex === -1) return null;
	return {
		endIndex,
		scope: getScopeFromSpanTag(html.slice(index, endIndex + 1)),
	};
}

export function renderHighlightedHtml(html: string, theme: HighlightTheme = {}): string {
	let output = "";
	let textBuffer = "";
	const scopes: Array<string | undefined> = [];

	const flushText = () => {
		if (!textBuffer) {
			return;
		}
		const formatter = getActiveFormatter(scopes, theme);
		output += formatter ? formatter(textBuffer) : textBuffer;
		textBuffer = "";
	};

	let index = 0;
	while (index < html.length) {
		const spanOpenTag = parseSpanOpenTag(html, index);
		if (spanOpenTag) {
			flushText();
			scopes.push(spanOpenTag.scope);
			index = spanOpenTag.endIndex + 1;
			continue;
		}

		if (html.startsWith(SPAN_CLOSE, index)) {
			flushText();
			if (scopes.length > 0) {
				scopes.pop();
			}
			index += SPAN_CLOSE.length;
			continue;
		}

		if (html[index] === "&") {
			const decoded = decodeHtmlEntityAt(html, index);
			if (decoded) {
				textBuffer += decoded.text;
				index += decoded.length;
				continue;
			}
		}

		textBuffer += html[index];
		index++;
	}

	flushText();
	return output;
}

export function highlight(code: string, options: HighlightOptions = {}): string {
	const html = options.language
		? hljs.highlight(code, {
				language: options.language,
				ignoreIllegals: options.ignoreIllegals,
			}).value
		: hljs.highlightAuto(code, options.languageSubset).value;
	return renderHighlightedHtml(html, options.theme);
}

export function supportsLanguage(name: string): boolean {
	return hljs.getLanguage(name) !== undefined;
}
