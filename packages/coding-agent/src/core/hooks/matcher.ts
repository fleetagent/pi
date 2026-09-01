import type { HookInput } from "./types.ts";

const EXACT_MATCHER = /^[A-Za-z0-9_\- ,|]+$/;

export interface MatcherResult {
	matches: boolean;
	error?: string;
}

export function matchHookValue(matcher: string | undefined, value: string): MatcherResult {
	if (matcher === undefined || matcher === "" || matcher === "*") return { matches: true };
	if (EXACT_MATCHER.test(matcher)) {
		return { matches: matcher.split(/[|,]/).some((alternative) => alternative.trim() === value) };
	}
	try {
		return { matches: new RegExp(matcher).test(value) };
	} catch (error) {
		return { matches: false, error: `Invalid hook matcher ${JSON.stringify(matcher)}: ${String(error)}` };
	}
}

export function hookMatcherValue(input: HookInput): string | undefined {
	switch (input.hook_event_name) {
		case "SessionStart":
			return input.source;
		case "PreToolUse":
		case "PostToolUse":
		case "PostToolUseFailure":
			return input.tool_name;
		case "StopFailure":
			return input.error;
		case "PreCompact":
		case "PostCompact":
			return input.trigger;
		case "SessionEnd":
			return input.reason;
		case "UserPromptSubmit":
		case "Stop":
			return undefined;
	}
}

export function matchesHookInput(matcher: string | undefined, input: HookInput): MatcherResult {
	const value = hookMatcherValue(input);
	// Claude ignores matcher fields on events without matcher support.
	return value === undefined ? { matches: true } : matchHookValue(matcher, value);
}

export function matchesHookIf(pattern: string | undefined, input: HookInput): MatcherResult {
	if (pattern === undefined) return { matches: true };
	if (
		input.hook_event_name !== "PreToolUse" &&
		input.hook_event_name !== "PostToolUse" &&
		input.hook_event_name !== "PostToolUseFailure"
	) {
		return { matches: false };
	}
	const open = pattern.indexOf("(");
	if (open < 1 || !pattern.endsWith(")")) return matchHookValue(pattern, input.tool_name);
	if (pattern.slice(0, open) !== input.tool_name) return { matches: false };
	const argumentPattern = pattern.slice(open + 1, -1);
	const candidate =
		typeof input.tool_input.command === "string"
			? input.tool_input.command
			: typeof input.tool_input.file_path === "string"
				? input.tool_input.file_path
				: JSON.stringify(input.tool_input);
	if (argumentPattern === "*") return { matches: true };
	// Permission-rule globs are intentionally limited here to their common '*' form.
	const escaped = argumentPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
	try {
		return { matches: new RegExp(`^${escaped}$`).test(candidate) };
	} catch (error) {
		return { matches: false, error: `Invalid hook if condition ${JSON.stringify(pattern)}: ${String(error)}` };
	}
}
