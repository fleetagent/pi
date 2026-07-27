import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { getDefaultActiveToolNames } from "../src/core/agent-session.ts";
import {
	formatSandboxList,
	formatSandboxStartResult,
	formatSandboxStopResult,
	parseSandboxUserCommand,
} from "../src/core/sandbox/command.ts";
import { BUILTIN_SLASH_COMMANDS, HIDDEN_BUILTIN_SLASH_COMMAND_NAMES } from "../src/core/slash-commands.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SandboxHandlerContext = {
	session: {
		activateSandboxDaemon: (options: { url: string; token: string; expectedCwd: string }) => Promise<{
			type: "remote";
			cwd: string;
			url: string;
			protocol: "ws";
			configured: true;
			workspace: { id: string; root: string; pathFlavor: "posix" };
		}>;
		clearRemoteSandbox: () => Promise<void>;
	};
	activeSession: { getCwd: () => string };
	activeSandboxContainerId?: string;
	createDockerSandboxService: () => {
		start: (options: { workspaceRoot: string; image?: string }) => Promise<ReturnType<typeof createStartResult>>;
		list: (options: { workspaceRoot: string }) => Promise<ReturnType<typeof createContainer>[]>;
		stop: (options: { workspaceRoot: string; target?: string; currentContainerId?: string }) => Promise<{
			status: "stopped";
			container: ReturnType<typeof createContainer>;
		}>;
	};
	refreshUiAfterBackendChange: () => void;
	updateToolBackendStatus: () => void;
	formatToolBackendStatus: (info: { type: string; cwd: string; configured?: boolean; url?: string }) => string;
	showStatus: (message: string) => void;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	handleSandboxCommand(this: SandboxHandlerContext, text: string): Promise<void>;
};

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	handleSandboxCommand: (text: string) => Promise<void>;
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	return {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		handleSandboxCommand: vi.fn(async () => {}),
		pendingUserInputs: [],
	};
}

function createStartResult() {
	return {
		containerId: "abc123",
		containerName: "pi-sandbox-project-hash",
		workspaceRoot: "/host/project",
		workspaceMountPath: "/workspace",
		daemonUrl: "ws://127.0.0.1:49153/pi/workspace",
		daemonUrlRedacted: "ws://127.0.0.1:49153/pi/workspace",
		token: "secret-token",
		labels: {},
	};
}

function createContainer() {
	return {
		id: "abc123",
		name: "pi-sandbox-project-hash",
		image: "pi-sandbox:test",
		status: "Up 1s",
		state: "running",
		createdAt: "2026-01-01T00:00:00Z",
		workspaceRoot: "/host/project",
		workspaceMountPath: "/workspace",
		daemonPort: 8787,
		daemonEndpoint: "127.0.0.1:49153->8787/tcp",
		labels: {},
	};
}

