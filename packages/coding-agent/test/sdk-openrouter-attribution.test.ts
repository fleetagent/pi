import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type ProviderHeaders,
	type SimpleStreamOptions,
} from "@fleetagent/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { PiAgent } from "../src/core/pi-agent.ts";
import { InMemorySessionManager } from "../src/core/session/in-memory-session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

describe("PiAgent OpenRouter attribution headers", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let originalTelemetryEnv: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-openrouter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		originalTelemetryEnv = process.env.PI_TELEMETRY;
		delete process.env.PI_TELEMETRY;
	});

	afterEach(() => {
		if (originalTelemetryEnv === undefined) {
			delete process.env.PI_TELEMETRY;
		} else {
			process.env.PI_TELEMETRY = originalTelemetryEnv;
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createModel(provider: string, baseUrl: string): Model<Api> {
		return {
			id: `${provider}-test-model`,
			name: `${provider} Test Model`,
			api: "openai-completions",
			provider,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
	}

	function createDoneStream() {
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-completions",
			provider: "capture-provider",
			model: "capture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.end(message);
		return stream;
	}

	async function captureHeaders(
		model: Model<Api>,
		options: {
			telemetryEnabled?: boolean;
			providerHeaders?: ProviderHeaders;
			requestHeaders?: ProviderHeaders;
			authHeader?: boolean;
			extensionFactories?: ExtensionFactory[];
			sessionId?: string;
		} = {},
	): Promise<ProviderHeaders | undefined> {
		const settingsManager = SettingsManager.create(cwd, agentDir);
		if (options.telemetryEnabled === false) {
			settingsManager.setEnableInstallTelemetry(false);
		}

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "test-api-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const registeredProviders = ["capture-provider"];
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider("capture-provider", {
			api: "openai-completions",
			streamSimple: (_model, _context, providerOptions) => {
				capturedOptions = providerOptions;
				return createDoneStream();
			},
		});

		if (options.providerHeaders || options.authHeader) {
			modelRegistry.registerProvider(model.provider, {
				headers: options.providerHeaders,
				authHeader: options.authHeader,
			});
			registeredProviders.push(model.provider);
		}
		const extensionsResult = options.extensionFactories
			? await createTestExtensionsResult(options.extensionFactories, cwd)
			: undefined;

		const sessionManager = new InMemorySessionManager(cwd).create(
			options.sessionId ? { id: options.sessionId } : undefined,
		);
		const pi = await PiAgent.create({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			settingsManager,
			resourceLoader: createTestResourceLoader(extensionsResult ? { extensionsResult } : undefined),
			sessionManager: new InMemorySessionManager(cwd),
		});
		const session = await pi.createAgentSession({ session: sessionManager });

		try {
			await session.agent.streamFn(
				model,
				{ messages: [] },
				{
					sessionId: session.sessionId,
					...(options.requestHeaders ? { headers: options.requestHeaders } : {}),
				},
			);
			return capturedOptions?.headers;
		} finally {
			await pi.dispose();
			for (const provider of registeredProviders.reverse()) {
				modelRegistry.unregisterProvider(provider);
			}
		}
	}

	it("adds default attribution headers for OpenRouter models", async () => {
		const headers = await captureHeaders(createModel("openrouter", "https://openrouter.ai/api/v1"));

		expect(headers?.["HTTP-Referer"]).toBe("https://pi.dev");
		expect(headers?.["X-OpenRouter-Title"]).toBe("pi");
		expect(headers?.["X-OpenRouter-Categories"]).toBe("cli-agent");
	});

	it("does not add attribution headers when telemetry is disabled", async () => {
		const headers = await captureHeaders(createModel("openrouter", "https://openrouter.ai/api/v1"), {
			telemetryEnabled: false,
		});

		expect(headers?.["HTTP-Referer"]).toBeUndefined();
		expect(headers?.["X-OpenRouter-Title"]).toBeUndefined();
		expect(headers?.["X-OpenRouter-Categories"]).toBeUndefined();
	});

	it("adds attribution headers for custom providers routed through OpenRouter", async () => {
		const headers = await captureHeaders(createModel("custom-openrouter", "https://openrouter.ai/api/v1"));

		expect(headers?.["HTTP-Referer"]).toBe("https://pi.dev");
		expect(headers?.["X-OpenRouter-Title"]).toBe("pi");
		expect(headers?.["X-OpenRouter-Categories"]).toBe("cli-agent");
	});

	it("lets provider and request headers override the defaults", async () => {
		const headers = await captureHeaders(createModel("openrouter", "https://openrouter.ai/api/v1"), {
			providerHeaders: {
				"HTTP-Referer": "https://provider.example",
				"X-OpenRouter-Categories": "provider-category",
			},
			requestHeaders: {
				"X-OpenRouter-Title": "request-title",
			},
		});

		expect(headers?.["HTTP-Referer"]).toBe("https://provider.example");
		expect(headers?.["X-OpenRouter-Title"]).toBe("request-title");
		expect(headers?.["X-OpenRouter-Categories"]).toBe("provider-category");
	});
	it("runs before_provider_headers after model auth and request-header assembly", async () => {
		const model = {
			...createModel("openrouter", "https://openrouter.ai/api/v1"),
			headers: { "x-model": "model" },
		};
		let observed: ProviderHeaders | undefined;
		const headers = await captureHeaders(model, {
			providerHeaders: { "x-provider": "provider", "x-provider-remove": null },
			requestHeaders: { "X-OpenRouter-Title": "request-title", "x-explicit": "explicit" },
			authHeader: true,
			extensionFactories: [
				(pi) => {
					pi.on("before_provider_headers", (event) => {
						observed = { ...event.headers };
						event.headers["x-correlation-id"] = "trace-123";
						event.headers["X-OpenRouter-Title"] = null;
					});
				},
			],
		});

		expect(observed).toMatchObject({
			"HTTP-Referer": "https://pi.dev",
			"X-OpenRouter-Title": "request-title",
			"x-model": "model",
			"x-provider": "provider",
			"x-provider-remove": null,
			"x-explicit": "explicit",
			Authorization: "Bearer test-api-key",
		});
		expect(headers).toMatchObject({
			"x-correlation-id": "trace-123",
			"x-provider-remove": null,
			"X-OpenRouter-Title": null,
			Authorization: "Bearer test-api-key",
		});
		expect(headers).not.toHaveProperty("ignored");
	});
	it("exposes Cloudflare gateway auth after assembly and preserves hook deletion markers", async () => {
		let observed: ProviderHeaders | undefined;
		const headers = await captureHeaders(
			createModel("cloudflare-ai-gateway", "https://gateway.ai.cloudflare.com/v1/account/gateway/compat"),
			{
				extensionFactories: [
					(pi) => {
						pi.on("before_provider_headers", (event) => {
							observed = { ...event.headers };
							event.headers["cf-aig-authorization"] = null;
						});
					},
				],
			},
		);

		expect(observed).toMatchObject({
			Authorization: null,
			"cf-aig-authorization": "Bearer test-api-key",
		});
		expect(headers).toMatchObject({ Authorization: null, "cf-aig-authorization": null });
	});

	it("adds OpenCode session headers", async () => {
		const headers = await captureHeaders(createModel("opencode", "https://opencode.ai/zen/v1"), {
			sessionId: "opencode-session",
		});

		expect(headers?.["x-opencode-session"]).toBe("opencode-session");
		expect(headers?.["x-opencode-client"]).toBe("pi");
	});

	it("lets configured OpenCode headers override the defaults", async () => {
		const headers = await captureHeaders(createModel("opencode", "https://opencode.ai/zen/v1"), {
			sessionId: "opencode-session",
			providerHeaders: {
				"x-opencode-session": "configured-session",
				"x-opencode-client": "configured-client",
			},
		});

		expect(headers?.["x-opencode-session"]).toBe("configured-session");
		expect(headers?.["x-opencode-client"]).toBe("configured-client");
	});
});
