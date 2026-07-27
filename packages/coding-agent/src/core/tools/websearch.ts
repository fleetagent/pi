import type { AgentTool } from "@fleetagent/pi-agent-core";
import { Text } from "@fleetagent/pi-tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

interface RenderTheme {
	bold(value: string): string;
	fg(role: string, value: string): string;
}

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 10_000;

export type WebsearchProvider =
	| "duckduckgo"
	| "duckduckgo-instant-answer"
	| "brave"
	| "brave-search"
	| "firecrawl"
	| "firecrawl-search";

export interface WebsearchToolOptions {
	provider?: WebsearchProvider;
	apiKey?: string;
	baseUrl?: string;
}

const websearchSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
	limit: Type.Optional(
		Type.Number({ description: `Maximum number of links to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` }),
	),
});

export type WebsearchToolInput = Static<typeof websearchSchema>;

export interface WebsearchResultItem {
	title: string;
	url: string;
	snippet?: string;
}

export interface WebsearchToolDetails {
	query: string;
	results: WebsearchResultItem[];
	source: "duckduckgo-instant-answer" | "brave-search" | "firecrawl-search";
}

interface DuckDuckGoTopic {
	FirstURL?: unknown;
	Text?: unknown;
	Name?: unknown;
	Topics?: unknown;
}

interface BraveSearchResult {
	title?: unknown;
	url?: unknown;
	description?: unknown;
}

interface FirecrawlSearchResult {
	title?: unknown;
	url?: unknown;
	description?: unknown;
	markdown?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function parseWebsearchToolOptions(value: unknown): WebsearchToolOptions | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error("tools.websearch must be an object");
	const options: WebsearchToolOptions = {};

	const provider = asString(value.provider);
	if (provider !== undefined) {
		if (
			provider !== "duckduckgo" &&
			provider !== "duckduckgo-instant-answer" &&
			provider !== "brave" &&
			provider !== "brave-search" &&
			provider !== "firecrawl" &&
			provider !== "firecrawl-search"
		) {
			throw new Error(`Invalid tools.websearch.provider: ${provider}`);
		}
		options.provider = provider;
	}

	const apiKey = asString(value.apiKey);
	if (apiKey !== undefined) options.apiKey = apiKey;

	const baseUrl = asString(value.baseUrl);
	if (baseUrl !== undefined) options.baseUrl = baseUrl;

