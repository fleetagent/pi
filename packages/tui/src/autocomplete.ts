import { spawn } from "child_process";
import { type Dirent, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import type { SelectItem } from "./components/select-list.ts";
import { fuzzyFilter } from "./fuzzy.ts";

interface ParsedPathPrefix {
	rawPrefix: string;
	isAtPrefix: boolean;
	isQuotedPrefix: boolean;
}

interface CompletionValueOptions {
	isDirectory: boolean;
	isAtPrefix: boolean;
	isQuotedPrefix: boolean;
}

interface FileSearchEntry {
	path: string;
	isDirectory: boolean;
}

export interface AutocompleteSuggestionRequest {
	signal: AbortSignal;
	force?: boolean;
}

export interface AutocompleteCompletion {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

interface ScopedFuzzyQuery {
	baseDir: string;
	query: string;
	displayBase: string;
}

interface FuzzyFileSuggestionOptions {
	isQuotedPrefix: boolean;
	signal: AbortSignal;
}

interface FileSuggestionSearch {
	rawPrefix: string;
	isAtPrefix: boolean;
	isQuotedPrefix: boolean;
	searchDir: string;
	searchPrefix: string;
}

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);
const ROOT_PATH_PREFIXES = new Set(["", "./", "../", "~", "~/", "/"]);

function isFileSuggestionDirectory(searchDir: string, entry: Dirent): boolean {
	if (entry.isDirectory()) return true;
	if (!entry.isSymbolicLink()) return false;
	try {
		return statSync(join(searchDir, entry.name)).isDirectory();
	} catch {
		return false;
	}
}

function buildRelativeSuggestionPath(displayPrefix: string, name: string): string {
	if (displayPrefix.endsWith("/")) return displayPrefix + name;
	const hasDirectoryPrefix = displayPrefix.includes("/") || displayPrefix.includes("\\");
	if (!hasDirectoryPrefix) return displayPrefix.startsWith("~") ? `~/${name}` : name;
	if (displayPrefix.startsWith("~/")) {
		const dir = dirname(displayPrefix.slice(2));
		return `~/${dir === "." ? name : join(dir, name)}`;
	}
	if (displayPrefix.startsWith("/")) {
		const dir = dirname(displayPrefix);
		return dir === "/" ? `/${name}` : `${dir}/${name}`;
	}
	const relativePath = join(dirname(displayPrefix), name);
	return displayPrefix.startsWith("./") && !relativePath.startsWith("./") ? `./${relativePath}` : relativePath;
}

function toDisplayPath(value: string): string {
	return value.replace(/\\/g, "/");
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFdPathQuery(query: string): string {
	const normalized = toDisplayPath(query);
	if (!normalized.includes("/")) {
		return normalized;
	}

	const hasTrailingSeparator = normalized.endsWith("/");
	const trimmed = normalized.replace(/^\/+|\/+$/g, "");
	if (!trimmed) {
		return normalized;
	}

	const separatorPattern = "[\\\\/]";
	const segments = trimmed
		.split("/")
		.filter(Boolean)
		.map((segment) => escapeRegex(segment));
	if (segments.length === 0) {
		return normalized;
	}

	let pattern = segments.join(separatorPattern);
	if (hasTrailingSeparator) {
		pattern += separatorPattern;
	}
	return pattern;
}

function findLastDelimiter(text: string): number {
	for (let i = text.length - 1; i >= 0; i -= 1) {
		if (PATH_DELIMITERS.has(text[i] ?? "")) {
			return i;
		}
	}
	return -1;
}

function findUnclosedQuoteStart(text: string): number | null {
	let inQuotes = false;
	let quoteStart = -1;

	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) {
				quoteStart = i;
			}
		}
	}

	return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
	return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

function extractQuotedPrefix(text: string): string | null {
	const quoteStart = findUnclosedQuoteStart(text);
	if (quoteStart === null) {
		return null;
	}

	if (quoteStart > 0 && text[quoteStart - 1] === "@") {
		if (!isTokenStart(text, quoteStart - 1)) {
			return null;
		}
		return text.slice(quoteStart - 1);
	}

	if (!isTokenStart(text, quoteStart)) {
		return null;
	}

	return text.slice(quoteStart);
}

