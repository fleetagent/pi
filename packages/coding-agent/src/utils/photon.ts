/**
 * Photon image processing wrapper.
 *
 * This module provides a unified interface to @silvia-odwyer/photon-node that works in:
 * 1. Node.js (development, npm run build)
 * 2. Bun compiled binaries (standalone distribution)
 *
 * The challenge: photon-node's CJS entry uses fs.readFileSync(__dirname + '/photon_rs_bg.wasm')
 * which bakes the build machine's absolute path into Bun compiled binaries.
 *
 * Solution:
 * 1. Patch fs.readFileSync to redirect missing photon_rs_bg.wasm reads
 * 2. Copy photon_rs_bg.wasm next to the executable in build:binary
 */

import type * as PhotonNode from "@silvia-odwyer/photon-node";
import type * as NodeFs from "fs";
import { createRequire } from "module";
import * as path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const fs = require("fs") as typeof NodeFs;

// Re-export types from the main package
export type { PhotonImage as PhotonImageType } from "@silvia-odwyer/photon-node";

interface PatchedReadFileSyncObjectOptions extends NodeFs.ObjectEncodingOptions {
	flag?: string;
}

type PatchedReadFileSyncOptions = PatchedReadFileSyncObjectOptions | BufferEncoding | null;
type ReadFileSync = typeof NodeFs.readFileSync;
type PatchedReadFileSyncResult = string | Buffer<ArrayBuffer>;

const WASM_FILENAME = "photon_rs_bg.wasm";

// Lazy-loaded photon module
let photonModule: typeof PhotonNode | null = null;
let loadPromise: Promise<typeof PhotonNode | null> | null = null;

function pathOrNull(file: NodeFs.PathOrFileDescriptor): string | null {
	if (typeof file === "string") {
		return file;
	}
	if (file instanceof URL) {
		return fileURLToPath(file);
	}
	return null;
}

function getFallbackWasmPaths(): string[] {
	const execDir = path.dirname(process.execPath);
	return [
		path.join(execDir, WASM_FILENAME),
		path.join(execDir, "photon", WASM_FILENAME),
		path.join(process.cwd(), WASM_FILENAME),
	];
}
interface PhotonWasmReadContext {
	readFileSync: ReadFileSync;
	fallbackPaths: string[];
}

function readFallbackWasm(
	context: PhotonWasmReadContext,
	options: PatchedReadFileSyncOptions | undefined,
	originalError: unknown,
): PatchedReadFileSyncResult {
	for (const fallbackPath of context.fallbackPaths) {
		if (!fs.existsSync(fallbackPath)) continue;
		if (options === undefined) return context.readFileSync(fallbackPath);
		return context.readFileSync(fallbackPath, options);
	}
	throw originalError;
}

function readPhotonWasm(
	context: PhotonWasmReadContext,
	file: NodeFs.PathOrFileDescriptor,
	options: PatchedReadFileSyncOptions | undefined,
): PatchedReadFileSyncResult {
	try {
		return context.readFileSync(file, options);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err?.code && err.code !== "ENOENT") throw error;
		return readFallbackWasm(context, options, error);
	}
}

function patchPhotonWasmRead(): () => void {
	const originalReadFileSync: ReadFileSync = fs.readFileSync.bind(fs);
	const context: PhotonWasmReadContext = {
		readFileSync: originalReadFileSync,
		fallbackPaths: getFallbackWasmPaths(),
	};
	const mutableFs = fs as { readFileSync: ReadFileSync };

	const patchedReadFileSync: ReadFileSync = ((
		file: NodeFs.PathOrFileDescriptor,
		options?: PatchedReadFileSyncOptions,
	) => {
		const resolvedPath = pathOrNull(file);
		if (!resolvedPath?.endsWith(WASM_FILENAME)) return originalReadFileSync(file, options);
		return readPhotonWasm(context, file, options);
	}) as ReadFileSync;

	try {
		mutableFs.readFileSync = patchedReadFileSync;
	} catch {
		Object.defineProperty(fs, "readFileSync", {
			value: patchedReadFileSync,
			writable: true,
			configurable: true,
		});
	}

	return () => {
		try {
			mutableFs.readFileSync = originalReadFileSync;
		} catch {
			Object.defineProperty(fs, "readFileSync", {
				value: originalReadFileSync,
				writable: true,
				configurable: true,
			});
		}
	};
}

/**
 * Load the photon module asynchronously.
 * Returns cached module on subsequent calls.
 */
export async function loadPhoton(): Promise<typeof PhotonNode | null> {
	if (photonModule) {
		return photonModule;
	}

	if (loadPromise) {
		return loadPromise;
	}

	loadPromise = (async () => {
		const restoreReadFileSync = patchPhotonWasmRead();
		try {
			photonModule = await import("@silvia-odwyer/photon-node");
			return photonModule;
		} catch {
			photonModule = null;
			return photonModule;
		} finally {
			restoreReadFileSync();
		}
	})();

	return loadPromise;
}
