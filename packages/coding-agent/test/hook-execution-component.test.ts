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
});
