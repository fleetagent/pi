import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { ImageContent, TextContent } from "@fleetagent/pi-ai";
import type {
	Diagnostic,
	InitializeParams,
	InitializeResult,
	PublishDiagnosticsParams,
	ServerCapabilities,
} from "vscode-languageserver-protocol";
import {
	createMessageConnection,
	type MessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-languageserver-protocol/node.js";

export interface LspClientOptions {
	command: string;
	args: string[];
	rootDir: string;
	languageId: string;
	env?: Record<string, string>;
	onUnexpectedExit?: (code: number | null) => void;
}

export interface LspClientStartResult {
	capabilities: ServerCapabilities;
}

type ToolContent = TextContent | ImageContent;

function mergeEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
	return extra ? { ...process.env, ...extra } : process.env;
}

export class LspClient {
	readonly command: string;
	readonly languageId: string;
	readonly rootDir: string;

	private readonly options: LspClientOptions;
	private child: ChildProcessWithoutNullStreams | undefined;
	private connection: MessageConnection | undefined;
	private capabilities: ServerCapabilities | undefined;
	private diagnostics = new Map<string, Diagnostic[]>();
	private initialized = false;
	private disposed = false;

	constructor(options: LspClientOptions) {
		this.options = options;
		this.command = options.command;
		this.languageId = options.languageId;
		this.rootDir = options.rootDir;
	}

	get isInitialized(): boolean {
		return this.initialized;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	get serverCapabilities(): ServerCapabilities | undefined {
		return this.capabilities;
	}

	getDiagnostics(uri: string): Diagnostic[] {
		return this.diagnostics.get(uri) ?? [];
	}

	getAllDiagnostics(): Map<string, Diagnostic[]> {
		return new Map(this.diagnostics);
	}

	async start(): Promise<LspClientStartResult> {
		if (this.disposed) {
			throw new Error(`LSP client for ${this.languageId} is disposed`);
		}
		if (this.initialized && this.capabilities) {
			return { capabilities: this.capabilities };
		}

		this.child = spawn(this.options.command, this.options.args, {
			cwd: this.options.rootDir,
			env: mergeEnv(this.options.env),
			stdio: "pipe",
		});

		await new Promise<void>((resolve, reject) => {
			const cleanup = (): void => {
				this.child?.off("spawn", onSpawn);
				this.child?.off("error", onError);
			};
			const onSpawn = (): void => {
				cleanup();
				resolve();
			};
			const onError = (error: Error): void => {
				cleanup();
				reject(new Error(`Failed to spawn LSP server "${this.options.command}": ${error.message}`));
			};
			this.child?.once("spawn", onSpawn);
			this.child?.once("error", onError);
		});

		this.child.stderr.resume();
		this.child.stdin.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
		});
		this.child.on("exit", (code) => {
			if (this.disposed) return;
			this.initialized = false;
			this.disposeConnection();
			this.options.onUnexpectedExit?.(code);
		});

		this.connection = createMessageConnection(
			new StreamMessageReader(this.child.stdout),
			new StreamMessageWriter(this.child.stdin),
		);
		this.registerConnectionHandlers();
		this.connection.listen();

		const initializeParams: InitializeParams = {
			processId: process.pid,
			rootUri: pathToFileURL(this.options.rootDir).toString(),
			workspaceFolders: [{ uri: pathToFileURL(this.options.rootDir).toString(), name: this.options.rootDir }],
			capabilities: {
				textDocument: {
					synchronization: { didSave: true, dynamicRegistration: false },
					hover: { contentFormat: ["plaintext", "markdown"] },
					definition: {},
					references: {},
					rename: { prepareSupport: false },
					publishDiagnostics: { relatedInformation: true },
				},
				workspace: { configuration: true, workspaceFolders: true },
			},
		};
		const result = await this.connection.sendRequest<InitializeResult>("initialize", initializeParams);
		this.capabilities = result.capabilities;
		this.connection.sendNotification("initialized", {});
		this.initialized = true;
		return { capabilities: result.capabilities };
	}

	async sendRequest<TResult>(method: string, params: unknown): Promise<TResult> {
		if (!this.connection || !this.initialized) {
			throw new Error(`LSP client for ${this.languageId} is not initialized`);
		}
		return this.connection.sendRequest<TResult>(method, params);
	}

	sendNotification(method: string, params: unknown): void {
		if (!this.connection || !this.initialized) return;
		this.connection.sendNotification(method, params);
	}

	didOpen(uri: string, languageId: string, version: number, text: string): void {
		this.sendNotification("textDocument/didOpen", {
			textDocument: { uri, languageId, version, text },
		});
	}

	didChange(uri: string, version: number, text: string): void {
		this.sendNotification("textDocument/didChange", {
			textDocument: { uri, version },
			contentChanges: [{ text }],
		});
	}

	didClose(uri: string): void {
		this.sendNotification("textDocument/didClose", { textDocument: { uri } });
	}

	async shutdown(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.initialized = false;
		try {
			if (this.connection) {
				const shutdown = this.connection.sendRequest("shutdown").catch(() => undefined);
				await Promise.race([shutdown, new Promise((resolve) => setTimeout(resolve, 3000))]);
				this.connection.sendNotification("exit");
			}
		} catch {
			// Server may already be gone.
		}
		this.disposeConnection();
		this.child?.kill("SIGTERM");
		const child = this.child;
		if (child) {
			setTimeout(() => {
				if (!child.killed) child.kill("SIGKILL");
			}, 2000).unref?.();
		}
		this.child = undefined;
	}

	private registerConnectionHandlers(): void {
		this.connection?.onNotification("textDocument/publishDiagnostics", (params: PublishDiagnosticsParams) => {
			this.diagnostics.set(params.uri, params.diagnostics);
		});
		this.connection?.onRequest("workspace/configuration", () => []);
		this.connection?.onError(() => undefined);
		this.connection?.onClose(() => {
			if (!this.disposed) this.initialized = false;
		});
	}

	private disposeConnection(): void {
		try {
			this.connection?.dispose();
		} catch {
			// Already disposed.
		}
		this.connection = undefined;
	}
}

export function getTextFromToolContent(content: ToolContent): string | undefined {
	return content.type === "text" ? content.text : undefined;
}
