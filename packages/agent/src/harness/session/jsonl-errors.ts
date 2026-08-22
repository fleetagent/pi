import { SessionError, type SessionErrorCode } from "../types.ts";

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

export interface JsonlSessionErrorOptions {
	code: SessionErrorCode;
	reference: string;
	phase: JsonlErrorPhase;
	message: string;
	line?: number;
	byteOffset?: number;
	decodeKind?: JsonlDecodeKind;
	outcome?: JsonlWriteOutcome;
	cause?: Error;
}

/** SessionError with actionable JSONL location, phase, decoding, and write-outcome context. */
export class JsonlSessionError extends SessionError {
	readonly reference: string;
	readonly path: string;
	readonly phase: JsonlErrorPhase;
	readonly line?: number;
	readonly byteOffset?: number;
	readonly decodeKind?: JsonlDecodeKind;
	readonly outcome?: JsonlWriteOutcome;

	constructor(options: JsonlSessionErrorOptions) {
		super(options.code, options.message, options.cause);
		this.name = "JsonlSessionError";
		this.reference = options.reference;
		this.path = options.reference;
		this.phase = options.phase;
		this.line = options.line;
		this.byteOffset = options.byteOffset;
		this.decodeKind = options.decodeKind;
		this.outcome = options.outcome;
	}
}
