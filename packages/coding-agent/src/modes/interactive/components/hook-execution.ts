import { Box, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@fleetagent/pi-tui";
import type { HookExecutionCallNotice, HookExecutionNotice } from "../../../core/hooks/types.ts";
import { getMarkdownTheme, type ThemeColor, theme } from "../theme/theme.ts";

const MAX_CALL_LABEL_CHARS = 300;

interface HookCallView {
	label: string;
	source: string;
	status: string;
	statusColor: ThemeColor;
}

function truncateCallLabel(label: string): string {
	return label.length <= MAX_CALL_LABEL_CHARS ? label : `${label.slice(0, MAX_CALL_LABEL_CHARS - 1)}…`;
}

function hookCallView(call: HookExecutionCallNotice): HookCallView {
	const successful = call.status === "completed" && (call.exitCode === 0 || call.exitCode === null);
	const exit = call.exitCode === null ? "" : `, exit ${call.exitCode}`;
	return {
		label: `${call.type} ${truncateCallLabel(call.label)}`,
		source: `${call.source.kind}: ${call.source.path}`,
		status: `${call.status}${exit}, ${call.durationMs}ms`,
		statusColor: successful ? "success" : call.status === "cancelled" ? "warning" : "error",
	};
}

/** TUI-only card for completed hook calls and their model-visible returned prompts. */
export class HookExecutionComponent extends Container {
	private readonly eventName: string;
	private readonly subject: string | undefined;
	private readonly calls: HookCallView[];
	private readonly prompts: string[];
	private readonly markdownTheme: MarkdownTheme;
	private readonly box: Box;

	constructor(notice: HookExecutionNotice, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.eventName = notice.event;
		this.subject = notice.subject;
		this.calls = notice.calls.map(hookCallView);
		this.prompts = [...notice.returnedPrompts];
		this.markdownTheme = markdownTheme;
		this.box = new Box(1, 1, (text: string) => theme.bg("selectedBg", text));
		this.addChild(new Spacer(1));
		this.addChild(this.box);
		this.rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.box.clear();
		const subject = this.subject ? theme.fg("muted", ` · ${this.subject}`) : "";
		this.box.addChild(new Text(theme.fg("warning", theme.bold(`Hook · ${this.eventName}`)) + subject, 0, 0));
		this.box.addChild(new Spacer(1));

		for (const call of this.calls) {
			const status = theme.fg(call.statusColor, call.status);
			this.box.addChild(new Text(`${theme.fg("text", call.label)}  ${status}`, 0, 0));
			this.box.addChild(new Text(theme.fg("dim", call.source), 0, 0));
		}

		if (this.prompts.length === 0) return;
		this.box.addChild(new Spacer(1));
		this.box.addChild(
			new Text(
				theme.fg("warning", theme.bold(this.prompts.length === 1 ? "Returned prompt" : "Returned prompts")),
				0,
				0,
			),
		);
		for (let index = 0; index < this.prompts.length; index++) {
			if (this.prompts.length > 1) {
				this.box.addChild(new Text(theme.fg("muted", `Prompt ${index + 1}`), 0, 0));
			}
			this.box.addChild(
				new Markdown(this.prompts[index], 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("text", text),
				}),
			);
		}
	}
}
