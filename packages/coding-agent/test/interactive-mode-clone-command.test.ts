import { describe, expect, it, vi } from "vitest";
import type { ExtensionForkOptions } from "../src/core/extensions/types.ts";
import type { PiAgentForkResult } from "../src/core/pi-agent.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface CloneCommandActiveSession {
	getLeafId: () => string | null;
}

interface CloneCommandRuntimeHost {
	fork: (entryId: string, options?: ExtensionForkOptions) => Promise<PiAgentForkResult>;
}

interface CloneCommandEditor {
	setText: (text: string) => void;
}

interface CloneCommandUI {
	requestRender: () => void;
}

interface CloneCommandContext {
	activeSession: CloneCommandActiveSession;
	runtimeHost: CloneCommandRuntimeHost;
	renderCurrentSessionState: () => void;
	editor: CloneCommandEditor;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	ui: CloneCommandUI;
}

type InteractiveModePrototype = {
	handleCloneCommand(this: CloneCommandContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode /clone", () => {
	it("clones the current leaf into a new session", async () => {
		const fork = vi.fn(async () => ({ cancelled: false }));
		const renderCurrentSessionState = vi.fn();
		const setText = vi.fn();
		const showStatus = vi.fn();
		const showError = vi.fn();
		const requestRender = vi.fn();

		const context: CloneCommandContext = {
			activeSession: { getLeafId: () => "leaf-123" },
			runtimeHost: { fork },
			renderCurrentSessionState,
			editor: { setText },
			showStatus,
			showError,
			ui: { requestRender },
		};

		await interactiveModePrototype.handleCloneCommand.call(context);

		expect(fork).toHaveBeenCalledWith("leaf-123", { position: "at" });
		expect(renderCurrentSessionState).toHaveBeenCalled();
		expect(setText).toHaveBeenCalledWith("");
		expect(showStatus).toHaveBeenCalledWith("Cloned to new session");
		expect(showError).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("shows a status message when there is nothing to clone", async () => {
		const fork = vi.fn(async () => ({ cancelled: false }));
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: CloneCommandContext = {
			activeSession: { getLeafId: () => null },
			runtimeHost: { fork },
			renderCurrentSessionState: vi.fn(),
			editor: { setText: vi.fn() },
			showStatus,
			showError,
			ui: { requestRender: vi.fn() },
		};

		await interactiveModePrototype.handleCloneCommand.call(context);

		expect(fork).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Nothing to clone yet");
		expect(showError).not.toHaveBeenCalled();
	});
});
