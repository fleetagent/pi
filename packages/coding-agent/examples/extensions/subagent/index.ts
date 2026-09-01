/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@fleetagent/pi-agent-core";
import type { AssistantMessage, Message } from "@fleetagent/pi-ai";
import { StringEnum } from "@fleetagent/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
	type SubagentUsageStats,
	type Theme,
	type ThemeColor,
	withFileMutationQueue,
} from "@fleetagent/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@fleetagent/pi-tui";
import { type Static, Type } from "typebox";
import { type AgentConfig, type AgentConfigSource, type AgentScope, discoverAgents } from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
type UsageDisplayStats = Omit<SubagentUsageStats, "contextTokens" | "turns"> &
	Partial<Pick<SubagentUsageStats, "contextTokens" | "turns">>;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageDisplayStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

type SubagentToolThemeForeground = (color: ThemeColor, text: string) => string;

function shortenSubagentToolPath(filePath: string): string {
	const home = os.homedir();
	return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

function formatSubagentBashCall(args: Record<string, unknown>, themeFg: SubagentToolThemeForeground): string {
	const command = (args.command as string) || "...";
	const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
	return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
}

function formatSubagentReadCall(args: Record<string, unknown>, themeFg: SubagentToolThemeForeground): string {
	const rawPath = (args.file_path || args.path || "...") as string;
	const offset = args.offset as number | undefined;
	const limit = args.limit as number | undefined;
	let text = themeFg("accent", shortenSubagentToolPath(rawPath));
	if (offset !== undefined || limit !== undefined) {
		const startLine = offset ?? 1;
		const endLine = limit !== undefined ? startLine + limit - 1 : "";
		text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
	}
	return themeFg("muted", "read ") + text;
}

function formatSubagentWriteCall(args: Record<string, unknown>, themeFg: SubagentToolThemeForeground): string {
	const rawPath = (args.file_path || args.path || "...") as string;
	const content = (args.content || "") as string;
	const lines = content.split("\n").length;
	let text = themeFg("muted", "write ") + themeFg("accent", shortenSubagentToolPath(rawPath));
	if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
	return text;
}

function formatUnknownSubagentToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: SubagentToolThemeForeground,
): string {
	const argsString = JSON.stringify(args);
	const preview = argsString.length > 50 ? `${argsString.slice(0, 50)}...` : argsString;
	return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
}

