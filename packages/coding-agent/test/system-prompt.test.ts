import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test("instructs models to resolve pi docs and examples under absolute base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(
				"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			);
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("subagent orchestration", () => {
		test("describes the primary agent as the final decision-maker when subagent is active", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "subagent"],
				toolSnippets: { subagent: "Delegate focused tasks" },
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("## Orchestration");
			expect(prompt).toContain("You are the primary agent and final decision-maker.");
			expect(prompt).toContain("Treat its output as evidence, not authority");
			expect(prompt).toContain("Do not delegate responsibility for the final answer.");
		});

		test("omits orchestration guidance when subagent is unavailable", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("## Orchestration");
		});
	});

	describe("state compression", () => {
		test("gives concrete compression checkpoints without exposing utilization when the tool is active", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "compress_context"],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("## State compression");
			expect(prompt).toContain("Consider compress_context at concrete checkpoints");
			expect(prompt).toContain("when the user switches tasks");
			expect(prompt).toContain("an implementation slice is complete");
			expect(prompt).toContain("validation has finished");
			expect(prompt).toContain("do not wait for a context percentage or an explicit request");
			expect(prompt).toContain("does not receive a context-utilization percentage");
			expect(prompt).toContain("urgency score");
			expect(prompt).not.toContain("35%");
			expect(prompt).not.toContain("50%");
			expect(prompt).toContain("model-only context metadata after user messages and completed tool-call batches");
			expect(prompt).toContain("session entry IDs but no utilization estimate");
			expect(prompt).toContain("tool-result IDs are for lookup, not cuts");
			expect(prompt).toContain("Turn batches of reads, searches, builds, and tests into concise state");
			expect(prompt).toContain("what passed or failed (including relevant errors)");
			expect(prompt).toContain("Choose a cut point from the entry IDs already visible in context metadata");
			expect(prompt).toContain("Pass startEntryId and a summary");
			expect(prompt).toContain("inclusive endEntryId");
			expect(prompt).toContain("Detector-suggested IDs are advisory");
			expect(prompt).toContain("Do not send a list of IDs.");
			expect(prompt).toContain("Call compress_context alone");
		});

		test("omits compression guidance when the tool is unavailable", () => {
			const prompt = buildSystemPrompt({ selectedTools: ["read"], cwd: process.cwd() });
			expect(prompt).not.toContain("## State compression");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});
});
