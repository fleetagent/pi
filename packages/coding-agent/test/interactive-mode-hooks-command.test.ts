import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface HooksCommandSession {
	setHooksEnabled(enabled: boolean): void;
}

interface HooksCommandContext {
	session: HooksCommandSession;
	showStatus(message: string): void;
	showWarning(message: string): void;
}

interface InteractiveModePrivate {
	handleHooksCommand(this: HooksCommandContext, text: string): void;
}

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createContext(): HooksCommandContext {
	return {
		session: { setHooksEnabled: vi.fn() },
		showStatus: vi.fn(),
		showWarning: vi.fn(),
	};
}

describe("InteractiveMode /hooks command", () => {
	it.each([
		["disable", false, "Hooks disabled for this session"],
		["enable", true, "Hooks enabled for this session"],
	] as const)("handles %s", (action, enabled, status) => {
		const context = createContext();

		interactiveModePrototype.handleHooksCommand.call(context, `/hooks ${action}`);

		expect(context.session.setHooksEnabled).toHaveBeenCalledWith(enabled);
		expect(context.showStatus).toHaveBeenCalledWith(status);
		expect(context.showWarning).not.toHaveBeenCalled();
	});

	it("rejects missing and unsupported actions", () => {
		for (const command of ["/hooks", "/hooks pause"]) {
			const context = createContext();

			interactiveModePrototype.handleHooksCommand.call(context, command);

			expect(context.session.setHooksEnabled).not.toHaveBeenCalled();
			expect(context.showWarning).toHaveBeenCalledWith("Usage: /hooks <enable|disable>");
		}
	});
});
