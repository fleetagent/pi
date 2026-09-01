/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@fleetagent/pi-ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();
	const state: DetachedAgentStreamState = { messages: [] };

	void runAgentLoop(prompts, context, config, createDetachedEventSink(stream, state), signal, streamFn).then(
		(messages) => stream.end(messages),
		(error: unknown) => terminateDetachedAgentStream(stream, state, config, error),
	);

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();
	const state: DetachedAgentStreamState = { messages: [] };

	void runAgentLoopContinue(context, config, createDetachedEventSink(stream, state), signal, streamFn).then(
		(messages) => stream.end(messages),
		(error: unknown) => terminateDetachedAgentStream(stream, state, config, error),
	);

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context, messages: [...context.messages] };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

interface DetachedAgentStreamState {
	messages: AgentMessage[];
	activeAssistant?: AssistantMessage;
	turnOpen?: boolean;
}

function createDetachedEventSink(
	stream: EventStream<AgentEvent, AgentMessage[]>,
	state: DetachedAgentStreamState,
): AgentEventSink {
	return (event) => {
		if (event.type === "turn_start") {
			state.turnOpen = true;
		} else if (event.type === "turn_end") {
			state.turnOpen = false;
		} else if (event.type === "message_start" && event.message.role === "assistant") {
			state.activeAssistant = event.message;
		} else if (event.type === "message_update" && event.message.role === "assistant") {
			state.activeAssistant = event.message;
		} else if (event.type === "message_end") {
			state.messages.push(event.message);
			if (event.message.role === "assistant") state.activeAssistant = undefined;
		}
		stream.push(event);
	};
}

function terminateDetachedAgentStream(
	stream: EventStream<AgentEvent, AgentMessage[]>,
	state: DetachedAgentStreamState,
	config: AgentLoopConfig,
	error: unknown,
): void {
	const errorMessage = error instanceof Error ? error.message : String(error);
	const message: AssistantMessage = state.activeAssistant
		? { ...state.activeAssistant, stopReason: "error", errorMessage }
		: {
				role: "assistant",
				content: [],
				api: config.model.api,
				provider: config.model.provider,
				model: config.model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage,
				timestamp: Date.now(),
			};
	if (!state.turnOpen) {
		stream.push({ type: "turn_start" });
		state.turnOpen = true;
	}
	state.messages.push(message);
	if (!state.activeAssistant) stream.push({ type: "message_start", message });
	stream.push({ type: "message_end", message });
	stream.push({ type: "turn_end", message, toolResults: [] });
	state.turnOpen = false;
	stream.push({ type: "agent_end", messages: [...state.messages] });
}

interface AgentLoopRuntimeState {
	context: AgentContext;
	config: AgentLoopConfig;
}

interface AgentLoopExecution {
	newMessages: AgentMessage[];
	signal: AbortSignal | undefined;
	emit: AgentEventSink;
	streamFn: StreamFn | undefined;
}

interface TurnSequenceResult {
	state: AgentLoopRuntimeState;
	firstTurn: boolean;
	terminated: boolean;
}

interface AssistantTurnResult {
	terminated: boolean;
	message: AssistantMessage;
	toolResults: ToolResultMessage[];
	hasMoreToolCalls: boolean;
}

async function emitSubsequentTurnStart(firstTurn: boolean, emit: AgentEventSink): Promise<void> {
	if (!firstTurn) await emit({ type: "turn_start" });
}

async function injectPendingMessages(
	pendingMessages: AgentMessage[],
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	emit: AgentEventSink,
): Promise<void> {
	for (const message of pendingMessages) {
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
		currentContext.messages.push(message);
		newMessages.push(message);
	}
}

async function executeAssistantTurn(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantTurnResult> {
	const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
	newMessages.push(message);
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		await emit({ type: "turn_end", message, toolResults: [] });
		await emit({ type: "agent_end", messages: newMessages });
		return { terminated: true, message, toolResults: [], hasMoreToolCalls: false };
	}

	const toolCalls = message.content.filter((content) => content.type === "toolCall");
	const toolResults: ToolResultMessage[] = [];
	let hasMoreToolCalls = false;
	if (toolCalls.length > 0) {
		const executedToolBatch = await executeToolCalls(currentContext, message, config, signal, emit);
		toolResults.push(...executedToolBatch.messages);
		hasMoreToolCalls = !executedToolBatch.terminate;
		for (const result of toolResults) {
			currentContext.messages.push(result);
			newMessages.push(result);
		}
	}
	await emit({ type: "turn_end", message, toolResults });
	return { terminated: false, message, toolResults, hasMoreToolCalls };
}

