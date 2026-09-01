import type { AgentToolResult } from "@fleetagent/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type TextContent, validateToolArguments } from "@fleetagent/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { STRUCTURED_RESPONSE_INTERNAL_CUSTOM_TYPE } from "../src/core/messages.ts";
import type {
	SessionEntryGetToolDetails,
	SessionHistoryToolName,
	SessionSearchToolDetails,
} from "../src/core/tools/session-history.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function textOutput(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((content): content is TextContent => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

async function executeTool(
	harness: Harness,
	name: SessionHistoryToolName,
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

	it("registers both tools as active host-owned built-ins", async () => {
		const created = await harness();
		expect(created.session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["session_search", "session_entry_get"]),
		);
		expect(created.session.getAllTools().find((tool) => tool.name === "session_search")?.sourceInfo).toMatchObject({
			path: "<builtin:session_search>",
			source: "builtin",
		});
	});

	it("searches compacted current-branch history with regex and grep-like context", async () => {
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
		expect(details.matchCount).toBe(2);
		expect(details.matches.map((match) => match.entryId)).toEqual([rootId, currentId]);
		expect(textOutput(result)).toContain("1-role: user");
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
});
