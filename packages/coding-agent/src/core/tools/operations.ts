import { spawn } from "node:child_process";
import { constants, createReadStream, createWriteStream, type Stats, type WriteStream } from "node:fs";
import {
	access as fsAccess,
	mkdir as fsMkdir,
	readdir as fsReaddir,
	readFile as fsReadFile,
	stat as fsStat,
	writeFile as fsWriteFile,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { waitForChildProcess } from "../../utils/child-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";

export type ToolAccessMode = "exists" | "read" | "write" | "readwrite";

export interface ToolFileStat {
	isDirectory: () => boolean;
	isFile: () => boolean;
}

export interface ToolExecOptions {
	cwd?: string;
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
	env?: NodeJS.ProcessEnv;
}

export interface ToolGlobOptions {
	ignore: string[];
	limit: number;
}

export interface ToolGrepOptions {
	pattern: string;
	path: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	limit: number;
}

export interface ToolGrepMatch {
	filePath: string;
	lineNumber: number;
	lineText?: string;
}

export interface ToolGrepResult {
	isDirectory: boolean;
	matches: ToolGrepMatch[];
}

export type ToolBackendInfo =
	| { type: "local"; cwd: string }
	| { type: "ssh"; cwd: string; remote: string; configured: true }
	| { type: "remote"; cwd: string; configured: false }
	| { type: "remote"; cwd: string; url: string; protocol: "ws"; configured: true };

export interface ToolOperations {
	cwd: string;
	exec(command: string, options: ToolExecOptions): Promise<{ exitCode: number | null }>;
	access(path: string, mode?: ToolAccessMode): Promise<void>;
	readFile(path: string): Promise<Buffer>;
	writeFile(path: string, content: string | Buffer): Promise<void>;
	uploadFile?(sourcePath: string, destinationPath: string): Promise<void>;
	downloadFile?(sourcePath: string, destinationPath: string): Promise<void>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	stat(path: string): Promise<ToolFileStat>;
	readdir(path: string): Promise<string[]>;
	glob?(pattern: string, cwd: string, options: ToolGlobOptions): Promise<string[]>;
	grep?(options: ToolGrepOptions): Promise<ToolGrepResult>;
	detectImageMimeType?(path: string): Promise<string | null | undefined>;
	getBackendInfo?(): ToolBackendInfo;
	dispose?(): Promise<void>;
}

export interface LocalToolOperationsOptions {
	shellPath?: string;
}

export interface SshToolOperationsOptions {
	remote: string;
	cwd: string;
}

export interface DeferredRemoteToolOperationsConfigureSshOptions {
	remote: string;
	cwd?: string;
}

export interface ParsedSshTarget {
	remote: string;
	cwd?: string;
}

function accessModeToFsMode(mode: ToolAccessMode | undefined): number {
	switch (mode) {
		case "read":
			return constants.R_OK;
		case "write":
			return constants.W_OK;
		case "readwrite":
			return constants.R_OK | constants.W_OK;
		case "exists":
		case undefined:
			return constants.F_OK;
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseSshTarget(value: string): ParsedSshTarget {
	const separatorIndex = value.indexOf(":");
	if (separatorIndex === -1) {
		return { remote: value };
	}
	const remote = value.slice(0, separatorIndex);
	const cwd = value.slice(separatorIndex + 1);
	return cwd ? { remote, cwd } : { remote };
}

function validateSshRemote(remote: string): void {
	if (!remote) {
		throw new Error("--ssh requires a remote target like user@host or user@host:/path");
	}
	if (remote.startsWith("-")) {
		throw new Error("--ssh remote target must not start with '-'");
	}
}

function sshArgs(remote: string, command: string): string[] {
	validateSshRemote(remote);
	return ["--", remote, command];
}

function buildFdArgs(pattern: string, searchPath: string, limit: number): string[] {
	const args: string[] = ["--glob", "--color=never", "--hidden", "--no-require-git", "--max-results", String(limit)];
	let effectivePattern = pattern;
	if (pattern.includes("/")) {
		args.push("--full-path");
		if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
			effectivePattern = `**/${pattern}`;
		}
	}
	args.push("--", effectivePattern, searchPath);
	return args;
}

function buildRgArgs(options: ToolGrepOptions): string[] {
	const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
	if (options.ignoreCase) args.push("--ignore-case");
	if (options.literal) args.push("--fixed-strings");
	if (options.glob) args.push("--glob", options.glob);
	args.push("--", options.pattern, options.path);
	return args;
}

function commandWithArgs(command: string, args: string[]): string {
	return [command, ...args.map(shellQuote)].join(" ");
}

async function copyFileStream(sourcePath: string, destinationPath: string): Promise<void> {
	await pipeline(createReadStream(sourcePath), createWriteStream(destinationPath));
}

function writeStreamChunk(stream: WriteStream, chunk: Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			stream.off("error", onError);
			reject(error);
		};
		stream.once("error", onError);
		stream.write(chunk, (error) => {
			stream.off("error", onError);
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

function endWriteStream(stream: WriteStream): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			stream.off("error", onError);
			reject(error);
		};
		stream.once("error", onError);
		stream.end(() => {
			stream.off("error", onError);
			resolve();
		});
	});
}