function parsePathPrefix(prefix: string): ParsedPathPrefix {
	if (prefix.startsWith('@"')) {
		return { rawPrefix: prefix.slice(2), isAtPrefix: true, isQuotedPrefix: true };
	}
	if (prefix.startsWith('"')) {
		return { rawPrefix: prefix.slice(1), isAtPrefix: false, isQuotedPrefix: true };
	}
	if (prefix.startsWith("@")) {
		return { rawPrefix: prefix.slice(1), isAtPrefix: true, isQuotedPrefix: false };
	}
	return { rawPrefix: prefix, isAtPrefix: false, isQuotedPrefix: false };
}

function buildCompletionValue(path: string, options: CompletionValueOptions): string {
	const needsQuotes = options.isQuotedPrefix || path.includes(" ");
	const prefix = options.isAtPrefix ? "@" : "";

	if (!needsQuotes) {
		return `${prefix}${path}`;
	}

	const openQuote = `${prefix}"`;
	const closeQuote = '"';
	return `${openQuote}${path}${closeQuote}`;
}

function parseFdSearchOutput(stdout: string, exitCode: number | null, aborted: boolean): FileSearchEntry[] {
	if (aborted || exitCode !== 0 || !stdout) return [];
	const results: FileSearchEntry[] = [];
	for (const line of stdout.trim().split("\n").filter(Boolean)) {
		const displayLine = toDisplayPath(line);
		const hasTrailingSeparator = displayLine.endsWith("/");
		const normalizedPath = hasTrailingSeparator ? displayLine.slice(0, -1) : displayLine;
		if (normalizedPath === ".git" || normalizedPath.startsWith(".git/") || normalizedPath.includes("/.git/")) {
			continue;
		}
		results.push({ path: displayLine, isDirectory: hasTrailingSeparator });
	}
	return results;
}

async function walkDirectoryWithFd(
	baseDir: string,
	fdPath: string,
	query: string,
	maxResults: number,
	signal: AbortSignal,
): Promise<FileSearchEntry[]> {
	const args = [
		"--base-directory",
		baseDir,
		"--max-results",
		String(maxResults),
		"--type",
		"f",
		"--type",
		"d",
		"--follow",
		"--hidden",
		"--exclude",
		".git",
		"--exclude",
		".git/*",
		"--exclude",
		".git/**",
	];

	if (toDisplayPath(query).includes("/")) {
		args.push("--full-path");
	}

	if (query) {
		args.push(buildFdPathQuery(query));
	}

	return await new Promise((resolve) => {
		if (signal.aborted) {
			resolve([]);
			return;
		}

		const child = spawn(fdPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let resolved = false;

		const finish = (results: FileSearchEntry[]) => {
			if (resolved) return;
			resolved = true;
			signal.removeEventListener("abort", onAbort);
			resolve(results);
		};

		const onAbort = () => {
			if (child.exitCode === null) {
				child.kill("SIGKILL");
			}
		};

		signal.addEventListener("abort", onAbort, { once: true });
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => {
			finish([]);
		});
		child.on("close", (code) => {
			finish(parseFdSearchOutput(stdout, code, signal.aborted));
		});
	});
}

export type AutocompleteItem = SelectItem;

type Awaitable<T> = T | Promise<T>;

export interface SlashCommand {
	name: string;
	description?: string;
	argumentHint?: string;
	// Function to get argument completions for this command
	// Returns null if no argument completion is available
	getArgumentCompletions?(argumentPrefix: string): Awaitable<AutocompleteItem[] | null>;
}

interface CommandSuggestionItem {
	name: string;
	label: string;
	description?: string;
}

function toCommandSuggestionItem(command: SlashCommand | AutocompleteItem): CommandSuggestionItem {
	const name = "name" in command ? command.name : command.value;
	const hint = "argumentHint" in command && command.argumentHint ? command.argumentHint : undefined;
	const description = command.description ?? "";
	const fullDescription = hint ? (description ? `${hint} — ${description}` : hint) : description;
	return {
		name,
		label: name,
		description: fullDescription || undefined,
	};
}

function isSlashCommandCompletion(prefix: string, beforePrefix: string): boolean {
	return prefix.startsWith("/") && beforePrefix.trim() === "" && !prefix.slice(1).includes("/");
}

function completionCursorOffset(item: AutocompleteItem): number {
	const trailingQuoteOffset = item.label.endsWith("/") && item.value.endsWith('"') ? 1 : 0;
	return item.value.length - trailingQuoteOffset;
}

export interface AutocompleteSuggestions {
	items: AutocompleteItem[];
	prefix: string; // What we're matching against (e.g., "/" or "src/")
}

