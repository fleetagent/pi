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

interface CountedValue {
	value: string;
	count: number;
}

interface GroupedHookCall {
	call: HookExecutionCallNotice;
	invocationCount: number;
	totalDurationMs: number;
	statuses: CountedValue[];
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

function callIdentity(call: HookExecutionCallNotice): string {
	return JSON.stringify([call.type, truncateCallLabel(call.label), call.source.kind, call.source.path]);
}

function statusIdentity(call: HookExecutionCallNotice): string {
	return call.exitCode === null ? call.status : `${call.status} (exit ${call.exitCode})`;
}

function countValues(values: Iterable<string>): CountedValue[] {
	const counts = new Map<string, CountedValue>();
	for (const value of values) {
		const existing = counts.get(value);
		if (existing) {
			existing.count += 1;
		} else {
			counts.set(value, { value, count: 1 });
		}
	}
	return [...counts.values()];
}

function groupedHookCalls(notices: readonly HookExecutionNotice[]): GroupedHookCall[] {
	const groups = new Map<string, GroupedHookCall>();
	for (const notice of notices) {
		for (const call of notice.calls) {
			const identity = callIdentity(call);
			const status = statusIdentity(call);
			const existing = groups.get(identity);
			if (existing) {
				existing.invocationCount += 1;
				existing.totalDurationMs += call.durationMs;
				const existingStatus = existing.statuses.find((entry) => entry.value === status);
				if (existingStatus) existingStatus.count += 1;
				else existing.statuses.push({ value: status, count: 1 });
			} else {
				groups.set(identity, {
					call,
					invocationCount: 1,
					totalDurationMs: call.durationMs,
					statuses: [{ value: status, count: 1 }],
				});
			}
		}
	}
	return [...groups.values()];
}

function groupedCallStatus(group: GroupedHookCall): string {
	const statuses = group.statuses.map(({ value, count }) => `${value}${count > 1 ? ` ×${count}` : ""}`).join("; ");
	return `${statuses}, ~${(group.totalDurationMs / group.invocationCount).toFixed(1)}ms`;
}

function groupedCallStatusColor(group: GroupedHookCall): ThemeColor {
	if (group.statuses.every(({ value }) => value === "completed" || value === "completed (exit 0)")) return "success";
	if (group.statuses.every(({ value }) => value.startsWith("cancelled"))) return "warning";
	return "error";
}

/** TUI-only card for completed hook calls and their model-visible returned prompts. */
export class HookExecutionComponent extends Container {
	private readonly notices: HookExecutionNotice[];
	private readonly markdownTheme: MarkdownTheme;
	private readonly box: Box;

	constructor(notice: HookExecutionNotice, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.notices = [notice];
		this.markdownTheme = markdownTheme;
		this.box = new Box(1, 1, (text: string) => theme.bg("selectedBg", text));
		this.addChild(new Spacer(1));
		this.addChild(this.box);
		this.rebuild();
	}

	appendNotice(notice: HookExecutionNotice): void {
		if (notice.event !== this.notices[0].event) {
			throw new Error(`Cannot group ${notice.event} notice with ${this.notices[0].event}`);
		}
		this.notices.push(notice);
		this.rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.box.clear();
		const firstNotice = this.notices[0];
		if (this.notices.length === 1) {
			this.renderSingleNotice(firstNotice);
			return;
		}
		this.renderGroupedNotices(firstNotice);
	}

	private renderSingleNotice(notice: HookExecutionNotice): void {
		const subject = notice.subject ? theme.fg("muted", ` · ${notice.subject}`) : "";
		this.box.addChild(new Text(theme.fg("warning", theme.bold(`Hook · ${notice.event}`)) + subject, 0, 0));
		this.box.addChild(new Spacer(1));

		for (const call of notice.calls.map(hookCallView)) {
			const status = theme.fg(call.statusColor, call.status);
			this.box.addChild(new Text(`${theme.fg("text", call.label)}  ${status}`, 0, 0));
			this.box.addChild(new Text(theme.fg("dim", call.source), 0, 0));
		}
		this.renderPrompts(countValues(notice.returnedPrompts), false);
	}

	private renderGroupedNotices(firstNotice: HookExecutionNotice): void {
		this.box.addChild(new Text(theme.fg("warning", theme.bold(`Hook · ${firstNotice.event}`)), 0, 0));
		const subjects = countValues(
			this.notices.flatMap((notice) => (notice.subject === undefined ? [] : [notice.subject])),
		);
		if (subjects.length > 0) {
			const summary = subjects.map(({ value, count }) => `${value}${count > 1 ? ` ×${count}` : ""}`).join(", ");
			this.box.addChild(new Text(theme.fg("muted", `Tools: ${summary}`), 0, 0));
		}
		this.box.addChild(new Spacer(1));

		for (const group of groupedHookCalls(this.notices)) {
			const call = hookCallView(group.call);
			const status = theme.fg(groupedCallStatusColor(group), groupedCallStatus(group));
			this.box.addChild(new Text(`${theme.fg("text", call.label)}  ${status}`, 0, 0));
			this.box.addChild(new Text(theme.fg("dim", call.source), 0, 0));
		}
		this.renderPrompts(countValues(this.notices.flatMap((notice) => notice.returnedPrompts)), true);
	}

	private renderPrompts(prompts: readonly CountedValue[], grouped: boolean): void {
		if (prompts.length === 0) return;
		this.box.addChild(new Spacer(1));
		this.box.addChild(
			new Text(
				theme.fg("warning", theme.bold(prompts.length === 1 && !grouped ? "Returned prompt" : "Returned prompts")),
				0,
				0,
			),
		);
		for (let index = 0; index < prompts.length; index++) {
			const prompt = prompts[index];
			if (prompts.length > 1 || grouped) {
				const count = prompt.count > 1 ? ` ×${prompt.count}` : "";
				this.box.addChild(new Text(theme.fg("muted", `Prompt ${index + 1}${count}`), 0, 0));
			}
			this.box.addChild(
				new Markdown(prompt.value, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("text", text),
				}),
			);
		}
	}
}
