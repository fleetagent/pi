/**
 * Custom Provider Example
 *
 * Demonstrates registering a custom provider with:
 * - Custom API identifier ("custom-anthropic-api")
 * - Custom streamSimple implementation
 * - OAuth support for /login
 * - API key support via environment variable
 * - Two model definitions
 *
 * Usage:
 *   # First install dependencies
 *   cd packages/coding-agent/examples/extensions/custom-provider && npm install
 *
 *   # With OAuth (run /login custom-anthropic first)
 *   pi -e ./packages/coding-agent/examples/extensions/custom-provider
 *
 *   # With API key
 *   CUSTOM_ANTHROPIC_API_KEY=sk-ant-... pi -e ./packages/coding-agent/examples/extensions/custom-provider
 *
 * Then use /model to select custom-anthropic/claude-sonnet-4-5
 */

import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import type {
	Usage as AnthropicUsage,
	ContentBlockParam,
	ImageBlockParam,
	MessageCreateParamsStreaming,
	MessageDeltaUsage,
	MessageParam,
	RawContentBlockDeltaEvent,
	RawContentBlockStartEvent,
	RawContentBlockStopEvent,
	RawMessageDeltaEvent,
	RawMessageStartEvent,
	RawMessageStreamEvent,
	TextBlockParam,
	ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	calculateCost,
	createAssistantMessageEventStream,
	type ImageContent,
	type Message,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type PKCEPair,
	type SimpleStreamOptions,
	type StopReason,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
} from "@fleetagent/pi-ai";
import type { ExtensionAPI } from "@fleetagent/pi-coding-agent";

// =============================================================================
// OAuth Implementation (copied from packages/ai/src/utils/oauth/anthropic.ts)
// =============================================================================

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

async function generatePKCE(): Promise<PKCEPair> {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	const verifier = btoa(String.fromCharCode(...array))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hash = await crypto.subtle.digest("SHA-256", data);
	const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

	return { verifier, challenge };
}

async function loginAnthropic(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();

	const authParams = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: verifier,
	});

	callbacks.onAuth({ url: `${AUTHORIZE_URL}?${authParams.toString()}` });

	const authCode = await callbacks.onPrompt({ message: "Paste the authorization code:" });
	const [code, state] = authCode.split("#");

	const tokenResponse = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			state,
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
		}),
	});

	if (!tokenResponse.ok) {
		throw new Error(`Token exchange failed: ${await tokenResponse.text()}`);
	}

	const data = (await tokenResponse.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};

	return {
		refresh: data.refresh_token,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
}

async function refreshAnthropicToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: credentials.refresh,
		}),
	});

	if (!response.ok) {
		throw new Error(`Token refresh failed: ${await response.text()}`);
	}

	const data = (await response.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};

	return {
		refresh: data.refresh_token,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
}

// =============================================================================
// Streaming Implementation (simplified from packages/ai/src/providers/anthropic.ts)
// =============================================================================

// Claude Code tool names for OAuth stealth mode
const claudeCodeTools = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];
const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));
const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;
const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
	const lowerName = name.toLowerCase();
	const matched = tools?.find((t) => t.name.toLowerCase() === lowerName);
	return matched?.name ?? name;
};

function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

type AnthropicInputContent = string | Array<TextBlockParam | ImageBlockParam>;

function convertContentBlocks(content: (TextContent | ImageContent)[]): AnthropicInputContent {
	const hasImages = content.some((block) => block.type === "image");
	if (!hasImages) return sanitizeSurrogates(content.map((block) => (block as TextContent).text).join("\n"));
	const blocks: Array<TextBlockParam | ImageBlockParam> = content.map((block) => {
		if (block.type === "text") return { type: "text" as const, text: sanitizeSurrogates(block.text) };
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});
	if (!blocks.some((block) => block.type === "text")) {
		blocks.unshift({ type: "text" as const, text: "(see attached image)" });
	}
	return blocks;
}

function appendAnthropicUserMessage(params: MessageParam[], message: Message): void {
	if (message.role !== "user") return;
	if (typeof message.content === "string") {
		if (message.content.trim()) params.push({ role: "user", content: sanitizeSurrogates(message.content) });
		return;
	}
	const blocks: ContentBlockParam[] = message.content.map((item) =>
		item.type === "text"
			? { type: "text" as const, text: sanitizeSurrogates(item.text) }
			: {
					type: "image" as const,
					source: { type: "base64" as const, media_type: item.mimeType as any, data: item.data },
				},
	);
	if (blocks.length > 0) params.push({ role: "user", content: blocks });
}