export interface AutocompleteProvider {
	// Get autocomplete suggestions for current text/cursor position
	// Returns null if no suggestions available
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: AutocompleteSuggestionRequest,
	): Promise<AutocompleteSuggestions | null>;

	// Apply the selected item
	// Returns the new text and cursor position
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): AutocompleteCompletion;

	// Check if file completion should trigger for explicit Tab completion
	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
}

// Combined provider that handles both slash commands and file paths
export class CombinedAutocompleteProvider implements AutocompleteProvider {
	private commands: (SlashCommand | AutocompleteItem)[];
	private basePath: string;
	private fdPath: string | null;

	constructor(commands: (SlashCommand | AutocompleteItem)[] = [], basePath: string, fdPath: string | null = null) {
		this.commands = commands;
		this.basePath = basePath;
		this.fdPath = fdPath;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: AutocompleteSuggestionRequest,
	): Promise<AutocompleteSuggestions | null> {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		const atPrefix = this.extractAtPrefix(textBeforeCursor);
		if (atPrefix) {
			const { rawPrefix, isQuotedPrefix } = parsePathPrefix(atPrefix);
			const suggestions = await this.getFuzzyFileSuggestions(rawPrefix, {
				isQuotedPrefix,
				signal: options.signal,
			});
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: atPrefix,
			};
		}

		if (!options.force && textBeforeCursor.startsWith("/")) {
			return await this.getSlashCommandSuggestions(textBeforeCursor);
		}

		const pathMatch = this.extractPathPrefix(textBeforeCursor, options.force ?? false);
		if (pathMatch === null) {
			return null;
		}

		const suggestions = this.getFileSuggestions(pathMatch);
		if (suggestions.length === 0) return null;

