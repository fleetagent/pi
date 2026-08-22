import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	copyToClipboard: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock("../src/utils/clipboard.ts", () => ({
	copyToClipboard: mocks.copyToClipboard,
	readClipboardText: vi.fn(async () => null),
}));

import type { SessionTreeNode } from "../src/core/session-manager.ts";
import type { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type SetupKeyHandlersContext = {
	defaultEditor: {
		onAction: (action: string, handler: () => void) => void;
		onEscape?: () => void;
		onCtrlD?: () => void;
		onChange?: (text: string) => void;
		onPasteImage?: () => void;
	};
	ui: { onDebug?: () => void };
	handleCopyCommand: (options?: { flashConfirmation?: boolean }) => Promise<void>;
};

type CopyCommandContext = {
	session: { getLastAssistantText: () => string | undefined };
	showStatus: (message: string) => void;
	showError: (message: string) => void;
};

type ShowTreeContext = {
	activeSession: {
		getTree: () => SessionTreeNode[];
		getLeafId: () => string | null;
		appendLabelChange: (entryId: string, label: string | undefined) => void;
	};
	settingsManager: { getTreeFilterMode: () => "default" };
	ui: { terminal: { rows: number }; requestRender: () => void };
	showSelector: (
		factory: (done: () => void) => { component: TreeSelectorComponent; focus: TreeSelectorComponent },
	) => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
};

type InteractiveModePrivate = {
	setupKeyHandlers(this: SetupKeyHandlersContext): void;
	handleCopyCommand(this: CopyCommandContext, options?: { flashConfirmation?: boolean }): Promise<void>;
	showTreeSelector(this: ShowTreeContext): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

describe("InteractiveMode message copy", () => {
	beforeEach(() => {
		initTheme("dark");
		mocks.copyToClipboard.mockReset();
		mocks.copyToClipboard.mockResolvedValue(undefined);
	});

	test("wires the configurable copy action to the existing copy command", () => {
		const actions = new Map<string, () => void>();
		const handleCopyCommand = vi.fn(async () => {});
		const context: SetupKeyHandlersContext = {
			defaultEditor: {
				onAction: (action, handler) => actions.set(action, handler),
			},
			ui: {},
			handleCopyCommand,
		};

		interactiveModePrototype.setupKeyHandlers.call(context);
		actions.get("app.message.copy")?.();

		expect(handleCopyCommand).toHaveBeenCalledWith({ flashConfirmation: true });
	});

	test("copies the last assistant text and reports success", async () => {
		const showStatus = vi.fn<(message: string) => void>();
		const showError = vi.fn<(message: string) => void>();
		const context: CopyCommandContext = {
			session: { getLastAssistantText: () => "assistant response" },
			showStatus,
			showError,
		};

		await interactiveModePrototype.handleCopyCommand.call(context);

		expect(mocks.copyToClipboard).toHaveBeenCalledWith("assistant response");
		expect(showStatus).toHaveBeenCalledWith("Copied last agent message to clipboard");
		expect(showError).not.toHaveBeenCalled();
	});

	test("reports missing messages and clipboard failures", async () => {
		const showStatus = vi.fn<(message: string) => void>();
		const showError = vi.fn<(message: string) => void>();
		const missingContext: CopyCommandContext = {
			session: { getLastAssistantText: () => undefined },
			showStatus,
			showError,
		};

		await interactiveModePrototype.handleCopyCommand.call(missingContext);
		expect(showError).toHaveBeenCalledWith("No agent messages to copy yet.");
		expect(mocks.copyToClipboard).not.toHaveBeenCalled();

		showError.mockClear();
		mocks.copyToClipboard.mockRejectedValueOnce(new Error("clipboard unavailable"));
		const failureContext: CopyCommandContext = {
			session: { getLastAssistantText: () => "assistant response" },
			showStatus,
			showError,
		};
		await interactiveModePrototype.handleCopyCommand.call(failureContext);

		expect(showError).toHaveBeenCalledWith("clipboard unavailable");
		expect(showStatus).not.toHaveBeenCalled();
	});

	test("copies selected tree text and reports empty entries or clipboard failures", async () => {
		const showStatus = vi.fn<(message: string) => void>();
		const showError = vi.fn<(message: string) => void>();
		const tree: SessionTreeNode[] = [
			{
				entry: {
					type: "message",
					id: "user-1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "selected text", timestamp: Date.now() },
				},
				children: [],
			},
		];
		let selector: TreeSelectorComponent | undefined;
		const context: ShowTreeContext = {
			activeSession: {
				getTree: () => tree,
				getLeafId: () => "user-1",
				appendLabelChange: vi.fn(),
			},
			settingsManager: { getTreeFilterMode: () => "default" },
			ui: { terminal: { rows: 24 }, requestRender: vi.fn() },
			showSelector: (factory) => {
				selector = factory(vi.fn()).component;
			},
			showStatus,
			showError,
		};

		interactiveModePrototype.showTreeSelector.call(context);
		const onCopy = selector?.onCopy as ((text: string | undefined) => Promise<void>) | undefined;
		if (!onCopy) throw new Error("Expected tree copy callback");

		await onCopy("selected text");
		expect(mocks.copyToClipboard).toHaveBeenCalledWith("selected text");
		expect(showStatus).toHaveBeenCalledWith("Copied selected message to clipboard");

		mocks.copyToClipboard.mockClear();
		showStatus.mockClear();
		await onCopy(undefined);
		expect(showError).toHaveBeenCalledWith("Selected entry has no text to copy");
		expect(mocks.copyToClipboard).not.toHaveBeenCalled();

		showError.mockClear();
		mocks.copyToClipboard.mockRejectedValueOnce(new Error("tree clipboard unavailable"));
		await onCopy("selected text");
		expect(showError).toHaveBeenCalledWith("tree clipboard unavailable");
		expect(showStatus).not.toHaveBeenCalled();
	});
});
