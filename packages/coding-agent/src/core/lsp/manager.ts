import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LspClient, type LspClientOptions } from "./client.ts";
import { getLspLanguageId } from "./language-map.ts";

export interface LspServerConfig {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

export interface LspServerStatus {
	languageId: string;
	command: string;
	running: boolean;
	starting: boolean;
	diagnosticsCount: number;
}

export interface LspManagerOptions {
	serverConfigs?: Record<string, LspServerConfig>;
	createClient?: (options: LspClientOptions) => LspClient;
}

const DEFAULT_SERVER_CONFIGS: Record<string, LspServerConfig> = {
	javascript: { command: "typescript-language-server", args: ["--stdio"] },
	javascriptreact: { command: "typescript-language-server", args: ["--stdio"] },
	typescript: { command: "typescript-language-server", args: ["--stdio"] },
	typescriptreact: { command: "typescript-language-server", args: ["--stdio"] },
};

export class LspManager {
	private readonly rootDir: string;
	private readonly serverConfigs: Map<string, LspServerConfig>;
	private readonly createClient: (options: LspClientOptions) => LspClient;
	private readonly clients = new Map<string, LspClient>();
	private readonly starting = new Map<string, Promise<LspClient>>();
	private shuttingDown = false;

	constructor(rootDir: string, options: LspManagerOptions = {}) {
		this.rootDir = resolve(rootDir);
		this.serverConfigs = new Map(Object.entries({ ...DEFAULT_SERVER_CONFIGS, ...options.serverConfigs }));
		this.createClient = options.createClient ?? ((clientOptions) => new LspClient(clientOptions));
	}

	get cwd(): string {
		return this.rootDir;
	}

	resolvePath(filePath: string): string {
		return resolve(this.rootDir, filePath);
	}

	getFileUri(filePath: string): string {
		return pathToFileURL(this.resolvePath(filePath)).toString();
	}

	getLanguageId(filePath: string): string | undefined {
		return getLspLanguageId(filePath);
	}

	getServerConfig(languageId: string): LspServerConfig | undefined {
		return this.serverConfigs.get(languageId);
	}

	setServerConfig(languageId: string, config: LspServerConfig): void {
		this.serverConfigs.set(languageId, config);
	}

	getRunningClient(languageId: string): LspClient | undefined {
		const client = this.clients.get(languageId);
		return client?.isInitialized === true && !client.isDisposed ? client : undefined;
	}

	isStarting(languageId: string): boolean {
		return this.starting.has(languageId);
	}

	async getClientForFile(filePath: string): Promise<LspClient | undefined> {
		const languageId = this.getLanguageId(filePath);
		if (!languageId) return undefined;
		return this.getClientForLanguage(languageId);
	}

	async getClientForLanguage(languageId: string): Promise<LspClient | undefined> {
		if (this.shuttingDown) return undefined;
		const running = this.getRunningClient(languageId);
		if (running) return running;

		const pending = this.starting.get(languageId);
		if (pending) return pending;

		const config = this.serverConfigs.get(languageId);
		if (!config) return undefined;

		const start = this.startClient(languageId, config);
		this.starting.set(languageId, start);
		try {
			return await start;
		} finally {
			this.starting.delete(languageId);
		}
	}

	getUnavailableReason(filePath: string): string {
		const languageId = this.getLanguageId(filePath);
		if (!languageId) return `No LSP language mapping for file type: ${filePath}`;
		if (!this.serverConfigs.has(languageId)) return `No LSP server configured for language: ${languageId}`;
		if (this.starting.has(languageId)) return `LSP server for ${languageId} is starting. Retry shortly.`;
		return `No running LSP server for ${filePath}. Call an LSP tool for this file to start it.`;
	}

	getStatus(): LspServerStatus[] {
		return [...this.serverConfigs.entries()].map(([languageId, config]) => {
			const client = this.clients.get(languageId);
			let diagnosticsCount = 0;
			if (client) {
				for (const diagnostics of client.getAllDiagnostics().values()) {
					diagnosticsCount += diagnostics.length;
				}
			}
			return {
				languageId,
				command: config.command,
				running: client?.isInitialized === true && !client.isDisposed,
				starting: this.starting.has(languageId),
				diagnosticsCount,
			};
		});
	}

	async shutdownAll(): Promise<void> {
		this.shuttingDown = true;
		const clients = [...this.clients.values()];
		this.clients.clear();
		this.starting.clear();
		await Promise.all(clients.map((client) => client.shutdown().catch(() => undefined)));
	}

	private async startClient(languageId: string, config: LspServerConfig): Promise<LspClient> {
		const client = this.createClient({
			command: config.command,
			args: config.args,
			env: config.env,
			rootDir: this.rootDir,
			languageId,
			onUnexpectedExit: () => {
				this.clients.delete(languageId);
			},
		});
		await client.start();
		this.clients.set(languageId, client);
		return client;
	}
}
