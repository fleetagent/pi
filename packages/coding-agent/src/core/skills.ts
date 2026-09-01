import type { ResourceDiagnostic } from "./diagnostics.ts";
import {
	formatInstructionResourcesForPrompt,
	type InstructionResource,
	type InstructionResourceDirectoryOptions,
	type InstructionResourceFrontmatter,
	InstructionResourceLoader,
} from "./instruction-resource-loader.ts";
import type { ToolOperations } from "./tools/operations.ts";

export interface SkillFrontmatter extends InstructionResourceFrontmatter {}

export interface Skill extends InstructionResource {}

export interface LoadSkillsResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

export type LoadSkillsFromDirOptions = InstructionResourceDirectoryOptions;

export interface LoadSkillsOptions {
	/** Working directory for project-local skills. */
	cwd: string;
	/** Agent config directory for global skills. */
	agentDir: string;
	/** Explicit skill paths (files or directories) */
	skillPaths: string[];
	/** Include default skills directories. */
	includeDefaults: boolean;
}

export interface LoadSkillsWithOperationsOptions extends LoadSkillsOptions {
	operations: ToolOperations;
}

export class SkillLoader extends InstructionResourceLoader<Skill, SkillFrontmatter> {
	constructor() {
		super({ resourceType: "skill", defaultDirectoryName: "skills", rootFileName: "SKILL.md" });
	}

	protected override createResource(resource: InstructionResource): Skill {
		return resource;
	}

	loadFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
		const result = this.loadResourcesFromDir(options.dir, options.source);
		return { skills: result.resources, diagnostics: result.diagnostics };
	}

	load(options: LoadSkillsOptions): LoadSkillsResult {
		const result = this.loadResources({
			cwd: options.cwd,
			agentDir: options.agentDir,
			resourcePaths: options.skillPaths,
			includeDefaults: options.includeDefaults,
		});
		return { skills: result.resources, diagnostics: result.diagnostics };
	}

	async loadWithOperations(options: LoadSkillsWithOperationsOptions): Promise<LoadSkillsResult> {
		const result = await this.loadResourcesWithOperations({
			cwd: options.cwd,
			agentDir: options.agentDir,
			resourcePaths: options.skillPaths,
			includeDefaults: options.includeDefaults,
			operations: options.operations,
		});
		return { skills: result.resources, diagnostics: result.diagnostics };
	}
}

const skillLoader = new SkillLoader();

/** Load skills from a directory. */
export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
	return skillLoader.loadFromDir(options);
}

/** Load skills from all configured locations. */
export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
	return skillLoader.load(options);
}

export function loadSkillsWithOperations(options: LoadSkillsWithOperationsOptions): Promise<LoadSkillsResult> {
	return skillLoader.loadWithOperations(options);
}

/** Format model-visible skills for inclusion in a system prompt. */
export function formatSkillsForPrompt(skills: Skill[]): string {
	return formatInstructionResourcesForPrompt(skills, {
		intro: [
			"The following skills provide specialized instructions for specific tasks.",
			"Use the read tool to load a skill's file when the task matches its description.",
			"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		],
		containerTag: "available_skills",
		itemTag: "skill",
	});
}
