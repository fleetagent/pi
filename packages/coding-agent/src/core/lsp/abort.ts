function abortReason(signal: AbortSignal): unknown {
	if (signal.reason !== undefined) return signal.reason;
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	return error;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw abortReason(signal);
}

export async function waitForAbort<T>(operation: PromiseLike<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return operation;
	throwIfAborted(signal);
	let onAbort!: () => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(abortReason(signal));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([operation, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
