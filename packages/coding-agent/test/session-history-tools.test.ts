import type { AgentToolResult } from "@fleetagent/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	type Message,
	type TextContent,
	validateToolArguments,
} from "@fleetagent/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	COMPRESSION_ECONOMICS_ENTRY_TYPE,
	estimateCompressionEconomics,
	estimateCompressionSavings,
} from "../src/core/compaction/compression-economics.ts";
import { STRUCTURED_RESPONSE_INTERNAL_CUSTOM_TYPE } from "../src/core/messages.ts";
import { buildSessionContext, projectSessionContextEntries } from "../src/core/session/context.ts";
import type { SessionEntry } from "../src/core/session/types.ts";
import type {
	SessionEntryGetToolDetails,
	SessionHistoryToolName,
	SessionSearchToolDetails,
} from "../src/core/tools/session-history.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

function textOutput(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((content): content is TextContent => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

async function executeTool(
	harness: Harness,
	name: SessionHistoryToolName | "compress_context",
	arguments_: Record<string, unknown>,
	toolCallId = `test-${name}`,
): Promise<AgentToolResult<unknown>> {
	const tool = harness.session.agent.state.tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Missing active tool: ${name}`);
	const prepared = tool.prepareArguments?.(arguments_) ?? arguments_;
	const validated = validateToolArguments(tool, {
		type: "toolCall",
		id: toolCallId,
		name,
		arguments: prepared,
	});
	return tool.execute(toolCallId, validated, undefined, undefined);
}

describe("session history tools", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function harness(): Promise<Harness> {
		const created = await createHarness();
		harnesses.push(created);
		return created;
	}

	it("registers session tools as active host-owned built-ins", async () => {
		const created = await harness();
		expect(created.session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["session_search", "session_entry_get", "compress_context"]),
		);
		expect(created.session.getAllTools().find((tool) => tool.name === "compress_context")?.sourceInfo).toMatchObject({
			path: "<builtin:compress_context>",
			source: "builtin",
		});
	});

	it("exposes user and tool-result entry IDs without utilization only to the model", async () => {
		const created = await harness();
		const providerContexts: Message[][] = [];
		created.setResponses([
			(context) => {
				providerContexts.push(context.messages);
				return fauxAssistantMessage(
					[
						fauxToolCall("session_search", { pattern: "metadata", fixedStrings: true }),
						fauxToolCall("session_entry_get", { entryId: "missing" }),
					],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				providerContexts.push(context.messages);
				return fauxAssistantMessage("done");
			},
		]);
		await created.session.prompt("inspect metadata");
		const branch = created.sessionManager.getBranch();
		const userId = branch.find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
		const assistantId = branch.find((entry) => entry.type === "message" && entry.message.role === "assistant")?.id;
		const resultIds = branch
			.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
			.map((entry) => entry.id);
		const firstRequest = JSON.stringify(providerContexts[0]);
		const secondRequest = JSON.stringify(providerContexts[1]);
		if (!userId || !assistantId) throw new Error("Missing persisted message entries");
		expect(firstRequest).toContain(`user entry ${userId}`);
		expect(firstRequest).not.toContain("context ~");
		expect(secondRequest).not.toContain("context ~");
		expect(secondRequest).toContain(`assistant entry ${assistantId}`);
		for (const resultId of resultIds) expect(secondRequest).toContain(`result entry ${resultId}`);
		const resultIndexes = providerContexts[1].flatMap((message, index) =>
			message.role === "toolResult" ? [index] : [],
		);
		const noticeIndex = providerContexts[1].findIndex(
			(message) => message.role === "user" && JSON.stringify(message).includes("assistant entry"),
		);
		expect(resultIndexes).toHaveLength(2);
		expect(noticeIndex).toBeGreaterThan(resultIndexes[1]);
		expect(branch.some((entry) => entry.type === "custom_message" && entry.customType === "context_metadata")).toBe(
			false,
		);
		expect(
			created.session.messages.some(
				(message) => message.role === "custom" && message.customType === "context_metadata",
			),
		).toBe(false);
	});

	it("omits model-only context notices when the compression tool is inactive", async () => {
		const created = await createHarness({ tools: [] });
		harnesses.push(created);
		let providerMessages: Message[] = [];
		created.setResponses([
			(context) => {
				providerMessages = context.messages;
				return fauxAssistantMessage("done");
			},
		]);
		await created.session.prompt("no compression tool");
		expect(created.session.getActiveToolNames()).not.toContain("compress_context");
		expect(JSON.stringify(providerMessages)).not.toContain("context metadata:");
	});

	it("keeps entry ID notices without utilization after compaction", async () => {
		const created = await harness();
		const kept = created.sessionManager.appendMessage({ role: "user", content: "kept", timestamp: 1 });
		created.sessionManager.appendCompaction("previous work", kept, 200);
		created.session.agent.state.messages = created.sessionManager.buildSessionContext().messages;
		let providerMessages: Message[] = [];
		created.setResponses([
			(context) => {
				providerMessages = context.messages;
				return fauxAssistantMessage("done");
			},
		]);
		await created.session.prompt("after compaction");
		expect(JSON.stringify(providerMessages)).toContain("user entry");
		expect(JSON.stringify(providerMessages)).not.toContain("context ~");
	});

	it("searches current model context by default and compacted branch history explicitly", async () => {
		const created = await harness();
		const rootId = created.sessionManager.appendMessage({
			role: "user",
			content: "Original decision\nINCIDENT-42 uses host networking",
			timestamp: 1,
		});
		created.sessionManager.appendMessage({
			role: "user",
			content: "abandoned branch value",
			timestamp: 2,
		});
		created.sessionManager.branch(rootId);
		const currentId = created.sessionManager.appendMessage({
			role: "user",
			content: "Current exact value foo123",
			timestamp: 3,
		});
		created.sessionManager.appendCompaction("Earlier work was summarized", currentId, 50_000);

		const result = await executeTool(created, "session_search", {
			pattern: "INCIDENT-\\d+|foo\\d+",
			beforeContext: 1,
		});
		const details = result.details as SessionSearchToolDetails;
		expect(details.scope).toBe("context");
		expect(details.matchCount).toBe(1);
		expect(details.matches.map((match) => match.entryId)).toEqual([currentId]);
		const branchResult = await executeTool(created, "session_search", {
			pattern: "INCIDENT-\\d+|foo\\d+",
			beforeContext: 1,
			scope: "branch",
		});
		expect((branchResult.details as SessionSearchToolDetails).matches.map((match) => match.entryId)).toEqual([
			rootId,
			currentId,
		]);
		expect(textOutput(branchResult)).toContain("1-role: user");
		expect(textOutput(result)).not.toContain("abandoned branch value");
	});

	it("supports fixed-string, case-insensitive, and all-branch searches", async () => {
		const created = await harness();
		const rootId = created.sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const abandonedId = created.sessionManager.appendMessage({
			role: "user",
			content: "Abandoned [Literal] Value",
			timestamp: 2,
		});
		created.sessionManager.branch(rootId);
		created.sessionManager.appendMessage({ role: "user", content: "current", timestamp: 3 });

		const branchResult = await executeTool(created, "session_search", {
			pattern: "[literal]",
			fixedStrings: true,
			ignoreCase: true,
		});
		expect((branchResult.details as SessionSearchToolDetails).matchCount).toBe(0);

		const allResult = await executeTool(created, "session_search", {
			pattern: "[literal]",
			fixedStrings: true,
			ignoreCase: true,
			scope: "all",
		});
		expect((allResult.details as SessionSearchToolDetails).matches[0]?.entryId).toBe(abandonedId);
	});

	it("rejects malformed regular expressions", async () => {
		const created = await harness();
		await expect(executeTool(created, "session_search", { pattern: "(" })).rejects.toThrow(
			"Invalid session_search regular expression",
		);
	});

	it("terminates pathological regular expressions outside the main event loop", async () => {
		const created = await harness();
		created.sessionManager.appendMessage({
			role: "user",
			content: `${"a".repeat(500)}!`,
			timestamp: 1,
		});
		await expect(executeTool(created, "session_search", { pattern: "(a+)+$" })).rejects.toThrow(
			"session_search regular expression exceeded",
		);
	});

	it("does not search synthetic truncation annotations", async () => {
		const created = await harness();
		created.sessionManager.appendMessage({ role: "user", content: "x".repeat(10_001), timestamp: 1 });
		const result = await executeTool(created, "session_search", { pattern: "truncated", fixedStrings: true });
		const details = result.details as SessionSearchToolDetails;
		expect(details.matchCount).toBe(0);
		expect(details.scanTruncated).toBe(true);
	});

	it("does not match its own assistant tool call", async () => {
		const created = await harness();
		const toolCall = fauxToolCall("session_search", { pattern: "self-only-pattern" });
		created.sessionManager.appendMessage(fauxAssistantMessage(toolCall, { stopReason: "toolUse" }));

		const result = await executeTool(
			created,
			"session_search",
			{ pattern: "self-only-pattern", fixedStrings: true },
			toolCall.id,
		);
		expect((result.details as SessionSearchToolDetails).matchCount).toBe(0);
		expect(textOutput(result)).toBe("No matching session entries found.");
	});

	it("omits extension state and context-excluded bash output from search", async () => {
		const created = await harness();
		created.sessionManager.appendCustomEntry("private-state", { value: "hidden-needle" });
		created.sessionManager.appendMessage({
			role: "bashExecution",
			command: "echo hidden-needle",
			output: "hidden-needle",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			excludeFromContext: true,
			timestamp: 1,
		});

		const result = await executeTool(created, "session_search", { pattern: "hidden-needle" });
		expect((result.details as SessionSearchToolDetails).matchCount).toBe(0);
	});

	it("searches non-displayed context messages but omits internal audit messages", async () => {
		const created = await harness();
		const visibleId = created.sessionManager.appendCustomMessageEntry(
			"context-message",
			"model-visible-needle",
			false,
		);
		created.sessionManager.appendCustomMessageEntry(
			STRUCTURED_RESPONSE_INTERNAL_CUSTOM_TYPE,
			"internal-needle",
			false,
		);
		const visible = await executeTool(created, "session_search", { pattern: "model-visible-needle" });
		expect((visible.details as SessionSearchToolDetails).matches[0]?.entryId).toBe(visibleId);
		const internal = await executeTool(created, "session_search", { pattern: "internal-needle" });
		expect((internal.details as SessionSearchToolDetails).matchCount).toBe(0);
	});

	it("fetches an exact model-visible entry by ID outside the current branch", async () => {
		const created = await harness();
		const rootId = created.sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const entryId = created.sessionManager.appendMessage({
			role: "user",
			content: "abandoned exact message",
			timestamp: 2,
		});
		created.sessionManager.branch(rootId);
		created.sessionManager.appendMessage({ role: "user", content: "current", timestamp: 3 });

		const result = await executeTool(created, "session_entry_get", { entryId });
		const details = result.details as SessionEntryGetToolDetails;
		expect(details).toMatchObject({ entryId, entryType: "message", onCurrentBranch: false, outputTruncated: false });
		expect(textOutput(result)).toContain('"content":"abandoned exact message"');
	});

	it("rejects private entries and removes tool-result details", async () => {
		const created = await harness();
		const privateId = created.sessionManager.appendCustomEntry("saved-state", { secret: "private-value" });
		await expect(executeTool(created, "session_entry_get", { entryId: privateId })).rejects.toThrow(
			"Session entry is private or context-excluded",
		);

		const toolResultId = created.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "visible output" }],
			details: { secret: "private-details" },
			isError: false,
			timestamp: 4,
		});
		const result = await executeTool(created, "session_entry_get", { entryId: toolResultId });
		expect(textOutput(result)).toContain("visible output");
		expect(textOutput(result)).not.toContain("private-details");
	});

	it("reports an unknown exact entry ID as a tool error", async () => {
		const created = await harness();
		await expect(executeTool(created, "session_entry_get", { entryId: "missing" })).rejects.toThrow(
			"Session entry not found: missing",
		);
	});
	it("projects the summary before the preserved compression request and result", async () => {
		const contexts: string[][] = [];
		const created = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("context", (event) => {
						contexts.push(
							event.messages.map((message) =>
								message.role === "custom" ? String(message.content) : getMessageText(message),
							),
						);
					});
				},
			],
		});
		harnesses.push(created);
		const prefixId = created.sessionManager.appendMessage({ role: "user", content: "preserve prefix", timestamp: 1 });
		const startId = created.sessionManager.appendMessage({
			role: "user",
			content: `stale read ${"old content ".repeat(300)}`,
			timestamp: 2,
		});
		const endId = created.sessionManager.appendMessage({ role: "user", content: "older follow-up", timestamp: 3 });
		created.session.agent.state.messages = created.sessionManager.buildSessionContext().messages;
		const compressionUsage: Array<ReturnType<typeof created.session.getContextUsage>> = [];
		created.session.subscribe((event) => {
			if (event.type === "state_compressed") compressionUsage.push(created.session.getContextUsage());
		});
		const call = fauxToolCall("compress_context", {
			startEntryId: startId,
			summary: "Retain current objective and latest file state.",
		});
		created.setResponses([fauxAssistantMessage(call, { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
		await created.session.prompt("current request");
		const branch = created.sessionManager.getBranch();
		expect(compressionUsage).toHaveLength(1);
		expect(compressionUsage[0]?.tokens).toBeNull();
		expect(compressionUsage[0]?.percent).toBeNull();
		expect(contexts).toHaveLength(2);
		expect(contexts[1]).toContain("Retain current objective and latest file state.");
		expect(contexts[1]).not.toContain("stale read");
		expect(contexts[1]).toContain("current request");
		expect(branch[0]?.id).toBe(prefixId);
		expect(branch.some((entry) => entry.id === startId)).toBe(true);
		expect(
			branch.find((entry) => entry.type === "custom_message" && entry.customType === "compress_context"),
		).toMatchObject({
			content: "Retain current objective and latest file state.",
			details: { replacementVersion: 1, startEntryId: startId, endEntryId: endId },
		});
		expect(
			branch.find((entry) => entry.type === "custom" && entry.customType === COMPRESSION_ECONOMICS_ENTRY_TYPE),
		).toMatchObject({ data: { version: 1, sourceTokens: expect.any(Number), removedTokens: expect.any(Number) } });
		expect(estimateCompressionSavings(branch).liveRemovedTokens).toBeGreaterThan(0);
		expect(created.sessionManager.getEntry(startId)).toBeDefined();
		expect(created.sessionManager.buildSessionContext().messages.map((message) => message.role)).toEqual([
			"user",
			"custom",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		const context = created.sessionManager.buildSessionContext().messages;
		expect(getMessageText(context[2])).toBe("current request");
		expect(JSON.stringify(context[4])).toContain("Compression complete");
		const persisted = JSON.parse(JSON.stringify(created.sessionManager.getEntries())) as SessionEntry[];
		expect(buildSessionContext(persisted, created.sessionManager.getLeafId()).messages).toEqual(context);
		const marker = branch.find((entry) => entry.type === "custom_message" && entry.customType === "compress_context");
		const beforeMarker = branch.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		if (!marker || !beforeMarker) throw new Error("Missing compression marker or result");
		expect(
			buildSessionContext(persisted, beforeMarker.id).messages.some((entry) =>
				getMessageText(entry).includes("stale read"),
			),
		).toBe(true);
		expect(buildSessionContext(persisted, marker.id).messages.map((entry) => entry.role)).toEqual([
			"user",
			"custom",
			"user",
			"assistant",
			"toolResult",
		]);
		const inContext = await executeTool(created, "session_search", { pattern: "stale read", fixedStrings: true });
		expect((inContext.details as SessionSearchToolDetails).matchCount).toBe(0);
		const old = await executeTool(created, "session_search", {
			pattern: "stale read",
			fixedStrings: true,
			scope: "all",
		});
		expect((old.details as SessionSearchToolDetails).matches[0]?.entryId).toBe(startId);
	});
	it("rejects an end cut that includes the current compression request", async () => {
		const created = await harness();
		const first = created.sessionManager.appendMessage({ role: "user", content: "earlier", timestamp: 1 });
		created.sessionManager.appendMessage({ role: "user", content: "more earlier", timestamp: 2 });
		created.session.agent.state.messages = created.sessionManager.buildSessionContext().messages;
		created.setResponses([
			() => {
				const current = created.sessionManager
					.getBranch()
					.filter((entry) => entry.type === "message" && entry.message.role === "user")
					.at(-1);
				if (!current) throw new Error("Missing current request");
				return fauxAssistantMessage(
					fauxToolCall("compress_context", { startEntryId: first, endEntryId: current.id, summary: "wrong" }),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("done"),
		]);
		await created.session.prompt("compress now");
		const branch = created.sessionManager.getBranch();
		expect(branch.some((entry) => entry.type === "custom_message" && entry.customType === "compress_context")).toBe(
			false,
		);
		expect(
			branch.some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.isError &&
					JSON.stringify(entry.message.content).includes(
						"endEntryId is the current user request; omit endEntryId",
					),
			),
		).toBe(true);
	});

	it("replaces a bounded earlier range while keeping later entry IDs and the compression turn", async () => {
		const created = await createHarness({
			models: [{ id: "faux-1", cost: { input: 4, output: 20, cacheRead: 1, cacheWrite: 5 } }],
		});
		harnesses.push(created);
		const session = created.sessionManager;
		const prefix = session.appendMessage({ role: "user", content: "keep prefix", timestamp: 1 });
		const start = session.appendMessage({ role: "user", content: "old investigation", timestamp: 2 });
		session.appendModelChange(created.getModel().provider, created.getModel().id);
		const end = session.appendMessage(fauxAssistantMessage("old findings"));
		const retainedThinking = session.appendThinkingLevelChange("high");
		const retainedUser = session.appendMessage({ role: "user", content: "retain this later task", timestamp: 4 });
		const call = fauxToolCall("read", { path: "later.txt" });
		const retainedAssistant = session.appendMessage(fauxAssistantMessage([call], { stopReason: "toolUse" }));
		const retainedResult = session.appendMessage({
			role: "toolResult",
			toolCallId: call.id,
			toolName: "read",
			content: [{ type: "text", text: "later result" }],
			isError: false,
			timestamp: 5,
		});
		created.session.agent.state.messages = session.buildSessionContext().messages;
		created.setResponses([
			fauxAssistantMessage(
				fauxToolCall("compress_context", { startEntryId: start, endEntryId: end, summary: "Concise old findings" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await created.session.prompt("compress earlier work");
		const branch = session.getBranch();
		const marker = branch.find((entry) => entry.type === "custom_message" && entry.customType === "compress_context");
		const economics = branch.find(
			(entry) => entry.type === "custom" && entry.customType === COMPRESSION_ECONOMICS_ENTRY_TYPE,
		);
		if (!marker || !economics || economics.type !== "custom")
			throw new Error("Missing compression marker or economics record");
		const compressCallIndex = branch.findIndex(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some((block) => block.type === "toolCall" && block.name === "compress_context"),
		);
		expect(compressCallIndex).toBeGreaterThan(0);
		const beforeCompression = projectSessionContextEntries(branch.slice(0, compressCallIndex));
		const expected = estimateCompressionEconomics(
			beforeCompression,
			start,
			end,
			created.getModel(),
			"Concise old findings",
		);
		expect(economics.data).toMatchObject(expected ?? {});
		expect(expected?.oneTimeCost).toBeGreaterThan(
			((expected?.summaryTokens ?? 0) * (created.getModel().cost.input + created.getModel().cost.output)) /
				1_000_000,
		);
		expect(branch[0]?.id).toBe(prefix);
		expect(branch.map((entry) => entry.id)).toContain(start);
		expect(branch.map((entry) => entry.id)).toContain(end);
		expect(branch.some((entry) => entry.type === "thinking_level_change" && entry.thinkingLevel === "high")).toBe(
			true,
		);
		expect(branch.map((entry) => entry.id)).toContain(retainedThinking);
		expect(session.buildSessionContext().model).toMatchObject({
			provider: created.getModel().provider,
			modelId: created.getModel().id,
		});
		for (const id of [start, end, retainedUser, retainedAssistant, retainedResult])
			expect(session.getEntry(id)).toBeDefined();
		const messages = session.buildSessionContext().messages;
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"custom",
			"user",
			"assistant",
			"toolResult",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(messages[1]?.role === "custom" ? messages[1].content : undefined).toBe("Concise old findings");
		expect(messages[2]?.role === "user" ? messages[2].content : undefined).toBe("retain this later task");
		expect(messages[4]?.role === "toolResult" ? messages[4].toolCallId : undefined).toBe(call.id);
		expect(getMessageText(messages[5])).toBe("compress earlier work");
		expect(branch.find((entry) => entry.type === "message" && entry.message.role === "toolResult")?.id).toBe(
			retainedResult,
		);
		const archived = await executeTool(created, "session_search", {
			pattern: "old investigation",
			fixedStrings: true,
		});
		expect((archived.details as SessionSearchToolDetails).matchCount).toBe(0);
		const retained = await executeTool(created, "session_search", {
			pattern: "retain this later task",
			fixedStrings: true,
		});
		expect((retained.details as SessionSearchToolDetails).matches[0]?.entryId).toBe(
			branch.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					entry.message.content === "retain this later task",
			)?.id,
		);
	});

	it("rejects unknown, reversed and split-tool-call bounded ranges", async () => {
		const created = await harness();
		const session = created.sessionManager;
		const start = session.appendMessage({ role: "user", content: "start", timestamp: 1 });
		const call = fauxToolCall("read", { path: "later.txt" });
		const assistant = session.appendMessage(fauxAssistantMessage([call], { stopReason: "toolUse" }));
		const result = session.appendMessage({
			role: "toolResult",
			toolCallId: call.id,
			toolName: "read",
			content: [],
			isError: false,
			timestamp: 2,
		});
		await expect(
			executeTool(created, "compress_context", { startEntryId: start, endEntryId: "missing", summary: "x" }),
		).rejects.toThrow("endEntryId");
		await expect(
			executeTool(created, "compress_context", { startEntryId: result, endEntryId: start, summary: "x" }),
		).rejects.toThrow("precede");
		await expect(
			executeTool(created, "compress_context", { startEntryId: start, endEntryId: assistant, summary: "x" }),
		).rejects.toThrow("split a tool call");
	});

	it("rejects invalid tail ranges and tool results as cut points", async () => {
		const created = await harness();
		const first = created.sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const toolResult = created.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "old",
			toolName: "read",
			content: [],
			isError: false,
			timestamp: 2,
		});
		await expect(
			executeTool(created, "compress_context", { startEntryId: "not-on-branch", summary: "x" }),
		).rejects.toThrow("current model context");
		await expect(
			executeTool(created, "compress_context", { startEntryId: toolResult, summary: "x" }),
		).rejects.toThrow("tool result");
		await expect(executeTool(created, "compress_context", { startEntryId: first, summary: "" })).rejects.toThrow(
			"non-empty summary",
		);
	});

	it.each([false, true])(
		"compresses retained messages before compaction (include summary: %s)",
		async (includeCompaction) => {
			const created = await harness();
			const session = created.sessionManager;
			const first = session.appendMessage({ role: "user", content: "first retained", timestamp: 1 });
			const second = session.appendMessage({ role: "user", content: "second retained", timestamp: 2 });
			const compaction = session.appendCompaction("prior compaction summary", first, 100);
			const later = session.appendMessage({ role: "user", content: "later task", timestamp: 3 });
			created.session.agent.state.messages = session.buildSessionContext().messages;
			created.setResponses([
				fauxAssistantMessage(
					fauxToolCall("compress_context", {
						startEntryId: includeCompaction ? compaction : first,
						endEntryId: second,
						summary: "new concise summary",
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await created.session.prompt("compress older work");
			const messages = session.buildSessionContext().messages;
			const contents = messages.map((message) =>
				message.role === "custom"
					? String(message.content)
					: message.role === "compactionSummary"
						? message.summary
						: getMessageText(message),
			);
			if (includeCompaction) expect(contents).not.toContain("prior compaction summary");
			else expect(contents).toContain("prior compaction summary");
			expect(contents).toContain("new concise summary");
			expect(contents).toContain("later task");
			expect(contents).not.toContain("first retained");
			expect(contents).not.toContain("second retained");
			expect(session.getBranch().some((entry) => entry.id === later)).toBe(true);
			expect(session.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
		},
	);

	it("requires both compression arguments and rejects the removed listing API", async () => {
		const created = await harness();
		const tool = created.session.agent.state.tools.find((candidate) => candidate.name === "compress_context");
		expect(tool?.description).toContain("model-only context metadata");
		expect(tool?.description).toContain("do not use the current user's ID");
		expect(tool?.description).not.toContain("List IDs");
		expect(Object.keys(tool?.parameters.properties ?? {})).toEqual(["startEntryId", "endEntryId", "summary"]);
		await expect(executeTool(created, "compress_context", {})).rejects.toThrow();
		await expect(executeTool(created, "compress_context", { startEntryId: "missing" })).rejects.toThrow();
		await expect(executeTool(created, "compress_context", { summary: "x" })).rejects.toThrow();
		await expect(
			executeTool(created, "compress_context", { startEntryId: "missing", summary: "x", offset: 50 }),
		).rejects.toThrow();
	});

	it("supports repeated tail compression without restoring the prior tail", async () => {
		const created = await harness();
		created.sessionManager.appendMessage({ role: "user", content: "prefix", timestamp: 1 });
		const start = created.sessionManager.appendMessage({ role: "user", content: "old detail", timestamp: 2 });
		created.sessionManager.appendMessage({ role: "user", content: "old continuation", timestamp: 3 });
		created.session.agent.state.messages = created.sessionManager.buildSessionContext().messages;
		created.setResponses([
			fauxAssistantMessage(fauxToolCall("compress_context", { startEntryId: start, summary: "first summary" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("continue"),
		]);
		await created.session.prompt("work");
		const firstSummaryId = created.sessionManager
			.getBranch()
			.find((entry) => entry.type === "custom_message" && entry.customType === "compress_context")?.id;
		if (!firstSummaryId) throw new Error("Missing first compression summary");
		created.setResponses([
			fauxAssistantMessage(
				fauxToolCall("compress_context", { startEntryId: firstSummaryId, summary: "second summary" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("finished"),
		]);
		await created.session.prompt("more work");
		const errors = created.session.messages.filter((message) => message.role === "toolResult" && message.isError);
		expect(errors).toEqual([]);
		const context = created.sessionManager.buildSessionContext().messages;
		expect(context.map((message) => message.role)).toEqual([
			"user",
			"custom",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(context.find((message) => message.role === "custom")?.content).toBe("second summary");
		expect(created.sessionManager.getEntry(firstSummaryId)).toBeDefined();
	});
	it("replaces overlapping bounded ranges in place across three compressions", async () => {
		const created = await harness();
		const session = created.sessionManager;
		const one = session.appendMessage({ role: "user", content: "1", timestamp: 1 });
		const two = session.appendMessage({ role: "user", content: "2", timestamp: 2 });
		const three = session.appendMessage({ role: "user", content: "3", timestamp: 3 });
		session.appendMessage({ role: "user", content: "4", timestamp: 4 });
		const compress = async (startEntryId: string, endEntryId: string, summary: string): Promise<string> => {
			created.session.agent.state.messages = session.buildSessionContext().messages;
			created.setResponses([
				fauxAssistantMessage(fauxToolCall("compress_context", { startEntryId, endEntryId, summary }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			await created.session.prompt(`compress ${summary}`);
			const entry = session
				.getBranch()
				.find(
					(candidate) =>
						candidate.type === "custom_message" &&
						candidate.customType === "compress_context" &&
						candidate.content === summary,
				);
			if (!entry) throw new Error(`Missing ${summary}`);
			return entry.id;
		};
		const visible = () =>
			session.buildSessionContext().messages.flatMap((message) => {
				if (message.role === "custom" && message.customType === "compress_context")
					return [String(message.content)];
				if (message.role === "user" && /^[1-6]$/.test(String(message.content))) return [String(message.content)];
				return [];
			});
		const first = await compress(two, three, "3'");
		expect(visible()).toEqual(["1", "3'", "4"]);
		session.appendMessage({ role: "user", content: "5", timestamp: 5 });
		session.appendMessage({ role: "user", content: "6", timestamp: 6 });
		const second = await compress(one, first, "1'");
		expect(visible()).toEqual(["1'", "4", "5", "6"]);
		const five = session
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "user" && entry.message.content === "5");
		if (!five) throw new Error("Missing retained message 5");
		await compress(second, five.id, "1''");
		expect(visible()).toEqual(["1''", "6"]);
		expect(session.getEntry(first)).toBeDefined();
		expect(session.getEntry(second)).toBeDefined();
		const records = new Map<string, number>();
		for (const entry of session.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== COMPRESSION_ECONOMICS_ENTRY_TYPE) continue;
			const data = entry.data as { summaryEntryId: string; removedTokens: number };
			records.set(data.summaryEntryId, data.removedTokens);
		}
		expect(records.size).toBe(3);
		const removed = [...records.values()].reduce((total, amount) => total + amount, 0);
		const savings = estimateCompressionSavings(session.getBranch());
		expect(savings.totalRemovedTokens).toBe(removed);
		expect(savings.liveRemovedTokens).toBe([...records.values()][2]);
	});
});