function convertAnthropicAssistantBlocks(message: AssistantMessage, isOAuth: boolean): ContentBlockParam[] {
	const blocks: ContentBlockParam[] = [];
	for (const block of message.content) {
		if (block.type === "text" && block.text.trim()) {
			blocks.push({ type: "text", text: sanitizeSurrogates(block.text) });
		} else if (block.type === "thinking" && block.thinking.trim()) {
			if (block.thinkingSignature) {
				blocks.push({
					type: "thinking" as any,
					thinking: sanitizeSurrogates(block.thinking),
					signature: block.thinkingSignature,
				});
			} else {
				blocks.push({ type: "text", text: sanitizeSurrogates(block.thinking) });
			}
		} else if (block.type === "toolCall") {
			blocks.push({
				type: "tool_use",
				id: block.id,
				name: isOAuth ? toClaudeCodeName(block.name) : block.name,
				input: block.arguments,
			});
		}
	}
	return blocks;
}

function appendAnthropicAssistantMessage(params: MessageParam[], message: Message, isOAuth: boolean): void {
	if (message.role !== "assistant") return;
	const blocks = convertAnthropicAssistantBlocks(message, isOAuth);
	if (blocks.length > 0) params.push({ role: "assistant", content: blocks });
}

function convertAnthropicToolResult(message: ToolResultMessage): ToolResultBlockParam {
	return {
		type: "tool_result",
		tool_use_id: message.toolCallId,
		content: convertContentBlocks(message.content),
		is_error: message.isError,
	};
}

function appendAnthropicToolResultBatch(params: MessageParam[], messages: Message[], startIndex: number): number {
	const firstMessage = messages[startIndex];
	if (firstMessage.role !== "toolResult") return startIndex;
	const toolResults: ToolResultBlockParam[] = [convertAnthropicToolResult(firstMessage)];
	let nextIndex = startIndex + 1;
	while (nextIndex < messages.length && messages[nextIndex].role === "toolResult") {
		toolResults.push(convertAnthropicToolResult(messages[nextIndex] as ToolResultMessage));
		nextIndex++;
	}
	params.push({ role: "user", content: toolResults });
	return nextIndex - 1;
}

function applyAnthropicCacheBreakpoint(params: MessageParam[]): void {
	const last = params.at(-1);
	if (last?.role !== "user" || !Array.isArray(last.content)) return;
	const lastBlock = last.content.at(-1);
	if (lastBlock) Object.assign(lastBlock, { cache_control: { type: "ephemeral" } });
}

function convertMessages(messages: Message[], isOAuth: boolean, _tools?: Tool[]): MessageParam[] {
	const params: MessageParam[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "user") {
			appendAnthropicUserMessage(params, message);
			continue;
		}
		if (message.role === "assistant") {
			appendAnthropicAssistantMessage(params, message, isOAuth);
			continue;
		}
		index = appendAnthropicToolResultBatch(params, messages, index);
	}
	applyAnthropicCacheBreakpoint(params);
	return params;
}

function convertTools(tools: Tool[], isOAuth: boolean): any[] {
	return tools.map((tool) => ({
		name: isOAuth ? toClaudeCodeName(tool.name) : tool.name,
		description: tool.description,
		input_schema: {
			type: "object",
			properties: (tool.parameters as any).properties || {},
			required: (tool.parameters as any).required || [],
		},
	}));
}

function mapStopReason(reason: string): StopReason {
	switch (reason) {
		case "end_turn":
		case "pause_turn":
		case "stop_sequence":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		default:
			return "error";
	}
}

type StreamingAnthropicBlock =
	| (TextContent & { index: number })
	| (ThinkingContent & { index: number })
	| (ToolCall & { partialJson: string; index: number });

interface AnthropicStreamingState {
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	blocks: StreamingAnthropicBlock[];
	contentIndexByEventIndex: Map<number, number>;
	model: Model<Api>;
	isOAuth: boolean;
	tools: Tool[] | undefined;
}

const DEFAULT_THINKING_BUDGETS: Record<string, number> = {
	minimal: 1024,
	low: 4096,
	medium: 10240,
	high: 20480,
};

function createAnthropicOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createAnthropicClientOptions(model: Model<Api>, apiKey: string, isOAuth: boolean): ClientOptions {
	const betaFeatures = ["fine-grained-tool-streaming-2025-05-14", "interleaved-thinking-2025-05-14"];
	if (isOAuth) {
		return {
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			apiKey: null,
			authToken: apiKey,
			defaultHeaders: {
				accept: "application/json",
				"anthropic-dangerous-direct-browser-access": "true",
				"anthropic-beta": `claude-code-20250219,oauth-2025-04-20,${betaFeatures.join(",")}`,
				"user-agent": "claude-cli/2.1.2 (external, cli)",
				"x-app": "cli",
			},
		};
	}
	return {
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		apiKey,
		defaultHeaders: {
			accept: "application/json",
			"anthropic-dangerous-direct-browser-access": "true",
			"anthropic-beta": betaFeatures.join(","),
		},
	};
}

