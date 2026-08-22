import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials } from "@fleetagent/pi-ai";
import { registerOAuthProvider, unregisterOAuthProvider } from "@fleetagent/pi-ai/oauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";

describe("AuthStorage OAuth refresh timeout", () => {
	let tempDir: string | undefined;
	let providerId: string | undefined;

	afterEach(() => {
		if (providerId) unregisterOAuthProvider(providerId);
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		vi.restoreAllMocks();
	});

	it("releases the credential-file lock after a stalled refresh times out", async () => {
		tempDir = join(tmpdir(), `pi-oauth-timeout-${crypto.randomUUID()}`);
		mkdirSync(tempDir, { recursive: true });
		const authPath = join(tempDir, "auth.json");
		providerId = `stalled-${crypto.randomUUID()}`;
		writeFileSync(
			authPath,
			JSON.stringify({
				[providerId]: {
					type: "oauth",
					access: "expired-access",
					refresh: "refresh-token",
					expires: 0,
				},
			}),
		);

		const timeoutController = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		registerOAuthProvider({
			id: providerId,
			name: "Stalled OAuth",
			login: async () => {
				throw new Error("Not used");
			},
			refreshToken: async (_credentials, signal?: AbortSignal): Promise<OAuthCredentials> => {
				if (!signal) throw new Error("Expected a refresh signal");
				markStarted?.();
				return new Promise<OAuthCredentials>((_resolve, reject) => {
					const rejectAborted = () => reject(signal.reason);
					signal.addEventListener("abort", rejectAborted, { once: true });
					if (signal.aborted) rejectAborted();
				});
			},
			getApiKey: (credentials) => credentials.access,
		});

		const storage = AuthStorage.create(authPath);
		const resolution = storage.getApiKey(providerId);
		await started;
		expect(timeout).toHaveBeenCalledWith(15_000);
		timeoutController.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

		await expect(resolution).resolves.toBeUndefined();
		expect(storage.drainErrors().map((error) => error.message)).toContain(
			`OAuth token refresh timed out after 15000ms for ${providerId}`,
		);

		const secondStorage = AuthStorage.create(authPath);
		secondStorage.set("after-timeout", { type: "api_key", key: "available" });
		const persisted = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, { key?: string }>;
		expect(persisted["after-timeout"]?.key).toBe("available");
	});
});
