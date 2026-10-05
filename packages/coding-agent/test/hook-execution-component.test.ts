import { getKeybindings, setKeybindings } from "@fleetagent/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { HookExecutionNotice } from "../src/core/hooks/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { HookExecutionComponent } from "../src/modes/interactive/components/hook-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const notice: HookExecutionNotice = {
	event: "Stop",
	calls: [
		{
			type: "command",
			label: "node .pi/hooks/check.mjs",
			source: { kind: "project", path: "/workspace/.pi/settings.json" },
			status: "completed",
			exitCode: 0,
			durationMs: 42,
		},
	],
	returnedPrompts: ["Fix the reported issue."],
};

function render(component: HookExecutionComponent, width = 120): string {
	return stripAnsi(component.render(width).join("\n"));
}

function expectHiddenDetails(text: string): void {
	expect(text).not.toContain(notice.calls[0].label);
	expect(text).not.toContain(notice.calls[0].source.path);
	expect(text).not.toContain("42ms");
	expect(text).not.toContain("exit 0");
	expect(text).not.toContain("Returned prompt");
	expect(text).not.toContain(notice.returnedPrompts[0]);
}

describe("HookExecutionComponent", () => {
	const previousKeybindings = getKeybindings();
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));
	afterEach(() => setKeybindings(previousKeybindings));

	it("hides details by default while retaining the event, subject, counts, and shortcut", () => {
		const component = new HookExecutionComponent({ ...notice, subject: "Read" });
		const text = render(component);
		expect(text).toContain("Hook · Stop");
		expect(text).toContain("Read");
		expect(text).toContain("1 completed");
		expect(text).toContain("ctrl+o to expand");
		expectHiddenDetails(text);
	});

	it("renders full details when expanded and hides them again when collapsed", () => {
		const component = new HookExecutionComponent(notice);
		component.setExpanded(true);
		const rendered = component.render(120).join("\n");
		const text = stripAnsi(rendered);
		expect(text).toContain("command node .pi/hooks/check.mjs");
		expect(text).toContain("project: /workspace/.pi/settings.json");
		expect(text).toContain("completed, exit 0, 42ms");
		expect(text).toContain("Returned prompt");
		expect(text.match(/Fix the reported issue\./g)).toHaveLength(1);
		expect(rendered).toMatch(/\u001b\[48;(?:2|5);/);
		component.setExpanded(false);
		expectHiddenDetails(render(component));
	});

	it("summarizes failures, nonzero exits, cancellations, and null-exit successes", () => {
		const component = new HookExecutionComponent({
			...notice,
			calls: [
				notice.calls[0],
				{ ...notice.calls[0], exitCode: null },
				{ ...notice.calls[0], exitCode: 2 },
				{ ...notice.calls[0], status: "error", exitCode: null },
				{ ...notice.calls[0], status: "timeout", exitCode: null },
				{ ...notice.calls[0], status: "unsupported", exitCode: null },
				{ ...notice.calls[0], status: "cancelled", exitCode: null },
			],
		});
		const text = render(component);
		expect(text).toContain("2 completed");
		expect(text).toContain("4 failed");
		expect(text).toContain("1 cancelled");
		expectHiddenDetails(text);
	});

	it("uses remapped shortcuts and updates the hint on invalidation", () => {
		const component = new HookExecutionComponent(notice);
		setKeybindings(new KeybindingsManager({ "app.tools.expand": ["ctrl+e", "alt+o"] }));
		component.invalidate();
		expect(render(component)).toContain(
			process.platform === "darwin" ? "ctrl+e/option+o to expand" : "ctrl+e/alt+o to expand",
		);
		expect(render(component)).not.toContain("ctrl+o");
		setKeybindings(new KeybindingsManager({ "app.tools.expand": [] }));
		component.invalidate();
		expect(render(component)).not.toContain("to expand");
	});

	it.each([[], [""], ["First line\n\nLast line"], ["long-body ".repeat(200)]])(
		"preserves prompt bodies through expansion and invalidation: %j",
		(...returnedPrompts) => {
			const input = { ...notice, returnedPrompts };
			const original = structuredClone(input);
			const component = new HookExecutionComponent(input);
			expect(render(component)).not.toContain("Returned prompt");
			component.setExpanded(true);
			component.invalidate();
			const text = render(component);
			if (returnedPrompts.length === 0) expect(text).not.toContain("Returned prompt");
			else expect(text).toContain("Returned prompt");
			for (const prompt of returnedPrompts) {
				if (prompt.includes("Last line")) expect(text).toContain("Last line");
				if (prompt.includes("long-body")) expect(text.match(/long-body/g)).toHaveLength(200);
			}
			component.setExpanded(false);
			expectHiddenDetails(render(component));
			expect(input).toEqual(original);
		},
	);

	it("groups calls and prompts without revealing details until expanded", () => {
		const component = new HookExecutionComponent({
			event: "PreToolUse",
			subject: "Read",
			calls: [{ ...notice.calls[0], durationMs: 40 }],
			returnedPrompts: ["Shared feedback."],
		});
		component.appendNotice({
			event: "PreToolUse",
			subject: "Bash",
			calls: [{ ...notice.calls[0], durationMs: 41 }],
			returnedPrompts: ["Shared feedback.", "Bash feedback."],
		});
		expect(render(component)).toContain("2 completed");
		expectHiddenDetails(render(component));
		expect(render(component)).not.toContain("Shared feedback.");
		component.setExpanded(true);
		component.appendNotice({
			event: "PreToolUse",
			subject: "Read",
			calls: [{ ...notice.calls[0], status: "error", exitCode: 1, durationMs: 43 }],
			returnedPrompts: ["Shared feedback."],
		});
		component.invalidate();
		const text = render(component);
		expect(text).toContain("Hook · PreToolUse");
		expect(text).toContain("Tools: Read ×2, Bash");
		expect(text.match(/command node \.pi\/hooks\/check\.mjs/g)).toHaveLength(1);
		expect(text).toContain("completed (exit 0) ×2; error (exit 1), ~41.3ms");
		expect(text).toContain("Prompt 1 ×3");
		expect(text.match(/Shared feedback\./g)).toHaveLength(1);
		expect(text.match(/Bash feedback\./g)).toHaveLength(1);
		component.setExpanded(false);
		expect(render(component)).toContain("2 completed");
		expect(render(component)).toContain("1 failed");
		expectHiddenDetails(render(component));
		expect(render(component)).not.toContain("feedback.");
	});

	it("uses the displayed label when grouping expanded handler rows", () => {
		const sharedPrefix = "a".repeat(310);
		const component = new HookExecutionComponent({
			event: "PreToolUse",
			calls: [{ ...notice.calls[0], label: `${sharedPrefix}first`, durationMs: 1 }],
			returnedPrompts: [],
		});
		component.setExpanded(true);
		component.appendNotice({
			event: "PreToolUse",
			calls: [{ ...notice.calls[0], label: `${sharedPrefix}second`, durationMs: 2 }],
			returnedPrompts: [],
		});
		expect(render(component, 500)).toContain("completed (exit 0) ×2, ~1.5ms");
	});
});
