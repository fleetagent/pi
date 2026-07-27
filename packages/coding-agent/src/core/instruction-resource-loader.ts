import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
	pathComparisonValue,
	relativePortablePath,
	relativeWithin,
	resolvePortablePath,
} from "./lsp/portable-path.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import type { ToolOperations } from "./tools/operations.ts";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;
type ResourceSource = "user" | "project" | "path" | string;

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
	for (const entry of raw) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (trimmed.length > 0 && !tools.includes(trimmed)) tools.push(trimmed);
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
		const getSource = (resolvedPath: string): "user" | "project" | "path" => {
			if (!options.includeDefaults) {
				if (isUnderPath(resolvedPath, userDir)) return "user";
				if (isUnderPath(resolvedPath, projectDir)) return "project";
			}
			return "path";
		};

		for (const rawPath of options.resourcePaths) {
			const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
			if (!existsSync(resolvedPath)) {
				allDiagnostics.push({
					type: "warning",
					message: `${this.resourceType} path does not exist`,
					path: resolvedPath,
				});
				continue;
			}
			try {
				const stats = statSync(resolvedPath);
				const source = getSource(resolvedPath);
				if (stats.isDirectory()) {
					addResources(this.loadResourcesFromDirInternal(resolvedPath, source, true));
				} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
					const result = this.loadResourceFromFile(resolvedPath, source);
					if (result.resource) addResources({ resources: [result.resource], diagnostics: result.diagnostics });
					else allDiagnostics.push(...result.diagnostics);
				} else {
					allDiagnostics.push({
						type: "warning",
						message: `${this.resourceType} path is not a markdown file`,
						path: resolvedPath,
					});
				}
			} catch (error) {
				allDiagnostics.push({
					type: "warning",
					message: error instanceof Error ? error.message : `failed to read ${this.resourceType} path`,
					path: resolvedPath,
				});
			}
		}

		return {
			resources: Array.from(resourceMap.values()),
			diagnostics: [...allDiagnostics, ...collisionDiagnostics],
		};
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
		const getSource = (resolvedPath: string): "user" | "project" | "path" => {
			if (!options.includeDefaults) {
				if (relativeWithin(userDir, resolvedPath) !== undefined) return "user";
				if (relativeWithin(projectDir, resolvedPath) !== undefined) return "project";
			}
			return "path";
		};

		for (const rawPath of options.resourcePaths) {
			const resolvedPath = resolvePortablePath(resolvedCwd, rawPath.trim());
			if (!(await backendPathExists(options.operations, resolvedPath))) {
				allDiagnostics.push({
					type: "warning",
					message: `${this.resourceType} path does not exist`,
					path: resolvedPath,
				});
				continue;
			}
			try {
				const stats = await options.operations.stat(resolvedPath);
				const source = getSource(resolvedPath);
				if (stats.isDirectory()) {
					addResources(
						await this.loadResourcesFromDirInternalWithOperations(options.operations, resolvedPath, source, true),
					);
				} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
					const result = await this.loadResourceFromFileWithOperations(options.operations, resolvedPath, source);
					if (result.resource) addResources({ resources: [result.resource], diagnostics: result.diagnostics });
					else allDiagnostics.push(...result.diagnostics);
				} else {
					allDiagnostics.push({
						type: "warning",
						message: `${this.resourceType} path is not a markdown file`,
						path: resolvedPath,
					});
				}
			} catch (error) {
				allDiagnostics.push({
					type: "warning",
					message: error instanceof Error ? error.message : `failed to read ${this.resourceType} path`,
					path: resolvedPath,
				});
			}
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

	private addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
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
		ig: IgnoreMatcher,
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

	private loadResourcesFromDirInternal(
		dir: string,
		source: string,
		includeRootFiles: boolean,
		ignoreMatcher?: IgnoreMatcher,
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
			for (const entry of entries) {
				if (entry.name !== this.rootFileName) continue;
				const fullPath = join(dir, entry.name);
				let isFile = entry.isFile();
				if (entry.isSymbolicLink()) {
					try {
						isFile = statSync(fullPath).isFile();
					} catch {
						continue;
					}
				}
				if (!isFile || ig.ignores(toPosixPath(relative(root, fullPath)))) continue;
				const result = this.loadResourceFromFile(fullPath, source);
				if (result.resource) resources.push(result.resource);
				diagnostics.push(...result.diagnostics);
				return { resources, diagnostics };
			}

			for (const entry of entries) {
				if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
				const fullPath = join(dir, entry.name);
				let isDirectory = entry.isDirectory();
				let isFile = entry.isFile();
				if (entry.isSymbolicLink()) {
					try {
						const stats = statSync(fullPath);
						isDirectory = stats.isDirectory();
						isFile = stats.isFile();
					} catch {
						continue;
					}
				}
				const relPath = toPosixPath(relative(root, fullPath));
				if (ig.ignores(isDirectory ? `${relPath}/` : relPath)) continue;
				if (isDirectory) {
					const nested = this.loadResourcesFromDirInternal(fullPath, source, false, ig, root);
					resources.push(...nested.resources);
					diagnostics.push(...nested.diagnostics);
					continue;
				}
				if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) continue;
				const result = this.loadResourceFromFile(fullPath, source);
				if (result.resource) resources.push(result.resource);
				diagnostics.push(...result.diagnostics);
			}
		} catch {}
		return { resources, diagnostics };
	}

	private async loadResourcesFromDirInternalWithOperations(
		operations: ToolOperations,
		dir: string,
		source: string,
		includeRootFiles: boolean,
		ignoreMatcher?: IgnoreMatcher,
		rootDir?: string,
	): Promise<InstructionResourceLoadResult<TResource>> {
		const resources: TResource[] = [];
		const diagnostics: ResourceDiagnostic[] = [];
		if (!(await backendPathExists(operations, dir))) return { resources, diagnostics };

		const root = rootDir ?? dir;
		const ig = ignoreMatcher ?? ignore();
		await this.addIgnoreRulesWithOperations(operations, ig, dir, root);
		try {
			const entries = await operations.readdir(dir);
			for (const name of entries) {
				if (name !== this.rootFileName) continue;
				const fullPath = joinPortablePath(dir, name);
				let isFile = false;
				try {
					isFile = (await operations.stat(fullPath)).isFile();
				} catch {
					continue;
				}
				if (!isFile || ig.ignores(relativePortablePath(root, fullPath).replace(/\\/g, "/"))) continue;
				const result = await this.loadResourceFromFileWithOperations(operations, fullPath, source);
				if (result.resource) resources.push(result.resource);
				diagnostics.push(...result.diagnostics);
				return { resources, diagnostics };
			}

			for (const name of entries) {
				if (name.startsWith(".") || name === "node_modules") continue;
				const fullPath = joinPortablePath(dir, name);
				let isDirectory = false;
				let isFile = false;
				try {
					const stats = await operations.stat(fullPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
				const relPath = relativePortablePath(root, fullPath).replace(/\\/g, "/");
				if (ig.ignores(isDirectory ? `${relPath}/` : relPath)) continue;
				if (isDirectory) {
					const nested = await this.loadResourcesFromDirInternalWithOperations(
						operations,
						fullPath,
						source,
						false,
						ig,
						root,
					);
					resources.push(...nested.resources);
					diagnostics.push(...nested.diagnostics);
					continue;
				}
				if (!isFile || !includeRootFiles || !name.endsWith(".md")) continue;
				const result = await this.loadResourceFromFileWithOperations(operations, fullPath, source);
				if (result.resource) resources.push(result.resource);
				diagnostics.push(...result.diagnostics);
			}
		} catch {}
		return { resources, diagnostics };
	}

	private loadResourceFromFile(
		filePath: string,
		source: string,
	): { resource: TResource | null; diagnostics: ResourceDiagnostic[] } {
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
	): Promise<{ resource: TResource | null; diagnostics: ResourceDiagnostic[] }> {
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
		pathFlavor?: "posix" | "windows",
	): { resource: TResource | null; diagnostics: ResourceDiagnostic[] } {
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

	private createParseError(error: unknown, filePath: string): { resource: null; diagnostics: ResourceDiagnostic[] } {
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
	options: {
		intro: string[];
		containerTag: string;
		itemTag: string;
	},
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
