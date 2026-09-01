import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir as fsMkdir, lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentToolResult } from "@fleetagent/pi-agent-core";
import { createLspRuntimeState, createLspToolDefinitions, type LspRuntimeState } from "../core/lsp/integration.ts";
import type { LspServerStatus } from "../core/lsp/manager.ts";
import { createManagedStdioConnectionFactory, resolveLspConnectionFactory } from "../core/lsp/transport.ts";
import {
	hashRemoteWorkspaceJson,
	type RemoteWorkspaceCapability,
	type RemoteWorkspaceCatalog,
	type RemoteWorkspaceIdentity,
	type RemoteWorkspaceMethod,
	type RemoteWorkspaceOperationKind,
} from "../core/remote-workspace-protocol/contract.ts";
import {
	RemoteWorkspaceRequestError,
	type RemoteWorkspaceServerHandler,
	type RemoteWorkspaceServerRequestContext,
	type RemoteWorkspaceTypedRequest,
} from "../core/remote-workspace-protocol/session.ts";
import { withFileMutationQueue } from "../core/tools/file-mutation-queue.ts";
import {
	LocalToolOperations,
	type ToolAccessMode,
	type ToolBackendInfo,
	type ToolExecOptions,
	type ToolExecResult,
	type ToolFileStat,
	type ToolGlobOptions,
	type ToolGrepMatch,
	type ToolGrepOptions,
	type ToolGrepResult,
	type ToolMkdirOptions,
	type ToolOperations,
	type WorkspaceToolExecutionOptions,
} from "../core/tools/operations.ts";
import { WorkspaceToolHost, type WorkspaceToolName } from "../core/tools/workspace-tool-host.ts";
import type { DaemonConfiguration } from "./config.ts";
import { loadDaemonLspConfiguration } from "./lsp-config.ts";
import { redactDaemonText } from "./security.ts";

const PRIMITIVE_OPERATIONS: RemoteWorkspaceMethod[] = [
	"workspace.access",
	"workspace.read",
	"workspace.write",
	"workspace.mkdir",
	"workspace.stat",
	"workspace.readdir",
	"workspace.glob",
	"workspace.grep",
	"workspace.detect_image_mime",
	"workspace.exec",
];

const SECRET_ENVIRONMENT_SUFFIX = /_(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIALS)$/iu;
const BASELINE_ENVIRONMENT =
	process.platform === "win32"
		? ["PATH", "PATHEXT", "SYSTEMROOT", "COMSPEC", "TEMP", "TMP", "USER", "USERNAME"]
		: ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "COLORTERM", "NO_COLOR", "TMPDIR"];

function isSecretEnvironmentName(name: string): boolean {
	const upper = name.toUpperCase();
	return (
		upper === "PI_DAEMON_TOKEN" ||
		upper === "PI_REMOTE_TOKEN" ||
		upper.startsWith("PI_DAEMON_TLS_") ||
		SECRET_ENVIRONMENT_SUFFIX.test(upper)
	);
}
process.platform === "win32"
	? ["PATH", "PATHEXT", "SYSTEMROOT", "TEMP", "TMP"]
	: ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"];

