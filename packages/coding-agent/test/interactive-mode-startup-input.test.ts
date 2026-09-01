import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface SubmitDefaultEditor {
	onSubmit?: (text: string) => void;
}

// pi-ignore noNearIdenticalDataStructures: This startup-input editor fixture models only that test's private method surface and may diverge from sandbox-command fixtures.
interface SubmitEditor {
	addToHistory?: (text: string) => void;
	setText: (text: string) => void;
}

// pi-ignore noNearIdenticalDataStructures: This startup-input session fixture follows startup queue behavior independently from sandbox-command submission tests.
interface SubmitSession {
	isCompacting: boolean;
	isStreaming: boolean;
	isBashRunning: boolean;
	prompt: (text: string, options?: unknown) => Promise<void>;
}

interface SubmitContext {
	defaultEditor: SubmitDefaultEditor;
	editor: SubmitEditor;
	session: SubmitSession;
	flushPendingBashComponents: () => void;
	onInputCallback?: (text: string) => void;
	handleHooksCommand: (text: string) => void;
	handleSandboxCommand: (text: string) => Promise<void>;
	pendingUserInputs: string[];
}

type InputContext = {
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<string>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	const context = Object.create(InteractiveMode.prototype) as SubmitContext;
	Object.defineProperties(
		context,
		Object.getOwnPropertyDescriptors({
			defaultEditor: {},
			editor: {
				addToHistory: vi.fn(),
				setText: vi.fn(),
			},
			session: {
				isCompacting: false,
				isStreaming: false,
				isBashRunning: false,
				prompt: vi.fn(async () => {}),
			},
			flushPendingBashComponents: vi.fn(),
			handleHooksCommand: vi.fn(),
			handleSandboxCommand: vi.fn(async () => {}),
			pendingUserInputs: [],
		}),
	);
	return context;
}

describe("InteractiveMode startup input", () => {
	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual(["early prompt"]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("handles hook control before queuing streaming input", async () => {
		const context = createSubmitContext();
		context.session.isStreaming = true;
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/hooks disable");

		expect(context.handleHooksCommand).toHaveBeenCalledWith("/hooks disable");
		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(context.pendingUserInputs).toEqual([]);
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: ["queued prompt"],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("queued prompt");
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});
});
