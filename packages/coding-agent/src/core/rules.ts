import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import ignore from "ignore";
import { dirname, join, relative, resolve, sep } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import type { ToolOperations } from "./tools/operations.ts";

/** Max name length per spec */
const MAX_NAME_LENGTH = 64;

/** Max description length per spec */
const MAX_DESCRIPTION_LENGTH = 1024;

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
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

function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
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

export interface RuleFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
	[key: string]: unknown;
}

export interface Rule {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo: SourceInfo;
	disableModelInvocation: boolean;
	content?: string;
}

export interface LoadRulesResult {
	rules: Rule[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * Validate rule name.
 * Returns array of validation error messages (empty if valid).
 */
function validateName(name: string): string[] {
	const errors: string[] = [];

	if (name.length > MAX_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}

	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
	}

	if (name.startsWith("-") || name.endsWith("-")) {
		errors.push(`name must not start or end with a hyphen`);
	}

	if (name.includes("--")) {
		errors.push(`name must not contain consecutive hyphens`);
	}

	return errors;
}

/**
 * Validate description.
 */
function validateDescription(description: string | undefined): string[] {
	const errors: string[] = [];

	if (!description || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}

	return errors;
}

export interface LoadRulesFromDirOptions {
	/** Directory to scan for rules */
	dir: string;
	/** Source identifier for these rules */
	source: string;
}

function createRuleSourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
	switch (source) {
		case "user":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "user",
				baseDir,
			});
		case "project":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "project",
				baseDir,
			});
		case "path":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				baseDir,
			});
		default:
			return createSyntheticSourceInfo(filePath, { source, baseDir });
	}
}

/**
 * Load rules from a directory.
 *
 * Discovery rules:
 * - if a directory contains RULES.md, treat it as a rule root and do not recurse further
 * - otherwise, load direct .md children in the root
 * - recurse into subdirectories to find RULES.md
 */
export function loadRulesFromDir(options: LoadRulesFromDirOptions): LoadRulesResult {
	const { dir, source } = options;
	return loadRulesFromDirInternal(dir, source, true);
}

function loadRulesFromDirInternal(
	dir: string,
	source: string,
	includeRootFiles: boolean,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): LoadRulesResult {
	const rules: Rule[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	if (!existsSync(dir)) {
		return { rules, diagnostics };
	}

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			if (entry.name !== "RULES.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (!isFile || ig.ignores(relPath)) {
				continue;
			}

			const result = loadRuleFromFile(fullPath, source);
			if (result.rule) {
				rules.push(result.rule);
			}
			diagnostics.push(...result.diagnostics);
			return { rules, diagnostics };
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".")) {
				continue;
			}

			// Skip node_modules to avoid scanning dependencies
			if (entry.name === "node_modules") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			// For symlinks, check if they point to a directory and follow them
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					// Broken symlink, skip it
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDirectory ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) {
				continue;
			}

			if (isDirectory) {
				const subResult = loadRulesFromDirInternal(fullPath, source, false, ig, root);
				rules.push(...subResult.rules);
				diagnostics.push(...subResult.diagnostics);
				continue;
			}

			if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) {
				continue;
			}

			const result = loadRuleFromFile(fullPath, source);
			if (result.rule) {
				rules.push(result.rule);
			}
			diagnostics.push(...result.diagnostics);
		}
	} catch {}

	return { rules, diagnostics };
}

