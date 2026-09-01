import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import {
	type Dirent,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";

function getEnv(): NodeJS.ProcessEnv {
	if (process.platform !== "linux" || Object.keys(process.env).length > 0) {
		return process.env;
	}
	try {
		const data = readFileSync("/proc/self/environ", "utf-8");
		const env: NodeJS.ProcessEnv = {};
		for (const entry of data.split("\0")) {
			const idx = entry.indexOf("=");
			if (idx > 0) {
				env[entry.slice(0, idx)] = entry.slice(idx + 1);
			}
		}
		return env;
	} catch {
		return process.env;
	}
}

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { globSync } from "glob";
import ignore from "ignore";
import { minimatch } from "minimatch";
import { CONFIG_DIR_NAME } from "../config.ts";
import { spawnProcess, spawnProcessSync } from "../utils/child-process.ts";
import { type GitSource, isSafeGitInstallPath, parseGitUrl } from "../utils/git.ts";
import { canonicalizePath, isLocalPath, markPathIgnoredByCloudSync, resolvePath } from "../utils/paths.ts";
import { isStdoutTakenOver } from "./output-guard.ts";
import { type PiManifest, readPiManifest } from "./pi-manifest.ts";
import type { PackageSource, Settings, SettingsManager } from "./settings-manager.ts";
import type { SourceOrigin, SourceScope } from "./source-info.ts";
import type { WorkspaceIdentity } from "./workspace-identity.ts";

const NETWORK_TIMEOUT_MS = 10000;
const UPDATE_CHECK_CONCURRENCY = 4;
const GIT_UPDATE_CONCURRENCY = 4;

export type InstalledSourceScope = Exclude<SourceScope, "temporary">;
export type ProgressEventType = "start" | "progress" | "complete" | "error";
export type PackageUpdateType = "npm" | "git";

function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

// pi-ignore noNearIdenticalDataStructures: Package paths require fully resolved scope and origin, while synthetic source options may omit them to request source-info defaults.
export interface PathMetadata {
	source: string;
	scope: SourceScope;
	origin: SourceOrigin;
	baseDir?: string;
	workspace?: WorkspaceIdentity;
}

export interface ResolvedResource {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
}

export interface ResolvedPaths {
	extensions: ResolvedResource[];
	skills: ResolvedResource[];
	rules: ResolvedResource[];
	prompts: ResolvedResource[];
	themes: ResolvedResource[];
}

export type MissingSourceAction = "install" | "skip" | "error";

export type ProgressAction = "install" | "remove" | "update" | "clone" | "pull";

export interface ProgressEvent {
	type: ProgressEventType;
	action: ProgressAction;
	source: string;
	message?: string;
}

export type ProgressCallback = (event: ProgressEvent) => void;

export interface PackageUpdate {
	source: string;
	displayName: string;
	type: PackageUpdateType;
	scope: InstalledSourceScope;
}

export interface ConfiguredPackage {
	source: string;
	scope: InstalledSourceScope;
	filtered: boolean;
	installedPath?: string;
}

export interface PackageScopeOptions {
	local?: boolean;
}

export interface ExtensionSourceResolutionOptions extends PackageScopeOptions {
	temporary?: boolean;
}

export interface PackageManager {
	resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths>;
	install(source: string, options?: PackageScopeOptions): Promise<void>;
	installAndPersist(source: string, options?: PackageScopeOptions): Promise<void>;
	remove(source: string, options?: PackageScopeOptions): Promise<void>;
	removeAndPersist(source: string, options?: PackageScopeOptions): Promise<boolean>;
	update(source?: string): Promise<void>;
	listConfiguredPackages(): ConfiguredPackage[];
	resolveExtensionSources(sources: string[], options?: ExtensionSourceResolutionOptions): Promise<ResolvedPaths>;
	addSourceToSettings(source: string, options?: PackageScopeOptions): boolean;
	removeSourceFromSettings(source: string, options?: PackageScopeOptions): boolean;
	setProgressCallback(callback: ProgressCallback | undefined): void;
	getInstalledPath(source: string, scope: InstalledSourceScope): string | undefined;
}

interface PackageManagerOptions {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
}
type NpmSource = {
	type: "npm";
	spec: string;
	name: string;
	pinned: boolean;
};

type LocalSource = {
	type: "local";
	path: string;
};

type ParsedSource = NpmSource | GitSource | LocalSource;
interface ConfiguredUpdateSource {
	source: string;
	scope: InstalledSourceScope;
}

interface NpmUpdateTarget extends ConfiguredUpdateSource {
	parsed: NpmSource;
}

interface GitUpdateTarget extends ConfiguredUpdateSource {
	parsed: GitSource;
}

interface PackageUpdateCandidates {
	npm: NpmUpdateTarget[];
	git: GitUpdateTarget[];
}

interface ScopedPackageSource {
	pkg: PackageSource;
	scope: SourceScope;
}

interface InstalledPackageSource extends ScopedPackageSource {
	scope: InstalledSourceScope;
}

interface ManagedPackageResolutionContext {
	source: string;
	scope: SourceScope;
	accumulator: ResourceAccumulator;
	filter: PackageFilter | undefined;
	metadata: PathMetadata;
	onMissing: ((source: string) => Promise<MissingSourceAction>) | undefined;
}

interface AccumulatedResource {
	metadata: PathMetadata;
	enabled: boolean;
}

type ResourceMap = Map<string, AccumulatedResource>;

interface ResourceAccumulator {
	extensions: ResourceMap;
	skills: ResourceMap;
	rules: ResourceMap;
	prompts: ResourceMap;
	themes: ResourceMap;
}

// pi-ignore noNearIdenticalDataStructures: This private checkout plan is mirrored only by a test facade for private-method verification and must not become a published API.
interface GitCheckoutTarget {
	ref: string;
	head: string;
	fetchArgs: string[];
}

// pi-ignore noNearIdenticalDataStructures: Parsed npm identity/version data and LSP client metadata have unrelated validation and ownership.
interface ParsedNpmSpec {
	name: string;
	version?: string;
}

// pi-ignore noNearIdenticalDataStructures: Package-manager invocations and RPC client startup commands evolve under separate configuration and process lifecycles.
interface PackageManagerCommand {
	command: string;
	args: string[];
}

interface ManifestFileCollection {
	allFiles: string[];
	enabledByManifest: Set<string>;
}

interface PnpmGlobalDependencyMetadata {
	path?: string;
}

interface CommandWorkingDirectoryOptions {
	cwd?: string;
}

interface CommandEnvironmentOptions extends CommandWorkingDirectoryOptions {
	env?: Record<string, string>;
}

interface CommandCaptureOptions extends CommandEnvironmentOptions {
	timeoutMs?: number;
}

/**
 * Compute a numeric precedence rank for a resource based on its metadata.
 * Lower rank = higher precedence. Used to sort resolved resources so that
 * name-collision resolution ("first wins") produces the correct outcome.
 *
 * Precedence (highest to lowest):
 *   0  project + settings entry (source: "local", scope: "project")
 *   1  project + auto-discovered (source: "auto", scope: "project")
 *   2  user + settings entry (source: "local", scope: "user")
 *   3  user + auto-discovered (source: "auto", scope: "user")
 *   4  package resource (origin: "package")
 */
function resourcePrecedenceRank(m: PathMetadata): number {
	if (m.origin === "package") return 4;
	const scopeBase = m.scope === "project" ? 0 : 2;
	return scopeBase + (m.source === "local" ? 0 : 1);
}

type PackageFilter = Omit<Exclude<PackageSource, string>, "source">;

type ResourceType = "extensions" | "skills" | "rules" | "prompts" | "themes";

const RESOURCE_TYPES: ResourceType[] = ["extensions", "skills", "rules", "prompts", "themes"];

const FILE_PATTERNS: Record<ResourceType, RegExp> = {
	extensions: /\.(ts|js)$/,
	skills: /\.md$/,
	rules: /\.md$/,
	prompts: /\.md$/,
	themes: /\.json$/,
};

const IGNORE_FILE_NAMES = new Set([".gitignore", ".ignore", ".fdignore"]);

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

function isPathWithin(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}

function getHomeDir(): string {
	return process.env.HOME || homedir();
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

function addIgnoreRules(ig: ignore.Ignore, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {}
	}
}

function isPattern(s: string): boolean {
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-") || s.includes("*") || s.includes("?");
}

function isOverridePattern(s: string): boolean {
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-");
}

function hasGlobPattern(s: string): boolean {
	return s.includes("*") || s.includes("?");
}
interface PatternPartition {
	plain: string[];
	patterns: string[];
}

interface FileCollectionContext {
	filePattern: RegExp;
	skipNodeModules: boolean;
	ignoreMatcher: ignore.Ignore;
	rootDir: string;
	visited: Set<string>;
}

function splitPatterns(entries: string[]): PatternPartition {
	const plain: string[] = [];
	const patterns: string[] = [];
	for (const entry of entries) {
		if (isPattern(entry)) {
			patterns.push(entry);
		} else {
			plain.push(entry);
		}
	}
	return { plain, patterns };
}
function collectFileEntry(dir: string, entry: Dirent, context: FileCollectionContext): string[] {
	if (entry.name.startsWith(".")) return [];
	if (context.skipNodeModules && entry.name === "node_modules") return [];

	const fullPath = join(dir, entry.name);
	let isDirectory = entry.isDirectory();
	let isFile = entry.isFile();
	if (entry.isSymbolicLink()) {
		try {
			const stats = statSync(fullPath);
			isDirectory = stats.isDirectory();
			isFile = stats.isFile();
		} catch {
			return [];
		}
	}

	const relPath = toPosixPath(relative(context.rootDir, fullPath));
	const ignorePath = isDirectory ? `${relPath}/` : relPath;
	if (context.ignoreMatcher.ignores(ignorePath)) return [];
	if (isDirectory) {
		return collectFiles(
			fullPath,
			context.filePattern,
			context.skipNodeModules,
			context.ignoreMatcher,
			context.rootDir,
			context.visited,
		);
	}
	return isFile && context.filePattern.test(entry.name) ? [fullPath] : [];
}

function collectFiles(
	dir: string,
	filePattern: RegExp,
	skipNodeModules = true,
	ignoreMatcher?: ignore.Ignore,
	rootDir?: string,
	visited = new Set<string>(),
): string[] {
	const files: string[] = [];
	if (!existsSync(dir)) return files;
	let canonicalDir: string;
	try {
		canonicalDir = realpathSync(dir);
	} catch {
		return files;
	}
	if (visited.has(canonicalDir)) return files;
	visited.add(canonicalDir);

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);
	const context: FileCollectionContext = {
		filePattern,
		skipNodeModules,
		ignoreMatcher: ig,
		rootDir: root,
		visited,
	};
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) files.push(...collectFileEntry(dir, entry, context));
	} catch {
		// Ignore errors
	}

	return files;
}

type InstructionDiscoveryMode = "pi" | "agents";
type InstructionEntryFileName = "SKILL.md" | "RULES.md";

interface DirectoryEntryKind {
	isDirectory: boolean;
	isFile: boolean;
}

interface InstructionCollectionContext {
	entryFileName: InstructionEntryFileName;
	mode: InstructionDiscoveryMode;
	ignoreMatcher: ignore.Ignore;
	rootDir: string;
	visited: Set<string>;
}