function waitForSshFileTransfer(
	remote: string,
	command: string,
	wireStreams: (child: ReturnType<typeof spawn>) => Promise<void>,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", sshArgs(remote, command), { stdio: ["pipe", "pipe", "pipe"] });
		const stderr: Buffer[] = [];
		child.stderr.on("data", (data: Buffer) => stderr.push(data));
		child.on("error", reject);
		wireStreams(child).catch((error: unknown) => {
			child.kill();
			reject(error instanceof Error ? error : new Error(String(error)));
		});
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(Buffer.concat(stderr).toString("utf-8").trim() || `ssh exited with code ${code}`));
				return;
			}
			resolve();
		});
	});
}

async function runSshBuffer(
	remote: string,
	command: string,
	options: { input?: Buffer | string; signal?: AbortSignal; timeout?: number } = {},
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", sshArgs(remote, command), { stdio: ["pipe", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let timedOut = false;
		let timeoutHandle: NodeJS.Timeout | undefined;
		if (options.timeout !== undefined && options.timeout > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				child.kill();
			}, options.timeout * 1000);
		}
		child.stdout.on("data", (data: Buffer) => stdout.push(data));
		child.stderr.on("data", (data: Buffer) => stderr.push(data));
		child.on("error", reject);
		const onAbort = () => child.kill();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.input !== undefined) {
			child.stdin.end(options.input);
		} else {
			child.stdin.end();
		}
		child.on("close", (code) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			options.signal?.removeEventListener("abort", onAbort);
			if (options.signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}
			if (timedOut) {
				reject(new Error(`timeout:${options.timeout}`));
				return;
			}
			if (code !== 0) {
				reject(new Error(Buffer.concat(stderr).toString("utf-8").trim() || `ssh exited with code ${code}`));
				return;
			}
			resolve(Buffer.concat(stdout));
		});
	});
}

export class LocalToolOperations implements ToolOperations {
	cwd: string;
	private shellPath: string | undefined;

	constructor(cwd: string, options: LocalToolOperationsOptions = {}) {
		this.cwd = cwd;
		this.shellPath = options.shellPath;
	}

