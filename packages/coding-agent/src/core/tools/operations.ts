import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import {
	access as fsAccess,
	mkdir as fsMkdir,
	readdir as fsReaddir,
	readFile as fsReadFile,
	stat as fsStat,
	writeFile as fsWriteFile,
} from "node:fs/promises";
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
	| { type: "ssh"; cwd: string; configured: false };

export interface ToolOperations {
	cwd: string;
	exec(command: string, options: ToolExecOptions): Promise<{ exitCode: number | null }>;
	access(path: string, mode?: ToolAccessMode): Promise<void>;
	readFile(path: string): Promise<Buffer>;
	writeFile(path: string, content: string | Buffer): Promise<void>;
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

export interface DeferredSshToolOperationsConfigureOptions {
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
}

export class DeferredSshToolOperations implements ToolOperations {
	cwd: string;
	private operations: SshToolOperations | undefined;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	async configure(options: DeferredSshToolOperationsConfigureOptions): Promise<ToolBackendInfo> {
		const next = new SshToolOperations({ remote: options.remote, cwd: options.cwd ?? this.cwd });
		const stat = await next.stat(next.cwd);
		if (!stat.isDirectory()) {
			throw new Error(`SSH sandbox cwd is not a directory: ${next.cwd}`);
		}
		this.cwd = next.cwd;
		this.operations = next;
		return this.getBackendInfo();
	}

	clear(): void {
		this.operations = undefined;
	}

	private requireOperations(): SshToolOperations {
		if (!this.operations) {
			throw new Error(
				"SSH sandbox is not configured. Configure it over RPC or with /ssh-sandbox before using tools.",
			);
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
		return this.operations?.getBackendInfo() ?? { type: "ssh", cwd: this.cwd, configured: false };
	}
}

export function createSshToolOperations(target: string): Promise<SshToolOperations> {
	return SshToolOperations.fromTarget(target);
}
