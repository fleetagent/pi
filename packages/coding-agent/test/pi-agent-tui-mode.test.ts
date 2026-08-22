import { describe, expect, it, vi } from "vitest";

const interactiveModeMocks = vi.hoisted(() => ({
	options: [] as unknown[],
	run: vi.fn(async () => {}),
}));

vi.mock("../src/modes/interactive/interactive-mode.ts", () => ({
	InteractiveMode: class {
		constructor(_session: unknown, options: unknown) {
			interactiveModeMocks.options.push(options);
		}

		run(): Promise<void> {
			return interactiveModeMocks.run();
		}
	},
}));

import { PiAgent, type RunPiAgentModeOptions } from "../src/core/pi-agent.ts";

describe("PiAgent interactive TUI mode threading", () => {
	it("forwards the startup-only fullscreen mode to InteractiveMode", async () => {
		interactiveModeMocks.options.length = 0;
		interactiveModeMocks.run.mockClear();
		const agent = { modelFallbackMessage: undefined } as unknown as PiAgent;
		const options: RunPiAgentModeOptions = { mode: "interactive", tuiMode: "fullscreen" };

		await PiAgent.prototype.runMode.call(agent, options);

		expect(interactiveModeMocks.options).toEqual([expect.objectContaining({ tuiMode: "fullscreen" })]);
		expect(interactiveModeMocks.run).toHaveBeenCalledOnce();
	});

	it("leaves tuiMode omitted so the interactive factory retains its regular default", async () => {
		interactiveModeMocks.options.length = 0;
		const agent = { modelFallbackMessage: undefined } as unknown as PiAgent;

		await PiAgent.prototype.runMode.call(agent, { mode: "interactive" });

		expect(interactiveModeMocks.options).toEqual([expect.objectContaining({ tuiMode: undefined })]);
	});
});
