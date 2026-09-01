import { type Dirent, existsSync, readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import type { ResourceCollision, ResourceDiagnostic } from "./diagnostics.ts";
import {
	dirnamePortablePath,
	joinPortablePath,
	normalizePortablePath,
	type PortablePathFlavor,
	pathComparisonValue,
	relativePortablePath,
	relativeWithin,
	resolvePortablePath,
} from "./lsp/portable-path.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import type { ToolFileStat, ToolOperations } from "./tools/operations.ts";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type ConfiguredResourceSource = "user" | "project" | "path";
type ResourceSource = ConfiguredResourceSource | string;

export interface InstructionResourceFrontmatter {
	name?: string;
	description?: string;
	tools?: string | string[];
	"disable-model-invocation"?: boolean;
	[key: string]: unknown;
}

export interface InstructionResource {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo: SourceInfo;
	disableModelInvocation: boolean;
	tools?: string[];
	content?: string;
}

export interface InstructionResourceLoadResult<TResource extends InstructionResource> {
	resources: TResource[];
	diagnostics: ResourceDiagnostic[];
}

export interface InstructionResourceDirectoryOptions {
	/** Directory to scan for instruction resources. */
	dir: string;
	/** Source identifier for these instruction resources. */
	source: string;
}
interface LocalResourceTraversal<TResource extends InstructionResource> {
	entries: Dirent[];
	dir: string;
	source: string;
	includeRootFiles: boolean;
	ignoreMatcher: ignore.Ignore;
	rootDir: string;
	resources: TResource[];
	diagnostics: ResourceDiagnostic[];
}

interface BackendResourceTraversal<TResource extends InstructionResource> {
	entries: string[];
	operations: ToolOperations;
	dir: string;
	source: string;
	includeRootFiles: boolean;
	ignoreMatcher: ignore.Ignore;
	rootDir: string;
	resources: TResource[];
	diagnostics: ResourceDiagnostic[];
}

interface InstructionResourceParseResult<TResource extends InstructionResource> {
	resource: TResource | null;
	diagnostics: ResourceDiagnostic[];
}

interface InstructionResourcePromptFormatOptions {
	intro: string[];
	containerTag: string;
	itemTag: string;
}

export interface InstructionResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	resourcePaths: string[];
	includeDefaults: boolean;
}

export interface InstructionResourceLoaderWithOperationsOptions extends InstructionResourceLoaderOptions {
	operations: ToolOperations;
}

export interface InstructionResourceLoaderConfig {
	resourceType: ResourceCollision["resourceType"];
	defaultDirectoryName: string;
	rootFileName: string;
}

function toPosixPath(path: string): string {
	return path.split(sep).join("/");
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

function validateName(name: string): string[] {
	const errors: string[] = [];
	if (name.length > MAX_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}
	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
	}
	if (name.startsWith("-") || name.endsWith("-")) {
		errors.push("name must not start or end with a hyphen");
	}
	if (name.includes("--")) {
		errors.push("name must not contain consecutive hyphens");
	}
	return errors;
}

function validateDescription(description: string | undefined): string[] {
	if (!description || description.trim() === "") return ["description is required"];
	if (description.length > MAX_DESCRIPTION_LENGTH) {
		return [`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`];
	}
	return [];
}

function normalizeFrontmatterTools(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [];
	const tools: string[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (trimmed.length > 0 && !seen.has(trimmed)) {
			seen.add(trimmed);
			tools.push(trimmed);
		}
	}
	return tools;
}

function createResourceSourceInfo(filePath: string, baseDir: string, source: ResourceSource): SourceInfo {
	switch (source) {
		case "user":
			return createSyntheticSourceInfo(filePath, { source: "local", scope: "user", baseDir });
		case "project":
			return createSyntheticSourceInfo(filePath, { source: "local", scope: "project", baseDir });
		case "path":
			return createSyntheticSourceInfo(filePath, { source: "local", baseDir });
		default:
			return createSyntheticSourceInfo(filePath, { source, baseDir });
	}
}

