import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@fleetagent/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionAPI, MarkdownTransformer } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { InMemorySessionManager } from "../src/core/session/in-memory-session-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("Markdown transformer extension registration", () => {
	it("keeps one transformer per extension, aggregates in load order, and rejects stale registration", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		let firstApi: ExtensionAPI | undefined;
		const firstOne: MarkdownTransformer = (markdown) => `${markdown}-old`;
		const firstTwo: MarkdownTransformer = (markdown) => `${markdown}-first`;
		const second: MarkdownTransformer = (markdown) => `${markdown}-second`;
		const firstExtension = await loadExtensionFromFactory(
			(api) => {
				firstApi = api;
				api.registerMarkdownTransformer(firstOne);
				api.registerMarkdownTransformer(firstTwo);
			},
			process.cwd(),
			eventBus,
			runtime,
			"<first>",
		);
		const secondExtension = await loadExtensionFromFactory(
			(api) => api.registerMarkdownTransformer(second),
			process.cwd(),
			eventBus,
			runtime,
			"<second>",
		);
		const session = new InMemorySessionManager().create();
		const auth = AuthStorage.inMemory();
		const runner = new ExtensionRunner(
			[firstExtension, secondExtension],
			runtime,
			process.cwd(),
			session,
			ModelRegistry.create(auth),
		);

		expect(runner.getMarkdownTransformers()).toEqual([firstTwo, second]);
		runner.invalidate("stale test runtime");
		expect(() => firstApi?.registerMarkdownTransformer(firstOne)).toThrow("stale test runtime");
	});
});

describe("Mermaid settings", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	it("defaults invalid values to streaming, persists all values, and preserves nested settings", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ markdown: { codeBlockIndent: "    ", mermaid: "invalid" } }));
		storage.withLock("project", () => JSON.stringify({ markdown: { codeBlockIndent: "\t" } }));
		const manager = SettingsManager.fromStorage(storage);

		expect(manager.getMermaidRenderingMode()).toBe("streaming");
		expect(manager.getCodeBlockIndent()).toBe("\t");

		for (const mode of ["off", "final", "streaming"] as const) {
			manager.setMermaidRenderingMode(mode);
			await manager.flush();
			expect(manager.getMermaidRenderingMode()).toBe(mode);
			expect(manager.getGlobalSettings().markdown).toEqual({ codeBlockIndent: "    ", mermaid: mode });
		}

		manager.applyOverrides({ markdown: { mermaid: "final" } });
		expect(manager.getMermaidRenderingMode()).toBe("final");
		expect(manager.getCodeBlockIndent()).toBe("\t");

		manager.setMermaidRenderingMode("off");
		manager.setProjectPackages(["runtime-override-test"]);
		await manager.flush();
		expect(manager.getMermaidRenderingMode()).toBe("final");
		expect(manager.getCodeBlockIndent()).toBe("\t");

		await manager.reload();
		expect(manager.getMermaidRenderingMode()).toBe("final");
		expect(manager.getCodeBlockIndent()).toBe("\t");
	});

	it("offers Mermaid and fullscreen modes in /settings and invokes their callbacks", () => {
		const onMermaidRenderingModeChange = vi.fn();
		const onFullscreenExitOutputChange = vi.fn();
		const onFullscreenScrollbarChange = vi.fn();
		const config: SettingsConfig = {
			autoCompact: true,
			showImages: false,
			imageWidthCells: 60,
			autoResizeImages: true,
			blockImages: false,
			enableSkillCommands: true,
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			transport: "auto",
			httpIdleTimeoutMs: 300_000,
			thinkingLevel: "off",
			availableThinkingLevels: ["off"],
			currentTheme: "dark",
			availableThemes: ["dark"],
			hideThinkingBlock: false,
			mermaidRenderingMode: "streaming",
			collapseChangelog: false,
			enableInstallTelemetry: true,
			doubleEscapeAction: "tree",
			treeFilterMode: "default",
			showHardwareCursor: false,
			editorPaddingX: 0,
			outputPad: 1,
			autocompleteMaxVisible: 5,
			quietStartup: false,
			clearOnShrink: false,
			showTerminalProgress: false,
			tuiMode: "regular",
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
			warnings: {},
		};
		const noop = () => {};
		const callbacks: SettingsCallbacks = {
			onAutoCompactChange: noop,
			onShowImagesChange: noop,
			onImageWidthCellsChange: noop,
			onAutoResizeImagesChange: noop,
			onBlockImagesChange: noop,
			onEnableSkillCommandsChange: noop,
			onSteeringModeChange: noop,
			onFollowUpModeChange: noop,
			onTransportChange: noop,
			onHttpIdleTimeoutMsChange: noop,
			onThinkingLevelChange: noop,
			onThemeChange: noop,
			onHideThinkingBlockChange: noop,
			onMermaidRenderingModeChange,
			onCollapseChangelogChange: noop,
			onEnableInstallTelemetryChange: noop,
			onDoubleEscapeActionChange: noop,
			onTreeFilterModeChange: noop,
			onShowHardwareCursorChange: noop,
			onEditorPaddingXChange: noop,
			onOutputPadChange: noop,
			onAutocompleteMaxVisibleChange: noop,
			onQuietStartupChange: noop,
			onClearOnShrinkChange: noop,
			onShowTerminalProgressChange: noop,
			onTuiModeChange: noop,
			onFullscreenExitOutputChange,
			onFullscreenScrollbarChange,
			onWarningsChange: noop,
			onCancel: noop,
		};
		const selector = new SettingsSelectorComponent(config, callbacks);
		const list = selector.getSettingsList();
		for (const character of "Mermaid diagrams") list.handleInput(character);

		expect(selector.render(80).join("\n")).toContain("Mermaid diagrams");
		list.handleInput("\r");
		list.handleInput("\r");
		list.handleInput("\r");
		expect(onMermaidRenderingModeChange.mock.calls.map(([mode]) => mode)).toEqual(["off", "final", "streaming"]);

		const exitOutputSelector = new SettingsSelectorComponent(config, callbacks);
		const exitOutputList = exitOutputSelector.getSettingsList();
		for (const character of "Fullscreen exit output") exitOutputList.handleInput(character);
		exitOutputList.handleInput("\r");
		exitOutputList.handleInput("\r");
		expect(onFullscreenExitOutputChange.mock.calls.map(([output]) => output)).toEqual(["resume-hint", "transcript"]);

		const scrollbarSelector = new SettingsSelectorComponent(config, callbacks);
		const scrollbarList = scrollbarSelector.getSettingsList();
		for (const character of "Fullscreen scrollbar") scrollbarList.handleInput(character);
		scrollbarList.handleInput("\r");
		scrollbarList.handleInput("\r");
		scrollbarList.handleInput("\r");
		expect(onFullscreenScrollbarChange.mock.calls.map(([mode]) => mode)).toEqual(["always", "hidden", "auto"]);
	});
});
