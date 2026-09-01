import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ActivateSandboxDaemonOptions } from "../src/core/agent-session.ts";
import { getDefaultActiveToolNames } from "../src/core/agent-session.ts";
import {
	formatSandboxList,
	formatSandboxStartResult,
	formatSandboxStopResult,
	parseSandboxUserCommand,
} from "../src/core/sandbox/command.ts";
import type {
	SandboxConfig,
	SandboxContainer,
	SandboxListOptions,
	SandboxStartOptions,
	SandboxStartResult,
	SandboxStopOptions,
	SandboxStopResult,
} from "../src/core/sandbox/docker.ts";
import { BUILTIN_SLASH_COMMANDS, HIDDEN_BUILTIN_SLASH_COMMAND_NAMES } from "../src/core/slash-commands.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import type { ToolBackendInfo } from "../src/core/tools/operations.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface SandboxSessionStub {
	activateSandboxDaemon(options: ActivateSandboxDaemonOptions): Promise<ToolBackendInfo>;
	getToolBackendInfo(): ToolBackendInfo;
	clearRemoteSandbox(): Promise<void>;
}

interface ActiveSandboxSessionStub {
	getCwd(): string;
	getSessionId(): string;
}

interface SandboxServiceStub {
	resolveConfig(): Pick<SandboxConfig, "workspaceMountPath">;
	start(options: SandboxStartOptions): Promise<SandboxStartResult>;
	list(options: SandboxListOptions): Promise<SandboxContainer[]>;
	stop(options: SandboxStopOptions): Promise<SandboxStopResult>;
}

interface SandboxHandlerContext {
	session: SandboxSessionStub;
	activeSession: ActiveSandboxSessionStub;
	sessionSandboxStates: Map<string, unknown>;
	managedSandboxContainers: Map<string, unknown>;
	activeSandboxContainerId?: string;
	activeSandboxBackendConnected?: boolean;
	createDockerSandboxService(): SandboxServiceStub;
	refreshUiAfterBackendChange(): void;
	updateToolBackendStatus(): void;
	formatToolBackendStatus(info: ToolBackendInfo): string;
	showStatus(message: string): void;
	showWarning(message: string): void;
	showError(message: string): void;
}

interface RuntimeHostStub {
	dispose(): Promise<void>;
}

interface ManagedSandboxCleanupServiceStub {
	stopManagedContainers(): Promise<void>;
}

interface RuntimeResourceDisposalContext {
	runtimeHost: RuntimeHostStub;
	createDockerSandboxService(): ManagedSandboxCleanupServiceStub;
}

interface InteractiveModePrivate {
	setupEditorSubmitHandler(this: SubmitContext): void;
	handleSandboxCommand(this: SandboxHandlerContext, text: string): Promise<void>;
	restoreCurrentSessionSandbox(this: SandboxHandlerContext): Promise<void>;
	disposeRuntimeResources(this: RuntimeResourceDisposalContext): Promise<Error[]>;
}

interface SandboxSubmitDefaultEditor {
	onSubmit?: (text: string) => Promise<void>;
}

interface SandboxSubmitEditor {
	addToHistory?: (text: string) => void;
	setText: (text: string) => void;
}

interface SandboxSubmitSession {
	isCompacting: boolean;
	isStreaming: boolean;
	isBashRunning: boolean;
	prompt: (text: string, options?: unknown) => Promise<void>;
}

interface SubmitContext {
	defaultEditor: SandboxSubmitDefaultEditor;
	editor: SandboxSubmitEditor;
	session: SandboxSubmitSession;
	flushPendingBashComponents: () => void;
	handleSandboxCommand: (text: string) => Promise<void>;
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
}

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	const context = Object.create(InteractiveMode.prototype) as SubmitContext;
	Object.defineProperties(
		context,
		Object.getOwnPropertyDescriptors({
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
		}),
	);
	return context;
}

