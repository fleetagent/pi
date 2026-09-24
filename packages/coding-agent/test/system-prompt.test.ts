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
		test("instructs the agent to send only the starting ID and summary when the tool is active", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "compress_context"],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("## State compression");
			expect(prompt).toContain("Proactively use compress_context at useful checkpoints");
			expect(prompt).toContain("Do not wait for the context window to fill or for the user to ask.");
			expect(prompt).toContain("about 35% as a soft threshold");
			expect(prompt).toContain("At about 50%, prioritize compression at the next safe checkpoint");
			expect(prompt).toContain("repeatedly check utilization just to hit a number");
			expect(prompt).toContain("model-only context metadata after user messages and completed tool-call batches");
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
