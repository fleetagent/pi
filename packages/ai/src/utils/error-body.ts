// Shared normalization for provider HTTP error objects.

export const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;

export interface NormalizedProviderError {
	status?: number;
	body?: string;
	message: string;
	messageCarriesBody: boolean;
}

type SdkErrorShape = Error & {
	statusCode?: unknown;
	status?: unknown;
	body?: unknown;
	error?: unknown;
	$metadata?: { httpStatusCode?: unknown };
	$response?: { statusCode?: unknown; body?: unknown };
};

export function normalizeProviderError(error: unknown): NormalizedProviderError {
	if (!(error instanceof Error)) {
		return { message: safeJsonStringify(error), messageCarriesBody: false };
	}

	const sdkError = error as SdkErrorShape;
	const status = extractStatus(sdkError);
	const body = extractBody(sdkError);
	const messageCarriesBody = body === undefined || error.message.includes(body);

	return { status, body, message: error.message, messageCarriesBody };
}

function extractStatus(error: SdkErrorShape): number | undefined {
	if (typeof error.statusCode === "number") return error.statusCode;
	if (typeof error.status === "number") return error.status;
	if (typeof error.$metadata?.httpStatusCode === "number") return error.$metadata.httpStatusCode;
	if (typeof error.$response?.statusCode === "number") return error.$response.statusCode;
	return undefined;
}

function extractBody(error: SdkErrorShape): string | undefined {
	const bodyText = pickBodyText(error);
	if (bodyText === undefined) return undefined;
	const trimmed = bodyText.trim();
	if (trimmed.length === 0) return undefined;
	return truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS);
}

function pickBodyText(error: SdkErrorShape): string | undefined {
	if (typeof error.body === "string") return error.body;
	if (isPlainNonEmptyObject(error.error)) return safeJsonStringify(error.error);
	const responseBody = error.$response?.body;
	if (typeof responseBody === "string") return responseBody;
	if (isPlainNonEmptyObject(responseBody)) return safeJsonStringify(responseBody);
	return undefined;
}

/**
 * SDK error fields can contain response/stream wrapper instances rather than
 * parsed response bodies. Serializing those wrappers replaces the useful SDK
 * validation message with transport internals. Parsed JSON objects have an
 * Object or null prototype, so only those are treated as bodies.
 */
function isPlainNonEmptyObject(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	return Object.keys(value).length > 0;
}

export function formatProviderError(norm: NormalizedProviderError, prefix?: string): string {
	if (norm.messageCarriesBody || norm.status === undefined || norm.body === undefined) {
		return prefix !== undefined && norm.status !== undefined
			? `${prefix} (${norm.status}): ${norm.message}`
			: norm.message;
	}
	return prefix !== undefined ? `${prefix} (${norm.status}): ${norm.body}` : `${norm.status}: ${norm.body}`;
}

export function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

export function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}
