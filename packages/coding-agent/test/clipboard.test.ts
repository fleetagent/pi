import { execFileSync, execSync, spawn } from "child_process";
import { EventEmitter } from "events";
import { platform } from "os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { copyToClipboard, readClipboardText } from "../src/utils/clipboard.ts";

const mocks = vi.hoisted(() => {
	return {
		clipboard: {
			getText: vi.fn<() => Promise<string>>(),
			setText: vi.fn<(text: string) => Promise<void>>(),
		},
		execFileSync: vi.fn(),
		execSync: vi.fn(),
		spawn: vi.fn(),
		platform: vi.fn<() => NodeJS.Platform>(),
		isWaylandSession: vi.fn<() => boolean>(),
	};
});

vi.mock("../src/utils/clipboard-native.ts", () => {
	return {
		clipboard: mocks.clipboard,
	};
});

vi.mock("child_process", () => {
	return {
		execFileSync: mocks.execFileSync,
		execSync: mocks.execSync,
		spawn: mocks.spawn,
	};
});

vi.mock("os", () => {
	return {
		platform: mocks.platform,
	};
});

vi.mock("../src/utils/clipboard-image.ts", () => {
	return {
		isWaylandSession: mocks.isWaylandSession,
	};
});

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedExecSync = vi.mocked(execSync);
const mockedSpawn = vi.mocked(spawn);
const mockedPlatform = vi.mocked(platform);

interface WlCopyProcessFixture {
	events: EventEmitter;
	stdinEvents: EventEmitter;
	write: ReturnType<typeof vi.fn>;
	end: ReturnType<typeof vi.fn>;
}
type StdoutWriteCallback = (error: Error | null | undefined) => void;
type StdoutWriteInvocation = [
	chunk: unknown,
	encodingOrCallback?: BufferEncoding | StdoutWriteCallback,
	callback?: StdoutWriteCallback,
];

let originalWrite: typeof process.stdout.write;
let stdoutWrites: string[];
let nativeResolved = false;

function osc52Writes(): string[] {
	return stdoutWrites.filter((write) => write.startsWith("\x1b]52;c;"));
}

function mockWlCopyProcess(): WlCopyProcessFixture {
	const events = new EventEmitter();
	const stdinEvents = new EventEmitter();
	const write = vi.fn();
	const end = vi.fn();
	const stdin = Object.assign(stdinEvents, { write, end });
	mockedSpawn.mockReturnValue(Object.assign(events, { stdin }) as unknown as ReturnType<typeof spawn>);
	return { events, stdinEvents, write, end };
}

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.stubEnv("SSH_CONNECTION", "");
	vi.stubEnv("SSH_CLIENT", "");
	vi.stubEnv("MOSH_CONNECTION", "");
	stdoutWrites = [];
	nativeResolved = false;
	mocks.clipboard.getText.mockReset();
	mocks.clipboard.setText.mockReset();
	mocks.execFileSync.mockReset();
	mocks.execSync.mockReset();
	mocks.spawn.mockReset();
	mocks.platform.mockReset();
	mocks.isWaylandSession.mockReset();
	mockedPlatform.mockReturnValue("darwin");
	mocks.isWaylandSession.mockReturnValue(false);
	mocks.clipboard.getText.mockResolvedValue("");
	mocks.clipboard.setText.mockImplementation(async () => {
		await new Promise((resolve) => setTimeout(resolve, 1));
		nativeResolved = true;
	});
	originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((...args: StdoutWriteInvocation) => {
		const [chunk] = args;
		if (typeof chunk === "string" && chunk.startsWith("\x1b]52;c;")) {
			stdoutWrites.push(chunk);
			return true;
		}
		return Reflect.apply(originalWrite, undefined, args);
	}) as typeof process.stdout.write;
});

afterEach(() => {
	process.stdout.write = originalWrite;
	vi.unstubAllEnvs();
});

describe("readClipboardText", () => {
	test("returns native clipboard text", async () => {
		mocks.clipboard.getText.mockResolvedValue("clipboard text");

		await expect(readClipboardText()).resolves.toBe("clipboard text");
	});

	test("reads the Wayland clipboard before the stale native X11 clipboard", async () => {
		// Regression test for #7248.
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		mockedExecFileSync.mockReturnValue("Wayland text");
		mocks.clipboard.getText.mockResolvedValue("stale X11 text");

		await expect(readClipboardText()).resolves.toBe("Wayland text");
		expect(mockedExecFileSync).toHaveBeenCalledWith("wl-paste", ["--no-newline", "--type", "text"], {
			encoding: "utf8",
			maxBuffer: 50 * 1024 * 1024,
			timeout: 5000,
		});
		expect(mocks.clipboard.getText).not.toHaveBeenCalled();
	});

	test("does not fall back to stale X11 text when the Wayland clipboard is empty", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		mockedExecFileSync.mockReturnValue("");
		mocks.clipboard.getText.mockResolvedValue("stale X11 text");

		await expect(readClipboardText()).resolves.toBeNull();
		expect(mocks.clipboard.getText).not.toHaveBeenCalled();
	});

	test("falls back to the native clipboard when wl-paste is unavailable", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		mockedExecFileSync.mockImplementation(() => {
			throw new Error("wl-paste unavailable");
		});
		mocks.clipboard.getText.mockResolvedValue("X11 fallback text");

		await expect(readClipboardText()).resolves.toBe("X11 fallback text");
	});

	test("skips wl-paste without a Wayland display socket", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "");
		mocks.clipboard.getText.mockResolvedValue("native text");

		await expect(readClipboardText()).resolves.toBe("native text");
		expect(mockedExecFileSync).not.toHaveBeenCalled();
	});

	test("returns null for empty or unavailable clipboard text", async () => {
		await expect(readClipboardText()).resolves.toBeNull();

		mocks.clipboard.getText.mockRejectedValue(new Error("clipboard unavailable"));
		await expect(readClipboardText()).resolves.toBeNull();
	});
});

