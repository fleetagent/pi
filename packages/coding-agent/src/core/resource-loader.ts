import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import chalk from "chalk";
import { CONFIG_DIR_NAME } from "../config.ts";
import { loadThemeFromPath, type Theme } from "../modes/interactive/theme/theme.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";

export type { ResourceCollision, ResourceDiagnostic } from "./diagnostics.ts";

import { canonicalizePath, isLocalPath, resolvePath } from "../utils/paths.ts";
import { createEventBus, type EventBus } from "./event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory, loadExtensions } from "./extensions/loader.ts";
import type { Extension, ExtensionFactory, ExtensionRuntime, LoadExtensionsResult } from "./extensions/types.ts";
import { dirnamePortablePath, joinPortablePath, pathComparisonValue, relativeWithin } from "./lsp/portable-path.ts";
import {
	DefaultPackageManager,
	type PathMetadata,
	type ResolvedPaths,
	type ResolvedResource,
} from "./package-manager.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import { loadPromptTemplates, loadPromptTemplatesWithOperations } from "./prompt-templates.ts";
import type { LoadRulesResult, Rule } from "./rules.ts";
import { loadRules, loadRulesWithOperations } from "./rules.ts";
import { SettingsManager } from "./settings-manager.ts";
import type { LoadSkillsResult, Skill } from "./skills.ts";
import { loadSkills, loadSkillsWithOperations } from "./skills.ts";
import { createSourceInfo, createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { resetTimings } from "./timings.ts";
import type { ToolBackendInfo, ToolOperations } from "./tools/operations.ts";
import type { WorkspaceIdentity } from "./workspace-identity.ts";

export interface ProjectContextFile {
	path: string;
	content: string;
	sourceInfo?: SourceInfo;
}

interface NamedResourceMergeResult<T> {
	resources: T[];
	diagnostics: ResourceDiagnostic[];
}

export interface ResourcePathEntry {
	path: string;
	metadata: PathMetadata;
}

export interface LoadPromptTemplatesResult {
	prompts: PromptTemplate[];
	diagnostics: ResourceDiagnostic[];
}

export interface LoadThemesResult {
	themes: Theme[];
	diagnostics: ResourceDiagnostic[];
}

export interface ProjectContextFilesResult {
	agentsFiles: ProjectContextFile[];
}

export interface LoadProjectContextFilesOptions {
	cwd: string;
	agentDir: string;
}

export type ResourceOverride<TResult> = (base: TResult) => TResult;

interface LoadProjectContextFilesWithOperationsOptions extends LoadProjectContextFilesOptions {
	operations: ToolOperations;
	workspace?: WorkspaceIdentity;
}

type ConfiguredInstructionBackend = Extract<ToolBackendInfo, { type: "remote"; configured: true }>;

interface RemoteInstructionResourcePaths {
	skills: ResourcePathEntry[];
	rules: ResourcePathEntry[];
	prompts: ResourcePathEntry[];
}

// pi-ignore noNearIdenticalDataStructures: Resolved reload paths are required runtime inputs, while PiManifest is an optional package declaration with independent validation and evolution.
interface ReloadResourcePaths {
	extensions: string[];
	skills: string[];
	rules: string[];
	prompts: string[];
	themes: string[];
}

type InlineExtensionLoadResult = Pick<LoadExtensionsResult, "extensions" | "errors">;

function appendMissingResourceDiagnostic(
	resolvedPath: string,
	diagnostics: ResourceDiagnostic[],
	diagnosticPaths: Set<string | undefined>,
	message: string,
): void {
	if (existsSync(resolvedPath) || diagnosticPaths.has(resolvedPath)) return;
	diagnostics.push({ type: "error", message, path: resolvedPath });
	diagnosticPaths.add(resolvedPath);
}

interface ExtensionConflict {
	path: string;
	message: string;
}

type NamedInstructionResourceType = "skill" | "rule";

function mergeNamedResources<T extends { name: string; filePath: string }>(
	primary: readonly T[],
	secondary: readonly T[],
	resourceType: NamedInstructionResourceType,
): NamedResourceMergeResult<T> {
	const resources = new Map(primary.map((resource) => [resource.name, resource]));
	const diagnostics: ResourceDiagnostic[] = [];
	for (const resource of secondary) {
		const winner = resources.get(resource.name);
		if (!winner) {
			resources.set(resource.name, resource);
			continue;
		}
		diagnostics.push({
			type: "collision",
			message: `name ${JSON.stringify(resource.name)} collision`,
			path: resource.filePath,
			collision: {
				resourceType,
				name: resource.name,
				winnerPath: winner.filePath,
				loserPath: resource.filePath,
			},
		});
	}
	return { resources: [...resources.values()], diagnostics };
}
export interface ResourceExtensionPaths {
	skillPaths?: ResourcePathEntry[];
	rulePaths?: ResourcePathEntry[];
	promptPaths?: ResourcePathEntry[];
	themePaths?: ResourcePathEntry[];
}

export interface ResourceLoader {
	getExtensions(): LoadExtensionsResult;
	getSkills(): LoadSkillsResult;
	getRules(): LoadRulesResult;
	getPrompts(): LoadPromptTemplatesResult;
	getThemes(): LoadThemesResult;
	getAgentsFiles(): ProjectContextFilesResult;
	getSystemPrompt(): string | undefined;
	getAppendSystemPrompt(): string[];
	setToolOperations?(operations: ToolOperations | undefined): void;
	extendResources(paths: ResourceExtensionPaths): void;
	reload(): Promise<void>;
}

async function resolvePromptInput(
	input: string | undefined,
	description: string,
	operations?: ToolOperations,
): Promise<string | undefined> {
	if (!input) {
		return undefined;
	}

	if (existsSync(input)) {
		try {
			return readFileSync(input, "utf-8");
		} catch (error) {
			console.error(chalk.yellow(`Warning: Could not read ${description} file ${input}: ${error}`));
			return input;
		}
	}

	if (operations) {
		try {
			await operations.access(input, "read");
			return (await operations.readFile(input)).toString("utf-8");
		} catch {}
	}

	return input;
}

const CONTEXT_FILE_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

function loadContextFileFromDir(dir: string): ProjectContextFile | null {
	for (const filename of CONTEXT_FILE_CANDIDATES) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				if (!statSync(filePath).isFile()) continue;
				return {
					path: filePath,
					content: readFileSync(filePath, "utf-8"),
				};
			} catch (error) {
				console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
			}
		}
	}
	return null;
}

export function loadProjectContextFiles(options: LoadProjectContextFilesOptions): ProjectContextFile[] {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);

	const contextFiles: ProjectContextFile[] = [];
	const seenPaths = new Set<string>();

	const globalContext = loadContextFileFromDir(resolvedAgentDir);
	if (globalContext) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	const ancestorContextFiles: ProjectContextFile[] = [];

	let currentDir = resolvedCwd;
	const root = resolve("/");

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		if (contextFile && !seenPaths.has(contextFile.path)) {
			ancestorContextFiles.unshift(contextFile);
			seenPaths.add(contextFile.path);
		}

		if (currentDir === root) break;

		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	contextFiles.push(...ancestorContextFiles);

	return contextFiles;
}

