import { afterEach, describe, expect, it, vi } from "vitest";
import { loginGitHubCopilot } from "../src/utils/oauth/github-copilot.ts";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	if (input instanceof Request) {
		return input.url;
	}
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

interface SlowDownOAuthTestState {
	accessTokenPollTimes: number[];
	accessTokenResponses: Response[];
}

function handleSlowDownDeviceCodeRequest(init: RequestInit | undefined): Response {
	expect(init?.method).toBe("POST");
	expect(init?.headers).toMatchObject({
		Accept: "application/json",
		"Content-Type": "application/x-www-form-urlencoded",
	});
	expect(String(init?.body)).toContain("client_id=");
	expect(String(init?.body)).toContain("scope=read%3Auser");
	return jsonResponse({
		device_code: "device-code",
		user_code: "ABCD-EFGH",
		verification_uri: "https://github.com/login/device",
		interval: 5,
		expires_in: 900,
	});
}

function handleSlowDownAccessTokenRequest(init: RequestInit | undefined, state: SlowDownOAuthTestState): Response {
	state.accessTokenPollTimes.push(Date.now());
	expect(init?.method).toBe("POST");
	expect(init?.headers).toMatchObject({
		Accept: "application/json",
		"Content-Type": "application/x-www-form-urlencoded",
	});
	expect(String(init?.body)).toContain("client_id=");
	expect(String(init?.body)).toContain("device_code=device-code");
	expect(String(init?.body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
	const response = state.accessTokenResponses.shift();
	if (!response) throw new Error("Unexpected extra access token poll");
	return response;
}

async function handleSlowDownOAuthRequest(
	input: unknown,
	init: RequestInit | undefined,
	state: SlowDownOAuthTestState,
): Promise<Response> {
	const url = getUrl(input);
	if (url.endsWith("/login/device/code")) return handleSlowDownDeviceCodeRequest(init);
	if (url.endsWith("/login/oauth/access_token")) return handleSlowDownAccessTokenRequest(init, state);
	if (url.includes("/copilot_internal/v2/token")) {
		return jsonResponse({
			token: "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;",
			expires_at: 9999999999,
		});
	}
	if (url.includes("/models/") && url.endsWith("/policy")) return new Response("", { status: 200 });
	throw new Error(`Unexpected fetch URL: ${url}`);
}

describe("GitHub Copilot OAuth device flow", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("reports device-code details through onDeviceCode", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-09T00:00:00Z"));

		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);

			if (url.endsWith("/login/device/code")) {
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://github.com/login/device",
					interval: 1,
					expires_in: 900,
				});
			}

			if (url.endsWith("/login/oauth/access_token")) {
				return jsonResponse({ access_token: "ghu_refresh_token" });
			}

			if (url.includes("/copilot_internal/v2/token")) {
				return jsonResponse({
					token: "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;",
					expires_at: 9999999999,
				});
			}

			if (url.includes("/models/") && url.endsWith("/policy")) {
				return new Response("", { status: 200 });
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const onDeviceCode = vi.fn();
		const loginPromise = loginGitHubCopilot({
			onDeviceCode,
			onPrompt: async () => "",
		});

		await vi.advanceTimersByTimeAsync(0);

		expect(onDeviceCode).toHaveBeenCalledWith({
			userCode: "ABCD-EFGH",
			verificationUri: "https://github.com/login/device",
			intervalSeconds: 1,
			expiresInSeconds: 900,
		});
		await vi.advanceTimersByTimeAsync(1000);
		await loginPromise;
	});

	it.each(["$(id>/tmp/pwned)", "javascript:alert(1)", "file:///tmp/pwned"])(
		"rejects unsafe verification_uri %s before it reaches onDeviceCode",
		async (verificationUri) => {
			const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);
				if (url.endsWith("/login/device/code")) {
					return jsonResponse({
						device_code: "device-code",
						user_code: "ABCD-EFGH",
						verification_uri: verificationUri,
						interval: 1,
						expires_in: 900,
					});
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			});

			vi.stubGlobal("fetch", fetchMock);

			const onDeviceCode = vi.fn();
			await expect(
				loginGitHubCopilot({
					onDeviceCode,
					onPrompt: async () => "",
				}),
			).rejects.toThrow(/Untrusted verification_uri/);
			expect(onDeviceCode).not.toHaveBeenCalled();
		},
	);

	it("normalizes verification_uri before it reaches onDeviceCode", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-09T00:00:00Z"));

		const rawVerificationUri = "https://github.com/login/\x1b]8;;evil";
		const normalizedVerificationUri = new URL(rawVerificationUri).href;
		expect(normalizedVerificationUri).not.toBe(rawVerificationUri);

		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);

			if (url.endsWith("/login/device/code")) {
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: rawVerificationUri,
					interval: 1,
					expires_in: 900,
				});
			}

			if (url.endsWith("/login/oauth/access_token")) {
				return jsonResponse({ access_token: "ghu_refresh_token" });
			}

			if (url.includes("/copilot_internal/v2/token")) {
				return jsonResponse({
					token: "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;",
					expires_at: 9999999999,
				});
			}

			if (url.includes("/models/") && url.endsWith("/policy")) {
				return new Response("", { status: 200 });
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const onDeviceCode = vi.fn();
		const loginPromise = loginGitHubCopilot({
			onDeviceCode,
			onPrompt: async () => "",
		});

		await vi.advanceTimersByTimeAsync(0);

		expect(onDeviceCode).toHaveBeenCalledWith({
			userCode: "ABCD-EFGH",
			verificationUri: normalizedVerificationUri,
			intervalSeconds: 1,
			expiresInSeconds: 900,
		});
		expect(onDeviceCode).not.toHaveBeenCalledWith(expect.objectContaining({ verificationUri: rawVerificationUri }));

		await vi.advanceTimersByTimeAsync(1000);
		await loginPromise;
	});

	it("waits before the first poll and increases the interval after slow_down", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-03-09T00:00:00Z");
		vi.setSystemTime(startTime);

		const accessTokenPollTimes: number[] = [];
		const accessTokenResponses = [
			jsonResponse({ error: "authorization_pending", error_description: "pending" }),
			jsonResponse({ error: "slow_down", error_description: "slow down" }),
			jsonResponse({ access_token: "ghu_refresh_token" }),
		];

		const state: SlowDownOAuthTestState = { accessTokenPollTimes, accessTokenResponses };
		const fetchMock = vi.fn((input: unknown, init?: RequestInit) => handleSlowDownOAuthRequest(input, init, state));

		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginGitHubCopilot({
			onDeviceCode: () => {},
			onPrompt: async () => "",
			onProgress: () => {},
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(accessTokenPollTimes).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(4999);
		expect(accessTokenPollTimes).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(1);
		expect(accessTokenPollTimes).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(4999);
		expect(accessTokenPollTimes).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(accessTokenPollTimes).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(9999);
		expect(accessTokenPollTimes).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(1);
		await loginPromise;

		expect(accessTokenPollTimes).toEqual([
			startTime.getTime() + 5000,
			startTime.getTime() + 10000,
			startTime.getTime() + 20000,
		]);
	});

	it("uses the remaining lifetime for a final poll before timing out after repeated slow_down responses", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-03-09T00:00:00Z");
		vi.setSystemTime(startTime);

		const accessTokenPollTimes: number[] = [];
		const accessTokenResponses = [
			jsonResponse({ error: "slow_down", error_description: "slow down" }),
			jsonResponse({ error: "slow_down", error_description: "still too fast" }),
			jsonResponse({ error: "authorization_pending", error_description: "pending" }),
		];

		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);

			if (url.endsWith("/login/device/code")) {
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://github.com/login/device",
					interval: 5,
					expires_in: 25,
				});
			}

			if (url.endsWith("/login/oauth/access_token")) {
				accessTokenPollTimes.push(Date.now());
				const response = accessTokenResponses.shift();
				if (!response) {
					throw new Error("Unexpected extra access token poll");
				}
				return response;
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginGitHubCopilot({
			onDeviceCode: () => {},
			onPrompt: async () => "",
		});
		const rejection = expect(loginPromise).rejects.toThrow(
			/Device flow timed out after one or more slow_down responses/,
		);

		await vi.advanceTimersByTimeAsync(5000);
		expect(accessTokenPollTimes).toEqual([startTime.getTime() + 5000]);

		await vi.advanceTimersByTimeAsync(10000);
		expect(accessTokenPollTimes).toEqual([startTime.getTime() + 5000, startTime.getTime() + 15000]);

		await vi.advanceTimersByTimeAsync(9999);
		expect(accessTokenPollTimes).toEqual([startTime.getTime() + 5000, startTime.getTime() + 15000]);

		await vi.advanceTimersByTimeAsync(1);
		await rejection;

		expect(accessTokenPollTimes).toEqual([startTime.getTime() + 5000, startTime.getTime() + 15000]);
	});
});
