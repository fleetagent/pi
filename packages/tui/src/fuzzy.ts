/**
 * Fuzzy matching utilities.
 * Matches if all query characters appear in order (not necessarily consecutive).
 * Lower score = better match.
 */

export interface FuzzyMatch {
	matches: boolean;
	score: number;
}

interface FuzzyMatchState {
	queryIndex: number;
	score: number;
	lastMatchIndex: number;
	consecutiveMatches: number;
}

function scoreFuzzyCharacterMatch(state: FuzzyMatchState, text: string, index: number): void {
	const isWordBoundary = index === 0 || /[\s\-_./:]/.test(text[index - 1]!);
	if (state.lastMatchIndex === index - 1) {
		state.consecutiveMatches++;
		state.score -= state.consecutiveMatches * 5;
	} else {
		state.consecutiveMatches = 0;
		if (state.lastMatchIndex >= 0) state.score += (index - state.lastMatchIndex - 1) * 2;
	}
	if (isWordBoundary) state.score -= 10;
	state.score += index * 0.1;
	state.lastMatchIndex = index;
	state.queryIndex++;
}

function matchNormalizedQuery(normalizedQuery: string, text: string): FuzzyMatch {
	if (normalizedQuery.length === 0) return { matches: true, score: 0 };
	if (normalizedQuery.length > text.length) return { matches: false, score: 0 };
	const state: FuzzyMatchState = { queryIndex: 0, score: 0, lastMatchIndex: -1, consecutiveMatches: 0 };
	for (let index = 0; index < text.length && state.queryIndex < normalizedQuery.length; index++) {
		if (text[index] !== normalizedQuery[state.queryIndex]) continue;
		scoreFuzzyCharacterMatch(state, text, index);
	}
	if (state.queryIndex < normalizedQuery.length) return { matches: false, score: 0 };
	if (normalizedQuery === text) state.score -= 100;
	return { matches: true, score: state.score };
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
	const queryLower = query.toLowerCase();
	const textLower = text.toLowerCase();

	const primaryMatch = matchNormalizedQuery(queryLower, textLower);
	if (primaryMatch.matches) {
		return primaryMatch;
	}

	const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
	const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
	const swappedQuery = alphaNumericMatch
		? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}`
		: numericAlphaMatch
			? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}`
			: "";

	if (!swappedQuery) {
		return primaryMatch;
	}

	const swappedMatch = matchNormalizedQuery(swappedQuery, textLower);
	if (!swappedMatch.matches) {
		return primaryMatch;
	}

	return { matches: true, score: swappedMatch.score + 5 };
}

/**
 * Filter and sort items by fuzzy match quality (best matches first).
 * Supports space-separated tokens: all tokens must match.
 */
// pi-ignore noExcessiveCollectionIterations: Multi-token filtering must independently score every query token against each candidate item, with short-circuiting on the first failed token.
export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	if (!query.trim()) {
		return items;
	}

	const tokens = query
		.trim()
		.split(/\s+/)
		.filter((t) => t.length > 0);

	if (tokens.length === 0) {
		return items;
	}

	const results: { item: T; totalScore: number }[] = [];

	for (const item of items) {
		const text = getText(item);
		let totalScore = 0;
		let allMatch = true;

		for (const token of tokens) {
			const match = fuzzyMatch(token, text);
			if (match.matches) {
				totalScore += match.score;
			} else {
				allMatch = false;
				break;
			}
		}

		if (allMatch) {
			results.push({ item, totalScore });
		}
	}

	results.sort((a, b) => a.totalScore - b.totalScore);
	return results.map((r) => r.item);
}