async function loadContextFileFromDirWithOperations(
	operations: ToolOperations,
	dir: string,
	workspace?: WorkspaceIdentity,
): Promise<ProjectContextFile | null> {
	for (const filename of CONTEXT_FILE_CANDIDATES) {
		const filePath = joinPortablePath(dir, filename);
		try {
			if (!(await operations.stat(filePath)).isFile()) continue;
			await operations.access(filePath, "read");
			return {
				path: filePath,
				content: (await operations.readFile(filePath)).toString("utf-8"),
				sourceInfo: {
					path: filePath,
					source: "remote",
					scope: "project",
					origin: "top-level",
					baseDir: dir,
					...(workspace ? { workspace } : {}),
				},
			};
		} catch {}
	}
	return null;
}

async function loadProjectContextFilesWithOperations(
	options: LoadProjectContextFilesWithOperationsOptions,
): Promise<ProjectContextFile[]> {
	const contextFiles: ProjectContextFile[] = [];
	const seenPaths = new Set<string>();
	const globalContext = loadContextFileFromDir(resolvePath(options.agentDir));
	if (globalContext) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	const ancestorContextFiles: ProjectContextFile[] = [];
	let currentDir = options.cwd;
	while (true) {
		const contextFile = await loadContextFileFromDirWithOperations(options.operations, currentDir, options.workspace);
		if (contextFile && !seenPaths.has(contextFile.path)) {
			ancestorContextFiles.unshift(contextFile);
			seenPaths.add(contextFile.path);
		}
		if (
			options.workspace &&
			pathComparisonValue(currentDir, options.workspace.pathFlavor) ===
				pathComparisonValue(options.workspace.root, options.workspace.pathFlavor)
		)
			break;
		const parentDir = dirnamePortablePath(currentDir, options.workspace?.pathFlavor);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}
	contextFiles.push(...ancestorContextFiles);
	const sandboxContext = await loadSandboxContextFileWithOperations(options.operations, options.workspace);
	if (sandboxContext && !seenPaths.has(sandboxContext.path)) contextFiles.push(sandboxContext);
	return contextFiles;
}

async function loadSandboxContextFileWithOperations(
	operations: ToolOperations,
	workspace?: WorkspaceIdentity,
): Promise<ProjectContextFile | null> {
	if (!workspace || !operations.readResource) return null;
	try {
		const content = (await operations.readResource("SANDBOX.md")).toString("utf-8");
		return {
			path: "SANDBOX.md",
			content,
			sourceInfo: createSyntheticSourceInfo("SANDBOX.md", {
				source: "remote",
				scope: "project",
				origin: "top-level",
				baseDir: workspace.root,
				workspace,
			}),
		};
	} catch {
		return null;
	}
}

export interface DefaultResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	settingsManager?: SettingsManager;
	eventBus?: EventBus;
	additionalExtensionPaths?: string[];
	additionalSkillPaths?: string[];
	additionalRulePaths?: string[];
	additionalPromptTemplatePaths?: string[];
	additionalThemePaths?: string[];
	extensionFactories?: ExtensionFactory[];
	noExtensions?: boolean;
	noSkills?: boolean;
	noRules?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	toolOperations?: ToolOperations;
	extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	skillsOverride?: ResourceOverride<LoadSkillsResult>;
	rulesOverride?: ResourceOverride<LoadRulesResult>;
	promptsOverride?: ResourceOverride<LoadPromptTemplatesResult>;
	themesOverride?: ResourceOverride<LoadThemesResult>;
	agentsFilesOverride?: ResourceOverride<ProjectContextFilesResult>;
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride?: (base: string[]) => string[];
}

export class DefaultResourceLoader implements ResourceLoader {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;
	private eventBus: EventBus;
	private packageManager: DefaultPackageManager;
	private additionalExtensionPaths: string[];
	private additionalSkillPaths: string[];
	private additionalRulePaths: string[];
	private additionalPromptTemplatePaths: string[];
	private additionalThemePaths: string[];
	private extensionFactories: ExtensionFactory[];
	private noExtensions: boolean;
	private noSkills: boolean;
	private noRules: boolean;
	private noPromptTemplates: boolean;
	private noThemes: boolean;
	private noContextFiles: boolean;
	private systemPromptSource?: string;
	private appendSystemPromptSource?: string[];
	private toolOperations?: ToolOperations;
	private extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	private skillsOverride?: ResourceOverride<LoadSkillsResult>;
	private rulesOverride?: ResourceOverride<LoadRulesResult>;
	private promptsOverride?: ResourceOverride<LoadPromptTemplatesResult>;
	private themesOverride?: ResourceOverride<LoadThemesResult>;
	private agentsFilesOverride?: ResourceOverride<ProjectContextFilesResult>;
	private systemPromptOverride?: (base: string | undefined) => string | undefined;
	private appendSystemPromptOverride?: (base: string[]) => string[];

	private extensionsResult: LoadExtensionsResult;
	private skills: Skill[];
	private skillDiagnostics: ResourceDiagnostic[];
	private rules: Rule[];
	private ruleDiagnostics: ResourceDiagnostic[];
	private prompts: PromptTemplate[];
	private promptDiagnostics: ResourceDiagnostic[];
	private themes: Theme[];
	private themeDiagnostics: ResourceDiagnostic[];
	private agentsFiles: ProjectContextFile[];
	private systemPrompt?: string;
	private appendSystemPrompt: string[];
	private lastSkillPaths: string[];
	private lastRulePaths: string[];
	private extensionSkillSourceInfos: Map<string, SourceInfo>;
	private extensionRuleSourceInfos: Map<string, SourceInfo>;
	private extensionPromptSourceInfos: Map<string, SourceInfo>;
	private extensionThemeSourceInfos: Map<string, SourceInfo>;
	private lastPromptPaths: string[];
	private lastThemePaths: string[];

