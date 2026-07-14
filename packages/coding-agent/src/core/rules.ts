import type { ResourceDiagnostic } from "./diagnostics.ts";
import {
	formatInstructionResourcesForPrompt,
	type InstructionResource,
	type InstructionResourceFrontmatter,
	InstructionResourceLoader,
} from "./instruction-resource-loader.ts";
import type { ToolOperations } from "./tools/operations.ts";

export interface RuleFrontmatter extends InstructionResourceFrontmatter {}

export interface Rule extends InstructionResource {}

export interface LoadRulesResult {
	rules: Rule[];
	diagnostics: ResourceDiagnostic[];
}

export interface LoadRulesFromDirOptions {
	/** Directory to scan for rules */
	dir: string;
	/** Source identifier for these rules */
	source: string;
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

export interface LoadRulesWithOperationsOptions extends LoadRulesOptions {
	operations: ToolOperations;
}

export class RuleLoader extends InstructionResourceLoader<Rule, RuleFrontmatter> {
	constructor() {
		super({ resourceType: "rule", defaultDirectoryName: "rules", rootFileName: "RULES.md" });
	}

	protected override createResource(resource: InstructionResource): Rule {
		return resource;
	}

	loadFromDir(options: LoadRulesFromDirOptions): LoadRulesResult {
		const result = this.loadResourcesFromDir(options.dir, options.source);
		return { rules: result.resources, diagnostics: result.diagnostics };
	}

	load(options: LoadRulesOptions): LoadRulesResult {
		const result = this.loadResources({
			cwd: options.cwd,
			agentDir: options.agentDir,
			resourcePaths: options.rulePaths,
			includeDefaults: options.includeDefaults,
		});
		return { rules: result.resources, diagnostics: result.diagnostics };
	}

	async loadWithOperations(options: LoadRulesWithOperationsOptions): Promise<LoadRulesResult> {
		const result = await this.loadResourcesWithOperations({
			cwd: options.cwd,
			agentDir: options.agentDir,
			resourcePaths: options.rulePaths,
			includeDefaults: options.includeDefaults,
			operations: options.operations,
		});
		return { rules: result.resources, diagnostics: result.diagnostics };
	}
}

const ruleLoader = new RuleLoader();

/** Load rules from a directory. */
export function loadRulesFromDir(options: LoadRulesFromDirOptions): LoadRulesResult {
	return ruleLoader.loadFromDir(options);
}

/** Load rules from all configured locations. */
export function loadRules(options: LoadRulesOptions): LoadRulesResult {
	return ruleLoader.load(options);
}

export function loadRulesWithOperations(options: LoadRulesWithOperationsOptions): Promise<LoadRulesResult> {
	return ruleLoader.loadWithOperations(options);
}

/** Format model-visible rules for inclusion in a system prompt. */
export function formatRulesForPrompt(rules: Rule[]): string {
	return formatInstructionResourcesForPrompt(rules, {
		intro: [
			"The following rules provide mandatory constraints and policies.",
			"Use the read tool to load a rule's file when the task or files match its description; applicable rules are mandatory.",
			"When a rule file references a relative path, resolve it against the rule directory (parent of RULES.md / dirname of the path) and use that absolute path in tool commands.",
		],
		containerTag: "available_rules",
		itemTag: "rule",
	});
}
