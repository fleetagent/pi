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
import { DefaultPackageManager, type PathMetadata } from "./package-manager.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import { loadPromptTemplates, loadPromptTemplatesWithOperations } from "./prompt-templates.ts";
import type { Rule } from "./rules.ts";
import { loadRules, loadRulesWithOperations } from "./rules.ts";
import { SettingsManager } from "./settings-manager.ts";
import type { Skill } from "./skills.ts";
import { loadSkills, loadSkillsWithOperations } from "./skills.ts";
import { createSourceInfo, type SourceInfo } from "./source-info.ts";
import type { ToolOperations } from "./tools/operations.ts";

export interface ResourceExtensionPaths {
	skillPaths?: Array<{ path: string; metadata: PathMetadata }>;
	rulePaths?: Array<{ path: string; metadata: PathMetadata }>;
	promptPaths?: Array<{ path: string; metadata: PathMetadata }>;
	themePaths?: Array<{ path: string; metadata: PathMetadata }>;
}

export interface ResourceLoader {
	getExtensions(): LoadExtensionsResult;
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	getRules(): { rules: Rule[]; diagnostics: ResourceDiagnostic[] };
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
	getSystemPrompt(): string | undefined;
	getAppendSystemPrompt(): string[];
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

function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	const candidates = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
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

export function loadProjectContextFiles(options: {
	cwd: string;
	agentDir: string;
}): Array<{ path: string; content: string }> {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);

	const contextFiles: Array<{ path: string; content: string }> = [];
	const seenPaths = new Set<string>();

	const globalContext = loadContextFileFromDir(resolvedAgentDir);
	if (globalContext) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	const ancestorContextFiles: Array<{ path: string; content: string }> = [];

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
): Promise<{ path: string; content: string } | null> {
	const candidates = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		try {
			await operations.access(filePath, "read");
			return { path: filePath, content: (await operations.readFile(filePath)).toString("utf-8") };
		} catch {}
	}
	return null;
}

