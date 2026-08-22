import { fauxAssistantMessage, fauxToolCall } from "@fleetagent/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

describe("#5998 blocked tool termination", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("lets a tool_call handler terminate after blocking the native subagent tool", async () => {
		let subagentRuns = 0;
		const harness = await createHarness({
			subagentRunner: async () => {
				subagentRuns++;
				return { exitCode: 0, stderr: "" };
			},
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async (event) => {
						if (event.toolName !== "subagent") return;
						return {
							block: true,
							reason: "Subagents disabled by policy",
							terminate: true,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("subagent", { task: "Do not run" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("should not run"),
		]);

		await harness.session.prompt("delegate");

		expect(subagentRuns).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(getAssistantTexts(harness)).not.toContain("should not run");
		expect(harness.eventsOfType("tool_execution_end")[0]).toMatchObject({
			toolName: "subagent",
			result: { terminate: true },
			isError: true,
		});
		expect(
			harness.session.messages.find((message) => message.role === "toolResult" && message.isError),
		).toMatchObject({
			content: [{ type: "text", text: "Subagents disabled by policy" }],
		});
	});

	it("continues a mixed parallel batch when a terminating subagent call is blocked", async () => {
		let subagentRuns = 0;
		const echoInputs: string[] = [];
		const harness = await createHarness({
			subagentRunner: async () => {
				subagentRuns++;
				return { exitCode: 0, stderr: "" };
			},
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "echo",
						label: "Echo",
						description: "Echo text back",
						parameters: Type.Object({ text: Type.String() }),
						execute: async (_toolCallId, params) => {
							echoInputs.push(params.text);
							return { content: [{ type: "text", text: params.text }], details: {} };
						},
					});
					pi.on("tool_call", async (event) =>
						event.toolName === "subagent"
							? { block: true, reason: "Subagent blocked", terminate: true }
							: undefined,
					);
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("subagent", { task: "Do not run" }), fauxToolCall("echo", { text: "allowed" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("continued after mixed batch"),
		]);

		await harness.session.prompt("run both");

		expect(subagentRuns).toBe(0);
		expect(echoInputs).toEqual(["allowed"]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(getAssistantTexts(harness)).toContain("continued after mixed batch");
		const toolEnds = harness.eventsOfType("tool_execution_end");
		expect(toolEnds.find((event) => event.toolName === "subagent")?.result).toHaveProperty("terminate", true);
		expect(toolEnds.find((event) => event.toolName === "echo")?.result).not.toHaveProperty("terminate", true);
	});
});
