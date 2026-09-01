// biome-ignore-all lint/performance/noBarrelFile: This is the public hooks subpath entry point.
export {
	aggregateHookResults,
	capModelVisibleHookField,
	MAX_MODEL_VISIBLE_HOOK_FIELD_CHARS,
} from "./aggregate.ts";
export { freezeLoadedHooks, hookSettingsSources, type LoadHooksOptions, loadHooks } from "./config.ts";
export {
	classifyHookOutput,
	DEFAULT_HOOK_TIMEOUT_SECONDS,
	DEFAULT_MAX_HOOK_OUTPUT_BYTES,
	DEFAULT_SESSION_END_HOOK_TIMEOUT_SECONDS,
	DEFAULT_USER_PROMPT_HOOK_TIMEOUT_SECONDS,
	defaultHookTimeoutSeconds,
	executeHook,
	executeMatchingHooks,
	sanitizedHookEnvironment,
} from "./executor.ts";
export { hookMatcherValue, type MatcherResult, matchesHookIf, matchesHookInput, matchHookValue } from "./matcher.ts";
export {
	canonicalProjectHookCwd,
	canonicalProjectHookIdentity,
	hasProjectHookConfiguration,
	PROJECT_HOOK_TRUST_STORE_FILENAME,
	PROJECT_HOOK_TRUST_STORE_VERSION,
	type ProjectHookTrustResult,
	ProjectHookTrustStore,
} from "./trust-store.ts";
export * from "./types.ts";

import { aggregateHookResults } from "./aggregate.ts";
import { executeMatchingHooks } from "./executor.ts";
import type { HookAggregateResult, HookInput, HookRunOptions, LoadedHooks } from "./types.ts";

export async function runHooks(
	loaded: LoadedHooks,
	input: HookInput,
	options: HookRunOptions = {},
): Promise<HookAggregateResult> {
	const results = await executeMatchingHooks(loaded.handlers, input, options);
	return aggregateHookResults(input, results);
}