	async exec(command: string, options: ToolExecOptions): Promise<{ exitCode: number | null }> {
		const cwd = options.cwd ?? this.cwd;
		const { shell, args } = getShellConfig(this.shellPath);
		try {
			await fsAccess(cwd, constants.F_OK);
		} catch {
			throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
		}
		if (options.signal?.aborted) {
			throw new Error("aborted");
		}
		return new Promise((resolve, reject) => {
			const child = spawn(shell, [...args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: options.env ?? getShellEnv(),
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			if (options.timeout !== undefined && options.timeout > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					if (child.pid) killProcessTree(child.pid);
				}, options.timeout * 1000);
			}
			child.stdout?.on("data", options.onData);
			child.stderr?.on("data", options.onData);
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};
			if (options.signal) {
				if (options.signal.aborted) onAbort();
				else options.signal.addEventListener("abort", onAbort, { once: true });
			}
			waitForChildProcess(child)
				.then((code) => {
					if (child.pid) untrackDetachedChildPid(child.pid);
					if (timeoutHandle) clearTimeout(timeoutHandle);
					if (options.signal) options.signal.removeEventListener("abort", onAbort);
					if (options.signal?.aborted) {
						reject(new Error("aborted"));
						return;
					}
					if (timedOut) {
						reject(new Error(`timeout:${options.timeout}`));
						return;
					}
					resolve({ exitCode: code });
				})
				.catch((error: unknown) => {
					if (child.pid) untrackDetachedChildPid(child.pid);
					if (timeoutHandle) clearTimeout(timeoutHandle);
					if (options.signal) options.signal.removeEventListener("abort", onAbort);
					reject(error);
				});
		});
	}

	async access(path: string, mode?: ToolAccessMode): Promise<void> {
		await fsAccess(path, accessModeToFsMode(mode));
	}

	async readFile(path: string): Promise<Buffer> {
		return fsReadFile(path);
	}

	async writeFile(path: string, content: string | Buffer): Promise<void> {
		await fsWriteFile(path, content, typeof content === "string" ? "utf-8" : undefined);
	}

	async uploadFile(sourcePath: string, destinationPath: string): Promise<void> {
		await copyFileStream(sourcePath, destinationPath);
	}

	async downloadFile(sourcePath: string, destinationPath: string): Promise<void> {
		await copyFileStream(sourcePath, destinationPath);
	}

	async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
		await fsMkdir(path, { recursive: options.recursive ?? false });
	}

	async stat(path: string): Promise<Stats> {
		return fsStat(path);
	}

	async readdir(path: string): Promise<string[]> {
		return fsReaddir(path);
	}

	async detectImageMimeType(path: string): Promise<string | null | undefined> {
		return detectSupportedImageMimeTypeFromFile(path);
	}

	getBackendInfo(): ToolBackendInfo {
		return { type: "local", cwd: this.cwd };
	}
}

export class SshToolOperations implements ToolOperations {
	readonly remote: string;
	cwd: string;

	constructor(options: SshToolOperationsOptions) {
		this.remote = options.remote;
		this.cwd = options.cwd;
	}

	static async fromTarget(target: string): Promise<SshToolOperations> {
		const parsed = parseSshTarget(target);
		validateSshRemote(parsed.remote);
		const cwd = parsed.cwd ?? (await runSshBuffer(parsed.remote, "pwd")).toString("utf-8").trim();
		return new SshToolOperations({ remote: parsed.remote, cwd });
	}

