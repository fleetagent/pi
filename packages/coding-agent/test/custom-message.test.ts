import { beforeAll, describe, expect, it } from "vitest";
import { createCustomMessage } from "../src/core/messages.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

describe("CustomMessageComponent", () => {
	beforeAll(() => initTheme(undefined, false));

	it("uses the success palette for compressed state summaries", () => {
		const summary = createCustomMessage(
			"compress_context",
			"Retained objective",
			true,
			undefined,
			new Date().toISOString(),
		);
		const ordinary = createCustomMessage("note", "Retained objective", true, undefined, new Date().toISOString());
		const renderedSummary = new CustomMessageComponent(summary).render(80).join("\n");
		const renderedOrdinary = new CustomMessageComponent(ordinary).render(80).join("\n");

		expect(renderedSummary).toContain(theme.fg("success", "\x1b[1m[compress_context]\x1b[22m"));
		const successBackground = theme.bg("toolSuccessBg", " ").split(" ")[0];
		expect(renderedSummary).toContain(successBackground);
		expect(renderedOrdinary).not.toContain(successBackground);
		expect(renderedOrdinary).toContain(theme.fg("customMessageLabel", "\x1b[1m[note]\x1b[22m"));
	});
});
