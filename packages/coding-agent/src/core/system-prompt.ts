/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatRulesForPrompt, type Rule } from "./rules.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

// pi-ignore noNearIdenticalDataStructures: System-prompt context requires loaded file content, while the interactive status fixture is display-only and permits path-only entries.
export interface SystemPromptContextFile {
	path: string;
	content: string;
}

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: SystemPromptContextFile[];
	/** Pre-loaded skills. */
	skills?: Skill[];
	/** Pre-loaded rules. */
	rules?: Rule[];
}

interface SystemPromptFinalizationOptions {
	appendSystemPrompt?: string;
	promptCwd: string;
	date: string;
	contextFiles: SystemPromptContextFile[];
	skills: Skill[];
	rules: Rule[];
	hasRead: boolean;
}

function getCurrentPromptDate(): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function appendUniqueGuideline(guidelines: string[], seen: Set<string>, guideline: string): void {
	if (seen.has(guideline)) return;
	seen.add(guideline);
	guidelines.push(guideline);
}

function formatPromptGuidelines(tools: string[], additionalGuidelines: string[] | undefined): string {
	const guidelines: string[] = [];
	const seen = new Set<string>();
	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		appendUniqueGuideline(guidelines, seen, "Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		appendUniqueGuideline(
			guidelines,
			seen,
			"Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)",
		);
	}
	for (const guideline of additionalGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) appendUniqueGuideline(guidelines, seen, normalized);
	}
	appendUniqueGuideline(guidelines, seen, "Be concise in your responses");
	appendUniqueGuideline(guidelines, seen, "Show file paths clearly when working with files");
	return guidelines.map((guideline) => `- ${guideline}`).join("\n");
}

function formatAvailableTools(tools: string[], toolSnippets: Record<string, string> | undefined): string {
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	return visibleTools.length > 0
		? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n")
		: "(none)";
}

function buildOrchestrationSection(hasSubagent: boolean): string {
	if (!hasSubagent) return "";
	return `
			## Orchestration

You are the primary agent and final decision-maker. Use subagents as isolated workers for focused investigation, implementation alternatives, and independent review when delegation improves speed or confidence.

Give each subagent a precise task and expected response format. Treat its output as evidence, not authority: reconcile conflicting findings, verify important claims against source or tests, and integrate the final result yourself.

Work directly when delegation would cost more than completing the task. Do not delegate responsibility for the final answer.
		  `.trim();
}

function buildDefaultSystemPrompt(options: BuildSystemPromptOptions, tools: string[]): string {
	const toolsList = formatAvailableTools(tools, options.toolSnippets);
	const guidelines = formatPromptGuidelines(tools, options.promptGuidelines);
	const orchestrationSection = buildOrchestrationSection(tools.includes("subagent"));
	const stateCompressionSection = tools.includes("compress_context")
		? `## State compression
Proactively use compress_context at useful checkpoints after finishing a substantial slice of work (such as investigation, implementation, or validation), when the detailed tool calls are no longer needed for the next steps. Do not wait for the context window to fill or for the user to ask. Avoid compressing during active work or when the raw details are still needed.

When current context utilization is known, treat about 35% as a soft threshold: compress at the next completed work slice if there is redundant history. At about 50%, prioritize compression at the next safe checkpoint. These are guidelines, not reasons to interrupt active work, compress trivial exchanges, or repeatedly check utilization just to hit a number.

You receive model-only context metadata after user messages and completed tool-call batches, with session entry IDs and approximate utilization at those points. Use a user or assistant tool-call entry ID as a compression cut point; tool-result IDs are for lookup, not cuts. Do not repeat this metadata to the user.

Turn batches of reads, searches, builds, and tests into concise state: findings and decisions, changed files, what passed or failed (including relevant errors), unresolved issues, and concrete next steps. Preserve important user instructions and constraints. Omit redundant tool output rather than carrying it forward.

Choose a cut point from the entry IDs already visible in context metadata. Pass startEntryId and a summary to replace through the current tail, or add inclusive endEntryId to replace an older bounded range while retaining later messages. Never split a tool call from its results. Detector-suggested IDs are advisory; verify the range yourself before acting. Do not send a list of IDs. Call compress_context alone, not alongside other tools. session_search defaults to current model context; scope: branch/all retrieves historical entries for reference, not necessarily valid compression cut points.`
		: "";
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();
	return `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.
Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.
${orchestrationSection ? `\n${orchestrationSection}\n` : ""}${stateCompressionSection ? `\n${stateCompressionSection}\n` : ""}
Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), type TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;
}

function finalizeSystemPrompt(prompt: string, options: SystemPromptFinalizationOptions): string {
	if (options.appendSystemPrompt) prompt += `\n\n${options.appendSystemPrompt}`;
	if (options.contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path, content } of options.contextFiles) {
			prompt += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}
	if (options.hasRead && options.skills.length > 0) prompt += formatSkillsForPrompt(options.skills);
	if (options.hasRead && options.rules.length > 0) prompt += formatRulesForPrompt(options.rules);
	prompt += `\nCurrent date: ${options.date}`;
	prompt += `\nCurrent working directory: ${options.promptCwd}`;
	return prompt;
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const tools = options.selectedTools || ["read", "bash", "edit", "write"];
	const basePrompt = options.customPrompt || buildDefaultSystemPrompt(options, tools);
	return finalizeSystemPrompt(basePrompt, {
		appendSystemPrompt: options.appendSystemPrompt,
		promptCwd: options.cwd.replace(/\\/g, "/"),
		date: getCurrentPromptDate(),
		contextFiles: options.contextFiles ?? [],
		skills: options.skills ?? [],
		rules: options.rules ?? [],
		hasRead: !options.selectedTools || tools.includes("read"),
	});
}
