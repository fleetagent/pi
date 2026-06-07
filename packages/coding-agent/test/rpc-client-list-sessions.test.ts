import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type SentCommand = {
	type: string;
	cursor?: string;
	limit?: number;
};

type RpcClientPrivate = {
	send: (command: SentCommand) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
};

describe("RpcClient listSessions", () => {
	it("sends pagination options and revives session dates", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => ({
			id: "req_1",
			type: "response",
			command: "list_sessions",
			success: true,
			data: {
				sessions: [
					{
						reference: "session-reference",
						path: "/tmp/session.jsonl",
						id: "session-1",
						cwd: "/tmp/project",
						created: "2026-06-07T10:00:00.000Z",
						modified: "2026-06-07T11:00:00.000Z",
						messageCount: 2,
						firstMessage: "hello",
						allMessagesText: "hello\nworld",
					},
				],
				nextCursor: "25",
			},
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => {
			return (response as { data: T }).data;
		};

		const result = await client.listSessions({ cursor: "10", limit: 15 });

		expect(send).toHaveBeenCalledWith({ type: "list_sessions", cursor: "10", limit: 15 });
		expect(result.nextCursor).toBe("25");
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].created).toEqual(new Date("2026-06-07T10:00:00.000Z"));
		expect(result.sessions[0].modified).toEqual(new Date("2026-06-07T11:00:00.000Z"));
	});
});
