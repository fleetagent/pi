import { JsonlSessionStore } from "./stores/jsonl-session-store.ts";
import type { FileEntry } from "./types.ts";

export const jsonlSessionStore = new JsonlSessionStore();

/**
 * Compute the default session directory for a cwd.
 * Encodes cwd into a safe directory name under ~/.pi/agent/sessions/.
 */
export function getDefaultSessionDir(cwd: string, agentDir?: string): string {
	return jsonlSessionStore.getDefaultSessionDir(cwd, agentDir);
}

/** Exported for testing. */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
	return jsonlSessionStore.load(filePath);
}

/** Exported for testing. */
export function findMostRecentSession(sessionDir: string): string | null {
	return jsonlSessionStore.findMostRecent(sessionDir);
}