function applyNextTurnUpdate(
	context: AgentContext,
	config: AgentLoopConfig,
	update: AgentLoopTurnUpdate | undefined,
): AgentLoopRuntimeState {
	if (!update) return { context, config };
	const nextContext = update.context ? { ...update.context, messages: [...update.context.messages] } : context;
	const reasoning =
		update.thinkingLevel === undefined
			? config.reasoning
			: update.thinkingLevel === "off"
				? undefined
				: update.thinkingLevel;
	return {
		context: nextContext,
		config: { ...config, model: update.model ?? config.model, reasoning },
	};
}

async function prepareFollowingTurn(
	turn: AssistantTurnResult,
	context: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
): Promise<AgentLoopRuntimeState> {
	const update = await config.prepareNextTurn?.({
		message: turn.message,
		toolResults: turn.toolResults,
		context,
		newMessages,
	});
	return applyNextTurnUpdate(context, config, update);
}

async function shouldStopAfterCompletedTurn(
	turn: AssistantTurnResult,
	context: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
): Promise<boolean> {
	return (
		(await config.shouldStopAfterTurn?.({
			message: turn.message,
			toolResults: turn.toolResults,
			context,
			newMessages,
		})) ?? false
	);
}

async function runTurnSequence(
	initialState: AgentLoopRuntimeState,
	initialPendingMessages: AgentMessage[],
	firstTurn: boolean,
	execution: AgentLoopExecution,
): Promise<TurnSequenceResult> {
	let state = initialState;
	let pendingMessages = initialPendingMessages;
	let hasMoreToolCalls = true;
	while (hasMoreToolCalls || pendingMessages.length > 0) {
		await emitSubsequentTurnStart(firstTurn, execution.emit);
		firstTurn = false;
		await injectPendingMessages(pendingMessages, state.context, execution.newMessages, execution.emit);
		pendingMessages = [];

		const turn = await executeAssistantTurn(
			state.context,
			execution.newMessages,
			state.config,
			execution.signal,
			execution.emit,
			execution.streamFn,
		);
		if (turn.terminated) return { state, firstTurn, terminated: true };
		hasMoreToolCalls = turn.hasMoreToolCalls;
		state = await prepareFollowingTurn(turn, state.context, execution.newMessages, state.config);
		if (await shouldStopAfterCompletedTurn(turn, state.context, execution.newMessages, state.config)) {
			await execution.emit({ type: "agent_end", messages: execution.newMessages });
			return { state, firstTurn, terminated: true };
		}
		pendingMessages = (await state.config.getSteeringMessages?.()) || [];
	}
	return { state, firstTurn, terminated: false };
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	let state: AgentLoopRuntimeState = { context: initialContext, config: initialConfig };
	let firstTurn = true;
	let pendingMessages: AgentMessage[] = (await state.config.getSteeringMessages?.()) || [];
	const execution: AgentLoopExecution = { newMessages, signal, emit, streamFn };

	while (true) {
		const sequence = await runTurnSequence(state, pendingMessages, firstTurn, execution);
		if (sequence.terminated) return;
		state = sequence.state;
		firstTurn = sequence.firstTurn;

		const followUpMessages = (await state.config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length === 0) break;
		pendingMessages = followUpMessages;
	}
	await emit({ type: "agent_end", messages: newMessages });
}

async function finalizeAssistantResponse(
	response: AssistantMessageEventStream,
	context: AgentContext,
	addedPartial: boolean,
	emit: AgentEventSink,
): Promise<AssistantMessage> {
	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

async function consumeAssistantResponse(
	response: AssistantMessageEventStream,
	context: AgentContext,
	emit: AgentEventSink,
): Promise<AssistantMessage> {
	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;
	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;
			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;
			case "done":
			case "error":
				return await finalizeAssistantResponse(response, context, addedPartial, emit);
		}
	}
	return await finalizeAssistantResponse(response, context, addedPartial, emit);
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});
	return await consumeAssistantResponse(response, context, emit);
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const toolsByName = new Map<string, AgentTool<any>>();
	for (const tool of currentContext.tools ?? []) {
		if (!toolsByName.has(tool.name)) toolsByName.set(tool.name, tool);
	}
	const hasSequentialToolCall = toolCalls.some(
		(toolCall) => toolsByName.get(toolCall.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
				if (beforeResult.terminate === true) {
					result.terminate = true;
				}
				return {
					kind: "immediate",
					result,
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	let updateEvents = Promise.resolve();

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				updateEvents = updateEvents.then(() =>
					emit({
						type: "tool_execution_update",
						toolCallId: prepared.toolCall.id,
						toolName: prepared.toolCall.name,
						args: prepared.toolCall.arguments,
						partialResult,
					}),
				);
			},
		);
		await updateEvents;
		return { result, isError: false };
	} catch (error) {
		await updateEvents;
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				result = {
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools can omit content; never let nullish values enter history or provider payloads.
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
