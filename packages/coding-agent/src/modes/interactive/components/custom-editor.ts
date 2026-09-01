import { Editor, type EditorOptions, type EditorTheme, type TUI } from "@fleetagent/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	private handleInterruptInput(data: string): boolean {
		if (!this.keybindings.matches(data, "app.interrupt")) return false;
		if (!this.isShowingAutocomplete()) {
			const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
			if (handler) {
				handler();
				return true;
			}
		}
		super.handleInput(data);
		return true;
	}

	private handleExitInput(data: string): boolean {
		if (!this.keybindings.matches(data, "app.exit") || this.getText().length > 0) return false;
		const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
		handler?.();
		return true;
	}

	private handleExplicitHistoryBinding(data: string): boolean {
		if (
			!this.keybindings.matches(data, "tui.editor.historyPrevious") &&
			!this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			return false;
		}
		super.handleInput(data);
		return true;
	}

	private handleAppAction(data: string): boolean {
		for (const [action, handler] of this.actionHandlers) {
			if (action === "app.interrupt" || action === "app.exit" || !this.keybindings.matches(data, action)) continue;
			handler();
			return true;
		}
		return false;
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		if (this.handleInterruptInput(data)) return;
		if (this.handleExitInput(data)) return;

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (this.handleExplicitHistoryBinding(data)) return;
		if (this.handleAppAction(data)) return;

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