	return options;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stripHtml(value: string): string {
	return value
		.replace(/<[^>]*>/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function titleFromText(text: string): string {
	const separator = text.indexOf(" - ");
	return (separator > 0 ? text.slice(0, separator) : text).trim();
}

function pushResult(results: WebsearchResultItem[], seen: Set<string>, item: WebsearchResultItem): void {
	const url = item.url.trim();
	if (!url || seen.has(url)) return;
	seen.add(url);
	results.push({ ...item, url });
}

function collectRelatedTopics(value: unknown, results: WebsearchResultItem[], seen: Set<string>, limit: number): void {
	if (results.length >= limit) return;
	if (!Array.isArray(value)) return;

	for (const entry of value) {
		if (results.length >= limit) return;
		if (!isRecord(entry)) continue;
		const topic = entry as DuckDuckGoTopic;
		const nestedTopics = topic.Topics;
		if (Array.isArray(nestedTopics)) {
			collectRelatedTopics(nestedTopics, results, seen, limit);
			continue;
		}

		const url = asString(topic.FirstURL);
		const rawText = asString(topic.Text) ?? asString(topic.Name);
		if (!url || !rawText) continue;
		const text = stripHtml(rawText);
		pushResult(results, seen, {
			title: titleFromText(text),
			url,
			snippet: text,
		});
	}
}

export function parseDuckDuckGoResponse(data: unknown, limit: number): WebsearchResultItem[] {
	const results: WebsearchResultItem[] = [];
	const seen = new Set<string>();
	if (!isRecord(data)) return results;

	const heading = asString(data.Heading);
	const abstractUrl = asString(data.AbstractURL);
	const abstractText = asString(data.AbstractText) ?? asString(data.Abstract);
	if (abstractUrl && (heading || abstractText)) {
		pushResult(results, seen, {
			title: heading ?? titleFromText(stripHtml(abstractText ?? abstractUrl)),
			url: abstractUrl,
			snippet: abstractText ? stripHtml(abstractText) : undefined,
		});
	}

	collectRelatedTopics(data.RelatedTopics, results, seen, limit);
	collectRelatedTopics(data.Results, results, seen, limit);

	return results.slice(0, limit);
}

export function parseBraveSearchResponse(data: unknown, limit: number): WebsearchResultItem[] {
	const results: WebsearchResultItem[] = [];
	const seen = new Set<string>();
	if (!isRecord(data) || !isRecord(data.web) || !Array.isArray(data.web.results)) return results;

	for (const entry of data.web.results) {
		if (results.length >= limit) break;
		if (!isRecord(entry)) continue;
		const item = entry as BraveSearchResult;
		const title = asString(item.title);
		const url = asString(item.url);
		if (!title || !url) continue;
		const description = asString(item.description);
		pushResult(results, seen, {
			title: stripHtml(title),
			url,
			snippet: description ? stripHtml(description) : undefined,
		});
	}

	return results;
}

export function parseFirecrawlSearchResponse(data: unknown, limit: number): WebsearchResultItem[] {
	const results: WebsearchResultItem[] = [];
	const seen = new Set<string>();
	if (!isRecord(data) || !isRecord(data.data) || !Array.isArray(data.data.web)) return results;

	for (const entry of data.data.web) {
		if (results.length >= limit) break;
		if (!isRecord(entry)) continue;
		const item = entry as FirecrawlSearchResult;
		const title = asString(item.title);
		const url = asString(item.url);
		if (!title || !url) continue;
		const description = asString(item.description);
		const markdown = asString(item.markdown);
		pushResult(results, seen, {
			title: stripHtml(title),
			url,
			snippet: description ? stripHtml(description) : markdown ? stripHtml(markdown).slice(0, 500) : undefined,
		});
	}

	return results;
}

function formatSourceName(source: WebsearchToolDetails["source"]): string {
	switch (source) {
		case "brave-search":
			return "Brave Search";
		case "firecrawl-search":
			return "Firecrawl";
		case "duckduckgo-instant-answer":
			return "DuckDuckGo";
	}
}

function formatResults(query: string, results: WebsearchResultItem[], source: WebsearchToolDetails["source"]): string {
	if (results.length === 0) {
		return `No ${formatSourceName(source)} links found for: ${query}`;
	}
	return results
		.map((result, index) => {
			const lines = [`${index + 1}. ${result.title}`, `   ${result.url}`];
			if (result.snippet) lines.push(`   ${result.snippet}`);
			return lines.join("\n");
		})
		.join("\n\n");
}

function resolveLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_LIMIT;
	if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
	return Math.min(MAX_LIMIT, Math.floor(limit));
}

function formatWebsearchCall(args: { query?: string; limit?: number } | undefined, theme: RenderTheme): string {
	const query = str(args?.query);
	const invalidArg = invalidArgText(theme);
	let text = `${theme.fg("toolTitle", theme.bold("websearch"))} ${query === null ? invalidArg : theme.fg("accent", query)}`;
	if (args?.limit !== undefined) text += theme.fg("toolOutput", ` (limit ${args.limit})`);
	return text;
}

function formatWebsearchResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: WebsearchToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: RenderTheme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 24;
	const displayed = lines.slice(0, maxLines).map((line) => theme.fg("toolOutput", line));
	const remaining = lines.length - maxLines;
	return remaining > 0
		? `${displayed.join("\n")}\n${theme.fg("muted", `... (${remaining} more lines)`)}`
		: displayed.join("\n");
}
function resolveWebsearchProvider(options?: WebsearchToolOptions): WebsearchToolDetails["source"] {
	const configured =
		options?.provider?.trim().toLowerCase() ?? process.env.PI_WEBSEARCH_PROVIDER?.trim().toLowerCase();
	if (!configured) {
		if (process.env.PI_WEBSEARCH_FIRECRAWL_API_KEY || process.env.FIRECRAWL_API_KEY) return "firecrawl-search";
		if (options?.apiKey || process.env.PI_WEBSEARCH_BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY)
			return "brave-search";
	}
	if (!configured || configured === "duckduckgo" || configured === "duckduckgo-instant-answer") {
		return "duckduckgo-instant-answer";
	}
	if (configured === "brave" || configured === "brave-search") return "brave-search";
	if (configured === "firecrawl" || configured === "firecrawl-search") return "firecrawl-search";
	throw new Error(`Unsupported websearch provider: ${configured}`);
}

function resolveBraveApiKey(options?: WebsearchToolOptions): string {
	const key = options?.apiKey ?? process.env.PI_WEBSEARCH_BRAVE_API_KEY ?? process.env.BRAVE_SEARCH_API_KEY;
	if (!key?.trim()) {
		throw new Error(
			"Brave websearch requires tools.websearch.apiKey, PI_WEBSEARCH_BRAVE_API_KEY, or BRAVE_SEARCH_API_KEY",
		);
	}
	return key.trim();
}

function resolveFirecrawlApiKey(options?: WebsearchToolOptions): string {
	const key = options?.apiKey ?? process.env.PI_WEBSEARCH_FIRECRAWL_API_KEY ?? process.env.FIRECRAWL_API_KEY;
	if (!key?.trim()) {
		throw new Error(
			"Firecrawl websearch requires tools.websearch.apiKey, PI_WEBSEARCH_FIRECRAWL_API_KEY, or FIRECRAWL_API_KEY",
		);
	}
	return key.trim();
}

async function fetchDuckDuckGoResults(
	query: string,
	limit: number,
	signal: AbortSignal,
): Promise<WebsearchResultItem[]> {
	const url = new URL("https://api.duckduckgo.com/");
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");
	url.searchParams.set("no_html", "1");
	url.searchParams.set("skip_disambig", "1");

	const response = await fetch(url, {
		headers: { accept: "application/json", "user-agent": "pi-coding-agent" },
		signal,
	});
	if (!response.ok) {
		throw new Error(`DuckDuckGo request failed: ${response.status} ${response.statusText}`);
	}
	return parseDuckDuckGoResponse((await response.json()) as unknown, limit);
}

async function fetchBraveResults(
	query: string,
	limit: number,
	signal: AbortSignal,
	options?: WebsearchToolOptions,
): Promise<WebsearchResultItem[]> {
	const url = new URL(
		options?.baseUrl ?? process.env.PI_WEBSEARCH_BRAVE_BASE_URL ?? "https://api.search.brave.com/res/v1/web/search",
	);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(limit));

