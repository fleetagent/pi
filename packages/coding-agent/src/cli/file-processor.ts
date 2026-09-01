/**
 * Process @file CLI arguments into text content and image attachments
 */

import { access, readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@fleetagent/pi-ai";
import chalk from "chalk";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { processImage } from "../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
}

interface ProcessedFileArgument {
	text: string;
	image?: ImageContent;
}

async function processImageFile(
	absolutePath: string,
	mimeType: string,
	autoResizeImages: boolean,
): Promise<ProcessedFileArgument> {
	const content = await readFile(absolutePath);
	const processed = await processImage(content, mimeType, { autoResizeImages });
	if (!processed.ok) return { text: `<file name="${absolutePath}">${processed.message}</file>\n` };
	const image: ImageContent = { type: "image", mimeType: processed.mimeType, data: processed.data };
	const hints = processed.hints.length > 0 ? processed.hints.join("\n") : "";
	return { text: `<file name="${absolutePath}">${hints}</file>\n`, image };
}

async function processTextFile(absolutePath: string): Promise<ProcessedFileArgument> {
	try {
		const content = await readFile(absolutePath, "utf-8");
		return { text: `<file name="${absolutePath}">\n${content}\n</file>\n` };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
		process.exit(1);
	}
}

async function processFileArgument(
	fileArg: string,
	autoResizeImages: boolean,
): Promise<ProcessedFileArgument | undefined> {
	const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));
	try {
		await access(absolutePath);
	} catch {
		console.error(chalk.red(`Error: File not found: ${absolutePath}`));
		process.exit(1);
	}
	const stats = await stat(absolutePath);
	if (stats.size === 0) return undefined;
	const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
	return mimeType ? processImageFile(absolutePath, mimeType, autoResizeImages) : processTextFile(absolutePath);
}
/** Process @file arguments into text content and image attachments */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	let text = "";
	const images: ImageContent[] = [];
	for (const fileArg of fileArgs) {
		const processed = await processFileArgument(fileArg, autoResizeImages);
		if (!processed) continue;
		if (processed.image) images.push(processed.image);
		text += processed.text;
	}

	return { text, images };
}
