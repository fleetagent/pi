import ignore from "ignore";
import { parse } from "yaml";
import { type ExecutionEnv, type FileError, type FileInfo, type Result, type Skill, toError } from "./types.ts";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
type SkillPathKind = "file" | "directory";

export type SkillDiagnosticCode =
	| "file_info_failed"
	| "list_failed"
	| "read_failed"
	| "parse_failed"
	| "invalid_metadata";

/** Warning produced while loading skills. */
export interface SkillDiagnostic {
	/** Diagnostic severity. Currently only warnings are emitted. */
	type: "warning";
	/** Stable diagnostic code. */
	code: SkillDiagnosticCode;
	/** Human-readable diagnostic message. */
	message: string;
	/** Path associated with the diagnostic. */
	path: string;
}

function appendFileInfoDiagnostic(diagnostics: SkillDiagnostic[], error: FileError, path: string): void {
	if (error.code === "not_found") return;
	diagnostics.push({ type: "warning", code: "file_info_failed", message: error.message, path });
}

interface SkillFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
	[key: string]: unknown;
}

/** Skills and warnings produced by a directory load. */
export interface LoadSkillsResult {
	skills: Skill[];
	diagnostics: SkillDiagnostic[];
}

/** Source-tagged directory passed to the sourced skill loader. */
export type SourcedSkillInput<TSource> = {
	path: string;
	source: TSource;
};

/** Loaded skill paired with its caller-defined provenance. */
export interface SourcedSkill<TSkill extends Skill, TSource> {
	skill: TSkill;
	source: TSource;
}

/** Skill diagnostic paired with its caller-defined provenance. */
export interface SourcedSkillDiagnostic<TSource> extends SkillDiagnostic {
	source: TSource;
}

/** Skills and diagnostics produced by a sourced directory load. */
export interface LoadSourcedSkillsResult<TSkill extends Skill, TSource> {
	skills: SourcedSkill<TSkill, TSource>[];
	diagnostics: SourcedSkillDiagnostic<TSource>[];
}

interface SkillFileLoadResult {
	skill: Skill | null;
	diagnostics: SkillDiagnostic[];
}

type ParsedFrontmatter<T> = {
	frontmatter: T;
	body: string;
};

