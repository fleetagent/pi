import { type FuzzyMatch, fuzzyMatch } from "@fleetagent/pi-tui";
import type { SessionInfo } from "../../../core/session/types.ts";

export type SortMode = "threaded" | "recent" | "relevance";

export type NameFilter = "all" | "named";

export type SearchQueryMode = "tokens" | "regex";
export type SearchTokenKind = "fuzzy" | "phrase";

export interface SearchToken {
	kind: SearchTokenKind;
	value: string;
}

export interface ParsedSearchQuery {
	mode: SearchQueryMode;
	tokens: SearchToken[];
	regex: RegExp | null;
	/** If set, parsing failed and we should treat query as non-matching. */
	error?: string;
}
function normalizeWhitespaceLower(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function getSessionSearchText(session: SessionInfo): string {
	return `${session.id} ${session.name ?? ""} ${session.allMessagesText} ${session.cwd}`;
}

export function hasSessionName(session: SessionInfo): boolean {
	return Boolean(session.name?.trim());
}

function matchesNameFilter(session: SessionInfo, filter: NameFilter): boolean {
	if (filter === "all") return true;
	return hasSessionName(session);
}

function parseRegexSearchQuery(trimmed: string): ParsedSearchQuery {
	const pattern = trimmed.slice(3).trim();
	if (!pattern) return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
	try {
		return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { mode: "regex", tokens: [], regex: null, error: message };
	}
}

function parseTokenSearchQuery(trimmed: string): ParsedSearchQuery {
	const tokens: SearchToken[] = [];
	let buffer = "";
	let inQuote = false;
	const flush = (kind: SearchTokenKind): void => {
		const value = buffer.trim();
		buffer = "";
		if (value) tokens.push({ kind, value });
	};

	for (let index = 0; index < trimmed.length; index += 1) {
		const character = trimmed[index]!;
		if (character === '"') {
			flush(inQuote ? "phrase" : "fuzzy");
			inQuote = !inQuote;
			continue;
		}
		if (!inQuote && /\s/.test(character)) {
			flush("fuzzy");
			continue;
		}
		buffer += character;
	}

	if (inQuote) {
		return {
			mode: "tokens",
			tokens: trimmed
				.split(/\s+/)
				.map((token) => token.trim())
				.filter((token) => token.length > 0)
				.map((token) => ({ kind: "fuzzy" as const, value: token })),
			regex: null,
		};
	}
	flush("fuzzy");
	return { mode: "tokens", tokens, regex: null };
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
	const trimmed = query.trim();
	if (!trimmed) return { mode: "tokens", tokens: [], regex: null };
	return trimmed.startsWith("re:") ? parseRegexSearchQuery(trimmed) : parseTokenSearchQuery(trimmed);
}

interface SessionSearchScoreState {
	total: number;
	normalizedText: string | null;
}

function accumulateSearchTokenScore(token: SearchToken, text: string, state: SessionSearchScoreState): boolean {
	if (token.kind === "fuzzy") {
		const match = fuzzyMatch(token.value, text);
		if (!match.matches) return false;
		state.total += match.score;
		return true;
	}

	if (state.normalizedText === null) state.normalizedText = normalizeWhitespaceLower(text);
	const phrase = normalizeWhitespaceLower(token.value);
	if (!phrase) return true;
	const index = state.normalizedText.indexOf(phrase);
	if (index < 0) return false;
	state.total += index * 0.1;
	return true;
}
export function matchSession(session: SessionInfo, parsed: ParsedSearchQuery): FuzzyMatch {
	const text = getSessionSearchText(session);

	if (parsed.mode === "regex") {
		if (!parsed.regex) {
			return { matches: false, score: 0 };
		}
		const idx = text.search(parsed.regex);
		if (idx < 0) return { matches: false, score: 0 };
		return { matches: true, score: idx * 0.1 };
	}

	if (parsed.tokens.length === 0) {
		return { matches: true, score: 0 };
	}

	const scoreState: SessionSearchScoreState = { total: 0, normalizedText: null };
	for (const token of parsed.tokens) {
		if (!accumulateSearchTokenScore(token, text, scoreState)) return { matches: false, score: 0 };
	}
	return { matches: true, score: scoreState.total };
}

export function filterAndSortSessions(
	sessions: SessionInfo[],
	query: string,
	sortMode: SortMode,
	nameFilter: NameFilter = "all",
): SessionInfo[] {
	const nameFiltered =
		nameFilter === "all" ? sessions : sessions.filter((session) => matchesNameFilter(session, nameFilter));
	const trimmed = query.trim();
	if (!trimmed) return nameFiltered;

	const parsed = parseSearchQuery(query);
	if (parsed.error) return [];

	// Recent mode: filter only, keep incoming order.
	if (sortMode === "recent") {
		const filtered: SessionInfo[] = [];
		for (const s of nameFiltered) {
			const res = matchSession(s, parsed);
			if (res.matches) filtered.push(s);
		}
		return filtered;
	}

	// Relevance mode: sort by score, tie-break by modified desc.
	const scored: { session: SessionInfo; score: number }[] = [];
	for (const s of nameFiltered) {
		const res = matchSession(s, parsed);
		if (!res.matches) continue;
		scored.push({ session: s, score: res.score });
	}

	scored.sort((a, b) => {
		if (a.score !== b.score) return a.score - b.score;
		return b.session.modified.getTime() - a.session.modified.getTime();
	});

	return scored.map((r) => r.session);
}