function loadRuleFromFile(filePath: string, source: string): { rule: Rule | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];

	try {
		const rawContent = readFileSync(filePath, "utf-8");
		const { frontmatter } = parseFrontmatter<RuleFrontmatter>(rawContent);
		const ruleDir = dirname(filePath);

		// Validate description
		const descErrors = validateDescription(frontmatter.description);
		for (const error of descErrors) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		if (!frontmatter.name || frontmatter.name.trim() === "") {
			diagnostics.push({ type: "warning", message: "name is required", path: filePath });
		}

		const name = frontmatter.name;
		if (name) {
			for (const error of validateName(name)) {
				diagnostics.push({ type: "warning", message: error, path: filePath });
			}
		}

		// Still load the rule even with warnings (unless required fields are missing)
		if (!name || !frontmatter.description || frontmatter.description.trim() === "") {
			return { rule: null, diagnostics };
		}

		return {
			rule: {
				name,
				description: frontmatter.description,
				filePath,
				baseDir: ruleDir,
				sourceInfo: createRuleSourceInfo(filePath, ruleDir, source),
				disableModelInvocation: frontmatter["disable-model-invocation"] === true,
			},
			diagnostics,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to parse rule file";
		diagnostics.push({ type: "warning", message, path: filePath });
		return { rule: null, diagnostics };
	}
}

/**
 * Format rules for inclusion in a system prompt.
 * Rules with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via /rule:name commands).
 */
export function formatRulesForPrompt(rules: Rule[]): string {
	const visibleRules = rules.filter((s) => !s.disableModelInvocation);

	if (visibleRules.length === 0) {
		return "";
	}

	const lines = [
		"\n\nThe following rules provide mandatory constraints and policies.",
		"Use the read tool to load a rule's file when the task or files match its description; applicable rules are mandatory.",
		"When a rule file references a relative path, resolve it against the rule directory (parent of RULES.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_rules>",
	];

	for (const rule of visibleRules) {
		lines.push("  <rule>");
		lines.push(`    <name>${escapeXml(rule.name)}</name>`);
		lines.push(`    <description>${escapeXml(rule.description)}</description>`);
		lines.push(`    <location>${escapeXml(rule.filePath)}</location>`);
		lines.push("  </rule>");
	}

	lines.push("</available_rules>");

	return lines.join("\n");
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export interface LoadRulesOptions {
	/** Working directory for project-local rules. */
	cwd: string;
	/** Agent config directory for global rules. */
	agentDir: string;
	/** Explicit rule paths (files or directories) */
	rulePaths: string[];
	/** Include default rules directories. */
	includeDefaults: boolean;
}

/**
 * Load rules from all configured locations.
 * Returns rules and any validation diagnostics.
 */
export function loadRules(options: LoadRulesOptions): LoadRulesResult {
	const { agentDir, rulePaths, includeDefaults } = options;

	// Resolve agentDir - if not provided, use default from config
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(agentDir ?? getAgentDir());

	const ruleMap = new Map<string, Rule>();
	const realPathSet = new Set<string>();
	const allDiagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];

	function addRules(result: LoadRulesResult) {
		allDiagnostics.push(...result.diagnostics);
		for (const rule of result.rules) {
			// Resolve symlinks to detect duplicate files
			const realPath = canonicalizePath(rule.filePath);

			// Skip silently if we've already loaded this exact file (via symlink)
			if (realPathSet.has(realPath)) {
				continue;
			}

			const existing = ruleMap.get(rule.name);
			if (existing) {
				collisionDiagnostics.push({
					type: "collision",
					message: `name "${rule.name}" collision`,
					path: rule.filePath,
					collision: {
						resourceType: "rule",
						name: rule.name,
						winnerPath: existing.filePath,
						loserPath: rule.filePath,
					},
				});
			} else {
				ruleMap.set(rule.name, rule);
				realPathSet.add(realPath);
			}
		}
	}

	if (includeDefaults) {
		addRules(loadRulesFromDirInternal(join(resolvedAgentDir, "rules"), "user", true));
		addRules(loadRulesFromDirInternal(resolve(resolvedCwd, CONFIG_DIR_NAME, "rules"), "project", true));
	}

	const userRulesDir = join(resolvedAgentDir, "rules");
	const projectRulesDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "rules");

	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		if (!includeDefaults) {
			if (isUnderPath(resolvedPath, userRulesDir)) return "user";
			if (isUnderPath(resolvedPath, projectRulesDir)) return "project";
		}
		return "path";
	};

	for (const rawPath of rulePaths) {
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		if (!existsSync(resolvedPath)) {
			allDiagnostics.push({ type: "warning", message: "rule path does not exist", path: resolvedPath });
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			const source = getSource(resolvedPath);
			if (stats.isDirectory()) {
				addRules(loadRulesFromDirInternal(resolvedPath, source, true));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const result = loadRuleFromFile(resolvedPath, source);
				if (result.rule) {
					addRules({ rules: [result.rule], diagnostics: result.diagnostics });
				} else {
					allDiagnostics.push(...result.diagnostics);
				}
			} else {
				allDiagnostics.push({ type: "warning", message: "rule path is not a markdown file", path: resolvedPath });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read rule path";
			allDiagnostics.push({ type: "warning", message, path: resolvedPath });
		}
	}

	return {
		rules: Array.from(ruleMap.values()),
		diagnostics: [...allDiagnostics, ...collisionDiagnostics],
	};
}