describe("copyToClipboard", () => {
	test("awaits a clean wl-copy exit before reporting Wayland success", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		vi.stubEnv("DISPLAY", ":0");
		mockedExecSync.mockReturnValue(Buffer.alloc(0));
		const child = mockWlCopyProcess();

		let settled = false;
		const copyPromise = copyToClipboard("hello");
		void copyPromise.then(() => {
			settled = true;
		});
		await Promise.resolve();

		expect(settled).toBe(false);
		expect(mockedSpawn).toHaveBeenCalledWith("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
		expect(child.write).toHaveBeenCalledWith("hello");
		expect(child.end).toHaveBeenCalledOnce();
		child.stdinEvents.emit("error", new Error("EPIPE"));
		child.events.emit("close", 0);
		await copyPromise;

		expect(settled).toBe(true);
		expect(mockedExecSync).toHaveBeenCalledTimes(1);
		expect(mockedExecSync).toHaveBeenCalledWith("which wl-copy", { stdio: "ignore" });
		expect(osc52Writes()).toHaveLength(0);
	});

	test("falls through to X11 when wl-copy exits unsuccessfully", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		vi.stubEnv("DISPLAY", ":0");
		mockedExecSync.mockReturnValue(Buffer.alloc(0));
		const child = mockWlCopyProcess();

		const copyPromise = copyToClipboard("hello");
		child.events.emit("close", 1);
		await copyPromise;

		expect(mockedExecSync).toHaveBeenNthCalledWith(1, "which wl-copy", { stdio: "ignore" });
		expect(mockedExecSync).toHaveBeenNthCalledWith(2, "xclip -selection clipboard", {
			input: "hello",
			stdio: ["pipe", "ignore", "ignore"],
			timeout: 5000,
		});
		expect(osc52Writes()).toHaveLength(0);
	});

	test("falls through to OSC 52 when wl-copy emits a process error without X11", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		vi.stubEnv("DISPLAY", "");
		mockedExecSync.mockReturnValue(Buffer.alloc(0));
		const child = mockWlCopyProcess();

		const copyPromise = copyToClipboard("hello");
		child.events.emit("error", new Error("wl-copy failed"));
		await copyPromise;

		expect(mockedExecSync).toHaveBeenCalledTimes(1);
		expect(osc52Writes()).toEqual([`\x1b]52;c;${Buffer.from("hello").toString("base64")}\x07`]);
	});
	test("local native success skips OSC 52 and shell fallbacks", async () => {
		await copyToClipboard("hello");

		expect(mocks.clipboard.setText).toHaveBeenCalledWith("hello");
		expect(osc52Writes()).toHaveLength(0);
		expect(mockedExecSync).not.toHaveBeenCalled();
		expect(mockedSpawn).not.toHaveBeenCalled();
	});

	test("remote native success emits OSC 52 after native write", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		mocks.clipboard.setText.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
			expect(osc52Writes()).toHaveLength(0);
			nativeResolved = true;
		});

		await copyToClipboard("hello");

		expect(nativeResolved).toBe(true);
		expect(osc52Writes()).toHaveLength(1);
		expect(mockedExecSync).not.toHaveBeenCalled();
	});

	test("local shell fallback success skips OSC 52", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockedExecSync.mockReturnValue(Buffer.alloc(0));

		await copyToClipboard("hello");

		expect(mockedExecSync).toHaveBeenCalledWith("pbcopy", {
			input: "hello",
			stdio: ["pipe", "ignore", "ignore"],
			timeout: 5000,
		});
		expect(osc52Writes()).toHaveLength(0);
	});

	test("uses OSC 52 fallback when native and shell tools fail", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockedExecSync.mockImplementation(() => {
			throw new Error("pbcopy failed");
		});

		await copyToClipboard("hello");

		expect(osc52Writes()).toHaveLength(1);
	});

	test("does not emit oversized OSC 52 payloads", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mockedExecSync.mockImplementation(() => {
			throw new Error("pbcopy failed");
		});

		await expect(copyToClipboard("x".repeat(80_000))).rejects.toThrow("Failed to copy to clipboard");
		expect(osc52Writes()).toHaveLength(0);
	});
});
