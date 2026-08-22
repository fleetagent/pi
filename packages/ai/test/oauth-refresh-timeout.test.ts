import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshAnthropicToken } from "../src/utils/oauth/anthropic.ts";
import { refreshGitHubCopilotToken } from "../src/utils/oauth/github-copilot.ts";
import {
	getOAuthApiKey,
	refreshOAuthToken,
	registerOAuthProvider,
	unregisterOAuthProvider,
} from "../src/utils/oauth/index.ts";
import { refreshOpenAICodexToken } from "../src/utils/oauth/openai-codex.ts";
import type { OAuthCredentials, OAuthProviderInterface } from "../src/utils/oauth/types.ts";

const credentials: OAuthCredentials = {
	access: "expired-access",
	refresh: "refresh-token",
	expires: 0,
};

function createStalledProvider(id: string, onStart?: (signal: AbortSignal) => void): OAuthProviderInterface {
	return {
		id,
		name: "Stalled OAuth",
		login: async () => credentials,
		refreshToken: async (_credentials, signal) => {
			if (!signal) throw new Error("Expected a refresh signal");
			onStart?.(signal);
			return new Promise<OAuthCredentials>((_resolve, reject) => {
				const rejectAborted = () => reject(signal.reason);
				signal.addEventListener("abort", rejectAborted, { once: true });
				if (signal.aborted) rejectAborted();
			});
		},
		getApiKey: (current) => current.access,
	};
}

describe.sequential("OAuth refresh bounds", () => {
	const providerIds: string[] = [];

	afterEach(() => {
		for (const providerId of providerIds.splice(0)) unregisterOAuthProvider(providerId);
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("composes a 15-second timeout and reports timeout failures with their cause", async () => {
		const providerId = `timeout-${crypto.randomUUID()}`;
		providerIds.push(providerId);
		const timeoutController = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
		let refreshSignal: AbortSignal | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		registerOAuthProvider(
			createStalledProvider(providerId, (signal) => {
				refreshSignal = signal;
				markStarted?.();
			}),
		);

		const refresh = getOAuthApiKey(providerId, { [providerId]: credentials });
		await started;
		expect(timeout).toHaveBeenCalledWith(15_000);
		expect(refreshSignal).not.toBe(timeoutController.signal);

		const timeoutReason = new DOMException("The operation was aborted due to timeout", "TimeoutError");
		timeoutController.abort(timeoutReason);
		let thrown: unknown;
		try {
			await refresh;
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toMatchObject({
			message: `OAuth token refresh timed out after 15000ms for ${providerId}`,
			cause: timeoutReason,
		});
	});

	it("preserves caller cancellation through the composed refresh signal", async () => {
		const providerId = `cancel-${crypto.randomUUID()}`;
		providerIds.push(providerId);
		const timeoutController = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		registerOAuthProvider(createStalledProvider(providerId, () => markStarted?.()));
		const callerController = new AbortController();

		const refresh = refreshOAuthToken(providerId, credentials, callerController.signal);
		await started;
		const cancellation = new Error("caller cancelled model resolution");
		callerController.abort(cancellation);

		await expect(refresh).rejects.toBe(cancellation);
		expect(timeoutController.signal.aborted).toBe(false);
	});

	it("keeps provider failure details and the original cause", async () => {
		const providerId = `failure-${crypto.randomUUID()}`;
		providerIds.push(providerId);
		const providerFailure = new Error("refresh endpoint rejected the token");
		registerOAuthProvider({
			id: providerId,
			name: "Failing OAuth",
			login: async () => credentials,
			refreshToken: async () => {
				throw providerFailure;
			},
			getApiKey: (current) => current.access,
		});

		let thrown: unknown;
		try {
			await getOAuthApiKey(providerId, { [providerId]: credentials });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toMatchObject({
			message: `Failed to refresh OAuth token for ${providerId}: Error: refresh endpoint rejected the token`,
			cause: providerFailure,
		});
	});

	it("passes supplied cancellation signals to every built-in refresh transport", async () => {
		const signals: AbortSignal[] = [];
		const accountPayload = btoa(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-id" } }),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				if (!(init?.signal instanceof AbortSignal)) throw new Error("Expected fetch cancellation signal");
				signals.push(init.signal);
				const url = input instanceof Request ? input.url : String(input);
				if (url.includes("platform.claude.com")) {
					return Response.json({
						access_token: "anthropic-access",
						refresh_token: "anthropic-refresh",
						expires_in: 3600,
					});
				}
				if (url.includes("copilot_internal")) {
					return Response.json({ token: "copilot-access", expires_at: Math.floor(Date.now() / 1000) + 3600 });
				}
				if (url.includes("auth.openai.com")) {
					return Response.json({
						access_token: `header.${accountPayload}.signature`,
						refresh_token: "openai-refresh",
						expires_in: 3600,
					});
				}
				throw new Error(`Unexpected OAuth URL: ${url}`);
			}),
		);
		const controller = new AbortController();

		await refreshAnthropicToken("anthropic-refresh", controller.signal);
		await refreshGitHubCopilotToken("copilot-refresh", undefined, controller.signal);
		await refreshOpenAICodexToken("openai-refresh", controller.signal);
		expect(signals).toHaveLength(3);

		const cancellation = new Error("cancel built-in refreshes");
		controller.abort(cancellation);
		for (const signal of signals) {
			expect(signal.aborted).toBe(true);
			expect(signal.reason).toBe(cancellation);
		}
	});
});