	async exec(command: string, options: ToolExecOptions): Promise<{ exitCode: number | null }> {
		const cwd = options.cwd ?? this.cwd;
		const remoteCommand = `cd ${shellQuote(cwd)} && bash -s`;
		return new Promise((resolve, reject) => {
			const child = spawn("ssh", sshArgs(this.remote, remoteCommand), {
				stdio: ["pipe", "pipe", "pipe"],
			});
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			if (options.timeout !== undefined && options.timeout > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					child.kill();
				}, options.timeout * 1000);
			}
			child.stdout?.on("data", options.onData);
			child.stderr?.on("data", options.onData);
			child.on("error", reject);
			child.stdin.end(command);
			const onAbort = () => child.kill();
			options.signal?.addEventListener("abort", onAbort, { once: true });
			child.on("close", (code) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				options.signal?.removeEventListener("abort", onAbort);
				if (options.signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}
				if (timedOut) {
					reject(new Error(`timeout:${options.timeout}`));
					return;
				}
				resolve({ exitCode: code });
			});
		});
	}

	async access(path: string, mode?: ToolAccessMode): Promise<void> {
		const remotePath = shellQuote(path);
		if (mode === "readwrite") {
			await runSshBuffer(this.remote, `test -r ${remotePath} && test -w ${remotePath}`);
			return;
		}
		const flag = mode === "read" ? "-r" : mode === "write" ? "-w" : "-e";
		await runSshBuffer(this.remote, `test ${flag} ${remotePath}`);
	}

	async readFile(path: string): Promise<Buffer> {
		return runSshBuffer(this.remote, `cat ${shellQuote(path)}`);
	}

	async writeFile(path: string, content: string | Buffer): Promise<void> {
		await runSshBuffer(this.remote, `base64 -d > ${shellQuote(path)}`, {
			input: Buffer.from(content).toString("base64"),
		});
	}

	async uploadFile(sourcePath: string, destinationPath: string): Promise<void> {
		await waitForSshFileTransfer(this.remote, `cat > ${shellQuote(destinationPath)}`, async (child) => {
			if (!child.stdin) throw new Error("ssh stdin is unavailable");
			await pipeline(createReadStream(sourcePath), child.stdin);
		});
	}

	async downloadFile(sourcePath: string, destinationPath: string): Promise<void> {
		await waitForSshFileTransfer(this.remote, `cat ${shellQuote(sourcePath)}`, async (child) => {
			if (!child.stdout) throw new Error("ssh stdout is unavailable");
			await pipeline(child.stdout, createWriteStream(destinationPath));
		});
	}

	async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
		const flag = options.recursive ? "-p " : "";
		await runSshBuffer(this.remote, `mkdir ${flag}${shellQuote(path)}`);
	}

	async stat(path: string): Promise<ToolFileStat> {
		const output = await runSshBuffer(
			this.remote,
			`if test -d ${shellQuote(path)}; then echo d; elif test -f ${shellQuote(path)}; then echo f; else test -e ${shellQuote(path)} && echo o || exit 1; fi`,
		);
		const kind = output.toString("utf-8").trim();
		return {
			isDirectory: () => kind === "d",
			isFile: () => kind === "f",
		};
	}

	async readdir(path: string): Promise<string[]> {
		const output = await runSshBuffer(
			this.remote,
			`find ${shellQuote(path)} -maxdepth 1 -mindepth 1 -printf '%f\\n'`,
		);
		return output.toString("utf-8").split("\n").filter(Boolean);
	}

	async glob(pattern: string, cwd: string, options: ToolGlobOptions): Promise<string[]> {
		const command = commandWithArgs("fd", buildFdArgs(pattern, cwd, options.limit));
		const output = await runSshBuffer(this.remote, command);
		return output.toString("utf-8").split("\n").filter(Boolean);
	}

	async grep(options: ToolGrepOptions): Promise<ToolGrepResult> {
		const isDirectory = (await this.stat(options.path)).isDirectory();
		const command = commandWithArgs("rg", buildRgArgs(options));
		const output = await runSshBuffer(this.remote, command).catch((error: unknown) => {
			if (error instanceof Error && error.message.includes("ssh exited with code 1")) {
				return Buffer.alloc(0);
			}
			throw error;
		});
		const matches: ToolGrepMatch[] = [];
		for (const line of output.toString("utf-8").split("\n")) {
			if (!line.trim() || matches.length >= options.limit) continue;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			if (!event || typeof event !== "object" || !("type" in event) || event.type !== "match") continue;
			const data = "data" in event && event.data && typeof event.data === "object" ? event.data : undefined;
			const filePath =
				data && "path" in data && data.path && typeof data.path === "object" && "text" in data.path
					? data.path.text
					: undefined;
			const lineNumber = data && "line_number" in data ? data.line_number : undefined;
			const lineText =
				data && "lines" in data && data.lines && typeof data.lines === "object" && "text" in data.lines
					? data.lines.text
					: undefined;
			if (typeof filePath === "string" && typeof lineNumber === "number") {
				matches.push({ filePath, lineNumber, lineText: typeof lineText === "string" ? lineText : undefined });
			}
		}
		return { isDirectory, matches };
	}

	async detectImageMimeType(path: string): Promise<string | null | undefined> {
		try {
			const output = await runSshBuffer(this.remote, `file --mime-type -b ${shellQuote(path)}`);
			const mimeType = output.toString("utf-8").trim();
			return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType) ? mimeType : null;
		} catch {
			return null;
		}
	}

	getBackendInfo(): ToolBackendInfo {
		return { type: "ssh", remote: this.remote, cwd: this.cwd, configured: true };
	}

	async dispose(): Promise<void> {}
}

