import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	handleLine: (line: string) => void;
	rejectPendingRequests: (error: Error) => void;
};

function emitEvent(client: RpcClient, event: object): void {
	(client as unknown as RpcClientPrivate).handleLine(JSON.stringify(event));
}

describe("RpcClient idle event timeouts", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("resets waitForIdle timeout when events arrive", async () => {
		vi.useFakeTimers();
		const client = new RpcClient();
		vi.spyOn(client, "getState").mockResolvedValue({ isIdle: false } as Awaited<ReturnType<RpcClient["getState"]>>);
		const promise = client.waitForIdle(1000);
		const onRejected = vi.fn();
		promise.catch(onRejected);

		await vi.advanceTimersByTimeAsync(900);
		emitEvent(client, { type: "agent_start" });
		await vi.advanceTimersByTimeAsync(999);

		expect(onRejected).not.toHaveBeenCalled();

		emitEvent(client, { type: "agent_settled" });
		await expect(promise).resolves.toBeUndefined();
	});

	it("resolves waitForIdle when subscribe-then-state validation observes idle", async () => {
		const client = new RpcClient();
		vi.spyOn(client, "getState").mockResolvedValue({ isIdle: true } as Awaited<ReturnType<RpcClient["getState"]>>);

		await expect(client.waitForIdle()).resolves.toBeUndefined();
	});

	it("resets collectEvents timeout when events arrive", async () => {
		vi.useFakeTimers();
		const client = new RpcClient();
		const promise = client.collectEvents(1000);
		const onRejected = vi.fn();
		promise.catch(onRejected);

		await vi.advanceTimersByTimeAsync(900);
		emitEvent(client, { type: "agent_start" });
		await vi.advanceTimersByTimeAsync(999);

		expect(onRejected).not.toHaveBeenCalled();

		emitEvent(client, { type: "agent_settled" });
		await expect(promise).resolves.toEqual([{ type: "agent_start" }, { type: "agent_settled" }]);
	});

	it("times out after no events arrive within the inactivity timeout", async () => {
		vi.useFakeTimers();
		const client = new RpcClient();
		const promise = client.collectEvents(1000);
		const assertion = expect(promise).rejects.toThrow("Timeout collecting events");

		emitEvent(client, { type: "agent_start" });
		await vi.advanceTimersByTimeAsync(1000);

		await assertion;
	});

	it("ignores a stale settled event before prompt acceptance", async () => {
		const client = new RpcClient();
		let acceptPrompt = () => {};
		const promptAccepted = new Promise<void>((resolve) => {
			acceptPrompt = resolve;
		});
		vi.spyOn(client, "prompt").mockReturnValue(promptAccepted);
		vi.spyOn(client, "getState").mockResolvedValue({ isIdle: false } as Awaited<ReturnType<RpcClient["getState"]>>);

		const completion = client.promptAndWait("hello");
		let resolved = false;
		void completion.then(() => {
			resolved = true;
		});
		emitEvent(client, { type: "agent_settled" });
		acceptPrompt();
		await Promise.resolve();
		await Promise.resolve();
		expect(resolved).toBe(false);

		emitEvent(client, { type: "agent_start" });
		emitEvent(client, { type: "agent_settled" });
		await expect(completion).resolves.toEqual([{ type: "agent_start" }, { type: "agent_settled" }]);
	});

	it("rejects an accepted promptAndWait when the RPC process terminates", async () => {
		const client = new RpcClient();
		vi.spyOn(client, "prompt").mockResolvedValue();
		vi.spyOn(client, "getState").mockResolvedValue({ isIdle: false } as Awaited<ReturnType<RpcClient["getState"]>>);

		const completion = client.promptAndWait("hello");
		const assertion = expect(completion).rejects.toThrow("process terminated");
		await Promise.resolve();
		await Promise.resolve();
		(client as unknown as RpcClientPrivate).rejectPendingRequests(new Error("process terminated"));

		await assertion;
	});

	it("rejects idle event waiters when the RPC process terminates", async () => {
		const client = new RpcClient();
		vi.spyOn(client, "getState").mockResolvedValue({ isIdle: false } as Awaited<ReturnType<RpcClient["getState"]>>);
		const idle = client.waitForIdle();
		const events = client.collectEvents();
		const idleAssertion = expect(idle).rejects.toThrow("process terminated");
		const eventsAssertion = expect(events).rejects.toThrow("process terminated");

		(client as unknown as RpcClientPrivate).rejectPendingRequests(new Error("process terminated"));

		await Promise.all([idleAssertion, eventsAssertion]);
	});
});
