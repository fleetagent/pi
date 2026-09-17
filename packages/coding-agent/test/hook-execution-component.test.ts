import { beforeAll, describe, expect, it } from "vitest";
import type { HookExecutionNotice } from "../src/core/hooks/types.ts";
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

describe("HookExecutionComponent", () => {
	beforeAll(() => initTheme("dark"));

	it("renders only hook calls and returned prompts in a distinct card", () => {
		const rendered = new HookExecutionComponent(notice).render(120).join("\n");
		const text = stripAnsi(rendered);

		expect(text).toContain("Hook · Stop");
		expect(text).toContain("command node .pi/hooks/check.mjs");
		expect(text).toContain("project: /workspace/.pi/settings.json");
		expect(text).toContain("completed, exit 0, 42ms");
		expect(text).toContain("Returned prompt");
		expect(text.match(/Fix the reported issue\./g)).toHaveLength(1);
		expect(notice.calls[0]).not.toHaveProperty("stdout");
		expect(rendered).toMatch(/\u001b\[48;(?:2|5);/);
	});

	it("groups repeated hook calls, subjects, statuses, prompts, and average duration", () => {
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
		component.appendNotice({
			event: "PreToolUse",
			subject: "Read",
			calls: [{ ...notice.calls[0], status: "error", exitCode: 1, durationMs: 43 }],
			returnedPrompts: ["Shared feedback."],
		});

		const text = stripAnsi(component.render(120).join("\n"));

		expect(text).toContain("Hook · PreToolUse");
		expect(text).not.toContain("PreToolUse (x3)");
		expect(text).toContain("Tools: Read ×2, Bash");
		expect(text.match(/command node \.pi\/hooks\/check\.mjs/g)).toHaveLength(1);
		expect(text).toContain("completed (exit 0) ×2; error (exit 1), ~41.3ms");
		expect(text).toContain("Returned prompts");
		expect(text).toContain("Prompt 1 ×3");
		expect(text.match(/Shared feedback\./g)).toHaveLength(1);
		expect(text).toContain("Prompt 2");
		expect(text.match(/Bash feedback\./g)).toHaveLength(1);
	});

	it("uses the displayed label when grouping handler rows", () => {
		const sharedPrefix = "a".repeat(310);
		const component = new HookExecutionComponent({
			event: "PreToolUse",
			calls: [{ ...notice.calls[0], label: `${sharedPrefix}first`, durationMs: 1 }],
			returnedPrompts: [],
		});
		component.appendNotice({
			event: "PreToolUse",
			calls: [{ ...notice.calls[0], label: `${sharedPrefix}second`, durationMs: 2 }],
			returnedPrompts: [],
		});

		const text = stripAnsi(component.render(500).join("\n"));
		expect(text).toContain("completed (exit 0) ×2, ~1.5ms");
	});
});
