import { fauxAssistantMessage } from "@fleetagent/pi-ai";
import { setKeybindings } from "@fleetagent/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "../harness.ts";

type SelectableFocus = { handleInput(keyData: string): void };
type ForkSelectorContext = {
	session: { getUserMessagesForForking(): Array<{ entryId: string; text: string }> };
	showStatus(message: string): void;
	showSelector(factory: (done: () => void) => { component: unknown; focus: SelectableFocus }): void;
	runtimeHost: {
		fork(entryId: string): Promise<{ cancelled: boolean; selectedText?: string }>;
	};
	ui: { requestRender(): void };
	renderCurrentSessionState(): void;
	editor: { setText(text: string): void };
	showError(message: string): void;
};

type InteractiveModePrototype = {
	showUserMessageSelector(this: ForkSelectorContext): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("regression #6430: fork selector closes before asynchronous fork", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("ignores a second confirmation while the first fork is pending", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed reply")]);
		await harness.session.prompt("fork from here");

		let resolveFork: ((result: { cancelled: boolean; selectedText?: string }) => void) | undefined;
		const fork = vi.fn(
			() =>
				new Promise<{ cancelled: boolean; selectedText?: string }>((resolve) => {
					resolveFork = resolve;
				}),
		);
		const renderCurrentSessionState = vi.fn();
		const setText = vi.fn();
		const showStatus = vi.fn();
		const showError = vi.fn();
		const requestRender = vi.fn();
		const done = vi.fn();
		let activeFocus: SelectableFocus | undefined;

		const context: ForkSelectorContext = {
			session: harness.session,
			showStatus,
			showSelector: (factory) => {
				const selector = factory(() => {
					done();
					activeFocus = undefined;
				});
				activeFocus = selector.focus;
			},
			runtimeHost: { fork },
			ui: { requestRender },
			renderCurrentSessionState,
			editor: { setText },
			showError,
		};

		interactiveModePrototype.showUserMessageSelector.call(context);
		expect(activeFocus).toBeDefined();

		activeFocus?.handleInput("\r");
		expect(done).toHaveBeenCalledTimes(1);
		expect(activeFocus).toBeUndefined();
		expect(fork).toHaveBeenCalledTimes(1);

		activeFocus?.handleInput("\r");
		expect(fork).toHaveBeenCalledTimes(1);
		expect(renderCurrentSessionState).not.toHaveBeenCalled();

		resolveFork?.({ cancelled: false, selectedText: "restored draft" });
		await vi.waitFor(() => {
			expect(renderCurrentSessionState).toHaveBeenCalledTimes(1);
		});

		expect(done).toHaveBeenCalledTimes(1);
		expect(setText).toHaveBeenCalledWith("restored draft");
		expect(showStatus).toHaveBeenCalledWith("Forked to new session");
		expect(showError).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
	});
});
