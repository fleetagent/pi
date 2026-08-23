import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentToolResult } from "@fleetagent/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@fleetagent/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { prepareBranchEntries } from "../../../src/core/compaction/branch-summarization.ts";
import { prepareCompaction } from "../../../src/core/compaction/compaction.ts";
import { buildSessionContext } from "../../../src/core/session/context.ts";
import { LocalSessionManager } from "../../../src/core/session/local-session-manager.ts";
import type { CustomMessageEntry, SessionEntry, SessionMessageEntry } from "../../../src/core/session/types.ts";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness } from "../harness.ts";

function messageEntry(id: string, parentId: string | null, message: Record<string, unknown>): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message,
	} as unknown as SessionMessageEntry;
}

function customMessageEntry(id: string, parentId: string | null, content: unknown): CustomMessageEntry {
	return {
		type: "custom_message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType: "imported",
		content,
		display: false,
	} as unknown as CustomMessageEntry;
}

function malformedAssistant(): Record<string, unknown> {
	return {
		role: "assistant",
		content: null,
		api: "faux",
		provider: "faux",
		model: "faux-1",
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

function messageContent(message: AgentMessage): unknown {
	return "content" in message ? message.content : undefined;
}

describe("#6259 lax message content ingestion", () => {
	it("normalizes tool results from untyped tools before state and persistence", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.registerTool({
					name: "web_search",
					label: "Web Search",
					description: "Custom tool that returns a result without content",
					parameters: Type.Object({}),
					execute: async () => ({ details: { source: "remote" } }) as unknown as AgentToolResult<unknown>,
				});
			},
		];
		const harness = await createHarness({ extensionFactories });

		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("web_search", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("search something");

			const stateResult = harness.session.messages.find((message) => message.role === "toolResult");
			expect(stateResult ? messageContent(stateResult) : undefined).toEqual([]);
			const persistedResult = harness.sessionManager
				.getEntries()
				.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
			expect(persistedResult?.type === "message" ? messageContent(persistedResult.message) : undefined).toEqual([]);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("normalizes message_end replacements before state and persistence", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.on("message_end", async (event) => {
					if (event.message.role !== "assistant") return undefined;
					return { message: { ...event.message, content: null } as unknown as AgentMessage };
				});
			},
		];
		const harness = await createHarness({ extensionFactories });

		try {
			harness.setResponses([fauxAssistantMessage("hello")]);
			await harness.session.prompt("hi");

			const stateMessage = harness.session.messages.find((message) => message.role === "assistant");
			expect(stateMessage ? messageContent(stateMessage) : undefined).toEqual([]);
			const persistedMessage = harness.sessionManager
				.getEntries()
				.find((entry) => entry.type === "message" && entry.message.role === "assistant");
			expect(persistedMessage?.type === "message" ? messageContent(persistedMessage.message) : undefined).toEqual(
				[],
			);
		} finally {
			harness.cleanup();
		}
	});

	it("normalizes sendMessage custom content before state and persistence", async () => {
		const harness = await createHarness();

		try {
			await harness.session.sendCustomMessage({
				customType: "test",
				content: null as unknown as string,
				display: false,
				details: undefined,
			});

			const stateMessage = harness.session.messages.find((message) => message.role === "custom");
			expect(stateMessage ? messageContent(stateMessage) : undefined).toEqual([]);
			const persistedMessage = harness.sessionManager.getEntries().find((entry) => entry.type === "custom_message");
			expect(persistedMessage?.type === "custom_message" ? persistedMessage.content : undefined).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("normalizes before_agent_start custom content before the provider and history", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => ({
						message: {
							customType: "before-start",
							content: null as unknown as string,
							display: true,
						},
					}));
				},
			],
		});
		let providerSawEmptyContent = false;

		try {
			harness.setResponses([
				(context) => {
					providerSawEmptyContent = context.messages.some(
						(message) =>
							message.role === "user" && Array.isArray(message.content) && message.content.length === 0,
					);
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("hi");

			expect(providerSawEmptyContent).toBe(true);
			const customMessage = harness.session.messages.find(
				(message) => message.role === "custom" && message.customType === "before-start",
			);
			expect(customMessage ? messageContent(customMessage) : undefined).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("normalizes imported message and custom entries without mutating valid or raw entries", () => {
		const malformedUser = { role: "user", content: null, timestamp: Date.now() };
		const malformedAssistantMessage = malformedAssistant();
		const malformedToolResult = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "web_search",
			isError: false,
			timestamp: Date.now(),
		};
		const validImage = { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" };
		const validContent = [validImage];
		const validMessage = {
			role: "user",
			content: validContent,
			timestamp: Date.now(),
		};
		const entries: SessionEntry[] = [
			messageEntry("1", null, malformedUser),
			messageEntry("2", "1", malformedAssistantMessage),
			messageEntry("3", "2", malformedToolResult),
			customMessageEntry("4", "3", null),
			messageEntry("5", "4", validMessage),
		];

		const context = buildSessionContext(entries);

		expect(context.messages.slice(0, 4).map(messageContent)).toEqual([[], [], [], []]);
		expect(context.messages[4]).toBe(validMessage);
		expect(messageContent(context.messages[4])).toBe(validContent);
		expect(malformedUser.content).toBeNull();
		expect(malformedAssistantMessage.content).toBeNull();
		expect("content" in malformedToolResult).toBe(false);
		expect((entries[3] as CustomMessageEntry).content).toBeNull();
	});

	it("keeps imported JSONL discoverable while normalizing only the derived context", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lax-content-"));
		const file = join(dir, "imported.jsonl");
		const lines = [
			{
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: dir,
			},
			messageEntry("1", null, { role: "user", content: null, timestamp: Date.now() }),
			messageEntry("2", "1", malformedAssistant()),
			messageEntry("3", "2", {
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "web_search",
				isError: false,
				timestamp: Date.now(),
			}),
			customMessageEntry("4", "3", null),
		];
		const serialized = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
		writeFileSync(file, serialized);

		try {
			const manager = new LocalSessionManager({ cwd: dir, sessionDir: dir });
			const listed = await manager.list();
			const session = manager.openReference(file);
			const context = buildSessionContext(session.getEntries());

			expect(listed).toHaveLength(1);
			expect(context.messages.map(messageContent)).toEqual([[], [], [], []]);
			expect(readFileSync(file, "utf8")).toBe(serialized);
			const rawEntries = session.getEntries();
			expect(rawEntries[0].type === "message" ? messageContent(rawEntries[0].message) : undefined).toBeNull();
			expect(rawEntries[2].type === "message" && "content" in rawEntries[2].message).toBe(false);
			expect(rawEntries[3].type === "custom_message" ? rawEntries[3].content : undefined).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("normalizes imported entries on compaction and branch-summary paths", () => {
		const malformedUser = { role: "user", content: null, timestamp: Date.now() };
		const malformedAssistantMessage = malformedAssistant();
		const entries: SessionEntry[] = [
			messageEntry("1", null, malformedUser),
			messageEntry("2", "1", malformedAssistantMessage),
			customMessageEntry("3", "2", null),
			messageEntry("4", "3", { role: "user", content: "keep", timestamp: Date.now() }),
			messageEntry("5", "4", {
				...malformedAssistant(),
				content: [{ type: "text", text: "done" }],
			}),
		];

		const preparation = prepareCompaction(entries, {
			enabled: true,
			reserveTokens: 100,
			keepRecentTokens: 1,
		});
		const branch = prepareBranchEntries(entries);

		expect(preparation).toBeDefined();
		expect(preparation?.messagesToSummarize.slice(0, 3).map(messageContent)).toEqual([[], [], []]);
		expect(branch.messages.slice(0, 3).map(messageContent)).toEqual([[], [], []]);
		expect(malformedUser.content).toBeNull();
		expect(malformedAssistantMessage.content).toBeNull();
		expect((entries[2] as CustomMessageEntry).content).toBeNull();
	});
});