export class DeferredRemoteToolOperations implements ToolOperations {
	cwd: string;
	private operations: SshToolOperations | RemoteToolOperations | undefined;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	async configure(options: DeferredRemoteToolOperationsConfigureSshOptions): Promise<ToolBackendInfo> {
		const next = new SshToolOperations({ remote: options.remote, cwd: options.cwd ?? this.cwd });
		const stat = await next.stat(next.cwd);
		if (!stat.isDirectory()) {
			throw new Error(`SSH backend cwd is not a directory: ${next.cwd}`);
		}
		await this.operations?.dispose?.();
		this.cwd = next.cwd;
		this.operations = next;
		return this.getBackendInfo();
	}

	async configureRemote(url: string): Promise<ToolBackendInfo> {
		const next = await createRemoteToolOperations(url);
		const stat = await next.stat(next.cwd);
		if (!stat.isDirectory()) {
			throw new Error(`Remote daemon cwd is not a directory: ${next.cwd}`);
		}
		await this.operations?.dispose?.();
		this.cwd = next.cwd;
		this.operations = next;
		return this.getBackendInfo();
	}

	clear(): void {
		void this.operations?.dispose?.();
		this.operations = undefined;
	}

	private requireOperations(): SshToolOperations | RemoteToolOperations {
		if (!this.operations) {
			throw new Error("Remote backend is not configured. Configure it over RPC or with /remote before using tools.");
		}
		return this.operations;
	}

	async exec(command: string, options: ToolExecOptions): Promise<{ exitCode: number | null }> {
		return this.requireOperations().exec(command, options);
	}

	async access(path: string, mode?: ToolAccessMode): Promise<void> {
		await this.requireOperations().access(path, mode);
	}

	async readFile(path: string): Promise<Buffer> {
		return this.requireOperations().readFile(path);
	}

	async writeFile(path: string, content: string | Buffer): Promise<void> {
		await this.requireOperations().writeFile(path, content);
	}

	async uploadFile(sourcePath: string, destinationPath: string): Promise<void> {
		const operations = this.requireOperations();
		if (!operations.uploadFile) throw new Error("Remote backend does not support file upload");
		await operations.uploadFile(sourcePath, destinationPath);
	}

	async downloadFile(sourcePath: string, destinationPath: string): Promise<void> {
		const operations = this.requireOperations();
		if (!operations.downloadFile) throw new Error("Remote backend does not support file download");
		await operations.downloadFile(sourcePath, destinationPath);
	}

	async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
		await this.requireOperations().mkdir(path, options);
	}

	async stat(path: string): Promise<ToolFileStat> {
		return this.requireOperations().stat(path);
	}

	async readdir(path: string): Promise<string[]> {
		return this.requireOperations().readdir(path);
	}

	async glob(pattern: string, cwd: string, options: ToolGlobOptions): Promise<string[]> {
		return this.requireOperations().glob(pattern, cwd, options);
	}

	async grep(options: ToolGrepOptions): Promise<ToolGrepResult> {
		return this.requireOperations().grep(options);
	}

	async detectImageMimeType(path: string): Promise<string | null | undefined> {
		return this.requireOperations().detectImageMimeType(path);
	}

	getBackendInfo(): ToolBackendInfo {
		return this.operations?.getBackendInfo() ?? { type: "remote", cwd: this.cwd, configured: false };
	}
}

type RemoteResponse = { id: string; result: unknown } | { id: string; error: { message?: unknown } | string };

type RemoteExecEvent =
	| { id: string; event: "data"; dataBase64?: unknown; data?: unknown; stream?: unknown }
	| { id: string; event: "exit"; exitCode?: unknown; cancelled?: unknown }
	| { id: string; event: "error"; error?: { message?: unknown } | string };