async function backendPathExists(operations: ToolOperations, path: string): Promise<boolean> {
	try {
		await operations.access(path, "exists");
		return true;
	} catch {
		return false;
	}
}

async function addIgnoreRulesWithOperations(
	operations: ToolOperations,
	ig: IgnoreMatcher,
	dir: string,
	rootDir: string,
): Promise<void> {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!(await backendPathExists(operations, ignorePath))) continue;
		try {
			const content = (await operations.readFile(ignorePath)).toString("utf-8");
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

async function loadRuleFromFileWithOperations(
	operations: ToolOperations,
	filePath: string,
	source: string,
): Promise<{ rule: Rule | null; diagnostics: ResourceDiagnostic[] }> {
	const diagnostics: ResourceDiagnostic[] = [];

	try {
		const rawContent = (await operations.readFile(filePath)).toString("utf-8");
		const { frontmatter } = parseFrontmatter<RuleFrontmatter>(rawContent);
		const ruleDir = dirname(filePath);

		for (const error of validateDescription(frontmatter.description)) {
			diagnostics.push({ type: "warning", message: error, path: filePath });
		}

		if (!frontmatter.name || frontmatter.name.trim() === "") {
			diagnostics.push({ type: "warning", message: "name is required", path: filePath });
		}

		const name = frontmatter.name;
		if (name) {
			for (const error of validateName(name)) {
				diagnostics.push({ type: "warning", message: error, path: filePath });
			}
		}

		if (!name || !frontmatter.description || frontmatter.description.trim() === "") {
			return { rule: null, diagnostics };
		}

		return {
			rule: {
				name,
				description: frontmatter.description,
				filePath,
				baseDir: ruleDir,
				sourceInfo: createRuleSourceInfo(filePath, ruleDir, source),
				disableModelInvocation: frontmatter["disable-model-invocation"] === true,
			},
			diagnostics,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to parse rule file";
		diagnostics.push({ type: "warning", message, path: filePath });
		return { rule: null, diagnostics };
	}
}

async function loadRulesFromDirInternalWithOperations(
	operations: ToolOperations,
	dir: string,
	source: string,
	includeRootFiles: boolean,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): Promise<LoadRulesResult> {
	const rules: Rule[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	if (!(await backendPathExists(operations, dir))) {
		return { rules, diagnostics };
	}

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	await addIgnoreRulesWithOperations(operations, ig, dir, root);

	try {
		const entries = await operations.readdir(dir);

		for (const name of entries) {
			if (name !== "RULES.md") continue;
			const fullPath = join(dir, name);
			let isFile = false;
			try {
				isFile = (await operations.stat(fullPath)).isFile();
			} catch {
				continue;
			}
			const relPath = toPosixPath(relative(root, fullPath));
			if (!isFile || ig.ignores(relPath)) continue;
			const result = await loadRuleFromFileWithOperations(operations, fullPath, source);
			if (result.rule) rules.push(result.rule);
			diagnostics.push(...result.diagnostics);
			return { rules, diagnostics };
		}

		for (const name of entries) {
			if (name.startsWith(".") || name === "node_modules") continue;
			const fullPath = join(dir, name);
			let isDirectory = false;
			let isFile = false;
			try {
				const stats = await operations.stat(fullPath);
				isDirectory = stats.isDirectory();
				isFile = stats.isFile();
			} catch {
				continue;
			}
			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDirectory ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;
			if (isDirectory) {
				const subResult = await loadRulesFromDirInternalWithOperations(
					operations,
					fullPath,
					source,
					false,
					ig,
					root,
				);
				rules.push(...subResult.rules);
				diagnostics.push(...subResult.diagnostics);
				continue;
			}
			if (!isFile || !includeRootFiles || !name.endsWith(".md")) continue;
			const result = await loadRuleFromFileWithOperations(operations, fullPath, source);
			if (result.rule) rules.push(result.rule);
			diagnostics.push(...result.diagnostics);
		}
	} catch {}

	return { rules, diagnostics };
}

export interface LoadRulesWithOperationsOptions extends LoadRulesOptions {
	operations: ToolOperations;
}

export async function loadRulesWithOperations(options: LoadRulesWithOperationsOptions): Promise<LoadRulesResult> {
	const { agentDir, rulePaths, includeDefaults, operations } = options;
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(agentDir ?? getAgentDir());
	const ruleMap = new Map<string, Rule>();
	const pathSet = new Set<string>();
	const allDiagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];

	function addRules(result: LoadRulesResult) {
		allDiagnostics.push(...result.diagnostics);
		for (const rule of result.rules) {
			const canonicalPath = resolve(rule.filePath);
			if (pathSet.has(canonicalPath)) continue;
			const existing = ruleMap.get(rule.name);
			if (existing) {
				collisionDiagnostics.push({
					type: "collision",
					message: `name "${rule.name}" collision`,
					path: rule.filePath,
					collision: {
						resourceType: "rule",
						name: rule.name,
						winnerPath: existing.filePath,
						loserPath: rule.filePath,
					},
				});
			} else {
				ruleMap.set(rule.name, rule);
				pathSet.add(canonicalPath);
			}
		}
	}

	if (includeDefaults) {
		addRules(await loadRulesFromDirInternalWithOperations(operations, join(resolvedAgentDir, "rules"), "user", true));
		addRules(
			await loadRulesFromDirInternalWithOperations(
				operations,
				resolve(resolvedCwd, CONFIG_DIR_NAME, "rules"),
				"project",
				true,
			),
		);
	}

	const userRulesDir = join(resolvedAgentDir, "rules");
	const projectRulesDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "rules");
	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) return true;
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};
	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		if (!includeDefaults) {
			if (isUnderPath(resolvedPath, userRulesDir)) return "user";
			if (isUnderPath(resolvedPath, projectRulesDir)) return "project";
		}
		return "path";
	};

	for (const rawPath of rulePaths) {
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		if (!(await backendPathExists(operations, resolvedPath))) {
			allDiagnostics.push({ type: "warning", message: "rule path does not exist", path: resolvedPath });
			continue;
		}
		try {
			const stats = await operations.stat(resolvedPath);
			const source = getSource(resolvedPath);
			if (stats.isDirectory()) {
				addRules(await loadRulesFromDirInternalWithOperations(operations, resolvedPath, source, true));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const result = await loadRuleFromFileWithOperations(operations, resolvedPath, source);
				if (result.rule) addRules({ rules: [result.rule], diagnostics: result.diagnostics });
				else allDiagnostics.push(...result.diagnostics);
			} else {
				allDiagnostics.push({ type: "warning", message: "rule path is not a markdown file", path: resolvedPath });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read rule path";
			allDiagnostics.push({ type: "warning", message, path: resolvedPath });
		}
	}

	return { rules: Array.from(ruleMap.values()), diagnostics: [...allDiagnostics, ...collisionDiagnostics] };
}