function isUnderPath(target: string, root: string): boolean {
	const normalizedRoot = resolve(root);
	if (target === normalizedRoot) return true;
	const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
	return target.startsWith(prefix);
}

async function backendPathExists(operations: ToolOperations, path: string): Promise<boolean> {
	try {
		await operations.access(path, "exists");
		return true;
	} catch {
		return false;
	}
}

export abstract class InstructionResourceLoader<
	TResource extends InstructionResource,
	TFrontmatter extends InstructionResourceFrontmatter,
> {
	private resourceType: ResourceCollision["resourceType"];
	private defaultDirectoryName: string;
	private rootFileName: string;

	constructor(config: InstructionResourceLoaderConfig) {
		this.resourceType = config.resourceType;
		this.defaultDirectoryName = config.defaultDirectoryName;
		this.rootFileName = config.rootFileName;
	}

	protected abstract createResource(resource: InstructionResource, frontmatter: TFrontmatter): TResource;

	protected loadResourcesFromDir(dir: string, source: string): InstructionResourceLoadResult<TResource> {
		return this.loadResourcesFromDirInternal(dir, source, true);
	}

	private loadResourcesFromConfiguredPath(
		resolvedPath: string,
		source: ConfiguredResourceSource,
	): InstructionResourceLoadResult<TResource> {
		if (!existsSync(resolvedPath)) {
			return {
				resources: [],
				diagnostics: [{ type: "warning", message: `${this.resourceType} path does not exist`, path: resolvedPath }],
			};
		}
		try {
			const stats = statSync(resolvedPath);
			if (stats.isDirectory()) return this.loadResourcesFromDirInternal(resolvedPath, source, true);
			if (!stats.isFile() || !resolvedPath.endsWith(".md")) {
				return {
					resources: [],
					diagnostics: [
						{ type: "warning", message: `${this.resourceType} path is not a markdown file`, path: resolvedPath },
					],
				};
			}
			const result = this.loadResourceFromFile(resolvedPath, source);
			return { resources: result.resource ? [result.resource] : [], diagnostics: result.diagnostics };
		} catch (error) {
			return {
				resources: [],
				diagnostics: [
					{
						type: "warning",
						message: error instanceof Error ? error.message : `failed to read ${this.resourceType} path`,
						path: resolvedPath,
					},
				],
			};
		}
	}

	protected loadResources(options: InstructionResourceLoaderOptions): InstructionResourceLoadResult<TResource> {
		const resolvedCwd = resolvePath(options.cwd);
		const resolvedAgentDir = resolvePath(options.agentDir ?? getAgentDir());
		const resourceMap = new Map<string, TResource>();
		const realPathSet = new Set<string>();
		const allDiagnostics: ResourceDiagnostic[] = [];
		const collisionDiagnostics: ResourceDiagnostic[] = [];

		const addResources = (result: InstructionResourceLoadResult<TResource>): void => {
			allDiagnostics.push(...result.diagnostics);
			for (const resource of result.resources) {
				const realPath = canonicalizePath(resource.filePath);
				if (realPathSet.has(realPath)) continue;
				const existing = resourceMap.get(resource.name);
				if (existing) {
					collisionDiagnostics.push(this.createCollisionDiagnostic(resource, existing));
				} else {
					resourceMap.set(resource.name, resource);
					realPathSet.add(realPath);
				}
			}
		};

		if (options.includeDefaults) {
			addResources(
				this.loadResourcesFromDirInternal(join(resolvedAgentDir, this.defaultDirectoryName), "user", true),
			);
			addResources(
				this.loadResourcesFromDirInternal(
					resolve(resolvedCwd, CONFIG_DIR_NAME, this.defaultDirectoryName),
					"project",
					true,
				),
			);
		}

		const userDir = join(resolvedAgentDir, this.defaultDirectoryName);
		const projectDir = resolve(resolvedCwd, CONFIG_DIR_NAME, this.defaultDirectoryName);
		const getSource = (resolvedPath: string): ConfiguredResourceSource => {
			if (!options.includeDefaults) {
				if (isUnderPath(resolvedPath, userDir)) return "user";
				if (isUnderPath(resolvedPath, projectDir)) return "project";
			}
			return "path";
		};

		for (const rawPath of options.resourcePaths) {
			const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
			addResources(this.loadResourcesFromConfiguredPath(resolvedPath, getSource(resolvedPath)));
		}

		return {
			resources: Array.from(resourceMap.values()),
			diagnostics: [...allDiagnostics, ...collisionDiagnostics],
		};
	}

	private async loadResourcesFromConfiguredPathWithOperations(
		operations: ToolOperations,
		resolvedPath: string,
		source: ConfiguredResourceSource,
	): Promise<InstructionResourceLoadResult<TResource>> {
		if (!(await backendPathExists(operations, resolvedPath))) {
			return {
				resources: [],
				diagnostics: [{ type: "warning", message: `${this.resourceType} path does not exist`, path: resolvedPath }],
			};
		}
		try {
			const stats = await operations.stat(resolvedPath);
			if (stats.isDirectory()) {
				return this.loadResourcesFromDirInternalWithOperations(operations, resolvedPath, source, true);
			}
			if (!stats.isFile() || !resolvedPath.endsWith(".md")) {
				return {
					resources: [],
					diagnostics: [
						{
							type: "warning",
							message: `${this.resourceType} path is not a markdown file`,
							path: resolvedPath,
						},
					],
				};
			}
			const result = await this.loadResourceFromFileWithOperations(operations, resolvedPath, source);
			return { resources: result.resource ? [result.resource] : [], diagnostics: result.diagnostics };
		} catch (error) {
			return {
				resources: [],
				diagnostics: [
					{
						type: "warning",
						message: error instanceof Error ? error.message : `failed to read ${this.resourceType} path`,
						path: resolvedPath,
					},
				],
			};
		}
	}

	protected async loadResourcesWithOperations(
		options: InstructionResourceLoaderWithOperationsOptions,
	): Promise<InstructionResourceLoadResult<TResource>> {
		const backend = options.operations.getBackendInfo?.();
		const pathFlavor = backend?.type === "remote" && backend.configured ? backend.workspace.pathFlavor : undefined;
		const resolvedCwd = resolvePortablePath(options.operations.cwd, options.cwd);
		const resolvedAgentDir = normalizePortablePath(options.agentDir ?? getAgentDir(), pathFlavor);
		const resourceMap = new Map<string, TResource>();
		const pathSet = new Set<string>();
		const allDiagnostics: ResourceDiagnostic[] = [];
		const collisionDiagnostics: ResourceDiagnostic[] = [];

		const addResources = (result: InstructionResourceLoadResult<TResource>): void => {
			allDiagnostics.push(...result.diagnostics);
			for (const resource of result.resources) {
				const canonicalPath = pathComparisonValue(resource.filePath, pathFlavor);
				if (pathSet.has(canonicalPath)) continue;
				const existing = resourceMap.get(resource.name);
				if (existing) {
					collisionDiagnostics.push(this.createCollisionDiagnostic(resource, existing));
				} else {
					resourceMap.set(resource.name, resource);
					pathSet.add(canonicalPath);
				}
			}
		};

		if (options.includeDefaults) {
			addResources(
				await this.loadResourcesFromDirInternalWithOperations(
					options.operations,
					joinPortablePath(resolvedAgentDir, this.defaultDirectoryName),
					"user",
					true,
				),
			);
			addResources(
				await this.loadResourcesFromDirInternalWithOperations(
					options.operations,
					joinPortablePath(resolvedCwd, CONFIG_DIR_NAME, this.defaultDirectoryName),
					"project",
					true,
				),
			);
		}

		const userDir = joinPortablePath(resolvedAgentDir, this.defaultDirectoryName);
		const projectDir = joinPortablePath(resolvedCwd, CONFIG_DIR_NAME, this.defaultDirectoryName);
		const getSource = (resolvedPath: string): ConfiguredResourceSource => {
			if (!options.includeDefaults) {
				if (relativeWithin(userDir, resolvedPath) !== undefined) return "user";
				if (relativeWithin(projectDir, resolvedPath) !== undefined) return "project";
			}
			return "path";
		};

		for (const rawPath of options.resourcePaths) {
			const resolvedPath = resolvePortablePath(resolvedCwd, rawPath.trim());
			addResources(
				await this.loadResourcesFromConfiguredPathWithOperations(
					options.operations,
					resolvedPath,
					getSource(resolvedPath),
				),
			);
		}

		return {
			resources: Array.from(resourceMap.values()),
			diagnostics: [...allDiagnostics, ...collisionDiagnostics],
		};
	}

	private createCollisionDiagnostic(resource: TResource, existing: TResource): ResourceDiagnostic {
		return {
			type: "collision",
			message: `name "${resource.name}" collision`,
			path: resource.filePath,
			collision: {
				resourceType: this.resourceType,
				name: resource.name,
				winnerPath: existing.filePath,
				loserPath: resource.filePath,
			},
		};
	}

	private addIgnoreRules(ig: ignore.Ignore, dir: string, rootDir: string): void {
		const relativeDir = relative(rootDir, dir);
		const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";
		for (const filename of IGNORE_FILE_NAMES) {
			const ignorePath = join(dir, filename);
			if (!existsSync(ignorePath)) continue;
			try {
				const patterns = readFileSync(ignorePath, "utf-8")
					.split(/\r?\n/)
					.map((line) => prefixIgnorePattern(line, prefix))
					.filter((line): line is string => Boolean(line));
				if (patterns.length > 0) ig.add(patterns);
			} catch {}
		}
	}

	private async addIgnoreRulesWithOperations(
		operations: ToolOperations,
		ig: ignore.Ignore,
		dir: string,
		rootDir: string,
	): Promise<void> {
		const relativeDir = relativePortablePath(rootDir, dir);
		const prefix = relativeDir && relativeDir !== "." ? `${relativeDir.replace(/\\/g, "/")}/` : "";
		for (const filename of IGNORE_FILE_NAMES) {
			const ignorePath = joinPortablePath(dir, filename);
			if (!(await backendPathExists(operations, ignorePath))) continue;
			try {
				const patterns = (await operations.readFile(ignorePath))
					.toString("utf-8")
					.split(/\r?\n/)
					.map((line) => prefixIgnorePattern(line, prefix))
					.filter((line): line is string => Boolean(line));
				if (patterns.length > 0) ig.add(patterns);
			} catch {}
		}
	}

	private getLocalResourceEntry(entry: Dirent, fullPath: string): Dirent | Stats | undefined {
		if (!entry.isSymbolicLink()) return entry;
		try {
			return statSync(fullPath);
		} catch {
			return undefined;
		}
	}

	private loadRootResourceFromEntries(
		entries: Dirent[],
		dir: string,
		source: string,
		ignoreMatcher: ignore.Ignore,
		rootDir: string,
	): InstructionResourceLoadResult<TResource> | undefined {
		for (const entry of entries) {
			if (entry.name !== this.rootFileName) continue;
			const fullPath = join(dir, entry.name);
			const resourceEntry = this.getLocalResourceEntry(entry, fullPath);
			if (!resourceEntry?.isFile() || ignoreMatcher.ignores(toPosixPath(relative(rootDir, fullPath)))) continue;
			const result = this.loadResourceFromFile(fullPath, source);
			return { resources: result.resource ? [result.resource] : [], diagnostics: result.diagnostics };
		}
		return undefined;
	}

	private loadNestedResourceEntry(entry: Dirent, context: LocalResourceTraversal<TResource>): void {
		if (entry.name.startsWith(".") || entry.name === "node_modules") return;
		const fullPath = join(context.dir, entry.name);
		const resourceEntry = this.getLocalResourceEntry(entry, fullPath);
		if (!resourceEntry) return;
		const relativePath = toPosixPath(relative(context.rootDir, fullPath));
		if (context.ignoreMatcher.ignores(resourceEntry.isDirectory() ? `${relativePath}/` : relativePath)) return;
		if (resourceEntry.isDirectory()) {
			const nested = this.loadResourcesFromDirInternal(
				fullPath,
				context.source,
				false,
				context.ignoreMatcher,
				context.rootDir,
			);
			context.resources.push(...nested.resources);
			context.diagnostics.push(...nested.diagnostics);
			return;
		}
		if (!resourceEntry.isFile() || !context.includeRootFiles || !entry.name.endsWith(".md")) return;
		const result = this.loadResourceFromFile(fullPath, context.source);
		if (result.resource) context.resources.push(result.resource);
		context.diagnostics.push(...result.diagnostics);
	}

	private loadNestedResourcesFromEntries(context: LocalResourceTraversal<TResource>): void {
		for (const entry of context.entries) this.loadNestedResourceEntry(entry, context);
	}

	private loadResourcesFromDirInternal(
		dir: string,
		source: string,
		includeRootFiles: boolean,
		ignoreMatcher?: ignore.Ignore,
		rootDir?: string,
	): InstructionResourceLoadResult<TResource> {
		const resources: TResource[] = [];
		const diagnostics: ResourceDiagnostic[] = [];
		if (!existsSync(dir)) return { resources, diagnostics };

		const root = rootDir ?? dir;
		const ig = ignoreMatcher ?? ignore();
		this.addIgnoreRules(ig, dir, root);
		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			const rootResource = this.loadRootResourceFromEntries(entries, dir, source, ig, root);
			if (rootResource) return rootResource;
			this.loadNestedResourcesFromEntries({
				entries,
				dir,
				source,
				includeRootFiles,
				ignoreMatcher: ig,
				rootDir: root,
				resources,
				diagnostics,
			});
		} catch {}
		return { resources, diagnostics };
	}

	private async getBackendResourceEntry(
		operations: ToolOperations,
		fullPath: string,
	): Promise<ToolFileStat | undefined> {
		try {
			return await operations.stat(fullPath);
		} catch {
			return undefined;
		}
	}

	private async loadRootResourceWithOperations(
		context: BackendResourceTraversal<TResource>,
	): Promise<InstructionResourceLoadResult<TResource> | undefined> {
		for (const name of context.entries) {
			if (name !== this.rootFileName) continue;
			const fullPath = joinPortablePath(context.dir, name);
			const resourceEntry = await this.getBackendResourceEntry(context.operations, fullPath);
			if (
				!resourceEntry?.isFile() ||
				context.ignoreMatcher.ignores(relativePortablePath(context.rootDir, fullPath).replace(/\\/g, "/"))
			)
				continue;
			const result = await this.loadResourceFromFileWithOperations(context.operations, fullPath, context.source);
			return { resources: result.resource ? [result.resource] : [], diagnostics: result.diagnostics };
		}
		return undefined;
	}

	private async loadNestedResourceWithOperations(
		name: string,
		context: BackendResourceTraversal<TResource>,
	): Promise<void> {
		if (name.startsWith(".") || name === "node_modules") return;
		const fullPath = joinPortablePath(context.dir, name);
		const resourceEntry = await this.getBackendResourceEntry(context.operations, fullPath);
		if (!resourceEntry) return;
		const relativePath = relativePortablePath(context.rootDir, fullPath).replace(/\\/g, "/");
		if (context.ignoreMatcher.ignores(resourceEntry.isDirectory() ? `${relativePath}/` : relativePath)) return;
		if (resourceEntry.isDirectory()) {
			const nested = await this.loadResourcesFromDirInternalWithOperations(
				context.operations,
				fullPath,
				context.source,
				false,
				context.ignoreMatcher,
				context.rootDir,
			);
			context.resources.push(...nested.resources);
			context.diagnostics.push(...nested.diagnostics);
			return;
		}
		if (!resourceEntry.isFile() || !context.includeRootFiles || !name.endsWith(".md")) return;
		const result = await this.loadResourceFromFileWithOperations(context.operations, fullPath, context.source);
		if (result.resource) context.resources.push(result.resource);
		context.diagnostics.push(...result.diagnostics);
	}

	private async loadNestedResourcesWithOperations(context: BackendResourceTraversal<TResource>): Promise<void> {
		for (const name of context.entries) await this.loadNestedResourceWithOperations(name, context);
	}

	private async loadResourcesFromDirInternalWithOperations(
		operations: ToolOperations,
		dir: string,
		source: string,
		includeRootFiles: boolean,
		ignoreMatcher?: ignore.Ignore,
		rootDir?: string,
	): Promise<InstructionResourceLoadResult<TResource>> {
		const resources: TResource[] = [];
		const diagnostics: ResourceDiagnostic[] = [];
		if (!(await backendPathExists(operations, dir))) return { resources, diagnostics };

		const root = rootDir ?? dir;
		const ig = ignoreMatcher ?? ignore();
		await this.addIgnoreRulesWithOperations(operations, ig, dir, root);
		try {
			const context: BackendResourceTraversal<TResource> = {
				entries: await operations.readdir(dir),
				operations,
				dir,
				source,
				includeRootFiles,
				ignoreMatcher: ig,
				rootDir: root,
				resources,
				diagnostics,
			};
			const rootResource = await this.loadRootResourceWithOperations(context);
			if (rootResource) return rootResource;
			await this.loadNestedResourcesWithOperations(context);
		} catch {}
		return { resources, diagnostics };
	}

	private loadResourceFromFile(filePath: string, source: string): InstructionResourceParseResult<TResource> {
		try {
			return this.parseResource(readFileSync(filePath, "utf-8"), filePath, source);
		} catch (error) {
			return this.createParseError(error, filePath);
		}
	}

	private async loadResourceFromFileWithOperations(
		operations: ToolOperations,
		filePath: string,
		source: string,
	): Promise<InstructionResourceParseResult<TResource>> {
		try {
			const backend = operations.getBackendInfo?.();
			const pathFlavor = backend?.type === "remote" && backend.configured ? backend.workspace.pathFlavor : undefined;
			return this.parseResource(
				(await operations.readFile(filePath)).toString("utf-8"),
				filePath,
				source,
				pathFlavor,
			);
		} catch (error) {
			return this.createParseError(error, filePath);
		}
	}

	private parseResource(
		rawContent: string,
		filePath: string,
		source: string,
		pathFlavor?: PortablePathFlavor,
	): InstructionResourceParseResult<TResource> {
		const diagnostics: ResourceDiagnostic[] = [];
		const { frontmatter } = parseFrontmatter<TFrontmatter>(rawContent);
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
			return { resource: null, diagnostics };
		}
		const baseDir = pathFlavor ? dirnamePortablePath(filePath, pathFlavor) : dirname(filePath);
		const resource: InstructionResource = {
			name,
			description: frontmatter.description,
			filePath,
			baseDir,
			sourceInfo: createResourceSourceInfo(filePath, baseDir, source),
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
			tools: normalizeFrontmatterTools(frontmatter.tools),
		};
		return { resource: this.createResource(resource, frontmatter), diagnostics };
	}

	private createParseError(error: unknown, filePath: string): InstructionResourceParseResult<TResource> {
		return {
			resource: null,
			diagnostics: [
				{
					type: "warning",
					message: error instanceof Error ? error.message : `failed to parse ${this.resourceType} file`,
					path: filePath,
				},
			],
		};
	}
}

export function formatInstructionResourcesForPrompt(
	resources: InstructionResource[],
	options: InstructionResourcePromptFormatOptions,
): string {
	const visibleResources = resources.filter((resource) => !resource.disableModelInvocation);
	if (visibleResources.length === 0) return "";

	const [firstIntroLine = "", ...remainingIntroLines] = options.intro;
	const lines = [`\n\n${firstIntroLine}`, ...remainingIntroLines, "", `<${options.containerTag}>`];
	for (const resource of visibleResources) {
		lines.push(`  <${options.itemTag}>`);
		lines.push(`    <name>${escapeXml(resource.name)}</name>`);
		lines.push(`    <description>${escapeXml(resource.description)}</description>`);
		lines.push(`    <location>${escapeXml(resource.filePath)}</location>`);
		lines.push(`  </${options.itemTag}>`);
	}
	lines.push(`</${options.containerTag}>`);
	return lines.join("\n");
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
