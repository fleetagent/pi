import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";

describe("built-in slash commands", () => {
	it("includes model selection commands", () => {
		const names = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
		expect(names).toContain("model");
		expect(names).toContain("scoped-models");
	});
});