	constructor(options: DefaultResourceLoaderOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager ?? SettingsManager.create(this.cwd, this.agentDir);
		this.eventBus = options.eventBus ?? createEventBus();
		this.packageManager = new DefaultPackageManager({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
		});
		this.additionalExtensionPaths = options.additionalExtensionPaths ?? [];
		this.additionalSkillPaths = options.additionalSkillPaths ?? [];
		this.additionalRulePaths = options.additionalRulePaths ?? [];
		this.additionalPromptTemplatePaths = options.additionalPromptTemplatePaths ?? [];
		this.additionalThemePaths = options.additionalThemePaths ?? [];
		this.extensionFactories = options.extensionFactories ?? [];
		this.noExtensions = options.noExtensions ?? false;
		this.noSkills = options.noSkills ?? false;
		this.noRules = options.noRules ?? false;
		this.noPromptTemplates = options.noPromptTemplates ?? false;
		this.noThemes = options.noThemes ?? false;
		this.noContextFiles = options.noContextFiles ?? false;
		this.systemPromptSource = options.systemPrompt;
		this.appendSystemPromptSource = options.appendSystemPrompt;
		this.toolOperations = options.toolOperations;
		this.extensionsOverride = options.extensionsOverride;
		this.skillsOverride = options.skillsOverride;
		this.rulesOverride = options.rulesOverride;
		this.promptsOverride = options.promptsOverride;
		this.themesOverride = options.themesOverride;
		this.agentsFilesOverride = options.agentsFilesOverride;
		this.systemPromptOverride = options.systemPromptOverride;
		this.appendSystemPromptOverride = options.appendSystemPromptOverride;

		this.extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
		this.skills = [];
		this.skillDiagnostics = [];
		this.rules = [];
		this.ruleDiagnostics = [];
		this.prompts = [];
		this.promptDiagnostics = [];
		this.themes = [];
		this.themeDiagnostics = [];
		this.agentsFiles = [];
		this.appendSystemPrompt = [];
		this.lastSkillPaths = [];
		this.lastRulePaths = [];
		this.extensionSkillSourceInfos = new Map();
		this.extensionRuleSourceInfos = new Map();
		this.extensionPromptSourceInfos = new Map();
		this.extensionThemeSourceInfos = new Map();
		this.lastPromptPaths = [];
		this.lastThemePaths = [];
	}

	getExtensions(): LoadExtensionsResult {
		return this.extensionsResult;
	}

	getSkills(): LoadSkillsResult {
		return { skills: this.skills, diagnostics: this.skillDiagnostics };
	}

	getRules(): LoadRulesResult {
		return { rules: this.rules, diagnostics: this.ruleDiagnostics };
	}

	getPrompts(): LoadPromptTemplatesResult {
		return { prompts: this.prompts, diagnostics: this.promptDiagnostics };
	}

	getThemes(): LoadThemesResult {
		return { themes: this.themes, diagnostics: this.themeDiagnostics };
	}

	getAgentsFiles(): ProjectContextFilesResult {
		return { agentsFiles: this.agentsFiles };
	}

	getSystemPrompt(): string | undefined {
		return this.systemPrompt;
	}

	getAppendSystemPrompt(): string[] {
		return this.appendSystemPrompt;
	}

	setToolOperations(operations: ToolOperations | undefined): void {
		this.toolOperations = operations;
	}

	private getInstructionOperations(): ToolOperations | undefined {
		const backend = this.toolOperations?.getBackendInfo?.();
		return backend?.type === "remote" && backend.configured ? this.toolOperations : undefined;
	}

	private getRemoteProjectInstructionResourcePaths(
		cwd: string,
		backend: ConfiguredInstructionBackend,
	): RemoteInstructionResourcePaths {
		const projectBaseDir = joinPortablePath(cwd, CONFIG_DIR_NAME);
		const projectMetadata: PathMetadata = {
			source: "remote",
			scope: "project",
			origin: "top-level",
			baseDir: projectBaseDir,
			workspace: backend.workspace,
		};
		const skills: ResourcePathEntry[] = [
			{ path: joinPortablePath(projectBaseDir, "skills"), metadata: projectMetadata },
		];
		const rules: ResourcePathEntry[] = [
			{ path: joinPortablePath(projectBaseDir, "rules"), metadata: projectMetadata },
		];
		const prompts: ResourcePathEntry[] = [
			{ path: joinPortablePath(projectBaseDir, "prompts"), metadata: projectMetadata },
		];

		let currentDir = cwd;
		const boundary = backend.workspace.root;
		while (true) {
			const agentsBaseDir = joinPortablePath(currentDir, ".agents");
			const agentsMetadata: PathMetadata = {
				source: "remote",
				scope: "project",
				origin: "top-level",
				baseDir: agentsBaseDir,
				workspace: backend.workspace,
			};
			skills.push({ path: joinPortablePath(agentsBaseDir, "skills"), metadata: agentsMetadata });
			rules.push({ path: joinPortablePath(agentsBaseDir, "rules"), metadata: agentsMetadata });
			if (
				pathComparisonValue(currentDir, backend.workspace.pathFlavor) ===
				pathComparisonValue(boundary, backend.workspace.pathFlavor)
			)
				break;
			const parentDir = dirnamePortablePath(currentDir, backend.workspace.pathFlavor);
			if (parentDir === currentDir) break;
			currentDir = parentDir;
		}

		return { skills, rules, prompts };
	}

	extendResources(paths: ResourceExtensionPaths): void {
		const skillPaths = this.normalizeExtensionPaths(paths.skillPaths ?? []);
		const rulePaths = this.normalizeExtensionPaths(paths.rulePaths ?? []);
		const promptPaths = this.normalizeExtensionPaths(paths.promptPaths ?? []);
		const themePaths = this.normalizeExtensionPaths(paths.themePaths ?? []);

		for (const entry of skillPaths) {
			this.extensionSkillSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}
		for (const entry of rulePaths) {
			this.extensionRuleSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}
		for (const entry of promptPaths) {
			this.extensionPromptSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}
		for (const entry of themePaths) {
			this.extensionThemeSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}

		if (skillPaths.length > 0) {
			this.lastSkillPaths = this.mergePaths(
				this.lastSkillPaths,
				skillPaths.map((entry) => entry.path),
			);
			this.updateSkillsFromPaths(this.lastSkillPaths);
		}

		if (rulePaths.length > 0) {
			this.lastRulePaths = this.mergePaths(
				this.lastRulePaths,
				rulePaths.map((entry) => entry.path),
			);
			this.updateRulesFromPaths(this.lastRulePaths);
		}

		if (promptPaths.length > 0) {
			this.lastPromptPaths = this.mergePaths(
				this.lastPromptPaths,
				promptPaths.map((entry) => entry.path),
			);
			this.updatePromptsFromPaths(this.lastPromptPaths);
		}

		if (themePaths.length > 0) {
			this.lastThemePaths = this.mergePaths(
				this.lastThemePaths,
				themePaths.map((entry) => entry.path),
			);
			this.updateThemesFromPaths(this.lastThemePaths);
		}
	}

	private recordResourceMetadata(resources: ResolvedResource[], metadataByPath: Map<string, PathMetadata>): void {
		for (const resource of resources) {
			if (!metadataByPath.has(resource.path)) metadataByPath.set(resource.path, resource.metadata);
		}
	}

	private getEnabledResources(
		resources: ResolvedResource[],
		metadataByPath: Map<string, PathMetadata>,
	): ResolvedResource[] {
		this.recordResourceMetadata(resources, metadataByPath);
		return resources.filter((resource) => resource.enabled);
	}

	private getEnabledPaths(resources: ResolvedResource[], metadataByPath: Map<string, PathMetadata>): string[] {
		return this.getEnabledResources(resources, metadataByPath).map((resource) => resource.path);
	}

	private shouldExcludeLocalProjectInstructionResource(
		resource: ResolvedResource,
		loadProjectInstructionsRemotely: boolean,
	): boolean {
		return (
			loadProjectInstructionsRemotely &&
			resource.metadata.scope === "project" &&
			resource.metadata.origin === "top-level"
		);
	}

