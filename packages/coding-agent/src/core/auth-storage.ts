/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Uses file locking to prevent race conditions when multiple pi instances
 * try to refresh tokens simultaneously.
 */

import {
	findEnvKeys,
	getEnvApiKey,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderId,
} from "@fleetagent/pi-ai";
import {
	getOAuthApiKey,
	getOAuthProvider,
	getOAuthProviders,
	type OAuthApiKeyResolution,
} from "@fleetagent/pi-ai/oauth";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { setTimeout as sleep } from "timers/promises";
import { getAgentDir } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import { resolveConfigValue } from "./resolve-config-value.ts";

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthStorageData = Record<string, AuthCredential>;

export type AuthStatus = {
	configured: boolean;
	source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	label?: string;
};

export interface AuthApiKeyLookupOptions {
	includeFallback?: boolean;
}

type LockResult<T> = {
	result: T;
	next?: string;
};

type StoredOAuthApiKeyResolution = { kind: "resolved"; apiKey: string | undefined } | { kind: "fallback" };

const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

type AuthFileReadState = {
	data: AuthStorageData;
	generation: number;
	revision?: string;
	reload?: Promise<AuthStorageData>;
};

const sharedAuthFileReadStates = new Map<string, AuthFileReadState>();

function getFileRevision(path: string): string | undefined {
	try {
		const stats = statSync(path, { bigint: true });
		return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
	} catch {
		return undefined;
	}
}

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	private authPath: string;
	private initialContent: string;

	constructor(authPath: string = join(getAgentDir(), "auth.json"), initialContent = "{}") {
		this.authPath = normalizePath(authPath);
		this.initialContent = initialContent;
	}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			writeFileSync(this.authPath, this.initialContent, AUTH_FILE_WRITE_OPTIONS);
			chmodSync(this.authPath, 0o600);
		}
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire auth storage lock");
	}

	private async acquireLockAsync(onCompromised: (error: Error) => void): Promise<() => Promise<void>> {
		const staleMs = 30_000;
		const maxDelayMs = 2_000;
		const deadline = Date.now() + staleMs;
		let retry = 0;
		while (true) {
			try {
				return await lockfile.lock(this.authPath, {
					realpath: false,
					retries: 0,
					stale: staleMs,
					onCompromised,
				});
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				const remainingMs = deadline - Date.now();
				if (code !== "ELOCKED" || remainingMs <= 0) throw error;
				const baseDelayMs = Math.min(10 * 2 ** retry, maxDelayMs / 2);
				retry++;
				const delayMs = Math.min(Math.round(baseDelayMs * (1 + Math.random())), remainingMs);
				await sleep(delayMs);
			}
		}
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.authPath);
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
				chmodSync(this.authPath, 0o600);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await this.acquireLockAsync((err) => {
				lockCompromised = true;
				lockCompromisedError = err;
			});

			throwIfCompromised();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			if (next !== undefined) {
				writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
				chmodSync(this.authPath, 0o600);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const { result, next } = await fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage {
	private runtimeOverrides: Map<string, string> = new Map();
	private fallbackResolver?: (provider: string) => string | undefined;
	private loadError: Error | null = null;
	private errors: Error[] = [];
	private storage: AuthStorageBackend;
	private authPath: string | undefined;
	private readState: AuthFileReadState;

	private constructor(storage: AuthStorageBackend, authPath?: string) {
		this.storage = storage;
		this.authPath = authPath;
		this.readState = authPath
			? (sharedAuthFileReadStates.get(authPath) ?? { data: {}, generation: 0 })
			: { data: {}, generation: 0 };
		if (authPath) {
			sharedAuthFileReadStates.set(authPath, this.readState);
			const revision = getFileRevision(authPath);
			if (revision !== undefined && revision === this.readState.revision) return;
		}
		this.reload();
	}

	static create(authPath: string = join(getAgentDir(), "auth.json")): AuthStorage {
		const normalizedAuthPath = normalizePath(authPath);
		return new AuthStorage(new FileAuthStorageBackend(normalizedAuthPath), normalizedAuthPath);
	}

	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		return new AuthStorage(storage);
	}

	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.runtimeOverrides.delete(provider);
	}

	/**
	 * Set a fallback resolver for API keys not found in auth.json or env vars.
	 * Used for custom provider keys from models.json.
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.fallbackResolver = resolver;
	}

	private recordError(error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(normalizedError);
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		return JSON.parse(content) as AuthStorageData;
	}

	private updateReadState(data: AuthStorageData, revision?: string): void {
		this.readState.data = data;
		this.readState.revision = revision;
		this.readState.generation++;
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		let content: string | undefined;
		let revision: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				revision = this.authPath ? getFileRevision(this.authPath) : undefined;
				return { result: undefined };
			});
			this.updateReadState(this.parseStorageData(content), revision);
			this.loadError = null;
		} catch (error) {
			this.loadError = error as Error;
			this.recordError(error);
		}
	}

	private async reloadFromStorageAsync(): Promise<AuthStorageData> {
		const generation = this.readState.generation;
		let currentData: AuthStorageData = {};
		let revision: string | undefined;
		await this.storage.withLockAsync(async (content) => {
			currentData = this.parseStorageData(content);
			revision = this.authPath ? getFileRevision(this.authPath) : undefined;
			return { result: undefined };
		});
		if (this.readState.generation !== generation) return this.readState.data;
		this.updateReadState(currentData, revision);
		this.loadError = null;
		return currentData;
	}

	private async readLatestData(): Promise<AuthStorageData> {
		if (this.authPath) {
			const revision = getFileRevision(this.authPath);
			if (revision !== undefined && revision === this.readState.revision) return this.readState.data;
		}
		if (!this.readState.reload) {
			const reload = this.reloadFromStorageAsync().catch((error: unknown) => {
				this.loadError = error as Error;
				this.recordError(error);
				return this.readState.data;
			});
			this.readState.reload = reload;
			void reload.finally(() => {
				if (this.readState.reload === reload) this.readState.reload = undefined;
			});
		}
		return this.readState.reload;
	}

	private readLatestDataSync(): AuthStorageData {
		if (!this.authPath) return this.readState.data;
		const revision = getFileRevision(this.authPath);
		if (revision !== undefined && revision === this.readState.revision) return this.readState.data;
		if (this.readState.reload && revision !== undefined) {
			try {
				const content = readFileSync(this.authPath, "utf-8");
				if (getFileRevision(this.authPath) !== revision) return this.readState.data;
				this.updateReadState(this.parseStorageData(content), revision);
				this.loadError = null;
			} catch (error) {
				this.loadError = error as Error;
				this.recordError(error);
			}
			return this.readState.data;
		}
		this.reload();
		return this.readState.data;
	}

	private persistProviderChange(provider: string, credential: AuthCredential | undefined): AuthStorageData {
		if (this.loadError) {
			this.reload();
		}

		if (this.loadError) {
			const error = new Error(
				`Cannot update auth storage because it could not be loaded: ${this.loadError.message}`,
			);
			this.recordError(error);
			throw error;
		}
		try {
			let persistedData: AuthStorageData = {};
			this.storage.withLock((current) => {
				const currentData = this.parseStorageData(current);
				const merged: AuthStorageData = { ...currentData };
				if (credential) {
					merged[provider] = credential;
				} else {
					delete merged[provider];
				}
				persistedData = merged;
				return { result: undefined, next: JSON.stringify(merged, null, 2) };
			});
			this.updateReadState(persistedData);
			this.loadError = null;
			return persistedData;
		} catch (error) {
			this.recordError(error);
			throw error;
		}
	}

	/**
	 * Get credential for a provider.
	 */
	get(provider: string): AuthCredential | undefined {
		return this.readLatestDataSync()[provider] ?? undefined;
	}

	/**
	 * Set credential for a provider.
	 */
	set(provider: string, credential: AuthCredential): void {
		this.persistProviderChange(provider, credential);
	}

	/**
	 * Remove credential for a provider.
	 */
	remove(provider: string): void {
		this.persistProviderChange(provider, undefined);
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return Object.keys(this.readLatestDataSync());
	}

	/**
	 * Check if credentials exist for a provider in auth.json.
	 */
	has(provider: string): boolean {
		return provider in this.readLatestDataSync();
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		if (this.runtimeOverrides.has(provider)) return true;
		if (this.readLatestDataSync()[provider]) return true;
		if (getEnvApiKey(provider)) return true;
		if (this.fallbackResolver?.(provider)) return true;
		return false;
	}

	/**
	 * Return auth status without exposing credential values or refreshing tokens.
	 */
	getAuthStatus(provider: string): AuthStatus {
		if (this.readLatestDataSync()[provider]) {
			return { configured: true, source: "stored" };
		}
		if (this.runtimeOverrides.has(provider)) {
			return { configured: false, source: "runtime", label: "--api-key" };
		}

		const envKeys = findEnvKeys(provider);
		if (envKeys?.[0]) {
			return { configured: false, source: "environment", label: envKeys[0] };
		}

		if (this.fallbackResolver?.(provider)) {
			return { configured: false, source: "fallback", label: "custom provider config" };
		}

		return { configured: false };
	}

	/**
	 * Get all credentials (for passing to getOAuthApiKey).
	 */
	getAll(): AuthStorageData {
		return { ...this.readLatestDataSync() };
	}

	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	/**
	 * Login to an OAuth provider.
	 */
	async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			throw new Error(`Unknown OAuth provider: ${providerId}`);
		}

		const credentials = await provider.login(callbacks);
		this.set(providerId, { type: "oauth", ...credentials });
	}

	/**
	 * Logout from a provider.
	 */
	logout(provider: string): void {
		this.remove(provider);
	}

	/**
	 * Refresh OAuth token with backend locking to prevent race conditions.
	 * Multiple pi instances may try to refresh simultaneously when tokens expire.
	 */
	private async refreshOAuthTokenWithLock(providerId: OAuthProviderId): Promise<OAuthApiKeyResolution | null> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			return null;
		}

		let latestData = this.readState.data;
		let revision: string | undefined;
		const result = await this.storage.withLockAsync(async (current) => {
			const currentData = this.parseStorageData(current);
			latestData = currentData;
			revision = this.authPath ? getFileRevision(this.authPath) : undefined;
			this.loadError = null;

			const cred = currentData[providerId];
			if (cred?.type !== "oauth") {
				return { result: null };
			}

			if (Date.now() < cred.expires) {
				return { result: { apiKey: provider.getApiKey(cred), newCredentials: cred } };
			}

			const oauthCreds: Record<string, OAuthCredentials> = {};
			for (const [key, value] of Object.entries(currentData)) {
				if (value.type === "oauth") {
					oauthCreds[key] = value;
				}
			}

			const refreshed = await getOAuthApiKey(providerId, oauthCreds);
			if (!refreshed) {
				return { result: null };
			}

			const merged: AuthStorageData = {
				...currentData,
				[providerId]: { type: "oauth", ...refreshed.newCredentials },
			};
			latestData = merged;
			revision = undefined;
			return { result: refreshed, next: JSON.stringify(merged, null, 2) };
		});
		this.updateReadState(latestData, revision);

		return result;
	}

	private async resolveStoredOAuthApiKey(
		providerId: string,
		credential: OAuthCredential,
	): Promise<StoredOAuthApiKeyResolution> {
		const provider = getOAuthProvider(providerId);
		if (!provider) return { kind: "resolved", apiKey: undefined };

		if (Date.now() < credential.expires) {
			return { kind: "resolved", apiKey: provider.getApiKey(credential) };
		}

		try {
			const refreshed = await this.refreshOAuthTokenWithLock(providerId);
			return refreshed ? { kind: "resolved", apiKey: refreshed.apiKey } : { kind: "fallback" };
		} catch (error) {
			this.recordError(error);
			// Re-read storage in case another instance refreshed successfully.
			this.reload();
			const updatedCredential = this.readState.data[providerId];
			if (updatedCredential?.type === "oauth" && Date.now() < updatedCredential.expires) {
				return { kind: "resolved", apiKey: provider.getApiKey(updatedCredential) };
			}

			// Preserve credentials for retry; callers can re-authenticate with /login.
			return { kind: "resolved", apiKey: undefined };
		}
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. API key from auth.json
	 * 3. OAuth token from auth.json (auto-refreshed with locking)
	 * 4. Environment variable
	 * 5. Fallback resolver (models.json custom providers)
	 */
	async getApiKey(providerId: string, options?: AuthApiKeyLookupOptions): Promise<string | undefined> {
		// Runtime override takes highest priority
		const runtimeKey = this.runtimeOverrides.get(providerId);
		if (runtimeKey) {
			return runtimeKey;
		}

		const cred = (await this.readLatestData())[providerId];

		if (cred?.type === "api_key") {
			return resolveConfigValue(cred.key);
		}

		if (cred?.type === "oauth") {
			const resolution = await this.resolveStoredOAuthApiKey(providerId, cred);
			if (resolution.kind === "resolved") return resolution.apiKey;
		}

		// Fall back to environment variable
		const envKey = getEnvApiKey(providerId);
		if (envKey) return envKey;

		// Fall back to custom resolver (e.g., models.json custom providers)
		if (options?.includeFallback !== false) {
			return this.fallbackResolver?.(providerId) ?? undefined;
		}

		return undefined;
	}

	/**
	 * Get all registered OAuth providers
	 */
	getOAuthProviders() {
		return getOAuthProviders();
	}
}