function formatToolCall(toolName: string, args: Record<string, unknown>, themeFg: SubagentToolThemeForeground): string {
	switch (toolName) {
		case "bash":
			return formatSubagentBashCall(args, themeFg);
		case "read":
			return formatSubagentReadCall(args, themeFg);
		case "write":
			return formatSubagentWriteCall(args, themeFg);
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenSubagentToolPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenSubagentToolPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "find ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${shortenSubagentToolPath(rawPath)}`)
			);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenSubagentToolPath(rawPath)}`)
			);
		}
		default:
			return formatUnknownSubagentToolCall(toolName, args, themeFg);
	}
}

type SubagentResultAgentSource = AgentConfigSource | "unknown";

interface SingleResult {
	agent: string;
	agentSource: SubagentResultAgentSource;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: SubagentUsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentProcessEvent {
	type?: unknown;
	message?: unknown;
}

type SubagentMode = "single" | "parallel" | "chain";

interface SubagentDetails {
	mode: SubagentMode;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

interface SubagentToolResult extends AgentToolResult<SubagentDetails> {
	isError?: boolean;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

type TemporaryPromptFile = { dir: string; filePath: string };

async function writePromptToTempFile(agentName: string, prompt: string): Promise<TemporaryPromptFile> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

type PiInvocation = { command: string; args: string[] };

function getPiInvocation(args: string[]): PiInvocation {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

function parseSubagentProcessEvent(line: string): SubagentProcessEvent | undefined {
	if (!line.trim()) return undefined;
	try {
		const event = JSON.parse(line) as unknown;
		return event !== null && typeof event === "object" ? (event as SubagentProcessEvent) : undefined;
	} catch {
		return undefined;
	}
}

function accumulateSubagentAssistantMessage(result: SingleResult, message: AssistantMessage): void {
	result.usage.turns++;
	const usage = message.usage;
	if (usage) {
		result.usage.input += usage.input || 0;
		result.usage.output += usage.output || 0;
		result.usage.cacheRead += usage.cacheRead || 0;
		result.usage.cacheWrite += usage.cacheWrite || 0;
		result.usage.cost += usage.cost?.total || 0;
		result.usage.contextTokens = usage.totalTokens || 0;
	}
	if (!result.model && message.model) result.model = message.model;
	if (message.stopReason) result.stopReason = message.stopReason;
	if (message.errorMessage) result.errorMessage = message.errorMessage;
}

function recordSubagentProcessEvent(event: SubagentProcessEvent, result: SingleResult, emitUpdate: () => void): void {
	if (event.type === "message_end" && event.message) {
		const message = event.message as Message;
		result.messages.push(message);
		if (message.role === "assistant") accumulateSubagentAssistantMessage(result, message);
		emitUpdate();
		return;
	}
	if (event.type === "tool_result_end" && event.message) {
		result.messages.push(event.message as Message);
		emitUpdate();
	}
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				const event = parseSubagentProcessEvent(line);
				if (event) recordSubagentProcessEvent(event, currentResult, emitUpdate);
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

interface SubagentTask {
	agent: string;
	task: string;
	cwd?: string;
}

interface SubagentExecutionRequest {
	mode: SubagentMode;
	tasks: SubagentTask[];
}

type SubagentParameters = Static<typeof SubagentParams>;
type SubagentDetailsFactory = (results: SingleResult[]) => SubagentDetails;

interface SubagentExecutionEnvironment {
	extensionContext: ExtensionContext;
	agents: AgentConfig[];
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	signal: AbortSignal | undefined;
	onUpdate: OnUpdateCallback | undefined;
}

function resolveSubagentExecutionRequest(params: SubagentParameters): SubagentExecutionRequest | undefined {
	const requests: SubagentExecutionRequest[] = [];
	if (params.chain && params.chain.length > 0) requests.push({ mode: "chain", tasks: params.chain });
	if (params.tasks && params.tasks.length > 0) requests.push({ mode: "parallel", tasks: params.tasks });
	if (params.agent && params.task) {
		requests.push({ mode: "single", tasks: [{ agent: params.agent, task: params.task, cwd: params.cwd }] });
	}
	return requests.length === 1 ? requests[0] : undefined;
}

function createSubagentDetailsFactory(
	environment: SubagentExecutionEnvironment,
	mode: SubagentMode,
): SubagentDetailsFactory {
	return (results) => ({
		mode,
		agentScope: environment.agentScope,
		projectAgentsDir: environment.projectAgentsDir,
		results,
	});
}

function createSubagentTextResult(text: string, details: SubagentDetails, isError = false): SubagentToolResult {
	const result: SubagentToolResult = { content: [{ type: "text", text }], details };
	if (isError) result.isError = true;
	return result;
}

async function approveProjectAgents(
	params: SubagentParameters,
	environment: SubagentExecutionEnvironment,
	confirmProjectAgents: boolean,
): Promise<boolean> {
	const scopeIncludesProject = environment.agentScope === "project" || environment.agentScope === "both";
	if (!scopeIncludesProject || !confirmProjectAgents || !environment.extensionContext.hasUI) return true;
	const requestedAgentNames = new Set<string>();
	if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
	if (params.tasks) for (const task of params.tasks) requestedAgentNames.add(task.agent);
	if (params.agent) requestedAgentNames.add(params.agent);
	const firstAgentByName = new Map<string, AgentConfig>();
	for (const agent of environment.agents) {
		if (!firstAgentByName.has(agent.name)) firstAgentByName.set(agent.name, agent);
	}
	const projectAgents = Array.from(requestedAgentNames)
		.map((name) => firstAgentByName.get(name))
		.filter((agent): agent is AgentConfig => agent?.source === "project");
	if (projectAgents.length === 0) return true;
	const names = projectAgents.map((agent) => agent.name).join(", ");
	const dir = environment.projectAgentsDir ?? "(unknown)";
	return environment.extensionContext.ui.confirm(
		"Run project-local agents?",
		`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
	);
}