function buildAnthropicSystemPrompt(systemPrompt: string | undefined, isOAuth: boolean): TextBlockParam[] | undefined {
	if (isOAuth) {
		const system: TextBlockParam[] = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				cache_control: { type: "ephemeral" },
			},
		];
		if (systemPrompt) {
			system.push({
				type: "text",
				text: sanitizeSurrogates(systemPrompt),
				cache_control: { type: "ephemeral" },
			});
		}
		return system;
	}
	if (!systemPrompt) return undefined;
	return [
		{
			type: "text",
			text: sanitizeSurrogates(systemPrompt),
			cache_control: { type: "ephemeral" },
		},
	];
}

function buildAnthropicRequestParams(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	isOAuth: boolean,
): MessageCreateParamsStreaming {
	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages: convertMessages(context.messages, isOAuth, context.tools),
		max_tokens: options?.maxTokens || Math.floor(model.maxTokens / 3),
		stream: true,
	};
	const system = buildAnthropicSystemPrompt(context.systemPrompt, isOAuth);
	if (system) params.system = system;
	if (context.tools) params.tools = convertTools(context.tools, isOAuth);
	if (options?.reasoning && model.reasoning) {
		const customBudget = options.thinkingBudgets?.[options.reasoning as keyof typeof options.thinkingBudgets];
		params.thinking = {
			type: "enabled",
			budget_tokens: customBudget ?? DEFAULT_THINKING_BUDGETS[options.reasoning] ?? 10240,
		};
	}
	return params;
}

function updateAnthropicUsage(state: AnthropicStreamingState, usage: AnthropicUsage | MessageDeltaUsage): void {
	state.output.usage.input = usage.input_tokens || 0;
	state.output.usage.output = usage.output_tokens || 0;
	state.output.usage.cacheRead = usage.cache_read_input_tokens || 0;
	state.output.usage.cacheWrite = usage.cache_creation_input_tokens || 0;
	state.output.usage.totalTokens =
		state.output.usage.input +
		state.output.usage.output +
		state.output.usage.cacheRead +
		state.output.usage.cacheWrite;
	calculateCost(state.model, state.output.usage);
}

function handleAnthropicMessageStart(event: RawMessageStartEvent, state: AnthropicStreamingState): void {
	updateAnthropicUsage(state, event.message.usage);
}

function handleAnthropicContentBlockStart(event: RawContentBlockStartEvent, state: AnthropicStreamingState): void {
	let block: StreamingAnthropicBlock;
	if (event.content_block.type === "text") {
		block = { type: "text", text: "", index: event.index };
	} else if (event.content_block.type === "thinking") {
		block = { type: "thinking", thinking: "", thinkingSignature: "", index: event.index };
	} else if (event.content_block.type === "tool_use") {
		block = {
			type: "toolCall",
			id: event.content_block.id,
			name: state.isOAuth ? fromClaudeCodeName(event.content_block.name, state.tools) : event.content_block.name,
			arguments: {},
			partialJson: "",
			index: event.index,
		};
	} else {
		return;
	}

	state.output.content.push(block);
	const contentIndex = state.output.content.length - 1;
	if (!state.contentIndexByEventIndex.has(event.index)) {
		state.contentIndexByEventIndex.set(event.index, contentIndex);
	}
	if (block.type === "text") {
		state.stream.push({ type: "text_start", contentIndex, partial: state.output });
	} else if (block.type === "thinking") {
		state.stream.push({ type: "thinking_start", contentIndex, partial: state.output });
	} else {
		state.stream.push({ type: "toolcall_start", contentIndex, partial: state.output });
	}
}

function handleAnthropicContentBlockDelta(event: RawContentBlockDeltaEvent, state: AnthropicStreamingState): void {
	const contentIndex = state.contentIndexByEventIndex.get(event.index);
	if (contentIndex === undefined) return;
	const block = state.blocks[contentIndex];
	if (!block) return;

	if (event.delta.type === "text_delta" && block.type === "text") {
		block.text += event.delta.text;
		state.stream.push({
			type: "text_delta",
			contentIndex,
			delta: event.delta.text,
			partial: state.output,
		});
	} else if (event.delta.type === "thinking_delta" && block.type === "thinking") {
		block.thinking += event.delta.thinking;
		state.stream.push({
			type: "thinking_delta",
			contentIndex,
			delta: event.delta.thinking,
			partial: state.output,
		});
	} else if (event.delta.type === "input_json_delta" && block.type === "toolCall") {
		block.partialJson += event.delta.partial_json;
		try {
			block.arguments = JSON.parse(block.partialJson);
		} catch {}
		state.stream.push({
			type: "toolcall_delta",
			contentIndex,
			delta: event.delta.partial_json,
			partial: state.output,
		});
	} else if (event.delta.type === "signature_delta" && block.type === "thinking") {
		block.thinkingSignature = (block.thinkingSignature || "") + event.delta.signature;
	}
}