type RemoteFileEvent =
	| { id: string; event: "fileData"; dataBase64?: unknown }
	| { id: string; event: "fileEnd" }
	| { id: string; event: "fileError"; error?: { message?: unknown } | string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function remoteErrorMessage(error: unknown): string {
	if (typeof error === "string") return error;
	if (isRecord(error) && typeof error.message === "string") return error.message;
	return "remote operation failed";
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string") throw new Error(`Remote response missing string ${name}`);
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function normalizeRemoteUrl(url: string): { url: string; protocol: "ws" } {
	const parsed = new URL(url);
	if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
		throw new Error(`--remote currently supports ws:// and wss:// URLs, got ${parsed.protocol}`);
	}
	return { url, protocol: "ws" };
}

export class RemoteToolOperations implements ToolOperations {
	readonly url: string;
	readonly protocol: "ws";
	cwd: string;
	private socket: WebSocket;
	private nextId = 1;
	private pending = new Map<
		string,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
		}
	>();
	private execPending = new Map<
		string,
		{
			onData: (data: Buffer) => void;
			resolve: (value: { exitCode: number | null }) => void;
			reject: (error: Error) => void;
		}
	>();
	private fileDownloadPending = new Map<
		string,
		{
			stream: WriteStream;
			writePromise: Promise<void>;
			resolve: () => void;
			reject: (error: Error) => void;
		}
	>();
	private keepAliveInterval: NodeJS.Timeout | undefined;
	private lastPongAt = Date.now();

	private constructor(url: string, protocol: "ws", socket: WebSocket, cwd: string) {
		this.url = url;
		this.protocol = protocol;
		this.socket = socket;
		this.cwd = cwd;
		this.socket.addEventListener("message", (event) => this.handleMessage(event.data));
		this.socket.addEventListener("close", () => {
			this.stopKeepAlive();
			this.rejectAll(new Error("remote connection closed"));
		});
		this.socket.addEventListener("error", () => {
			this.stopKeepAlive();
			this.rejectAll(new Error("remote connection error"));
		});
		this.startKeepAlive();
	}

	static async connect(url: string): Promise<RemoteToolOperations> {
		const normalized = normalizeRemoteUrl(url);
		const socket = await new Promise<WebSocket>((resolveSocket, rejectSocket) => {
			const ws = new WebSocket(normalized.url);
			const cleanup = () => {
				ws.removeEventListener("open", onOpen);
				ws.removeEventListener("error", onError);
			};
			const onOpen = () => {
				cleanup();
				resolveSocket(ws);
			};
			const onError = () => {
				cleanup();
				rejectSocket(new Error(`failed to connect remote commander: ${normalized.url}`));
			};
			ws.addEventListener("open", onOpen, { once: true });
			ws.addEventListener("error", onError, { once: true });
		});
		const operations = new RemoteToolOperations(normalized.url, normalized.protocol, socket, "/");
		const capabilities = await operations.request("capabilities", {});
		if (isRecord(capabilities) && typeof capabilities.cwd === "string") {
			operations.cwd = capabilities.cwd;
		}
		return operations;
	}

	private startKeepAlive(): void {
		this.keepAliveInterval = setInterval(() => {
			if (Date.now() - this.lastPongAt > 90_000) {
				this.stopKeepAlive();
				this.rejectAll(new Error("remote connection heartbeat timed out"));
				this.socket.close();
				return;
			}
			try {
				this.send({ type: "ping", timestamp: Date.now() });
			} catch (error) {
				this.stopKeepAlive();
				this.rejectAll(error instanceof Error ? error : new Error(String(error)));
			}
		}, 30_000);
		this.keepAliveInterval.unref?.();
	}

	private stopKeepAlive(): void {
		if (this.keepAliveInterval) {
			clearInterval(this.keepAliveInterval);
			this.keepAliveInterval = undefined;
		}
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		for (const pending of this.execPending.values()) pending.reject(error);
		this.execPending.clear();
		for (const pending of this.fileDownloadPending.values()) {
			pending.stream.destroy(error);
			pending.reject(error);
		}
		this.fileDownloadPending.clear();
	}

	private send(message: Record<string, unknown>): void {
		if (this.socket.readyState !== WebSocket.OPEN) {
			throw new Error("remote connection is not open");
		}
		this.socket.send(JSON.stringify(message));
	}

	private request(method: string, params: Record<string, unknown>): Promise<unknown> {
		const id = `remote-${this.nextId++}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.send({ id, method, params });
			} catch (error) {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private handleMessage(data: unknown): void {
		if (typeof data !== "string") return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			return;
		}
		if (!isRecord(parsed)) return;
		if (parsed.type === "pong") {
			this.lastPongAt = Date.now();
			return;
		}
		if (typeof parsed.id !== "string") return;
		if (typeof parsed.event === "string") {
			if (parsed.event === "fileData" || parsed.event === "fileEnd" || parsed.event === "fileError") {
				this.handleFileEvent(parsed as RemoteFileEvent);
			} else {
				this.handleExecEvent(parsed as RemoteExecEvent);
			}
			return;
		}
		const pending = this.pending.get(parsed.id);
		if (!pending) return;
		this.pending.delete(parsed.id);
		const response = parsed as RemoteResponse;
		if ("error" in response) {
			pending.reject(new Error(remoteErrorMessage(response.error)));
			return;
		}
		pending.resolve(response.result);
	}

	private handleExecEvent(event: RemoteExecEvent): void {
		const pending = this.execPending.get(event.id);
		if (!pending) return;
		if (event.event === "data") {
			const encoded = optionalString(event.dataBase64);
			const text = optionalString(event.data);
			if (encoded !== undefined) pending.onData(Buffer.from(encoded, "base64"));
			else if (text !== undefined) pending.onData(Buffer.from(text));
			return;
		}
		this.execPending.delete(event.id);
		if (event.event === "error") {
			pending.reject(new Error(remoteErrorMessage(event.error)));
			return;
		}
		const exitCode = optionalNumber(event.exitCode) ?? null;
		pending.resolve({ exitCode });
	}

	private handleFileEvent(event: RemoteFileEvent): void {
		const pending = this.fileDownloadPending.get(event.id);
		if (!pending) return;
		if (event.event === "fileData") {
			const encoded = optionalString(event.dataBase64);
			if (encoded === undefined) return;
			pending.writePromise = pending.writePromise.then(() =>
				writeStreamChunk(pending.stream, Buffer.from(encoded, "base64")),
			);
			return;
		}
		this.fileDownloadPending.delete(event.id);
		if (event.event === "fileError") {
			const error = new Error(remoteErrorMessage(event.error));
			pending.reject(error);
			pending.stream.destroy(error);
			return;
		}
		pending.writePromise.then(() => endWriteStream(pending.stream)).then(pending.resolve, pending.reject);
	}

	async exec(command: string, options: ToolExecOptions): Promise<{ exitCode: number | null }> {
		const id = `remote-${this.nextId++}`;
		let timeoutHandle: NodeJS.Timeout | undefined;
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				options.signal?.removeEventListener("abort", onAbort);
			};
			const onAbort = () => {
				try {
					this.send({ id, method: "cancel" });
				} catch {}
				const pending = this.execPending.get(id);
				if (pending) {
					this.execPending.delete(id);
					cleanup();
					pending.reject(new Error("aborted"));
				}
			};
			this.execPending.set(id, {
				onData: options.onData,
				resolve: (value) => {
					cleanup();
					resolve(value);
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			});
			options.signal?.addEventListener("abort", onAbort, { once: true });
			if (options.timeout !== undefined && options.timeout > 0) {
				timeoutHandle = setTimeout(() => {
					try {
						this.send({ id, method: "cancel" });
					} catch {}
					const pending = this.execPending.get(id);
					if (pending) {
						this.execPending.delete(id);
						cleanup();
						pending.reject(new Error(`timeout:${options.timeout}`));
					}
				}, options.timeout * 1000);
			}
			try {
				this.send({
					id,
					method: "exec",
					params: { command, cwd: options.cwd ?? this.cwd, env: options.env, timeout: options.timeout },
				});
			} catch (error) {
				this.execPending.delete(id);
				cleanup();
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async access(path: string, mode?: ToolAccessMode): Promise<void> {
		await this.request("access", { path, mode });
	}

	async readFile(path: string): Promise<Buffer> {
		const result = await this.request("readFile", { path });
		if (!isRecord(result)) throw new Error("Invalid remote readFile response");
		return Buffer.from(requireString(result.contentBase64, "contentBase64"), "base64");
	}

	async writeFile(path: string, content: string | Buffer): Promise<void> {
		await this.request("writeFile", { path, contentBase64: Buffer.from(content).toString("base64") });
	}

	async uploadFile(sourcePath: string, destinationPath: string): Promise<void> {
		const uploadId = `remote-${this.nextId++}`;
		await new Promise<void>((resolve, reject) => {
			this.pending.set(uploadId, { resolve: () => resolve(), reject });
			try {
				this.send({ id: uploadId, method: "uploadFileStart", params: { path: destinationPath } });
			} catch (error) {
				this.pending.delete(uploadId);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
		try {
			for await (const chunk of createReadStream(sourcePath, { highWaterMark: 64 * 1024 })) {
				const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
				await this.request("uploadFileChunk", { uploadId, dataBase64: buffer.toString("base64") });
			}
			await this.request("uploadFileEnd", { uploadId });
		} catch (error) {
			await this.request("uploadFileCancel", { uploadId }).catch(() => undefined);
			throw error;
		}
	}

	async downloadFile(sourcePath: string, destinationPath: string): Promise<void> {
		const id = `remote-${this.nextId++}`;
		const stream = createWriteStream(destinationPath);
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => stream.off("error", onStreamError);
			const onStreamError = (error: Error) => {
				cleanup();
				this.fileDownloadPending.delete(id);
				reject(error);
			};
			stream.once("error", onStreamError);
			this.fileDownloadPending.set(id, {
				stream,
				writePromise: Promise.resolve(),
				resolve: () => {
					cleanup();
					resolve();
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			});
			try {
				this.send({ id, method: "downloadFile", params: { path: sourcePath } });
			} catch (error) {
				cleanup();
				this.fileDownloadPending.delete(id);
				stream.destroy();
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
		await this.request("mkdir", { path, recursive: options.recursive ?? false });
	}

	async stat(path: string): Promise<ToolFileStat> {
		const result = await this.request("stat", { path });
		if (!isRecord(result)) throw new Error("Invalid remote stat response");
		const kind = optionalString(result.kind) ?? optionalString(result.type);
		const isDirectory = result.isDirectory === true || kind === "directory" || kind === "dir";
		const isFile = result.isFile === true || kind === "file";
		return { isDirectory: () => isDirectory, isFile: () => isFile };
	}

	async readdir(path: string): Promise<string[]> {
		const result = await this.request("readdir", { path });
		if (Array.isArray(result)) return result.filter((entry): entry is string => typeof entry === "string");
		if (!isRecord(result) || !Array.isArray(result.entries)) throw new Error("Invalid remote readdir response");
		return result.entries.filter((entry): entry is string => typeof entry === "string");
	}

	async glob(pattern: string, cwd: string, options: ToolGlobOptions): Promise<string[]> {
		const result = await this.request("glob", { pattern, cwd, ignore: options.ignore, limit: options.limit });
		if (Array.isArray(result)) return result.filter((entry): entry is string => typeof entry === "string");
		if (!isRecord(result) || !Array.isArray(result.matches)) throw new Error("Invalid remote glob response");
		return result.matches.filter((entry): entry is string => typeof entry === "string");
	}

	async grep(options: ToolGrepOptions): Promise<ToolGrepResult> {
		const result = await this.request("grep", options as unknown as Record<string, unknown>);
		if (!isRecord(result)) throw new Error("Invalid remote grep response");
		const matches = Array.isArray(result.matches) ? result.matches : [];
		return {
			isDirectory: result.isDirectory === true,
			matches: matches.flatMap((entry): ToolGrepMatch[] => {
				if (!isRecord(entry)) return [];
				const filePath = optionalString(entry.filePath);
				const lineNumber = optionalNumber(entry.lineNumber);
				if (!filePath || lineNumber === undefined) return [];
				return [{ filePath, lineNumber, lineText: optionalString(entry.lineText) }];
			}),
		};
	}

	async detectImageMimeType(path: string): Promise<string | null | undefined> {
		const result = await this.request("detectImageMimeType", { path });
		if (!isRecord(result)) return undefined;
		const mimeType = optionalString(result.mimeType);
		return mimeType && ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType) ? mimeType : null;
	}

	getBackendInfo(): ToolBackendInfo {
		return { type: "remote", cwd: this.cwd, url: this.url, protocol: this.protocol, configured: true };
	}

	async dispose(): Promise<void> {
		this.stopKeepAlive();
		this.socket.close();
	}
}

export function createRemoteToolOperations(url: string): Promise<RemoteToolOperations> {
	return RemoteToolOperations.connect(url);
}

export function createSshToolOperations(target: string): Promise<SshToolOperations> {
	return SshToolOperations.fromTarget(target);
}
