export {
	applyEdits,
	buildIdx,
	changedRange,
	fmtBoundaryWarning,
	fmtRegion,
} from "./apply.ts";
export {
	_lineHashesPure,
	ANCHOR_LEN,
	DIFF_MINUS_RE,
	HASH_CLASS,
	HASH_LEN,
	HASH_SEP,
	HL_BARE_PREFIX_RE,
	HL_PREFIX_PLUS_RE,
	HL_PREFIX_RE,
	initHasher,
	lineHashes,
} from "./hash.ts";
export {
	type Anchor,
	parseHashRef,
	parseText,
} from "./parse.ts";
export {
	assertNoBarePrefix,
	type BDupWarn,
	descEdit,
	fmtMismatch,
	type HEdit,
	type HTEdit,
	type NEdit,
	type RAnchor,
	type RHEdit,
	resEdits,
	valEdits,
} from "./resolve.ts";