		return {
			items: suggestions,
			prefix: pathMatch,
		};
	}

	private async getSlashCommandSuggestions(textBeforeCursor: string): Promise<AutocompleteSuggestions | null> {
		const spaceIndex = textBeforeCursor.indexOf(" ");
		if (spaceIndex === -1) {
			const prefix = textBeforeCursor.slice(1);
			const commandItems = this.commands.map(toCommandSuggestionItem);

			const filtered = fuzzyFilter(commandItems, prefix, (item) => item.name).map((item) => ({
				value: item.name,
				label: item.label,
				...(item.description && { description: item.description }),
			}));
			if (filtered.length === 0) return null;

			return { items: filtered, prefix: textBeforeCursor };
		}

		const commandName = textBeforeCursor.slice(1, spaceIndex);
		const argumentText = textBeforeCursor.slice(spaceIndex + 1);
		const command = this.commands.find((candidate) => {
			const name = "name" in candidate ? candidate.name : candidate.value;
			return name === commandName;
		});
		if (!command || !("getArgumentCompletions" in command) || !command.getArgumentCompletions) {
			return null;
		}

		const argumentSuggestions = await command.getArgumentCompletions(argumentText);
		if (!Array.isArray(argumentSuggestions) || argumentSuggestions.length === 0) {
			return null;
		}

		return { items: argumentSuggestions, prefix: argumentText };
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): AutocompleteCompletion {
		const currentLine = lines[cursorLine] || "";
		const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
		const afterCursor = currentLine.slice(cursorCol);
		const isQuotedPrefix = prefix.startsWith('"') || prefix.startsWith('@"');
		const hasLeadingQuoteAfterCursor = afterCursor.startsWith('"');
		const hasTrailingQuoteInItem = item.value.endsWith('"');
		const adjustedAfterCursor =
			isQuotedPrefix && hasTrailingQuoteInItem && hasLeadingQuoteAfterCursor ? afterCursor.slice(1) : afterCursor;

		// Check if we're completing a slash command (prefix starts with "/" but NOT a file path)
		// Slash commands are at the start of the line and don't contain path separators after the first /.
		if (isSlashCommandCompletion(prefix, beforePrefix)) {
			// This is a command name completion
			const newLine = `${beforePrefix}/${item.value} ${adjustedAfterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 2, // +2 for "/" and space
			};
		}

		// Check if we're completing a file attachment (prefix starts with "@")
		if (prefix.startsWith("@")) {
			// This is a file attachment completion
			// Don't add space after directories so user can continue autocompleting
			const isDirectory = item.label.endsWith("/");
			const suffix = isDirectory ? "" : " ";
			const newLine = `${beforePrefix + item.value}${suffix}${adjustedAfterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			const cursorOffset = completionCursorOffset(item);

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + cursorOffset + suffix.length,
			};
		}

		// For file paths, complete the path
		const newLine = beforePrefix + item.value + adjustedAfterCursor;
		const newLines = [...lines];
		newLines[cursorLine] = newLine;

		const cursorOffset = completionCursorOffset(item);

		return {
			lines: newLines,
			cursorLine,
			cursorCol: beforePrefix.length + cursorOffset,
		};
	}

	// Extract @ prefix for fuzzy file suggestions
	private extractAtPrefix(text: string): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix?.startsWith('@"')) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;

		if (text[tokenStart] === "@") {
			return text.slice(tokenStart);
		}

		return null;
	}

	// Extract a path-like prefix from the text before cursor
	private extractPathPrefix(text: string, forceExtract: boolean = false): string | null {
		const quotedPrefix = extractQuotedPrefix(text);
		if (quotedPrefix) {
			return quotedPrefix;
		}

		const lastDelimiterIndex = findLastDelimiter(text);
		const pathPrefix = lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1);

		// For forced extraction (Tab key), always return something
		if (forceExtract) {
			return pathPrefix;
		}

		// For natural triggers, return if it looks like a path, ends with /, starts with ~/, .
		// Only return empty string if the text looks like it's starting a path context
		if (pathPrefix.includes("/") || pathPrefix.startsWith(".") || pathPrefix.startsWith("~/")) {
			return pathPrefix;
		}

		// Return empty string only after a space (not for completely empty text)
		// Empty text should not trigger file suggestions - that's for forced Tab completion
		if (pathPrefix === "" && text.endsWith(" ")) {
			return pathPrefix;
		}

		return null;
	}

	// Expand home directory (~/) to actual home path
	private expandHomePath(path: string): string {
		if (path.startsWith("~/")) {
			const expandedPath = join(homedir(), path.slice(2));
			// Preserve trailing slash if original path had one
			return path.endsWith("/") && !expandedPath.endsWith("/") ? `${expandedPath}/` : expandedPath;
		} else if (path === "~") {
			return homedir();
		}
		return path;
	}

	private resolveScopedFuzzyQuery(rawQuery: string): ScopedFuzzyQuery | null {
		const normalizedQuery = toDisplayPath(rawQuery);
		const slashIndex = normalizedQuery.lastIndexOf("/");
		if (slashIndex === -1) {
			return null;
		}

		const displayBase = normalizedQuery.slice(0, slashIndex + 1);
		const query = normalizedQuery.slice(slashIndex + 1);

		let baseDir: string;
		if (displayBase.startsWith("~/")) {
			baseDir = this.expandHomePath(displayBase);
		} else if (displayBase.startsWith("/")) {
			baseDir = displayBase;
		} else {
			baseDir = join(this.basePath, displayBase);
		}

		try {
			if (!statSync(baseDir).isDirectory()) {
				return null;
			}
		} catch {
			return null;
		}

		return { baseDir, query, displayBase };
	}

	private scopedPathForDisplay(displayBase: string, relativePath: string): string {
		const normalizedRelativePath = toDisplayPath(relativePath);
		if (displayBase === "/") {
			return `/${normalizedRelativePath}`;
		}
		return `${toDisplayPath(displayBase)}${normalizedRelativePath}`;
	}

	private resolveFileSuggestionSearch(prefix: string): FileSuggestionSearch {
		const { rawPrefix, isAtPrefix, isQuotedPrefix } = parsePathPrefix(prefix);
		const expandedPrefix = rawPrefix.startsWith("~") ? this.expandHomePath(rawPrefix) : rawPrefix;
		const useExpandedDirectory = rawPrefix.startsWith("~") || expandedPrefix.startsWith("/");
		if (ROOT_PATH_PREFIXES.has(rawPrefix) || rawPrefix.endsWith("/")) {
			return {
				rawPrefix,
				isAtPrefix,
				isQuotedPrefix,
				searchDir: useExpandedDirectory ? expandedPrefix : join(this.basePath, expandedPrefix),
				searchPrefix: "",
			};
		}
		const directory = dirname(expandedPrefix);
		return {
			rawPrefix,
			isAtPrefix,
			isQuotedPrefix,
			searchDir: useExpandedDirectory ? directory : join(this.basePath, directory),
			searchPrefix: basename(expandedPrefix),
		};
	}

	// Get file/directory suggestions for a given path prefix
	private getFileSuggestions(prefix: string): AutocompleteItem[] {
		try {
			const search = this.resolveFileSuggestionSearch(prefix);
			const entries = readdirSync(search.searchDir, { withFileTypes: true });
			const suggestions: AutocompleteItem[] = [];
			const normalizedSearchPrefix = search.searchPrefix.toLowerCase();

			for (const entry of entries) {
				if (!entry.name.toLowerCase().startsWith(normalizedSearchPrefix)) continue;
				const isDirectory = isFileSuggestionDirectory(search.searchDir, entry);
				const relativePath = toDisplayPath(buildRelativeSuggestionPath(search.rawPrefix, entry.name));
				const pathValue = isDirectory ? `${relativePath}/` : relativePath;
				const value = buildCompletionValue(pathValue, {
					isDirectory,
					isAtPrefix: search.isAtPrefix,
					isQuotedPrefix: search.isQuotedPrefix,
				});
				suggestions.push({
					value,
					label: entry.name + (isDirectory ? "/" : ""),
				});
			}

			suggestions.sort((a, b) => {
				const aIsDir = a.value.endsWith("/");
				const bIsDir = b.value.endsWith("/");
				if (aIsDir && !bIsDir) return -1;
				if (!aIsDir && bIsDir) return 1;
				return a.label.localeCompare(b.label);
			});
			return suggestions;
		} catch (_e) {
			return [];
		}
	}

	// Score an entry against the query (higher = better match)
	// isDirectory adds bonus to prioritize folders
	private scoreEntry(filePath: string, query: string, isDirectory: boolean): number {
		const fileName = basename(filePath);
		const lowerFileName = fileName.toLowerCase();
		const lowerQuery = query.toLowerCase();

		let score = 0;

		// Exact filename match (highest)
		if (lowerFileName === lowerQuery) score = 100;
		// Filename starts with query
		else if (lowerFileName.startsWith(lowerQuery)) score = 80;
		// Substring match in filename
		else if (lowerFileName.includes(lowerQuery)) score = 50;
		// Substring match in full path
		else if (filePath.toLowerCase().includes(lowerQuery)) score = 30;

		// Directories get a bonus to appear first
		if (isDirectory && score > 0) score += 10;

		return score;
	}

	// Fuzzy file search using fd (fast, respects .gitignore)
	private async getFuzzyFileSuggestions(
		query: string,
		options: FuzzyFileSuggestionOptions,
	): Promise<AutocompleteItem[]> {
		if (!this.fdPath || options.signal.aborted) {
			return [];
		}

		try {
			const scopedQuery = this.resolveScopedFuzzyQuery(query);
			const fdBaseDir = scopedQuery?.baseDir ?? this.basePath;
			const fdQuery = scopedQuery?.query ?? query;
			const entries = await walkDirectoryWithFd(fdBaseDir, this.fdPath, fdQuery, 100, options.signal);
			if (options.signal.aborted) {
				return [];
			}

			const scoredEntries = entries
				.map((entry) => ({
					...entry,
					score: fdQuery ? this.scoreEntry(entry.path, fdQuery, entry.isDirectory) : 1,
				}))
				.filter((entry) => entry.score > 0);

			scoredEntries.sort((a, b) => b.score - a.score);
			const topEntries = scoredEntries.slice(0, 20);

			const suggestions: AutocompleteItem[] = [];
			for (const { path: entryPath, isDirectory } of topEntries) {
				const pathWithoutSlash = isDirectory ? entryPath.slice(0, -1) : entryPath;
				const displayPath = scopedQuery
					? this.scopedPathForDisplay(scopedQuery.displayBase, pathWithoutSlash)
					: pathWithoutSlash;
				const entryName = basename(pathWithoutSlash);
				const completionPath = isDirectory ? `${displayPath}/` : displayPath;
				const value = buildCompletionValue(completionPath, {
					isDirectory,
					isAtPrefix: true,
					isQuotedPrefix: options.isQuotedPrefix,
				});

				suggestions.push({
					value,
					label: entryName + (isDirectory ? "/" : ""),
					description: displayPath,
				});
			}

			return suggestions;
		} catch {
			return [];
		}
	}

	// Check if we should trigger file completion (called on Tab key)
	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Don't trigger if we're typing a slash command at the start of the line
		if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
			return false;
		}

		return true;
	}
}
