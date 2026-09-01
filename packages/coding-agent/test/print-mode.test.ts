import type { AssistantMessage, ImageContent, StopReason } from "@fleetagent/pi-ai";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: Mock<(event: EmitEvent) => Promise<void>>;
};

interface FakeSessionStore {
	getHeader: () => object | undefined;
}

interface FakeAgent {
	waitForIdle: () => Promise<void>;
	subscribe: Mock;
}

interface FakeSessionState {
	messages: AssistantMessage[];
}

interface FakeSession {
	session: FakeSessionStore;
	agent: FakeAgent;
	waitForIdle: () => Promise<void>;
	state: FakeSessionState;
	extensionRunner: FakeExtensionRunner;
	bindExtensions: Mock;
	subscribe: Mock;
	prompt: Mock;
	reload: Mock;
}

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: Mock;
	fork: Mock;
	switchSession: Mock;
	dispose: Mock;
	setRebindSession: Mock;
};

interface AssistantMessageFixtureOptions {
	text?: string;
	stopReason?: StopReason;
	errorMessage?: string;
}

function createAssistantMessage(options?: AssistantMessageFixtureOptions): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(assistantMessage: AssistantMessage): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };

	const session: FakeSession = {
		session: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {}, subscribe: vi.fn(() => vi.fn()) },
		waitForIdle: vi.fn(async () => {}),
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("keeps LaTeX and Mermaid source unchanged in text output", async () => {
		const source = "$\\frac{1}{2}$\n\n```mermaid\nflowchart LR\nA --> B\n```";
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: source }));
		const writes: string[] = [];
		const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		): boolean => {
			writes.push(String(chunk));
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			done?.();
			return true;
		}) as typeof process.stdout.write);

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(0);
		expect(writes.join("")).toBe(`${source}\n`);
		expect(writes.join("")).not.toContain("┌");
		stdoutWrite.mockRestore();
	});

	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.waitForIdle).toHaveBeenCalled();
		expect(session.agent.subscribe).not.toHaveBeenCalled();
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.waitForIdle).toHaveBeenCalled();
		expect(session.agent.subscribe).toHaveBeenCalledTimes(1);
		expect(session.agent.subscribe.mock.results[0]?.value).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});
});
