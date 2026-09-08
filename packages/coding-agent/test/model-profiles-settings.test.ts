import { describe, expect, it } from "vitest";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";

describe("model profile settings", () => {
	it("stores independent named model snapshots", async () => {
		const manager = SettingsManager.inMemory();

		manager.setModelProfile("fast", ["openai/gpt-5-mini", "google/gemini-flash"]);
		manager.setModelProfile("deep", ["anthropic/claude-opus:high"]);
		await manager.flush();
		await manager.reload();

		expect(manager.getModelProfiles()).toEqual({
			fast: ["openai/gpt-5-mini", "google/gemini-flash"],
			deep: ["anthropic/claude-opus:high"],
		});
	});

	it("returns a defensive copy", () => {
		const manager = SettingsManager.inMemory({ modelProfiles: { work: ["openai/gpt-5"] } });
		const profiles = manager.getModelProfiles();

		profiles.work?.push("anthropic/claude-opus");

		expect(manager.getModelProfiles().work).toEqual(["openai/gpt-5"]);
	});

	it("ignores malformed stored profiles and rejects unsafe names", () => {
		const manager = SettingsManager.inMemory({
			modelProfiles: { valid: ["openai/gpt-5"], broken: null },
		} as unknown as Settings);

		expect(manager.getModelProfiles()).toEqual({ valid: ["openai/gpt-5"] });
		expect(() => manager.setModelProfile("__proto__", ["openai/gpt-5"])).toThrow("Invalid model profile name");
	});
});
