import type {
	HookAggregateResult,
	HookExecutionResult,
	HookInput,
	HookStructuredOutput,
	JsonObject,
	JsonValue,
} from "./types.ts";

export const MAX_MODEL_VISIBLE_HOOK_FIELD_CHARS = 10_000;

export function capModelVisibleHookField(value: string): string {
	return value.length <= MAX_MODEL_VISIBLE_HOOK_FIELD_CHARS
		? value
		: value.slice(0, MAX_MODEL_VISIBLE_HOOK_FIELD_CHARS);
}

function object(value: JsonValue | undefined): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function string(value: JsonValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}
function boolean(value: JsonValue | undefined): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}
function nonnegativeNumber(value: JsonValue | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
const permissionRank = { allow: 0, ask: 1, defer: 2, deny: 3 } as const;
type PermissionDecision = keyof typeof permissionRank;
type UnsupportedPermissionDecision = "ask" | "defer";
function permission(value: JsonValue | undefined): PermissionDecision | undefined {
	return value === "allow" || value === "ask" || value === "defer" || value === "deny" ? value : undefined;
}

function unsupportedPermissionReason(decision: UnsupportedPermissionDecision): string {
	return decision === "ask"
		? "Tool execution blocked: hook requested permission, but no permission engine is available"
		: "Tool execution blocked: hook deferred permission, but no permission engine is available";
}
function acceptsCommonControl(input: HookInput): boolean {
	return input.hook_event_name !== "SessionEnd";
}
function capped(value: string | undefined): string | undefined {
	return value === undefined ? undefined : capModelVisibleHookField(value);
}

function applyBlockingResult(
	input: HookInput,
	result: HookExecutionResult,
	aggregate: HookAggregateResult,
): PermissionDecision | undefined {
	if (!result.blocking) return undefined;
	aggregate.blocked = true;
	aggregate.reason ??= capped(result.blockingReason);
	return input.hook_event_name === "PreToolUse" ? "deny" : undefined;
}

function appendPlainTextOutput(
	input: HookInput,
	text: string,
	malformedJson: boolean,
	aggregate: HookAggregateResult,
): void {
	if (malformedJson) return;
	if (input.hook_event_name !== "SessionStart" && input.hook_event_name !== "UserPromptSubmit") return;
	const visibleText = capModelVisibleHookField(text);
	aggregate.plainText.push(visibleText);
	aggregate.additionalContext.push(visibleText);
}

function applyCommonJsonOutput(input: HookInput, output: HookStructuredOutput, aggregate: HookAggregateResult): void {
	if (acceptsCommonControl(input) && output.continue === false) {
		aggregate.continue = false;
		aggregate.reason ??= capped(output.stopReason);
	}
	if (typeof output.systemMessage === "string") aggregate.systemMessages.push(output.systemMessage);
}

function resolveSpecificOutput(
	input: HookInput,
	result: HookExecutionResult,
	output: HookStructuredOutput,
): JsonObject | undefined {
	const specific = object(output.hookSpecificOutput);
	if (!specific || specific.hookEventName === input.hook_event_name) return specific;
	result.diagnostic ??= {
		level: "warning",
		code: "malformed-output",
		message: `hookSpecificOutput.hookEventName must match ${input.hook_event_name}; fields were ignored`,
		source: result.hook.source,
		event: input.hook_event_name,
	};
	return undefined;
}

function acceptsAdditionalContext(input: HookInput): boolean {
	switch (input.hook_event_name) {
		case "StopFailure":
		case "PreCompact":
		case "PostCompact":
		case "SessionEnd":
			return false;
		default:
			return true;
	}
}

function getAdditionalContext(input: HookInput, specific: JsonObject | undefined): string | undefined {
	const context = capped(string(specific?.additionalContext));
	return context !== undefined && acceptsAdditionalContext(input) ? context : undefined;
}

function applyDecisionBlock(output: HookStructuredOutput, aggregate: HookAggregateResult): void {
	if (output.decision !== "block") return;
	aggregate.blocked = true;
	aggregate.reason ??= capped(output.reason);
}

function applySessionStartOutput(specific: JsonObject | undefined, aggregate: HookAggregateResult): void {
	aggregate.sessionTitle = string(specific?.sessionTitle) ?? aggregate.sessionTitle;
	aggregate.initialUserMessage = capped(string(specific?.initialUserMessage)) ?? aggregate.initialUserMessage;
	aggregate.reloadSkills = boolean(specific?.reloadSkills) ?? aggregate.reloadSkills;
}

function applyUserPromptSubmitOutput(
	output: HookStructuredOutput,
	specific: JsonObject | undefined,
	aggregate: HookAggregateResult,
): void {
	aggregate.sessionTitle = string(specific?.sessionTitle) ?? aggregate.sessionTitle;
	applyDecisionBlock(output, aggregate);
}

function selectMoreRestrictivePermission(
	current: PermissionDecision | undefined,
	next: PermissionDecision | undefined,
): PermissionDecision | undefined {
	if (next === undefined) return current;
	if (current === undefined || permissionRank[next] > permissionRank[current]) return next;
	return current;
}

function applyPreToolUseOutput(
	input: HookInput,
	result: HookExecutionResult,
	specific: JsonObject | undefined,
	aggregate: HookAggregateResult,
	bestPermission: PermissionDecision | undefined,
): PermissionDecision | undefined {
	const next = permission(specific?.permissionDecision);
	const selectedPermission = selectMoreRestrictivePermission(bestPermission, next);
	if (next === "ask" || next === "defer") {
		result.diagnostic ??= {
			level: "error",
			code: "policy",
			message: `${unsupportedPermissionReason(next)} (permissionDecision: ${next})`,
			source: result.hook.source,
			event: input.hook_event_name,
		};
	}
	const updated = object(specific?.updatedInput);
	if (updated !== undefined) aggregate.updatedInput = updated;
	if (next === "deny") {
		aggregate.blocked = true;
		aggregate.reason ??= capped(string(specific?.permissionDecisionReason));
	}
	return selectedPermission;
}

function applyPostToolUseOutput(
	input: HookInput,
	result: HookExecutionResult,
	output: HookStructuredOutput,
	specific: JsonObject | undefined,
	aggregate: HookAggregateResult,
): void {
	applyDecisionBlock(output, aggregate);
	if (specific?.updatedToolOutput !== undefined) {
		aggregate.updatedToolOutput = specific.updatedToolOutput;
		return;
	}
	if (specific?.updatedMCPToolOutput === undefined) return;
	if (input.hook_event_name === "PostToolUse" && input.tool_name.startsWith("mcp__")) {
		aggregate.updatedToolOutput = specific.updatedMCPToolOutput;
		return;
	}
	result.diagnostic ??= {
		level: "warning",
		code: "unsupported-update",
		message: "updatedMCPToolOutput is only supported for mcp__ tools; original output was retained",
		source: result.hook.source,
		event: input.hook_event_name,
	};
}

function applyStopOutput(
	output: HookStructuredOutput,
	specific: JsonObject | undefined,
	context: string | undefined,
	aggregate: HookAggregateResult,
): void {
	if (output.decision !== "block" && context === undefined) return;
	aggregate.blocked = true;
	aggregate.reason ??= capped(output.reason) ?? context;
	const progress = nonnegativeNumber(specific?.continuationProgress);
	if (progress !== undefined) {
		aggregate.stopContinuationProgress = (aggregate.stopContinuationProgress ?? 0) + progress;
	}
}

function applyEventSpecificOutput(
	input: HookInput,
	result: HookExecutionResult,
	output: HookStructuredOutput,
	specific: JsonObject | undefined,
	context: string | undefined,
	aggregate: HookAggregateResult,
	bestPermission: PermissionDecision | undefined,
): PermissionDecision | undefined {
	switch (input.hook_event_name) {
		case "SessionStart":
			applySessionStartOutput(specific, aggregate);
			break;
		case "UserPromptSubmit":
			applyUserPromptSubmitOutput(output, specific, aggregate);
			break;
		case "PreToolUse":
			return applyPreToolUseOutput(input, result, specific, aggregate, bestPermission);
		case "PostToolUse":
			applyPostToolUseOutput(input, result, output, specific, aggregate);
			break;
		case "PostToolUseFailure":
		case "PreCompact":
			applyDecisionBlock(output, aggregate);
			break;
		case "Stop":
			applyStopOutput(output, specific, context, aggregate);
			break;
		case "StopFailure":
		case "PostCompact":
		case "SessionEnd":
			break;
	}
	return bestPermission;
}

function finalizePermission(aggregate: HookAggregateResult, bestPermission: PermissionDecision | undefined): void {
	aggregate.permissionDecision = bestPermission;
	if (bestPermission !== "ask" && bestPermission !== "defer") return;
	aggregate.blocked = true;
	aggregate.reason = unsupportedPermissionReason(bestPermission);
}

export function aggregateHookResults(input: HookInput, results: HookExecutionResult[]): HookAggregateResult {
	const aggregate: HookAggregateResult = {
		continue: true,
		blocked: false,
		additionalContext: [],
		systemMessages: [],
		plainText: [],
		results,
	};
	let bestPermission: PermissionDecision | undefined;
	for (const result of results.sort((left, right) => left.hook.order - right.hook.order)) {
		if (result.status !== "completed") continue;
		bestPermission = selectMoreRestrictivePermission(bestPermission, applyBlockingResult(input, result, aggregate));
		if (result.exitCode !== 0) continue;
		if (result.output.kind === "text") {
			appendPlainTextOutput(input, result.output.text, result.output.malformedJson, aggregate);
			continue;
		}
		if (result.output.kind !== "json") continue;
		const output = result.output.value;
		applyCommonJsonOutput(input, output, aggregate);
		const specific = resolveSpecificOutput(input, result, output);
		const context = getAdditionalContext(input, specific);
		if (context !== undefined) aggregate.additionalContext.push(context);
		bestPermission = applyEventSpecificOutput(input, result, output, specific, context, aggregate, bestPermission);
	}
	finalizePermission(aggregate, bestPermission);
	return aggregate;
}
