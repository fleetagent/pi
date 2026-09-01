/**
 * Anthropic OAuth flow (Claude Pro/Max)
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

import type { createServer as createHttpServer, Server, ServerResponse } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";
import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
	OAuthManualCodeInput,
	OAuthProviderInterface,
	ParsedOAuthAuthorizationInput,
} from "./types.ts";

// pi-ignore noNearIdenticalDataStructures: Browser callback values are state-validated and required; manually parsed OAuth input remains partial and untrusted.
interface AuthorizationCallbackResult {
	code: string;
	state: string;
}

type CallbackServerInfo = {
	server: Server;
	redirectUri: string;
	cancelWait: () => void;
	waitForCode: () => Promise<AuthorizationCallbackResult | null>;
};

export type AnthropicLoginOptions = Pick<
	OAuthLoginCallbacks,
	"onAuth" | "onPrompt" | "onProgress" | "onManualCodeInput"
>;

type NodeApis = {
	createServer: typeof createHttpServer;
};

let nodeApis: NodeApis | null = null;
let nodeApisPromise: Promise<NodeApis> | null = null;

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
async function getNodeApis(): Promise<NodeApis> {
	if (nodeApis) return nodeApis;
	if (!nodeApisPromise) {
		if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
			throw new Error("Anthropic OAuth is only available in Node.js environments");
		}
		nodeApisPromise = import("node:http").then((httpModule) => ({
			createServer: httpModule.createServer,
		}));
	}
	nodeApis = await nodeApisPromise;
	return nodeApis;
}

function parseAuthorizationInput(input: string): ParsedOAuthAuthorizationInput {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

function formatErrorDetails(error: unknown): string {
	if (error instanceof Error) {
		const details: string[] = [`${error.name}: ${error.message}`];
		const errorWithCode = error as Error & { code?: string; errno?: number | string; cause?: unknown };
		if (errorWithCode.code) details.push(`code=${errorWithCode.code}`);
		if (typeof errorWithCode.errno !== "undefined") details.push(`errno=${String(errorWithCode.errno)}`);
		if (typeof error.cause !== "undefined") {
			details.push(`cause=${formatErrorDetails(error.cause)}`);
		}
		if (error.stack) {
			details.push(`stack=${error.stack}`);
		}
		return details.join("; ");
	}
	return String(error);
}

type AuthorizationCallbackSettler = (value: AuthorizationCallbackResult | null) => void;

function handleAuthorizationCallbackRequest(
	requestUrl: string | undefined,
	response: ServerResponse,
	expectedState: string,
	settleWait: AuthorizationCallbackSettler | undefined,
): void {
	const url = new URL(requestUrl || "", "http://localhost");
	if (url.pathname !== CALLBACK_PATH) {
		response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
		response.end(oauthErrorHtml("Callback route not found."));
		return;
	}
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	const error = url.searchParams.get("error");
	if (error) {
		response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
		response.end(oauthErrorHtml("Anthropic authentication did not complete.", `Error: ${error}`));
		return;
	}
	if (!code || !state) {
		response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
		response.end(oauthErrorHtml("Missing code or state parameter."));
		return;
	}
	if (state !== expectedState) {
		response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
		response.end(oauthErrorHtml("State mismatch."));
		return;
	}
	response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	response.end(oauthSuccessHtml("Anthropic authentication completed. You can close this window."));
	settleWait?.({ code, state });
}

async function startCallbackServer(expectedState: string): Promise<CallbackServerInfo> {
	const { createServer } = await getNodeApis();

	return new Promise((resolve, reject) => {
		let settleWait: AuthorizationCallbackSettler | undefined;
		const waitForCodePromise = new Promise<AuthorizationCallbackResult | null>((resolveWait) => {
			let settled = false;
			settleWait = (value) => {
				if (settled) return;
				settled = true;
				resolveWait(value);
			};
		});

		const server = createServer((req, res) => {
			try {
				handleAuthorizationCallbackRequest(req.url, res, expectedState, settleWait);
			} catch {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Internal error");
			}
		});

		server.on("error", (err) => {
			reject(err);
		});

		server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
			resolve({
				server,
				redirectUri: REDIRECT_URI,
				cancelWait: () => {
					settleWait?.(null);
				},
				waitForCode: () => waitForCodePromise,
			});
		});
	});
}

async function postJson(url: string, body: Record<string, string | number>, signal?: AbortSignal): Promise<string> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(body),
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
	});

	const responseBody = await response.text();

	if (!response.ok) {
		throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`);
	}

	return responseBody;
}

async function exchangeAuthorizationCode(
	code: string,
	state: string,
	verifier: string,
	redirectUri: string,
): Promise<OAuthCredentials> {
	let responseBody: string;
	try {
		responseBody = await postJson(TOKEN_URL, {
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			state,
			redirect_uri: redirectUri,
			code_verifier: verifier,
		});
	} catch (error) {
		throw new Error(
			`Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`,
		);
	}

	let tokenData: { access_token: string; refresh_token: string; expires_in: number };
	try {
		tokenData = JSON.parse(responseBody) as { access_token: string; refresh_token: string; expires_in: number };
	} catch (error) {
		throw new Error(
			`Token exchange returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}

	return {
		refresh: tokenData.refresh_token,
		access: tokenData.access_token,
		expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
	};
}

// pi-ignore noNearIdenticalDataStructures: Authorization selection is state-validated and may be empty before prompt fallback; parsed OAuth input remains partial and untrusted.
interface AuthorizationSelection {
	code?: string;
	state?: string;
}

function createAnthropicAuthorizationUrl(challenge: string, state: string): string {
	const params = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
	});
	return `${AUTHORIZE_URL}?${params.toString()}`;
}

function parseVerifiedAuthorizationInput(input: string, expectedState: string): AuthorizationSelection {
	const parsed = parseAuthorizationInput(input);
	if (parsed.state && parsed.state !== expectedState) throw new Error("OAuth state mismatch");
	return { code: parsed.code, state: parsed.state ?? expectedState };
}

async function waitForCallbackOrManualAuthorization(
	server: CallbackServerInfo,
	onManualCodeInput: OAuthManualCodeInput,
	expectedState: string,
): Promise<AuthorizationSelection> {
	let manualInput: string | undefined;
	let manualError: Error | undefined;
	const manualPromise = onManualCodeInput()
		.then((input) => {
			manualInput = input;
			server.cancelWait();
		})
		.catch((error) => {
			manualError = error instanceof Error ? error : new Error(String(error));
			server.cancelWait();
		});

	const callbackResult = await server.waitForCode();
	if (manualError) throw manualError;
	if (callbackResult?.code) return callbackResult;
	if (manualInput) return parseVerifiedAuthorizationInput(manualInput, expectedState);

	await manualPromise;
	if (manualError) throw manualError;
	return manualInput ? parseVerifiedAuthorizationInput(manualInput, expectedState) : {};
}

async function waitForAnthropicAuthorization(
	server: CallbackServerInfo,
	options: AnthropicLoginOptions,
	expectedState: string,
): Promise<AuthorizationSelection> {
	if (options.onManualCodeInput) {
		return waitForCallbackOrManualAuthorization(server, options.onManualCodeInput, expectedState);
	}
	const callbackResult = await server.waitForCode();
	return callbackResult?.code ? callbackResult : {};
}

async function promptForAnthropicAuthorization(
	options: AnthropicLoginOptions,
	expectedState: string,
): Promise<AuthorizationSelection> {
	const input = await options.onPrompt({
		message: "Paste the authorization code or full redirect URL:",
		placeholder: REDIRECT_URI,
	});
	return parseVerifiedAuthorizationInput(input, expectedState);
}

/**
 * Login with Anthropic OAuth (authorization code + PKCE)
 */
