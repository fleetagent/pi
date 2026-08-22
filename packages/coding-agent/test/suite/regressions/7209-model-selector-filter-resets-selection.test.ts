import { setKeybindings, type TUI } from "@fleetagent/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../../../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function selectedModelId(rendered: string): string | undefined {
	const line = rendered.split("\n").find((candidate) => candidate.startsWith("→ "));
	if (!line) return undefined;
	const id = line.replace(/^→\s*/, "").split(" [")[0];
	return id?.trim() || undefined;
}

describe("model selector filter resets selection to top", () => {
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

	it("moves selection to the best match after each query change in the All tab", async () => {
		const harness = await createHarness({
			models: [
				{ id: "alpha-1", name: "Alpha One", reasoning: true },
				{ id: "alpha-2", name: "Alpha Two", reasoning: true },
				{ id: "alpha-3", name: "Alpha Three", reasoning: true },
				{ id: "beta-1", name: "Beta One", reasoning: true },
			],
		});
		harnesses.push(harness);

		const current = harness.getModel("alpha-1")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			current,
			harness.settingsManager,
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			expect(stripAnsi(selector.render(120).join("\n"))).toContain("beta-1");
		});
		expect(selectedModelId(stripAnsi(selector.render(120).join("\n")))).toBe("alpha-1");

		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		expect(selectedModelId(stripAnsi(selector.render(120).join("\n")))).toBe("alpha-3");

		selector.handleInput("a");
		expect(selectedModelId(stripAnsi(selector.render(120).join("\n")))).toBe("alpha-1");

		selector.handleInput("\x1b[B");
		expect(selectedModelId(stripAnsi(selector.render(120).join("\n")))).toBe("alpha-2");

		selector.handleInput("\x7f");
		expect(selectedModelId(stripAnsi(selector.render(120).join("\n")))).toBe("alpha-2");

		for (const character of "alpha") selector.handleInput(character);

		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(selectedModelId(rendered)).toBe("alpha-1");
		expect(rendered).not.toContain("beta-1");
	});

	it("moves selection to the best match in the Scoped tab", async () => {
		const harness = await createHarness({
			models: [
				{ id: "alpha-1", name: "Alpha One", reasoning: true },
				{ id: "alpha-2", name: "Alpha Two", reasoning: true },
				{ id: "alpha-3", name: "Alpha Three", reasoning: true },
			],
		});
		harnesses.push(harness);

		const alpha1 = harness.getModel("alpha-1")!;
		const alpha2 = harness.getModel("alpha-2")!;
		const alpha3 = harness.getModel("alpha-3")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			alpha1,
			harness.settingsManager,
			harness.session.modelRegistry,
			[{ model: alpha2 }, { model: alpha3 }, { model: alpha1 }],
			() => {},
			() => {},
		);

		await vi.waitFor(() => {
			expect(stripAnsi(selector.render(120).join("\n"))).toContain("alpha-3");
		});
		expect(selectedModelId(stripAnsi(selector.render(120).join("\n")))).toBe("alpha-1");

		for (const character of "alpha") selector.handleInput(character);

		expect(selectedModelId(stripAnsi(selector.render(120).join("\n")))).toBe("alpha-2");
	});
});
