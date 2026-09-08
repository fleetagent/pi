import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type PathCommand = "/cd" | "/export" | "/import";

type InteractiveModePrototype = {
	getPathCommandArgument(this: unknown, text: string, command: PathCommand): string | undefined;
	handleCdCommand(this: CdCommandContext, text: string): Promise<void>;
};

interface CdCommandActiveSession {
	getCwd: () => string;
}

interface CdCommandSession {
	isIdle: boolean;
	isBashRunning: boolean;
	supportsDirectoryChange: () => boolean;
}

interface CdCommandSwitchResult {
	cancelled: boolean;
}

interface CdCommandRuntimeHost {
	changeDirectory: (cwd: string) => Promise<CdCommandSwitchResult>;
}

interface CdCommandContext {
	activeSession: CdCommandActiveSession;
	session: CdCommandSession;
	runtimeHost: CdCommandRuntimeHost;
	getPathCommandArgument: (text: string, command: PathCommand) => string | undefined;
	renderCurrentSessionState: () => void;
	showError: (message: string) => void;
	showWarning: (message: string) => void;
	showStatus: (message: string) => void;
}

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;
const tempDirectories: string[] = [];

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createContext(cwd: string): CdCommandContext {
	return {
		activeSession: {
			getCwd: () => cwd,
		},
		session: {
			isIdle: true,
			isBashRunning: false,
			supportsDirectoryChange: () => true,
		},
		runtimeHost: { changeDirectory: vi.fn(async () => ({ cancelled: false })) },
		getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
		renderCurrentSessionState: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
	};
}

describe("InteractiveMode /cd", () => {
	it("reopens the current session with the selected working directory", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-cd-command-"));
		tempDirectories.push(cwd);
		mkdirSync(join(cwd, "next"));
		const context = createContext(cwd);

		await interactiveModePrototype.handleCdCommand.call(context, "/cd next");

		expect(context.runtimeHost.changeDirectory).toHaveBeenCalledWith(realpathSync(join(cwd, "next")));
		expect(context.renderCurrentSessionState).toHaveBeenCalledOnce();
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("reports a missing directory without switching sessions", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-cd-command-"));
		tempDirectories.push(cwd);
		const context = createContext(cwd);

		await interactiveModePrototype.handleCdCommand.call(context, "/cd missing");

		expect(context.showError).toHaveBeenCalledWith("Directory not found: missing");
		expect(context.runtimeHost.changeDirectory).not.toHaveBeenCalled();
	});
});