export async function loginAnthropic(options: AnthropicLoginOptions): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();
	const server = await startCallbackServer(verifier);

	try {
		options.onAuth({
			url: createAnthropicAuthorizationUrl(challenge, verifier),
			instructions:
				"Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		let authorization = await waitForAnthropicAuthorization(server, options, verifier);
		if (!authorization.code) authorization = await promptForAnthropicAuthorization(options, verifier);
		if (!authorization.code) throw new Error("Missing authorization code");
		if (!authorization.state) throw new Error("Missing OAuth state");

		options.onProgress?.("Exchanging authorization code for tokens...");
		return exchangeAuthorizationCode(authorization.code, authorization.state, verifier, REDIRECT_URI);
	} finally {
		server.server.close();
	}
}

/**
 * Refresh Anthropic OAuth token
 */
export async function refreshAnthropicToken(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredentials> {
	let responseBody: string;
	try {
		responseBody = await postJson(
			TOKEN_URL,
			{
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: refreshToken,
			},
			signal,
		);
	} catch (error) {
		throw new Error(`Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatErrorDetails(error)}`);
	}

	let data: { access_token: string; refresh_token: string; expires_in: number; scope?: string };
	try {
		data = JSON.parse(responseBody) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
			scope?: string;
		};
	} catch (error) {
		throw new Error(
			`Anthropic token refresh returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}

	return {
		refresh: data.refresh_token,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
}

export const anthropicOAuthProvider: OAuthProviderInterface = {
	id: "anthropic",
	name: "Anthropic (Claude Pro/Max)",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginAnthropic({
			onAuth: callbacks.onAuth,
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			onManualCodeInput: callbacks.onManualCodeInput,
		});
	},

	async refreshToken(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials> {
		return refreshAnthropicToken(credentials.refresh, signal);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
