import type { ToolOperations } from "../tools/operations.ts";
import type { LspManager } from "./manager.ts";

export interface LspTrackedDocument {
	uri: string;
	languageId: string;
	version: number;
}

const DEFAULT_MAX_TRACKED_DOCUMENTS = 100;

export class LspFileSync {
	private readonly manager: LspManager;
	private readonly maxTrackedDocuments: number;
	private readonly tracked = new Map<string, LspTrackedDocument>();

	constructor(manager: LspManager, maxTrackedDocuments = DEFAULT_MAX_TRACKED_DOCUMENTS) {
		this.manager = manager;
		this.maxTrackedDocuments = maxTrackedDocuments;
	}

	get trackedCount(): number {
		return this.tracked.size;
	}

	getTrackedVersion(uri: string): number | undefined {
		return this.tracked.get(uri)?.version;
	}

	async handleFileRead(filePath: string, operations: ToolOperations): Promise<void> {
		const absolutePath = this.manager.resolvePath(filePath);
		const uri = this.manager.getFileUri(absolutePath);
		const existing = this.tracked.get(uri);
		if (existing) {
			this.touch(uri, existing);
			return;
		}

		const languageId = this.manager.getLanguageId(absolutePath);
		if (!languageId) return;
		const client = this.manager.getRunningClient(languageId);
		if (!client) return;

		const content = await this.readUtf8(absolutePath, operations);
		const document = { uri, languageId, version: 1 };
		this.tracked.set(uri, document);
		client.didOpen(uri, languageId, document.version, content);
		this.touch(uri, document);
	}

	async handleFileWrite(filePath: string, operations: ToolOperations): Promise<void> {
		const absolutePath = this.manager.resolvePath(filePath);
		const uri = this.manager.getFileUri(absolutePath);
		const languageId = this.manager.getLanguageId(absolutePath);
		if (!languageId) return;

		const client = this.manager.getRunningClient(languageId);
		if (!client) return;

		const content = await this.readUtf8(absolutePath, operations);
		const existing = this.tracked.get(uri);
		if (existing) {
			existing.version++;
			client.didChange(uri, existing.version, content);
			this.touch(uri, existing);
			return;
		}

		const document = { uri, languageId, version: 1 };
		this.tracked.set(uri, document);
		client.didOpen(uri, languageId, document.version, content);
		this.touch(uri, document);
	}

	private touch(uri: string, document: LspTrackedDocument): void {
		this.tracked.delete(uri);
		this.tracked.set(uri, document);

		while (this.tracked.size > this.maxTrackedDocuments) {
			const oldest = this.tracked.entries().next();
			if (oldest.done) return;
			const [oldestUri, oldestDocument] = oldest.value;
			this.tracked.delete(oldestUri);
			this.manager.getRunningClient(oldestDocument.languageId)?.didClose(oldestUri);
		}
	}

	private async readUtf8(absolutePath: string, operations: ToolOperations): Promise<string> {
		return (await operations.readFile(absolutePath)).toString("utf-8");
	}
}
