/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, only read-only tools are available.
 *
 * Features:
 * - /plan command or Ctrl+Alt+P to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 */

import type { AgentMessage } from "@fleetagent/pi-agent-core";
import type { AssistantMessage, TextContent } from "@fleetagent/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@fleetagent/pi-coding-agent";
import { Key } from "@fleetagent/pi-tui";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils.ts";

interface PersistedPlanModeState {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
}

// Tools
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		// Footer status
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Widget showing todo list
		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		executionMode = false;
		todoItems = [];

		if (planModeEnabled) {
			pi.setActiveTools(PLAN_MODE_TOOLS);
			ctx.ui.notify(`Plan mode enabled. Tools: ${PLAN_MODE_TOOLS.join(", ")}`);
		} else {
			pi.setActiveTools(NORMAL_MODE_TOOLS);
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		updateStatus(ctx);
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
		});
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Block destructive bash commands in plan mode
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	// Filter out stale plan mode context when not in plan mode
	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash, grep, find, ls, questionnaire
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions using the questionnaire tool.
Use brave-search skill via bash for web research.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`,
					display: false,
				},
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`,
					display: false,
				},
			};
		}
	});

	// Track progress after each turn
	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
		}
		persistState();
	});

	function handlePlanExecutionEnd(ctx: ExtensionContext): boolean {
		if (!executionMode || todoItems.length === 0) return false;
		if (!todoItems.every((item) => item.completed)) return true;

		const completedList = todoItems.map((item) => `~~${item.text}~~`).join("\n");
		pi.sendMessage(
			{ customType: "plan-complete", content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
			{ triggerTurn: false },
		);
		executionMode = false;
		todoItems = [];
		pi.setActiveTools(NORMAL_MODE_TOOLS);
		updateStatus(ctx);
		persistState(); // Save cleared state so resume doesn't restore old execution mode
		return true;
	}

	function presentLatestPlan(messages: readonly AgentMessage[]): void {
		const lastAssistant = [...messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const extracted = extractTodoItems(getTextContent(lastAssistant));
			if (extracted.length > 0) todoItems = extracted;
		}
		if (todoItems.length === 0) return;

		const todoListText = todoItems.map((item, index) => `${index + 1}. ☐ ${item.text}`).join("\n");
		pi.sendMessage(
			{
				customType: "plan-todo-list",
				content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
				display: true,
			},
			{ triggerTurn: false },
		);
	}

	function executeCurrentPlan(ctx: ExtensionContext): void {
		planModeEnabled = false;
		executionMode = todoItems.length > 0;
		pi.setActiveTools(NORMAL_MODE_TOOLS);
		updateStatus(ctx);
		const content =
			todoItems.length > 0
				? `Execute the plan. Start with: ${todoItems[0].text}`
				: "Execute the plan you just created.";
		pi.sendMessage({ customType: "plan-mode-execute", content, display: true }, { triggerTurn: true });
	}

	async function refineCurrentPlan(ctx: ExtensionContext): Promise<void> {
		const refinement = await ctx.ui.editor("Refine the plan:", "");
		if (refinement?.trim()) pi.sendUserMessage(refinement.trim());
	}

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		if (handlePlanExecutionEnd(ctx)) return;
		if (!planModeEnabled || !ctx.hasUI) return;

		presentLatestPlan(event.messages);
		const choice = await ctx.ui.select("Plan mode - what next?", [
			todoItems.length > 0 ? "Execute the plan (track progress)" : "Execute the plan",
			"Stay in plan mode",
			"Refine the plan",
		]);
		if (choice?.startsWith("Execute")) {
			executeCurrentPlan(ctx);
		} else if (choice === "Refine the plan") {
			await refineCurrentPlan(ctx);
		}
	});

	function restorePlanExecutionProgress(entries: SessionEntry[]): void {
		let executeIndex = -1;
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry.type === "custom" && entry.customType === "plan-mode-execute") {
				executeIndex = index;
				break;
			}
		}
		const messages: AssistantMessage[] = [];
		for (let index = executeIndex + 1; index < entries.length; index++) {
			const entry = entries[index];
			if (entry.type === "message" && isAssistantMessage(entry.message as AgentMessage)) {
				messages.push(entry.message as AssistantMessage);
			}
		}
		markCompletedSteps(messages.map(getTextContent).join("\n"), todoItems);
	}

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.session.getEntries();

		// Restore persisted state
		const planModeEntry = entries
			.filter((entry: SessionEntry) => entry.type === "custom" && entry.customType === "plan-mode")
			.pop() as { data?: PersistedPlanModeState } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
		}

		// On resume: re-scan messages to rebuild completion state
		// Only scan messages AFTER the last "plan-mode-execute" to avoid picking up [DONE:n] from previous plans
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			restorePlanExecutionProgress(entries);
		}

		if (planModeEnabled) {
			pi.setActiveTools(PLAN_MODE_TOOLS);
		}
		updateStatus(ctx);
	});
}