	private normalizePackagedInstructionPath(
		resource: ResolvedResource,
		filename: string,
		metadataByPath: Map<string, PathMetadata>,
	): string {
		if (resource.metadata.source !== "auto" && resource.metadata.origin !== "package") return resource.path;
		try {
			if (!statSync(resource.path).isDirectory()) return resource.path;
		} catch {
			return resource.path;
		}
		const instructionFile = join(resource.path, filename);
		if (!existsSync(instructionFile)) return resource.path;
		if (!metadataByPath.has(instructionFile)) metadataByPath.set(instructionFile, resource.metadata);
		return instructionFile;
	}

	private async filterExistingRemoteInstructionPaths(
		entries: ResourcePathEntry[],
		operations: ToolOperations,
	): Promise<ResourcePathEntry[]> {
		const existing: ResourcePathEntry[] = [];
		for (const entry of entries) {
			try {
				await operations.access(entry.path, "exists");
				existing.push(entry);
			} catch {}
		}
		return existing;
	}

	private async discoverRemoteInstructionResourcePaths(
		operations: ToolOperations | undefined,
	): Promise<RemoteInstructionResourcePaths> {
		const emptyPaths = { skills: [], rules: [], prompts: [] };
		if (!operations) return emptyPaths;
		const backend = operations.getBackendInfo?.();
		if (backend?.type !== "remote" || !backend.configured) return emptyPaths;
		const discovered = this.getRemoteProjectInstructionResourcePaths(operations.cwd, backend);
		return {
			skills: await this.filterExistingRemoteInstructionPaths(discovered.skills, operations),
			rules: await this.filterExistingRemoteInstructionPaths(discovered.rules, operations),
			prompts: await this.filterExistingRemoteInstructionPaths(discovered.prompts, operations),
		};
	}

	private recordRemoteInstructionMetadata(
		paths: RemoteInstructionResourcePaths,
		metadataByPath: Map<string, PathMetadata>,
	): void {
		for (const entry of [...paths.skills, ...paths.rules, ...paths.prompts]) {
			metadataByPath.set(entry.path, entry.metadata);
		}
	}

	private recordCliInstructionMetadata(paths: ResolvedPaths, metadataByPath: Map<string, PathMetadata>): void {
		for (const resource of [...paths.extensions, ...paths.skills, ...paths.rules]) {
			if (!metadataByPath.has(resource.path)) {
				metadataByPath.set(resource.path, { source: "cli", scope: "temporary", origin: "top-level" });
			}
		}
	}

	private async collectReloadResourcePaths(
		resolvedPaths: ResolvedPaths,
		cliPaths: ResolvedPaths,
		metadataByPath: Map<string, PathMetadata>,
		instructionOperations: ToolOperations | undefined,
	): Promise<ReloadResourcePaths> {
		const loadProjectInstructionsRemotely = instructionOperations !== undefined;
		const enabledExtensions = this.getEnabledPaths(resolvedPaths.extensions, metadataByPath);
		const enabledSkillResources = this.getEnabledResources(resolvedPaths.skills, metadataByPath).filter(
			(resource) => !this.shouldExcludeLocalProjectInstructionResource(resource, loadProjectInstructionsRemotely),
		);
		const enabledRuleResources = this.getEnabledResources(resolvedPaths.rules, metadataByPath).filter(
			(resource) => !this.shouldExcludeLocalProjectInstructionResource(resource, loadProjectInstructionsRemotely),
		);
		const enabledPrompts = this.getEnabledResources(resolvedPaths.prompts, metadataByPath)
			.filter(
				(resource) => !this.shouldExcludeLocalProjectInstructionResource(resource, loadProjectInstructionsRemotely),
			)
			.map((resource) => resource.path);
		const enabledThemes = this.getEnabledPaths(resolvedPaths.themes, metadataByPath);

		const remotePaths = await this.discoverRemoteInstructionResourcePaths(instructionOperations);
		this.recordRemoteInstructionMetadata(remotePaths, metadataByPath);
		const enabledSkills = enabledSkillResources.map((resource) =>
			this.normalizePackagedInstructionPath(resource, "SKILL.md", metadataByPath),
		);
		const enabledRules = enabledRuleResources.map((resource) =>
			this.normalizePackagedInstructionPath(resource, "RULES.md", metadataByPath),
		);

		this.recordCliInstructionMetadata(cliPaths, metadataByPath);
		const cliExtensions = this.getEnabledPaths(cliPaths.extensions, metadataByPath);
		const cliSkills = this.getEnabledPaths(cliPaths.skills, metadataByPath);
		const cliRules = this.getEnabledPaths(cliPaths.rules, metadataByPath);
		const cliPrompts = this.getEnabledPaths(cliPaths.prompts, metadataByPath);
		const cliThemes = this.getEnabledPaths(cliPaths.themes, metadataByPath);

		return {
			extensions: this.noExtensions ? cliExtensions : this.mergePaths(cliExtensions, enabledExtensions),
			skills: this.noSkills
				? this.mergePaths(cliSkills, this.additionalSkillPaths)
				: this.mergePaths(
						[...cliSkills, ...enabledSkills, ...remotePaths.skills.map((entry) => entry.path)],
						this.additionalSkillPaths,
					),
			rules: this.noRules
				? this.mergePaths(cliRules, this.additionalRulePaths)
				: this.mergePaths(
						[...cliRules, ...enabledRules, ...remotePaths.rules.map((entry) => entry.path)],
						this.additionalRulePaths,
					),
			prompts: this.noPromptTemplates
				? this.mergePaths(cliPrompts, this.additionalPromptTemplatePaths)
				: this.mergePaths(
						[...cliPrompts, ...enabledPrompts, ...remotePaths.prompts.map((entry) => entry.path)],
						this.additionalPromptTemplatePaths,
					),
			themes: this.noThemes
				? this.mergePaths(cliThemes, this.additionalThemePaths)
				: this.mergePaths([...cliThemes, ...enabledThemes], this.additionalThemePaths),
		};
	}

	private async reloadExtensions(extensionPaths: string[], metadataByPath: Map<string, PathMetadata>): Promise<void> {
		const extensionsResult = await loadExtensions(extensionPaths, this.cwd, this.eventBus);
		const inlineExtensions = await this.loadExtensionFactories(extensionsResult.runtime);
		extensionsResult.extensions.push(...inlineExtensions.extensions);
		extensionsResult.errors.push(...inlineExtensions.errors);
		for (const conflict of this.detectExtensionConflicts(extensionsResult.extensions)) {
			extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
		}
		for (const path of this.additionalExtensionPaths) {
			if (!isLocalPath(path)) continue;
			const resolved = this.resolveResourcePath(path);
			if (!existsSync(resolved)) {
				extensionsResult.errors.push({ path: resolved, error: `Extension path does not exist: ${resolved}` });
			}
		}
		this.extensionsResult = this.extensionsOverride ? this.extensionsOverride(extensionsResult) : extensionsResult;
		this.applyExtensionSourceInfo(this.extensionsResult.extensions, metadataByPath);
	}

