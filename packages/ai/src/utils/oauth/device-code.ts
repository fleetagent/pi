const CANCEL_MESSAGE = "Login cancelled";
const TIMEOUT_MESSAGE = "Device flow timed out";
const SLOW_DOWN_TIMEOUT_MESSAGE =
	"Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.";
const MINIMUM_INTERVAL_MS = 1000;
// RFC 8628 section 3.2: if the authorization server omits `interval`, the client must use 5 seconds.
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
// RFC 8628 section 3.5: `slow_down` means the polling interval must increase by 5 seconds.
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5000;

export type OAuthDeviceCodePollResult =
	| { status: "pending" }
	| { status: "slow_down"; intervalSeconds?: number }
	| { status: "complete"; accessToken: string }
	| { status: "failed"; message: string };

export type OAuthDeviceCodePollOptions = {
	intervalSeconds?: number;
	expiresInSeconds?: number;
	waitBeforeFirstPoll?: boolean;
	poll: () => Promise<OAuthDeviceCodePollResult>;
	signal?: AbortSignal;
};

function abortableSleep(ms: number, signal: AbortSignal | undefined, cancelMessage: string): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error(cancelMessage));
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error(cancelMessage));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

interface DeviceCodePollingState {
	deadline: number;
	intervalMs: number;
	slowDownResponses: number;
}

function createDeviceCodePollingState(options: OAuthDeviceCodePollOptions): DeviceCodePollingState {
	return {
		deadline:
			typeof options.expiresInSeconds === "number"
				? Date.now() + options.expiresInSeconds * 1000
				: Number.POSITIVE_INFINITY,
		intervalMs: Math.max(
			MINIMUM_INTERVAL_MS,
			Math.floor((options.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000),
		),
		slowDownResponses: 0,
	};
}

function resolveSlowDownInterval(intervalMs: number, serverIntervalSeconds: number | undefined): number {
	if (
		typeof serverIntervalSeconds === "number" &&
		Number.isFinite(serverIntervalSeconds) &&
		serverIntervalSeconds > 0
	) {
		return Math.max(MINIMUM_INTERVAL_MS, Math.floor(serverIntervalSeconds * 1000));
	}
	return Math.max(MINIMUM_INTERVAL_MS, intervalMs + SLOW_DOWN_INTERVAL_INCREMENT_MS);
}

function applyDeviceCodePollResult(
	state: DeviceCodePollingState,
	result: OAuthDeviceCodePollResult,
): string | undefined {
	if (result.status === "complete") return result.accessToken;
	if (result.status === "failed") throw new Error(result.message);
	if (result.status === "slow_down") {
		state.slowDownResponses += 1;
		// GitHub can report a new required minimum in `interval`; using it avoids
		// polling early forever under WSL/VM clock drift. Without it, apply RFC 8628.
		state.intervalMs = resolveSlowDownInterval(state.intervalMs, result.intervalSeconds);
	}
	return undefined;
}

async function waitForNextDeviceCodePoll(
	state: DeviceCodePollingState,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	const remainingMs = state.deadline - Date.now();
	if (remainingMs <= 0) return false;
	await abortableSleep(Math.min(state.intervalMs, remainingMs), signal, CANCEL_MESSAGE);
	return true;
}

async function waitBeforeInitialDeviceCodePoll(
	state: DeviceCodePollingState,
	options: OAuthDeviceCodePollOptions,
): Promise<void> {
	if (!options.waitBeforeFirstPoll) return;
	await waitForNextDeviceCodePoll(state, options.signal);
}

export async function pollOAuthDeviceCodeFlow(options: OAuthDeviceCodePollOptions): Promise<string> {
	const state = createDeviceCodePollingState(options);
	await waitBeforeInitialDeviceCodePoll(state, options);

	while (Date.now() < state.deadline) {
		if (options.signal?.aborted) throw new Error(CANCEL_MESSAGE);
		const accessToken = applyDeviceCodePollResult(state, await options.poll());
		if (accessToken !== undefined) return accessToken;
		if (!(await waitForNextDeviceCodePoll(state, options.signal))) break;
	}

	throw new Error(state.slowDownResponses > 0 ? SLOW_DOWN_TIMEOUT_MESSAGE : TIMEOUT_MESSAGE);
}
