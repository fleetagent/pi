import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { getAgentDir } from "../../config.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "../auth-storage.ts";

export const PROJECT_HOOK_TRUST_STORE_VERSION = 1 as const;
export const PROJECT_HOOK_TRUST_STORE_FILENAME = "trusted-project-hooks.json";

interface ProjectHookTrustData {
	version: typeof PROJECT_HOOK_TRUST_STORE_VERSION;
	trustedProjects: Record<string, true>;
}

export interface ProjectHookTrustResult {
	trusted: boolean;
	/** Canonical repository root, or canonical cwd when cwd is not in a repository. */
	identity?: string;
	/** A user-readable, nonfatal error. An error result always fails closed. */
	error?: string;
}

function emptyTrustData(): ProjectHookTrustData {
	return { version: PROJECT_HOOK_TRUST_STORE_VERSION, trustedProjects: {} };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingGitMarkerError(error: unknown): boolean {
	if (!isObject(error) || typeof error.code !== "string") return false;
	return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function parseTrustData(text: string | undefined): ProjectHookTrustData {
	if (text === undefined) return emptyTrustData();
	const value: unknown = JSON.parse(text);
	if (!isObject(value) || value.version !== PROJECT_HOOK_TRUST_STORE_VERSION || !isObject(value.trustedProjects)) {
		throw new Error(`expected version ${PROJECT_HOOK_TRUST_STORE_VERSION} trust-store JSON`);
	}
	const trustedProjects: Record<string, true> = {};
	for (const [identity, trusted] of Object.entries(value.trustedProjects)) {
		if (identity.length === 0 || trusted !== true) throw new Error("invalid trustedProjects entry");
		trustedProjects[identity] = true;
	}
	return { version: PROJECT_HOOK_TRUST_STORE_VERSION, trustedProjects };
}

function readableError(action: string, error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return `Unable to ${action} project hook trust: ${detail}`;
}

/** Return the physical cwd used to load approved project hook settings. */
export function canonicalProjectHookCwd(cwd: string): string {
	return realpathSync.native(resolve(cwd));
}

/**
 * Return the physical repository root containing cwd. If no ancestor has a
 * .git file or directory, return the physical cwd instead.
 */
export function canonicalProjectHookIdentity(cwd: string): string {
	const canonicalCwd = canonicalProjectHookCwd(cwd);
	let candidate = canonicalCwd;
	while (true) {
		try {
			const git = statSync(join(candidate, ".git"));
			if (git.isDirectory() || git.isFile()) return candidate;
		} catch (error) {
			if (!isMissingGitMarkerError(error)) throw error;
		}
		const parent = dirname(candidate);
		if (parent === candidate || candidate === parse(candidate).root) return canonicalCwd;
		candidate = parent;
	}
}

/**
 * Detect project hook declarations without loading or executing them.
 * Malformed and unreadable settings files are ignored.
 */
export function hasProjectHookConfiguration(cwd: string): boolean {
	const paths = [
		join(cwd, ".pi", "settings.json"),
		join(cwd, ".claude", "settings.json"),
		join(cwd, ".claude", "settings.local.json"),
	];
	for (const path of paths) {
		try {
			const value: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (isObject(value) && Object.hasOwn(value, "hooks")) return true;
		} catch {
			// Discovery is best-effort and must never make settings executable.
		}
	}
	return false;
}

/** Persistent, repository-scoped approval for project hooks. */
export class ProjectHookTrustStore {
	readonly path: string;
	private readonly agentDir: string;
	private readonly storage: AuthStorageBackend;

	constructor(agentDir = getAgentDir(), storage?: AuthStorageBackend) {
		this.agentDir = resolve(agentDir);
		this.path = join(this.agentDir, PROJECT_HOOK_TRUST_STORE_FILENAME);
		const initial = `${JSON.stringify(emptyTrustData(), null, 2)}\n`;
		this.storage = storage ?? new FileAuthStorageBackend(this.path, initial);
	}

	private secureStoragePath(): void {
		mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
		chmodSync(this.agentDir, 0o700);
		if (existsSync(this.path)) chmodSync(this.path, 0o600);
	}

	isTrusted(cwd: string): ProjectHookTrustResult {
		let identity: string;
		try {
			identity = canonicalProjectHookIdentity(cwd);
			this.secureStoragePath();
			return this.storage.withLock((current) => ({
				result: { trusted: parseTrustData(current).trustedProjects[identity] === true, identity },
			}));
		} catch (error) {
			return { trusted: false, error: readableError("read", error) };
		}
	}

	/** Persist approval for this repository identity. Hook contents are intentionally not fingerprinted. */
	trustAlways(cwd: string): ProjectHookTrustResult {
		try {
			return this.trustAlwaysIdentity(canonicalProjectHookIdentity(cwd));
		} catch (error) {
			return { trusted: false, error: readableError("update", error) };
		}
	}

	/** Persist an identity that was canonicalized and displayed before user approval. */
	trustAlwaysIdentity(identity: string): ProjectHookTrustResult {
		if (identity.length === 0 || resolve(identity) !== identity) {
			return { trusted: false, error: readableError("update", new Error("invalid canonical repository identity")) };
		}
		try {
			this.secureStoragePath();
			return this.storage.withLock((current) => {
				const data = parseTrustData(current);
				data.trustedProjects[identity] = true;
				return {
					result: { trusted: true, identity },
					next: `${JSON.stringify(data, null, 2)}\n`,
				};
			});
		} catch (error) {
			return { trusted: false, identity, error: readableError("update", error) };
		}
	}

	trust(cwd: string): ProjectHookTrustResult {
		return this.trustAlways(cwd);
	}

	revoke(cwd: string): ProjectHookTrustResult {
		let identity: string;
		try {
			identity = canonicalProjectHookIdentity(cwd);
			this.secureStoragePath();
			return this.storage.withLock((current) => {
				const data = parseTrustData(current);
				delete data.trustedProjects[identity];
				return {
					result: { trusted: false, identity },
					next: `${JSON.stringify(data, null, 2)}\n`,
				};
			});
		} catch (error) {
			return { trusted: false, error: readableError("update", error) };
		}
	}
}