	private async reloadSkills(skillPaths: string[], metadataByPath: Map<string, PathMetadata>): Promise<void> {
		this.lastSkillPaths = skillPaths;
		await this.updateSkillsFromPathsForReload(skillPaths, metadataByPath);
		const diagnosticPaths = new Set(this.skillDiagnostics.map((diagnostic) => diagnostic.path));
		for (const path of this.additionalSkillPaths) {
			if (!isLocalPath(path)) continue;
			const resolved = this.resolveResourcePath(path);
			appendMissingResourceDiagnostic(resolved, this.skillDiagnostics, diagnosticPaths, "Skill path does not exist");
		}
	}

	private async reloadRules(rulePaths: string[], metadataByPath: Map<string, PathMetadata>): Promise<void> {
		this.lastRulePaths = rulePaths;
		await this.updateRulesFromPathsForReload(rulePaths, metadataByPath);
		const diagnosticPaths = new Set(this.ruleDiagnostics.map((diagnostic) => diagnostic.path));
		for (const path of this.additionalRulePaths) {
			if (!isLocalPath(path)) continue;
			const resolved = this.resolveResourcePath(path);
			appendMissingResourceDiagnostic(resolved, this.ruleDiagnostics, diagnosticPaths, "Rule path does not exist");
		}
	}

	private async reloadPrompts(promptPaths: string[], metadataByPath: Map<string, PathMetadata>): Promise<void> {
		this.lastPromptPaths = promptPaths;
		await this.updatePromptsFromPathsForReload(promptPaths, metadataByPath);
		const diagnosticPaths = new Set(this.promptDiagnostics.map((diagnostic) => diagnostic.path));
		for (const path of this.additionalPromptTemplatePaths) {
			if (!isLocalPath(path)) continue;
			const resolved = this.resolveResourcePath(path);
			appendMissingResourceDiagnostic(
				resolved,
				this.promptDiagnostics,
				diagnosticPaths,
				"Prompt template path does not exist",
			);
		}
	}

	private reloadThemes(themePaths: string[], metadataByPath: Map<string, PathMetadata>): void {
		this.lastThemePaths = themePaths;
		this.updateThemesFromPaths(themePaths, metadataByPath);
		const diagnosticPaths = new Set(this.themeDiagnostics.map((diagnostic) => diagnostic.path));
		for (const path of this.additionalThemePaths) {
			const resolved = this.resolveResourcePath(path);
			appendMissingResourceDiagnostic(resolved, this.themeDiagnostics, diagnosticPaths, "Theme path does not exist");
		}
	}

	private async reloadProjectContextFiles(instructionOperations: ToolOperations | undefined): Promise<void> {
		const backend = instructionOperations?.getBackendInfo?.();
		const agentsFiles = {
			agentsFiles: this.noContextFiles
				? []
				: instructionOperations
					? await loadProjectContextFilesWithOperations({
							cwd: instructionOperations.cwd,
							agentDir: this.agentDir,
							operations: instructionOperations,
							workspace: backend?.type === "remote" && backend.configured ? backend.workspace : undefined,
						})
					: loadProjectContextFiles({ cwd: this.cwd, agentDir: this.agentDir }),
		};
		const resolvedAgentsFiles = this.agentsFilesOverride ? this.agentsFilesOverride(agentsFiles) : agentsFiles;
		this.agentsFiles = resolvedAgentsFiles.agentsFiles;
	}

	private async reloadSystemPrompts(): Promise<void> {
		const baseSystemPrompt = await resolvePromptInput(
			this.systemPromptSource ?? this.discoverSystemPromptFile(),
			"system prompt",
			this.getInstructionOperations(),
		);
		this.systemPrompt = this.systemPromptOverride ? this.systemPromptOverride(baseSystemPrompt) : baseSystemPrompt;

		const appendSources =
			this.appendSystemPromptSource ??
			(this.discoverAppendSystemPromptFile() ? [this.discoverAppendSystemPromptFile()!] : []);
		const baseAppend = (
			await Promise.all(
				appendSources.map((source) =>
					resolvePromptInput(source, "append system prompt", this.getInstructionOperations()),
				),
			)
		).filter((source): source is string => source !== undefined);
		this.appendSystemPrompt = this.appendSystemPromptOverride
			? this.appendSystemPromptOverride(baseAppend)
			: baseAppend;
	}

	async reload(): Promise<void> {
		resetTimings("extensions");
		await this.settingsManager.reload();
		const resolvedPaths = await this.packageManager.resolve();
		const cliPaths = await this.packageManager.resolveExtensionSources(this.additionalExtensionPaths, {
			temporary: true,
		});
		const metadataByPath = new Map<string, PathMetadata>();
		this.extensionSkillSourceInfos = new Map();
		this.extensionRuleSourceInfos = new Map();
		this.extensionPromptSourceInfos = new Map();
		this.extensionThemeSourceInfos = new Map();

		const instructionOperations = this.getInstructionOperations();
		const paths = await this.collectReloadResourcePaths(
			resolvedPaths,
			cliPaths,
			metadataByPath,
			instructionOperations,
		);
		await this.reloadExtensions(paths.extensions, metadataByPath);
		await this.reloadSkills(paths.skills, metadataByPath);
		await this.reloadRules(paths.rules, metadataByPath);
		await this.reloadPrompts(paths.prompts, metadataByPath);
		this.reloadThemes(paths.themes, metadataByPath);
		await this.reloadProjectContextFiles(instructionOperations);
		await this.reloadSystemPrompts();
	}

	private normalizeExtensionPaths(entries: ResourcePathEntry[]): ResourcePathEntry[] {
		return entries.map((entry) => {
			const metadata = entry.metadata.baseDir
				? { ...entry.metadata, baseDir: this.resolveResourcePath(entry.metadata.baseDir) }
				: entry.metadata;
			return {
				path: this.resolveResourcePath(entry.path),
				metadata,
			};
		});
	}

	private getExtensionRegisteredSkills(): Skill[] {
		return this.extensionsResult.extensions.flatMap((extension) => Array.from(extension.skills.values()));
	}

	private getExtensionRegisteredRules(): Rule[] {
		return this.extensionsResult.extensions.flatMap((extension) => Array.from(extension.rules.values()));
	}

	private getExtensionRegisteredPrompts(): PromptTemplate[] {
		return this.extensionsResult.extensions.flatMap((extension) => Array.from(extension.prompts.values()));
	}

	private applyLoadedSkills(skillsResult: LoadSkillsResult, metadataByPath?: Map<string, PathMetadata>): void {
		const extensionSkills = this.getExtensionRegisteredSkills();
		const seenSkillNames = new Set(extensionSkills.map((skill) => skill.name));
		const baseSkillsResult = {
			skills: [...extensionSkills, ...skillsResult.skills.filter((skill) => !seenSkillNames.has(skill.name))],
			diagnostics: skillsResult.diagnostics,
		};
		const resolvedSkills = this.skillsOverride ? this.skillsOverride(baseSkillsResult) : baseSkillsResult;
		this.skills = resolvedSkills.skills.map((skill) => ({
			...skill,
			sourceInfo:
				this.findSourceInfoForPath(skill.filePath, this.extensionSkillSourceInfos, metadataByPath) ??
				skill.sourceInfo ??
				this.getDefaultSourceInfoForPath(skill.filePath),
		}));
		this.skillDiagnostics = resolvedSkills.diagnostics;
	}

