import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../../config.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { dirnamePortablePath, joinPortablePath, pathComparisonValue } from "../lsp/portable-path.ts";
import type { ToolOperations } from "./operations.ts";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "bundled" | "user" | "project" | "session";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	modelHint?: string;
	skills?: string[];
	cwd?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

const BUNDLED_AGENTS: AgentConfig[] = [
	{
		name: "explore",
		description: "Fast codebase exploration that returns compressed context for handoff to other agents",
		tools: ["read", "grep", "find", "ls", "bash"],
		systemPrompt: `You are an explorer. Quickly investigate a codebase and return structured findings that another agent can use without re-reading everything.

Your output will be passed to an agent who has NOT seen the files you explored.

Thoroughness (infer from task, default medium):
- Quick: Targeted lookups, key files only
- Medium: Follow imports, read critical sections
- Thorough: Trace all dependencies, check tests/types

Strategy:
1. grep/find to locate relevant code
2. Read key sections
3. Identify types, interfaces, and key functions
4. Note dependencies between files

Return files and exact line ranges, key code, architecture, and the best file to inspect first.`,
		source: "bundled",
		filePath: "<builtin:subagent/explore>",
	},
	{
		name: "worker",
		description: "General-purpose subagent with full capabilities and isolated context",
		systemPrompt: `You are a worker agent with full capabilities. Work autonomously to complete the delegated task.

When finished, report what was completed, files changed, and anything the parent agent should know.`,
		source: "bundled",
		filePath: "<builtin:subagent/worker>",
	},
	{
		name: "reviewer",
		description: "Code review specialist for quality and security analysis",
		tools: ["read", "grep", "find", "ls", "bash"],
		systemPrompt: `You are a senior code reviewer. Analyze code for correctness, security, quality, and maintainability.

Use bash only for read-only commands. Do not modify files or run builds.

Report files reviewed, critical issues, warnings, suggestions, and a concise summary. Include exact file paths and line numbers.`,
		source: "bundled",
		filePath: "<builtin:subagent/reviewer>",
	},
];

function parseAgentConfig(
	content: string,
	filePath: string,
	source: Exclude<AgentSource, "bundled" | "session">,
): AgentConfig | undefined {
	const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
	if (!frontmatter.name || !frontmatter.description) return undefined;
	const tools = frontmatter.tools
		?.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
	const skills = frontmatter.skills
		?.split(",")
		.map((skill) => skill.trim())
		.filter(Boolean);
	return {
		name: frontmatter.name,
		description: frontmatter.description,
		tools: tools && tools.length > 0 ? tools : undefined,
		model: frontmatter.model,
		modelHint: frontmatter.modelHint,
		skills: skills && skills.length > 0 ? skills : undefined,
		cwd: frontmatter.cwd,
		systemPrompt: body,
		source,
		filePath,
	};
}

function loadAgentsFromDir(dir: string, source: Exclude<AgentSource, "bundled" | "session">): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const agent = parseAgentConfig(content, filePath, source);
		if (agent) agents.push(agent);
	}
	return agents;
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const bundledAgents = scope === "project" ? [] : BUNDLED_AGENTS;
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");
	const agentMap = new Map<string, AgentConfig>();

	for (const agent of bundledAgents) agentMap.set(agent.name, agent);
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	for (const agent of projectAgents) agentMap.set(agent.name, agent);

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

async function loadAgentsFromDirWithOperations(dir: string, operations: ToolOperations): Promise<AgentConfig[]> {
	const agents: AgentConfig[] = [];
	let entries: string[];
	try {
		entries = await operations.readdir(dir);
	} catch {
		return agents;
	}
	for (const name of entries.sort()) {
		if (!name.endsWith(".md")) continue;
		const filePath = joinPortablePath(dir, name);
		try {
			const stat = await operations.stat(filePath);
			if (!stat.isFile()) continue;
			const agent = parseAgentConfig((await operations.readFile(filePath)).toString("utf8"), filePath, "project");
			if (agent) agents.push(agent);
		} catch {}
	}
	return agents;
}

async function findNearestProjectAgentsDirWithOperations(
	cwd: string,
	operations: ToolOperations,
	root: string,
	pathFlavor: "posix" | "windows",
): Promise<string | null> {
	let currentDir = cwd;
	while (true) {
		const candidate = joinPortablePath(currentDir, ".pi", "agents");
		try {
			if ((await operations.stat(candidate)).isDirectory()) return candidate;
		} catch {}
		if (pathComparisonValue(currentDir, pathFlavor) === pathComparisonValue(root, pathFlavor)) return null;
		const parentDir = dirnamePortablePath(currentDir, pathFlavor);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function discoverHostOwnedAgents(scope: AgentScope): AgentDiscoveryResult {
	return {
		agents:
			scope === "project"
				? []
				: [...BUNDLED_AGENTS, ...loadAgentsFromDir(path.join(getAgentDir(), "agents"), "user")],
		projectAgentsDir: null,
	};
}

export async function discoverAgentsWithOperations(
	cwd: string,
	scope: AgentScope,
	operations?: ToolOperations,
): Promise<AgentDiscoveryResult> {
	if (!operations) return discoverAgents(cwd, scope);
	const backend = operations.getBackendInfo?.();
	if (backend?.type === "local") return discoverAgents(cwd, scope);
	if (!backend) return discoverHostOwnedAgents(scope);
	if (backend.type === "remote" && !backend.configured) {
		return discoverHostOwnedAgents(scope);
	}
	const remoteCwd = backend.type === "ssh" ? backend.cwd : backend.workspace.root;
	const pathFlavor = backend.type === "ssh" ? "posix" : backend.workspace.pathFlavor;
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir =
		scope === "user"
			? null
			: await findNearestProjectAgentsDirWithOperations(
					remoteCwd,
					operations,
					backend.type === "ssh" ? backend.cwd : backend.workspace.root,
					pathFlavor,
				);
	const bundledAgents = scope === "project" ? [] : BUNDLED_AGENTS;
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = projectAgentsDir ? await loadAgentsFromDirWithOperations(projectAgentsDir, operations) : [];
	const agentMap = new Map<string, AgentConfig>();
	for (const agent of bundledAgents) agentMap.set(agent.name, agent);
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	for (const agent of projectAgents) agentMap.set(agent.name, agent);
	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	return {
		text: listed.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("; "),
		remaining: agents.length - listed.length,
	};
}