describe("hidden sandbox command", () => {
	it("parses supported user-only sandbox commands and rejects unsupported arguments", () => {
		expect(parseSandboxUserCommand("/sandbox start")).toEqual({ subcommand: "start" });
		expect(parseSandboxUserCommand('/sandbox start --image "pi sandbox:test"')).toEqual({
			subcommand: "start",
			image: "pi sandbox:test",
		});
		expect(parseSandboxUserCommand("/sandbox list")).toEqual({ subcommand: "list" });
		expect(parseSandboxUserCommand("/sandbox stop abc123")).toEqual({ subcommand: "stop", target: "abc123" });
		expect(() => parseSandboxUserCommand("/sandbox start --token secret")).toThrow(
			"Unsupported /sandbox start argument",
		);
		expect(() => parseSandboxUserCommand("/sandbox rm abc123")).toThrow("Unsupported /sandbox subcommand");
		expect(() => parseSandboxUserCommand("/sandbox stop one two")).toThrow("Usage: /sandbox stop");
	});

	it("formats clear user-facing lifecycle output", () => {
		expect(
			formatSandboxStartResult({
				containerId: "abc123",
				containerName: "pi-sandbox-project-hash",
				workspaceRoot: "/host/project",
				workspaceMountPath: "/workspace",
				daemonUrl: "ws://127.0.0.1:49153/pi/workspace",
				daemonUrlRedacted: "ws://127.0.0.1:49153/pi/workspace",
				token: "secret-token",
				labels: {},
			}),
		).toContain("Sandbox started: pi-sandbox-project-hash (abc123)");
		expect(
			formatSandboxList([
				{
					id: "abc123",
					name: "pi-sandbox-project-hash",
					image: "pi-sandbox:test",
					status: "Up 1s",
					state: "running",
					createdAt: "2026-01-01T00:00:00Z",
					workspaceRoot: "/host/project",
					workspaceMountPath: "/workspace",
					daemonPort: 8787,
					daemonEndpoint: "127.0.0.1:49153->8787/tcp",
					labels: {},
				},
			]),
		).toContain("abc123\tpi-sandbox-project-hash\trunning\tpi-sandbox:test");
		expect(formatSandboxList([])).toBe("No Pi sandbox containers found for this workspace.");
		expect(
			formatSandboxStopResult({
				status: "already-stopped",
				container: {
					id: "abc123",
					name: "pi-sandbox-project-hash",
					image: "pi-sandbox:test",
					status: "Exited",
					state: "exited",
					createdAt: undefined,
					workspaceRoot: undefined,
					workspaceMountPath: "/workspace",
					daemonPort: 8787,
					daemonEndpoint: undefined,
					labels: {},
				},
			}),
		).toBe("Sandbox already stopped: pi-sandbox-project-hash (abc123)");
	});

	it("dispatches /sandbox through the interactive submit path without queueing it as a prompt", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" /sandbox\tlist ");

		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.handleSandboxCommand).toHaveBeenCalledWith("/sandbox\tlist");
		expect(context.pendingUserInputs).toEqual([]);
		expect(context.flushPendingBashComponents).not.toHaveBeenCalled();
		expect(context.session.prompt).not.toHaveBeenCalled();
	});

	it("dispatches start, list, and stop to the sandbox service and renders output", async () => {
		const start = vi.fn(async () => createStartResult());
		const list = vi.fn(async () => [createContainer()]);
		const stop = vi.fn(async () => ({ status: "stopped" as const, container: createContainer() }));
		const activateSandboxDaemon = vi.fn(async () => ({
			type: "remote" as const,
			cwd: "/workspace",
			url: "ws://127.0.0.1:49153/pi/workspace",
			protocol: "ws" as const,
			configured: true as const,
			workspace: { id: "workspace-id", root: "/workspace", pathFlavor: "posix" as const },
		}));
		const clearRemoteSandbox = vi.fn(async () => {});
		const showStatus = vi.fn();
		const context: SandboxHandlerContext = {
			session: { activateSandboxDaemon, clearRemoteSandbox },
			activeSession: { getCwd: () => "/host/project" },
			createDockerSandboxService: () => ({ start, list, stop }),
			refreshUiAfterBackendChange: vi.fn(),
			updateToolBackendStatus: vi.fn(),
			formatToolBackendStatus: (info) => `tools: ${info.type} ${info.cwd}`,
			showStatus,
			showWarning: vi.fn(),
			showError: vi.fn(),
		};

		await interactiveModePrototype.handleSandboxCommand.call(context, "/sandbox start --image pi-sandbox:test");
		await interactiveModePrototype.handleSandboxCommand.call(context, "/sandbox list");
		await interactiveModePrototype.handleSandboxCommand.call(context, "/sandbox stop abc123");

		expect(start).toHaveBeenCalledWith({ workspaceRoot: "/host/project", image: "pi-sandbox:test" });
		expect(activateSandboxDaemon).toHaveBeenCalledWith({
			url: "ws://127.0.0.1:49153/pi/workspace",
			token: "secret-token",
			expectedCwd: "/workspace",
		});
		expect(list).toHaveBeenCalledWith({ workspaceRoot: "/host/project" });
		expect(stop).toHaveBeenCalledWith({
			workspaceRoot: "/host/project",
			target: "abc123",
			currentContainerId: "abc123",
		});
		expect(showStatus.mock.calls.map((call) => call[0]).join("\n")).toContain("Sandbox started");
		expect(showStatus.mock.calls.map((call) => call[0]).join("\n")).toContain("pi-sandbox:test");
		expect(showStatus.mock.calls.map((call) => call[0]).join("\n")).toContain("Sandbox stopped");
		expect(clearRemoteSandbox).toHaveBeenCalledOnce();
	});

	it("shows /sandbox in user autocomplete but not model-visible command, prompt, or tool catalogs", () => {
		expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).toContain("sandbox");
		expect(HIDDEN_BUILTIN_SLASH_COMMAND_NAMES.has("sandbox")).toBe(true);
		expect(getDefaultActiveToolNames()).not.toContain("sandbox");
		expect(buildSystemPrompt({ cwd: process.cwd(), selectedTools: getDefaultActiveToolNames() })).not.toContain(
			"/sandbox",
		);
		const rpcModeSource = readFileSync(new URL("../src/modes/rpc/rpc-mode.ts", import.meta.url), "utf8");
		expect(rpcModeSource).not.toContain('"/sandbox"');
		expect(rpcModeSource).toContain("HIDDEN_BUILTIN_SLASH_COMMAND_NAMES.has(command.name)");
		const agentSessionSource = readFileSync(new URL("../src/core/agent-session.ts", import.meta.url), "utf8");
		expect(agentSessionSource).not.toContain('"/sandbox"');
		expect(agentSessionSource).toContain("HIDDEN_BUILTIN_SLASH_COMMAND_NAMES.has(command.name)");
	});
});
