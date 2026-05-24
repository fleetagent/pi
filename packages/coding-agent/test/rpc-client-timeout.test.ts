import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	handleLine: (line: string) => void;
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
		const promise = client.waitForIdle(1000);
		const onRejected = vi.fn();
		promise.catch(onRejected);

		await vi.advanceTimersByTimeAsync(900);
		emitEvent(client, { type: "agent_start" });
		await vi.advanceTimersByTimeAsync(999);

		expect(onRejected).not.toHaveBeenCalled();

		emitEvent(client, { type: "agent_end", messages: [] });
		await expect(promise).resolves.toBeUndefined();
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

		emitEvent(client, { type: "agent_end", messages: [] });
		await expect(promise).resolves.toEqual([{ type: "agent_start" }, { type: "agent_end", messages: [] }]);
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
});
