/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 */

import type { AgentToolResult, ExtensionAPI } from "@fleetagent/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, type SelectItem, Text, truncateToWidth } from "@fleetagent/pi-tui";
import { Type } from "typebox";

// Types
type QuestionOption = SelectItem;

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
}

interface Answer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

interface QuestionnaireResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

// Schema
const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

function errorResult(message: string, questions: Question[] = []): AgentToolResult<QuestionnaireResult> {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

export default function questionnaire(pi: ExtensionAPI) {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			// Normalize questions with defaults
			const questions: Question[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				allowOther: q.allowOther !== false,
			}));

			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1; // questions + Submit

			const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
				// State
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let inputQuestionId: string | null = null;
				let cachedLines: string[] | undefined;
				const answers = new Map<string, Answer>();

				// Editor for "Type something" option
				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				// Helpers
				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function submit(cancelled: boolean) {
					done({ questions, answers: Array.from(answers.values()), cancelled });
				}

				function currentQuestion(): Question | undefined {
					return questions[currentTab];
				}

				function currentOptions(): RenderOption[] {
					const q = currentQuestion();
					if (!q) return [];
					const opts: RenderOption[] = [...q.options];
					if (q.allowOther) {
						opts.push({ value: "__other__", label: "Type something.", isOther: true });
					}
					return opts;
				}

				function allAnswered(): boolean {
					return questions.every((q) => answers.has(q.id));
				}

				function advanceAfterAnswer() {
					if (!isMulti) {
						submit(false);
						return;
					}
					if (currentTab < questions.length - 1) {
						currentTab++;
					} else {
						currentTab = questions.length; // Submit tab
					}
					optionIndex = 0;
					refresh();
				}

				function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
					answers.set(questionId, { id: questionId, value, label, wasCustom, index });
				}

				// Editor submit callback
				editor.onSubmit = (value) => {
					if (!inputQuestionId) return;
					const trimmed = value.trim() || "(no response)";
					saveAnswer(inputQuestionId, trimmed, trimmed, true);
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					advanceAfterAnswer();
				};

				function handleEditorInput(data: string): boolean {
					if (!inputMode) return false;
					if (matchesKey(data, Key.escape)) {
						inputMode = false;
						inputQuestionId = null;
						editor.setText("");
						refresh();
						return true;
					}
					editor.handleInput(data);
					refresh();
					return true;
				}

				function handleQuestionTabNavigation(data: string): boolean {
					if (!isMulti) return false;
					if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
						currentTab = (currentTab + 1) % totalTabs;
					} else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
						currentTab = (currentTab - 1 + totalTabs) % totalTabs;
					} else {
						return false;
					}
					optionIndex = 0;
					refresh();
					return true;
				}

				function handleSubmitTabInput(data: string): boolean {
					if (currentTab !== questions.length) return false;
					if (matchesKey(data, Key.enter) && allAnswered()) submit(false);
					else if (matchesKey(data, Key.escape)) submit(true);
					return true;
				}

				function handleOptionNavigation(data: string): boolean {
					const options = currentOptions();
					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
					} else if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(options.length - 1, optionIndex + 1);
					} else {
						return false;
					}
					refresh();
					return true;
				}

				function handleOptionSelection(data: string): boolean {
					const question = currentQuestion();
					const options = currentOptions();
					if (!matchesKey(data, Key.enter) || !question) return false;
					const option = options[optionIndex];
					if (option.isOther) {
						inputMode = true;
						inputQuestionId = question.id;
						editor.setText("");
						refresh();
						return true;
					}
					saveAnswer(question.id, option.value, option.label, false, optionIndex + 1);
					advanceAfterAnswer();
					return true;
				}

				function handleQuestionnaireCancel(data: string): boolean {
					if (!matchesKey(data, Key.escape)) return false;
					submit(true);
					return true;
				}

				const inputHandlers = [
					handleEditorInput,
					handleQuestionTabNavigation,
					handleSubmitTabInput,
					handleOptionNavigation,
					handleOptionSelection,
					handleQuestionnaireCancel,
				];

				function handleInput(data: string) {
					for (const handler of inputHandlers) {
						if (handler(data)) return;
					}
				}

				function addLine(lines: string[], width: number, text: string): void {
					lines.push(truncateToWidth(text, width));
				}

				function formatQuestionTab(question: Question, index: number): string {
					const isActive = index === currentTab;
					const isAnswered = answers.has(question.id);
					const box = isAnswered ? "■" : "□";
					const color = isAnswered ? "success" : "muted";
					const text = ` ${box} ${question.label} `;
					const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
					return `${styled} `;
				}

				function appendQuestionTabs(lines: string[], width: number): void {
					if (!isMulti) return;
					const tabs = ["← ", ...questions.map(formatQuestionTab)];
					const submitText = " ✓ Submit ";
					const submitStyled =
						currentTab === questions.length
							? theme.bg("selectedBg", theme.fg("text", submitText))
							: theme.fg(allAnswered() ? "success" : "dim", submitText);
					tabs.push(`${submitStyled} →`);
					addLine(lines, width, ` ${tabs.join("")}`);
					lines.push("");
				}

				function formatOptionLine(option: RenderOption, index: number): string {
					const selected = index === optionIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const color = selected ? "accent" : "text";
					const label =
						option.isOther && inputMode ? `${index + 1}. ${option.label} ✎` : `${index + 1}. ${option.label}`;
					return prefix + theme.fg(color, label);
				}

				function appendOptions(lines: string[], width: number, options: RenderOption[]): void {
					for (let index = 0; index < options.length; index++) {
						const option = options[index];
						addLine(lines, width, formatOptionLine(option, index));
						if (option.description) addLine(lines, width, `     ${theme.fg("muted", option.description)}`);
					}
				}

				function appendCustomAnswerInput(
					lines: string[],
					width: number,
					question: Question,
					options: RenderOption[],
				): void {
					addLine(lines, width, theme.fg("text", ` ${question.prompt}`));
					lines.push("");
					appendOptions(lines, width, options);
					lines.push("");
					addLine(lines, width, theme.fg("muted", " Your answer:"));
					for (const line of editor.render(width - 2)) addLine(lines, width, ` ${line}`);
					lines.push("");
					addLine(lines, width, theme.fg("dim", " Enter to submit • Esc to cancel"));
				}

				function appendAnswerSummary(lines: string[], width: number): void {
					for (const question of questions) {
						const answer = answers.get(question.id);
						if (!answer) continue;
						const prefix = answer.wasCustom ? "(wrote) " : "";
						addLine(
							lines,
							width,
							`${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", prefix + answer.label)}`,
						);
					}
				}

				function appendSubmitPrompt(lines: string[], width: number): void {
					if (allAnswered()) {
						addLine(lines, width, theme.fg("success", " Press Enter to submit"));
						return;
					}
					const missing = questions
						.filter((question) => !answers.has(question.id))
						.map((question) => question.label)
						.join(", ");
					addLine(lines, width, theme.fg("warning", ` Unanswered: ${missing}`));
				}

				function appendSubmissionSummary(lines: string[], width: number): void {
					addLine(lines, width, theme.fg("accent", theme.bold(" Ready to submit")));
					lines.push("");
					appendAnswerSummary(lines, width);
					lines.push("");
					appendSubmitPrompt(lines, width);
				}

				function appendQuestionContent(
					lines: string[],
					width: number,
					question: Question | undefined,
					options: RenderOption[],
				): void {
					if (inputMode && question) {
						appendCustomAnswerInput(lines, width, question, options);
						return;
					}
					if (currentTab === questions.length) {
						appendSubmissionSummary(lines, width);
						return;
					}
					if (!question) return;
					addLine(lines, width, theme.fg("text", ` ${question.prompt}`));
					lines.push("");
					appendOptions(lines, width, options);
				}

				function appendQuestionnaireHelp(lines: string[], width: number): void {
					if (inputMode) return;
					const help = isMulti
						? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
						: " ↑↓ navigate • Enter select • Esc cancel";
					addLine(lines, width, theme.fg("dim", help));
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;
					const lines: string[] = [];
					addLine(lines, width, theme.fg("accent", "─".repeat(width)));
					appendQuestionTabs(lines, width);
					appendQuestionContent(lines, width, currentQuestion(), currentOptions());
					lines.push("");
					appendQuestionnaireHelp(lines, width);
					addLine(lines, width, theme.fg("accent", "─".repeat(width)));
					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: result,
				};
			}

			const firstQuestionLabelById = new Map<string, string>();
			for (const question of questions) {
				if (!firstQuestionLabelById.has(question.id)) firstQuestionLabelById.set(question.id, question.label);
			}
			const answerLines = result.answers.map((a) => {
				const qLabel = firstQuestionLabelById.get(a.id) || a.id;
				if (a.wasCustom) {
					return `${qLabel}: user wrote: ${a.label}`;
				}
				return `${qLabel}: user selected: ${a.index}. ${a.label}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				if (a.wasCustom) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
				}
				const display = a.index ? `${a.index}. ${a.label}` : a.label;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