function createChainUpdateCallback(
	environment: SubagentExecutionEnvironment,
	completedResults: SingleResult[],
	detailsFactory: SubagentDetailsFactory,
): OnUpdateCallback | undefined {
	if (!environment.onUpdate) return undefined;
	return (partial) => {
		const currentResult = partial.details?.results[0];
		if (!currentResult) return;
		environment.onUpdate?.({
			content: partial.content,
			details: detailsFactory([...completedResults, currentResult]),
		});
	};
}

async function executeSubagentChain(
	tasks: SubagentTask[],
	environment: SubagentExecutionEnvironment,
): Promise<AgentToolResult<SubagentDetails>> {
	const results: SingleResult[] = [];
	const detailsFactory = createSubagentDetailsFactory(environment, "chain");
	let previousOutput = "";
	for (let index = 0; index < tasks.length; index++) {
		const step = tasks[index];
		const result = await runSingleAgent(
			environment.extensionContext.cwd,
			environment.agents,
			step.agent,
			step.task.replace(/\{previous\}/g, previousOutput),
			step.cwd,
			index + 1,
			environment.signal,
			createChainUpdateCallback(environment, results, detailsFactory),
			detailsFactory,
		);
		results.push(result);
		if (isFailedResult(result)) {
			return createSubagentTextResult(
				`Chain stopped at step ${index + 1} (${step.agent}): ${getResultOutput(result)}`,
				detailsFactory(results),
				true,
			);
		}
		previousOutput = getFinalOutput(result.messages);
	}
	const finalResult = results[results.length - 1];
	return createSubagentTextResult(getFinalOutput(finalResult.messages) || "(no output)", detailsFactory(results));
}

function createPendingParallelResults(tasks: SubagentTask[]): SingleResult[] {
	return tasks.map((task) => ({
		agent: task.agent,
		agentSource: "unknown",
		task: task.task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	}));
}

function emitParallelProgress(
	environment: SubagentExecutionEnvironment,
	results: SingleResult[],
	detailsFactory: SubagentDetailsFactory,
): void {
	if (!environment.onUpdate) return;
	const running = results.filter((result) => result.exitCode === -1).length;
	const done = results.length - running;
	environment.onUpdate({
		content: [{ type: "text", text: `Parallel: ${done}/${results.length} done, ${running} running...` }],
		details: detailsFactory([...results]),
	});
}

function formatParallelSummary(result: SingleResult): string {
	const output = truncateParallelOutput(getResultOutput(result));
	const status = isFailedResult(result)
		? `failed${result.stopReason && result.stopReason !== "end" ? ` (${result.stopReason})` : ""}`
		: "completed";
	return `### [${result.agent}] ${status}\n\n${output}`;
}