function resolveDirectoryEntryKind(fullPath: string, entry: Dirent): DirectoryEntryKind | undefined {
	if (!entry.isSymbolicLink()) {
		return { isDirectory: entry.isDirectory(), isFile: entry.isFile() };
	}
	try {
		const stats = statSync(fullPath);
		return { isDirectory: stats.isDirectory(), isFile: stats.isFile() };
	} catch {
		return undefined;
	}
}

function findDirectInstructionFile(
	dir: string,
	directoryEntries: Dirent[],
	context: InstructionCollectionContext,
): string | undefined {
	for (const entry of directoryEntries) {
		if (entry.name !== context.entryFileName) continue;
		const fullPath = join(dir, entry.name);
		const kind = resolveDirectoryEntryKind(fullPath, entry);
		const relPath = toPosixPath(relative(context.rootDir, fullPath));
		if (kind?.isFile && !context.ignoreMatcher.ignores(relPath)) return fullPath;
	}
	return undefined;
}

function collectInstructionDirectoryEntries(
	dir: string,
	directoryEntries: Dirent[],
	context: InstructionCollectionContext,
	entries: string[],
): void {
	for (const entry of directoryEntries) {
		if (entry.name.startsWith(".")) continue;
		if (entry.name === "node_modules") continue;
		const fullPath = join(dir, entry.name);
		const kind = resolveDirectoryEntryKind(fullPath, entry);
		if (!kind) continue;
		const relPath = toPosixPath(relative(context.rootDir, fullPath));
		if (
			context.mode === "pi" &&
			dir === context.rootDir &&
			kind.isFile &&
			entry.name.endsWith(".md") &&
			!context.ignoreMatcher.ignores(relPath)
		) {
			entries.push(fullPath);
			continue;
		}
		if (!kind.isDirectory || context.ignoreMatcher.ignores(`${relPath}/`)) continue;
		entries.push(...collectInstructionEntries(fullPath, context));
	}
}

function collectInstructionEntries(dir: string, context: InstructionCollectionContext): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;
	let canonicalDir: string;
	try {
		canonicalDir = realpathSync(dir);
	} catch {
		return entries;
	}
	if (context.visited.has(canonicalDir)) return entries;
	context.visited.add(canonicalDir);
	addIgnoreRules(context.ignoreMatcher, dir, context.rootDir);
	try {
		const directoryEntries = readdirSync(dir, { withFileTypes: true });
		const directFile = findDirectInstructionFile(dir, directoryEntries, context);
		if (directFile) return [directFile];
		collectInstructionDirectoryEntries(dir, directoryEntries, context, entries);
	} catch {
		// Ignore errors
	}
	return entries;
}

function collectSkillEntries(
	dir: string,
	mode: InstructionDiscoveryMode,
	ignoreMatcher?: ignore.Ignore,
	rootDir?: string,
	visited = new Set<string>(),
): string[] {
	return collectInstructionEntries(dir, {
		entryFileName: "SKILL.md",
		mode,
		ignoreMatcher: ignoreMatcher ?? ignore(),
		rootDir: rootDir ?? dir,
		visited,
	});
}

function collectAutoSkillEntries(dir: string, mode: InstructionDiscoveryMode): string[] {
	return collectSkillEntries(dir, mode);
}

function collectRuleEntries(
	dir: string,
	mode: InstructionDiscoveryMode,
	ignoreMatcher?: ignore.Ignore,
	rootDir?: string,
	visited = new Set<string>(),
): string[] {
	return collectInstructionEntries(dir, {
		entryFileName: "RULES.md",
		mode,
		ignoreMatcher: ignoreMatcher ?? ignore(),
		rootDir: rootDir ?? dir,
		visited,
	});
}

function collectAutoRuleEntries(dir: string, mode: InstructionDiscoveryMode): string[] {
	return collectRuleEntries(dir, mode);
}

function findGitRepoRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	while (true) {
		if (existsSync(join(dir, ".git"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

function collectAncestorAgentsSkillDirs(startDir: string): string[] {
	const skillDirs: string[] = [];
	const resolvedStartDir = resolve(startDir);
	const gitRepoRoot = findGitRepoRoot(resolvedStartDir);

	let dir = resolvedStartDir;
	while (true) {
		skillDirs.push(join(dir, ".agents", "skills"));
		if (gitRepoRoot && dir === gitRepoRoot) {
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}

	return skillDirs;
}

function collectAncestorAgentsRuleDirs(startDir: string): string[] {
	const ruleDirs: string[] = [];
	const resolvedStartDir = resolve(startDir);
	const gitRepoRoot = findGitRepoRoot(resolvedStartDir);

	let dir = resolvedStartDir;
	while (true) {
		ruleDirs.push(join(dir, ".agents", "rules"));
		if (gitRepoRoot && dir === gitRepoRoot) {
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}

	return ruleDirs;
}

function collectAutoPromptEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			const kind = resolveDirectoryEntryKind(fullPath, entry);
			if (!kind) continue;
			const relPath = toPosixPath(relative(dir, fullPath));
			if (ig.ignores(relPath)) continue;
			if (kind.isFile && entry.name.endsWith(".md")) entries.push(fullPath);
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

function collectAutoThemeEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			const kind = resolveDirectoryEntryKind(fullPath, entry);
			if (!kind) continue;
			const relPath = toPosixPath(relative(dir, fullPath));
			if (ig.ignores(relPath)) continue;
			if (kind.isFile && entry.name.endsWith(".json")) entries.push(fullPath);
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

function resolveExtensionEntries(dir: string): string[] | null {
	const packageJsonPath = join(dir, "package.json");
	if (existsSync(packageJsonPath)) {
		const manifest = readPiManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = resolve(dir, extPath);
				if (existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	const indexTs = join(dir, "index.ts");
	const indexJs = join(dir, "index.ts");
	if (existsSync(indexTs)) {
		return [indexTs];
	}
	if (existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

function collectAutoExtensionDirectoryEntry(dir: string, entry: Dirent, ignoreMatcher: ignore.Ignore): string[] {
	if (entry.name.startsWith(".")) return [];
	if (entry.name === "node_modules") return [];
	const fullPath = join(dir, entry.name);
	const kind = resolveDirectoryEntryKind(fullPath, entry);
	if (!kind) return [];
	const relPath = toPosixPath(relative(dir, fullPath));
	const ignorePath = kind.isDirectory ? `${relPath}/` : relPath;
	if (ignoreMatcher.ignores(ignorePath)) return [];
	if (kind.isFile) return entry.name.endsWith(".ts") ? [fullPath] : [];
	if (!kind.isDirectory) return [];
	return resolveExtensionEntries(fullPath) ?? [];
}

function collectAutoExtensionEntries(dir: string): string[] {
	if (!existsSync(dir)) return [];
	// An explicit package manifest or index takes precedence over child discovery.
	const rootEntries = resolveExtensionEntries(dir);
	if (rootEntries) return rootEntries;

	const entries: string[] = [];
	const ignoreMatcher = ignore();
	addIgnoreRules(ignoreMatcher, dir, dir);
	try {
		const directoryEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of directoryEntries) {
			entries.push(...collectAutoExtensionDirectoryEntry(dir, entry, ignoreMatcher));
		}
	} catch {
		// Ignore errors
	}
	return entries;
}

/**
 * Collect resource files from a directory based on resource type.
 * Extensions use smart discovery (index.ts in subdirs), others use recursive collection.
 */
function collectResourceFiles(dir: string, resourceType: ResourceType): string[] {
	if (resourceType === "skills") {
		return collectSkillEntries(dir, "pi");
	}
	if (resourceType === "rules") {
		return collectRuleEntries(dir, "pi");
	}
	if (resourceType === "extensions") {
		return collectAutoExtensionEntries(dir);
	}
	return collectFiles(dir, FILE_PATTERNS[resourceType]);
}

function matchesAnyPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isDirectoryResourceFile = name === "SKILL.md" || name === "RULES.md";
	const parentDir = isDirectoryResourceFile ? dirname(filePath) : undefined;
	const parentRel = isDirectoryResourceFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentName = isDirectoryResourceFile ? basename(parentDir!) : undefined;
	const parentDirPosix = isDirectoryResourceFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalizedPattern = toPosixPath(pattern);
		if (
			minimatch(rel, normalizedPattern) ||
			minimatch(name, normalizedPattern) ||
			minimatch(filePathPosix, normalizedPattern)
		) {
			return true;
		}
		if (!isDirectoryResourceFile) return false;
		return (
			minimatch(parentRel!, normalizedPattern) ||
			minimatch(parentName!, normalizedPattern) ||
			minimatch(parentDirPosix!, normalizedPattern)
		);
	});
}

function normalizeExactPattern(pattern: string): string {
	const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	return toPosixPath(normalized);
}

function matchesAnyExactPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	if (patterns.length === 0) return false;
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isDirectoryResourceFile = name === "SKILL.md" || name === "RULES.md";
	const parentDir = isDirectoryResourceFile ? dirname(filePath) : undefined;
	const parentRel = isDirectoryResourceFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentDirPosix = isDirectoryResourceFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalized = normalizeExactPattern(pattern);
		if (normalized === rel || normalized === filePathPosix) {
			return true;
		}
		if (!isDirectoryResourceFile) return false;
		return normalized === parentRel || normalized === parentDirPosix;
	});
}

function getOverridePatterns(entries: string[]): string[] {
	return entries.filter((pattern) => pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-"));
}

function isEnabledByOverrides(filePath: string, patterns: string[], baseDir: string): boolean {
	const overrides = getOverridePatterns(patterns);
	const excludes = overrides.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
	const forceIncludes = overrides.filter((pattern) => pattern.startsWith("+")).map((pattern) => pattern.slice(1));
	const forceExcludes = overrides.filter((pattern) => pattern.startsWith("-")).map((pattern) => pattern.slice(1));

	let enabled = true;
	if (excludes.length > 0 && matchesAnyPattern(filePath, excludes, baseDir)) {
		enabled = false;
	}
	if (forceIncludes.length > 0 && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
		enabled = true;
	}
	if (forceExcludes.length > 0 && matchesAnyExactPattern(filePath, forceExcludes, baseDir)) {
		enabled = false;
	}
	return enabled;
}

/**
 * Apply patterns to paths and return a Set of enabled paths.
 * Pattern types:
 * - Plain patterns: include matching paths
 * - `!pattern`: exclude matching paths
 * - `+path`: force-include exact path (overrides exclusions)
 * - `-path`: force-exclude exact path (overrides force-includes)
 */
interface PackagePatternGroups {
	includes: string[];
	excludes: string[];
	forceIncludes: string[];
	forceExcludes: string[];
}

function groupPackagePatterns(patterns: string[]): PackagePatternGroups {
	const groups: PackagePatternGroups = { includes: [], excludes: [], forceIncludes: [], forceExcludes: [] };
	for (const pattern of patterns) {
		if (pattern.startsWith("+")) {
			groups.forceIncludes.push(pattern.slice(1));
		} else if (pattern.startsWith("-")) {
			groups.forceExcludes.push(pattern.slice(1));
		} else if (pattern.startsWith("!")) {
			groups.excludes.push(pattern.slice(1));
		} else {
			groups.includes.push(pattern);
		}
	}
	return groups;
}

function applyPatterns(allPaths: string[], patterns: string[], baseDir: string): Set<string> {
	const { includes, excludes, forceIncludes, forceExcludes } = groupPackagePatterns(patterns);

	// Step 1: Apply includes (or all if no includes)
	let result: string[];
	if (includes.length === 0) {
		result = [...allPaths];
	} else {
		result = allPaths.filter((filePath) => matchesAnyPattern(filePath, includes, baseDir));
	}

	// Step 2: Apply excludes
	if (excludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyPattern(filePath, excludes, baseDir));
	}

	// Step 3: Force-include (add back from allPaths, overriding exclusions)
	if (forceIncludes.length > 0) {
		const includedPaths = new Set(result);
		for (const filePath of allPaths) {
			if (!includedPaths.has(filePath) && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
				includedPaths.add(filePath);
				result.push(filePath);
			}
		}
	}

	// Step 4: Force-exclude (remove even if included or force-included)
	if (forceExcludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyExactPattern(filePath, forceExcludes, baseDir));
	}

	return new Set(result);
}

export class DefaultPackageManager implements PackageManager {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;
	private globalNpmRoot: string | undefined;
	private globalNpmRootCommandKey: string | undefined;
	private progressCallback: ProgressCallback | undefined;

	constructor(options: PackageManagerOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager;
	}

	setProgressCallback(callback: ProgressCallback | undefined): void {
		this.progressCallback = callback;
	}

	addSourceToSettings(source: string, options?: PackageScopeOptions): boolean {
		const scope: SourceScope = options?.local ? "project" : "user";
		const currentSettings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
		const currentPackages = currentSettings.packages ?? [];
		const normalizedSource = this.normalizePackageSourceForSettings(source, scope);
		const matchIndex = currentPackages.findIndex((existing) => this.packageSourcesMatch(existing, source, scope));
		if (matchIndex !== -1) {
			const existing = currentPackages[matchIndex];
			if (this.getPackageSourceString(existing) === normalizedSource) {
				return false;
			}
			const nextPackages = [...currentPackages];
			nextPackages[matchIndex] =
				typeof existing === "string" ? normalizedSource : { ...existing, source: normalizedSource };
			if (scope === "project") {
				this.settingsManager.setProjectPackages(nextPackages);
			} else {
				this.settingsManager.setPackages(nextPackages);
			}
			return true;
		}
		const nextPackages = [...currentPackages, normalizedSource];
		if (scope === "project") {
			this.settingsManager.setProjectPackages(nextPackages);
		} else {
			this.settingsManager.setPackages(nextPackages);
		}
		return true;
	}

	removeSourceFromSettings(source: string, options?: PackageScopeOptions): boolean {
		const scope: SourceScope = options?.local ? "project" : "user";
		const currentSettings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
		const currentPackages = currentSettings.packages ?? [];
		const nextPackages = currentPackages.filter((existing) => !this.packageSourcesMatch(existing, source, scope));
		const changed = nextPackages.length !== currentPackages.length;
		if (!changed) {
			return false;
		}
		if (scope === "project") {
			this.settingsManager.setProjectPackages(nextPackages);
		} else {
			this.settingsManager.setPackages(nextPackages);
		}
		return true;
	}

	getInstalledPath(source: string, scope: InstalledSourceScope): string | undefined {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			const path = this.getNpmInstallPath(parsed, scope);
			return existsSync(path) ? path : undefined;
		}
		if (parsed.type === "git") {
			const path = this.getGitInstallPath(parsed, scope);
			return existsSync(path) ? path : undefined;
		}
		if (parsed.type === "local") {
			const baseDir = this.getBaseDirForScope(scope);
			const path = this.resolvePathFromBase(parsed.path, baseDir);
			return existsSync(path) ? path : undefined;
		}
		return undefined;
	}

	private emitProgress(event: ProgressEvent): void {
		this.progressCallback?.(event);
	}

	private async withProgress(
		action: ProgressAction,
		source: string,
		message: string,
		operation: () => Promise<void>,
	): Promise<void> {
		this.emitProgress({ type: "start", action, source, message });
		try {
			await operation();
			this.emitProgress({ type: "complete", action, source });
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.emitProgress({ type: "error", action, source, message: errorMessage });
			throw error;
		}
	}

	async resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths> {
		const accumulator = this.createAccumulator();
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();

		// Collect all packages with scope (project first so cwd resources win collisions)
		const allPackages: ScopedPackageSource[] = [];
		for (const pkg of projectSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "project" });
		}
		for (const pkg of globalSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "user" });
		}

		// Dedupe: project scope wins over global for same package identity
		const packageSources = this.dedupePackages(allPackages);
		await this.resolvePackageSources(packageSources, accumulator, onMissing);

		const globalBaseDir = this.agentDir;
		const projectBaseDir = join(this.cwd, CONFIG_DIR_NAME);

		for (const resourceType of RESOURCE_TYPES) {
			const target = this.getTargetMap(accumulator, resourceType);
			const globalEntries = (globalSettings[resourceType] ?? []) as string[];
			const projectEntries = (projectSettings[resourceType] ?? []) as string[];
			this.resolveLocalEntries(
				projectEntries,
				resourceType,
				target,
				{
					source: "local",
					scope: "project",
					origin: "top-level",
				},
				projectBaseDir,
			);
			this.resolveLocalEntries(
				globalEntries,
				resourceType,
				target,
				{
					source: "local",
					scope: "user",
					origin: "top-level",
				},
				globalBaseDir,
			);
		}

		this.addAutoDiscoveredResources(accumulator, globalSettings, projectSettings, globalBaseDir, projectBaseDir);

		return this.toResolvedPaths(accumulator);
	}

	async resolveExtensionSources(
		sources: string[],
		options?: ExtensionSourceResolutionOptions,
	): Promise<ResolvedPaths> {
		const accumulator = this.createAccumulator();
		const scope: SourceScope = options?.temporary ? "temporary" : options?.local ? "project" : "user";
		const packageSources = sources.map((source) => ({ pkg: source as PackageSource, scope }));
		await this.resolvePackageSources(packageSources, accumulator);
		return this.toResolvedPaths(accumulator);
	}

	listConfiguredPackages(): ConfiguredPackage[] {
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const configuredPackages: ConfiguredPackage[] = [];

		for (const pkg of globalSettings.packages ?? []) {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			configuredPackages.push({
				source,
				scope: "user",
				filtered: typeof pkg === "object",
				installedPath: this.getInstalledPath(source, "user"),
			});
		}

		for (const pkg of projectSettings.packages ?? []) {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			configuredPackages.push({
				source,
				scope: "project",
				filtered: typeof pkg === "object",
				installedPath: this.getInstalledPath(source, "project"),
			});
		}

		return configuredPackages;
	}

	async install(source: string, options?: PackageScopeOptions): Promise<void> {
		const parsed = this.parseSource(source);
		const scope: SourceScope = options?.local ? "project" : "user";
		await this.withProgress("install", source, `Installing ${source}...`, async () => {
			if (parsed.type === "npm") {
				await this.installNpm(parsed, scope, false);
				return;
			}
			if (parsed.type === "git") {
				await this.installGit(parsed, scope);
				return;
			}
			if (parsed.type === "local") {
				const resolved = this.resolvePath(parsed.path);
				if (!existsSync(resolved)) {
					throw new Error(`Path does not exist: ${resolved}`);
				}
				return;
			}
			throw new Error(`Unsupported install source: ${source}`);
		});
	}

	async installAndPersist(source: string, options?: PackageScopeOptions): Promise<void> {
		await this.install(source, options);
		this.addSourceToSettings(source, options);
	}

	async remove(source: string, options?: PackageScopeOptions): Promise<void> {
		const parsed = this.parseSource(source);
		const scope: SourceScope = options?.local ? "project" : "user";
		await this.withProgress("remove", source, `Removing ${source}...`, async () => {
			if (parsed.type === "npm") {
				await this.uninstallNpm(parsed, scope);
				return;
			}
			if (parsed.type === "git") {
				await this.removeGit(parsed, scope);
				return;
			}
			if (parsed.type === "local") {
				return;
			}
			throw new Error(`Unsupported remove source: ${source}`);
		});
	}

	async removeAndPersist(source: string, options?: PackageScopeOptions): Promise<boolean> {
		await this.remove(source, options);
		return this.removeSourceFromSettings(source, options);
	}

	private collectConfiguredUpdateSources(
		packages: PackageSource[],
		scope: InstalledSourceScope,
		identity: string | undefined,
	): ConfiguredUpdateSource[] {
		const sources: ConfiguredUpdateSource[] = [];
		for (const pkg of packages) {
			const packageSource = typeof pkg === "string" ? pkg : pkg.source;
			if (identity && this.getPackageIdentity(packageSource, scope) !== identity) continue;
			sources.push({ source: packageSource, scope });
		}
		return sources;
	}

	async update(source?: string): Promise<void> {
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const globalPackages = globalSettings.packages ?? [];
		const projectPackages = projectSettings.packages ?? [];
		const identity = source ? this.getPackageIdentity(source) : undefined;
		const updateSources = [
			...this.collectConfiguredUpdateSources(globalPackages, "user", identity),
			...this.collectConfiguredUpdateSources(projectPackages, "project", identity),
		];

		if (source && updateSources.length === 0) {
			throw new Error(this.buildNoMatchingPackageMessage(source, [...globalPackages, ...projectPackages]));
		}
		await this.updateConfiguredSources(updateSources);
	}

	private classifyConfiguredUpdateSources(sources: ConfiguredUpdateSource[]): PackageUpdateCandidates {
		const candidates: PackageUpdateCandidates = { npm: [], git: [] };
		for (const entry of sources) {
			const parsed = this.parseSource(entry.source);
			// Pinned npm versions are fixed. Pinned git refs are configured checkout targets,
			// so include them to reconcile an existing clone when the configured ref changes.
			if (parsed.type === "npm") {
				if (!parsed.pinned) candidates.npm.push({ ...entry, parsed });
				continue;
			}
			if (parsed.type === "git") candidates.git.push({ ...entry, parsed });
		}
		return candidates;
	}

	private async updateConfiguredSources(sources: ConfiguredUpdateSource[]): Promise<void> {
		if (isOfflineModeEnabled() || sources.length === 0) {
			return;
		}

		const candidates = this.classifyConfiguredUpdateSources(sources);

		const npmCheckTasks = candidates.npm.map((entry) => async () => ({
			entry,
			shouldUpdate: await this.shouldUpdateNpmSource(entry.parsed, entry.scope),
		}));
		const npmCheckResults = await this.runWithConcurrency(npmCheckTasks, UPDATE_CHECK_CONCURRENCY);
		const userNpmUpdates: NpmUpdateTarget[] = [];
		const projectNpmUpdates: NpmUpdateTarget[] = [];
		for (const result of npmCheckResults) {
			if (!result.shouldUpdate) {
				continue;
			}
			if (result.entry.scope === "user") {
				userNpmUpdates.push(result.entry);
			} else {
				projectNpmUpdates.push(result.entry);
			}
		}

		const tasks: Promise<void>[] = [];
		if (userNpmUpdates.length > 0) {
			tasks.push(this.updateNpmBatch(userNpmUpdates, "user"));
		}
		if (projectNpmUpdates.length > 0) {
			tasks.push(this.updateNpmBatch(projectNpmUpdates, "project"));
		}
		if (candidates.git.length > 0) {
			const gitTasks = candidates.git.map(
				(entry) => async () =>
					this.withProgress("update", entry.source, `Updating ${entry.source}...`, async () => {
						await this.updateGit(entry.parsed, entry.scope);
					}),
			);
			tasks.push(this.runWithConcurrency(gitTasks, GIT_UPDATE_CONCURRENCY).then(() => {}));
		}

		await Promise.all(tasks);
	}

	private async shouldUpdateNpmSource(source: NpmSource, scope: InstalledSourceScope): Promise<boolean> {
		const installedPath = this.getManagedNpmInstallPath(source, scope);
		const installedVersion = existsSync(installedPath) ? this.getInstalledNpmVersion(installedPath) : undefined;
		if (!installedVersion) {
			return true;
		}

		try {
			const latestVersion = await this.getLatestNpmVersion(source.name);
			return latestVersion !== installedVersion;
		} catch {
			// Preserve existing update behavior when version lookup fails.
			return true;
		}
	}

	private async updateNpmBatch(sources: NpmUpdateTarget[], scope: InstalledSourceScope): Promise<void> {
		if (sources.length === 0) {
			return;
		}

		const sourceLabel = sources.length === 1 ? sources[0].source : `${scope} npm packages`;
		const message = sources.length === 1 ? `Updating ${sources[0].source}...` : `Updating ${scope} npm packages...`;
		const specs = sources.map((entry) => `${entry.parsed.name}@latest`);

		await this.withProgress("update", sourceLabel, message, async () => {
			await this.installNpmBatch(specs, scope);
		});
	}

	private async installNpmBatch(specs: string[], scope: InstalledSourceScope): Promise<void> {
		const installRoot = this.getNpmInstallRoot(scope, false);
		this.ensureNpmProject(installRoot);
		await this.runNpmCommand(this.getNpmInstallArgs(specs, installRoot));
	}
	private async getAvailableNpmUpdate(
		source: string,
		parsed: NpmSource,
		scope: InstalledSourceScope,
	): Promise<PackageUpdate | undefined> {
		const installedPath = this.getNpmInstallPath(parsed, scope);
		if (!existsSync(installedPath)) return undefined;
		if (!(await this.npmHasAvailableUpdate(parsed, installedPath))) return undefined;
		return { source, displayName: parsed.name, type: "npm", scope };
	}

	private async getAvailableGitUpdate(
		source: string,
		parsed: GitSource,
		scope: InstalledSourceScope,
	): Promise<PackageUpdate | undefined> {
		const installedPath = this.getGitInstallPath(parsed, scope);
		if (!existsSync(installedPath)) return undefined;
		if (!(await this.gitHasAvailableUpdate(installedPath))) return undefined;
		return { source, displayName: `${parsed.host}/${parsed.path}`, type: "git", scope };
	}

	async checkForAvailableUpdates(): Promise<PackageUpdate[]> {
		if (isOfflineModeEnabled()) {
			return [];
		}

		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const allPackages: ScopedPackageSource[] = [];
		for (const pkg of projectSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "project" });
		}
		for (const pkg of globalSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "user" });
		}

		const packageSources = this.dedupePackages(allPackages);
		const checks = packageSources
			.filter((entry): entry is InstalledPackageSource => entry.scope !== "temporary")
			.map((entry) => async (): Promise<PackageUpdate | undefined> => {
				const source = typeof entry.pkg === "string" ? entry.pkg : entry.pkg.source;
				const parsed = this.parseSource(source);
				if (parsed.type === "local" || parsed.pinned) return undefined;
				if (parsed.type === "npm") return this.getAvailableNpmUpdate(source, parsed, entry.scope);
				return this.getAvailableGitUpdate(source, parsed, entry.scope);
			});

		const results = await this.runWithConcurrency(checks, UPDATE_CHECK_CONCURRENCY);
		return results.filter((result): result is PackageUpdate => result !== undefined);
	}

	private async resolvePackageSources(
		sources: ScopedPackageSource[],
		accumulator: ResourceAccumulator,
		onMissing?: (source: string) => Promise<MissingSourceAction>,
	): Promise<void> {
		for (const { pkg, scope } of sources) {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			const filter = typeof pkg === "object" ? pkg : undefined;
			const parsed = this.parseSource(source);
			const metadata: PathMetadata = { source, scope, origin: "package" };

			if (parsed.type === "local") {
				const baseDir = this.getBaseDirForScope(scope);
				this.resolveLocalExtensionSource(parsed, accumulator, filter, metadata, baseDir);
				continue;
			}

			const context: ManagedPackageResolutionContext = {
				source,
				scope,
				accumulator,
				filter,
				metadata,
				onMissing,
			};
			if (parsed.type === "npm") {
				await this.resolveNpmPackageSource(parsed, context);
				continue;
			}
			await this.resolveGitPackageSource(parsed, context);
		}
	}

	private async installMissingPackageSource(
		parsed: NpmSource | GitSource,
		context: ManagedPackageResolutionContext,
	): Promise<boolean> {
		if (isOfflineModeEnabled()) return false;
		if (!context.onMissing) {
			await this.installParsedSource(parsed, context.scope);
			return true;
		}

		const action = await context.onMissing(context.source);
		if (action === "skip") return false;
		if (action === "error") throw new Error(`Missing source: ${context.source}`);
		await this.installParsedSource(parsed, context.scope);
		return true;
	}

	private async resolveNpmPackageSource(source: NpmSource, context: ManagedPackageResolutionContext): Promise<void> {
		let installedPath = this.getNpmInstallPath(source, context.scope);
		const needsInstall =
			!existsSync(installedPath) ||
			(source.pinned && !(await this.installedNpmMatchesPinnedVersion(source, installedPath)));
		if (needsInstall) {
			const installed = await this.installMissingPackageSource(source, context);
			if (!installed) return;
			installedPath = this.getNpmInstallPath(source, context.scope);
		}
		context.metadata.baseDir = installedPath;
		this.collectPackageResources(installedPath, context.accumulator, context.filter, context.metadata);
	}

	private async resolveGitPackageSource(source: GitSource, context: ManagedPackageResolutionContext): Promise<void> {
		const installedPath = this.getGitInstallPath(source, context.scope);
		if (!existsSync(installedPath)) {
			const installed = await this.installMissingPackageSource(source, context);
			if (!installed) return;
		} else if (context.scope === "temporary" && !source.pinned && !isOfflineModeEnabled()) {
			await this.refreshTemporaryGitSource(source, context.source);
		}
		context.metadata.baseDir = installedPath;
		this.collectManagedGitPackageResources(installedPath, context.accumulator, context.filter, context.metadata);
	}

	private resolveLocalExtensionSource(
		source: LocalSource,
		accumulator: ResourceAccumulator,
		filter: PackageFilter | undefined,
		metadata: PathMetadata,
		baseDir: string,
	): void {
		const resolved = this.resolvePathFromBase(source.path, baseDir);
		if (!existsSync(resolved)) {
			return;
		}

		try {
			const stats = statSync(resolved);
			if (stats.isFile()) {
				metadata.baseDir = dirname(resolved);
				this.addResource(accumulator.extensions, resolved, metadata, true);
				return;
			}
			if (stats.isDirectory()) {
				metadata.baseDir = resolved;
				const resources = this.collectPackageResources(resolved, accumulator, filter, metadata);
				if (!resources) {
					this.addResource(accumulator.extensions, resolved, metadata, true);
				}
			}
		} catch {
			return;
		}
	}

	private async installParsedSource(parsed: ParsedSource, scope: SourceScope): Promise<void> {
		if (parsed.type === "npm") {
			await this.installNpm(parsed, scope, scope === "temporary");
			return;
		}
		if (parsed.type === "git") {
			await this.installGit(parsed, scope);
			return;
		}
	}

	private getPackageSourceString(pkg: PackageSource): string {
		return typeof pkg === "string" ? pkg : pkg.source;
	}

	private getSourceMatchKeyForInput(source: string): string {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			return `npm:${parsed.name}`;
		}
		if (parsed.type === "git") {
			return `git:${parsed.host}/${parsed.path}`;
		}
		return `local:${this.resolvePath(parsed.path)}`;
	}

	private getSourceMatchKeyForSettings(source: string, scope: SourceScope): string {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			return `npm:${parsed.name}`;
		}
		if (parsed.type === "git") {
			return `git:${parsed.host}/${parsed.path}`;
		}
		const baseDir = this.getBaseDirForScope(scope);
		return `local:${this.resolvePathFromBase(parsed.path, baseDir)}`;
	}

	private buildNoMatchingPackageMessage(source: string, configuredPackages: PackageSource[]): string {
		const suggestion = this.findSuggestedConfiguredSource(source, configuredPackages);
		if (!suggestion) {
			return `No matching package found for ${source}`;
		}
		return `No matching package found for ${source}. Did you mean ${suggestion}?`;
	}
	private getConfiguredSourceAliases(source: string): string[] {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") return [parsed.name, parsed.spec];
		if (parsed.type !== "git") return [];
		const shorthand = `${parsed.host}/${parsed.path}`;
		return parsed.ref ? [shorthand, `${shorthand}@${parsed.ref}`] : [shorthand];
	}

	private findSuggestedConfiguredSource(source: string, configuredPackages: PackageSource[]): string | undefined {
		const trimmedSource = source.trim();
		const suggestions = new Set<string>();

		for (const pkg of configuredPackages) {
			const sourceStr = this.getPackageSourceString(pkg);
			if (this.getConfiguredSourceAliases(sourceStr).includes(trimmedSource)) suggestions.add(sourceStr);
		}

		return suggestions.values().next().value;
	}

	private packageSourcesMatch(existing: PackageSource, inputSource: string, scope: SourceScope): boolean {
		const left = this.getSourceMatchKeyForSettings(this.getPackageSourceString(existing), scope);
		const right = this.getSourceMatchKeyForInput(inputSource);
		return left === right;
	}

	private normalizePackageSourceForSettings(source: string, scope: SourceScope): string {
		const parsed = this.parseSource(source);
		if (parsed.type !== "local") {
			return source;
		}
		const baseDir = this.getBaseDirForScope(scope);
		const resolved = this.resolvePath(parsed.path);
		const rel = relative(baseDir, resolved);
		return rel || ".";
	}

	private parseSource(source: string): ParsedSource {
		if (source.startsWith("npm:")) {
			const spec = source.slice("npm:".length).trim();
			const { name, version } = this.parseNpmSpec(spec);
			return {
				type: "npm",
				spec,
				name,
				pinned: Boolean(version),
			};
		}

		if (isLocalPath(source)) {
			return { type: "local", path: source };
		}

		// Try parsing as git URL
		const gitParsed = parseGitUrl(source);
		if (gitParsed) {
			return gitParsed;
		}
		if (!isLocalPath(source)) {
			throw new Error(`Unsafe or invalid Git package source: ${source}`);
		}

		return { type: "local", path: source };
	}

	private async installedNpmMatchesPinnedVersion(source: NpmSource, installedPath: string): Promise<boolean> {
		const installedVersion = this.getInstalledNpmVersion(installedPath);
		if (!installedVersion) {
			return false;
		}

		const { version: pinnedVersion } = this.parseNpmSpec(source.spec);
		if (!pinnedVersion) {
			return true;
		}

		return installedVersion === pinnedVersion;
	}

	private async npmHasAvailableUpdate(source: NpmSource, installedPath: string): Promise<boolean> {
		if (isOfflineModeEnabled()) {
			return false;
		}

		const installedVersion = this.getInstalledNpmVersion(installedPath);
		if (!installedVersion) {
			return false;
		}

		try {
			const latestVersion = await this.getLatestNpmVersion(source.name);
			return latestVersion !== installedVersion;
		} catch {
			return false;
		}
	}

	private getInstalledNpmVersion(installedPath: string): string | undefined {
		const packageJsonPath = join(installedPath, "package.json");
		if (!existsSync(packageJsonPath)) return undefined;
		try {
			const content = readFileSync(packageJsonPath, "utf-8");
			const pkg = JSON.parse(content) as { version?: string };
			return pkg.version;
		} catch {
			return undefined;
		}
	}

	private async getLatestNpmVersion(packageName: string): Promise<string> {
		const npmCommand = this.getNpmCommand();
		const stdout = await this.runCommandCapture(
			npmCommand.command,
			[...npmCommand.args, "view", packageName, "version", "--json"],
			{ cwd: this.cwd, timeoutMs: NETWORK_TIMEOUT_MS },
		);
		const raw = stdout.trim();
		if (!raw) throw new Error("Empty response from npm view");
		return JSON.parse(raw);
	}

	private async gitHasAvailableUpdate(installedPath: string): Promise<boolean> {
		if (isOfflineModeEnabled()) {
			return false;
		}

		try {
			const localHead = await this.runCommandCapture("git", ["rev-parse", "HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const remoteHead = await this.getRemoteGitHead(installedPath);
			return localHead.trim() !== remoteHead.trim();
		} catch {
			return false;
		}
	}

	private async getRemoteGitHead(installedPath: string): Promise<string> {
		const upstreamRef = await this.getGitUpstreamRef(installedPath);
		if (upstreamRef) {
			const remoteHead = await this.runGitRemoteCommand(installedPath, ["ls-remote", "origin", upstreamRef]);
			const match = remoteHead.match(/^([0-9a-f]{40})\s+/m);
			if (match?.[1]) {
				return match[1];
			}
		}

		const remoteHead = await this.runGitRemoteCommand(installedPath, ["ls-remote", "origin", "HEAD"]);
		const match = remoteHead.match(/^([0-9a-f]{40})\s+HEAD$/m);
		if (!match?.[1]) {
			throw new Error("Failed to determine remote HEAD");
		}
		return match[1];
	}

	private async getLocalGitUpdateTarget(installedPath: string): Promise<GitCheckoutTarget> {
		try {
			const upstream = await this.runCommandCapture("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const trimmedUpstream = upstream.trim();
			if (!trimmedUpstream.startsWith("origin/")) {
				throw new Error(`Unsupported upstream remote: ${trimmedUpstream}`);
			}
			const branch = trimmedUpstream.slice("origin/".length);
			if (!branch) {
				throw new Error("Missing upstream branch name");
			}
			const head = await this.runCommandCapture("git", ["rev-parse", "@{upstream}"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			return {
				ref: "@{upstream}",
				head,
				fetchArgs: [
					"fetch",
					"--prune",
					"--no-tags",
					"origin",
					`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
				],
			};
		} catch {
			await this.runCommand("git", ["remote", "set-head", "origin", "-a"], { cwd: installedPath }).catch(() => {});
			const head = await this.runCommandCapture("git", ["rev-parse", "origin/HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const originHeadRef = await this.runCommandCapture("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			}).catch(() => "");
			const branch = originHeadRef.trim().replace(/^refs\/remotes\/origin\//, "");
			if (branch) {
				return {
					ref: "origin/HEAD",
					head,
					fetchArgs: [
						"fetch",
						"--prune",
						"--no-tags",
						"origin",
						`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
					],
				};
			}
			return {
				ref: "origin/HEAD",
				head,
				fetchArgs: ["fetch", "--prune", "--no-tags", "origin", "+HEAD:refs/remotes/origin/HEAD"],
			};
		}
	}

	private async getGitUpstreamRef(installedPath: string): Promise<string | undefined> {
		try {
			const upstream = await this.runCommandCapture("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const trimmed = upstream.trim();
			if (!trimmed.startsWith("origin/")) {
				return undefined;
			}
			const branch = trimmed.slice("origin/".length);
			return branch ? `refs/heads/${branch}` : undefined;
		} catch {
			return undefined;
		}
	}

	private runGitRemoteCommand(installedPath: string, args: string[]): Promise<string> {
		return this.runCommandCapture("git", args, {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
			env: {
				GIT_TERMINAL_PROMPT: "0",
			},
		});
	}

	private async runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
		if (tasks.length === 0) {
			return [];
		}

		const results: T[] = new Array(tasks.length);
		let nextIndex = 0;
		const workerCount = Math.max(1, Math.min(limit, tasks.length));

		const worker = async () => {
			while (true) {
				const index = nextIndex;
				nextIndex += 1;
				if (index >= tasks.length) {
					return;
				}
				results[index] = await tasks[index]();
			}
		};

		await Promise.all(Array.from({ length: workerCount }, () => worker()));
		return results;
	}

	/**
	 * Get a unique identity for a package, ignoring version/ref.
	 * Used to detect when the same package is in both global and project settings.
	 * For git packages, uses normalized host/path to ensure SSH and HTTPS URLs
	 * for the same repository are treated as identical.
	 */
	private getPackageIdentity(source: string, scope?: SourceScope): string {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			return `npm:${parsed.name}`;
		}
		if (parsed.type === "git") {
			// Use host/path for identity to normalize SSH and HTTPS
			return `git:${parsed.host}/${parsed.path}`;
		}
		if (scope) {
			const baseDir = this.getBaseDirForScope(scope);
			return `local:${this.resolvePathFromBase(parsed.path, baseDir)}`;
		}
		return `local:${this.resolvePath(parsed.path)}`;
	}

	/**
	 * Dedupe packages: if same package identity appears in both global and project,
	 * keep only the project one (project wins).
	 */
	private dedupePackages(packages: ScopedPackageSource[]): ScopedPackageSource[] {
		const seen = new Map<string, ScopedPackageSource>();

		for (const entry of packages) {
			const sourceStr = typeof entry.pkg === "string" ? entry.pkg : entry.pkg.source;
			const identity = this.getPackageIdentity(sourceStr, entry.scope);

			const existing = seen.get(identity);
			if (!existing) {
				seen.set(identity, entry);
			} else if (entry.scope === "project" && existing.scope === "user") {
				// Project wins over user
				seen.set(identity, entry);
			}
			// If existing is project and new is global, keep existing (project)
			// If both are same scope, keep first one
		}

		return Array.from(seen.values());
	}

	private parseNpmSpec(spec: string): ParsedNpmSpec {
		const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
		if (!match) {
			return { name: spec };
		}
		const name = match[1] ?? spec;
		const version = match[2];
		return { name, version };
	}

	private getNpmCommand(): PackageManagerCommand {
		const configuredCommand = this.settingsManager.getNpmCommand();
		if (!configuredCommand || configuredCommand.length === 0) {
			return { command: "npm", args: [] };
		}
		const [command, ...args] = configuredCommand;
		if (!command) {
			throw new Error("Invalid npmCommand: first array entry must be a non-empty command");
		}
		return { command, args };
	}

	private getPackageManagerName(): string {
		const npmCommand = this.getNpmCommand();
		const commandParts = [npmCommand.command, ...npmCommand.args];
		const separatorIndex = commandParts.lastIndexOf("--");
		const packageManagerCommand = separatorIndex >= 0 ? commandParts[separatorIndex + 1] : npmCommand.command;
		return packageManagerCommand ? basename(packageManagerCommand).replace(/\.(cmd|exe)$/i, "") : "";
	}

	private async runNpmCommand(args: string[], options?: CommandWorkingDirectoryOptions): Promise<void> {
		const npmCommand = this.getNpmCommand();
		await this.runCommand(npmCommand.command, [...npmCommand.args, ...args], options);
	}

	private getGitDependencyInstallArgs(): string[] {
		const configuredCommand = this.settingsManager.getNpmCommand();
		if (configuredCommand && configuredCommand.length > 0) {
			return ["install"];
		}
		return ["install", "--omit=dev"];
	}

	private runNpmCommandSync(args: string[]): string {
		const npmCommand = this.getNpmCommand();
		return this.runCommandSync(npmCommand.command, [...npmCommand.args, ...args]);
	}

	private getNpmInstallArgs(specs: string[], installRoot: string): string[] {
		const packageManagerName = this.getPackageManagerName();
		// Extension packages run inside pi and resolve pi APIs through loader aliases/virtual modules.
		// Disable peer dependency resolution for managed installs (npm's --legacy-peer-deps, and
		// equivalent bun/pnpm settings) so package managers do not install or solve host-provided
		// @fleetagent/pi-* peers. Stale auto-installed pi peers can otherwise block updates.
		if (packageManagerName === "bun") {
			return ["install", ...specs, "--cwd", installRoot, "--omit=peer"];
		}
		if (packageManagerName === "pnpm") {
			return [
				"install",
				...specs,
				"--prefix",
				installRoot,
				"--config.auto-install-peers=false",
				"--config.strict-peer-dependencies=false",
				"--config.strict-dep-builds=false",
			];
		}
		return ["install", ...specs, "--prefix", installRoot, "--legacy-peer-deps"];
	}

	private async installNpm(source: NpmSource, scope: SourceScope, temporary: boolean): Promise<void> {
		const installRoot = this.getNpmInstallRoot(scope, temporary);
		this.ensureNpmProject(installRoot);
		await this.runNpmCommand(this.getNpmInstallArgs([source.spec], installRoot));
	}

	private async uninstallNpm(source: NpmSource, scope: SourceScope): Promise<void> {
		const installRoot = this.getNpmInstallRoot(scope, false);
		if (!existsSync(installRoot)) {
			return;
		}
		if (this.getPackageManagerName() === "bun") {
			await this.runNpmCommand(["uninstall", source.name, "--cwd", installRoot]);
			return;
		}
		await this.runNpmCommand(["uninstall", source.name, "--prefix", installRoot]);
	}

	private async installGit(source: GitSource, scope: SourceScope): Promise<void> {
		const targetDir = this.getGitInstallPath(source, scope);
		if (existsSync(targetDir)) {
			this.assertGitTarget(source, scope, targetDir);
			if (source.ref) {
				await this.ensureGitRef(targetDir, ["fetch", "origin", source.ref], "FETCH_HEAD", source, scope);
				return;
			}
			const target = await this.getLocalGitUpdateTarget(targetDir);
			this.assertGitTarget(source, scope, targetDir);
			await this.ensureGitRef(targetDir, target.fetchArgs, target.ref, source, scope);
			return;
		}
		const gitRoot = this.getGitInstallRoot(scope);
		this.assertGitTarget(source, scope, targetDir);
		if (gitRoot) {
			this.ensureGitIgnore(gitRoot, true);
		}
		this.assertGitTarget(source, scope, targetDir);
		mkdirSync(dirname(targetDir), { recursive: true });
		this.assertGitTarget(source, scope, targetDir);

		await this.runCommand("git", ["clone", source.repo, targetDir]);
		this.assertGitTarget(source, scope, targetDir);
		if (source.ref) {
			await this.runCommand("git", ["checkout", source.ref], { cwd: targetDir });
			this.assertGitTarget(source, scope, targetDir);
		}
		const packageJsonPath = join(targetDir, "package.json");
		if (existsSync(packageJsonPath)) {
			this.assertConfinedResourcePath(packageJsonPath, targetDir);
			await this.runNpmCommand(this.getGitDependencyInstallArgs(), { cwd: targetDir });
		}
	}

	private async updateGit(source: GitSource, scope: SourceScope): Promise<void> {
		const targetDir = this.getGitInstallPath(source, scope);
		if (!existsSync(targetDir)) {
			await this.installGit(source, scope);
			return;
		}

		this.assertGitTarget(source, scope, targetDir);
		if (source.ref) {
			await this.ensureGitRef(targetDir, ["fetch", "origin", source.ref], "FETCH_HEAD", source, scope);
			return;
		}

		const target = await this.getLocalGitUpdateTarget(targetDir);
		this.assertGitTarget(source, scope, targetDir);
		await this.ensureGitRef(targetDir, target.fetchArgs, target.ref, source, scope);
	}

	private async ensureGitRef(
		targetDir: string,
		fetchArgs: string[],
		ref: string,
		source: GitSource,
		scope: SourceScope,
	): Promise<void> {
		// Fetch only the ref we will reset to, avoiding unrelated branch/tag noise.
		this.assertGitTarget(source, scope, targetDir);
		await this.runCommand("git", fetchArgs, { cwd: targetDir });
		this.assertGitTarget(source, scope, targetDir);

		const localHead = await this.runCommandCapture("git", ["rev-parse", "HEAD"], {
			cwd: targetDir,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		this.assertGitTarget(source, scope, targetDir);
		const commitRef = `${ref}^{commit}`;
		const targetHead = await this.runCommandCapture("git", ["rev-parse", commitRef], {
			cwd: targetDir,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		if (localHead.trim() === targetHead.trim()) {
			return;
		}

		this.assertGitTarget(source, scope, targetDir);
		await this.runCommand("git", ["reset", "--hard", commitRef], { cwd: targetDir });

		// Clean untracked files (extensions should be pristine)
		this.assertGitTarget(source, scope, targetDir);
		await this.runCommand("git", ["clean", "-fdx"], { cwd: targetDir });
		this.assertGitTarget(source, scope, targetDir);

		const packageJsonPath = join(targetDir, "package.json");
		if (existsSync(packageJsonPath)) {
			this.assertConfinedResourcePath(packageJsonPath, targetDir);
			await this.runNpmCommand(this.getGitDependencyInstallArgs(), { cwd: targetDir });
		}
	}

	private async refreshTemporaryGitSource(source: GitSource, sourceStr: string): Promise<void> {
		if (isOfflineModeEnabled()) {
			return;
		}
		try {
			await this.withProgress("pull", sourceStr, `Refreshing ${sourceStr}...`, async () => {
				await this.updateGit(source, "temporary");
			});
		} catch {
			// Keep cached temporary checkout if refresh fails.
		}
	}

	private async removeGit(source: GitSource, scope: SourceScope): Promise<void> {
		const targetDir = this.getGitInstallPath(source, scope);
		if (!existsSync(targetDir)) return;
		this.assertGitTarget(source, scope, targetDir);
		rmSync(targetDir, { recursive: true, force: true });
		this.pruneEmptyGitParents(targetDir, this.getGitInstallRoot(scope), source, scope);
	}

	private isSafeGitParentForPruning(
		current: string,
		targetDir: string,
		source: GitSource,
		scope: SourceScope,
	): boolean {
		try {
			this.assertGitTarget(source, scope, targetDir);
			return !existsSync(current) || !lstatSync(current).isSymbolicLink();
		} catch {
			return false;
		}
	}

	private pruneEmptyGitParents(
		targetDir: string,
		installRoot: string | undefined,
		source: GitSource,
		scope: SourceScope,
	): void {
		if (!installRoot) return;
		const resolvedRoot = resolve(installRoot);
		let current = dirname(resolve(targetDir));
		while (current !== resolvedRoot && isPathWithin(resolvedRoot, current)) {
			if (!this.isSafeGitParentForPruning(current, targetDir, source, scope)) break;
			if (!existsSync(current)) {
				current = dirname(current);
				continue;
			}
			const entries = readdirSync(current);
			if (entries.length > 0) {
				break;
			}
			try {
				this.assertGitTarget(source, scope, targetDir);
				this.resolveManagedPath(resolvedRoot, relative(resolvedRoot, current));
				if (lstatSync(current).isSymbolicLink()) {
					break;
				}
				rmSync(current, { recursive: true, force: true });
			} catch {
				break;
			}
			current = dirname(current);
		}
	}

	private ensureNpmProject(installRoot: string): void {
		if (!existsSync(installRoot)) {
			mkdirSync(installRoot, { recursive: true });
		}
		markPathIgnoredByCloudSync(installRoot);
		this.ensureGitIgnore(installRoot);
		const packageJsonPath = join(installRoot, "package.json");
		if (!existsSync(packageJsonPath)) {
			const pkgJson = { name: "pi-extensions", private: true };
			writeFileSync(packageJsonPath, JSON.stringify(pkgJson, null, 2), "utf-8");
		}
	}

	private ensureGitIgnore(dir: string, managedGitRoot = false): void {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const ignorePath = join(dir, ".gitignore");
		if (!managedGitRoot) {
			if (!existsSync(ignorePath)) {
				writeFileSync(ignorePath, "*\n!.gitignore\n", "utf-8");
			}
			return;
		}
		try {
			const stats = lstatSync(ignorePath);
			if (stats.isSymbolicLink()) {
				throw new Error(`Refusing symbolic link in managed Git metadata path: ${ignorePath}`);
			}
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			writeFileSync(ignorePath, "*\n!.gitignore\n", "utf-8");
		}
	}

	private getNpmInstallRoot(scope: SourceScope, temporary: boolean): string {
		if (temporary) {
			return this.getTemporaryDir("npm");
		}
		if (scope === "project") {
			return join(this.cwd, CONFIG_DIR_NAME, "npm");
		}
		return join(this.agentDir, "npm");
	}

	private getGlobalNpmRoot(): string {
		const npmCommand = this.getNpmCommand();
		const commandKey = [npmCommand.command, ...npmCommand.args].join("\0");
		if (this.globalNpmRoot && this.globalNpmRootCommandKey === commandKey) {
			return this.globalNpmRoot;
		}
		if (this.getPackageManagerName() === "bun") {
			const binDir = this.runNpmCommandSync(["pm", "bin", "-g"]).trim();
			this.globalNpmRoot = join(dirname(binDir), "install", "global", "node_modules");
		} else {
			this.globalNpmRoot = this.runNpmCommandSync(["root", "-g"]).trim();
		}
		this.globalNpmRootCommandKey = commandKey;
		return this.globalNpmRoot;
	}

	private getPnpmGlobalPackagePath(packageName: string): string | undefined {
		if (this.getPackageManagerName() !== "pnpm") {
			return undefined;
		}

		const output = this.runNpmCommandSync(["list", "-g", "--depth", "0", "--json"]);
		const entries = JSON.parse(output) as Array<{ dependencies?: Record<string, PnpmGlobalDependencyMetadata> }>;
		for (const entry of entries) {
			const path = entry.dependencies?.[packageName]?.path;
			if (path) return path;
		}
		return undefined;
	}

	private getManagedNpmInstallPath(source: NpmSource, scope: SourceScope): string {
		if (scope === "temporary") {
			return join(this.getTemporaryDir("npm"), "node_modules", source.name);
		}
		if (scope === "project") {
			return join(this.cwd, CONFIG_DIR_NAME, "npm", "node_modules", source.name);
		}
		return join(this.agentDir, "npm", "node_modules", source.name);
	}

	private getLegacyGlobalNpmInstallPath(source: NpmSource): string | undefined {
		try {
			return this.getPnpmGlobalPackagePath(source.name) ?? join(this.getGlobalNpmRoot(), source.name);
		} catch {
			return undefined;
		}
	}

	private getNpmInstallPath(source: NpmSource, scope: SourceScope): string {
		const managedPath = this.getManagedNpmInstallPath(source, scope);
		if (scope !== "user" || existsSync(managedPath)) {
			return managedPath;
		}
		const legacyPath = this.getLegacyGlobalNpmInstallPath(source);
		return legacyPath && existsSync(legacyPath) ? legacyPath : managedPath;
	}

	private getGitInstallPath(source: GitSource, scope: SourceScope): string {
		if (!isSafeGitInstallPath(source)) {
			throw new Error(`Refusing unsafe Git package path: ${source.host}/${source.path}`);
		}

		let targetDir: string;
		if (scope === "temporary") {
			targetDir = this.getTemporaryDir(`git-${source.host}`, source.path);
		} else {
			const installRoot = this.getGitInstallRoot(scope);
			if (!installRoot) {
				throw new Error("Missing Git install root");
			}
			targetDir = this.resolveManagedPath(installRoot, source.host, source.path);
		}

		this.assertManagedGitPath(source, scope, targetDir);
		return targetDir;
	}

	private getGitInstallRoot(scope: SourceScope): string | undefined {
		if (scope === "temporary") {
			return undefined;
		}
		if (scope === "project") {
			return join(this.cwd, CONFIG_DIR_NAME, "git");
		}
		return join(this.agentDir, "git");
	}

	private getGitConfinementRoot(scope: SourceScope): string {
		return scope === "temporary" ? join(tmpdir(), "pi-extensions") : (this.getGitInstallRoot(scope) ?? "");
	}

	private getGitScopeAnchor(scope: SourceScope): string {
		if (scope === "temporary") return tmpdir();
		return scope === "project" ? this.cwd : this.agentDir;
	}

	private getTemporaryDir(prefix: string, suffix?: string): string {
		const root = this.resolveManagedPath(join(tmpdir(), "pi-extensions"), prefix);
		const hash = createHash("sha256")
			.update(`${prefix}-${suffix ?? ""}`)
			.digest("hex")
			.slice(0, 8);
		return this.resolveManagedPath(root, hash, suffix ?? "");
	}

	private resolveManagedPath(root: string, ...parts: string[]): string {
		const resolvedRoot = resolve(root);
		const resolvedPath = resolve(resolvedRoot, ...parts);
		if (!isPathWithin(resolvedRoot, resolvedPath)) {
			throw new Error(`Refusing to use path outside package install root: ${resolvedPath}`);
		}
		return resolvedPath;
	}

	private canonicalizeProspectivePath(path: string): string {
		let current = resolve(path);
		const missingParts: string[] = [];
		while (true) {
			try {
				lstatSync(current);
			} catch (error) {
				if (!isMissingPathError(error)) {
					throw error;
				}
				const parent = dirname(current);
				if (parent === current) {
					throw error;
				}
				missingParts.unshift(basename(current));
				current = parent;
				continue;
			}
			return resolve(realpathSync(current), ...missingParts);
		}
	}

	private assertManagedGitPath(source: GitSource, scope: SourceScope, targetDir: string): void {
		if (!isSafeGitInstallPath(source)) {
			throw new Error(`Refusing unsafe Git package path: ${source.host}/${source.path}`);
		}

		const anchor = resolve(this.getGitScopeAnchor(scope));
		const root = resolve(this.getGitConfinementRoot(scope));
		const target = resolve(targetDir);
		if (!isPathWithin(anchor, root) || !isPathWithin(root, target)) {
			throw new Error(`Refusing to use path outside package install root: ${target}`);
		}

		let canonicalAnchor: string;
		let canonicalRoot: string;
		try {
			canonicalAnchor = this.canonicalizeProspectivePath(anchor);
			canonicalRoot = this.canonicalizeProspectivePath(root);
		} catch {
			throw new Error(`Refusing unsafe Git package install root: ${root}`);
		}
		if (!isPathWithin(canonicalAnchor, canonicalRoot)) {
			throw new Error(`Refusing Git package install root outside its trusted anchor: ${root}`);
		}

		const relativeTarget = relative(root, target);
		let current = canonicalRoot;
		for (const component of relativeTarget.split(sep).filter(Boolean)) {
			current = join(current, component);
			try {
				const stats = lstatSync(current);
				if (stats.isSymbolicLink()) {
					throw new Error(`Refusing symbolic link in Git package path: ${current}`);
				}
			} catch (error) {
				if (isMissingPathError(error)) {
					break;
				}
				throw error;
			}
		}
	}

	private assertGitTarget(source: GitSource, scope: SourceScope, targetDir: string): void {
		const expected = this.getGitInstallPath(source, scope);
		if (expected !== resolve(targetDir)) {
			throw new Error(`Refusing unexpected Git package path: ${targetDir}`);
		}
	}

	private getBaseDirForScope(scope: SourceScope): string {
		if (scope === "project") {
			return join(this.cwd, CONFIG_DIR_NAME);
		}
		if (scope === "user") {
			return this.agentDir;
		}
		return this.cwd;
	}

	private resolvePath(input: string): string {
		return resolvePath(input, this.cwd, { homeDir: getHomeDir(), trim: true });
	}

	private resolvePathFromBase(input: string, baseDir: string): string {
		return resolvePath(input, baseDir, { homeDir: getHomeDir(), trim: true });
	}

	private assertConfinedResourcePath(candidate: string, packageRoot: string): void {
		let canonicalRoot: string;
		let canonicalCandidate: string;
		try {
			canonicalRoot = realpathSync(packageRoot);
			canonicalCandidate = realpathSync(candidate);
		} catch {
			throw new Error(`Refusing unreadable or broken managed Git package resource: ${candidate}`);
		}
		if (!isPathWithin(canonicalRoot, canonicalCandidate)) {
			throw new Error(`Refusing managed Git package resource outside checkout: ${candidate}`);
		}
	}

	private validateConfinedResourceTree(candidate: string, packageRoot: string, visited = new Set<string>()): void {
		lstatSync(candidate);
		this.assertConfinedResourcePath(candidate, packageRoot);
		const canonicalCandidate = realpathSync(candidate);
		const stats = statSync(candidate);
		if (!stats.isDirectory() || visited.has(canonicalCandidate)) return;
		visited.add(canonicalCandidate);
		for (const entry of readdirSync(candidate, { withFileTypes: true })) {
			if (entry.name === "node_modules") continue;
			if (entry.name.startsWith(".") && !IGNORE_FILE_NAMES.has(entry.name)) continue;
			this.validateConfinedResourceTree(join(candidate, entry.name), packageRoot, visited);
		}
	}

	private validateOptionalConfinedResourcePath(candidate: string, packageRoot: string): void {
		try {
			lstatSync(candidate);
			this.assertConfinedResourcePath(candidate, packageRoot);
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
		}
	}

	private validateOptionalConfinedResourceTree(candidate: string, packageRoot: string): void {
		try {
			this.validateConfinedResourceTree(candidate, packageRoot);
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
		}
	}

	private validateManagedGitManifestEntry(entry: string, packageRoot: string): void {
		if (entry.includes("\\") || /^[a-z]:/i.test(entry)) {
			throw new Error(`Refusing unsafe managed Git package resource entry: ${entry}`);
		}
		this.resolveManagedPath(packageRoot, entry);
		const entryParts = entry.split("/");
		const firstGlobPart = entryParts.findIndex((part) => hasGlobPattern(part));
		const scanEntry = firstGlobPart < 0 ? entry : entryParts.slice(0, firstGlobPart).join("/") || ".";
		this.validateOptionalConfinedResourceTree(resolve(packageRoot, scanEntry), packageRoot);
		if (firstGlobPart < 0) return;
		for (const match of globSync(entry, {
			cwd: packageRoot,
			absolute: true,
			dot: false,
			follow: false,
			nodir: false,
		})) {
			this.validateConfinedResourceTree(resolve(match), packageRoot);
		}
	}

	private validateManagedGitManifestResources(manifest: PiManifest, packageRoot: string): void {
		for (const resourceType of RESOURCE_TYPES) {
			const entries = manifest[resourceType as keyof PiManifest];
			if (!Array.isArray(entries)) continue;
			for (const entry of entries) {
				if (typeof entry !== "string" || isOverridePattern(entry)) continue;
				this.validateManagedGitManifestEntry(entry, packageRoot);
			}
		}
	}

	private validateManagedGitResourceInputs(packageRoot: string): void {
		this.assertConfinedResourcePath(packageRoot, packageRoot);
		const packageJsonPath = join(packageRoot, "package.json");
		this.validateOptionalConfinedResourcePath(packageJsonPath, packageRoot);
		for (const resourceType of RESOURCE_TYPES) {
			this.validateOptionalConfinedResourceTree(join(packageRoot, resourceType), packageRoot);
		}
		const manifest = readPiManifest(packageJsonPath);
		if (manifest) this.validateManagedGitManifestResources(manifest, packageRoot);
	}

	private collectManagedGitPackageResources(
		packageRoot: string,
		accumulator: ResourceAccumulator,
		filter: PackageFilter | undefined,
		metadata: PathMetadata,
	): void {
		this.validateManagedGitResourceInputs(packageRoot);
		const packageAccumulator = this.createAccumulator();
		this.collectPackageResources(packageRoot, packageAccumulator, filter, metadata);
		for (const resourceType of RESOURCE_TYPES) {
			const sourceMap = this.getTargetMap(packageAccumulator, resourceType);
			const targetMap = this.getTargetMap(accumulator, resourceType);
			for (const [path, value] of sourceMap) {
				this.assertConfinedResourcePath(path, packageRoot);
				this.addResource(targetMap, path, value.metadata, value.enabled);
			}
		}
	}

	private collectPackageResources(
		packageRoot: string,
		accumulator: ResourceAccumulator,
		filter: PackageFilter | undefined,
		metadata: PathMetadata,
	): boolean {
		if (filter) {
			for (const resourceType of RESOURCE_TYPES) {
				const patterns = filter[resourceType as keyof PackageFilter];
				const target = this.getTargetMap(accumulator, resourceType);
				if (patterns !== undefined) {
					this.applyPackageFilter(packageRoot, patterns, resourceType, target, metadata);
				} else {
					this.collectDefaultResources(packageRoot, resourceType, target, metadata);
				}
			}
			return true;
		}

		const manifest = readPiManifest(join(packageRoot, "package.json"));
		if (manifest) {
			for (const resourceType of RESOURCE_TYPES) {
				const entries = manifest[resourceType as keyof PiManifest];
				this.addManifestEntries(
					entries,
					packageRoot,
					resourceType,
					this.getTargetMap(accumulator, resourceType),
					metadata,
				);
			}
			return true;
		}

		let hasAnyDir = false;
		for (const resourceType of RESOURCE_TYPES) {
			const dir = join(packageRoot, resourceType);
			if (!existsSync(dir)) continue;
			// Collect all files from the directory (all enabled by default)
			const files = collectResourceFiles(dir, resourceType);
			for (const f of files) {
				this.addResource(this.getTargetMap(accumulator, resourceType), f, metadata, true);
			}
			hasAnyDir = true;
		}
		return hasAnyDir;
	}

	private collectDefaultResources(
		packageRoot: string,
		resourceType: ResourceType,
		target: ResourceMap,
		metadata: PathMetadata,
	): void {
		const manifest = readPiManifest(join(packageRoot, "package.json"));
		const entries = manifest?.[resourceType as keyof PiManifest];
		if (entries) {
			this.addManifestEntries(entries, packageRoot, resourceType, target, metadata);
			return;
		}
		const dir = join(packageRoot, resourceType);
		if (existsSync(dir)) {
			// Collect all files from the directory (all enabled by default)
			const files = collectResourceFiles(dir, resourceType);
			for (const f of files) {
				this.addResource(target, f, metadata, true);
			}
		}
	}

	private applyPackageFilter(
		packageRoot: string,
		userPatterns: string[],
		resourceType: ResourceType,
		target: ResourceMap,
		metadata: PathMetadata,
	): void {
		const { allFiles } = this.collectManifestFiles(packageRoot, resourceType);

		if (userPatterns.length === 0) {
			// Empty array explicitly disables all resources of this type
			for (const f of allFiles) {
				this.addResource(target, f, metadata, false);
			}
			return;
		}

		// Apply user patterns
		const enabledByUser = applyPatterns(allFiles, userPatterns, packageRoot);

		for (const f of allFiles) {
			const enabled = enabledByUser.has(f);
			this.addResource(target, f, metadata, enabled);
		}
	}

	/**
	 * Collect all files from a package for a resource type, applying manifest patterns.
	 * Returns { allFiles, enabledByManifest } where enabledByManifest is the set of files
	 * that pass the manifest's own patterns.
	 */
	private collectManifestFiles(packageRoot: string, resourceType: ResourceType): ManifestFileCollection {
		const manifest = readPiManifest(join(packageRoot, "package.json"));
		const entries = manifest?.[resourceType as keyof PiManifest];
		if (entries && entries.length > 0) {
			const allFiles = this.collectFilesFromManifestEntries(entries, packageRoot, resourceType);
			const manifestPatterns = entries.filter(isOverridePattern);
			const enabledByManifest =
				manifestPatterns.length > 0 ? applyPatterns(allFiles, manifestPatterns, packageRoot) : new Set(allFiles);
			return { allFiles: Array.from(enabledByManifest), enabledByManifest };
		}

		const conventionDir = join(packageRoot, resourceType);
		if (!existsSync(conventionDir)) {
			return { allFiles: [], enabledByManifest: new Set() };
		}
		const allFiles = collectResourceFiles(conventionDir, resourceType);
		return { allFiles, enabledByManifest: new Set(allFiles) };
	}

	private addManifestEntries(
		entries: string[] | undefined,
		root: string,
		resourceType: ResourceType,
		target: ResourceMap,
		metadata: PathMetadata,
	): void {
		if (!entries) return;

		const allFiles = this.collectFilesFromManifestEntries(entries, root, resourceType);
		const patterns = entries.filter(isOverridePattern);
		const enabledPaths = applyPatterns(allFiles, patterns, root);

		for (const f of allFiles) {
			if (enabledPaths.has(f)) {
				this.addResource(target, f, metadata, true);
			}
		}
	}

	private collectFilesFromManifestEntries(entries: string[], root: string, resourceType: ResourceType): string[] {
		const sourceEntries = entries.filter((entry) => !isOverridePattern(entry));
		const resolved = sourceEntries.flatMap((entry) => {
			if (!hasGlobPattern(entry)) {
				return [resolve(root, entry)];
			}

			return globSync(entry, {
				cwd: root,
				absolute: true,
				dot: false,
				follow: false,
				nodir: false,
			}).map((match) => resolve(match));
		});
		return this.collectFilesFromPaths(resolved, resourceType);
	}

	private resolveLocalEntries(
		entries: string[],
		resourceType: ResourceType,
		target: ResourceMap,
		metadata: PathMetadata,
		baseDir: string,
	): void {
		if (entries.length === 0) return;

		// Collect all files from plain entries (non-pattern entries)
		const { plain, patterns } = splitPatterns(entries);
		const resolvedPlain = plain.map((p) => this.resolvePathFromBase(p, baseDir));
		const allFiles = this.collectFilesFromPaths(resolvedPlain, resourceType);

		// Determine which files are enabled based on patterns
		const enabledPaths = applyPatterns(allFiles, patterns, baseDir);

		// Add all files with their enabled state
		for (const f of allFiles) {
			this.addResource(target, f, metadata, enabledPaths.has(f));
		}
	}

	private addAutoDiscoveredResources(
		accumulator: ResourceAccumulator,
		globalSettings: Settings,
		projectSettings: Settings,
		globalBaseDir: string,
		projectBaseDir: string,
	): void {
		const userMetadata: PathMetadata = {
			source: "auto",
			scope: "user",
			origin: "top-level",
			baseDir: globalBaseDir,
		};
		const projectMetadata: PathMetadata = {
			source: "auto",
			scope: "project",
			origin: "top-level",
			baseDir: projectBaseDir,
		};

		const userOverrides = {
			extensions: (globalSettings.extensions ?? []) as string[],
			skills: (globalSettings.skills ?? []) as string[],
			rules: (globalSettings.rules ?? []) as string[],
			prompts: (globalSettings.prompts ?? []) as string[],
			themes: (globalSettings.themes ?? []) as string[],
		};
		const projectOverrides = {
			extensions: (projectSettings.extensions ?? []) as string[],
			skills: (projectSettings.skills ?? []) as string[],
			rules: (projectSettings.rules ?? []) as string[],
			prompts: (projectSettings.prompts ?? []) as string[],
			themes: (projectSettings.themes ?? []) as string[],
		};

		const userDirs = {
			extensions: join(globalBaseDir, "extensions"),
			skills: join(globalBaseDir, "skills"),
			rules: join(globalBaseDir, "rules"),
			prompts: join(globalBaseDir, "prompts"),
			themes: join(globalBaseDir, "themes"),
		};
		const projectDirs = {
			extensions: join(projectBaseDir, "extensions"),
			skills: join(projectBaseDir, "skills"),
			rules: join(projectBaseDir, "rules"),
			prompts: join(projectBaseDir, "prompts"),
			themes: join(projectBaseDir, "themes"),
		};
		const userAgentsSkillsDir = join(getHomeDir(), ".agents", "skills");
		const userAgentsRulesDir = join(getHomeDir(), ".agents", "rules");
		const projectAgentsSkillDirs = collectAncestorAgentsSkillDirs(this.cwd).filter(
			(dir) => resolve(dir) !== resolve(userAgentsSkillsDir),
		);
		const projectAgentsRuleDirs = collectAncestorAgentsRuleDirs(this.cwd).filter(
			(dir) => resolve(dir) !== resolve(userAgentsRulesDir),
		);

		const addResources = (
			resourceType: ResourceType,
			paths: string[],
			metadata: PathMetadata,
			overrides: string[],
			baseDir: string,
		) => {
			const target = this.getTargetMap(accumulator, resourceType);
			for (const path of paths) {
				const enabled = isEnabledByOverrides(path, overrides, baseDir);
				this.addResource(target, path, metadata, enabled);
			}
		};

		// Project extensions from .pi/
		addResources(
			"extensions",
			collectAutoExtensionEntries(projectDirs.extensions),
			projectMetadata,
			projectOverrides.extensions,
			projectBaseDir,
		);

		// Project skills from .pi/
		addResources(
			"skills",
			collectAutoSkillEntries(projectDirs.skills, "pi"),
			projectMetadata,
			projectOverrides.skills,
			projectBaseDir,
		);

		// Project rules from .pi/
		addResources(
			"rules",
			collectAutoRuleEntries(projectDirs.rules, "pi"),
			projectMetadata,
			projectOverrides.rules,
			projectBaseDir,
		);

		// Project skills from .agents/ (each with its own baseDir)
		for (const agentsSkillsDir of projectAgentsSkillDirs) {
			const agentsBaseDir = dirname(agentsSkillsDir); // the .agents directory
			const agentsMetadata: PathMetadata = {
				...projectMetadata,
				baseDir: agentsBaseDir,
			};
			addResources(
				"skills",
				collectAutoSkillEntries(agentsSkillsDir, "agents"),
				agentsMetadata,
				projectOverrides.skills,
				agentsBaseDir,
			);
		}

		// Project rules from .agents/ (each with its own baseDir)
		for (const agentsRulesDir of projectAgentsRuleDirs) {
			const agentsBaseDir = dirname(agentsRulesDir); // the .agents directory
			const agentsMetadata: PathMetadata = {
				...projectMetadata,
				baseDir: agentsBaseDir,
			};
			addResources(
				"rules",
				collectAutoRuleEntries(agentsRulesDir, "agents"),
				agentsMetadata,
				projectOverrides.rules,
				agentsBaseDir,
			);
		}

		addResources(
			"prompts",
			collectAutoPromptEntries(projectDirs.prompts),
			projectMetadata,
			projectOverrides.prompts,
			projectBaseDir,
		);
		addResources(
			"themes",
			collectAutoThemeEntries(projectDirs.themes),
			projectMetadata,
			projectOverrides.themes,
			projectBaseDir,
		);

		// User extensions from ~/.pi/agent/
		addResources(
			"extensions",
			collectAutoExtensionEntries(userDirs.extensions),
			userMetadata,
			userOverrides.extensions,
			globalBaseDir,
		);

		// User skills from ~/.pi/agent/
		addResources(
			"skills",
			collectAutoSkillEntries(userDirs.skills, "pi"),
			userMetadata,
			userOverrides.skills,
			globalBaseDir,
		);

		// User rules from ~/.pi/agent/
		addResources(
			"rules",
			collectAutoRuleEntries(userDirs.rules, "pi"),
			userMetadata,
			userOverrides.rules,
			globalBaseDir,
		);

		// User skills from ~/.agents/ (with its own baseDir)
		const userAgentsBaseDir = dirname(userAgentsSkillsDir);
		const userAgentsMetadata: PathMetadata = {
			...userMetadata,
			baseDir: userAgentsBaseDir,
		};
		addResources(
			"skills",
			collectAutoSkillEntries(userAgentsSkillsDir, "agents"),
			userAgentsMetadata,
			userOverrides.skills,
			userAgentsBaseDir,
		);

		// User rules from ~/.agents/ (with its own baseDir)
		const userAgentsRulesBaseDir = dirname(userAgentsRulesDir);
		const userAgentsRulesMetadata: PathMetadata = {
			...userMetadata,
			baseDir: userAgentsRulesBaseDir,
		};
		addResources(
			"rules",
			collectAutoRuleEntries(userAgentsRulesDir, "agents"),
			userAgentsRulesMetadata,
			userOverrides.rules,
			userAgentsRulesBaseDir,
		);

		addResources(
			"prompts",
			collectAutoPromptEntries(userDirs.prompts),
			userMetadata,
			userOverrides.prompts,
			globalBaseDir,
		);
		addResources(
			"themes",
			collectAutoThemeEntries(userDirs.themes),
			userMetadata,
			userOverrides.themes,
			globalBaseDir,
		);
	}

	private collectFilesFromPaths(paths: string[], resourceType: ResourceType): string[] {
		const files: string[] = [];
		for (const p of paths) {
			if (!existsSync(p)) continue;

			try {
				const stats = statSync(p);
				if (stats.isFile()) {
					files.push(p);
				} else if (stats.isDirectory()) {
					files.push(...collectResourceFiles(p, resourceType));
				}
			} catch {
				// Ignore errors
			}
		}
		return files;
	}

	private getTargetMap(accumulator: ResourceAccumulator, resourceType: ResourceType): ResourceMap {
		switch (resourceType) {
			case "extensions":
				return accumulator.extensions;
			case "skills":
				return accumulator.skills;
			case "rules":
				return accumulator.rules;
			case "prompts":
				return accumulator.prompts;
			case "themes":
				return accumulator.themes;
			default:
				throw new Error(`Unknown resource type: ${resourceType}`);
		}
	}

	private addResource(map: ResourceMap, path: string, metadata: PathMetadata, enabled: boolean): void {
		if (!path) return;
		if (!map.has(path)) {
			map.set(path, { metadata, enabled });
		}
	}

	private createAccumulator(): ResourceAccumulator {
		return {
			extensions: new Map(),
			skills: new Map(),
			rules: new Map(),
			prompts: new Map(),
			themes: new Map(),
		};
	}

	private toResolvedPaths(accumulator: ResourceAccumulator): ResolvedPaths {
		const mapToResolved = (entries: ResourceMap): ResolvedResource[] => {
			const resolved = Array.from(entries.entries()).map(([path, { metadata, enabled }]) => ({
				path,
				enabled,
				metadata,
			}));
			resolved.sort((a, b) => resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata));

			const seen = new Set<string>();
			return resolved.filter((entry) => {
				const canonicalPath = canonicalizePath(entry.path);
				if (seen.has(canonicalPath)) return false;
				seen.add(canonicalPath);
				return true;
			});
		};

		return {
			extensions: mapToResolved(accumulator.extensions),
			skills: mapToResolved(accumulator.skills),
			rules: mapToResolved(accumulator.rules),
			prompts: mapToResolved(accumulator.prompts),
			themes: mapToResolved(accumulator.themes),
		};
	}

	private spawnCommand(command: string, args: string[], options?: CommandWorkingDirectoryOptions): ChildProcess {
		const env = getEnv();
		return spawnProcess(command, args, {
			cwd: options?.cwd,
			stdio: isStdoutTakenOver() ? ["ignore", 2, 2] : "inherit",
			env,
		});
	}

	private spawnCaptureCommand(
		command: string,
		args: string[],
		options?: CommandEnvironmentOptions,
	): ChildProcessByStdio<null, Readable, Readable> {
		const baseEnv = getEnv();
		const env = options?.env ? { ...baseEnv, ...options.env } : baseEnv;
		return spawnProcess(command, args, {
			cwd: options?.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});
	}

	private runCommandCapture(command: string, args: string[], options?: CommandCaptureOptions): Promise<string> {
		return new Promise((resolvePromise, reject) => {
			const child = this.spawnCaptureCommand(command, args, options);
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			const timeout =
				typeof options?.timeoutMs === "number"
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, options.timeoutMs)
					: undefined;

			child.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			child.stderr?.on("data", (data) => {
				stderr += data.toString();
			});
			child.once("error", (error) => {
				if (timeout) clearTimeout(timeout);
				reject(error);
			});
			child.once("close", (code, signal) => {
				if (timeout) clearTimeout(timeout);
				if (timedOut) {
					reject(new Error(`${command} ${args.join(" ")} timed out after ${options?.timeoutMs}ms`));
					return;
				}
				if (code === 0) {
					resolvePromise(stdout.trim());
					return;
				}
				const exitStatus = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
				reject(new Error(`${command} ${args.join(" ")} failed with ${exitStatus}: ${stderr || stdout}`));
			});
		});
	}

	private runCommand(command: string, args: string[], options?: CommandWorkingDirectoryOptions): Promise<void> {
		return new Promise((resolvePromise, reject) => {
			const child = this.spawnCommand(command, args, options);
			child.on("error", reject);
			child.on("exit", (code) => {
				if (code === 0) {
					resolvePromise();
				} else {
					reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
				}
			});
		});
	}

	private runCommandSync(command: string, args: string[]): string {
		const env = getEnv();
		const result = spawnProcessSync(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf-8",
			env,
		});
		if (result.error || result.status !== 0) {
			throw new Error(
				`Failed to run ${command} ${args.join(" ")}: ${result.error?.message || result.stderr || result.stdout}`,
			);
		}
		return (result.stdout || result.stderr || "").trim();
	}
}
