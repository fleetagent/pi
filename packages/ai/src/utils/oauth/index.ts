/**
 * OAuth credential management and provider registry.
 */
// ============================================================================
// Provider Registry
// ============================================================================

import { anthropicOAuthProvider } from "./anthropic.ts";
import { githubCopilotOAuthProvider } from "./github-copilot.ts";
import { openaiCodexOAuthProvider } from "./openai-codex.ts";
import type { OAuthCredentials, OAuthProviderId, OAuthProviderInfo, OAuthProviderInterface } from "./types.ts";

const BUILT_IN_OAUTH_PROVIDERS: OAuthProviderInterface[] = [
	anthropicOAuthProvider,
	githubCopilotOAuthProvider,
	openaiCodexOAuthProvider,
];

const oauthProviderRegistry = new Map<string, OAuthProviderInterface>(
	BUILT_IN_OAUTH_PROVIDERS.map((provider) => [provider.id, provider]),
);

/**
 * Get an OAuth provider by ID
 */
export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return oauthProviderRegistry.get(id);
}

/**
 * Register a custom OAuth provider
 */
export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	oauthProviderRegistry.set(provider.id, provider);
}

/**
 * Unregister an OAuth provider.
 *
 * If the provider is built-in, restores the built-in implementation.
 * Custom providers are removed completely.
 */
export function unregisterOAuthProvider(id: string): void {
	const builtInProvider = BUILT_IN_OAUTH_PROVIDERS.find((provider) => provider.id === id);
	if (builtInProvider) {
		oauthProviderRegistry.set(id, builtInProvider);
		return;
	}
	oauthProviderRegistry.delete(id);
}

/**
 * Reset OAuth providers to built-ins.
 */
export function resetOAuthProviders(): void {
	oauthProviderRegistry.clear();
	for (const provider of BUILT_IN_OAUTH_PROVIDERS) {
		oauthProviderRegistry.set(provider.id, provider);
	}
}

/**
 * Get all registered OAuth providers
 */
export function getOAuthProviders(): OAuthProviderInterface[] {
	return Array.from(oauthProviderRegistry.values());
}

/**
 * @deprecated Use getOAuthProviders() which returns OAuthProviderInterface[]
 */
export function getOAuthProviderInfoList(): OAuthProviderInfo[] {
	return getOAuthProviders().map((p) => ({
		id: p.id,
		name: p.name,
		available: true,
	}));
}

// ============================================================================
// High-level API (uses provider registry)
// ============================================================================

const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 15_000;
const NEVER_ABORTED_SIGNAL = new AbortController().signal;

async function refreshProviderToken(
	providerId: OAuthProviderId,
	provider: OAuthProviderInterface,
	credentials: OAuthCredentials,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	signal?.throwIfAborted();
	const timeoutSignal = AbortSignal.timeout(DEFAULT_OAUTH_REFRESH_TIMEOUT_MS);
	const refreshSignal = AbortSignal.any([signal ?? NEVER_ABORTED_SIGNAL, timeoutSignal]);

	try {
		return await provider.refreshToken(credentials, refreshSignal);
	} catch (error) {
		if (signal?.aborted) {
			throw signal.reason;
		}
		if (timeoutSignal.aborted) {
			throw new Error(
				`OAuth token refresh timed out after ${DEFAULT_OAUTH_REFRESH_TIMEOUT_MS}ms for ${providerId}`,
				{
					cause: timeoutSignal.reason ?? error,
				},
			);
		}
		const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		throw new Error(`Failed to refresh OAuth token for ${providerId}: ${details}`, { cause: error });
	}
}
/**
 * Refresh token for any OAuth provider.
 * @deprecated Use getOAuthProvider(id).refreshToken() instead
 */
export async function refreshOAuthToken(
	providerId: OAuthProviderId,
	credentials: OAuthCredentials,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown OAuth provider: ${providerId}`);
	}
	return refreshProviderToken(providerId, provider, credentials, signal);
}

/**
 * Get API key for a provider from OAuth credentials.
 * Automatically refreshes expired tokens.
 *
 * @returns API key string and updated credentials, or null if no credentials
 * @throws Error if refresh fails
 */
export async function getOAuthApiKey(
	providerId: OAuthProviderId,
	credentials: Record<string, OAuthCredentials>,
	signal?: AbortSignal,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	const provider = getOAuthProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown OAuth provider: ${providerId}`);
	}

	let creds = credentials[providerId];
	if (!creds) {
		return null;
	}

	// Refresh if expired
	if (Date.now() >= creds.expires) {
		creds = await refreshProviderToken(providerId, provider, creds, signal);
	}

	const apiKey = provider.getApiKey(creds);
	return { newCredentials: creds, apiKey };
}
