export type JsonlDecodeKind = "utf8" | "syntax" | "schema" | "state";

export type JsonlErrorPhase =
	| "create"
	| "append"
	| "fork"
	| "open"
	| "repair"
	| "migrate"
	| "list"
	| "import"
	| "replace"
	| "sync";

export type JsonlWriteOutcome = "not_written" | "unknown" | "published";

/** Path-independent JSONL decoding failure. Storage boundaries attach location and operation context. */
export class JsonlDecodeError extends Error {
	readonly decodeKind: JsonlDecodeKind;
	/** Compatibility alias for path-independent codec consumers. */
	readonly kind: JsonlDecodeKind;

	constructor(decodeKind: JsonlDecodeKind, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "JsonlDecodeError";
		this.decodeKind = decodeKind;
		this.kind = decodeKind;
	}
}

export type JsonlSessionErrorCode = "invalid_jsonl" | "storage" | "fenced";

export interface JsonlSessionErrorOptions {
	code: JsonlSessionErrorCode;
	reference: string;
	phase: JsonlErrorPhase;
	message: string;
	line?: number;
	byteOffset?: number;
	decodeKind?: JsonlDecodeKind;
	outcome?: JsonlWriteOutcome;
	cause?: Error;
}

/** Actionable local JSONL error with location, phase, decoding, and write-outcome context. */
export class JsonlSessionError extends Error {
	readonly code: JsonlSessionErrorCode;
	readonly reference: string;
	readonly path: string;
	readonly phase: JsonlErrorPhase;
	readonly line?: number;
	readonly byteOffset?: number;
	readonly decodeKind?: JsonlDecodeKind;
	readonly outcome?: JsonlWriteOutcome;

	constructor(options: JsonlSessionErrorOptions) {
		super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "JsonlSessionError";
		this.code = options.code;
		this.reference = options.reference;
		this.path = options.reference;
		this.phase = options.phase;
		this.line = options.line;
		this.byteOffset = options.byteOffset;
		this.decodeKind = options.decodeKind;
		this.outcome = options.outcome;
	}
}

export function createJsonlSessionDecodeError(
	reference: string,
	phase: JsonlErrorPhase,
	decodeKind: JsonlDecodeKind,
	message: string,
	line = 1,
	byteOffset = 0,
): JsonlSessionError {
	const cause = new JsonlDecodeError(decodeKind, message);
	return new JsonlSessionError({
		code: "invalid_jsonl",
		reference,
		phase,
		line,
		byteOffset,
		decodeKind,
		message,
		cause,
	});
}
