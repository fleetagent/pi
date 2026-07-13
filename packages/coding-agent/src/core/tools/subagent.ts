/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Runs each task in a fresh embedded AgentSession using an injected runner.
 *
 * Supports three modes:
 *   - Single: { task: "...", responseFormat: "...", systemPrompt: "..." }
 *   - Parallel: { tasks: [{ task: "...", model: "..." }, ...] }
 *   - Chain: { chain: [{ task: "... {previous} ..." }, ...] }
 */

import * as os from "node:os";
import type { AgentTool, AgentToolResult } from "@fleetagent/pi-agent-core";
import type { Api, Message, Model } from "@fleetagent/pi-ai";
import { StringEnum } from "@fleetagent/pi-ai";
import { Container, Markdown, Spacer, Text } from "@fleetagent/pi-tui";
import { type Static, Type } from "typebox";
import { getMarkdownTheme, type ThemeColor } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { type AgentConfig, type AgentScope, type AgentSource, discoverAgents } from "./subagent-agents.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const GENERIC_SYSTEM_PROMPT =
	"You are an isolated subagent. Complete the delegated task autonomously and return only the information requested by the parent agent.";
const MAX_PARALLEL_TASKS = 8;
const MAX_CHAIN_STEPS = 16;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const MAX_RETAINED_MESSAGE_CHARS = 64 * 1024;
const MAX_RETAINED_TASK_CHARS = 256 * 1024;
const MAX_RETAINED_TASK_MESSAGES = 100;
const MAX_RETAINED_TASK_DESCRIPTION_CHARS = 16 * 1024;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`in:${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`out:${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function getModelFamily(modelId: string): string {
	return modelId.match(/^(.*?\d+(?:\.\d+)+)/)?.[1] ?? modelId;
}

export function formatSubagentModelCatalog(
	currentModel: Model<Api> | undefined,
	availableModels: Model<Api>[],
): string | undefined {
	if (!currentModel) return undefined;
	const family = getModelFamily(currentModel.id);
	const familyModels = availableModels.filter(
		(model) => model.provider === currentModel.provider && (model.id === family || model.id.startsWith(`${family}-`)),
	);
	if (familyModels.length === 0) return undefined;

	const lines = [
		`Authenticated subagent models in the current ${currentModel.provider}/${family} family:`,
		"Omit model to inherit the current model.",
	];
	for (const model of familyModels) {
		const capabilities = [
			model.reasoning ? "reasoning" : "non-reasoning",
			`context ${formatTokens(model.contextWindow)}`,
			`max output ${formatTokens(model.maxTokens)}`,
			`input $${model.cost.input}/M`,
			`output $${model.cost.output}/M`,
		];
		if (model.cost.cacheRead > 0) capabilities.push(`cache read $${model.cost.cacheRead}/M`);
		if (model.cost.cacheWrite > 0) capabilities.push(`cache write $${model.cost.cacheWrite}/M`);
		lines.push(`- ${model.provider}/${model.id}: ${capabilities.join(", ")}`);
	}
	return lines.join("\n");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: ThemeColor, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

export interface SubagentUsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export type SubagentStatus = "queued" | "running" | "completed" | "failed";

export interface SubagentResult {
	status: SubagentStatus;
	agent: string;
	agentSource: AgentSource | "ad-hoc" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: SubagentUsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	responseFormat?: string;
	step?: number;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SubagentResult[];
}

interface PresentationSegment {
	displayItemCount: number;
	assistantOutput?: string;
}

interface SubagentPresentationState {
	displayItems: DisplayItem[];
	assistantOutputs: string[];
	segments: PresentationSegment[];
}

const presentationCache = new WeakMap<Message[], SubagentPresentationState>();

function appendPresentationMessage(state: SubagentPresentationState, message: Message): void {
	const segment: PresentationSegment = { displayItemCount: 0 };
	if (message.role === "assistant") {
		const textParts: string[] = [];
		for (const part of message.content) {
			if (part.type === "text") {
				state.displayItems.push({ type: "text", text: part.text });
				textParts.push(part.text);
				segment.displayItemCount++;
			} else if (part.type === "toolCall") {
				state.displayItems.push({ type: "toolCall", name: part.name, args: part.arguments });
				segment.displayItemCount++;
			}
		}
		if (textParts.length > 0) {
			segment.assistantOutput = textParts.join("\n");
			state.assistantOutputs.push(segment.assistantOutput);
		}
	}
	state.segments.push(segment);
}

function removeOldestPresentationMessage(state: SubagentPresentationState): void {
	const segment = state.segments.shift();
	if (!segment) return;
	if (segment.displayItemCount > 0) state.displayItems.splice(0, segment.displayItemCount);
	if (segment.assistantOutput !== undefined) state.assistantOutputs.shift();
}

function getPresentationState(messages: Message[]): SubagentPresentationState {
	const cached = presentationCache.get(messages);
	if (cached) return cached;
	const state: SubagentPresentationState = { displayItems: [], assistantOutputs: [], segments: [] };
	for (const message of messages) appendPresentationMessage(state, message);
	presentationCache.set(messages, state);
	return state;
}

function getFinalOutput(messages: Message[]): string {
	return getPresentationState(messages).assistantOutputs.at(-1) ?? "";
}

function isFailedResult(result: SubagentResult): boolean {
	return result.status === "failed";
}

function getResultOutput(result: SubagentResult): string {
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
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	return getPresentationState(messages).displayItems;
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
function truncateRetainedTask(task: string): string {
	if (task.length <= MAX_RETAINED_TASK_DESCRIPTION_CHARS) return task;
	return `${task.slice(0, MAX_RETAINED_TASK_DESCRIPTION_CHARS)}\n\n[Task truncated in retained details]`;
}

function truncateRetainedText(text: string): string {
	if (text.length <= MAX_RETAINED_MESSAGE_CHARS) return text;
	return `${text.slice(0, MAX_RETAINED_MESSAGE_CHARS)}\n\n[Retained output truncated: ${text.length - MAX_RETAINED_MESSAGE_CHARS} characters omitted.]`;
}

function compactRetainedMessage(message: Message): Message | undefined {
	if (JSON.stringify(message).length <= MAX_RETAINED_MESSAGE_CHARS) return message;
	if (message.role === "assistant") {
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		return {
			...message,
			errorMessage: message.errorMessage ? truncateRetainedText(message.errorMessage) : undefined,
			content: [{ type: "text", text: truncateRetainedText(text || "[Oversized assistant event omitted]") }],
		};
	}
	if (message.role === "toolResult") {
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		return {
			...message,
			toolCallId: message.toolCallId.slice(0, 1024),
			toolName: message.toolName.slice(0, 1024),
			details: undefined,
			content: [{ type: "text", text: truncateRetainedText(text || "[Oversized tool result omitted]") }],
		};
	}
	return undefined;
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export interface SubagentRunRequest {
	cwd: string;
	prompt: string;
	systemPrompt: string;
	model?: string;
	tools?: string[];
	signal?: AbortSignal;
	onMessage: (message: Message) => void;
}

export interface SubagentRunOutcome {
	exitCode: number;
	stderr: string;
}

export type SubagentRunner = (request: SubagentRunRequest) => Promise<SubagentRunOutcome>;

interface SubagentTaskSpec {
	agent?: string;
	task: string;
	responseFormat?: string;
	systemPrompt?: string;
	model?: string;
	tools?: string[];
	cwd?: string;
}

export function formatSubagentTaskPrompt(task: string, responseFormat?: string): string {
	const sections = [`<task>\n${task}\n</task>`];
	if (responseFormat?.trim()) {
		sections.push(`<response-format>\n${responseFormat}\n</response-format>`);
	}
	return sections.join("\n\n");
}

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	spec: SubagentTaskSpec,
	inheritedModel: string | undefined,
	runner: SubagentRunner,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SubagentResult[]) => SubagentDetails,
): Promise<SubagentResult> {
	const preset = spec.agent ? agents.find((agent) => agent.name === spec.agent) : undefined;
	const agentName = spec.agent ?? "ad-hoc";
	if (spec.agent && !preset) {
		const available = agents.map((agent) => `"${agent.name}"`).join(", ") || "none";
		return {
			status: "failed",
			agent: agentName,
			agentSource: "unknown",
			task: truncateRetainedTask(spec.task),
			responseFormat: spec.responseFormat,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const effectiveModel = spec.model ?? preset?.model ?? inheritedModel;
	const effectiveTools = spec.tools ?? preset?.tools;
	const effectiveSystemPrompt = spec.systemPrompt ?? preset?.systemPrompt ?? GENERIC_SYSTEM_PROMPT;
	const currentResult: SubagentResult = {
		status: "running",
		agent: agentName,
		agentSource: preset?.source ?? "ad-hoc",
		task: truncateRetainedTask(spec.task),
		responseFormat: spec.responseFormat,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: effectiveModel,
		step,
	};
	if (signal?.aborted) {
		currentResult.status = "failed";
		currentResult.exitCode = 1;
		currentResult.stderr = "Subagent was aborted";
		currentResult.stopReason = "aborted";
		currentResult.errorMessage = "Subagent was aborted";
		return currentResult;
	}
	const presentation = getPresentationState(currentResult.messages);
	let retainedChars = 0;
	const retainedSizes: number[] = [];
	const emitUpdate = (): void => {
		onUpdate?.({
			content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
			details: makeDetails([currentResult]),
		});
	};
	const onMessage = (msg: Message): void => {
		const retainedMessage = compactRetainedMessage(msg);
		if (retainedMessage) {
			const retainedSize = JSON.stringify(retainedMessage).length;
			currentResult.messages.push(retainedMessage);
			appendPresentationMessage(presentation, retainedMessage);
			retainedSizes.push(retainedSize);
			retainedChars += retainedSize;
			while (
				currentResult.messages.length > MAX_RETAINED_TASK_MESSAGES ||
				(retainedChars > MAX_RETAINED_TASK_CHARS && currentResult.messages.length > 1)
			) {
				currentResult.messages.shift();
				removeOldestPresentationMessage(presentation);
				retainedChars -= retainedSizes.shift() ?? 0;
			}
		}
		if (msg.role === "assistant") {
			currentResult.usage.turns++;
			const usage = msg.usage;
			if (usage) {
				currentResult.usage.input += usage.input || 0;
				currentResult.usage.output += usage.output || 0;
				currentResult.usage.cacheRead += usage.cacheRead || 0;
				currentResult.usage.cacheWrite += usage.cacheWrite || 0;
				currentResult.usage.cost += usage.cost?.total || 0;
				currentResult.usage.contextTokens = usage.totalTokens || 0;
			}
			if (!currentResult.model && msg.model) currentResult.model = msg.model;
			if (msg.stopReason) currentResult.stopReason = msg.stopReason;
			currentResult.errorMessage = msg.errorMessage;
		}
		emitUpdate();
	};

	emitUpdate();
	let outcome: SubagentRunOutcome;
	try {
		outcome = await runner({
			cwd: spec.cwd ?? defaultCwd,
			prompt: formatSubagentTaskPrompt(spec.task, spec.responseFormat),
			systemPrompt: effectiveSystemPrompt,
			model: effectiveModel,
			tools: effectiveTools,
			signal,
			onMessage,
		});
	} catch (error) {
		if (!signal?.aborted) throw error;
		outcome = { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
	}
	currentResult.exitCode = outcome.exitCode;
	currentResult.stderr = outcome.stderr;
	if (signal?.aborted) {
		currentResult.status = "failed";
		currentResult.stopReason = "aborted";
		currentResult.errorMessage ??= outcome.stderr || "Subagent was aborted";
		return currentResult;
	}
	currentResult.status =
		outcome.exitCode !== 0 || currentResult.stopReason === "error" || currentResult.stopReason === "aborted"
			? "failed"
			: "completed";
	return currentResult;
}

const MODEL_DESCRIPTION = "Model for this task. Omit to inherit the parent model";
const STEP_MODEL_DESCRIPTION = "Model for this step. Omit to inherit the parent model";

function appendModelCatalog(description: string, modelCatalog?: string): string {
	return modelCatalog ? `${description}.\n\n${modelCatalog}` : description;
}

function createSubagentParamsSchema(modelCatalog?: string) {
	const TaskItem = Type.Object({
		agent: Type.Optional(Type.String({ description: "Optional named agent preset" })),
		task: Type.String({ description: "Task to delegate" }),
		responseFormat: Type.Optional(Type.String({ description: "Requested response content and structure" })),
		systemPrompt: Type.Optional(
			Type.String({ description: "Persona/instructions overriding the preset system prompt" }),
		),
		model: Type.Optional(Type.String({ description: appendModelCatalog(MODEL_DESCRIPTION, modelCatalog) })),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist overriding preset defaults" })),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent session" })),
	});

	const ChainItem = Type.Object({
		agent: Type.Optional(Type.String({ description: "Optional named agent preset" })),
		task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
		responseFormat: Type.Optional(Type.String({ description: "Requested response content and structure" })),
		systemPrompt: Type.Optional(
			Type.String({ description: "Persona/instructions overriding the preset system prompt" }),
		),
		model: Type.Optional(Type.String({ description: appendModelCatalog(STEP_MODEL_DESCRIPTION, modelCatalog) })),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist overriding preset defaults" })),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent session" })),
	});

	const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
		description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
		default: "user",
	});

	return Type.Object({
		agent: Type.Optional(Type.String({ description: "Optional named agent preset (single mode)" })),
		task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
		responseFormat: Type.Optional(Type.String({ description: "Requested response content and structure" })),
		systemPrompt: Type.Optional(
			Type.String({ description: "Persona/instructions overriding the preset system prompt" }),
		),
		model: Type.Optional(Type.String({ description: appendModelCatalog(MODEL_DESCRIPTION, modelCatalog) })),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist overriding preset defaults" })),
		tasks: Type.Optional(Type.Array(TaskItem, { description: "Tasks for parallel execution" })),
		chain: Type.Optional(
			Type.Array(ChainItem, { description: "Tasks for sequential execution", maxItems: MAX_CHAIN_STEPS }),
		),
		agentScope: Type.Optional(AgentScopeSchema),
		cwd: Type.Optional(Type.String({ description: "Working directory for the subagent session (single mode)" })),
	});
}

