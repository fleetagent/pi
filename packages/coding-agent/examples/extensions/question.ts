/**
 * Question Tool - Single question with options
 * Full custom UI: options list + inline editor for "Type something..."
 * Escape in editor returns to options, Escape in options cancels
 */

import type { ExtensionAPI, Theme } from "@fleetagent/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@fleetagent/pi-tui";
import { Type } from "typebox";

interface OptionWithDesc {
	label: string;
	description?: string;
}

type DisplayOption = OptionWithDesc & { isOther?: boolean };

interface QuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom?: boolean;
}

// Options with labels and optional descriptions
const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(OptionSchema, { description: "Options for the user to choose from" }),
});

interface QuestionPromptRenderState {
	theme: Theme;
	question: string;
	options: DisplayOption[];
	optionIndex: number;
	editMode: boolean;
	editor: Editor;
	width: number;
}

function appendQuestionLine(lines: string[], state: QuestionPromptRenderState, content: string): void {
	lines.push(truncateToWidth(content, state.width));
}

function formatQuestionOption(state: QuestionPromptRenderState, index: number): string {
	const option = state.options[index]!;
	const selected = index === state.optionIndex;
	const prefix = selected ? state.theme.fg("accent", "> ") : "  ";
	if (option.isOther === true && state.editMode) {
		return prefix + state.theme.fg("accent", `${index + 1}. ${option.label} ✎`);
	}
	if (selected) return prefix + state.theme.fg("accent", `${index + 1}. ${option.label}`);
	return `  ${state.theme.fg("text", `${index + 1}. ${option.label}`)}`;
}

function appendQuestionOptions(lines: string[], state: QuestionPromptRenderState): void {
	for (let index = 0; index < state.options.length; index++) {
		const option = state.options[index]!;
		appendQuestionLine(lines, state, formatQuestionOption(state, index));
		if (option.description) appendQuestionLine(lines, state, `     ${state.theme.fg("muted", option.description)}`);
	}
}

function appendCustomAnswerEditor(lines: string[], state: QuestionPromptRenderState): void {
	if (!state.editMode) return;
	lines.push("");
	appendQuestionLine(lines, state, state.theme.fg("muted", " Your answer:"));
	for (const line of state.editor.render(state.width - 2)) {
		appendQuestionLine(lines, state, ` ${line}`);
	}
}

function renderQuestionPrompt(state: QuestionPromptRenderState): string[] {
	const lines: string[] = [];
	appendQuestionLine(lines, state, state.theme.fg("accent", "─".repeat(state.width)));
	appendQuestionLine(lines, state, state.theme.fg("text", ` ${state.question}`));
	lines.push("");
	appendQuestionOptions(lines, state);
	appendCustomAnswerEditor(lines, state);
	lines.push("");
	const footer = state.editMode
		? " Enter to submit • Esc to go back"
		: " ↑↓ navigate • Enter to select • Esc to cancel";
	appendQuestionLine(lines, state, state.theme.fg("dim", footer));
	appendQuestionLine(lines, state, state.theme.fg("accent", "─".repeat(state.width)));
	return lines;
}
export default function question(pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "Question",
		description: "Ask the user a question and let them pick from options. Use when you need user input to proceed.",
		parameters: QuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: {
						question: params.question,
						options: params.options.map((o) => o.label),
						answer: null,
					} as QuestionDetails,
				};
			}

			if (params.options.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No options provided" }],
					details: { question: params.question, options: [], answer: null } as QuestionDetails,
				};
			}

			const allOptions: DisplayOption[] = [...params.options, { label: "Type something.", isOther: true }];

			const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean; index?: number } | null>(
				(tui, theme, _kb, done) => {
					let optionIndex = 0;
					let editMode = false;
					let cachedLines: string[] | undefined;

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

					editor.onSubmit = (value) => {
						const trimmed = value.trim();
						if (trimmed) {
							done({ answer: trimmed, wasCustom: true });
						} else {
							editMode = false;
							editor.setText("");
							refresh();
						}
					};

					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					function handleEditorInput(data: string): void {
						if (matchesKey(data, Key.escape)) {
							editMode = false;
							editor.setText("");
						} else {
							editor.handleInput(data);
						}
						refresh();
					}

					function selectCurrentOption(): void {
						const selected = allOptions[optionIndex];
						if (selected.isOther) {
							editMode = true;
							refresh();
							return;
						}
						done({ answer: selected.label, wasCustom: false, index: optionIndex + 1 });
					}

					function handleOptionAction(data: string): void {
						if (matchesKey(data, Key.enter)) {
							selectCurrentOption();
						} else if (matchesKey(data, Key.escape)) {
							done(null);
						}
					}

					function handleOptionNavigation(data: string): boolean {
						if (matchesKey(data, Key.up)) {
							optionIndex = Math.max(0, optionIndex - 1);
						} else if (matchesKey(data, Key.down)) {
							optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
						} else {
							return false;
						}
						refresh();
						return true;
					}

					function handleInput(data: string): void {
						if (editMode) {
							handleEditorInput(data);
							return;
						}
						if (handleOptionNavigation(data)) return;
						handleOptionAction(data);
					}

					function render(width: number): string[] {
						if (cachedLines) return cachedLines;
						cachedLines = renderQuestionPrompt({
							theme,
							question: params.question,
							options: allOptions,
							optionIndex,
							editMode,
							editor,
							width,
						});
						return cachedLines;
					}

					return {
						render,
						invalidate: () => {
							cachedLines = undefined;
						},
						handleInput,
					};
				},
			);

			// Build simple options list for details
			const simpleOptions = params.options.map((o) => o.label);

			if (!result) {
				return {
					content: [{ type: "text", text: "User cancelled the selection" }],
					details: { question: params.question, options: simpleOptions, answer: null } as QuestionDetails,
				};
			}

			if (result.wasCustom) {
				return {
					content: [{ type: "text", text: `User wrote: ${result.answer}` }],
					details: {
						question: params.question,
						options: simpleOptions,
						answer: result.answer,
						wasCustom: true,
					} as QuestionDetails,
				};
			}
			return {
				content: [{ type: "text", text: `User selected: ${result.index}. ${result.answer}` }],
				details: {
					question: params.question,
					options: simpleOptions,
					answer: result.answer,
					wasCustom: false,
				} as QuestionDetails,
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", args.question);
			const opts = Array.isArray(args.options) ? args.options : [];
			if (opts.length) {
				const labels = opts.map((o: OptionWithDesc) => o.label);
				const numbered = [...labels, "Type something."].map((o, i) => `${i + 1}. ${o}`);
				text += `\n${theme.fg("dim", `  Options: ${numbered.join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.answer === null) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			if (details.wasCustom) {
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", details.answer),
					0,
					0,
				);
			}
			const idx = details.options.indexOf(details.answer) + 1;
			const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
		},
	});
}