/** Format a skill invocation prompt, optionally appending additional user instructions. */
export function formatSkillInvocation(skill: Skill, additionalInstructions?: string): string {
	const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${dirnameEnvPath(skill.filePath)}.\n\n${skill.content}\n</skill>`;
	return additionalInstructions ? `${skillBlock}\n\n${additionalInstructions}` : skillBlock;
}

/**
 * Load skills from one or more directories.
 *
 * Traverses directories recursively, loads `SKILL.md` files, loads direct root `.md` files as skills, honors ignore files,
 * and returns diagnostics for invalid skill files. Missing input directories are skipped.
 */
export async function loadSkills(env: ExecutionEnv, dirs: string | string[]): Promise<LoadSkillsResult> {
	const skills: Skill[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
		const rootInfoResult = await env.fileInfo(dir);
		if (!rootInfoResult.ok) {
			if (rootInfoResult.error.code !== "not_found") {
				diagnostics.push({
					type: "warning",
					code: "file_info_failed",
					message: rootInfoResult.error.message,
					path: dir,
				});
			}
			continue;
		}
		const rootInfo = rootInfoResult.value;
		if ((await resolveKind(env, rootInfo, diagnostics)) !== "directory") continue;
		const result = await loadSkillsFromDirInternal(env, rootInfo.path, true, ignore(), rootInfo.path);
		skills.push(...result.skills);
		diagnostics.push(...result.diagnostics);
	}
	return { skills, diagnostics };
}

/**
 * Load skills from source-tagged directories.
 *
 * Source values are preserved exactly and attached to every loaded skill and diagnostic. The agent package does not
 * interpret source values; applications define their own provenance shape.
 */
export async function loadSourcedSkills<TSource, TSkill extends Skill = Skill>(
	env: ExecutionEnv,
	inputs: SourcedSkillInput<TSource>[],
	mapSkill?: (skill: Skill, source: TSource) => TSkill,
): Promise<LoadSourcedSkillsResult<TSkill, TSource>> {
	const skills: SourcedSkill<TSkill, TSource>[] = [];
	const diagnostics: SourcedSkillDiagnostic<TSource>[] = [];
	for (const input of inputs) {
		const result = await loadSkills(env, input.path);
		for (const skill of result.skills) {
			skills.push({ skill: mapSkill ? mapSkill(skill, input.source) : (skill as TSkill), source: input.source });
		}
		for (const diagnostic of result.diagnostics) diagnostics.push({ ...diagnostic, source: input.source });
	}
	return { skills, diagnostics };
}

async function findDirectorySkill(
	env: ExecutionEnv,
	entries: FileInfo[],
	ignoreMatcher: ignore.Ignore,
	rootDir: string,
	diagnostics: SkillDiagnostic[],
): Promise<SkillFileLoadResult | undefined> {
	for (const entry of entries) {
		if (entry.name !== "SKILL.md") continue;
		if ((await resolveKind(env, entry, diagnostics)) !== "file") continue;
		if (ignoreMatcher.ignores(relativeEnvPath(rootDir, entry.path))) continue;
		return loadSkillFromFile(env, entry.path);
	}
	return undefined;
}

function shouldSkipChildSkillEntry(entry: FileInfo): boolean {
	return entry.name.startsWith(".") || entry.name === "node_modules";
}

async function loadChildSkillEntry(
	env: ExecutionEnv,
	entry: FileInfo,
	includeRootFiles: boolean,
	ignoreMatcher: ignore.Ignore,
	rootDir: string,
	diagnostics: SkillDiagnostic[],
): Promise<LoadSkillsResult> {
	if (shouldSkipChildSkillEntry(entry)) return { skills: [], diagnostics: [] };
	const kind = await resolveKind(env, entry, diagnostics);
	if (!kind) return { skills: [], diagnostics: [] };
	const relPath = relativeEnvPath(rootDir, entry.path);
	const ignorePath = kind === "directory" ? `${relPath}/` : relPath;
	if (ignoreMatcher.ignores(ignorePath)) return { skills: [], diagnostics: [] };
	if (kind === "directory") return loadSkillsFromDirInternal(env, entry.path, false, ignoreMatcher, rootDir);
	if (!includeRootFiles || !entry.name.endsWith(".md")) return { skills: [], diagnostics: [] };
	const result = await loadSkillFromFile(env, entry.path);
	return { skills: result.skill ? [result.skill] : [], diagnostics: result.diagnostics };
}

function mergeSkillsResult(target: LoadSkillsResult, source: LoadSkillsResult): void {
	target.skills.push(...source.skills);
	target.diagnostics.push(...source.diagnostics);
}

async function loadSkillsFromDirInternal(
	env: ExecutionEnv,
	dir: string,
	includeRootFiles: boolean,
	ignoreMatcher: ignore.Ignore,
	rootDir: string,
): Promise<LoadSkillsResult> {
	const result: LoadSkillsResult = { skills: [], diagnostics: [] };
	const dirInfoResult = await env.fileInfo(dir);
	if (!dirInfoResult.ok) {
		appendFileInfoDiagnostic(result.diagnostics, dirInfoResult.error, dir);
		return result;
	}
	if ((await resolveKind(env, dirInfoResult.value, result.diagnostics)) !== "directory") return result;

	await addIgnoreRules(env, ignoreMatcher, dir, rootDir, result.diagnostics);
	const entriesResult = await env.listDir(dir);
	if (!entriesResult.ok) {
		result.diagnostics.push({
			type: "warning",
			code: "list_failed",
			message: entriesResult.error.message,
			path: dir,
		});
		return result;
	}
	const entries = entriesResult.value;
	const directorySkill = await findDirectorySkill(env, entries, ignoreMatcher, rootDir, result.diagnostics);
	if (directorySkill) {
		if (directorySkill.skill) result.skills.push(directorySkill.skill);
		result.diagnostics.push(...directorySkill.diagnostics);
		return result;
	}

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		mergeSkillsResult(
			result,
			await loadChildSkillEntry(env, entry, includeRootFiles, ignoreMatcher, rootDir, result.diagnostics),
		);
	}
	return result;
}

async function addIgnoreRules(
	env: ExecutionEnv,
	ig: ignore.Ignore,
	dir: string,
	rootDir: string,
	diagnostics: SkillDiagnostic[],
): Promise<void> {
	const relativeDir = relativeEnvPath(rootDir, dir);
	const prefix = relativeDir ? `${relativeDir}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = joinEnvPath(dir, filename);
		const info = await env.fileInfo(ignorePath);
		if (!info.ok) {
			if (info.error.code !== "not_found") {
				diagnostics.push({
					type: "warning",
					code: "file_info_failed",
					message: info.error.message,
					path: ignorePath,
				});
			}
			continue;
		}
		if (info.value.kind !== "file") continue;
		const content = await env.readTextFile(ignorePath);
		if (!content.ok) {
			diagnostics.push({ type: "warning", code: "read_failed", message: content.error.message, path: ignorePath });
			continue;
		}
		const patterns = content.value
			.split(/\r?\n/)
			.map((line) => prefixIgnorePattern(line, prefix))
			.filter((line): line is string => Boolean(line));
		if (patterns.length > 0) ig.add(patterns);
	}
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
	if (pattern.startsWith("/")) pattern = pattern.slice(1);
	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

