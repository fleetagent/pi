import type { AgentTool } from "@fleetagent/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@fleetagent/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

function createWaitTool(released: Promise<void>): AgentTool {
	return {
		name: "wait",
		label: "Wait",
		description: "Wait until released",
		parameters: Type.Object({}),
		execute: async () => {
			await released;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
}

describe("regression #6363: agent settled event and idle waiting", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("emits one public agent_settled event after automatic retry finishes", async () => {
		const extensionEvents: string[] = [];
		const publicEvents: string[] = [];
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", () => {
						extensionEvents.push("agent_end");
					});
					pi.on("agent_settled", (_event, ctx) => {
						extensionEvents.push(`agent_settled:${ctx.isIdle()}`);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled") publicEvents.push("agent_settled");
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");
		await harness.session.waitForIdle();

		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(extensionEvents).toEqual(["agent_end", "agent_end", "agent_settled:false"]);
		expect(publicEvents).toEqual(["agent_settled"]);
		expect(harness.session.isIdle).toBe(true);
	});

	it("settles only after follow-ups queued by agent_end handlers run", async () => {
		let queuedFollowUp = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", () => {
						if (queuedFollowUp) return;
						queuedFollowUp = true;
						pi.sendUserMessage("status follow-up", { deliverAs: "followUp" });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("hello");
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["hello", "status follow-up"]);
		expect(harness.eventsOfType("agent_end")).toHaveLength(2);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("rechecks settlement when an extension settled handler starts another prompt", async () => {
		let startedReentrantPrompt = false;
		let extensionSettledCount = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", () => {
						extensionSettledCount++;
						if (startedReentrantPrompt) return;
						startedReentrantPrompt = true;
						pi.sendUserMessage("from settled callback");
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("hello");
		const waiterOne = harness.session.waitForIdle();
		const waiterTwo = harness.session.waitForIdle();
		await Promise.all([waiterOne, waiterTwo]);

		expect(getUserTexts(harness)).toEqual(["hello", "from settled callback"]);
		expect(extensionSettledCount).toBe(2);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.session.isIdle).toBe(true);
	});

	it("registers reentrant prompt admission before asynchronous input hooks", async () => {
		let releaseInput = () => {};
		const inputGate = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		let markInputStarted = () => {};
		const inputStarted = new Promise<void>((resolve) => {
			markInputStarted = resolve;
		});
		let startedReentrantPrompt = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text === "gated reentrant prompt") {
							markInputStarted();
							await inputGate;
						}
						return { action: "continue" };
					});
					pi.on("agent_settled", () => {
						if (startedReentrantPrompt) return;
						startedReentrantPrompt = true;
						pi.sendUserMessage("gated reentrant prompt");
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("hello");
		const idle = harness.session.waitForIdle();
		await inputStarted;
		let resolved = false;
		void idle.then(() => {
			resolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(resolved).toBe(false);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(0);

		releaseInput();
		await idle;
		expect(getUserTexts(harness)).toEqual(["hello", "gated reentrant prompt"]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("rejects idle steering and follow-up admission instead of settling with stranded queues", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await expect(harness.session.steer("stranded")).rejects.toThrow("agent is idle");
		await expect(harness.session.followUp("stranded")).rejects.toThrow("agent is idle");
		await expect(harness.session.waitForIdle()).resolves.toBeUndefined();
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	it("isolates throwing public settled listeners and releases waiters", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let laterListenerRan = false;
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled") throw new Error("subscriber failed");
		});
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled") laterListenerRan = true;
		});
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("hello");
		await expect(harness.session.waitForIdle()).resolves.toBeUndefined();

		expect(laterListenerRan).toBe(true);
		expect(harness.session.isIdle).toBe(true);
	});

	it("fails fast when an agent_end handler awaits its own session barrier", async () => {
		let harness: Harness;
		let barrierError: string | undefined;
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", async () => {
						try {
							await harness.session.waitForIdle();
						} catch (error) {
							barrierError = error instanceof Error ? error.message : String(error);
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("hello");
		await harness.session.waitForIdle();

		expect(barrierError).toContain("extension agent_end handler");
	});

	it("fails fast when a settled handler awaits its own session barrier", async () => {
		let harness: Harness;
		let barrierError: string | undefined;
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", async () => {
						try {
							await harness.session.waitForIdle();
						} catch (error) {
							barrierError = error instanceof Error ? error.message : String(error);
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("hello");
		await harness.session.waitForIdle();

		expect(barrierError).toContain("agent_settled extension handler");
	});

	it("extension command waitForIdle waits through an active tool execution", async () => {
		let releaseTool = () => {};
		const released = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		let markCommandStarted = () => {};
		const commandStarted = new Promise<void>((resolve) => {
			markCommandStarted = resolve;
		});
		const commandResults: boolean[] = [];
		const harness = await createHarness({
			tools: [createWaitTool(released)],
			extensionFactories: [
				(pi) => {
					pi.registerCommand("after-idle", {
						description: "Wait for idle",
						handler: async (_args, ctx) => {
							markCommandStarted();
							await ctx.waitForIdle();
							commandResults.push(ctx.isIdle());
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			commandContextActions: {
				waitForIdle: () => harness.session.waitForIdle(),
				newSession: async () => ({ cancelled: false }),
				fork: async () => ({ cancelled: false }),
				navigateTree: async () => ({ cancelled: false }),
				switchSession: async () => ({ cancelled: false }),
				reload: async () => {},
			},
		});
		const toolStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const promptPromise = harness.session.prompt("start");
		await toolStarted;
		const commandPromise = harness.session.prompt("/after-idle");
		await commandStarted;
		let commandFinished = false;
		void commandPromise.then(() => {
			commandFinished = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(commandFinished).toBe(false);

		releaseTool();
		await Promise.all([promptPromise, commandPromise]);

		expect(commandResults).toEqual([true]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});
});