function createStartResult(): SandboxStartResult {
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

function createContainer(): SandboxContainer {
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
		expect(parseSandboxUserCommand("/sandbox")).toEqual({ subcommand: "status" });
		expect(parseSandboxUserCommand("/sandbox status")).toEqual({ subcommand: "status" });
		expect(parseSandboxUserCommand("/sandbox clear")).toEqual({ subcommand: "clear" });
		expect(parseSandboxUserCommand("/sandbox --attach ws://127.0.0.1:8787/pi/workspace")).toEqual({
			subcommand: "attach",
			url: "ws://127.0.0.1:8787/pi/workspace",
		});
		expect(parseSandboxUserCommand("/sandbox start")).toEqual({ subcommand: "start" });
		expect(parseSandboxUserCommand('/sandbox start --image "pi sandbox:test"')).toEqual({
			subcommand: "start",
			image: "pi sandbox:test",
		});
		expect(parseSandboxUserCommand("/sandbox list")).toEqual({ subcommand: "list" });
		expect(parseSandboxUserCommand("/sandbox stop abc123")).toEqual({ subcommand: "stop", target: "abc123" });
		expect(() => parseSandboxUserCommand("/sandbox --attach")).toThrow("Usage: /sandbox --attach");
		expect(() => parseSandboxUserCommand("/sandbox --attach one two")).toThrow("Usage: /sandbox --attach");
		expect(() => parseSandboxUserCommand("/sandbox ssh user@host")).toThrow("Unsupported /sandbox subcommand");
		expect(() => parseSandboxUserCommand("/sandbox status extra")).toThrow("Usage: /sandbox status");
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
		expect(context.session.prompt).not.toHaveBeenCalled();

		await context.defaultEditor.onSubmit?.("/remote status");
		expect(context.handleSandboxCommand).toHaveBeenCalledOnce();
		expect(context.pendingUserInputs).toEqual(["/remote status"]);
	});

	it("restores only the sandbox owned by the active session", async () => {
		let sessionId = "session-a";
		const activateSandboxDaemon = vi.fn(async () => ({
			type: "remote" as const,
			cwd: "/workspace",
			url: "ws://127.0.0.1:49153/pi/workspace",
			protocol: "ws" as const,
			configured: true as const,
			workspace: { id: "workspace-id", root: "/workspace", pathFlavor: "posix" as const },
		}));
		const context: SandboxHandlerContext = {
			session: {
				activateSandboxDaemon,
				getToolBackendInfo: () => ({ type: "local", cwd: "/host/project" }),
				clearRemoteSandbox: vi.fn(),
			},
			activeSession: { getCwd: () => "/host/project", getSessionId: () => sessionId },
			sessionSandboxStates: new Map([
				[
					"/host/project\0session-a",
					{
						type: "daemon",
						url: "ws://127.0.0.1:49153/pi/workspace",
						token: "session-token",
						expectedCwd: "/workspace",
						containerId: "container-a",
					},
				],
			]),
			managedSandboxContainers: new Map(),
			createDockerSandboxService: vi.fn(),
			refreshUiAfterBackendChange: vi.fn(),
			updateToolBackendStatus: vi.fn(),
			formatToolBackendStatus: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		};
		Object.setPrototypeOf(context, InteractiveMode.prototype);

		await interactiveModePrototype.restoreCurrentSessionSandbox.call(context);
		expect(activateSandboxDaemon).toHaveBeenCalledWith({
			url: "ws://127.0.0.1:49153/pi/workspace",
			token: "session-token",
			expectedCwd: "/workspace",
		});
		expect(context.activeSandboxContainerId).toBe("container-a");
		expect(context.activeSandboxBackendConnected).toBe(true);

		sessionId = "session-b";
		await interactiveModePrototype.restoreCurrentSessionSandbox.call(context);
		expect(activateSandboxDaemon).toHaveBeenCalledOnce();
		expect(context.activeSandboxContainerId).toBeUndefined();
		expect(context.activeSandboxBackendConnected).toBe(false);

		sessionId = "session-a";
		context.activeSandboxContainerId = "container-a";
		context.activeSandboxBackendConnected = false;
		await interactiveModePrototype.handleSandboxCommand.call(context, "/sandbox clear");
		expect(context.sessionSandboxStates.size).toBe(0);
		expect(context.session.clearRemoteSandbox).not.toHaveBeenCalled();
	});

	it("blocks replacement backends while a failed-start container awaits cleanup", async () => {
		const start = vi.fn(async () => createStartResult());
		const showWarning = vi.fn();
		const activateSandboxDaemon = vi.fn(async () => ({
			type: "remote" as const,
			cwd: "/workspace",
			url: "ws://daemon.test/pi/workspace",
			protocol: "ws" as const,
			configured: true as const,
			workspace: { id: "workspace", root: "/workspace", pathFlavor: "posix" as const },
		}));
		const context: SandboxHandlerContext = {
			session: {
				activateSandboxDaemon,
				getToolBackendInfo: () => ({ type: "local", cwd: "/host/project" }),
				clearRemoteSandbox: vi.fn(),
			},
			activeSession: { getCwd: () => "/host/project", getSessionId: () => "session-a" },
			sessionSandboxStates: new Map(),
			managedSandboxContainers: new Map([
				["orphaned-container", { workspaceRoot: "/host/project", daemonPort: 49300, ownerId: "session-a" }],
			]),
			activeSandboxContainerId: undefined,
			activeSandboxBackendConnected: false,
			createDockerSandboxService: () => ({
				resolveConfig: () => ({ workspaceMountPath: "/workspace" }),
				start,
				list: vi.fn(),
				stop: vi.fn(),
			}),
			refreshUiAfterBackendChange: vi.fn(),
			updateToolBackendStatus: vi.fn(),
			formatToolBackendStatus: vi.fn(),
			showStatus: vi.fn(),
			showWarning,
			showError: vi.fn(),
		};
		Object.setPrototypeOf(context, InteractiveMode.prototype);

		await interactiveModePrototype.handleSandboxCommand.call(context, "/sandbox start");
		context.managedSandboxContainers.clear();
		context.activeSandboxContainerId = "orphaned-container";
		await interactiveModePrototype.handleSandboxCommand.call(context, "/sandbox start");
		expect(start).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledTimes(2);
		expect(showWarning).toHaveBeenLastCalledWith(expect.stringContaining("awaiting cleanup"));

		context.activeSandboxContainerId = undefined;
		context.managedSandboxContainers.set("other-session-container", {
			workspaceRoot: "/host/project",
			daemonPort: 49301,
			ownerId: "session-b",
		});
		await interactiveModePrototype.handleSandboxCommand.call(
			context,
			"/sandbox --attach ws://daemon.test/pi/workspace",
		);
		expect(activateSandboxDaemon).toHaveBeenCalledOnce();
	});

	it("preserves active sandbox guards when backend clearing fails after Docker disappears", async () => {
		const clearRemoteSandbox = vi.fn(async () => {
			throw new Error("disconnect failed");
		});
		const showError = vi.fn();
		const context: SandboxHandlerContext = {
			session: {
				activateSandboxDaemon: vi.fn(),
				getToolBackendInfo: () => ({ type: "local", cwd: "/host/project" }),
				clearRemoteSandbox,
			},
			activeSession: { getCwd: () => "/host/project", getSessionId: () => "session-a" },
			sessionSandboxStates: new Map([["/host/project\0session-a", { type: "daemon" }]]),
			managedSandboxContainers: new Map(),
			activeSandboxContainerId: "missing-container",
			activeSandboxBackendConnected: true,
			createDockerSandboxService: () => ({
				resolveConfig: () => ({ workspaceMountPath: "/workspace" }),
				start: vi.fn(),
				list: vi.fn(),
				stop: vi.fn(async () => ({ status: "not-found" as const, message: "missing" })),
			}),
			refreshUiAfterBackendChange: vi.fn(),
			updateToolBackendStatus: vi.fn(),
			formatToolBackendStatus: vi.fn(),
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError,
		};
		Object.setPrototypeOf(context, InteractiveMode.prototype);

		await interactiveModePrototype.handleSandboxCommand.call(context, "/sandbox stop");
		expect(clearRemoteSandbox).toHaveBeenCalledOnce();
		expect(context.activeSandboxContainerId).toBe("missing-container");
		expect(context.activeSandboxBackendConnected).toBe(true);
		expect(context.sessionSandboxStates.size).toBe(1);
		expect(showError).toHaveBeenCalledWith("disconnect failed");
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
			session: {
				activateSandboxDaemon,
				getToolBackendInfo: () => ({ type: "local", cwd: "/host/project" }),
				clearRemoteSandbox,
			},
			activeSession: { getCwd: () => "/host/project", getSessionId: () => "session-a" },
			sessionSandboxStates: new Map(),
			managedSandboxContainers: new Map(),
			createDockerSandboxService: () => ({
				resolveConfig: () => ({ workspaceMountPath: "/workspace" }),
				start,
				list,
				stop,
			}),
			refreshUiAfterBackendChange: vi.fn(),
			updateToolBackendStatus: vi.fn(),
			formatToolBackendStatus: (info) => `tools: ${info.type} ${info.cwd}`,
			showStatus,
			showWarning: vi.fn(),
			showError: vi.fn(),
		};
		Object.setPrototypeOf(context, InteractiveMode.prototype);

		await interactiveModePrototype.handleSandboxCommand.call(context, "/sandbox start --image pi-sandbox:test");
		await interactiveModePrototype.handleSandboxCommand.call(context, "/sandbox list");
		await interactiveModePrototype.handleSandboxCommand.call(context, "/sandbox stop abc123");

		expect(start).toHaveBeenCalledWith({
			workspaceRoot: "/host/project",
			image: "pi-sandbox:test",
			sessionId: "session-a",
		});
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

	it("attaches and detaches an existing sandbox daemon without using Docker lifecycle commands", async () => {
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
			session: {
				activateSandboxDaemon,
				getToolBackendInfo: () => ({
					type: "remote" as const,
					cwd: "/custom-workspace",
					configured: false as const,
				}),
				clearRemoteSandbox,
			},
			activeSession: { getCwd: () => "/host/project", getSessionId: () => "session-a" },
			sessionSandboxStates: new Map(),
			managedSandboxContainers: new Map(),
			createDockerSandboxService: () => ({
				resolveConfig: () => ({ workspaceMountPath: "/workspace" }),
				start,
				list,
				stop,
			}),
			refreshUiAfterBackendChange: vi.fn(),
			updateToolBackendStatus: vi.fn(),
			formatToolBackendStatus: (info) => `tools: ${info.type} ${info.cwd}`,
			showStatus,
			showWarning: vi.fn(),
			showError: vi.fn(),
		};
		Object.setPrototypeOf(context, InteractiveMode.prototype);

		await interactiveModePrototype.handleSandboxCommand.call(
			context,
			"/sandbox --attach ws://127.0.0.1:49153/pi/workspace",
		);
		await interactiveModePrototype.handleSandboxCommand.call(context, "/sandbox stop");

		expect(activateSandboxDaemon).toHaveBeenCalledWith({
			url: "ws://127.0.0.1:49153/pi/workspace",
			token: process.env.PI_REMOTE_TOKEN ?? "",
			expectedCwd: "/custom-workspace",
		});
		expect(stop).not.toHaveBeenCalled();
		expect(clearRemoteSandbox).toHaveBeenCalledOnce();
		expect(showStatus.mock.calls.map((call) => call[0]).join("\n")).toContain("Sandbox attached");
		expect(showStatus.mock.calls.map((call) => call[0]).join("\n")).toContain("Sandbox detached");
	});

	it("shows /sandbox in user autocomplete but not model-visible command, prompt, or tool catalogs", () => {
		expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).toContain("sandbox");
		expect(BUILTIN_SLASH_COMMANDS.map((command) => command.name)).not.toContain("remote");
		expect(HIDDEN_BUILTIN_SLASH_COMMAND_NAMES.has("sandbox")).toBe(true);
		expect(getDefaultActiveToolNames()).not.toContain("sandbox");
		expect(buildSystemPrompt({ cwd: process.cwd(), selectedTools: getDefaultActiveToolNames() })).not.toContain(
			"/sandbox",
		);
		const rpcModeSource = readFileSync(new URL("../src/modes/rpc/rpc-mode.ts", import.meta.url), "utf8");
		expect(rpcModeSource).not.toContain('"/sandbox"');
		expect(rpcModeSource).toContain("HIDDEN_BUILTIN_SLASH_COMMAND_NAMES.has(registeredCommand.name)");
		const agentSessionSource = readFileSync(new URL("../src/core/agent-session.ts", import.meta.url), "utf8");
		expect(agentSessionSource).not.toContain('"/sandbox"');
		expect(agentSessionSource).toContain("HIDDEN_BUILTIN_SLASH_COMMAND_NAMES.has(command.name)");
	});
	it("disposes the runtime and every managed sandbox during shutdown cleanup", async () => {
		const dispose = vi.fn(async () => {});
		const stopManagedContainers = vi.fn(async () => {});

		await expect(
			interactiveModePrototype.disposeRuntimeResources.call({
				runtimeHost: { dispose },
				createDockerSandboxService: () => ({ stopManagedContainers }),
			}),
		).resolves.toEqual([]);
		expect(dispose).toHaveBeenCalledOnce();
		expect(stopManagedContainers).toHaveBeenCalledOnce();
		expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(stopManagedContainers.mock.invocationCallOrder[0]);
	});
});