	private updateSkillsFromPaths(skillPaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let skillsResult: { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
		if (this.noSkills && skillPaths.length === 0) {
			skillsResult = { skills: [], diagnostics: [] };
		} else {
			skillsResult = loadSkills({
				cwd: this.cwd,
				agentDir: this.agentDir,
				skillPaths,
				includeDefaults: false,
			});
		}
		this.applyLoadedSkills(skillsResult, metadataByPath);
	}

	private shouldLoadPathWithInstructionOperations(path: string, metadataByPath?: Map<string, PathMetadata>): boolean {
		const operations = this.getInstructionOperations();
		if (!operations) return false;
		const sourceInfo = this.findSourceInfoForPath(path, undefined, metadataByPath);
		if (sourceInfo?.source === "remote") return true;
		const backend = operations.getBackendInfo?.();
		if (backend?.type === "remote" && backend.configured) {
			return relativeWithin(backend.workspace.root, path) !== undefined;
		}
		const cwd = operations.cwd.endsWith(sep) ? operations.cwd : `${operations.cwd}${sep}`;
		return path === operations.cwd || path.startsWith(cwd);
	}

	private async updateSkillsFromPathsForReload(
		skillPaths: string[],
		metadataByPath?: Map<string, PathMetadata>,
	): Promise<void> {
		let skillsResult: { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
		const operations = this.getInstructionOperations();
		if (this.noSkills && skillPaths.length === 0) {
			skillsResult = { skills: [], diagnostics: [] };
		} else if (operations) {
			const remotePaths = skillPaths.filter((path) =>
				this.shouldLoadPathWithInstructionOperations(path, metadataByPath),
			);
			const localPaths = skillPaths.filter(
				(path) => !this.shouldLoadPathWithInstructionOperations(path, metadataByPath),
			);
			const remoteResult = await loadSkillsWithOperations({
				cwd: operations.cwd,
				agentDir: this.agentDir,
				skillPaths: remotePaths,
				includeDefaults: false,
				operations,
			});
			const localResult = loadSkills({
				cwd: this.cwd,
				agentDir: this.agentDir,
				skillPaths: localPaths,
				includeDefaults: false,
			});
			const merged = mergeNamedResources(remoteResult.skills, localResult.skills, "skill");
			skillsResult = {
				skills: merged.resources,
				diagnostics: [...remoteResult.diagnostics, ...localResult.diagnostics, ...merged.diagnostics],
			};
		} else {
			skillsResult = loadSkills({
				cwd: this.cwd,
				agentDir: this.agentDir,
				skillPaths,
				includeDefaults: false,
			});
		}
		this.applyLoadedSkills(skillsResult, metadataByPath);
	}

	private applyLoadedRules(rulesResult: LoadRulesResult, metadataByPath?: Map<string, PathMetadata>): void {
		const extensionRules = this.getExtensionRegisteredRules();
		const seenRuleNames = new Set(extensionRules.map((rule) => rule.name));
		const baseRulesResult = {
			rules: [...extensionRules, ...rulesResult.rules.filter((rule) => !seenRuleNames.has(rule.name))],
			diagnostics: rulesResult.diagnostics,
		};
		const resolvedRules = this.rulesOverride ? this.rulesOverride(baseRulesResult) : baseRulesResult;
		this.rules = resolvedRules.rules.map((rule) => ({
			...rule,
			sourceInfo:
				this.findSourceInfoForPath(rule.filePath, this.extensionRuleSourceInfos, metadataByPath) ??
				rule.sourceInfo ??
				this.getDefaultSourceInfoForPath(rule.filePath),
		}));
		this.ruleDiagnostics = resolvedRules.diagnostics;
	}

	private updateRulesFromPaths(rulePaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let rulesResult: { rules: Rule[]; diagnostics: ResourceDiagnostic[] };
		if (this.noRules && rulePaths.length === 0) {
			rulesResult = { rules: [], diagnostics: [] };
		} else {
			rulesResult = loadRules({
				cwd: this.cwd,
				agentDir: this.agentDir,
				rulePaths,
				includeDefaults: false,
			});
		}
		this.applyLoadedRules(rulesResult, metadataByPath);
	}

	private async updateRulesFromPathsForReload(
		rulePaths: string[],
		metadataByPath?: Map<string, PathMetadata>,
	): Promise<void> {
		let rulesResult: { rules: Rule[]; diagnostics: ResourceDiagnostic[] };
		const operations = this.getInstructionOperations();
		if (this.noRules && rulePaths.length === 0) {
			rulesResult = { rules: [], diagnostics: [] };
		} else if (operations) {
			const remotePaths = rulePaths.filter((path) =>
				this.shouldLoadPathWithInstructionOperations(path, metadataByPath),
			);
			const localPaths = rulePaths.filter(
				(path) => !this.shouldLoadPathWithInstructionOperations(path, metadataByPath),
			);
			const remoteResult = await loadRulesWithOperations({
				cwd: operations.cwd,
				agentDir: this.agentDir,
				rulePaths: remotePaths,
				includeDefaults: false,
				operations,
			});
			const localResult = loadRules({
				cwd: this.cwd,
				agentDir: this.agentDir,
				rulePaths: localPaths,
				includeDefaults: false,
			});
			const merged = mergeNamedResources(remoteResult.rules, localResult.rules, "rule");
			rulesResult = {
				rules: merged.resources,
				diagnostics: [...remoteResult.diagnostics, ...localResult.diagnostics, ...merged.diagnostics],
			};
		} else {
			rulesResult = loadRules({
				cwd: this.cwd,
				agentDir: this.agentDir,
				rulePaths,
				includeDefaults: false,
			});
		}
		this.applyLoadedRules(rulesResult, metadataByPath);
	}

	private applyLoadedPrompts(
		promptsResult: LoadPromptTemplatesResult,
		metadataByPath?: Map<string, PathMetadata>,
	): void {
		const extensionPrompts = this.getExtensionRegisteredPrompts();
		const basePromptsResult = this.dedupePrompts([...extensionPrompts, ...promptsResult.prompts]);
		basePromptsResult.diagnostics.unshift(...promptsResult.diagnostics);
		const resolvedPrompts = this.promptsOverride ? this.promptsOverride(basePromptsResult) : basePromptsResult;
		this.prompts = resolvedPrompts.prompts.map((prompt) => ({
			...prompt,
			sourceInfo:
				this.findSourceInfoForPath(prompt.filePath, this.extensionPromptSourceInfos, metadataByPath) ??
				prompt.sourceInfo ??
				this.getDefaultSourceInfoForPath(prompt.filePath),
		}));
		this.promptDiagnostics = resolvedPrompts.diagnostics;
	}

	private updatePromptsFromPaths(promptPaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let promptsResult: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
		if (this.noPromptTemplates && promptPaths.length === 0) {
			promptsResult = { prompts: [], diagnostics: [] };
		} else {
			const allPrompts = loadPromptTemplates({
				cwd: this.cwd,
				agentDir: this.agentDir,
				promptPaths,
				includeDefaults: false,
			});
			promptsResult = this.dedupePrompts(allPrompts);
		}
		this.applyLoadedPrompts(promptsResult, metadataByPath);
	}

	private async updatePromptsFromPathsForReload(
		promptPaths: string[],
		metadataByPath?: Map<string, PathMetadata>,
	): Promise<void> {
		let promptsResult: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
		const operations = this.getInstructionOperations();
		if (this.noPromptTemplates && promptPaths.length === 0) {
			promptsResult = { prompts: [], diagnostics: [] };
		} else if (operations) {
			const remotePaths = promptPaths.filter((path) =>
				this.shouldLoadPathWithInstructionOperations(path, metadataByPath),
			);
			const localPaths = promptPaths.filter(
				(path) => !this.shouldLoadPathWithInstructionOperations(path, metadataByPath),
			);
			const remotePrompts = await loadPromptTemplatesWithOperations({
				cwd: operations.cwd,
				agentDir: this.agentDir,
				promptPaths: remotePaths,
				includeDefaults: false,
				operations,
			});
			const localPrompts = loadPromptTemplates({
				cwd: this.cwd,
				agentDir: this.agentDir,
				promptPaths: localPaths,
				includeDefaults: false,
			});
			promptsResult = this.dedupePrompts([...remotePrompts, ...localPrompts]);
		} else {
			const allPrompts = loadPromptTemplates({
				cwd: this.cwd,
				agentDir: this.agentDir,
				promptPaths,
				includeDefaults: false,
			});
			promptsResult = this.dedupePrompts(allPrompts);
		}
		this.applyLoadedPrompts(promptsResult, metadataByPath);
	}

	private updateThemesFromPaths(themePaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let themesResult: { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
		if (this.noThemes && themePaths.length === 0) {
			themesResult = { themes: [], diagnostics: [] };
		} else {
			const loaded = this.loadThemes(themePaths, false);
			const deduped = this.dedupeThemes(loaded.themes);
			themesResult = { themes: deduped.themes, diagnostics: [...loaded.diagnostics, ...deduped.diagnostics] };
		}
		const resolvedThemes = this.themesOverride ? this.themesOverride(themesResult) : themesResult;
		this.themes = resolvedThemes.themes.map((theme) => {
			const sourcePath = theme.sourcePath;
			theme.sourceInfo = sourcePath
				? (this.findSourceInfoForPath(sourcePath, this.extensionThemeSourceInfos, metadataByPath) ??
					theme.sourceInfo ??
					this.getDefaultSourceInfoForPath(sourcePath))
				: theme.sourceInfo;
			return theme;
		});
		this.themeDiagnostics = resolvedThemes.diagnostics;
	}

	private applyExtensionSourceInfo(extensions: Extension[], metadataByPath: Map<string, PathMetadata>): void {
		for (const extension of extensions) {
			extension.sourceInfo =
				this.findSourceInfoForPath(extension.path, undefined, metadataByPath) ??
				this.getDefaultSourceInfoForPath(extension.path);
			for (const command of extension.commands.values()) {
				command.sourceInfo = extension.sourceInfo;
			}
			for (const tool of extension.tools.values()) {
				tool.sourceInfo = extension.sourceInfo;
			}
			for (const skill of extension.skills.values()) {
				skill.sourceInfo = extension.sourceInfo;
			}
			for (const rule of extension.rules.values()) {
				rule.sourceInfo = extension.sourceInfo;
			}
			for (const prompt of extension.prompts.values()) {
				prompt.sourceInfo = extension.sourceInfo;
			}
		}
	}

	private findRegisteredSourceInfoForPath(
		resourcePath: string,
		normalizedResourcePath: string,
		sourceInfos: Map<string, SourceInfo>,
	): SourceInfo | undefined {
		for (const [sourcePath, sourceInfo] of sourceInfos.entries()) {
			const normalizedSourcePath = resolve(sourcePath);
			if (
				normalizedResourcePath === normalizedSourcePath ||
				normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
			) {
				return { ...sourceInfo, path: resourcePath };
			}
		}
		return undefined;
	}

	private findResolvedResourceSourceInfoForPath(
		resourcePath: string,
		normalizedResourcePath: string,
		metadataByPath: Map<string, PathMetadata>,
	): SourceInfo | undefined {
		const exact = metadataByPath.get(normalizedResourcePath) ?? metadataByPath.get(resourcePath);
		if (exact) return createSourceInfo(resourcePath, exact);

		for (const [sourcePath, metadata] of metadataByPath.entries()) {
			if (metadata.workspace) {
				if (relativeWithin(sourcePath, resourcePath) !== undefined) {
					return createSourceInfo(resourcePath, metadata);
				}
				continue;
			}
			const normalizedSourcePath = resolve(sourcePath);
			if (
				normalizedResourcePath === normalizedSourcePath ||
				normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
			) {
				return createSourceInfo(resourcePath, metadata);
			}
		}
		return undefined;
	}

	private findSourceInfoForPath(
		resourcePath: string,
		extraSourceInfos?: Map<string, SourceInfo>,
		metadataByPath?: Map<string, PathMetadata>,
	): SourceInfo | undefined {
		if (!resourcePath) return undefined;
		if (resourcePath.startsWith("<")) return this.getDefaultSourceInfoForPath(resourcePath);

		const normalizedResourcePath = resolve(resourcePath);
		const registeredSourceInfo = extraSourceInfos
			? this.findRegisteredSourceInfoForPath(resourcePath, normalizedResourcePath, extraSourceInfos)
			: undefined;
		if (registeredSourceInfo) return registeredSourceInfo;
		return metadataByPath
			? this.findResolvedResourceSourceInfoForPath(resourcePath, normalizedResourcePath, metadataByPath)
			: undefined;
	}

	private getDefaultSourceInfoForPath(filePath: string): SourceInfo {
		if (filePath.startsWith("<") && filePath.endsWith(">")) {
			return {
				path: filePath,
				source: filePath.slice(1, -1).split(":")[0] || "temporary",
				scope: "temporary",
				origin: "top-level",
			};
		}

		const normalizedPath = resolve(filePath);
		const agentRoots = [
			join(this.agentDir, "skills"),
			join(this.agentDir, "rules"),
			join(this.agentDir, "prompts"),
			join(this.agentDir, "themes"),
			join(this.agentDir, "extensions"),
		];
		const projectRoots = [
			join(this.cwd, CONFIG_DIR_NAME, "skills"),
			join(this.cwd, CONFIG_DIR_NAME, "rules"),
			join(this.cwd, CONFIG_DIR_NAME, "prompts"),
			join(this.cwd, CONFIG_DIR_NAME, "themes"),
			join(this.cwd, CONFIG_DIR_NAME, "extensions"),
		];

		for (const root of agentRoots) {
			if (this.isUnderPath(normalizedPath, root)) {
				return { path: filePath, source: "local", scope: "user", origin: "top-level", baseDir: root };
			}
		}

		for (const root of projectRoots) {
			if (this.isUnderPath(normalizedPath, root)) {
				return { path: filePath, source: "local", scope: "project", origin: "top-level", baseDir: root };
			}
		}

		return {
			path: filePath,
			source: "local",
			scope: "temporary",
			origin: "top-level",
			baseDir: statSync(normalizedPath).isDirectory() ? normalizedPath : resolve(normalizedPath, ".."),
		};
	}

	private mergePaths(primary: string[], additional: string[]): string[] {
		const merged: string[] = [];
		const seen = new Set<string>();

		for (const p of [...primary, ...additional]) {
			const resolved = this.resolveResourcePath(p);
			const canonicalPath = canonicalizePath(resolved);
			if (seen.has(canonicalPath)) continue;
			seen.add(canonicalPath);
			merged.push(resolved);
		}

		return merged;
	}

	private resolveResourcePath(p: string): string {
		return resolvePath(p, this.cwd, { trim: true });
	}

	private loadThemes(paths: string[], includeDefaults: boolean = true): LoadThemesResult {
		const themes: Theme[] = [];
		const diagnostics: ResourceDiagnostic[] = [];
		if (includeDefaults) {
			const defaultDirs = [join(this.agentDir, "themes"), join(this.cwd, CONFIG_DIR_NAME, "themes")];

			for (const dir of defaultDirs) {
				this.loadThemesFromDir(dir, themes, diagnostics);
			}
		}

		for (const p of paths) {
			const resolved = this.resolveResourcePath(p);
			if (!existsSync(resolved)) {
				diagnostics.push({ type: "warning", message: "theme path does not exist", path: resolved });
				continue;
			}

			try {
				const stats = statSync(resolved);
				if (stats.isDirectory()) {
					this.loadThemesFromDir(resolved, themes, diagnostics);
				} else if (stats.isFile() && resolved.endsWith(".json")) {
					this.loadThemeFromFile(resolved, themes, diagnostics);
				} else {
					diagnostics.push({ type: "warning", message: "theme path is not a json file", path: resolved });
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to read theme path";
				diagnostics.push({ type: "warning", message, path: resolved });
			}
		}

		return { themes, diagnostics };
	}

	private loadThemesFromDir(dir: string, themes: Theme[], diagnostics: ResourceDiagnostic[]): void {
		if (!existsSync(dir)) {
			return;
		}

		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				let isFile = entry.isFile();
				if (entry.isSymbolicLink()) {
					try {
						isFile = statSync(join(dir, entry.name)).isFile();
					} catch {
						continue;
					}
				}
				if (!isFile) {
					continue;
				}
				if (!entry.name.endsWith(".json")) {
					continue;
				}
				this.loadThemeFromFile(join(dir, entry.name), themes, diagnostics);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read theme directory";
			diagnostics.push({ type: "warning", message, path: dir });
		}
	}

	private loadThemeFromFile(filePath: string, themes: Theme[], diagnostics: ResourceDiagnostic[]): void {
		try {
			themes.push(loadThemeFromPath(filePath));
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to load theme";
			diagnostics.push({ type: "warning", message, path: filePath });
		}
	}

	private async loadExtensionFactories(runtime: ExtensionRuntime): Promise<InlineExtensionLoadResult> {
		const extensions: Extension[] = [];
		const errors: Array<{ path: string; error: string }> = [];

		for (const [index, factory] of this.extensionFactories.entries()) {
			const extensionPath = `<inline:${index + 1}>`;
			try {
				const extension = await loadExtensionFromFactory(factory, this.cwd, this.eventBus, runtime, extensionPath);
				extensions.push(extension);
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to load extension";
				errors.push({ path: extensionPath, error: message });
			}
		}

		return { extensions, errors };
	}

	private dedupePrompts(prompts: PromptTemplate[]): LoadPromptTemplatesResult {
		const seen = new Map<string, PromptTemplate>();
		const diagnostics: ResourceDiagnostic[] = [];

		for (const prompt of prompts) {
			const existing = seen.get(prompt.name);
			if (existing) {
				diagnostics.push({
					type: "collision",
					message: `name "/${prompt.name}" collision`,
					path: prompt.filePath,
					collision: {
						resourceType: "prompt",
						name: prompt.name,
						winnerPath: existing.filePath,
						loserPath: prompt.filePath,
					},
				});
			} else {
				seen.set(prompt.name, prompt);
			}
		}

		return { prompts: Array.from(seen.values()), diagnostics };
	}

	private dedupeThemes(themes: Theme[]): LoadThemesResult {
		const seen = new Map<string, Theme>();
		const diagnostics: ResourceDiagnostic[] = [];

		for (const t of themes) {
			const name = t.name ?? "unnamed";
			const existing = seen.get(name);
			if (existing) {
				diagnostics.push({
					type: "collision",
					message: `name "${name}" collision`,
					path: t.sourcePath,
					collision: {
						resourceType: "theme",
						name,
						winnerPath: existing.sourcePath ?? "<builtin>",
						loserPath: t.sourcePath ?? "<builtin>",
					},
				});
			} else {
				seen.set(name, t);
			}
		}

		return { themes: Array.from(seen.values()), diagnostics };
	}

	private discoverSystemPromptFile(): string | undefined {
		const projectPath = join(this.cwd, CONFIG_DIR_NAME, "SYSTEM.md");
		if (existsSync(projectPath)) {
			return projectPath;
		}

		const globalPath = join(this.agentDir, "SYSTEM.md");
		if (existsSync(globalPath)) {
			return globalPath;
		}

		return undefined;
	}

	private discoverAppendSystemPromptFile(): string | undefined {
		const projectPath = join(this.cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
		if (existsSync(projectPath)) {
			return projectPath;
		}

		const globalPath = join(this.agentDir, "APPEND_SYSTEM.md");
		if (existsSync(globalPath)) {
			return globalPath;
		}

		return undefined;
	}

	private isUnderPath(target: string, root: string): boolean {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	}

	private detectExtensionConflicts(extensions: Extension[]): ExtensionConflict[] {
		const conflicts: ExtensionConflict[] = [];

		// Track which extension registered each tool and flag
		const toolOwners = new Map<string, string>();
		const flagOwners = new Map<string, string>();

		for (const ext of extensions) {
			// Check tools
			for (const toolName of ext.tools.keys()) {
				const existingOwner = toolOwners.get(toolName);
				if (existingOwner && existingOwner !== ext.path) {
					conflicts.push({
						path: ext.path,
						message: `Tool "${toolName}" conflicts with ${existingOwner}`,
					});
				} else {
					toolOwners.set(toolName, ext.path);
				}
			}

			// Check flags
			for (const flagName of ext.flags.keys()) {
				const existingOwner = flagOwners.get(flagName);
				if (existingOwner && existingOwner !== ext.path) {
					conflicts.push({
						path: ext.path,
						message: `Flag "--${flagName}" conflicts with ${existingOwner}`,
					});
				} else {
					flagOwners.set(flagName, ext.path);
				}
			}
		}

		return conflicts;
	}
}