async function loadProjectContextFilesWithOperations(options: {
	cwd: string;
	agentDir: string;
	operations: ToolOperations;
}): Promise<Array<{ path: string; content: string }>> {
	const contextFiles: Array<{ path: string; content: string }> = [];
	const seenPaths = new Set<string>();
	const globalContext = loadContextFileFromDir(resolvePath(options.agentDir));
	if (globalContext) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	const ancestorContextFiles: Array<{ path: string; content: string }> = [];
	let currentDir = resolvePath(options.cwd);
	const root = resolve("/");
	while (true) {
		const contextFile = await loadContextFileFromDirWithOperations(options.operations, currentDir);
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
	skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	rulesOverride?: (base: { rules: Rule[]; diagnostics: ResourceDiagnostic[] }) => {
		rules: Rule[];
		diagnostics: ResourceDiagnostic[];
	};
	promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
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
	private skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	private rulesOverride?: (base: { rules: Rule[]; diagnostics: ResourceDiagnostic[] }) => {
		rules: Rule[];
		diagnostics: ResourceDiagnostic[];
	};
	private promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	private themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	private agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
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
	private agentsFiles: Array<{ path: string; content: string }>;
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

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		return { skills: this.skills, diagnostics: this.skillDiagnostics };
	}

	getRules(): { rules: Rule[]; diagnostics: ResourceDiagnostic[] } {
		return { rules: this.rules, diagnostics: this.ruleDiagnostics };
	}

	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		return { prompts: this.prompts, diagnostics: this.promptDiagnostics };
	}

	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		return { themes: this.themes, diagnostics: this.themeDiagnostics };
	}

	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
		return { agentsFiles: this.agentsFiles };
	}

	getSystemPrompt(): string | undefined {
		return this.systemPrompt;
	}

	getAppendSystemPrompt(): string[] {
		return this.appendSystemPrompt;
	}

	private getInstructionOperations(): ToolOperations | undefined {
		const backend = this.toolOperations?.getBackendInfo?.();
		return backend?.type === "ssh" && backend.configured ? this.toolOperations : undefined;
	}

	private getRemoteProjectInstructionResourcePaths(cwd: string): {
		skills: Array<{ path: string; metadata: PathMetadata }>;
		rules: Array<{ path: string; metadata: PathMetadata }>;
		prompts: Array<{ path: string; metadata: PathMetadata }>;
	} {
		const projectBaseDir = join(cwd, CONFIG_DIR_NAME);
		const projectMetadata: PathMetadata = {
			source: "ssh",
			scope: "project",
			origin: "top-level",
			baseDir: projectBaseDir,
		};
		const skills: Array<{ path: string; metadata: PathMetadata }> = [
			{ path: join(projectBaseDir, "skills"), metadata: projectMetadata },
		];
		const rules: Array<{ path: string; metadata: PathMetadata }> = [
			{ path: join(projectBaseDir, "rules"), metadata: projectMetadata },
		];
		const prompts: Array<{ path: string; metadata: PathMetadata }> = [
			{ path: join(projectBaseDir, "prompts"), metadata: projectMetadata },
		];

		let currentDir = resolve(cwd);
		const root = resolve("/");
		while (true) {
			const agentsBaseDir = join(currentDir, ".agents");
			const agentsMetadata: PathMetadata = {
				source: "ssh",
				scope: "project",
				origin: "top-level",
				baseDir: agentsBaseDir,
			};
			skills.push({ path: join(agentsBaseDir, "skills"), metadata: agentsMetadata });
			rules.push({ path: join(agentsBaseDir, "rules"), metadata: agentsMetadata });
			if (currentDir === root) break;
			const parentDir = resolve(currentDir, "..");
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

	async reload(): Promise<void> {
		await this.settingsManager.reload();
		const resolvedPaths = await this.packageManager.resolve();
		const cliExtensionPaths = await this.packageManager.resolveExtensionSources(this.additionalExtensionPaths, {
			temporary: true,
		});
		const metadataByPath = new Map<string, PathMetadata>();

		this.extensionSkillSourceInfos = new Map();
		this.extensionRuleSourceInfos = new Map();
		this.extensionPromptSourceInfos = new Map();
		this.extensionThemeSourceInfos = new Map();

		// Helper to extract enabled paths and store metadata
		const getEnabledResources = (
			resources: Array<{ path: string; enabled: boolean; metadata: PathMetadata }>,
		): Array<{ path: string; enabled: boolean; metadata: PathMetadata }> => {
			for (const r of resources) {
				if (!metadataByPath.has(r.path)) {
					metadataByPath.set(r.path, r.metadata);
				}
			}
			return resources.filter((r) => r.enabled);
		};

		const getEnabledPaths = (
			resources: Array<{ path: string; enabled: boolean; metadata: PathMetadata }>,
		): string[] => getEnabledResources(resources).map((r) => r.path);
		const instructionOperations = this.getInstructionOperations();
		const loadProjectInstructionsRemotely = instructionOperations !== undefined;
		const isLocalProjectInstructionResource = (resource: { metadata: PathMetadata }): boolean =>
			loadProjectInstructionsRemotely &&
			resource.metadata.scope === "project" &&
			resource.metadata.origin === "top-level";

		const enabledExtensions = getEnabledPaths(resolvedPaths.extensions);
		const enabledSkillResources = getEnabledResources(resolvedPaths.skills).filter(
			(resource) => !isLocalProjectInstructionResource(resource),
		);
		const enabledRuleResources = getEnabledResources(resolvedPaths.rules).filter(
			(resource) => !isLocalProjectInstructionResource(resource),
		);
		const enabledPromptResources = getEnabledResources(resolvedPaths.prompts).filter(
			(resource) => !isLocalProjectInstructionResource(resource),
		);
		const enabledPrompts = enabledPromptResources.map((resource) => resource.path);
		const enabledThemes = getEnabledPaths(resolvedPaths.themes);

		const mapSkillPath = (resource: { path: string; metadata: PathMetadata }): string => {
			if (resource.metadata.source !== "auto" && resource.metadata.origin !== "package") {
				return resource.path;
			}
			try {
				const stats = statSync(resource.path);
				if (!stats.isDirectory()) {
					return resource.path;
				}
			} catch {
				return resource.path;
			}
			const skillFile = join(resource.path, "SKILL.md");
			if (existsSync(skillFile)) {
				if (!metadataByPath.has(skillFile)) {
					metadataByPath.set(skillFile, resource.metadata);
				}
				return skillFile;
			}
			return resource.path;
		};

		const remoteInstructionResourcePaths = instructionOperations
			? this.getRemoteProjectInstructionResourcePaths(instructionOperations.cwd)
			: { skills: [], rules: [], prompts: [] };
		for (const entry of [
			...remoteInstructionResourcePaths.skills,
			...remoteInstructionResourcePaths.rules,
			...remoteInstructionResourcePaths.prompts,
		]) {
			metadataByPath.set(entry.path, entry.metadata);
		}

		const enabledSkills = [
			...enabledSkillResources.map(mapSkillPath),
			...remoteInstructionResourcePaths.skills.map((entry) => entry.path),
		];
		const mapRulePath = (resource: { path: string; metadata: PathMetadata }): string => {
			if (resource.metadata.source !== "auto" && resource.metadata.origin !== "package") {
				return resource.path;
			}
			try {
				const stats = statSync(resource.path);
				if (!stats.isDirectory()) {
					return resource.path;
				}
			} catch {
				return resource.path;
			}
			const ruleFile = join(resource.path, "RULES.md");
			if (existsSync(ruleFile)) {
				if (!metadataByPath.has(ruleFile)) {
					metadataByPath.set(ruleFile, resource.metadata);
				}
				return ruleFile;
			}
			return resource.path;
		};
		const enabledRules = [
			...enabledRuleResources.map(mapRulePath),
			...remoteInstructionResourcePaths.rules.map((entry) => entry.path),
		];

		// Add CLI paths metadata
		for (const r of cliExtensionPaths.extensions) {
			if (!metadataByPath.has(r.path)) {
				metadataByPath.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
			}
		}
		for (const r of cliExtensionPaths.skills) {
			if (!metadataByPath.has(r.path)) {
				metadataByPath.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
			}
		}
		for (const r of cliExtensionPaths.rules) {
			if (!metadataByPath.has(r.path)) {
				metadataByPath.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
			}
		}

		const cliEnabledExtensions = getEnabledPaths(cliExtensionPaths.extensions);
		const cliEnabledSkills = getEnabledPaths(cliExtensionPaths.skills);
		const cliEnabledRules = getEnabledPaths(cliExtensionPaths.rules);
		const cliEnabledPrompts = getEnabledPaths(cliExtensionPaths.prompts);
		const cliEnabledThemes = getEnabledPaths(cliExtensionPaths.themes);

		const extensionPaths = this.noExtensions
			? cliEnabledExtensions
			: this.mergePaths(cliEnabledExtensions, enabledExtensions);

		const extensionsResult = await loadExtensions(extensionPaths, this.cwd, this.eventBus);
		const inlineExtensions = await this.loadExtensionFactories(extensionsResult.runtime);
		extensionsResult.extensions.push(...inlineExtensions.extensions);
		extensionsResult.errors.push(...inlineExtensions.errors);

		// Detect extension conflicts (tools, commands, flags with same names from different extensions)
		// Keep all extensions loaded. Conflicts are reported as diagnostics, and precedence is handled by load order.
		const conflicts = this.detectExtensionConflicts(extensionsResult.extensions);
		for (const conflict of conflicts) {
			extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
		}

		for (const p of this.additionalExtensionPaths) {
			if (isLocalPath(p)) {
				const resolved = this.resolveResourcePath(p);
				if (!existsSync(resolved)) {
					extensionsResult.errors.push({ path: resolved, error: `Extension path does not exist: ${resolved}` });
				}
			}
		}
		this.extensionsResult = this.extensionsOverride ? this.extensionsOverride(extensionsResult) : extensionsResult;
		this.applyExtensionSourceInfo(this.extensionsResult.extensions, metadataByPath);

		const skillPaths = this.noSkills
			? this.mergePaths(cliEnabledSkills, this.additionalSkillPaths)
			: this.mergePaths([...cliEnabledSkills, ...enabledSkills], this.additionalSkillPaths);

		this.lastSkillPaths = skillPaths;
		await this.updateSkillsFromPathsForReload(skillPaths, metadataByPath);
		for (const p of this.additionalSkillPaths) {
			if (isLocalPath(p)) {
				const resolved = this.resolveResourcePath(p);
				if (!existsSync(resolved) && !this.skillDiagnostics.some((d) => d.path === resolved)) {
					this.skillDiagnostics.push({ type: "error", message: "Skill path does not exist", path: resolved });
				}
			}
		}

		const rulePaths = this.noRules
			? this.mergePaths(cliEnabledRules, this.additionalRulePaths)
			: this.mergePaths([...cliEnabledRules, ...enabledRules], this.additionalRulePaths);

		this.lastRulePaths = rulePaths;
		await this.updateRulesFromPathsForReload(rulePaths, metadataByPath);
		for (const p of this.additionalRulePaths) {
			if (isLocalPath(p)) {
				const resolved = this.resolveResourcePath(p);
				if (!existsSync(resolved) && !this.ruleDiagnostics.some((d) => d.path === resolved)) {
					this.ruleDiagnostics.push({ type: "error", message: "Rule path does not exist", path: resolved });
				}
			}
		}

		const remotePromptPaths = remoteInstructionResourcePaths.prompts.map((entry) => entry.path);
		const promptPaths = this.noPromptTemplates
			? this.mergePaths(cliEnabledPrompts, this.additionalPromptTemplatePaths)
			: this.mergePaths(
					[...cliEnabledPrompts, ...enabledPrompts, ...remotePromptPaths],
					this.additionalPromptTemplatePaths,
				);

		this.lastPromptPaths = promptPaths;
		await this.updatePromptsFromPathsForReload(promptPaths, metadataByPath);
		for (const p of this.additionalPromptTemplatePaths) {
			if (isLocalPath(p)) {
				const resolved = this.resolveResourcePath(p);
				if (!existsSync(resolved) && !this.promptDiagnostics.some((d) => d.path === resolved)) {
					this.promptDiagnostics.push({
						type: "error",
						message: "Prompt template path does not exist",
						path: resolved,
					});
				}
			}
		}

		const themePaths = this.noThemes
			? this.mergePaths(cliEnabledThemes, this.additionalThemePaths)
			: this.mergePaths([...cliEnabledThemes, ...enabledThemes], this.additionalThemePaths);

		this.lastThemePaths = themePaths;
		this.updateThemesFromPaths(themePaths, metadataByPath);
		for (const p of this.additionalThemePaths) {
			const resolved = this.resolveResourcePath(p);
			if (!existsSync(resolved) && !this.themeDiagnostics.some((d) => d.path === resolved)) {
				this.themeDiagnostics.push({ type: "error", message: "Theme path does not exist", path: resolved });
			}
		}

		const agentsFiles = {
			agentsFiles: this.noContextFiles
				? []
				: instructionOperations
					? await loadProjectContextFilesWithOperations({
							cwd: instructionOperations.cwd,
							agentDir: this.agentDir,
							operations: instructionOperations,
						})
					: loadProjectContextFiles({ cwd: this.cwd, agentDir: this.agentDir }),
		};
		const resolvedAgentsFiles = this.agentsFilesOverride ? this.agentsFilesOverride(agentsFiles) : agentsFiles;
		this.agentsFiles = resolvedAgentsFiles.agentsFiles;

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
				appendSources.map((s) => resolvePromptInput(s, "append system prompt", this.getInstructionOperations())),
			)
		).filter((s): s is string => s !== undefined);
		this.appendSystemPrompt = this.appendSystemPromptOverride
			? this.appendSystemPromptOverride(baseAppend)
			: baseAppend;
	}

	private normalizeExtensionPaths(
		entries: Array<{ path: string; metadata: PathMetadata }>,
	): Array<{ path: string; metadata: PathMetadata }> {
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

	private applyLoadedSkills(
		skillsResult: { skills: Skill[]; diagnostics: ResourceDiagnostic[] },
		metadataByPath?: Map<string, PathMetadata>,
	): void {
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
		if (sourceInfo?.source === "ssh") return true;
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
			const skillsByName = new Map<string, Skill>();
			for (const skill of [...remoteResult.skills, ...localResult.skills]) {
				if (!skillsByName.has(skill.name)) {
					skillsByName.set(skill.name, skill);
				}
			}
			skillsResult = {
				skills: Array.from(skillsByName.values()),
				diagnostics: [...remoteResult.diagnostics, ...localResult.diagnostics],
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

	private applyLoadedRules(
		rulesResult: { rules: Rule[]; diagnostics: ResourceDiagnostic[] },
		metadataByPath?: Map<string, PathMetadata>,
	): void {
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
			const rulesByName = new Map<string, Rule>();
			for (const rule of [...remoteResult.rules, ...localResult.rules]) {
				if (!rulesByName.has(rule.name)) {
					rulesByName.set(rule.name, rule);
				}
			}
			rulesResult = {
				rules: Array.from(rulesByName.values()),
				diagnostics: [...remoteResult.diagnostics, ...localResult.diagnostics],
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
		promptsResult: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] },
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

	private findSourceInfoForPath(
		resourcePath: string,
		extraSourceInfos?: Map<string, SourceInfo>,
		metadataByPath?: Map<string, PathMetadata>,
	): SourceInfo | undefined {
		if (!resourcePath) {
			return undefined;
		}

		if (resourcePath.startsWith("<")) {
			return this.getDefaultSourceInfoForPath(resourcePath);
		}

		const normalizedResourcePath = resolve(resourcePath);
		if (extraSourceInfos) {
			for (const [sourcePath, sourceInfo] of extraSourceInfos.entries()) {
				const normalizedSourcePath = resolve(sourcePath);
				if (
					normalizedResourcePath === normalizedSourcePath ||
					normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
				) {
					return { ...sourceInfo, path: resourcePath };
				}
			}
		}

		if (metadataByPath) {
			const exact = metadataByPath.get(normalizedResourcePath) ?? metadataByPath.get(resourcePath);
			if (exact) {
				return createSourceInfo(resourcePath, exact);
			}

			for (const [sourcePath, metadata] of metadataByPath.entries()) {
				const normalizedSourcePath = resolve(sourcePath);
				if (
					normalizedResourcePath === normalizedSourcePath ||
					normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
				) {
					return createSourceInfo(resourcePath, metadata);
				}
			}
		}

		return undefined;
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

	private loadThemes(
		paths: string[],
		includeDefaults: boolean = true,
	): {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	} {
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

	private async loadExtensionFactories(runtime: ExtensionRuntime): Promise<{
		extensions: Extension[];
		errors: Array<{ path: string; error: string }>;
	}> {
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

	private dedupePrompts(prompts: PromptTemplate[]): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
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

	private dedupeThemes(themes: Theme[]): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
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

	private detectExtensionConflicts(extensions: Extension[]): Array<{ path: string; message: string }> {
		const conflicts: Array<{ path: string; message: string }> = [];

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
