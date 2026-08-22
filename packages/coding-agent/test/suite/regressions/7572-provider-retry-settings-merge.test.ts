import { describe, expect, it } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../../../src/core/settings-manager.ts";

describe("regression #7572: nested provider retry settings merge", () => {
	it("preserves global provider settings not overridden by the project", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				retry: {
					provider: {
						timeoutMs: 30000,
						maxRetryDelayMs: 45000,
					},
				},
			}),
		);
		storage.withLock("project", () =>
			JSON.stringify({
				retry: {
					provider: {
						maxRetries: 2,
					},
				},
			}),
		);

		const settingsManager = SettingsManager.fromStorage(storage);

		expect(settingsManager.getProviderRetrySettings()).toEqual({
			timeoutMs: 30000,
			maxRetries: 2,
			maxRetryDelayMs: 45000,
		});
	});

	it("retains field-specific merge policies for sandbox, tools, arrays, and LSP", () => {
		const storage = new InMemorySettingsStorage();
		const globalLsp = { servers: [{ id: "global", enabled: false }] };
		const projectLsp = { enabled: false };
		storage.withLock("global", () =>
			JSON.stringify({
				sandbox: {
					image: "global-image",
					dockerBinary: "podman",
					daemonPort: 9000,
					daemonHostBind: "127.0.0.2",
					cleanup: "stop",
				},
				tools: {
					websearch: {
						provider: "brave",
						apiKey: "global-key",
						options: { region: "global-region", safe: true },
					},
					custom: { enabled: true },
					malformedArray: ["global", "retained"],
				},
				packages: ["npm:global-package"],
				lsp: globalLsp,
			}),
		);
		storage.withLock("project", () =>
			JSON.stringify({
				sandbox: { image: "project-image", cleanup: "remove" },
				tools: {
					websearch: {
						baseUrl: "https://search.example.test",
						options: { safe: false },
					},
					malformedArray: ["project"],
				},
				packages: ["npm:project-package"],
				lsp: projectLsp,
			}),
		);

		const settingsManager = SettingsManager.fromStorage(storage);

		expect(settingsManager.getSandboxSettings()).toEqual({
			image: "project-image",
			dockerBinary: "podman",
			daemonPort: 9000,
			daemonHostBind: "127.0.0.2",
			cleanup: "remove",
		});
		expect(settingsManager.getToolSettings("websearch")).toEqual({
			provider: "brave",
			apiKey: "global-key",
			baseUrl: "https://search.example.test",
			options: { safe: false },
		});
		expect(settingsManager.getToolSettings("custom")).toEqual({ enabled: true });
		expect(settingsManager.getToolsSettings()).toMatchObject({ malformedArray: ["project"] });
		expect(settingsManager.getPackages()).toEqual(["npm:project-package"]);
		expect(settingsManager.getGlobalLspConfiguration()).toEqual(globalLsp);
		expect(settingsManager.getProjectLspConfiguration()).toEqual(projectLsp);
	});

	it("recursively merges runtime retry overrides without mutating stored layers", () => {
		const settingsManager = SettingsManager.inMemory({
			retry: {
				enabled: false,
				provider: { timeoutMs: 30000, maxRetryDelayMs: 45000 },
			},
		});

		settingsManager.applyOverrides({ retry: { provider: { maxRetries: 2 } } });

		expect(settingsManager.getRetryEnabled()).toBe(false);
		expect(settingsManager.getProviderRetrySettings()).toEqual({
			timeoutMs: 30000,
			maxRetries: 2,
			maxRetryDelayMs: 45000,
		});
		expect(settingsManager.getGlobalSettings()).toEqual({
			retry: {
				enabled: false,
				provider: { timeoutMs: 30000, maxRetryDelayMs: 45000 },
			},
		});
	});

	it("replaces malformed array settings atomically instead of object-spreading indices", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ tools: ["global", "retained"] }));
		storage.withLock("project", () => JSON.stringify({ tools: ["project"] }));

		const settingsManager = SettingsManager.fromStorage(storage);

		expect(settingsManager.getToolsSettings()).toEqual(["project"]);
	});
});