async function loadSkillFromFile(env: ExecutionEnv, filePath: string): Promise<SkillFileLoadResult> {
	const diagnostics: SkillDiagnostic[] = [];
	const rawContent = await env.readTextFile(filePath);
	if (!rawContent.ok) {
		diagnostics.push({ type: "warning", code: "read_failed", message: rawContent.error.message, path: filePath });
		return { skill: null, diagnostics };
	}

	const parsed = parseFrontmatter<SkillFrontmatter>(rawContent.value);
	if (!parsed.ok) {
		diagnostics.push({ type: "warning", code: "parse_failed", message: parsed.error.message, path: filePath });
		return { skill: null, diagnostics };
	}

	const { frontmatter, body } = parsed.value;
	const skillDir = dirnameEnvPath(filePath);
	const parentDirName = basenameEnvPath(skillDir);
	const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined;

	for (const error of validateDescription(description)) {
		diagnostics.push({ type: "warning", code: "invalid_metadata", message: error, path: filePath });
	}

	const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
	const name = frontmatterName || parentDirName;
	for (const error of validateName(name, parentDirName)) {
		diagnostics.push({ type: "warning", code: "invalid_metadata", message: error, path: filePath });
	}

	if (!description || description.trim() === "") {
		return { skill: null, diagnostics };
	}

	return {
		skill: {
			name,
			description,
			content: body,
			filePath,
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		},
		diagnostics,
	};
}

function validateName(name: string, parentDirName: string): string[] {
	const errors: string[] = [];
	if (name !== parentDirName) errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
	if (name.length > MAX_NAME_LENGTH) errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
	}
	if (name.startsWith("-") || name.endsWith("-")) errors.push("name must not start or end with a hyphen");
	if (name.includes("--")) errors.push("name must not contain consecutive hyphens");
	return errors;
}

function validateDescription(description: string | undefined): string[] {
	const errors: string[] = [];
	if (!description || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}
	return errors;
}

function parseFrontmatter<T extends Record<string, unknown>>(content: string): Result<ParsedFrontmatter<T>, Error> {
	try {
		const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		if (!normalized.startsWith("---")) return { ok: true, value: { frontmatter: {} as T, body: normalized } };
		const endIndex = normalized.indexOf("\n---", 3);
		if (endIndex === -1) return { ok: true, value: { frontmatter: {} as T, body: normalized } };
		const yamlString = normalized.slice(4, endIndex);
		const body = normalized.slice(endIndex + 4).trim();
		return { ok: true, value: { frontmatter: (parse(yamlString) ?? {}) as T, body } };
	} catch (error) {
		return { ok: false, error: toError(error) };
	}
}

async function resolveKind(
	env: ExecutionEnv,
	info: FileInfo,
	diagnostics: SkillDiagnostic[],
): Promise<SkillPathKind | undefined> {
	if (info.kind === "file" || info.kind === "directory") return info.kind;
	const canonicalPath = await env.canonicalPath(info.path);
	if (!canonicalPath.ok) {
		if (canonicalPath.error.code !== "not_found") {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: canonicalPath.error.message,
				path: info.path,
			});
		}
		return undefined;
	}
	const target = await env.fileInfo(canonicalPath.value);
	if (!target.ok) {
		if (target.error.code !== "not_found") {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: target.error.message,
				path: info.path,
			});
		}
		return undefined;
	}
	return target.value.kind === "file" || target.value.kind === "directory" ? target.value.kind : undefined;
}

function joinEnvPath(base: string, child: string): string {
	return `${base.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`;
}

function dirnameEnvPath(path: string): string {
	const normalized = path.replace(/\/+$/, "");
	const slashIndex = normalized.lastIndexOf("/");
	return slashIndex <= 0 ? "/" : normalized.slice(0, slashIndex);
}

function basenameEnvPath(path: string): string {
	const normalized = path.replace(/\/+$/, "");
	const slashIndex = normalized.lastIndexOf("/");
	return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
}

function relativeEnvPath(root: string, path: string): string {
	const normalizedRoot = root.replace(/\/+$/, "");
	const normalizedPath = path.replace(/\/+$/, "");
	if (normalizedPath === normalizedRoot) return "";
	return normalizedPath.startsWith(`${normalizedRoot}/`)
		? normalizedPath.slice(normalizedRoot.length + 1)
		: normalizedPath.replace(/^\/+/, "");
}
