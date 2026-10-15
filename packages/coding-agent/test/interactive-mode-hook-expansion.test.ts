import { Container, getKeybindings, type MarkdownTheme, setKeybindings, TuiMainScreen } from "@fleetagent/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { HOOK_EXECUTION_CUSTOM_TYPE, type HookEventName, type HookExecutionNotice } from "../src/core/hooks/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import type { HookExecutionComponent } from "../src/modes/interactive/components/hook-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

interface HookTranscriptContext {
	messages: CustomMessage[];
}

interface HookExpansionSession {
	buildSessionContext(): HookTranscriptContext;
}

interface HookExpansionUi {
	requestRender(): void;
}

interface HookExpansionContext {
	activeSession: HookExpansionSession;
	hookExecutionSession: HookExpansionSession | undefined;
	hookExecutionNotices: HookExecutionNotice[][];
	hookExecutionComponents: HookExecutionComponent[];
	hookExecutionTurnActive: boolean;
	activeToolHookExecutionGroups: Map<HookEventName, HookExecutionNotice[]>;
	toolOutputExpanded: boolean;
	chatContainer: Container;
	pendingTools: Map<string, unknown>;
	ui: HookExpansionUi;
	getMarkdownThemeWithSettings(): MarkdownTheme;
	addHookExecutionNotice(notice: HookExecutionNotice): void;
	addCustomMessage(message: CustomMessage): void;
	toggleToolOutputExpansion(): void;
	setToolsExpanded(expanded: boolean): void;
	rebuildChatFromMessages(): void;
}

const notice: HookExecutionNotice = {
	event: "PreToolUse",
	subject: "Read",
	calls: [
		{
			type: "command",
			label: "check-tool.sh",
			source: { kind: "project", path: "/workspace/.pi/settings.json" },
			status: "completed",
			exitCode: 0,
			durationMs: 7,
		},
	],
	returnedPrompts: ["Hook feedback."],
};

function auditMessage(): CustomMessage {
	return {
		role: "custom",
		customType: HOOK_EXECUTION_CUSTOM_TYPE,
		content: JSON.stringify(notice),
		display: true,
		timestamp: 0,
	};
}

function createContext(expanded = false): HookExpansionContext {
	const context = Object.create(InteractiveMode.prototype) as HookExpansionContext;
	Object.defineProperties(
		context,
		Object.getOwnPropertyDescriptors({
			activeSession: { buildSessionContext: () => ({ messages: [auditMessage()] }) },
			hookExecutionSession: undefined,
			hookExecutionNotices: [],
			hookExecutionComponents: [],
			hookExecutionTurnActive: false,
			activeToolHookExecutionGroups: new Map(),
			toolOutputExpanded: expanded,
			chatContainer: new Container(),
			pendingTools: new Map(),
			ui: { requestRender: vi.fn() },
			getMarkdownThemeWithSettings: getMarkdownTheme,
		}),
	);
	return context;
}

function render(context: HookExpansionContext): string {
	return stripAnsi(context.chatContainer.render(120).join("\n"));
}

describe("InteractiveMode hook expansion", () => {
	const previousKeybindings = getKeybindings();
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));
	afterEach(() => setKeybindings(previousKeybindings));

	it("toggles existing hook cards alongside ordinary expandable components", () => {
		const context = createContext();
		const tool = new Container();
		const setExpanded = vi.fn();
		Object.assign(tool, { setExpanded });
		context.chatContainer.addChild(tool);
		context.addHookExecutionNotice(notice);
		expect(render(context)).not.toContain("check-tool.sh");
		context.toggleToolOutputExpansion();
		expect(render(context)).toContain("check-tool.sh");
		expect(render(context)).toContain("Hook feedback.");
		expect(setExpanded).toHaveBeenLastCalledWith(true);
		context.toggleToolOutputExpansion();
		expect(render(context)).not.toContain("Hook feedback.");
		expect(setExpanded).toHaveBeenLastCalledWith(false);
		expect(context.ui.requestRender).toHaveBeenCalled();
	});

	it.each([false, true])("initializes live and persisted cards from expanded=%s", (expanded) => {
		const context = createContext(expanded);
		context.addHookExecutionNotice(notice);
		context.addCustomMessage(auditMessage());
		expect(context.hookExecutionComponents).toHaveLength(2);
		for (const component of context.hookExecutionComponents) {
			const text = stripAnsi(component.render(120).join("\n"));
			expect(text.includes("Hook feedback.")).toBe(expanded);
		}
	});

	it.each([false, true])("retains expanded=%s when notices join an active group", (expanded) => {
		const context = createContext(expanded);
		context.hookExecutionSession = context.activeSession;
		context.hookExecutionTurnActive = true;
		context.addHookExecutionNotice(notice);
		context.addHookExecutionNotice({ ...notice, subject: "Bash" });
		expect(context.hookExecutionComponents).toHaveLength(1);
		expect(context.hookExecutionNotices[0]).toHaveLength(2);
		expect(render(context)).toContain("Read, Bash");
		expect(render(context).includes("Hook feedback.")).toBe(expanded);
		context.setToolsExpanded(!expanded);
		expect(render(context).includes("Hook feedback.")).toBe(!expanded);
	});

	it.each([false, true])("reconstructs audit cards with current expanded=%s", (expanded) => {
		const context = createContext();
		context.addHookExecutionNotice(notice);
		const old = context.hookExecutionComponents[0];
		context.setToolsExpanded(expanded);
		context.rebuildChatFromMessages();
		expect(context.hookExecutionComponents).toHaveLength(1);
		expect(context.hookExecutionComponents[0]).not.toBe(old);
		expect(context.hookExecutionTurnActive).toBe(false);
		expect(render(context).includes("Hook feedback.")).toBe(expanded);
	});

	it("clears old session cards without resetting global expansion", () => {
		const context = createContext(true);
		context.addHookExecutionNotice(notice);
		const old = context.hookExecutionComponents[0];
		context.activeSession = { buildSessionContext: () => ({ messages: [] }) };
		context.addHookExecutionNotice({ ...notice, subject: "Bash" });
		expect(context.chatContainer.children).not.toContain(old);
		expect(context.hookExecutionComponents).toHaveLength(1);
		expect(render(context)).toContain("Bash");
		expect(render(context)).toContain("Hook feedback.");
	});
	it("dispatches a remapped expansion shortcut through the editor", () => {
		const bindings = new KeybindingsManager({ "app.tools.expand": "ctrl+e" });
		setKeybindings(bindings);
		const context = createContext();
		context.addHookExecutionNotice(notice);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, bindings);
		editor.onAction("app.tools.expand", () => context.toggleToolOutputExpansion());
		expect(render(context)).toContain("ctrl+e to expand");
		editor.handleInput("\x0f"); // Default Ctrl+O is no longer bound.
		expect(render(context)).not.toContain("Hook feedback.");
		editor.handleInput("\x05"); // Remapped Ctrl+E.
		expect(render(context)).toContain("Hook feedback.");
		editor.handleInput("\x05");
		expect(render(context)).not.toContain("Hook feedback.");
	});
});
