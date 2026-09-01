/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShellCaptureResult } from "@fleetagent/pi-agent-core";
import { stripAnsi } from "../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import type { ToolOperations } from "./tools/operations.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.ts";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Timeout in seconds */
	timeout?: number;
	/** Whether to truncate returned output. Defaults to true. */
	truncate?: boolean;
}

export type BashResult = ShellCaptureResult;

// ============================================================================
// Implementation
// ============================================================================

class BashOutputCapture {
	private outputChunks: string[] = [];
	private outputBytes = 0;
	private readonly maxOutputBytes = DEFAULT_MAX_BYTES * 2;
	private readonly truncateOutput: boolean;
	private tempFilePath: string | undefined;
	private tempFileStream: WriteStream | undefined;
	private totalBytes = 0;
	private readonly decoder = new TextDecoder();
	private readonly options: BashExecutorOptions;

	constructor(options: BashExecutorOptions = {}) {
		this.options = options;
		this.truncateOutput = options.truncate !== false;
	}

	private ensureTempFile(): void {
		if (this.tempFilePath) return;
		const id = randomBytes(8).toString("hex");
		this.tempFilePath = join(tmpdir(), `pi-bash-${id}.log`);
		this.tempFileStream = createWriteStream(this.tempFilePath);
		for (const chunk of this.outputChunks) {
			this.tempFileStream.write(chunk);
		}
	}

	onData = (data: Buffer): void => {
		this.totalBytes += data.length;
		const text = sanitizeBinaryOutput(stripAnsi(this.decoder.decode(data, { stream: true }))).replace(/\r/g, "");

		if (this.totalBytes > DEFAULT_MAX_BYTES) this.ensureTempFile();
		this.tempFileStream?.write(text);

		this.outputChunks.push(text);
		this.outputBytes += text.length;
		while (this.truncateOutput && this.outputBytes > this.maxOutputBytes && this.outputChunks.length > 1) {
			const removed = this.outputChunks.shift()!;
			this.outputBytes -= removed.length;
		}

		this.options.onChunk?.(text);
	};

	finish(exitCode: number | null | undefined, cancelled: boolean): BashResult {
		const fullOutput = this.outputChunks.join("");
		const truncationResult = this.truncateOutput
			? truncateTail(fullOutput)
			: { content: fullOutput, truncated: false };
		if (truncationResult.truncated) this.ensureTempFile();
		this.close();
		return {
			output: truncationResult.content,
			exitCode: cancelled ? undefined : (exitCode ?? undefined),
			cancelled,
			truncated: truncationResult.truncated,
			fullOutputPath: this.tempFilePath,
		};
	}

	close(): void {
		this.tempFileStream?.end();
	}
}
/**
 * Execute a bash command using custom ToolOperations.
 * Used for remote daemon, container, and host-provided execution backends.
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: ToolOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputCapture = new BashOutputCapture(options);

	try {
		const result = await operations.exec(command, {
			cwd,
			onData: outputCapture.onData,
			signal: options?.signal,
			timeout: options?.timeout,
		});
		const cancelled = options?.signal?.aborted ?? false;
		return outputCapture.finish(result.exitCode, cancelled);
	} catch (error) {
		if (options?.signal?.aborted) return outputCapture.finish(undefined, true);
		outputCapture.close();
		throw error;
	}
}
