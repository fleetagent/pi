import {
	findMostRecent,
	getDefaultSessionDir as getDefaultJsonlSessionDir,
	JsonlSessionStore,
	load,
} from "./stores/jsonl-session-store.ts";
import type { FileEntry } from "./types.ts";

export const jsonlSessionStore = new JsonlSessionStore();

/**
 * Compute the default session directory for a cwd.
 * Encodes cwd into a safe directory name under ~/.pi/agent/sessions/.
 */
export function getDefaultSessionDir(cwd: string, agentDir?: string): string {
	return getDefaultJsonlSessionDir(cwd, agentDir);
}

/** Exported for testing. */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
	return load(filePath);
}

/** Exported for testing. */
export function findMostRecentSession(sessionDir: string): string | null {
	return findMostRecent(sessionDir);
}