function handleAnthropicContentBlockStop(event: RawContentBlockStopEvent, state: AnthropicStreamingState): void {
	const contentIndex = state.contentIndexByEventIndex.get(event.index);
	if (contentIndex === undefined) return;
	state.contentIndexByEventIndex.delete(event.index);
	const block = state.blocks[contentIndex];
	if (!block) return;

	Reflect.deleteProperty(block, "index");
	if (block.type === "text") {
		state.stream.push({ type: "text_end", contentIndex, content: block.text, partial: state.output });
	} else if (block.type === "thinking") {
		state.stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: state.output });
	} else {
		try {
			block.arguments = JSON.parse(block.partialJson);
		} catch {}
		Reflect.deleteProperty(block, "partialJson");
		state.stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: state.output });
	}
}

function handleAnthropicMessageDelta(event: RawMessageDeltaEvent, state: AnthropicStreamingState): void {
	if (event.delta.stop_reason) state.output.stopReason = mapStopReason(event.delta.stop_reason);
	updateAnthropicUsage(state, event.usage);
}

function handleAnthropicStreamEvent(event: RawMessageStreamEvent, state: AnthropicStreamingState): void {
	switch (event.type) {
		case "message_start":
			handleAnthropicMessageStart(event, state);
			break;
		case "content_block_start":
			handleAnthropicContentBlockStart(event, state);
			break;
		case "content_block_delta":
			handleAnthropicContentBlockDelta(event, state);
			break;
		case "content_block_stop":
			handleAnthropicContentBlockStop(event, state);
			break;
		case "message_delta":
			handleAnthropicMessageDelta(event, state);
			break;
		case "message_stop":
			break;
	}
}

function failAnthropicStream(
	error: unknown,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	options: SimpleStreamOptions | undefined,
): void {
	for (const block of output.content) Reflect.deleteProperty(block, "index");
	output.stopReason = options?.signal?.aborted ? "aborted" : "error";
	output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
	stream.push({ type: "error", reason: output.stopReason, error: output });
	stream.end();
}

async function runCustomAnthropicStream(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): Promise<void> {
	try {
		const apiKey = options?.apiKey ?? "";
		const isOAuth = isOAuthToken(apiKey);
		const client = new Anthropic(createAnthropicClientOptions(model, apiKey, isOAuth));
		const params = buildAnthropicRequestParams(model, context, options, isOAuth);
		const anthropicStream = client.messages.stream({ ...params }, { signal: options?.signal });
		const state: AnthropicStreamingState = {
			output,
			stream,
			blocks: output.content as StreamingAnthropicBlock[],
			contentIndexByEventIndex: new Map(),
			model,
			isOAuth,
			tools: context.tools,
		};

		stream.push({ type: "start", partial: output });
		for await (const event of anthropicStream) handleAnthropicStreamEvent(event, state);
		if (options?.signal?.aborted) throw new Error("Request was aborted");
		stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
		stream.end();
	} catch (error) {
		failAnthropicStream(error, output, stream, options);
	}
}

function streamCustomAnthropic(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output = createAnthropicOutput(model);
	void runCustomAnthropicStream(model, context, options, output, stream);
	return stream;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerProvider("custom-anthropic", {
		baseUrl: "https://api.anthropic.com",
		apiKey: "$CUSTOM_ANTHROPIC_API_KEY",
		api: "custom-anthropic-api",

		models: [
			{
				id: "claude-opus-4-5",
				name: "Claude Opus 4.5 (Custom)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
				contextWindow: 200000,
				maxTokens: 64000,
			},
			{
				id: "claude-sonnet-4-5",
				name: "Claude Sonnet 4.5 (Custom)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200000,
				maxTokens: 64000,
			},
		],

		oauth: {
			name: "Custom Anthropic (Claude Pro/Max)",
			login: loginAnthropic,
			refreshToken: refreshAnthropicToken,
			getApiKey: (cred) => cred.access,
		},

		streamSimple: streamCustomAnthropic,
	});
}
