import { afterEach, describe, expect, test, vi } from "vitest";
import type { FullscreenExitOutput } from "../../../src/core/settings-manager.ts";
import { InteractiveMode, type ShutdownOptions } from "../../../src/modes/interactive/interactive-mode.ts";

// Regression for https://github.com/fleetagent/pi/issues/5080
//
// On SIGTERM/SIGHUP the graceful shutdown must emit `session_shutdown`
// (runtimeHost.dispose) BEFORE touching the terminal. Extension teardown such
// as removing a socket does not write to the tty, so it must not be skipped if
// a later terminal-restore write fails on a dead or stalled terminal. The
// interactive quit path (Ctrl+D, /quit) keeps the opposite order to preserve
// the final TUI frame.

interface ShutdownRuntimeHost {
	dispose: () => Promise<void>;
}

interface ShutdownSettingsManager {
	getFullscreenExitOutput: () => FullscreenExitOutput;
}

interface ShutdownTerminal {
	drainInput: (ms: number) => Promise<void>;
}

interface ShutdownUI {
	terminal: ShutdownTerminal;
}

interface ShutdownThis {
	isShuttingDown: boolean;
	unregisterSignalHandlers: () => void;
	runtimeHost: ShutdownRuntimeHost;
	settingsManager: ShutdownSettingsManager;
	ui: ShutdownUI;
	stop: (fullscreenExitOutput?: FullscreenExitOutput) => void;
}

interface UncaughtCrashContext {
	isShuttingDown: boolean;
	unregisterSignalHandlers: () => void;
	stopInteractiveTui: (output: FullscreenExitOutput) => void;
}

interface FatalRuntimeErrorContext {
	showError: (message: string) => void;
	stop: (output?: FullscreenExitOutput) => void;
}

type InteractiveModePrototypeWithShutdown = {
	uncaughtCrash(this: UncaughtCrashContext, error: Error): never;
	handleFatalRuntimeError(this: FatalRuntimeErrorContext, prefix: string, error: unknown): Promise<never>;
	shutdown(this: ShutdownThis, options?: ShutdownOptions): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown;

class ProcessExitError extends Error {}

function createContext(order: string[], fullscreenExitOutput: FullscreenExitOutput = "resume-hint"): ShutdownThis {
	return {
		isShuttingDown: false,
		unregisterSignalHandlers: vi.fn(),
		runtimeHost: {
			dispose: vi.fn(async () => {
				order.push("dispose");
			}),
		},
		settingsManager: { getFullscreenExitOutput: () => fullscreenExitOutput },
		ui: {
			terminal: {
				drainInput: vi.fn(async () => {
					order.push("drainInput");
				}),
			},
		},
		stop: vi.fn((output) => {
			order.push(`stop:${output ?? "default"}`);
		}),
	};
}

async function callShutdown(context: ShutdownThis, options?: ShutdownOptions): Promise<void> {
	try {
		await (interactiveModePrototype as InteractiveModePrototypeWithShutdown).shutdown.call(context, options);
	} catch (error) {
		if (!(error instanceof ProcessExitError)) throw error;
	}
}

describe("InteractiveMode.shutdown ordering (#5080)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("signal-triggered shutdown emits session_shutdown before terminal writes", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);

		await callShutdown(context, { fromSignal: true });

		expect(order).toEqual(["dispose", "drainInput", "stop:resume-hint"]);
		expect(context.isShuttingDown).toBe(true);
		expect(context.unregisterSignalHandlers).toHaveBeenCalledTimes(1);
	});

	test("interactive quit stops the TUI before emitting session_shutdown", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);

		await callShutdown(context);

		expect(order).toEqual(["drainInput", "stop:resume-hint", "dispose"]);
	});

	test("fatal runtime errors force transcript output", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const showError = vi.fn();
		const stop = vi.fn();

		await expect(
			(interactiveModePrototype as InteractiveModePrototypeWithShutdown).handleFatalRuntimeError.call(
				{ showError, stop },
				"Fatal operation",
				new Error("failed"),
			),
		).rejects.toBeInstanceOf(ProcessExitError);
		expect(showError).toHaveBeenCalledWith("Fatal operation: failed");
		expect(stop).toHaveBeenCalledWith("transcript");
	});

	test("re-entrant shutdown is a no-op", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);
		context.isShuttingDown = true;

		await callShutdown(context, { fromSignal: true });

		expect(order).toEqual([]);
		expect(context.runtimeHost.dispose).not.toHaveBeenCalled();
	});

	test("uncaught runtime errors force transcript output while restoring the terminal", () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const unregisterSignalHandlers = vi.fn();
		const stopInteractiveTui = vi.fn();
		const context = { isShuttingDown: false, unregisterSignalHandlers, stopInteractiveTui };

		expect(() =>
			(interactiveModePrototype as InteractiveModePrototypeWithShutdown).uncaughtCrash.call(
				context,
				new Error("uncaught"),
			),
		).toThrow(ProcessExitError);
		expect(context.isShuttingDown).toBe(true);
		expect(unregisterSignalHandlers).toHaveBeenCalledTimes(1);
		expect(stopInteractiveTui).toHaveBeenCalledWith("transcript");
	});
});
