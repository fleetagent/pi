import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@fleetagent/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { LspConnectionFactory } from "../../src/core/lsp/transport.ts";
import { PiAgent, type PiAgentSessionOptions } from "../../src/core/pi-agent.ts";
import { InMemorySessionManager, LocalSessionManager } from "../../src/core/session-manager.ts";
import type {
	ExtensionAPI,
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/index.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("PiAgent session replacement characterization", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(
		extensionFactory: ExtensionFactory,
		options?: {
			cwd?: string;
			bootstrapModel?: boolean;
			bootstrapThinkingLevel?: boolean;
			failReplacementBuild?: { current: boolean };
			lsp?: PiAgentSessionOptions["lsp"];
			lspConnectionFactories?: PiAgentSessionOptions["lspConnectionFactories"];
		},
	) {
		const tempDir =
			options?.cwd ?? join(tmpdir(), `pi-runtime-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const model = options?.bootstrapModel === false ? undefined : faux.getModel();
		const thinkingLevel = options?.bootstrapThinkingLevel === false ? undefined : undefined;
		const runtime = await PiAgent.create({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			sessionManager: new LocalSessionManager({ cwd: tempDir }),
			lsp: options?.lsp,
			lspConnectionFactories: options?.lspConnectionFactories,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
						extensionFactory(pi);
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
			resolveSessionOptions: () => {
				if (options?.failReplacementBuild?.current) throw new Error("replacement build failed");
				return { model, thinkingLevel };
			},
		});
		await runtime.createAgentSession();
		await runtime.session.bindExtensions({});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime, faux, tempDir };
	}

	it("reuses one local ToolOperations identity across runtime hooks", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const first = runtime.session.getToolOperations();
		expect(runtime.session.getToolOperations()).toBe(first);
		expect(runtime.session.getToolBackendInfo()).toEqual(first.getBackendInfo?.());
	});

	it("updates the stable local ToolOperations shell path on reload", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const operations = runtime.session.getToolOperations();
		const reloadedShellPath = join(tmpdir(), "reloaded-shell");
		runtime.session.settingsManager.getShellPath = () => reloadedShellPath;
		await runtime.session.reload();
		expect(runtime.session.getToolOperations()).toBe(operations);
		expect((operations as unknown as { shellPath?: string }).shellPath).toBe(reloadedShellPath);
	});

	it("persists message_end assistant replacements to the session manager", async () => {
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("message_end", (event) => {
				if (event.message.role !== "assistant") return;

				return {
					message: {
						...event.message,
						usage: {
							...event.message.usage,
							cost: {
								...event.message.usage.cost,
								total: 0.123,
							},
						},
					},
				};
			});
		});

		await runtime.session.prompt("hello");

		const sessionAssistant = runtime.session.messages.find((message) => message.role === "assistant");
		expect(sessionAssistant?.role).toBe("assistant");
		if (sessionAssistant?.role !== "assistant") {
			throw new Error("missing assistant message");
		}
		expect(sessionAssistant.usage.cost.total).toBe(0.123);

		const persistedAssistant = runtime.session.session
			.getEntries()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message)
			.find((message) => message.role === "assistant");
		expect(persistedAssistant?.role).toBe("assistant");
		if (persistedAssistant?.role !== "assistant") {
			throw new Error("missing persisted assistant message");
		}
		expect(persistedAssistant.usage.cost.total).toBe(0.123);
	});

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;
		const originalSession = runtime.session;

		const newSessionResult = await runtime.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(runtime.session).not.toBe(originalSession);
		expect(runtime.session.messages).toEqual([]);
		const secondSessionFile = runtime.session.sessionFile;
		expect(events).toEqual([
			{
				type: "session_before_switch",
				reason: "new",
				targetSessionReference: undefined,
				targetSessionFile: undefined,
			},
			{
				type: "session_shutdown",
				reason: "new",
				targetSessionReference: secondSessionFile,
				targetSessionFile: secondSessionFile,
			},
			{
				type: "session_start",
				reason: "new",
				previousSessionReference: originalSessionFile,
				previousSessionFile: originalSessionFile,
			},
		]);

		events.length = 0;

		const switchResult = await runtime.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{
				type: "session_before_switch",
				reason: "resume",
				targetSessionReference: originalSessionFile,
				targetSessionFile: originalSessionFile,
			},
			{
				type: "session_shutdown",
				reason: "resume",
				targetSessionReference: originalSessionFile,
				targetSessionFile: originalSessionFile,
			},
			{
				type: "session_start",
				reason: "resume",
				previousSessionReference: secondSessionFile,
				previousSessionFile: secondSessionFile,
			},
		]);
	});

	it("keeps the current session usable when replacement construction fails", async () => {
		const failReplacementBuild = { current: false };
		const lifecycleEvents: string[] = [];
		const { runtime } = await createRuntimeForTest(
			(pi) => {
				pi.on("session_shutdown", () => {
					lifecycleEvents.push("shutdown");
				});
			},
			{ failReplacementBuild },
		);
		const originalSession = runtime.session;
		const originalSessionReference = originalSession.sessionReference;

		failReplacementBuild.current = true;
		await expect(runtime.newSession()).rejects.toThrow("replacement build failed");
		failReplacementBuild.current = false;

		expect(runtime.session).toBe(originalSession);
		expect(runtime.session.sessionReference).toBe(originalSessionReference);
		expect(lifecycleEvents).toEqual([]);
		await runtime.session.prompt("still usable");
		expect(runtime.session.messages.at(-1)).toMatchObject({ role: "assistant" });
	});

	it("keeps the current session usable when pre-commit invalidation fails", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const originalSession = runtime.session;
		runtime.setBeforeSessionInvalidate(() => {
			throw new Error("invalidation failed");
		});

		await expect(runtime.newSession()).rejects.toThrow("invalidation failed");
		runtime.setBeforeSessionInvalidate(undefined);

		expect(runtime.session).toBe(originalSession);
		await runtime.session.prompt("still usable after invalidation failure");
		expect(runtime.session.messages.at(-1)).toMatchObject({ role: "assistant" });
	});

	it("awaits tool-operation and LSP shutdown during disposal", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		let resolveTools!: () => void;
		let resolveLsp!: () => void;
		const toolsDisposed = new Promise<void>((resolve) => {
			resolveTools = resolve;
		});
		const lspDisposed = new Promise<void>((resolve) => {
			resolveLsp = resolve;
		});
		const sessionInternals = runtime.session as unknown as {
			_localResourceToolOperations?: { dispose(): Promise<void> };
			_lspRuntimeState?: { manager: { shutdownAll(): Promise<void> } };
		};
		sessionInternals._localResourceToolOperations = { dispose: () => toolsDisposed };
		sessionInternals._lspRuntimeState = { manager: { shutdownAll: () => lspDisposed } };

		let settled = false;
		const disposal = runtime.session.dispose().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		resolveTools();
		await Promise.resolve();
		expect(settled).toBe(false);
		resolveLsp();
		await disposal;
		expect(settled).toBe(true);
	});

	it("waits for an accepted reload before disposing and rejects later transitions", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		let releaseReload!: () => void;
		let markReloadStarted!: () => void;
		const reloadGate = new Promise<void>((resolve) => {
			releaseReload = resolve;
		});
		const reloadStarted = new Promise<void>((resolve) => {
			markReloadStarted = resolve;
		});
		const settingsManager = runtime.session.settingsManager;
		const originalReload = settingsManager.reload.bind(settingsManager);
		settingsManager.reload = async () => {
			markReloadStarted();
			await reloadGate;
			await originalReload();
		};
		const reload = runtime.session.reload();
		await reloadStarted;
		let disposalFinished = false;
		const disposal = runtime.session.dispose().then(() => {
			disposalFinished = true;
		});
		await Promise.resolve();
		expect(disposalFinished).toBe(false);
		await expect(runtime.session.configureLsp({ enabled: false })).rejects.toThrow(
			"Cannot configure LSP after AgentSession disposal",
		);
		releaseReload();
		await Promise.all([reload, disposal]);
		expect(disposalFinished).toBe(true);
	});
	it("honors session_before_switch cancellation for new and resume", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelReason: "new" | "resume" | undefined;
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				if (event.reason === cancelReason) {
					return { cancel: true };
				}
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;

		cancelReason = "new";
		const newResult = await runtime.newSession();
		expect(newResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);

		events.length = 0;
		const otherDir = join(tmpdir(), `pi-runtime-other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(otherDir, { recursive: true });
		const otherSession = new LocalSessionManager({ cwd: otherDir }).create();
		otherSession.appendMessage({ role: "user", content: [{ type: "text", text: "other" }], timestamp: Date.now() });
		const otherSessionFile = otherSession.getSessionReference();
		cancelReason = "resume";
		const resumeResult = await runtime.switchSession(otherSessionFile!);
		expect(resumeResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		events.length = 0;
		await runtime.session.prompt("hello");
		const userMessage = runtime.session.getUserMessagesForForking()[0]!;
		const previousSessionFile = runtime.session.sessionFile;

		const successResult = await runtime.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{
				type: "session_shutdown",
				reason: "fork",
				targetSessionReference: runtime.session.sessionReference,
				targetSessionFile: runtime.session.sessionReference,
			},
			{ type: "session_start", reason: "fork", previousSessionReference: previousSessionFile, previousSessionFile },
		]);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtime.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtime.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});

	it("duplicates the current active branch when forking at the current position", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const previousSessionFile = runtime.session.sessionFile;
		const leafId = runtime.session.session.getLeafId();
		expect(leafId).toBeTruthy();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, selectedText: undefined });
		expect(runtime.session.sessionFile).not.toBe(previousSessionFile);
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("duplicates the current active branch in-memory when forking at the current position", async () => {
		const tempDir = join(tmpdir(), `pi-runtime-suite-in-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtime = await PiAgent.create({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			sessionManager: new InMemorySessionManager(tempDir),
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
			resolveSessionOptions: () => ({ model: faux.getModel() }),
		});
		await runtime.createAgentSession();
		await runtime.session.bindExtensions({});
		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const leafId = runtime.session.session.getLeafId();
		expect(leafId).toBeTruthy();
		expect(runtime.session.sessionReference).toMatch(/^memory:/);

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, selectedText: undefined });
		expect(runtime.session.sessionReference).toMatch(/^memory:/);
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("throws when forking with an invalid entry id", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await expect(runtime.fork("missing-entry")).rejects.toThrow("Invalid entry ID for forking");
	});

	it("preserves the single lazy LSP runtime across same- and cross-cwd session replacement", async () => {
		const firstDir = join(tmpdir(), `pi-runtime-lsp-a-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const secondDir = join(tmpdir(), `pi-runtime-lsp-b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(firstDir, { recursive: true });
		mkdirSync(secondDir, { recursive: true });
		cleanups.push(() => rmSync(secondDir, { recursive: true, force: true }));
		const connectionRoots: string[] = [];
		const connectionFactory: LspConnectionFactory = async (context) => {
			connectionRoots.push(context.workspaceRoot);
			throw new Error("intentional faux LSP connection failure");
		};
		const lsp = {
			type: "configuration" as const,
			configuration: {
				servers: [
					{
						id: "suite",
						selectors: [{ languageId: "typescript", pattern: "**/*.ts" }],
						transport: { type: "connection" as const, id: "suite-factory" },
						lifecycle: { type: "attached" as const },
						workspace: { type: "session" as const },
					},
				],
			},
		};
		const { runtime } = await createRuntimeForTest(() => {}, {
			cwd: firstDir,
			lsp,
			lspConnectionFactories: { "suite-factory": connectionFactory },
		});
		const getManager = () => {
			const state = (
				runtime.session as unknown as {
					_lspRuntimeState?: { manager: { getClientForFile(path: string): Promise<unknown> } };
				}
			)._lspRuntimeState;
			if (!state) throw new Error("expected AgentSession-owned LSP runtime");
			return state.manager;
		};

		expect(runtime.session.getLspStatus()).toMatchObject({
			owner: "agent-session",
			enabled: true,
			servers: [{ serverId: "suite", state: "idle" }],
		});
		expect(connectionRoots).toEqual([]);
		await getManager().getClientForFile("fixture.ts");
		expect(connectionRoots).toEqual([firstDir]);

		const firstSession = runtime.session;
		await runtime.newSession();
		expect(runtime.session).not.toBe(firstSession);
		expect(runtime.session.getLspStatus()).toMatchObject({ enabled: true, servers: [{ serverId: "suite" }] });
		await getManager().getClientForFile("fixture.ts");
		expect(connectionRoots).toEqual([firstDir, firstDir]);

		const otherSession = new LocalSessionManager({ cwd: secondDir }).create();
		otherSession.appendMessage({ role: "user", content: [{ type: "text", text: "other" }], timestamp: Date.now() });
		const otherReference = otherSession.getSessionReference();
		if (!otherReference) throw new Error("expected destination session reference");
		await runtime.switchSession(otherReference, { cwdOverride: secondDir });
		expect(realpathSync(runtime.cwd)).toBe(realpathSync(secondDir));
		await getManager().getClientForFile("fixture.ts");
		expect(connectionRoots).toEqual([firstDir, firstDir, secondDir]);

		await runtime.session.configureLsp({ enabled: false });
		expect(runtime.session.getLspStatus()).toMatchObject({ enabled: false, servers: [] });
		expect((runtime.session as unknown as { _lspRuntimeState?: unknown })._lspRuntimeState).toBeUndefined();
		expect(runtime.session.getToolDefinition("lsp_hover")).toBeUndefined();
	});

	it("updates the runtime session cwd on cross-cwd session replacement", async () => {
		const firstDir = join(tmpdir(), `pi-runtime-cwd-a-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const secondDir = join(tmpdir(), `pi-runtime-cwd-b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(firstDir, { recursive: true });
		mkdirSync(secondDir, { recursive: true });
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, { cwd: firstDir });
		const otherAuthStorage = AuthStorage.inMemory();
		otherAuthStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const otherRuntime = await PiAgent.create({
			cwd: secondDir,
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			sessionManager: new LocalSessionManager({ cwd: secondDir }),
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
			resolveSessionOptions: () => ({ model: faux.getModel() }),
		});
		await otherRuntime.createAgentSession();
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.prompt("other");
		const otherSessionFile = otherRuntime.session.sessionFile!;

		await runtime.switchSession(otherSessionFile);

		expect(realpathSync(runtime.session.session.getCwd())).toBe(realpathSync(secondDir));
		expect(realpathSync(runtime.cwd)).toBe(realpathSync(secondDir));
	});

	it("restores model and thinking state from the destination session", async () => {
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, {
			bootstrapModel: false,
			bootstrapThinkingLevel: false,
		});
		const otherDir = join(tempDir, "other");
		mkdirSync(otherDir, { recursive: true });
		const otherAuthStorage = AuthStorage.inMemory();
		otherAuthStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const otherRuntime = await PiAgent.create({
			cwd: otherDir,
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			sessionManager: new LocalSessionManager({ cwd: otherDir }),
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		await otherRuntime.createAgentSession();
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.setModel(faux.getModel("faux-2")!);
		otherRuntime.session.setThinkingLevel("off");
		await otherRuntime.session.prompt("hello");
		const targetSessionFile = otherRuntime.session.sessionFile!;

		await runtime.switchSession(targetSessionFile);

		expect(runtime.session.model?.id).toBe("faux-2");
		expect(runtime.session.thinkingLevel).toBe("off");
	});
});