async function executeSubagentsInParallel(
	tasks: SubagentTask[],
	environment: SubagentExecutionEnvironment,
): Promise<AgentToolResult<SubagentDetails>> {
	const detailsFactory = createSubagentDetailsFactory(environment, "parallel");
	if (tasks.length > MAX_PARALLEL_TASKS) {
		return createSubagentTextResult(
			`Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
			detailsFactory([]),
		);
	}
	const allResults = createPendingParallelResults(tasks);
	const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (task, index) => {
		const result = await runSingleAgent(
			environment.extensionContext.cwd,
			environment.agents,
			task.agent,
			task.task,
			task.cwd,
			undefined,
			environment.signal,
			(partial) => {
				const currentResult = partial.details?.results[0];
				if (!currentResult) return;
				allResults[index] = currentResult;
				emitParallelProgress(environment, allResults, detailsFactory);
			},
			detailsFactory,
		);
		allResults[index] = result;
		emitParallelProgress(environment, allResults, detailsFactory);
		return result;
	});
	const successCount = results.filter((result) => !isFailedResult(result)).length;
	const summaries = results.map(formatParallelSummary);
	return createSubagentTextResult(
		`Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
		detailsFactory(results),
	);
}

async function executeSingleSubagent(
	task: SubagentTask,
	environment: SubagentExecutionEnvironment,
): Promise<AgentToolResult<SubagentDetails>> {
	const detailsFactory = createSubagentDetailsFactory(environment, "single");
	const result = await runSingleAgent(
		environment.extensionContext.cwd,
		environment.agents,
		task.agent,
		task.task,
		task.cwd,
		undefined,
		environment.signal,
		environment.onUpdate,
		detailsFactory,
	);
	if (isFailedResult(result)) {
		return createSubagentTextResult(
			`Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}`,
			detailsFactory([result]),
			true,
		);
	}
	return createSubagentTextResult(getFinalOutput(result.messages) || "(no output)", detailsFactory([result]));
}

async function executeSubagentTool(
	params: SubagentParameters,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<SubagentDetails>> {
	const agentScope: AgentScope = params.agentScope ?? "user";
	const discovery = discoverAgents(ctx.cwd, agentScope);
	const environment: SubagentExecutionEnvironment = {
		extensionContext: ctx,
		agents: discovery.agents,
		agentScope,
		projectAgentsDir: discovery.projectAgentsDir,
		signal,
		onUpdate,
	};
	const request = resolveSubagentExecutionRequest(params);
	if (!request) {
		const available = discovery.agents.map((agent) => `${agent.name} (${agent.source})`).join(", ") || "none";
		return createSubagentTextResult(
			`Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
			createSubagentDetailsFactory(environment, "single")([]),
		);
	}
	const approved = await approveProjectAgents(params, environment, params.confirmProjectAgents ?? true);
	if (!approved) {
		return createSubagentTextResult(
			"Canceled: project-local agents not approved.",
			createSubagentDetailsFactory(environment, request.mode)([]),
		);
	}
	switch (request.mode) {
		case "chain":
			return executeSubagentChain(request.tasks, environment);
		case "parallel":
			return executeSubagentsInParallel(request.tasks, environment);
		case "single":
			return executeSingleSubagent(request.tasks[0], environment);
	}
}

function renderSubagentChainCall(args: SubagentParameters, scope: AgentScope, theme: Theme): Text | undefined {
	if (!args.chain || args.chain.length === 0) return undefined;
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", `chain (${args.chain.length} steps)`) +
		theme.fg("muted", ` [${scope}]`);
	for (let index = 0; index < Math.min(args.chain.length, 3); index++) {
		const step = args.chain[index];
		const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
		const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
		text +=
			"\n  " +
			theme.fg("muted", `${index + 1}.`) +
			" " +
			theme.fg("accent", step.agent) +
			theme.fg("dim", ` ${preview}`);
	}
	if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
	return new Text(text, 0, 0);
}

function renderSubagentParallelCall(args: SubagentParameters, scope: AgentScope, theme: Theme): Text | undefined {
	if (!args.tasks || args.tasks.length === 0) return undefined;
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
		theme.fg("muted", ` [${scope}]`);
	for (const task of args.tasks.slice(0, 3)) {
		const preview = task.task.length > 40 ? `${task.task.slice(0, 40)}...` : task.task;
		text += `\n  ${theme.fg("accent", task.agent)}${theme.fg("dim", ` ${preview}`)}`;
	}
	if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
	return new Text(text, 0, 0);
}

function renderSingleSubagentCall(args: SubagentParameters, scope: AgentScope, theme: Theme): Text {
	const agentName = args.agent || "...";
	const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agentName) + theme.fg("muted", ` [${scope}]`);
	text += `\n  ${theme.fg("dim", preview)}`;
	return new Text(text, 0, 0);
}

type SubagentRenderedResult = Container | Text;

function renderDisplayItems(items: DisplayItem[], expanded: boolean, theme: Theme, limit?: number): string {
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;
	let text = skipped > 0 ? theme.fg("muted", `... ${skipped} earlier items\n`) : "";
	for (const item of toShow) {
		if (item.type === "text") {
			const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
			text += `${theme.fg("toolOutput", preview)}\n`;
		} else {
			text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
		}
	}
	return text.trimEnd();
}

function aggregateUsage(results: SingleResult[]): UsageDisplayStats {
	const total: UsageDisplayStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const result of results) {
		total.input += result.usage.input;
		total.output += result.usage.output;
		total.cacheRead += result.usage.cacheRead;
		total.cacheWrite += result.usage.cacheWrite;
		total.cost += result.usage.cost;
		total.turns = (total.turns ?? 0) + result.usage.turns;
	}
	return total;
}

function appendToolCalls(container: Container, items: DisplayItem[], theme: Theme): void {
	for (const item of items) {
		if (item.type !== "toolCall") continue;
		container.addChild(
			new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
		);
	}
}

function appendFinalOutput(container: Container, output: string): void {
	if (!output) return;
	container.addChild(new Spacer(1));
	container.addChild(new Markdown(output.trim(), 0, 0, getMarkdownTheme()));
}

function appendUsage(container: Container, usage: string, theme: Theme, prefix = ""): void {
	if (!usage) return;
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", `${prefix}${usage}`), 0, 0));
}

function renderExpandedSingleResult(result: SingleResult, theme: Theme): Container {
	const isError = isFailedResult(result);
	const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const displayItems = getDisplayItems(result.messages);
	const finalOutput = getFinalOutput(result.messages);
	const container = new Container();
	let header = `${icon} ${theme.fg("toolTitle", theme.bold(result.agent))}${theme.fg("muted", ` (${result.agentSource})`)}`;
	if (isError && result.stopReason) header += ` ${theme.fg("error", `[${result.stopReason}]`)}`;
	container.addChild(new Text(header, 0, 0));
	if (isError && result.errorMessage) {
		container.addChild(new Text(theme.fg("error", `Error: ${result.errorMessage}`), 0, 0));
	}
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
	container.addChild(new Text(theme.fg("dim", result.task), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
	if (displayItems.length === 0 && !finalOutput) {
		container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
	} else {
		appendToolCalls(container, displayItems, theme);
		appendFinalOutput(container, finalOutput);
	}
	appendUsage(container, formatUsageStats(result.usage, result.model), theme);
	return container;
}

function renderCollapsedSingleResult(result: SingleResult, theme: Theme): Text {
	const isError = isFailedResult(result);
	const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const displayItems = getDisplayItems(result.messages);
	let text = `${icon} ${theme.fg("toolTitle", theme.bold(result.agent))}${theme.fg("muted", ` (${result.agentSource})`)}`;
	if (isError && result.stopReason) text += ` ${theme.fg("error", `[${result.stopReason}]`)}`;
	if (isError && result.errorMessage) {
		text += `\n${theme.fg("error", `Error: ${result.errorMessage}`)}`;
	} else if (displayItems.length === 0) {
		text += `\n${theme.fg("muted", "(no output)")}`;
	} else {
		text += `\n${renderDisplayItems(displayItems, false, theme, COLLAPSED_ITEM_COUNT)}`;
		if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	}
	const usage = formatUsageStats(result.usage, result.model);
	if (usage) text += `\n${theme.fg("dim", usage)}`;
	return new Text(text, 0, 0);
}

function renderSingleSubagentResult(result: SingleResult, expanded: boolean, theme: Theme): SubagentRenderedResult {
	return expanded ? renderExpandedSingleResult(result, theme) : renderCollapsedSingleResult(result, theme);
}

function appendExpandedSubagentResult(
	container: Container,
	result: SingleResult,
	heading: string,
	theme: Theme,
	failed: boolean,
): void {
	const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const displayItems = getDisplayItems(result.messages);
	container.addChild(new Spacer(1));
	container.addChild(new Text(`${heading} ${icon}`, 0, 0));
	container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", result.task), 0, 0));
	appendToolCalls(container, displayItems, theme);
	appendFinalOutput(container, getFinalOutput(result.messages));
	const usage = formatUsageStats(result.usage, result.model);
	if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
}

function renderExpandedChain(details: SubagentDetails, successCount: number, icon: string, theme: Theme): Container {
	const container = new Container();
	container.addChild(
		new Text(
			icon +
				" " +
				theme.fg("toolTitle", theme.bold("chain ")) +
				theme.fg("accent", `${successCount}/${details.results.length} steps`),
			0,
			0,
		),
	);
	for (const result of details.results) {
		const heading = theme.fg("muted", `─── Step ${result.step}: `) + theme.fg("accent", result.agent);
		appendExpandedSubagentResult(container, result, heading, theme, result.exitCode !== 0);
	}
	appendUsage(container, formatUsageStats(aggregateUsage(details.results)), theme, "Total: ");
	return container;
}

function renderCollapsedChain(details: SubagentDetails, successCount: number, icon: string, theme: Theme): Text {
	let text =
		icon +
		" " +
		theme.fg("toolTitle", theme.bold("chain ")) +
		theme.fg("accent", `${successCount}/${details.results.length} steps`);
	for (const result of details.results) {
		const resultIcon = result.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
		const displayItems = getDisplayItems(result.messages);
		text += `\n\n${theme.fg("muted", `─── Step ${result.step}: `)}${theme.fg("accent", result.agent)} ${resultIcon}`;
		text +=
			displayItems.length === 0
				? `\n${theme.fg("muted", "(no output)")}`
				: `\n${renderDisplayItems(displayItems, false, theme, 5)}`;
	}
	const usage = formatUsageStats(aggregateUsage(details.results));
	if (usage) text += `\n\n${theme.fg("dim", `Total: ${usage}`)}`;
	text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

function renderChainResult(details: SubagentDetails, expanded: boolean, theme: Theme): SubagentRenderedResult {
	const successCount = details.results.filter((result) => result.exitCode === 0).length;
	const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
	return expanded
		? renderExpandedChain(details, successCount, icon, theme)
		: renderCollapsedChain(details, successCount, icon, theme);
}

interface ParallelStatus {
	running: number;
	successCount: number;
	failCount: number;
	isRunning: boolean;
	icon: string;
	label: string;
}

function getParallelStatus(details: SubagentDetails, theme: Theme): ParallelStatus {
	const running = details.results.filter((result) => result.exitCode === -1).length;
	const successCount = details.results.filter((result) => result.exitCode !== -1 && !isFailedResult(result)).length;
	const failCount = details.results.filter((result) => result.exitCode !== -1 && isFailedResult(result)).length;
	const isRunning = running > 0;
	const icon = isRunning
		? theme.fg("warning", "⏳")
		: failCount > 0
			? theme.fg("warning", "◐")
			: theme.fg("success", "✓");
	const label = isRunning
		? `${successCount + failCount}/${details.results.length} done, ${running} running`
		: `${successCount}/${details.results.length} tasks`;
	return { running, successCount, failCount, isRunning, icon, label };
}

function renderExpandedParallel(details: SubagentDetails, status: ParallelStatus, theme: Theme): Container {
	const container = new Container();
	container.addChild(
		new Text(
			`${status.icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status.label)}`,
			0,
			0,
		),
	);
	for (const result of details.results) {
		const heading = theme.fg("muted", "─── ") + theme.fg("accent", result.agent);
		appendExpandedSubagentResult(container, result, heading, theme, isFailedResult(result));
	}
	appendUsage(container, formatUsageStats(aggregateUsage(details.results)), theme, "Total: ");
	return container;
}

function renderCollapsedParallel(
	details: SubagentDetails,
	status: ParallelStatus,
	expanded: boolean,
	theme: Theme,
): Text {
	let text = `${status.icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status.label)}`;
	for (const result of details.results) {
		const resultIcon =
			result.exitCode === -1
				? theme.fg("warning", "⏳")
				: isFailedResult(result)
					? theme.fg("error", "✗")
					: theme.fg("success", "✓");
		const displayItems = getDisplayItems(result.messages);
		text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", result.agent)} ${resultIcon}`;
		text +=
			displayItems.length === 0
				? `\n${theme.fg("muted", result.exitCode === -1 ? "(running...)" : "(no output)")}`
				: `\n${renderDisplayItems(displayItems, false, theme, 5)}`;
	}
	if (!status.isRunning) {
		const usage = formatUsageStats(aggregateUsage(details.results));
		if (usage) text += `\n\n${theme.fg("dim", `Total: ${usage}`)}`;
	}
	if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

function renderParallelResult(details: SubagentDetails, expanded: boolean, theme: Theme): SubagentRenderedResult {
	const status = getParallelStatus(details, theme);
	if (expanded && !status.isRunning) return renderExpandedParallel(details, status, theme);
	return renderCollapsedParallel(details, status, expanded, theme);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		parameters: SubagentParams,

		execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeSubagentTool(params, signal, onUpdate, ctx);
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			const chainCall = renderSubagentChainCall(args, scope, theme);
			if (chainCall) return chainCall;
			const parallelCall = renderSubagentParallelCall(args, scope, theme);
			if (parallelCall) return parallelCall;
			return renderSingleSubagentCall(args, scope, theme);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}
			if (details.mode === "single" && details.results.length === 1) {
				return renderSingleSubagentResult(details.results[0], expanded, theme);
			}
			if (details.mode === "chain") return renderChainResult(details, expanded, theme);
			if (details.mode === "parallel") return renderParallelResult(details, expanded, theme);
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