export const subagentParamsSchema = createSubagentParamsSchema();

export type SubagentToolInput = Static<typeof subagentParamsSchema>;

export interface SubagentToolOptions {
	runner?: SubagentRunner;
	modelCatalog?: string;
	/** Host-controlled trust grant for project-local agent presets. */
	trustProjectAgents?: boolean;
}
export function createSubagentToolDefinition(
	options: SubagentToolOptions = {},
): ToolDefinition<typeof subagentParamsSchema, SubagentDetails> {
	const runner = options.runner;
	const parameters = options.modelCatalog ? createSubagentParamsSchema(options.modelCatalog) : subagentParamsSchema;
	return {
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to isolated subagent sessions with optional named presets.",
			"Modes: single (task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Each task can specify responseFormat, systemPrompt, model, tools, cwd, and an optional agent preset.",
			"Omitted models inherit the parent model. Bundled presets: explore, worker, reviewer.",
			'Default agent scope is "user"; project-local presets require host approval or trustProjectAgents in the host configuration.',
		].join(" "),
		promptSnippet: "Delegate tasks to specialized agents in isolated sessions",
		promptGuidelines: [
			"Use subagent for focused parallel investigation or when a task benefits from an isolated context window.",
			"Do not delegate trivial work that is faster to perform directly.",
		],
		parameters,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const inheritedModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SubagentResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (!runner) {
				return {
					content: [{ type: "text", text: "Subagent runner is not configured for this session." }],
					details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
					isError: true,
				};
			}

			if (agentScope === "project" || agentScope === "both") {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) if (step.agent) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const task of params.tasks) if (task.agent) requestedAgentNames.add(task.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((agent) => agent.name === name))
					.filter((agent): agent is AgentConfig => agent?.source === "project");

				if (projectAgentsRequested.length > 0 && !options.trustProjectAgents) {
					const names = projectAgentsRequested.map((agent) => agent.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					if (!ctx.hasUI) {
						return {
							content: [
								{
									type: "text",
									text: `Project-local agents require host approval, but no interactive UI is available. Agents: ${names}. Source: ${dir}.`,
								},
							],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
							isError: true,
						};
					}
					const approved = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!approved) {
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
							isError: true,
						};
					}
				}
			}
			if (params.chain && params.chain.length > 0) {
				if (params.chain.length > MAX_CHAIN_STEPS)
					return {
						content: [
							{
								type: "text",
								text: `Too many chain steps (${params.chain.length}). Max is ${MAX_CHAIN_STEPS}.`,
							},
						],
						details: makeDetails("chain")([]),
					};
				const results: SubagentResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						{ ...step, task: taskWithContext },
						inheritedModel,
						runner,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${result.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SubagentResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					const task = params.tasks[i];
					allResults[i] = {
						status: "queued",
						agent: task.agent ?? "ad-hoc",
						agentSource: task.agent ? "unknown" : "ad-hoc",
						task: truncateRetainedTask(task.task),
						responseFormat: task.responseFormat,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
						model: task.model ?? agents.find((agent) => agent.name === task.agent)?.model ?? inheritedModel,
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.status === "running" || r.status === "queued").length;
						const done = allResults.length - running;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t,
						inheritedModel,
						runner,
						undefined,
						signal,
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					{
						agent: params.agent,
						task: params.task,
						responseFormat: params.responseFormat,
						systemPrompt: params.systemPrompt,
						model: params.model,
						tools: params.tools,
						cwd: params.cwd,
					},
					inheritedModel,
					runner,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent ?? "ad-hoc") +
						theme.fg("muted", ` [${step.model ?? "parent model"}]`) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent ?? "ad-hoc")}${theme.fg("muted", ` [${t.model ?? "parent model"}]`)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "ad-hoc";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}] [${args.model ?? "parent model"}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "-> ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};
			const renderStatusIcon = (status: SubagentStatus): string => {
				if (status === "queued") return theme.fg("muted", "[queued]");
				if (status === "running") return theme.fg("warning", "[running]");
				if (status === "failed") return theme.fg("error", "[failed]");
				return theme.fg("success", "[done]");
			};
			const renderModel = (model?: string): string => theme.fg("muted", ` [${model ?? "model pending"}]`);

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = renderStatusIcon(r.status);
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}${renderModel(r.model)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					if (r.responseFormat) {
						container.addChild(
							new Text(theme.fg("muted", "Response format: ") + theme.fg("dim", r.responseFormat), 0, 0),
						);
					}
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(
							new Text(theme.fg("muted", r.status === "running" ? "(running...)" : "(no output)"), 0, 0),
						);
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "-> ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}${renderModel(r.model)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0)
					text += `\n${theme.fg("muted", r.status === "running" ? "(running...)" : "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SubagentResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.status === "completed").length;
				const failCount = details.results.filter((r) => r.status === "failed").length;
				const runningCount = details.results.filter((r) => r.status === "running" || r.status === "queued").length;
				const icon =
					runningCount > 0
						? theme.fg("warning", "[running]")
						: failCount > 0
							? theme.fg("error", "[failed]")
							: theme.fg("success", "[done]");

				if (expanded) {
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

					for (const r of details.results) {
						const rIcon = renderStatusIcon(r.status);
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)}${renderModel(r.model)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						if (r.responseFormat) {
							container.addChild(
								new Text(theme.fg("muted", "Response format: ") + theme.fg("dim", r.responseFormat), 0, 0),
							);
						}

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "-> ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = renderStatusIcon(r.status);
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)}${renderModel(r.model)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.status === "running" || r.status === "queued" ? `(${r.status}...)` : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.status === "running" || r.status === "queued").length;
				const successCount = details.results.filter((r) => r.status === "completed").length;
				const failCount = details.results.filter((r) => r.status === "failed").length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "[running]")
					: failCount > 0
						? theme.fg("warning", "[partial]")
						: theme.fg("success", "[done]");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = renderStatusIcon(r.status);
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)}${renderModel(r.model)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						if (r.responseFormat) {
							container.addChild(
								new Text(theme.fg("muted", "Response format: ") + theme.fg("dim", r.responseFormat), 0, 0),
							);
						}

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "-> ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon = renderStatusIcon(r.status);
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)}${renderModel(r.model)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.status === "running" || r.status === "queued" ? `(${r.status}...)` : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	};
}

export function createSubagentTool(
	options?: SubagentToolOptions,
): AgentTool<typeof subagentParamsSchema, SubagentDetails> {
	return wrapToolDefinition(createSubagentToolDefinition(options));
}