	const response = await fetch(url, {
		headers: {
			accept: "application/json",
			"user-agent": "pi-coding-agent",
			"x-subscription-token": resolveBraveApiKey(options),
		},
		signal,
	});
	if (!response.ok) {
		throw new Error(`Brave Search request failed: ${response.status} ${response.statusText}`);
	}
	return parseBraveSearchResponse((await response.json()) as unknown, limit);
}

async function fetchFirecrawlResults(
	query: string,
	limit: number,
	signal: AbortSignal,
	options?: WebsearchToolOptions,
): Promise<WebsearchResultItem[]> {
	const url = new URL(
		options?.baseUrl ?? process.env.PI_WEBSEARCH_FIRECRAWL_BASE_URL ?? "https://api.firecrawl.dev/v2/search",
	);
	const response = await fetch(url, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/json",
			"user-agent": "pi-coding-agent",
			authorization: `Bearer ${resolveFirecrawlApiKey(options)}`,
		},
		body: JSON.stringify({ query, limit, sources: [{ type: "web" }] }),
		signal,
	});
	if (!response.ok) {
		throw new Error(`Firecrawl Search request failed: ${response.status} ${response.statusText}`);
	}
	return parseFirecrawlSearchResponse((await response.json()) as unknown, limit);
}
export function createWebsearchToolDefinition(
	options?: WebsearchToolOptions,
): ToolDefinition<typeof websearchSchema, WebsearchToolDetails> {
	return {
		name: "websearch",
		label: "websearch",
		description:
			"Search the web for relevant links using DuckDuckGo by default, or Brave Search/Firecrawl when configured. Returns titles, URLs, and snippets when available.",
		promptSnippet: "Search the web for relevant links",
		parameters: websearchSchema,
		async execute(_toolCallId, { query, limit }: WebsearchToolInput, signal?: AbortSignal) {
			const trimmedQuery = query.trim();
			if (!trimmedQuery) throw new Error("query is required");

			const effectiveLimit = resolveLimit(limit);
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
			const onAbort = () => controller.abort();
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const source = resolveWebsearchProvider(options);
				const results = await (async () => {
					switch (source) {
						case "brave-search":
							return fetchBraveResults(trimmedQuery, effectiveLimit, controller.signal, options);
						case "firecrawl-search":
							return fetchFirecrawlResults(trimmedQuery, effectiveLimit, controller.signal, options);
						case "duckduckgo-instant-answer":
							return fetchDuckDuckGoResults(trimmedQuery, effectiveLimit, controller.signal);
					}
				})();
				return {
					content: [{ type: "text", text: formatResults(trimmedQuery, results, source) }],
					details: { query: trimmedQuery, results, source },
				};
			} finally {
				clearTimeout(timeout);
				signal?.removeEventListener("abort", onAbort);
			}
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatWebsearchCall(args as { query?: string; limit?: number } | undefined, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				formatWebsearchResult(
					result as { content: Array<{ type: string; text?: string }>; details?: WebsearchToolDetails },
					options,
					theme,
					context.showImages,
				),
			);
			return text;
		},
	};
}

export function createWebsearchTool(options?: WebsearchToolOptions): AgentTool<typeof websearchSchema> {
	return wrapToolDefinition(createWebsearchToolDefinition(options));
}
