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
import type { Api, AssistantMessage, Message, Model, TextContent } from "@fleetagent/pi-ai";
import { StringEnum } from "@fleetagent/pi-ai";
import { Container, Markdown, Spacer, Text } from "@fleetagent/pi-tui";
import { type Static, Type } from "typebox";
import { getMarkdownTheme, type Theme, type ThemeColor } from "../../modes/interactive/theme/theme.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import type { ToolOperations } from "./operations.ts";
import {
	type AgentConfig,
	type AgentScope,
	type AgentSource,
	discoverAgentsWithOperations,
} from "./subagent-agents.ts";
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

type SubagentUsageDisplayMetrics = Omit<SubagentUsageStats, "contextTokens" | "turns"> &
	Partial<Pick<SubagentUsageStats, "contextTokens" | "turns">>;

function formatUsageStats(usage: SubagentUsageDisplayMetrics, model?: string): string {
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

export function formatSubagentModelCatalog(
	currentModel: Model<Api> | undefined,
	availableModels: Model<Api>[],
): string | undefined {
	if (!currentModel) return undefined;
	const providerModels = availableModels.filter((model) => model.provider === currentModel.provider);
	if (providerModels.length === 0) return undefined;

	const lines = [
		`Authenticated subagent models for the current ${currentModel.provider} provider:`,
		"Omit model to inherit the current model.",
	];
	for (const model of providerModels) {
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

type SubagentToolThemeForeground = (color: ThemeColor, text: string) => string;

function shortenSubagentToolPath(filePath: string): string {
	const home = os.homedir();
	return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

function formatBashToolCall(args: Record<string, unknown>, themeFg: SubagentToolThemeForeground): string {
	const command = (args.command as string) || "...";
	const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
	return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
}

function formatReadToolCall(args: Record<string, unknown>, themeFg: SubagentToolThemeForeground): string {
	const rawPath = (args.file_path || args.path || "...") as string;
	const filePath = shortenSubagentToolPath(rawPath);
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

function formatWriteToolCall(args: Record<string, unknown>, themeFg: SubagentToolThemeForeground): string {
	const rawPath = (args.file_path || args.path || "...") as string;
	const filePath = shortenSubagentToolPath(rawPath);
	const content = (args.content || "") as string;
	const lines = content.split("\n").length;
	let text = themeFg("muted", "write ") + themeFg("accent", filePath);
	if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
	return text;
}

function formatToolCall(toolName: string, args: Record<string, unknown>, themeFg: SubagentToolThemeForeground): string {
	switch (toolName) {
		case "bash":
			return formatBashToolCall(args, themeFg);
		case "read":
			return formatReadToolCall(args, themeFg);
		case "write":
			return formatWriteToolCall(args, themeFg);
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
export type SubagentRunStatus = Exclude<SubagentStatus, "queued">;
export type SubagentMode = "single" | "parallel" | "chain";
export type SubagentAgentSource = AgentSource | "ad-hoc" | "unknown";

export interface SubagentResult {
	status: SubagentStatus;
	runId?: string;
	sessionReference?: string;
	agent: string;
	agentSource: SubagentAgentSource;
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
	mode: SubagentMode;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SubagentResult[];
}

export interface SubagentRunInfo {
	runId: string;
	sessionReference?: string;
	status: SubagentRunStatus;
	agent: string;
	task: string;
	cwd: string;
	model?: string;
	createdAt: string;
	updatedAt: string;
	lastOutput?: string;
}

export type SubagentModelHint =
	| "cheapest"
	| "fastest"
	| "strongest"
	| "best-reasoning"
	| "large-context"
	| "same-as-parent"
	| "balanced";

export interface SessionSubagentConfig {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	model?: string;
	modelHint?: SubagentModelHint;
	skills?: string[];
	cwd?: string;
	createdAt: string;
	updatedAt: string;
}

export interface SubagentRunRegistry {
	list(): SubagentRunInfo[];
}

export interface SubagentConfigRegistry {
	list(): SessionSubagentConfig[];
	upsert(config: SessionSubagentConfig): void;
	get(name: string): SessionSubagentConfig | undefined;
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

interface RetainedSubagentMessageState {
	presentation: SubagentPresentationState;
	retainedChars: number;
	retainedSizes: number[];
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
function retainSubagentMessage(result: SubagentResult, state: RetainedSubagentMessageState, message: Message): void {
	const retainedMessage = compactRetainedMessage(message);
	if (!retainedMessage) return;

	const retainedSize = JSON.stringify(retainedMessage).length;
	result.messages.push(retainedMessage);
	appendPresentationMessage(state.presentation, retainedMessage);
	state.retainedSizes.push(retainedSize);
	state.retainedChars += retainedSize;
	while (
		result.messages.length > MAX_RETAINED_TASK_MESSAGES ||
		(state.retainedChars > MAX_RETAINED_TASK_CHARS && result.messages.length > 1)
	) {
		result.messages.shift();
		removeOldestPresentationMessage(state.presentation);
		state.retainedChars -= state.retainedSizes.shift() ?? 0;
	}
}

function recordSubagentAssistantMessage(result: SubagentResult, message: AssistantMessage): void {
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
	result.errorMessage = message.errorMessage;
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export interface SubagentRunRequest {
	cwd: string;
	toolOperations?: ToolOperations;
	prompt: string;
	/** Human-readable delegated task, without wrapper markup. */
	task: string;
	agent: string;
	agentSource: SubagentAgentSource;
	systemPrompt: string;
	model?: string;
	tools?: string[];
	skills?: string[];
	continueSession?: string;
	signal?: AbortSignal;
	onMessage: (message: Message) => void;
}

export interface SubagentRunOutcome {
	exitCode: number;
	stderr: string;
	runId?: string;
	sessionReference?: string;
}

export type SubagentRunner = (request: SubagentRunRequest) => Promise<SubagentRunOutcome>;

interface SubagentTaskSpec {
	agent?: string;
	task: string;
	responseFormat?: string;
	systemPrompt?: string;
	model?: string;
	modelHint?: SubagentModelHint;
	tools?: string[];
	skills?: string[];
	cwd?: string;
	toolOperations?: ToolOperations;
	continueSession?: string;
}
interface SubagentModelSelection {
	spec: SubagentTaskSpec;
	preset: AgentConfig | undefined;
	inheritedModel: string | undefined;
	agentName: string;
	result: SubagentResult;
	resolveModelHintOption: ((hint: SubagentModelHint) => string | undefined) | undefined;
}

function selectSubagentModel(selection: SubagentModelSelection): string | undefined {
	const { spec, preset, inheritedModel, agentName, result, resolveModelHintOption } = selection;
	return (
		spec.model ??
		(spec.modelHint
			? resolveModelHint(spec.modelHint, resolveModelHintOption, `task "${agentName}"`, result)
			: undefined) ??
		preset?.model ??
		(preset?.modelHint
			? resolveModelHint(
					preset.modelHint as SubagentModelHint,
					resolveModelHintOption,
					`agent "${agentName}"`,
					result,
				)
			: undefined) ??
		inheritedModel
	);
}

function finalizeSubagentRun(result: SubagentResult, outcome: SubagentRunOutcome, aborted: boolean): SubagentResult {
	result.runId = outcome.runId;
	result.sessionReference = outcome.sessionReference;
	result.exitCode = outcome.exitCode;
	result.stderr = outcome.stderr;
	if (aborted) {
		result.status = "failed";
		result.stopReason = "aborted";
		result.errorMessage ??= outcome.stderr || "Subagent was aborted";
		return result;
	}
	result.status =
		outcome.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted"
			? "failed"
			: "completed";
	return result;
}
async function invokeSubagentRunner(runner: SubagentRunner, request: SubagentRunRequest): Promise<SubagentRunOutcome> {
	try {
		return await runner(request);
	} catch (error) {
		if (!request.signal?.aborted) throw error;
		return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
	}
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
	resolveModelHintOption: ((hint: SubagentModelHint) => string | undefined) | undefined,
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
		step,
	};
	const effectiveModel = selectSubagentModel({
		spec,
		preset,
		inheritedModel,
		agentName,
		result: currentResult,
		resolveModelHintOption,
	});
	const effectiveTools = spec.tools ?? preset?.tools;
	const effectiveSkills = spec.skills ?? preset?.skills;
	const effectiveCwd = spec.cwd ?? preset?.cwd ?? defaultCwd;
	const effectiveSystemPrompt = spec.systemPrompt ?? preset?.systemPrompt ?? GENERIC_SYSTEM_PROMPT;
	currentResult.model = effectiveModel;
	if (currentResult.status === "failed") return currentResult;
	if (signal?.aborted) {
		currentResult.status = "failed";
		currentResult.exitCode = 1;
		currentResult.stderr = "Subagent was aborted";
		currentResult.stopReason = "aborted";
		currentResult.errorMessage = "Subagent was aborted";
		return currentResult;
	}
	const retainedMessageState: RetainedSubagentMessageState = {
		presentation: getPresentationState(currentResult.messages),
		retainedChars: 0,
		retainedSizes: [],
	};
	const emitUpdate = (): void => {
		onUpdate?.({
			content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
			details: makeDetails([currentResult]),
		});
	};
	const onMessage = (message: Message): void => {
		retainSubagentMessage(currentResult, retainedMessageState, message);
		if (message.role === "assistant") recordSubagentAssistantMessage(currentResult, message);
		emitUpdate();
	};

	emitUpdate();
	const outcome = await invokeSubagentRunner(runner, {
		cwd: effectiveCwd,
		toolOperations: spec.toolOperations,
		prompt: formatSubagentTaskPrompt(spec.task, spec.responseFormat),
		task: spec.task,
		agent: agentName,
		agentSource: preset?.source ?? "ad-hoc",
		systemPrompt: effectiveSystemPrompt,
		model: effectiveModel,
		tools: effectiveTools,
		skills: effectiveSkills,
		continueSession: spec.continueSession,
		signal,
		onMessage,
	});
	return finalizeSubagentRun(currentResult, outcome, signal?.aborted === true);
}

const MODEL_DESCRIPTION = "Model for this task. Omit to inherit the parent model";
const STEP_MODEL_DESCRIPTION = "Model for this step. Omit to inherit the parent model";
const MODEL_HINT_VALUES = [
	"cheapest",
	"fastest",
	"strongest",
	"best-reasoning",
	"large-context",
	"same-as-parent",
	"balanced",
] as const;
const MODEL_HINT_DESCRIPTION =
	"Advisory model selection hint. Exact model overrides this. Supported: cheapest, fastest, strongest, best-reasoning, large-context, same-as-parent, balanced.";

function appendModelCatalog(description: string, modelCatalog?: string): string {
	return modelCatalog ? `${description}.\n\n${modelCatalog}` : description;
}

function createModelHintSchema() {
	return StringEnum(MODEL_HINT_VALUES, { description: MODEL_HINT_DESCRIPTION });
}

function mergeSessionAgents(agents: AgentConfig[], configs: SessionSubagentConfig[]): AgentConfig[] {
	const agentMap = new Map<string, AgentConfig>();
	for (const agent of agents) agentMap.set(agent.name, agent);
	for (const config of configs) {
		agentMap.set(config.name, {
			name: config.name,
			description: config.description,
			systemPrompt: config.systemPrompt,
			tools: config.tools,
			model: config.model,
			modelHint: config.modelHint,
			skills: config.skills,
			cwd: config.cwd,
			source: "session",
			filePath: `<session-subagent:${config.name}>`,
		});
	}
	return Array.from(agentMap.values());
}

function resolveModelHint(
	hint: SubagentModelHint | undefined,
	resolveModelHintOption: ((hint: SubagentModelHint) => string | undefined) | undefined,
	context: string,
	result: SubagentResult,
): string | undefined {
	if (!hint) return undefined;
	const resolved = resolveModelHintOption?.(hint);
	if (!resolved) {
		result.status = "failed";
		result.exitCode = 1;
		result.stderr = `Could not resolve modelHint "${hint}" for ${context}.`;
		result.errorMessage = result.stderr;
		result.stopReason = "error";
		return undefined;
	}
	return resolved;
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
		modelHint: Type.Optional(createModelHintSchema()),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist overriding preset defaults" })),
		skills: Type.Optional(
			Type.Array(Type.String(), { description: "Skills to preload before the first subagent turn" }),
		),
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
		modelHint: Type.Optional(createModelHintSchema()),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist overriding preset defaults" })),
		skills: Type.Optional(
			Type.Array(Type.String(), { description: "Skills to preload before the first subagent turn" }),
		),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent session" })),
	});

	const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
		description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
		default: "user",
	});

	return Type.Object({
		agent: Type.Optional(Type.String({ description: "Optional named agent preset (single mode)" })),
		task: Type.Optional(
			Type.String({ description: "Task to delegate (single mode) or follow-up prompt when continuing a subagent" }),
		),
		responseFormat: Type.Optional(Type.String({ description: "Requested response content and structure" })),
		systemPrompt: Type.Optional(
			Type.String({ description: "Persona/instructions overriding the preset system prompt" }),
		),
		model: Type.Optional(Type.String({ description: appendModelCatalog(MODEL_DESCRIPTION, modelCatalog) })),
		modelHint: Type.Optional(createModelHintSchema()),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist overriding preset defaults" })),
		skills: Type.Optional(
			Type.Array(Type.String(), { description: "Skills to preload before the first subagent turn" }),
		),
		tasks: Type.Optional(Type.Array(TaskItem, { description: "Tasks for parallel execution" })),
		chain: Type.Optional(
			Type.Array(ChainItem, { description: "Tasks for sequential execution", maxItems: MAX_CHAIN_STEPS }),
		),
		agentScope: Type.Optional(AgentScopeSchema),
		continueSession: Type.Optional(Type.String({ description: "Run id of a previous subagent run to continue" })),
		cwd: Type.Optional(Type.String({ description: "Working directory for the subagent session (single mode)" })),
	});
}

export const subagentParamsSchema = createSubagentParamsSchema();

export type SubagentToolInput = Static<typeof subagentParamsSchema>;

export interface SubagentToolOptions {
	runner?: SubagentRunner;
	modelCatalog?: string;
	resolveModelHint?: (hint: SubagentModelHint) => string | undefined;
	/** Host-controlled trust grant for project-local agent presets. */
	trustProjectAgents?: boolean;
	runRegistry?: SubagentRunRegistry;
	configRegistry?: SubagentConfigRegistry;
}
const subagentRunsParamsSchema = Type.Object({
	status: Type.Optional(
		StringEnum(["running", "completed", "failed"] as const, { description: "Filter runs by status" }),
	),
});

export type SubagentRunsToolInput = Static<typeof subagentRunsParamsSchema>;

function truncateRunPreview(text: string | undefined): string {
	if (!text) return "";
	const trimmed = text.trim();
	return trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed;
}

export interface SubagentRunsDetails {
	runs: SubagentRunInfo[];
}

export function createSubagentRunsToolDefinition(
	registry?: SubagentRunRegistry,
): ToolDefinition<typeof subagentRunsParamsSchema, SubagentRunsDetails> {
	return {
		name: "subagent_runs",
		label: "Subagent Runs",
		description: "List subagent runs in the current session so one can be selected and continued by run id.",
		promptSnippet: "List subagent runs from the current session for continuation",
		parameters: subagentRunsParamsSchema,
		async execute(_toolCallId, params) {
			if (!registry) {
				return {
					content: [{ type: "text", text: "Subagent run registry is not configured for this session." }],
					details: { runs: [] },
					isError: true,
				};
			}
			const runs = registry.list().filter((run) => !params.status || run.status === params.status);
			if (runs.length === 0) {
				return { content: [{ type: "text", text: "No subagent runs found." }], details: { runs } };
			}
			const text = runs
				.map((run, index) => {
					const lines = [
						`${index + 1}. ${run.runId} [${run.status}] ${run.agent}${run.model ? ` (${run.model})` : ""}`,
						`   Task: ${run.task.replace(/\s+/g, " ")}`,
						`   CWD: ${run.cwd}`,
					];
					if (run.sessionReference) lines.push(`   Session: ${run.sessionReference}`);
					const preview = truncateRunPreview(run.lastOutput);
					if (preview) lines.push(`   Output: ${preview}`);
					return lines.join("\n");
				})
				.join("\n\n");
			return { content: [{ type: "text", text }], details: { runs } };
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("subagent_runs")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content
				.filter((part): part is TextContent => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();
			return new Text(theme.fg("toolOutput", text), 0, 0);
		},
	};
}
const createSubagentConfigParamsSchema = Type.Object({
	name: Type.String({ description: "Session-scoped subagent preset name" }),
	description: Type.String({ description: "Short description shown when this preset is available" }),
	systemPrompt: Type.String({ description: "System prompt/persona for this subagent preset" }),
	model: Type.Optional(Type.String({ description: "Exact model for this preset. Overrides modelHint." })),
	modelHint: Type.Optional(createModelHintSchema()),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Default tool allowlist for this preset" })),
	skills: Type.Optional(
		Type.Array(Type.String(), { description: "Skill names to preload before the first subagent turn" }),
	),
	cwd: Type.Optional(Type.String({ description: "Default working directory for this preset" })),
});

export type CreateSubagentToolInput = Static<typeof createSubagentConfigParamsSchema>;

export interface CreateSubagentDetails {
	config?: SessionSubagentConfig;
	configs: SessionSubagentConfig[];
}

export function createCreateSubagentToolDefinition(
	registry?: SubagentConfigRegistry,
): ToolDefinition<typeof createSubagentConfigParamsSchema, CreateSubagentDetails> {
	return {
		name: "create_subagent",
		label: "Create Subagent",
		description: "Create or replace a session-scoped named subagent preset for later subagent calls.",
		promptSnippet: "Create session-scoped subagent presets with tools, skills, cwd, and model hints",
		promptGuidelines: [
			"Use create_subagent when a reusable temporary role would reduce repeated subagent configuration.",
			"Prefer modelHint for cost/performance intent unless an exact model is required.",
		],
		parameters: createSubagentConfigParamsSchema,
		async execute(_toolCallId, params) {
			if (!registry) {
				return {
					content: [{ type: "text", text: "Subagent config registry is not configured for this session." }],
					details: { configs: [] },
					isError: true,
				};
			}
			const trimmedName = params.name.trim();
			if (!/^[A-Za-z0-9_-]{1,64}$/.test(trimmedName)) {
				return {
					content: [
						{ type: "text", text: "Invalid subagent name. Use 1-64 letters, numbers, underscores, or hyphens." },
					],
					details: { configs: registry.list() },
					isError: true,
				};
			}
			const now = new Date().toISOString();
			const existing = registry.get(trimmedName);
			const config: SessionSubagentConfig = {
				name: trimmedName,
				description: params.description.trim(),
				systemPrompt: params.systemPrompt,
				model: params.model?.trim() || undefined,
				modelHint: params.modelHint,
				tools: params.tools?.map((tool) => tool.trim()).filter(Boolean),
				skills: params.skills?.map((skill) => skill.trim()).filter(Boolean),
				cwd: params.cwd?.trim() || undefined,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			};
			registry.upsert(config);
			return {
				content: [{ type: "text", text: `Created subagent preset "${config.name}".` }],
				details: { config, configs: registry.list() },
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("create_subagent ")) + theme.fg("accent", args.name), 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content
				.filter((part): part is TextContent => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			return new Text(theme.fg("toolOutput", text), 0, 0);
		},
	};
}

interface SubagentModeSelection {
	mode: SubagentMode;
	hasChain: boolean;
	hasTasks: boolean;
	hasSingle: boolean;
	modeCount: number;
}

type SubagentDetailsBuilder = (results: SubagentResult[]) => SubagentDetails;
type SubagentDetailsFactory = (mode: SubagentMode) => SubagentDetailsBuilder;

interface SubagentExecutionEnvironment {
	agents: AgentConfig[];
	workspaceCwd: string;
	workspaceOperations: ToolOperations;
	inheritedModel: string | undefined;
	runner: SubagentRunner;
	signal: AbortSignal | undefined;
	onUpdate: OnUpdateCallback | undefined;
	makeDetails: SubagentDetailsFactory;
	resolveModelHintOption: ((hint: SubagentModelHint) => string | undefined) | undefined;
}

interface SubagentToolExecutionResult extends AgentToolResult<SubagentDetails> {
	isError?: boolean;
}

function inheritedSubagentModelName(model: Model<Api> | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

function selectSubagentMode(params: SubagentToolInput): SubagentModeSelection {
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.task);
	return {
		mode: hasChain ? "chain" : hasTasks ? "parallel" : "single",
		hasChain,
		hasTasks,
		hasSingle,
		modeCount: Number(hasChain) + Number(hasTasks) + Number(hasSingle),
	};
}

function createSubagentDetailsFactory(agentScope: AgentScope, projectAgentsDir: string | null): SubagentDetailsFactory {
	return (mode) => (results) => ({ mode, agentScope, projectAgentsDir, results });
}

function hasContinuedSessionOverrides(params: SubagentToolInput): boolean {
	return (
		params.agent !== undefined ||
		params.systemPrompt !== undefined ||
		params.model !== undefined ||
		params.modelHint !== undefined ||
		params.tools !== undefined ||
		params.skills !== undefined ||
		params.cwd !== undefined ||
		params.agentScope !== undefined
	);
}

function validateSubagentRequest(
	params: SubagentToolInput,
	selection: SubagentModeSelection,
	agents: AgentConfig[],
	makeDetails: SubagentDetailsFactory,
): SubagentToolExecutionResult | undefined {
	if (selection.modeCount !== 1) {
		const available = agents.map((agent) => `${agent.name} (${agent.source})`).join(", ") || "none";
		return {
			content: [
				{ type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` },
			],
			details: makeDetails("single")([]),
		};
	}
	if (params.continueSession && !selection.hasSingle) {
		return {
			content: [{ type: "text", text: "Invalid parameters. continueSession requires a single follow-up task." }],
			details: makeDetails(selection.mode)([]),
			isError: true,
		};
	}
	if (params.continueSession && hasContinuedSessionOverrides(params)) {
		return {
			content: [
				{
					type: "text",
					text: "Invalid parameters. A continued subagent may only specify task and responseFormat.",
				},
			],
			details: makeDetails("single")([]),
			isError: true,
		};
	}
	return undefined;
}

function collectRequestedAgentNames(params: SubagentToolInput): Set<string> {
	const names = new Set<string>();
	for (const step of params.chain ?? []) if (step.agent) names.add(step.agent);
	for (const task of params.tasks ?? []) if (task.agent) names.add(task.agent);
	if (params.agent) names.add(params.agent);
	return names;
}

async function authorizeProjectAgents(
	params: SubagentToolInput,
	agentScope: AgentScope,
	agents: AgentConfig[],
	projectAgentsDir: string | null,
	trustProjectAgents: boolean | undefined,
	ctx: ExtensionContext,
	makeDetails: SubagentDetailsFactory,
	mode: SubagentMode,
): Promise<SubagentToolExecutionResult | undefined> {
	if (agentScope === "user") return undefined;
	const agentsByName = new Map<string, AgentConfig>();
	for (const agent of agents) {
		if (!agentsByName.has(agent.name)) agentsByName.set(agent.name, agent);
	}
	const projectAgents: AgentConfig[] = [];
	for (const name of collectRequestedAgentNames(params)) {
		const agent = agentsByName.get(name);
		if (agent?.source === "project") projectAgents.push(agent);
	}
	if (projectAgents.length === 0 || trustProjectAgents) return undefined;
	const names = projectAgents.map((agent) => agent.name).join(", ");
	const dir = projectAgentsDir ?? "(unknown)";
	if (!ctx.hasUI) {
		return {
			content: [
				{
					type: "text",
					text: `Project-local agents require host approval, but no interactive UI is available. Agents: ${names}. Source: ${dir}.`,
				},
			],
			details: makeDetails(mode)([]),
			isError: true,
		};
	}
	const approved = await ctx.ui.confirm(
		"Run project-local agents?",
		`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
	);
	if (approved) return undefined;
	return {
		content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
		details: makeDetails(mode)([]),
		isError: true,
	};
}

function createChainUpdate(
	onUpdate: OnUpdateCallback | undefined,
	results: SubagentResult[],
	makeDetails: SubagentDetailsFactory,
): OnUpdateCallback | undefined {
	if (!onUpdate) return undefined;
	return (partial) => {
		const currentResult = partial.details?.results[0];
		if (!currentResult) return;
		onUpdate({
			content: partial.content,
			details: makeDetails("chain")([...results, currentResult]),
		});
	};
}

async function executeSubagentChain(
	params: SubagentToolInput,
	environment: SubagentExecutionEnvironment,
): Promise<SubagentToolExecutionResult> {
	const chain = params.chain ?? [];
	if (chain.length > MAX_CHAIN_STEPS) {
		return {
			content: [{ type: "text", text: `Too many chain steps (${chain.length}). Max is ${MAX_CHAIN_STEPS}.` }],
			details: environment.makeDetails("chain")([]),
		};
	}
	const results: SubagentResult[] = [];
	let previousOutput = "";
	for (let index = 0; index < chain.length; index++) {
		const step = chain[index];
		const result = await runSingleAgent(
			environment.workspaceCwd,
			environment.agents,
			{
				...step,
				task: step.task.replace(/\{previous\}/g, previousOutput),
				toolOperations: environment.workspaceOperations,
			},
			environment.inheritedModel,
			environment.runner,
			index + 1,
			environment.signal,
			createChainUpdate(environment.onUpdate, results, environment.makeDetails),
			environment.makeDetails("chain"),
			environment.resolveModelHintOption,
		);
		results.push(result);
		if (isFailedResult(result)) {
			return {
				content: [
					{
						type: "text",
						text: `Chain stopped at step ${index + 1} (${result.agent}): ${getResultOutput(result)}`,
					},
				],
				details: environment.makeDetails("chain")(results),
				isError: true,
			};
		}
		previousOutput = getFinalOutput(result.messages);
	}
	return {
		content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
		details: environment.makeDetails("chain")(results),
	};
}

function createQueuedSubagentResult(
	task: SubagentTaskSpec,
	agents: AgentConfig[],
	inheritedModel: string | undefined,
): SubagentResult {
	return {
		status: "queued",
		agent: task.agent ?? "ad-hoc",
		agentSource: task.agent ? "unknown" : "ad-hoc",
		task: truncateRetainedTask(task.task),
		responseFormat: task.responseFormat,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model:
			task.model ??
			(task.modelHint ? `hint:${task.modelHint}` : undefined) ??
			agents.find((agent) => agent.name === task.agent)?.model ??
			inheritedModel,
	};
}

function emitParallelSubagentUpdate(
	onUpdate: OnUpdateCallback | undefined,
	results: SubagentResult[],
	makeDetails: SubagentDetailsFactory,
): void {
	if (!onUpdate) return;
	const running = results.filter((result) => result.status === "running" || result.status === "queued").length;
	const done = results.length - running;
	onUpdate({
		content: [{ type: "text", text: `Parallel: ${done}/${results.length} done, ${running} running...` }],
		details: makeDetails("parallel")([...results]),
	});
}

function formatParallelSubagentSummary(result: SubagentResult): string {
	const output = truncateParallelOutput(getResultOutput(result));
	const status = isFailedResult(result)
		? `failed${result.stopReason && result.stopReason !== "end" ? ` (${result.stopReason})` : ""}`
		: "completed";
	return `### [${result.agent}] ${status}\n\n${output}`;
}

async function executeParallelSubagents(
	params: SubagentToolInput,
	environment: SubagentExecutionEnvironment,
): Promise<SubagentToolExecutionResult> {
	const tasks = params.tasks ?? [];
	if (tasks.length > MAX_PARALLEL_TASKS) {
		return {
			content: [{ type: "text", text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
			details: environment.makeDetails("parallel")([]),
		};
	}
	const currentResults = tasks.map((task) =>
		createQueuedSubagentResult(task, environment.agents, environment.inheritedModel),
	);
	const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (task, index) => {
		const result = await runSingleAgent(
			environment.workspaceCwd,
			environment.agents,
			{ ...task, toolOperations: environment.workspaceOperations },
			environment.inheritedModel,
			environment.runner,
			undefined,
			environment.signal,
			(partial) => {
				const currentResult = partial.details?.results[0];
				if (!currentResult) return;
				currentResults[index] = currentResult;
				emitParallelSubagentUpdate(environment.onUpdate, currentResults, environment.makeDetails);
			},
			environment.makeDetails("parallel"),
			environment.resolveModelHintOption,
		);
		currentResults[index] = result;
		emitParallelSubagentUpdate(environment.onUpdate, currentResults, environment.makeDetails);
		return result;
	});
	const successCount = results.filter((result) => !isFailedResult(result)).length;
	const summaries = results.map(formatParallelSubagentSummary);
	return {
		content: [
			{
				type: "text",
				text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
			},
		],
		details: environment.makeDetails("parallel")(results),
	};
}

async function executeSingleSubagent(
	params: SubagentToolInput,
	environment: SubagentExecutionEnvironment,
): Promise<SubagentToolExecutionResult> {
	const result = await runSingleAgent(
		environment.workspaceCwd,
		environment.agents,
		{
			agent: params.agent,
			task: params.task ?? "",
			responseFormat: params.responseFormat,
			systemPrompt: params.systemPrompt,
			model: params.model,
			modelHint: params.modelHint,
			tools: params.tools,
			skills: params.skills,
			cwd: params.cwd,
			toolOperations: environment.workspaceOperations,
			continueSession: params.continueSession,
		},
		environment.inheritedModel,
		environment.runner,
		undefined,
		environment.signal,
		environment.onUpdate,
		environment.makeDetails("single"),
		environment.resolveModelHintOption,
	);
	if (isFailedResult(result)) {
		return {
			content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}` }],
			details: environment.makeDetails("single")([result]),
			isError: true,
		};
	}
	return {
		content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
		details: environment.makeDetails("single")([result]),
	};
}

function executeSelectedSubagentMode(
	params: SubagentToolInput,
	selection: SubagentModeSelection,
	environment: SubagentExecutionEnvironment,
): Promise<SubagentToolExecutionResult> {
	if (selection.hasChain) return executeSubagentChain(params, environment);
	if (selection.hasTasks) return executeParallelSubagents(params, environment);
	return executeSingleSubagent(params, environment);
}

function truncateSubagentCallTask(task: string, maxCharacters: number): string {
	return task.length > maxCharacters ? `${task.slice(0, maxCharacters)}...` : task;
}

function renderSubagentChainCall(args: SubagentToolInput, scope: AgentScope, theme: Theme): Text {
	const chain = args.chain ?? [];
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", `chain (${chain.length} steps)`) +
		theme.fg("muted", ` [${scope}]`);
	for (let index = 0; index < Math.min(chain.length, 3); index++) {
		const step = chain[index];
		const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
		const preview = truncateSubagentCallTask(cleanTask, 40);
		text +=
			"\n  " +
			theme.fg("muted", `${index + 1}.`) +
			" " +
			theme.fg("accent", step.agent ?? "ad-hoc") +
			theme.fg("muted", ` [${step.model ?? "parent model"}]`) +
			theme.fg("dim", ` ${preview}`);
	}
	if (chain.length > 3) text += `\n  ${theme.fg("muted", `... +${chain.length - 3} more`)}`;
	return new Text(text, 0, 0);
}

function renderParallelSubagentCall(args: SubagentToolInput, scope: AgentScope, theme: Theme): Text {
	const tasks = args.tasks ?? [];
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", `parallel (${tasks.length} tasks)`) +
		theme.fg("muted", ` [${scope}]`);
	for (const task of tasks.slice(0, 3)) {
		const preview = truncateSubagentCallTask(task.task, 40);
		text += `\n  ${theme.fg("accent", task.agent ?? "ad-hoc")}${theme.fg("muted", ` [${task.model ?? "parent model"}]`)}${theme.fg("dim", ` ${preview}`)}`;
	}
	if (tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${tasks.length - 3} more`)}`;
	return new Text(text, 0, 0);
}

function renderSingleSubagentCall(args: SubagentToolInput, scope: AgentScope, theme: Theme): Text {
	const agentName = args.agent || "ad-hoc";
	const preview = args.task ? truncateSubagentCallTask(args.task, 60) : "...";
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", agentName) +
		theme.fg("muted", ` [${scope}] [${args.model ?? "parent model"}]`);
	text += `\n  ${theme.fg("dim", preview)}`;
	return new Text(text, 0, 0);
}

interface SubagentStatusCounts {
	completed: number;
	failed: number;
	active: number;
}

function renderSubagentStatusIcon(status: SubagentStatus, theme: Theme): string {
	if (status === "queued") return theme.fg("muted", "[queued]");
	if (status === "running") return theme.fg("warning", "[running]");
	if (status === "failed") return theme.fg("error", "[failed]");
	return theme.fg("success", "[done]");
}

function renderSubagentModel(model: string | undefined, theme: Theme): string {
	return theme.fg("muted", ` [${model ?? "model pending"}]`);
}

function renderSubagentDisplayItems(items: DisplayItem[], expanded: boolean, theme: Theme, limit?: number): string {
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;
	let text = skipped > 0 ? theme.fg("muted", `... ${skipped} earlier items\n`) : "";
	for (const item of toShow) {
		if (item.type === "text") {
			const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
			text += `${theme.fg("toolOutput", preview)}\n`;
			continue;
		}
		text += `${theme.fg("muted", "-> ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
	}
	return text.trimEnd();
}

function aggregateSubagentUsage(results: SubagentResult[]): SubagentUsageDisplayMetrics {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const result of results) {
		total.input += result.usage.input;
		total.output += result.usage.output;
		total.cacheRead += result.usage.cacheRead;
		total.cacheWrite += result.usage.cacheWrite;
		total.cost += result.usage.cost;
		total.turns += result.usage.turns;
	}
	return total;
}

function countSubagentStatuses(results: SubagentResult[]): SubagentStatusCounts {
	const counts: SubagentStatusCounts = { completed: 0, failed: 0, active: 0 };
	for (const result of results) {
		if (result.status === "completed") counts.completed++;
		else if (result.status === "failed") counts.failed++;
		else counts.active++;
	}
	return counts;
}

function appendSubagentToolCalls(container: Container, items: DisplayItem[], theme: Theme): void {
	for (const item of items) {
		if (item.type !== "toolCall") continue;
		container.addChild(
			new Text(theme.fg("muted", "-> ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
		);
	}
}

function appendSubagentMarkdown(container: Container, output: string): void {
	if (!output) return;
	container.addChild(new Spacer(1));
	container.addChild(new Markdown(output.trim(), 0, 0, getMarkdownTheme()));
}

function appendSubagentUsage(
	container: Container,
	usage: SubagentUsageDisplayMetrics,
	theme: Theme,
	model?: string,
	prefix = "",
	withSpacer = false,
): void {
	const text = formatUsageStats(usage, model);
	if (!text) return;
	if (withSpacer) container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", `${prefix}${text}`), 0, 0));
}

function appendExpandedBatchResult(container: Container, result: SubagentResult, heading: string, theme: Theme): void {
	container.addChild(new Spacer(1));
	container.addChild(new Text(heading, 0, 0));
	container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", result.task), 0, 0));
	if (result.responseFormat) {
		container.addChild(
			new Text(theme.fg("muted", "Response format: ") + theme.fg("dim", result.responseFormat), 0, 0),
		);
	}
	appendSubagentToolCalls(container, getDisplayItems(result.messages), theme);
	appendSubagentMarkdown(container, getFinalOutput(result.messages));
	appendSubagentUsage(container, result.usage, theme, result.model);
}

function renderExpandedSingleSubagent(result: SubagentResult, theme: Theme): Container {
	const container = new Container();
	const failed = isFailedResult(result);
	let header = `${renderSubagentStatusIcon(result.status, theme)} ${theme.fg("toolTitle", theme.bold(result.agent))}${theme.fg("muted", ` (${result.agentSource})`)}${renderSubagentModel(result.model, theme)}`;
	if (failed && result.stopReason) header += ` ${theme.fg("error", `[${result.stopReason}]`)}`;
	container.addChild(new Text(header, 0, 0));
	if (failed && result.errorMessage) {
		container.addChild(new Text(theme.fg("error", `Error: ${result.errorMessage}`), 0, 0));
	}
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
	container.addChild(new Text(theme.fg("dim", result.task), 0, 0));
	if (result.responseFormat) {
		container.addChild(
			new Text(theme.fg("muted", "Response format: ") + theme.fg("dim", result.responseFormat), 0, 0),
		);
	}
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
	const displayItems = getDisplayItems(result.messages);
	const finalOutput = getFinalOutput(result.messages);
	if (displayItems.length === 0 && !finalOutput) {
		container.addChild(
			new Text(theme.fg("muted", result.status === "running" ? "(running...)" : "(no output)"), 0, 0),
		);
	} else {
		appendSubagentToolCalls(container, displayItems, theme);
		appendSubagentMarkdown(container, finalOutput);
	}
	appendSubagentUsage(container, result.usage, theme, result.model, "", true);
	return container;
}

function renderCollapsedSingleSubagent(result: SubagentResult, theme: Theme): Text {
	const failed = isFailedResult(result);
	const displayItems = getDisplayItems(result.messages);
	let text = `${renderSubagentStatusIcon(result.status, theme)} ${theme.fg("toolTitle", theme.bold(result.agent))}${theme.fg("muted", ` (${result.agentSource})`)}${renderSubagentModel(result.model, theme)}`;
	if (failed && result.stopReason) text += ` ${theme.fg("error", `[${result.stopReason}]`)}`;
	if (failed && result.errorMessage) text += `\n${theme.fg("error", `Error: ${result.errorMessage}`)}`;
	else if (displayItems.length === 0) {
		text += `\n${theme.fg("muted", result.status === "running" ? "(running...)" : "(no output)")}`;
	} else {
		text += `\n${renderSubagentDisplayItems(displayItems, false, theme, COLLAPSED_ITEM_COUNT)}`;
		if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	}
	const usage = formatUsageStats(result.usage, result.model);
	if (usage) text += `\n${theme.fg("dim", usage)}`;
	return new Text(text, 0, 0);
}

function renderSingleSubagentResult(result: SubagentResult, expanded: boolean, theme: Theme): Text | Container {
	return expanded ? renderExpandedSingleSubagent(result, theme) : renderCollapsedSingleSubagent(result, theme);
}

function renderExpandedSubagentChain(
	results: SubagentResult[],
	counts: SubagentStatusCounts,
	icon: string,
	theme: Theme,
): Container {
	const container = new Container();
	container.addChild(
		new Text(
			icon +
				" " +
				theme.fg("toolTitle", theme.bold("chain ")) +
				theme.fg("accent", `${counts.completed}/${results.length} steps`),
			0,
			0,
		),
	);
	for (const result of results) {
		const heading = `${theme.fg("muted", `─── Step ${result.step}: `) + theme.fg("accent", result.agent)}${renderSubagentModel(result.model, theme)} ${renderSubagentStatusIcon(result.status, theme)}`;
		appendExpandedBatchResult(container, result, heading, theme);
	}
	appendSubagentUsage(container, aggregateSubagentUsage(results), theme, undefined, "Total: ", true);
	return container;
}

function renderCollapsedSubagentChain(
	results: SubagentResult[],
	counts: SubagentStatusCounts,
	icon: string,
	theme: Theme,
): Text {
	let text =
		icon +
		" " +
		theme.fg("toolTitle", theme.bold("chain ")) +
		theme.fg("accent", `${counts.completed}/${results.length} steps`);
	for (const result of results) {
		const items = getDisplayItems(result.messages);
		text += `\n\n${theme.fg("muted", `─── Step ${result.step}: `)}${theme.fg("accent", result.agent)}${renderSubagentModel(result.model, theme)} ${renderSubagentStatusIcon(result.status, theme)}`;
		if (items.length === 0) {
			const empty =
				result.status === "running" || result.status === "queued" ? `(${result.status}...)` : "(no output)";
			text += `\n${theme.fg("muted", empty)}`;
		} else text += `\n${renderSubagentDisplayItems(items, false, theme, 5)}`;
	}
	const usage = formatUsageStats(aggregateSubagentUsage(results));
	if (usage) text += `\n\n${theme.fg("dim", `Total: ${usage}`)}`;
	text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

function renderSubagentChain(results: SubagentResult[], expanded: boolean, theme: Theme): Text | Container {
	const counts = countSubagentStatuses(results);
	const icon =
		counts.active > 0
			? theme.fg("warning", "[running]")
			: counts.failed > 0
				? theme.fg("error", "[failed]")
				: theme.fg("success", "[done]");
	return expanded
		? renderExpandedSubagentChain(results, counts, icon, theme)
		: renderCollapsedSubagentChain(results, counts, icon, theme);
}

function parallelSubagentStatus(counts: SubagentStatusCounts, total: number): string {
	return counts.active > 0
		? `${counts.completed + counts.failed}/${total} done, ${counts.active} running`
		: `${counts.completed}/${total} tasks`;
}

function renderExpandedParallelSubagents(
	results: SubagentResult[],
	icon: string,
	status: string,
	theme: Theme,
): Container {
	const container = new Container();
	container.addChild(
		new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0),
	);
	for (const result of results) {
		const heading = `${theme.fg("muted", "─── ") + theme.fg("accent", result.agent)}${renderSubagentModel(result.model, theme)} ${renderSubagentStatusIcon(result.status, theme)}`;
		appendExpandedBatchResult(container, result, heading, theme);
	}
	appendSubagentUsage(container, aggregateSubagentUsage(results), theme, undefined, "Total: ", true);
	return container;
}

function renderCollapsedParallelSubagents(
	results: SubagentResult[],
	expanded: boolean,
	counts: SubagentStatusCounts,
	icon: string,
	status: string,
	theme: Theme,
): Text {
	let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
	for (const result of results) {
		const items = getDisplayItems(result.messages);
		text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", result.agent)}${renderSubagentModel(result.model, theme)} ${renderSubagentStatusIcon(result.status, theme)}`;
		if (items.length === 0) {
			const empty =
				result.status === "running" || result.status === "queued" ? `(${result.status}...)` : "(no output)";
			text += `\n${theme.fg("muted", empty)}`;
		} else text += `\n${renderSubagentDisplayItems(items, expanded, theme, 5)}`;
	}
	if (counts.active === 0) {
		const usage = formatUsageStats(aggregateSubagentUsage(results));
		if (usage) text += `\n\n${theme.fg("dim", `Total: ${usage}`)}`;
	}
	if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

function renderParallelSubagents(results: SubagentResult[], expanded: boolean, theme: Theme): Text | Container {
	const counts = countSubagentStatuses(results);
	const icon =
		counts.active > 0
			? theme.fg("warning", "[running]")
			: counts.failed > 0
				? theme.fg("warning", "[partial]")
				: theme.fg("success", "[done]");
	const status = parallelSubagentStatus(counts, results.length);
	return expanded && counts.active === 0
		? renderExpandedParallelSubagents(results, icon, status, theme)
		: renderCollapsedParallelSubagents(results, expanded, counts, icon, status, theme);
}

function renderSubagentFallback(result: AgentToolResult<SubagentDetails>): Text {
	const content = result.content[0];
	return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
}

function renderSubagentResult(
	result: AgentToolResult<SubagentDetails>,
	expanded: boolean,
	theme: Theme,
): Text | Container {
	const details = result.details;
	if (!details || details.results.length === 0) return renderSubagentFallback(result);
	if (details.mode === "single" && details.results.length === 1) {
		return renderSingleSubagentResult(details.results[0], expanded, theme);
	}
	if (details.mode === "chain") return renderSubagentChain(details.results, expanded, theme);
	if (details.mode === "parallel") return renderParallelSubagents(details.results, expanded, theme);
	return renderSubagentFallback(result);
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
			const selection = selectSubagentMode(params);
			const agentScope: AgentScope = params.agentScope ?? "user";
			const workspaceOperations = ctx.toolOperations;
			if (!workspaceOperations) {
				return {
					content: [{ type: "text", text: "Subagents require explicit workspace tool operations." }],
					details: { mode: selection.mode, agentScope, projectAgentsDir: null, results: [] },
					isError: true,
				};
			}
			const backendInfo = workspaceOperations.getBackendInfo?.();
			if (backendInfo?.type === "remote" && !backendInfo.configured) {
				return {
					content: [{ type: "text", text: "Subagents cannot run with an unconfigured remote backend." }],
					details: { mode: selection.mode, agentScope, projectAgentsDir: null, results: [] },
					isError: true,
				};
			}
			const workspaceCwd = workspaceOperations.cwd ?? ctx.cwd;
			const discovery = await discoverAgentsWithOperations(workspaceCwd, agentScope, workspaceOperations);
			const agents = mergeSessionAgents(discovery.agents, options.configRegistry?.list() ?? []);
			const makeDetails = createSubagentDetailsFactory(agentScope, discovery.projectAgentsDir);
			const validationError = validateSubagentRequest(params, selection, agents, makeDetails);
			if (validationError) return validationError;
			if (!runner) {
				return {
					content: [{ type: "text", text: "Subagent runner is not configured for this session." }],
					details: makeDetails(selection.mode)([]),
					isError: true,
				};
			}
			const authorizationError = await authorizeProjectAgents(
				params,
				agentScope,
				agents,
				discovery.projectAgentsDir,
				options.trustProjectAgents,
				ctx,
				makeDetails,
				selection.mode,
			);
			if (authorizationError) return authorizationError;
			return executeSelectedSubagentMode(params, selection, {
				agents,
				workspaceCwd,
				workspaceOperations,
				inheritedModel: inheritedSubagentModelName(ctx.model),
				runner,
				signal,
				onUpdate,
				makeDetails,
				resolveModelHintOption: options.resolveModelHint,
			});
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) return renderSubagentChainCall(args, scope, theme);
			if (args.tasks && args.tasks.length > 0) return renderParallelSubagentCall(args, scope, theme);
			return renderSingleSubagentCall(args, scope, theme);
		},

		renderResult(result, { expanded }, theme, _context) {
			return renderSubagentResult(result, expanded, theme);
		},
	};
}
export function createSubagentRunsTool(
	registry?: SubagentRunRegistry,
): AgentTool<typeof subagentRunsParamsSchema, SubagentRunsDetails> {
	return wrapToolDefinition(createSubagentRunsToolDefinition(registry));
}

export function createCreateSubagentTool(
	registry?: SubagentConfigRegistry,
): AgentTool<typeof createSubagentConfigParamsSchema, CreateSubagentDetails> {
	return wrapToolDefinition(createCreateSubagentToolDefinition(registry));
}

export function createSubagentTool(
	options?: SubagentToolOptions,
): AgentTool<typeof subagentParamsSchema, SubagentDetails> {
	return wrapToolDefinition(createSubagentToolDefinition(options));
}
