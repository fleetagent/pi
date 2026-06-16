import type { ExtensionAPI } from "@fleetagent/pi-coding-agent";
import { Type } from "typebox";

export default function lazyToolsTest(pi: ExtensionAPI) {
	pi.registerTool(
		{
			name: "lazy_echo_static",
			label: "Lazy static echo",
			description: "Return a static echo response for testing lazy tool loading.",
			parameters: Type.Object({}),
			async execute() {
				return {
					content: [{ type: "text", text: "lazy_echo_static response: hello from a lazy extension tool" }],
					details: { source: "lazy-tools-test", tool: "lazy_echo_static" },
				};
			},
		},
		{ lazy: true },
	);

	pi.registerTool(
		{
			name: "lazy_project_fact",
			label: "Lazy project fact",
			description: "Return a static project fact for testing lazy tool loading.",
			parameters: Type.Object({}),
			async execute() {
				return {
					content: [{ type: "text", text: "This response came from the project-local lazy-tools-test extension." }],
					details: { source: "lazy-tools-test", tool: "lazy_project_fact" },
				};
			},
		},
		{ lazy: true },
	);

	pi.registerTool(
		{
			name: "lazy_color",
			label: "Lazy color",
			description: "Return a static favorite color for testing lazy tool loading.",
			parameters: Type.Object({}),
			async execute() {
				return {
					content: [{ type: "text", text: "blue" }],
					details: { source: "lazy-tools-test", tool: "lazy_color", color: "blue" },
				};
			},
		},
		{ lazy: true },
	);

	pi.registerCommand("lazy-tools-test", {
		description: "Show lazy test tools registered by the project-local test extension",
		handler: async (_args, ctx) => {
			const tools = pi
				.getAvailableTools()
				.filter((tool) => tool.sourceInfo.path.includes("lazy-tools-test"))
				.map((tool) => tool.name)
				.sort();
			ctx.ui.notify(`Lazy test tools: ${tools.join(", ") || "none"}`, "info");
		},
	});
}
