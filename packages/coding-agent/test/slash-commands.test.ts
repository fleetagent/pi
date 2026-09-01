import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS, HIDDEN_BUILTIN_SLASH_COMMAND_NAMES } from "../src/core/slash-commands.ts";

describe("built-in slash commands", () => {
	it("includes model selection commands", () => {
		const names = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
		expect(names).toContain("model");
		expect(names).toContain("scoped-models");
	});

	it("includes user-only hook control without exposing it to model command catalogs", () => {
		const names = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
		expect(names).toContain("hooks");
		expect(HIDDEN_BUILTIN_SLASH_COMMAND_NAMES.has("hooks")).toBe(true);
	});
});