function isMissingPath(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function sanitizeLspStatus(
	status: LspServerStatus,
	configuration: DaemonConfiguration,
): Omit<LspServerStatus, "capabilities"> {
	const { capabilities: _capabilities, ...safe } = status;
	const secrets = [configuration.token, configuration.tls?.passphrase];
	const redact = (value: string | undefined) => (value ? redactDaemonText(value, secrets) : undefined);
	return {
		...safe,
		serverId: redact(safe.serverId)!,
		languageIds: safe.languageIds.map((value) => redact(value)!),
		transport: redact(safe.transport)!,
		...(safe.instanceKey ? { instanceKey: redact(safe.instanceKey) } : {}),
		...(safe.workspaceRoot ? { workspaceRoot: redact(safe.workspaceRoot) } : {}),
		...(safe.rootUri ? { rootUri: redact(safe.rootUri) } : {}),
		...(safe.endpoint ? { endpoint: redact(safe.endpoint) } : {}),
		...(safe.lastError ? { lastError: redact(safe.lastError) } : {}),
		...(safe.lastRequestError ? { lastRequestError: redact(safe.lastRequestError) } : {}),
		...(safe.stderr ? { stderr: redact(safe.stderr) } : {}),
		...(safe.synchronizationError ? { synchronizationError: redact(safe.synchronizationError) } : {}),
	};
}

function portableToolResult(result: AgentToolResult<unknown>): AgentToolResult<unknown> {
	const clone = JSON.parse(JSON.stringify(result)) as AgentToolResult<unknown>;
	const details = clone.details;
	if (!details || typeof details !== "object" || !("fullOutputPath" in details)) return clone;
	const fullOutputPath = (details as { fullOutputPath?: unknown }).fullOutputPath;
	if (typeof fullOutputPath !== "string") return clone;
	delete (details as { fullOutputPath?: unknown }).fullOutputPath;
	for (const content of clone.content) {
		if (content.type === "text") {
			content.text = content.text.replaceAll(fullOutputPath, "[remote full output is not transferable]");
		}
	}
	return clone;
}

function operationKind(name: string): RemoteWorkspaceOperationKind {
	if (name.startsWith("lsp_")) return "service";
	switch (name) {
		case "read":
		case "grep":
		case "find":
		case "ls":
			return "read";
		case "edit":
		case "write":
			return "mutation";
		case "bash":
			return "process";
	}
	throw new Error(`Unknown daemon tool: ${name}`);
}

function runCommand(
	command: string,
	args: string[],
	environment: NodeJS.ProcessEnv,
	maxBufferedBytes: number,
): Promise<Buffer> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: environment });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let bufferedBytes = 0;
		let settled = false;
		const append = (target: Buffer[], chunk: Buffer) => {
			if (settled) return;
			bufferedBytes += chunk.byteLength;
			if (bufferedBytes > maxBufferedBytes) {
				settled = true;
				child.kill();
				reject(new Error(`${command} output exceeded the daemon buffered-output limit`));
				return;
			}
			target.push(Buffer.from(chunk));
		};
		child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
		child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
		child.once("close", (code) => {
			if (settled) return;
			settled = true;
			if (code === 0 || (command === "rg" && code === 1)) {
				resolvePromise(Buffer.concat(stdout));
				return;
			}
			reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${command} exited with code ${code}`));
		});
	});
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nestedText(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const nested = record?.[key];
	return isUnknownRecord(nested) && typeof nested.text === "string" ? nested.text : undefined;
}

function parseDaemonGrepMatch(line: string): ToolGrepMatch | undefined {
	if (!line) return undefined;
	let event: unknown;
	try {
		event = JSON.parse(line) as unknown;
	} catch {
		return undefined;
	}
	const eventRecord = isUnknownRecord(event) ? event : undefined;
	if (eventRecord?.type !== "match") return undefined;
	const data = isUnknownRecord(eventRecord.data) ? eventRecord.data : undefined;
	const filePath = nestedText(data, "path");
	const lineNumber = data?.line_number;
	if (!filePath || typeof lineNumber !== "number") return undefined;
	const lineText = nestedText(data, "lines");
	return { filePath, lineNumber, ...(lineText === undefined ? {} : { lineText }) };
}

export class ConfinedDaemonToolOperations implements ToolOperations {
	readonly cwd: string;
	private readonly local: LocalToolOperations;
	private readonly allowedRoots: readonly string[];
	private readonly allowProcessExec: boolean;
	private readonly environment: NodeJS.ProcessEnv;
	private readonly maxBufferedOutputBytes: number;

	constructor(configuration: DaemonConfiguration) {
		this.cwd = configuration.workspaceRoot;
		this.local = new LocalToolOperations(this.cwd);
		this.allowedRoots = Object.freeze([
			this.cwd,
			...(configuration.temporaryRoot ? [configuration.temporaryRoot] : []),
		]);
		this.allowProcessExec = configuration.allowProcessExec;
		this.maxBufferedOutputBytes = configuration.maxBufferedOutputBytes;
		const localeNames = Object.keys(process.env).filter((name) => /^LC_/iu.test(name));
		const names = new Set([...BASELINE_ENVIRONMENT, ...localeNames, ...configuration.forwardedEnvironment]);
		this.environment = {};
		for (const name of names) {
			if (isSecretEnvironmentName(name)) continue;
			const value = process.env[name];
			if (value !== undefined) this.environment[name] = value;
		}
	}

	createChildEnvironment(extra: Record<string, string> = {}): Record<string, string> {
		const environment: Record<string, string> = {};
		for (const [name, value] of Object.entries(this.environment)) {
			if (value !== undefined) environment[name] = value;
		}
		Object.assign(environment, extra);
		for (const name of Object.keys(environment)) {
			if (isSecretEnvironmentName(name)) delete environment[name];
		}
		return environment;
	}
	private isWithinAllowedRoot(candidate: string, root: string): boolean {
		const pathRelative = relative(root, candidate);
		return pathRelative !== ".." && !pathRelative.startsWith(`..${sep}`) && !isAbsolute(pathRelative);
	}

	private lexicalPath(path: string): string {
		const candidate = resolve(this.cwd, path);
		if (!this.allowedRoots.some((root) => this.isWithinAllowedRoot(candidate, root))) {
			throw new Error(`Path escapes the daemon workspace and allowed temporary root: ${path}`);
		}
		return candidate;
	}

	private async existingPath(path: string): Promise<string> {
		const candidate = this.lexicalPath(path);
		const canonical = await realpath(candidate);
		return this.lexicalPath(canonical);
	}

	private async existingWritablePath(candidate: string, path: string): Promise<string | undefined> {
		try {
			const stat = await lstat(candidate);
			if (stat.isSymbolicLink()) {
				try {
					this.lexicalPath(await realpath(candidate));
				} catch (error) {
					if (isMissingPath(error)) throw new Error(`Writable path uses a broken symbolic link: ${path}`);
					throw error;
				}
				throw new Error(`Writable path uses a symbolic link: ${path}`);
			}
			const canonical = await realpath(candidate);
			this.lexicalPath(canonical);
			return this.lexicalPath(canonical);
		} catch (error) {
			if (isMissingPath(error)) return undefined;
			throw error;
		}
	}

	private async ensureConfinedWritableParent(candidate: string, path: string): Promise<void> {
		let parent = resolve(candidate, "..");
		while (true) {
			try {
				const parentStat = await lstat(parent);
				if (parentStat.isSymbolicLink()) {
					this.lexicalPath(await realpath(parent));
					throw new Error(`Writable parent uses a symbolic link: ${path}`);
				}
				const canonicalParent = await realpath(parent);
				this.lexicalPath(canonicalParent);
				return;
			} catch (error) {
				if (!isMissingPath(error)) throw error;
				const next = resolve(parent, "..");
				if (next === parent) throw new Error(`No confined parent exists for path: ${path}`);
				parent = next;
			}
		}
	}

	private async writablePath(path: string): Promise<string> {
		const candidate = this.lexicalPath(path);
		const existing = await this.existingWritablePath(candidate, path);
		if (existing) return existing;
		await this.ensureConfinedWritableParent(candidate, path);
		return candidate;
	}

	private async atomicWriteFile(path: string, content: string | Buffer): Promise<void> {
		const target = await this.writablePath(path);
		const parent = resolve(target, "..");
		const temporary = resolve(parent, `.pi-remote-write-${process.pid}-${randomUUID()}-${basename(target)}.tmp`);
		this.lexicalPath(temporary);
		let wroteTemporary = false;
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(content, typeof content === "string" ? "utf8" : undefined);
			} finally {
				await handle.close();
			}
			wroteTemporary = true;
			this.lexicalPath(await realpath(temporary));
			try {
				if ((await lstat(target)).isSymbolicLink()) throw new Error(`Writable path uses a symbolic link: ${path}`);
			} catch (error) {
				if (!isMissingPath(error)) throw error;
			}
			await rename(temporary, target);
			wroteTemporary = false;
			this.lexicalPath(await realpath(target));
		} finally {
			if (wroteTemporary) await rm(temporary, { force: true });
		}
	}

	async exec(command: string, options: ToolExecOptions): Promise<ToolExecResult> {
		if (!this.allowProcessExec) throw new Error("Process execution is disabled by daemon policy");
		const cwd = await this.existingPath(options.cwd ?? this.cwd);
		return this.local.exec(command, { ...options, cwd, env: { ...this.environment } });
	}

	async access(path: string, mode?: ToolAccessMode): Promise<void> {
		await this.local.access(await this.existingPath(path), mode);
	}

	async readFile(path: string): Promise<Buffer> {
		return this.local.readFile(await this.existingPath(path));
	}

	async writeFile(path: string, content: string | Buffer): Promise<void> {
		await this.atomicWriteFile(path, content);
	}

	async mkdir(path: string, options?: ToolMkdirOptions): Promise<void> {
		await fsMkdir(await this.writablePath(path), options);
	}

	async stat(path: string): Promise<ToolFileStat> {
		return this.local.stat(await this.existingPath(path));
	}

	async readdir(path: string): Promise<string[]> {
		return this.local.readdir(await this.existingPath(path));
	}

	async glob(pattern: string, cwd: string, options: ToolGlobOptions): Promise<string[]> {
		const searchRoot = await this.existingPath(cwd);
		const args = ["--glob", "--color=never", "--hidden", "--no-require-git", "--max-results", String(options.limit)];
		for (const ignored of options.ignore) args.push("--exclude", ignored);
		let effectivePattern = pattern;
		if (pattern.includes("/")) {
			args.push("--full-path");
			if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**")
				effectivePattern = `**/${pattern}`;
		}
		args.push("--", effectivePattern, searchRoot);
		const output = await runCommand("fd", args, this.environment, this.maxBufferedOutputBytes);
		const results: string[] = [];
		for (const entry of output.toString("utf8").split("\n")) {
			if (!entry) continue;
			try {
				results.push(await this.existingPath(entry));
			} catch {
				// Symlinks escaping the workspace are deliberately omitted.
			}
		}
		return results;
	}

	async grep(options: ToolGrepOptions): Promise<ToolGrepResult> {
		const searchPath = await this.existingPath(options.path);
		const isDirectory = (await this.local.stat(searchPath)).isDirectory();
		const args = ["--json", "--line-number", "--color=never", "--hidden"];
		if (options.ignoreCase) args.push("--ignore-case");
		if (options.literal) args.push("--fixed-strings");
		if (options.glob) args.push("--glob", options.glob);
		args.push("--", options.pattern, searchPath);
		const output = await runCommand("rg", args, this.environment, this.maxBufferedOutputBytes);
		const matches: ToolGrepMatch[] = [];
		for (const line of output.toString("utf8").split("\n")) {
			if (matches.length >= options.limit) continue;
			const match = parseDaemonGrepMatch(line);
			if (!match) continue;
			try {
				await this.existingPath(match.filePath);
			} catch {
				continue;
			}
			matches.push(match);
		}
		return { isDirectory, matches };
	}

	async detectImageMimeType(path: string): Promise<string | null | undefined> {
		return this.local.detectImageMimeType(await this.existingPath(path));
	}

	getBackendInfo(): ToolBackendInfo {
		return { type: "local", cwd: this.cwd };
	}
}

export interface DaemonWorkspaceRuntime {
	readonly operations: ConfinedDaemonToolOperations;
	readonly host: WorkspaceToolHost;
	readonly lspRuntime?: LspRuntimeState;
	readonly catalog: RemoteWorkspaceCatalog;
	readonly capabilities: readonly RemoteWorkspaceCapability[];
	createHandler(workspace: RemoteWorkspaceIdentity): RemoteWorkspaceServerHandler;
	retire(): Promise<void>;
	dispose(): Promise<void>;
}

type DaemonRequestInterruptionCode = "cancelled" | "deadline_exceeded";
type DaemonInterruptedExecutionState = "not_started" | "indeterminate";

function requestError(code: DaemonRequestInterruptionCode, message: string, state: DaemonInterruptedExecutionState) {
	return new RemoteWorkspaceRequestError({ code, message, executionState: state, retryable: false });
}
interface DaemonRequestRuntime {
	configuration: DaemonConfiguration;
	operations: ConfinedDaemonToolOperations;
	host: WorkspaceToolHost;
	lspRuntime: LspRuntimeState | undefined;
	workspace: RemoteWorkspaceIdentity;
}

function withDaemonWorkspace<T extends Record<string, unknown>>(result: T, workspace: RemoteWorkspaceIdentity) {
	return { ...result, workspace };
}

async function synchronizeDaemonToolFile(
	toolName: string,
	invocationArguments: unknown,
	runtime: DaemonRequestRuntime,
): Promise<void> {
	if (!runtime.lspRuntime) return;
	const args = invocationArguments as { path?: unknown };
	if (typeof args.path !== "string") return;
	try {
		if (toolName === "read") {
			await runtime.lspRuntime.fileSync.handleFileRead(args.path, runtime.operations);
		} else if (toolName === "write" || toolName === "edit") {
			await runtime.lspRuntime.fileSync.handleFileWrite(args.path, runtime.operations);
		}
	} catch {
		// Synchronization remains best-effort, matching local AgentSession behavior.
	}
}

async function invokeDaemonTool(
	request: RemoteWorkspaceTypedRequest,
	params: Record<string, unknown>,
	context: RemoteWorkspaceServerRequestContext,
	runtime: DaemonRequestRuntime,
): Promise<AgentToolResult<unknown>> {
	const toolName = params.toolName as string;
	const kind = operationKind(toolName);
	if (kind !== "read") context.markSideEffectStarted();
	let updateQueue = Promise.resolve();
	try {
		const result = await runtime.host.executePrepared(toolName, {
			toolCallId: request.id,
			arguments: params.arguments,
			signal: context.signal,
			executionOptions: params.executionOptions as WorkspaceToolExecutionOptions,
			onUpdate: (update) => {
				updateQueue = updateQueue.then(() => context.sendUpdate(portableToolResult(update)));
			},
		});
		await updateQueue;
		await synchronizeDaemonToolFile(toolName, params.arguments, runtime);
		if (kind !== "read") context.markCommitted();
		return portableToolResult(result);
	} catch (error) {
		await updateQueue.catch(() => undefined);
		if (context.signal.aborted) {
			throw requestError(
				"cancelled",
				"Remote workspace tool invocation was cancelled",
				kind === "read" ? "not_started" : "indeterminate",
			);
		}
		throw new RemoteWorkspaceRequestError({
			code: "internal_error",
			message: error instanceof Error ? error.message.slice(0, 4096) : "Workspace tool failed",
			executionState: kind === "read" ? "not_started" : "indeterminate",
			retryable: false,
		});
	}
}

async function executeDaemonWorkspaceProcess(
	params: Record<string, unknown>,
	context: RemoteWorkspaceServerRequestContext,
	runtime: DaemonRequestRuntime,
): Promise<ToolExecResult> {
	context.markSideEffectStarted();
	let updateQueue = Promise.resolve();
	let pendingOutputBytes = 0;
	let outputLimitExceeded = false;
	const outputController = new AbortController();
	const signal = AbortSignal.any([context.signal, outputController.signal]);
	let result: ToolExecResult;
	try {
		result = await runtime.operations.exec(params.command as string, {
			cwd: params.cwd as string,
			signal,
			onData: (data) => {
				if (outputLimitExceeded) return;
				const chunk = Buffer.from(data);
				pendingOutputBytes += chunk.byteLength;
				if (pendingOutputBytes > runtime.configuration.maxBufferedOutputBytes) {
					outputLimitExceeded = true;
					outputController.abort();
					return;
				}
				updateQueue = updateQueue
					.then(() => context.sendUpdate({ dataBase64: chunk.toString("base64") }))
					.finally(() => {
						pendingOutputBytes -= chunk.byteLength;
					});
			},
		});
	} catch (error) {
		if (outputLimitExceeded) throw new Error("Process output exceeded the daemon buffered-output limit");
		throw error;
	}
	await updateQueue;
	context.markCommitted();
	return result;
}

async function readDaemonResource(
	params: Record<string, unknown>,
	runtime: DaemonRequestRuntime,
): Promise<Record<string, unknown>> {
	const path = params.path as string;
	if (path !== "SANDBOX.md" || !runtime.configuration.sandboxInstructionsPath) {
		throw new RemoteWorkspaceRequestError({
			code: "not_available",
			message: "Requested daemon resource is not available",
			executionState: "not_started",
			retryable: false,
		});
	}
	return withDaemonWorkspace(
		{ contentBase64: (await readFile(runtime.configuration.sandboxInstructionsPath)).toString("base64") },
		runtime.workspace,
	);
}

function getDaemonLspStatus(runtime: DaemonRequestRuntime): Record<string, unknown> {
	if (!runtime.lspRuntime) {
		throw new RemoteWorkspaceRequestError({
			code: "not_available",
			message: "Daemon LSP is not configured",
			executionState: "not_started",
			retryable: false,
		});
	}
	return {
		enabled: true,
		servers: runtime.lspRuntime.manager.getStatus().map((status) => sanitizeLspStatus(status, runtime.configuration)),
	};
}

async function dispatchDaemonWorkspaceRequest(
	request: RemoteWorkspaceTypedRequest,
	context: RemoteWorkspaceServerRequestContext,
	runtime: DaemonRequestRuntime,
): Promise<unknown> {
	const params = request.params as Record<string, unknown>;
	switch (request.method) {
		case "tool.invoke":
			return invokeDaemonTool(request, params, context, runtime);
		case "workspace.access":
			await runtime.operations.access(params.path as string, params.mode as ToolAccessMode | undefined);
			return {};
		case "workspace.read":
			return withDaemonWorkspace(
				{ contentBase64: (await runtime.operations.readFile(params.path as string)).toString("base64") },
				runtime.workspace,
			);
		case "workspace.write":
			context.markSideEffectStarted();
			await withFileMutationQueue(resolve(runtime.configuration.workspaceRoot, params.path as string), () =>
				runtime.operations.writeFile(params.path as string, Buffer.from(params.contentBase64 as string, "base64")),
			);
			context.markCommitted();
			return {};
		case "workspace.mkdir":
			context.markSideEffectStarted();
			await withFileMutationQueue(resolve(runtime.configuration.workspaceRoot, params.path as string), () =>
				runtime.operations.mkdir(params.path as string, { recursive: params.recursive === true }),
			);
			context.markCommitted();
			return {};
		case "workspace.stat": {
			const value = await runtime.operations.stat(params.path as string);
			return withDaemonWorkspace(
				{ kind: value.isDirectory() ? "directory" : value.isFile() ? "file" : "other" },
				runtime.workspace,
			);
		}
		case "workspace.readdir":
			return withDaemonWorkspace(
				{ entries: await runtime.operations.readdir(params.path as string) },
				runtime.workspace,
			);
		case "workspace.glob":
			return withDaemonWorkspace(
				{
					matches: await runtime.operations.glob(params.pattern as string, params.cwd as string, {
						ignore: params.ignore as string[],
						limit: params.limit as number,
					}),
				},
				runtime.workspace,
			);
		case "workspace.grep": {
			const result = await runtime.operations.grep(params as unknown as ToolGrepOptions);
			return withDaemonWorkspace(result as unknown as Record<string, unknown>, runtime.workspace);
		}
		case "workspace.detect_image_mime":
			return withDaemonWorkspace(
				{ mimeType: (await runtime.operations.detectImageMimeType(params.path as string)) ?? null },
				runtime.workspace,
			);
		case "workspace.exec":
			return executeDaemonWorkspaceProcess(params, context, runtime);
		case "resource.read":
			return readDaemonResource(params, runtime);
		case "lsp.status":
			return getDaemonLspStatus(runtime);
		default:
			throw new RemoteWorkspaceRequestError({
				code: "method_not_supported",
				message: `Workspace operation is not implemented: ${request.method}`,
				executionState: "not_started",
				retryable: false,
			});
	}
}

export function createDaemonWorkspaceRuntime(configuration: DaemonConfiguration): DaemonWorkspaceRuntime {
	const operations = new ConfinedDaemonToolOperations(configuration);
	const toolNames: WorkspaceToolName[] = ["read", "edit", "write", "grep", "find", "ls"];
	if (configuration.allowProcessExec) toolNames.splice(1, 0, "bash");
	const lspConfiguration = loadDaemonLspConfiguration(configuration);
	const lspRuntime = lspConfiguration.enabled
		? createLspRuntimeState(configuration.workspaceRoot, {
				configuration: lspConfiguration,
				getToolBackendInfo: () => operations.getBackendInfo(),
				getToolOperations: () => operations,
				resolveConnectionFactory: (transport) =>
					transport.type === "spawn"
						? createManagedStdioConnectionFactory({
								...transport,
								env: operations.createChildEnvironment(transport.env),
								inheritEnvironment: false,
							})
						: resolveLspConnectionFactory(transport),
			})
		: undefined;
	const host = new WorkspaceToolHost({
		cwd: configuration.workspaceRoot,
		operations,
		toolNames,
		additionalDefinitions: lspRuntime
			? createLspToolDefinitions(
					() => lspRuntime,
					() => operations,
				)
			: undefined,
		disposeTimeoutMs: Math.min(configuration.shutdownTimeoutMs, 60_000),
	});
	const catalog: RemoteWorkspaceCatalog = {
		generation: 1,
		tools: host.getCatalog().map((entry) => ({
			name: entry.name,
			executionMode: operationKind(entry.name),
			parameterSchema: structuredClone(entry.parameters) as Record<string, unknown>,
			schemaHash: hashRemoteWorkspaceJson(entry.parameters),
			featureFlags: [],
		})),
		operations: [
			...PRIMITIVE_OPERATIONS.filter((method) => method !== "workspace.exec" || configuration.allowProcessExec),
			...(configuration.sandboxInstructionsPath ? (["resource.read"] as const) : []),
			...(lspRuntime ? (["lsp.status"] as const) : []),
		],
	};
	const capabilities: RemoteWorkspaceCapability[] = [
		"catalog_refresh",
		"primitive_operations",
		"tool_updates",
		...(lspRuntime ? (["lsp_status"] as const) : []),
	];
	let activeRequests = 0;

	return {
		operations,
		host,
		lspRuntime,
		catalog,
		capabilities,
		createHandler(workspace) {
			const requestRuntime: DaemonRequestRuntime = { configuration, operations, host, lspRuntime, workspace };
			return {
				validateToolArguments: (toolName, value) => host.validatePreparedArguments(toolName, value),
				async handleRequest(request, context) {
					if (activeRequests >= configuration.maxGlobalRequests) {
						throw new RemoteWorkspaceRequestError({
							code: "limit_exceeded",
							message: "Daemon global active request limit reached",
							executionState: "not_started",
							retryable: true,
						});
					}
					activeRequests++;
					try {
						return await dispatchDaemonWorkspaceRequest(request, context, requestRuntime);
					} finally {
						activeRequests--;
					}
				},
			};
		},
		retire: async () => {
			await host.waitForIdle(configuration.shutdownTimeoutMs);
			await lspRuntime?.manager.shutdownAll();
			await host.dispose();
		},
		dispose: async () => {
			await Promise.all([lspRuntime?.manager.shutdownAll(), host.dispose()]);
		},
	};
}
