/**
 * Overlay Test - validates overlay compositing with inline text inputs
 *
 * Usage: pi --extension ./examples/extensions/overlay-test.ts
 *
 * Run /overlay-test to show a floating overlay with:
 * - Inline text inputs within menu items
 * - Edge case tests (wide chars, styled text, emoji)
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@fleetagent/pi-coding-agent";
import { CURSOR_MARKER, type Focusable, matchesKey, visibleWidth } from "@fleetagent/pi-tui";

interface OverlayTestResult {
	action: string;
	query?: string;
}

interface OverlayTestItem {
	label: string;
	hasInput: boolean;
	text: string;
	cursor: number;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("overlay-test", {
		description: "Test overlay rendering with edge cases",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const result = await ctx.ui.custom<OverlayTestResult | undefined>(
				(_tui, theme, _keybindings, done) => new OverlayTestComponent(theme, done),
				{ overlay: true },
			);

			if (result) {
				const msg = result.query ? `${result.action}: "${result.query}"` : result.action;
				ctx.ui.notify(msg, "info");
			}
		},
	});
}

class OverlayTestComponent implements Focusable {
	readonly width = 70;

	/** Focusable interface - set by TUI when focus changes */
	focused = false;

	private selected = 0;
	private items: OverlayTestItem[] = [
		{ label: "Search", hasInput: true, text: "", cursor: 0 },
		{ label: "Run", hasInput: true, text: "", cursor: 0 },
		{ label: "Settings", hasInput: false, text: "", cursor: 0 },
		{ label: "Cancel", hasInput: false, text: "", cursor: 0 },
	];

	private theme: Theme;
	private done: (result: OverlayTestResult | undefined) => void;

	constructor(theme: Theme, done: (result: OverlayTestResult | undefined) => void) {
		this.theme = theme;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done(undefined);
			return;
		}

		const current = this.items[this.selected]!;

		if (matchesKey(data, "return")) {
			this.done({ action: current.label, query: current.hasInput ? current.text : undefined });
			return;
		}

		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
		} else if (matchesKey(data, "down")) {
			this.selected = Math.min(this.items.length - 1, this.selected + 1);
		} else if (current.hasInput) {
			this.editInput(current, data);
		}
	}

	private editInput(item: OverlayTestItem, data: string): void {
		if (matchesKey(data, "backspace")) {
			if (item.cursor === 0) return;
			item.text = item.text.slice(0, item.cursor - 1) + item.text.slice(item.cursor);
			item.cursor--;
			return;
		}
		if (matchesKey(data, "left")) {
			item.cursor = Math.max(0, item.cursor - 1);
			return;
		}
		if (matchesKey(data, "right")) {
			item.cursor = Math.min(item.text.length, item.cursor + 1);
			return;
		}
		if (data.length !== 1 || data.charCodeAt(0) < 32) return;
		item.text = item.text.slice(0, item.cursor) + data + item.text.slice(item.cursor);
		item.cursor++;
	}

	private renderRow(content: string, innerWidth: number): string {
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
		return this.theme.fg("border", "│") + content + padding + this.theme.fg("border", "│");
	}

	private renderActionItem(item: OverlayTestItem, index: number): string {
		const isSelected = index === this.selected;
		const prefix = isSelected ? " ▶ " : "   ";
		if (!item.hasInput) {
			const label = isSelected ? this.theme.fg("accent", item.label) : this.theme.fg("text", item.label);
			return prefix + label;
		}

		const label = isSelected ? this.theme.fg("accent", `${item.label}:`) : this.theme.fg("text", `${item.label}:`);
		let inputDisplay = item.text;
		if (isSelected) {
			const before = inputDisplay.slice(0, item.cursor);
			const cursorChar = item.cursor < inputDisplay.length ? inputDisplay[item.cursor] : " ";
			const after = inputDisplay.slice(item.cursor + 1);
			// Emit hardware cursor marker for IME support when focused
			const marker = this.focused ? CURSOR_MARKER : "";
			inputDisplay = `${before}${marker}\x1b[7m${cursorChar}\x1b[27m${after}`;
		}
		return `${prefix + label} ${inputDisplay}`;
	}
	render(_width: number): string[] {
		const w = this.width;
		const th = this.theme;
		const innerW = w - 2;
		const lines: string[] = [];

		const row = (content: string) => this.renderRow(content, innerW);

		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		lines.push(row(` ${th.fg("accent", "🧪 Overlay Test")}`));
		lines.push(row(""));

		// Edge cases - full width lines to test compositing at boundaries
		lines.push(row(` ${th.fg("dim", "─── Edge Cases (borders should align) ───")}`));
		lines.push(row(` Wide: ${th.fg("warning", "中文日本語한글テスト漢字繁體简体ひらがなカタカナ가나다라마바")}`));
		lines.push(
			row(
				` Styled: ${th.fg("error", "RED")} ${th.fg("success", "GREEN")} ${th.fg("warning", "YELLOW")} ${th.fg("accent", "ACCENT")} ${th.fg("dim", "DIM")} ${th.fg("error", "more")} ${th.fg("success", "colors")}`,
			),
		);
		lines.push(row(" Emoji: 👨‍👩‍👧‍👦 🇯🇵 🚀 💻 🎉 🔥 😀 🎯 🌟 💡 🎨 🔧 📦 🏆 🌈 🎪 🎭 🎬 🎮 🎲"));
		lines.push(row(""));

		// Menu with inline inputs
		lines.push(row(` ${th.fg("dim", "─── Actions ───")}`));

		for (let i = 0; i < this.items.length; i++) {
			lines.push(row(this.renderActionItem(this.items[i]!, i)));
		}

		lines.push(row(""));
		lines.push(row(` ${th.fg("dim", "↑↓ navigate • type to input • Enter select • Esc cancel")}`));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}
