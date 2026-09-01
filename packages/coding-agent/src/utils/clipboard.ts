import { type ExecFileSyncOptionsWithStringEncoding, execFileSync, execSync, spawn } from "child_process";
import { platform } from "os";
import { isWaylandSession } from "./clipboard-image.ts";
import { clipboard } from "./clipboard-native.ts";

type NativeClipboardExecOptions = {
	input: string;
	timeout: number;
	stdio: ["pipe", "ignore", "ignore"];
};

function copyToX11Clipboard(options: NativeClipboardExecOptions): void {
	try {
		execSync("xclip -selection clipboard", options);
	} catch {
		execSync("xsel --clipboard --input", options);
	}
}

const MAX_OSC52_ENCODED_LENGTH = 100_000;

function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

type ClipboardReadResult = { ok: true; text: string | null } | { ok: false };

const READ_CLIPBOARD_OPTIONS: ExecFileSyncOptionsWithStringEncoding = {
	encoding: "utf8",
	maxBuffer: 50 * 1024 * 1024,
	timeout: 5000,
};

function readWaylandClipboardText(): ClipboardReadResult {
	try {
		const text = execFileSync("wl-paste", ["--no-newline", "--type", "text"], READ_CLIPBOARD_OPTIONS);
		return { ok: true, text: text || null };
	} catch {
		return { ok: false };
	}
}

/** Read plain text from the system clipboard. */
export async function readClipboardText(): Promise<string | null> {
	if (platform() === "linux" && isWaylandSession() && process.env.WAYLAND_DISPLAY) {
		const result = readWaylandClipboardText();
		if (result.ok) {
			return result.text;
		}
	}

	if (!clipboard) {
		return null;
	}

	try {
		const text = await clipboard.getText();
		return text || null;
	} catch {
		return null;
	}
}

type ClipboardCopyAttempt = boolean | Promise<boolean>;

function writeWaylandClipboard(text: string): Promise<number> {
	return new Promise((resolve) => {
		const proc = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
		proc.on("error", () => resolve(1));
		proc.on("close", (code) => resolve(code ?? 1));
		proc.stdin.on("error", () => {
			// Ignore EPIPE errors if wl-copy exits early.
		});
		proc.stdin.write(text);
		proc.stdin.end();
	});
}

function copyToX11IfAvailable(options: NativeClipboardExecOptions, hasX11Display: boolean): boolean {
	if (!hasX11Display) return false;
	copyToX11Clipboard(options);
	return true;
}

function copyToWaylandClipboard(
	text: string,
	options: NativeClipboardExecOptions,
	hasX11Display: boolean,
): ClipboardCopyAttempt {
	try {
		// Verify wl-copy exists (spawn errors are async and won't be caught).
		execSync("which wl-copy", { stdio: "ignore" });
	} catch {
		return copyToX11IfAvailable(options, hasX11Display);
	}
	return writeWaylandClipboard(text).then(
		(exitCode) => {
			if (exitCode === 0) return true;
			try {
				return copyToX11IfAvailable(options, hasX11Display);
			} catch {
				return copyToX11IfAvailable(options, hasX11Display);
			}
		},
		() => copyToX11IfAvailable(options, hasX11Display),
	);
}

function copyToLinuxClipboard(text: string, options: NativeClipboardExecOptions): ClipboardCopyAttempt {
	if (process.env.TERMUX_VERSION) {
		try {
			execSync("termux-clipboard-set", options);
			return true;
		} catch {
			// Fall back to Wayland or X11 tools.
		}
	}
	const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
	const hasX11Display = Boolean(process.env.DISPLAY);
	if (isWaylandSession() && hasWaylandDisplay) {
		const attempt = copyToWaylandClipboard(text, options, hasX11Display);
		return attempt instanceof Promise ? attempt.catch(() => false) : attempt;
	}
	if (!hasX11Display) return false;
	copyToX11Clipboard(options);
	return true;
}

function copyWithPlatformTools(
	text: string,
	currentPlatform: NodeJS.Platform,
	options: NativeClipboardExecOptions,
): ClipboardCopyAttempt {
	try {
		if (currentPlatform === "darwin") {
			execSync("pbcopy", options);
			return true;
		}
		if (currentPlatform === "win32") {
			execSync("clip", options);
			return true;
		}
		return copyToLinuxClipboard(text, options);
	} catch {
		return false;
	}
}

export async function copyToClipboard(text: string): Promise<void> {
	let copied = false;

	const p = platform();

	// Prefer direct clipboard writes. Emitting OSC 52 first can make terminals
	// write the same native clipboard concurrently with the addon, and very large
	// OSC 52 payloads can desynchronize terminal rendering.
	//
	// On Linux, skip the native addon. The underlying `clipboard-rs` crate is
	// X11-only and does not retain selection ownership after `set_text`
	// resolves, so on Wayland-only compositors (Hyprland, Niri, ...) and even
	// some X11 sessions the call resolves successfully without populating the
	// clipboard. The platform tools below (wl-copy, xclip, xsel) properly
	// daemonize and keep ownership.
	try {
		if (clipboard && p !== "linux") {
			await clipboard.setText(text);
			copied = true;
		}
	} catch {
		// Fall through to platform-specific clipboard tools.
	}

	const remote = isRemoteSession();
	if (copied && !remote) {
		return;
	}

	const options: NativeClipboardExecOptions = { input: text, timeout: 5000, stdio: ["pipe", "ignore", "ignore"] };

	if (!copied) {
		const copyAttempt = copyWithPlatformTools(text, p, options);
		copied = copyAttempt instanceof Promise ? await copyAttempt : copyAttempt;
	}

	if (remote || !copied) {
		const osc52Copied = emitOsc52(text);
		copied = copied || osc52Copied;
	}

	if (!copied) {
		throw new Error("Failed to copy to clipboard");
	}
}
