import type { ProviderHeaders } from "../types.ts";

export function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
}

/** Resolve case-insensitive deletion markers for transports that only accept concrete string values. */
export function providerHeadersToRecord(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const result: Record<string, string> = {};
	const keyByLowercaseName = new Map<string, string>();
	for (const [key, value] of Object.entries(headers)) {
		const lowercaseName = key.toLowerCase();
		const previousKey = keyByLowercaseName.get(lowercaseName);
		if (previousKey !== undefined) delete result[previousKey];
		if (value === null) {
			keyByLowercaseName.delete(lowercaseName);
		} else {
			result[key] = value;
			keyByLowercaseName.set(lowercaseName, key);
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}
