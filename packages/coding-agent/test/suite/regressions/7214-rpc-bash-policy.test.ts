import { afterEach, describe, expect, test, vi } from "vitest";
import type { UserBashEvent } from "../../../src/core/extensions/types.ts";
import type { PiAgentRuntimeHost } from "../../../src/core/pi-agent.ts";
import { LocalToolOperations } from "../../../src/core/tools/operations.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../../src/modes/interactive/theme/theme.ts", () => ({ theme: {} }));

vi.mock("../../../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type RpcResponseRecord = {
	id?: string;
	type: string;
	command?: string;
	success?: boolean;
	data?: Record<string, unknown>;
};

function responsesFor(id: string): RpcResponseRecord[] {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as RpcResponseRecord)
		.filter((record) => record.type === "response" && record.id === id);
}

async function sendCommand(command: Record<string, unknown>): Promise<RpcResponseRecord> {
	if (!rpcIo.lineHandler) throw new Error("RPC input handler is not attached");
	const id = String(command.id);
	rpcIo.lineHandler(JSON.stringify(command));
	await vi.waitFor(() => expect(responsesFor(id)).toHaveLength(1));
	return responsesFor(id)[0];
}

function removeAddedSignalListeners(signal: NodeJS.Signals, existing: NodeJS.SignalsListener[]): void {
	const existingListeners = new Set(existing);
	for (const listener of process.listeners(signal)) {
		if (!existingListeners.has(listener)) process.removeListener(signal, listener);
	}
}

function removeAddedEndListeners(existing: Array<() => void>): void {
	const existingListeners = new Set(existing);
	for (const listener of process.stdin.listeners("end")) {
		const endListener = listener as () => void;
		if (!existingListeners.has(endListener)) process.stdin.removeListener("end", endListener);
	}
}

// Regression for https://github.com/fleetagent/pi/pull/7214
// RPC bash must take the same extension policy path as interactive !/!! commands.
describe("RPC bash user_bash policy (#7214)", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		vi.restoreAllMocks();
	});

	test("honors replacement results, custom operations, backend fallback, recording, context exclusion, and abort", async () => {
		const policyEvents: UserBashEvent[] = [];
		const backendOperations = new LocalToolOperations("/backend-workspace");
		const customOperations = new LocalToolOperations("/policy-workspace");
		const backendExec = vi.spyOn(backendOperations, "exec").mockImplementation(async (_command, options) => {
			options.onData(Buffer.from("backend-output"));
			return { exitCode: 0 };
		});
		let customSignal: AbortSignal | undefined;
		const customExec = vi.spyOn(customOperations, "exec").mockImplementation(async (command, options) => {
			if (command === "wait-for-abort") {
				customSignal = options.signal;
				return new Promise((resolve) => {
					options.signal?.addEventListener("abort", () => resolve({ exitCode: null }), { once: true });
				});
			}
			options.onData(Buffer.from("policy-output"));
			return { exitCode: 0 };
		});

		harness = await createHarness({
			toolOperations: backendOperations,
			extensionFactories: [
				(pi) => {
					pi.on("user_bash", (event) => {
						policyEvents.push(event);
						if (event.command.startsWith("replace")) {
							return {
								result: {
									output: "replacement-output",
									exitCode: 23,
									cancelled: false,
									truncated: false,
								},
							};
						}
						if (event.command === "custom" || event.command === "wait-for-abort") {
							return { operations: customOperations };
						}
						return undefined;
					});
				},
			],
		});

		const existingSigterm = process.listeners("SIGTERM");
		const existingSighup = process.listeners("SIGHUP");
		const existingEnd = process.stdin.listeners("end") as Array<() => void>;
		const runtimeHost = {
			session: harness.session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			listSessions: vi.fn(async () => []),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as PiAgentRuntimeHost;

		try {
			void runRpcMode(runtimeHost);
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			const replaced = await sendCommand({
				id: "replace-recorded",
				type: "bash",
				command: "replace-recorded",
				excludeFromContext: true,
			});
			expect(replaced).toMatchObject({
				command: "bash",
				success: true,
				data: { output: "replacement-output", exitCode: 23 },
			});
			expect(policyEvents[0]).toEqual({
				type: "user_bash",
				command: "replace-recorded",
				excludeFromContext: true,
				cwd: harness.session.session.getCwd(),
			});
			expect(harness.session.messages).toContainEqual(
				expect.objectContaining({
					role: "bashExecution",
					command: "replace-recorded",
					output: "replacement-output",
					excludeFromContext: true,
				}),
			);

			const recordedMessageCount = harness.session.messages.length;
			await sendCommand({
				id: "replace-unrecorded",
				type: "bash",
				command: "replace-unrecorded",
				record: false,
			});
			expect(harness.session.messages).toHaveLength(recordedMessageCount);
			expect(policyEvents[1]?.excludeFromContext).toBe(false);

			const custom = await sendCommand({
				id: "custom",
				type: "bash",
				command: "custom",
				record: false,
				truncate: false,
				excludeFromContext: true,
			});
			expect(custom.data).toMatchObject({ output: "policy-output", exitCode: 0, cancelled: false });
			expect(customExec).toHaveBeenCalledWith(
				"custom",
				expect.objectContaining({ cwd: "/policy-workspace", signal: expect.any(AbortSignal) }),
			);
			expect(backendExec).not.toHaveBeenCalled();

			const fallback = await sendCommand({ id: "fallback", type: "bash", command: "fallback", record: false });
			expect(fallback.data).toMatchObject({ output: "backend-output", exitCode: 0, cancelled: false });
			expect(backendExec).toHaveBeenCalledWith(
				"fallback",
				expect.objectContaining({ cwd: "/backend-workspace", signal: expect.any(AbortSignal) }),
			);

			if (!rpcIo.lineHandler) throw new Error("RPC input handler is not attached");
			rpcIo.lineHandler(
				JSON.stringify({ id: "cancelled-bash", type: "bash", command: "wait-for-abort", record: false }),
			);
			await vi.waitFor(() => expect(customSignal).toBeDefined());
			const abortResponse = await sendCommand({ id: "abort", type: "abort_bash" });
			expect(abortResponse).toMatchObject({ command: "abort_bash", success: true });
			await vi.waitFor(() => expect(responsesFor("cancelled-bash")).toHaveLength(1));
			expect(responsesFor("cancelled-bash")[0].data).toMatchObject({ cancelled: true });
			expect(customSignal?.aborted).toBe(true);
		} finally {
			removeAddedSignalListeners("SIGTERM", existingSigterm);
			removeAddedSignalListeners("SIGHUP", existingSighup);
			removeAddedEndListeners(existingEnd);
		}
	});
});
