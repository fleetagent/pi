import { registerFauxProvider } from "@fleetagent/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import type { ScopedModel } from "../src/core/model-resolver.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type InteractiveModePrototype = {
	handleProfileCommand(this: ProfileCommandContext, text: string): Promise<void>;
};

interface ProfileCommandSession {
	scopedModels: ReadonlyArray<ScopedModel>;
	modelRegistry: ModelRegistry;
	setScopedModels: (models: ScopedModel[]) => void;
}

interface ProfileCommandUi {
	requestRender: () => void;
}

interface ProfileCommandContext {
	session: ProfileCommandSession;
	settingsManager: SettingsManager;
	updateAvailableProviderCount: () => Promise<void>;
	ui: ProfileCommandUi;
	showError: (message: string) => void;
	showStatus: (message: string) => void;
}

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode /profile", () => {
	it("snapshots the current scope and restores it by name", async () => {
		const faux = registerFauxProvider();
		try {
			const model = faux.getModel();
			const modelRegistry = { getAvailable: async () => [model] } as unknown as ModelRegistry;
			const settingsManager = SettingsManager.inMemory();
			const setScopedModels = vi.fn();
			const context: ProfileCommandContext = {
				session: {
					scopedModels: [{ model, thinkingLevel: "high" }],
					modelRegistry,
					setScopedModels,
				},
				settingsManager,
				updateAvailableProviderCount: vi.fn(async () => {}),
				ui: { requestRender: vi.fn() },
				showError: vi.fn(),
				showStatus: vi.fn(),
			};

			await interactiveModePrototype.handleProfileCommand.call(context, "/profile create deep");
			expect(settingsManager.getModelProfiles().deep).toEqual([`${model.provider}/${model.id}:high`]);

			context.session.scopedModels = [];
			await interactiveModePrototype.handleProfileCommand.call(context, "/profile use deep");

			expect(setScopedModels).toHaveBeenCalledWith([{ model, thinkingLevel: "high" }]);
			expect(settingsManager.getEnabledModels()).toEqual([`${model.provider}/${model.id}:high`]);
			expect(context.showError).not.toHaveBeenCalled();
		} finally {
			faux.unregister();
		}
	});

	it("rejects unknown profiles", async () => {
		const context = {
			session: { scopedModels: [], modelRegistry: {}, setScopedModels: vi.fn() },
			settingsManager: SettingsManager.inMemory(),
			updateAvailableProviderCount: vi.fn(async () => {}),
			ui: { requestRender: vi.fn() },
			showError: vi.fn(),
			showStatus: vi.fn(),
		} as unknown as ProfileCommandContext;

		await interactiveModePrototype.handleProfileCommand.call(context, "/profile use missing");

		expect(context.showError).toHaveBeenCalledWith("Unknown profile: missing");
		expect(context.session.setScopedModels).not.toHaveBeenCalled();
	});
});
