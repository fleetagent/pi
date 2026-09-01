/**
 * Model resolution, scoping, and initial selection
 */

import type { ThinkingLevel } from "@fleetagent/pi-agent-core";
import type { Api, KnownProvider, Model } from "@fleetagent/pi-ai";
import chalk from "chalk";
import { minimatch } from "minimatch";
import { isValidThinkingLevel } from "../cli/args.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ModelRegistry } from "./model-registry.ts";

/** Default model IDs for each known provider */
export const defaultModelPerProvider: Record<KnownProvider, string> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	anthropic: "claude-opus-4-7",
	openai: "gpt-5.4",
	"azure-openai-responses": "gpt-5.4",
	"openai-codex": "gpt-5.6",
	deepseek: "deepseek-v4-pro",
	google: "gemini-3.1-pro-preview",
	"google-vertex": "gemini-3.1-pro-preview",
	"github-copilot": "gpt-5.4",
	openrouter: "moonshotai/kimi-k2.6",
	"vercel-ai-gateway": "zai/glm-5.1",
	xai: "grok-4.20-0309-reasoning",
	groq: "openai/gpt-oss-120b",
	cerebras: "zai-glm-4.7",
	zai: "glm-5.1",
	mistral: "devstral-medium-latest",
	minimax: "MiniMax-M2.7",
	"minimax-cn": "MiniMax-M2.7",
	moonshotai: "kimi-k2.6",
	"moonshotai-cn": "kimi-k2.6",
	huggingface: "moonshotai/Kimi-K2.6",
	fireworks: "accounts/fireworks/models/kimi-k2p6",
	together: "moonshotai/Kimi-K2.6",
	opencode: "kimi-k2.6",
	"opencode-go": "kimi-k2.6",
	"kimi-coding": "kimi-for-coding",
	"cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.6",
	"cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.6",
	xiaomi: "mimo-v2.5-pro",
	"xiaomi-token-plan-cn": "mimo-v2.5-pro",
	"xiaomi-token-plan-ams": "mimo-v2.5-pro",
	"xiaomi-token-plan-sgp": "mimo-v2.5-pro",
};

export interface ScopedModel {
	model: Model<Api>;
	/** Thinking level if explicitly specified in pattern (e.g., "model:high"), undefined otherwise */
	thinkingLevel?: ThinkingLevel;
}

/**
 * Helper to check if a model ID looks like an alias (no date suffix)
 * Dates are typically in format: -20241022 or -20250929
 */
function isAlias(id: string): boolean {
	// Check if ID ends with -latest
	if (id.endsWith("-latest")) return true;

	// Check if ID ends with a date pattern (-YYYYMMDD)
	const datePattern = /-\d{8}$/;
	return !datePattern.test(id);
}

/**
 * Find an exact model reference match.
 * Supports either a bare model id or a canonical provider/modelId reference.
 * When matching by bare id, ambiguous matches across providers are rejected.
 */
export function findExactModelReferenceMatch(
	modelReference: string,
	availableModels: Model<Api>[],
): Model<Api> | undefined {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) {
		return undefined;
	}

	const normalizedReference = trimmedReference.toLowerCase();

	const canonicalMatches = availableModels.filter(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
	);
	if (canonicalMatches.length === 1) {
		return canonicalMatches[0];
	}
	if (canonicalMatches.length > 1) {
		return undefined;
	}

	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.substring(0, slashIndex).trim();
		const modelId = trimmedReference.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			const providerMatches = availableModels.filter(
				(model) =>
					model.provider.toLowerCase() === provider.toLowerCase() &&
					model.id.toLowerCase() === modelId.toLowerCase(),
			);
			if (providerMatches.length === 1) {
				return providerMatches[0];
			}
			if (providerMatches.length > 1) {
				return undefined;
			}
		}
	}

	const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

/**
 * Try to match a pattern to a model from the available models list.
 * Returns the matched model or undefined if no match found.
 */
function tryMatchModel(modelPattern: string, availableModels: Model<Api>[]): Model<Api> | undefined {
	const exactMatch = findExactModelReferenceMatch(modelPattern, availableModels);
	if (exactMatch) {
		return exactMatch;
	}

	// No exact match - fall back to partial matching
	const matches = availableModels.filter(
		(m) =>
			m.id.toLowerCase().includes(modelPattern.toLowerCase()) ||
			m.name?.toLowerCase().includes(modelPattern.toLowerCase()),
	);

	if (matches.length === 0) {
		return undefined;
	}

	// Separate into aliases and dated versions
	const aliases = matches.filter((m) => isAlias(m.id));
	const datedVersions = matches.filter((m) => !isAlias(m.id));

	if (aliases.length > 0) {
		// Prefer alias - if multiple aliases, pick the one that sorts highest
		aliases.sort((a, b) => b.id.localeCompare(a.id));
		return aliases[0];
	} else {
		// No alias found, pick latest dated version
		datedVersions.sort((a, b) => b.id.localeCompare(a.id));
		return datedVersions[0];
	}
}

interface ParseModelPatternOptions {
	allowInvalidThinkingLevelFallback?: boolean;
}

export interface ParsedModelResult {
	model: Model<Api> | undefined;
	/** Thinking level if explicitly specified in pattern, undefined otherwise */
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
}

function buildFallbackModel(provider: string, modelId: string, availableModels: Model<Api>[]): Model<Api> | undefined {
	const providerModels = availableModels.filter((m) => m.provider === provider);
	if (providerModels.length === 0) return undefined;

	const defaultId = defaultModelPerProvider[provider as KnownProvider];
	const baseModel = defaultId
		? (providerModels.find((m) => m.id === defaultId) ?? providerModels[0])
		: providerModels[0];

	return {
		...baseModel,
		id: modelId,
		name: modelId,
	};
}

/**
 * Parse a pattern to extract model and thinking level.
 * Handles models with colons in their IDs (e.g., OpenRouter's :exacto suffix).
 *
 * Algorithm:
 * 1. Try to match full pattern as a model
 * 2. If found, return it with "off" thinking level
 * 3. If not found and has colons, split on last colon:
 *    - If suffix is valid thinking level, use it and recurse on prefix
 *    - If suffix is invalid, warn and recurse on prefix with "off"
 *
 * @internal Exported for testing
 */
export function parseModelPattern(
	pattern: string,
	availableModels: Model<Api>[],
	options?: ParseModelPatternOptions,
): ParsedModelResult {
	// Try exact match first
	const exactMatch = tryMatchModel(pattern, availableModels);
	if (exactMatch) {
		return { model: exactMatch, thinkingLevel: undefined, warning: undefined };
	}

	// No match - try splitting on last colon if present
	const lastColonIndex = pattern.lastIndexOf(":");
	if (lastColonIndex === -1) {
		// No colons, pattern simply doesn't match any model
		return { model: undefined, thinkingLevel: undefined, warning: undefined };
	}

	const prefix = pattern.substring(0, lastColonIndex);
	const suffix = pattern.substring(lastColonIndex + 1);

	if (isValidThinkingLevel(suffix)) {
		// Valid thinking level - recurse on prefix and use this level
		const result = parseModelPattern(prefix, availableModels, options);
		if (result.model) {
			// Only use this thinking level if no warning from inner recursion
			return {
				model: result.model,
				thinkingLevel: result.warning ? undefined : suffix,
				warning: result.warning,
			};
		}
		return result;
	} else {
		// Invalid suffix
		const allowFallback = options?.allowInvalidThinkingLevelFallback ?? true;
		if (!allowFallback) {
			// In strict mode (CLI --model parsing), treat it as part of the model id and fail.
			// This avoids accidentally resolving to a different model.
			return { model: undefined, thinkingLevel: undefined, warning: undefined };
		}

		// Scope mode: recurse on prefix and warn
		const result = parseModelPattern(prefix, availableModels, options);
		if (result.model) {
			return {
				model: result.model,
				thinkingLevel: undefined,
				warning: `Invalid thinking level "${suffix}" in pattern "${pattern}". Using default instead.`,
			};
		}
		return result;
	}
}

interface GlobModelPattern {
	pattern: string;
	thinkingLevel?: ThinkingLevel;
}

interface ModelScopePatternResolution {
	models: ScopedModel[];
	warnings: string[];
}

function parseGlobModelPattern(pattern: string): GlobModelPattern {
	const colonIndex = pattern.lastIndexOf(":");
	if (colonIndex === -1) return { pattern };
	const suffix = pattern.substring(colonIndex + 1);
	return isValidThinkingLevel(suffix)
		? { pattern: pattern.substring(0, colonIndex), thinkingLevel: suffix }
		: { pattern };
}

function resolveGlobModelScopePattern(pattern: string, availableModels: Model<Api>[]): ModelScopePatternResolution {
	const glob = parseGlobModelPattern(pattern);
	const matchingModels = availableModels.filter((model) => {
		const fullId = `${model.provider}/${model.id}`;
		return minimatch(fullId, glob.pattern, { nocase: true }) || minimatch(model.id, glob.pattern, { nocase: true });
	});
	if (matchingModels.length === 0) {
		return { models: [], warnings: [`Warning: No models match pattern "${pattern}"`] };
	}
	return {
		models: matchingModels.map((model) => ({ model, thinkingLevel: glob.thinkingLevel })),
		warnings: [],
	};
}

function resolveLiteralModelScopePattern(pattern: string, availableModels: Model<Api>[]): ModelScopePatternResolution {
	const { model, thinkingLevel, warning } = parseModelPattern(pattern, availableModels);
	const warnings = warning ? [`Warning: ${warning}`] : [];
	if (!model) warnings.push(`Warning: No models match pattern "${pattern}"`);
	return { models: model ? [{ model, thinkingLevel }] : [], warnings };
}

type ModelIndex = Map<string, Map<string, Model<Api>>>;

function addModelToIndex(index: ModelIndex, model: Model<Api>): boolean {
	let providerModels = index.get(model.provider);
	if (!providerModels) {
		providerModels = new Map();
		index.set(model.provider, providerModels);
	}
	if (providerModels.has(model.id)) return false;
	providerModels.set(model.id, model);
	return true;
}

function createModelIndex(models: Iterable<Model<Api>>): ModelIndex {
	const index: ModelIndex = new Map();
	for (const model of models) addModelToIndex(index, model);
	return index;
}

function appendUniqueScopedModels(target: ScopedModel[], candidates: ScopedModel[]): void {
	const modelIndex = createModelIndex(target.map((scopedModel) => scopedModel.model));
	for (const candidate of candidates) {
		if (addModelToIndex(modelIndex, candidate.model)) target.push(candidate);
	}
}
/**
 * Resolve model patterns to actual Model objects with optional thinking levels
 * Format: "pattern:level" where :level is optional
 * For each pattern, finds all matching models and picks the best version:
 * 1. Prefer alias (e.g., claude-sonnet-4-5) over dated versions (claude-sonnet-4-5-20250929)
 * 2. If no alias, pick the latest dated version
 *
 * Supports models with colons in their IDs (e.g., OpenRouter's model:exacto).
 * The algorithm tries to match the full pattern first, then progressively
 * strips colon-suffixes to find a match.
 */
export async function resolveModelScope(patterns: string[], modelRegistry: ModelRegistry): Promise<ScopedModel[]> {
	const availableModels = await modelRegistry.getAvailable();
	const scopedModels: ScopedModel[] = [];
	for (const pattern of patterns) {
		const resolution =
			pattern.includes("*") || pattern.includes("?") || pattern.includes("[")
				? resolveGlobModelScopePattern(pattern, availableModels)
				: resolveLiteralModelScopePattern(pattern, availableModels);
		for (const warning of resolution.warnings) console.warn(chalk.yellow(warning));
		appendUniqueScopedModels(scopedModels, resolution.models);
	}
	return scopedModels;
}

interface ResolveCliModelOptions {
	cliProvider?: string;
	cliModel?: string;
	modelRegistry: ModelRegistry;
}

export interface ResolveCliModelResult {
	model: Model<Api> | undefined;
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
	/**
	 * Error message suitable for CLI display.
	 * When set, model will be undefined.
	 */
	error: string | undefined;
}

interface CliModelReference {
	provider: string | undefined;
	pattern: string;
	inferredProvider: boolean;
}

type CliModelReferenceResolution =
	| { reference: CliModelReference; error?: never }
	| { reference?: never; error: string };

function createProviderMap(availableModels: Model<Api>[]): Map<string, string> {
	const providerMap = new Map<string, string>();
	for (const model of availableModels) providerMap.set(model.provider.toLowerCase(), model.provider);
	return providerMap;
}

function resolveCliModelReference(
	cliProvider: string | undefined,
	cliModel: string,
	providerMap: Map<string, string>,
): CliModelReferenceResolution {
	let provider = cliProvider ? providerMap.get(cliProvider.toLowerCase()) : undefined;
	if (cliProvider && !provider) {
		return { error: `Unknown provider "${cliProvider}". Use --list-models to see available providers/models.` };
	}
	let pattern = cliModel;
	let inferredProvider = false;
	if (!provider) {
		const slashIndex = cliModel.indexOf("/");
		const maybeProvider = slashIndex === -1 ? undefined : cliModel.substring(0, slashIndex);
		const canonical = maybeProvider ? providerMap.get(maybeProvider.toLowerCase()) : undefined;
		if (canonical) {
			provider = canonical;
			pattern = cliModel.substring(slashIndex + 1);
			inferredProvider = true;
		}
	}
	if (cliProvider && provider) {
		const prefix = `${provider}/`;
		if (cliModel.toLowerCase().startsWith(prefix.toLowerCase())) pattern = cliModel.substring(prefix.length);
	}
	return { reference: { provider, pattern, inferredProvider } };
}

function findExactCliInputModel(cliModel: string, availableModels: Model<Api>[]): Model<Api> | undefined {
	const lower = cliModel.toLowerCase();
	return availableModels.find(
		(model) => model.id.toLowerCase() === lower || `${model.provider}/${model.id}`.toLowerCase() === lower,
	);
}

function resolveInferredProviderFallback(
	cliModel: string,
	availableModels: Model<Api>[],
): ResolveCliModelResult | undefined {
	const exact = findExactCliInputModel(cliModel, availableModels);
	if (exact) return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
	const fallback = parseModelPattern(cliModel, availableModels, {
		allowInvalidThinkingLevelFallback: false,
	});
	if (!fallback.model) return undefined;
	return {
		model: fallback.model,
		thinkingLevel: fallback.thinkingLevel,
		warning: fallback.warning,
		error: undefined,
	};
}

function resolveCustomProviderModel(
	provider: string,
	pattern: string,
	warning: string | undefined,
	availableModels: Model<Api>[],
): ResolveCliModelResult | undefined {
	const fallbackModel = buildFallbackModel(provider, pattern, availableModels);
	if (!fallbackModel) return undefined;
	const fallbackWarning = warning
		? `${warning} Model "${pattern}" not found for provider "${provider}". Using custom model id.`
		: `Model "${pattern}" not found for provider "${provider}". Using custom model id.`;
	return { model: fallbackModel, thinkingLevel: undefined, warning: fallbackWarning, error: undefined };
}

/**
 * Resolve a single model from CLI flags.
 *
 * Supports:
 * - --provider <provider> --model <pattern>
 * - --model <provider>/<pattern>
 * - Fuzzy matching (same rules as model scoping: exact id, then partial id/name)
 *
 * Note: This does not apply the thinking level by itself, but it may *parse* and
 * return a thinking level from "<pattern>:<thinking>" so the caller can apply it.
 */
export function resolveCliModel(options: ResolveCliModelOptions): ResolveCliModelResult {
	const { cliProvider, cliModel, modelRegistry } = options;
	if (!cliModel) return { model: undefined, warning: undefined, error: undefined };

	// Important: use *all* models here, not just models with pre-configured auth.
	// This allows "--api-key" to be used for first-time setup.
	const availableModels = modelRegistry.getAll();
	if (availableModels.length === 0) {
		return {
			model: undefined,
			warning: undefined,
			error: "No models available. Check your installation or add models to models.json.",
		};
	}

	const referenceResolution = resolveCliModelReference(cliProvider, cliModel, createProviderMap(availableModels));
	if ("error" in referenceResolution) {
		return { model: undefined, warning: undefined, error: referenceResolution.error };
	}
	const { provider, pattern, inferredProvider } = referenceResolution.reference;

	// Without provider inference, model IDs containing slashes remain eligible for exact matching.
	if (!provider) {
		const exact = findExactCliInputModel(cliModel, availableModels);
		if (exact) return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
	}

	const candidates = provider ? availableModels.filter((model) => model.provider === provider) : availableModels;
	const { model, thinkingLevel, warning } = parseModelPattern(pattern, candidates, {
		allowInvalidThinkingLevelFallback: false,
	});
	if (model) return { model, thinkingLevel, warning, error: undefined };

	// A slash prefix can name either a provider or part of a raw model ID. Retry the full input after provider matching fails.
	if (inferredProvider) {
		const fallback = resolveInferredProviderFallback(cliModel, availableModels);
		if (fallback) return fallback;
	}

	if (provider) {
		const fallback = resolveCustomProviderModel(provider, pattern, warning, availableModels);
		if (fallback) return fallback;
	}

	const display = provider ? `${provider}/${pattern}` : cliModel;
	return {
		model: undefined,
		thinkingLevel: undefined,
		warning,
		error: `Model "${display}" not found. Use --list-models to see available models.`,
	};
}

function findPreferredAvailableModel(availableModels: Model<Api>[]): Model<Api> | undefined {
	const modelIndex = createModelIndex(availableModels);
	for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
		const match = modelIndex.get(provider)?.get(defaultModelPerProvider[provider]);
		if (match) return match;
	}
	return availableModels[0];
}

interface FindInitialModelOptions {
	cliProvider?: string;
	cliModel?: string;
	scopedModels: ScopedModel[];
	isContinuing: boolean;
	defaultProvider?: string;
	defaultModelId?: string;
	defaultThinkingLevel?: ThinkingLevel;
	modelRegistry: ModelRegistry;
}

export interface InitialModelResult {
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel;
	fallbackMessage: string | undefined;
}

function resolveInitialCliSelection(
	cliProvider: string | undefined,
	cliModel: string | undefined,
	modelRegistry: ModelRegistry,
): InitialModelResult | undefined {
	if (!cliProvider || !cliModel) return undefined;
	const resolved = resolveCliModel({ cliProvider, cliModel, modelRegistry });
	if (resolved.error) {
		console.error(chalk.red(resolved.error));
		process.exit(1);
	}
	return resolved.model
		? { model: resolved.model, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined }
		: undefined;
}

/**
 * Find the initial model to use based on priority:
 * 1. CLI args (provider + model)
 * 2. First model from scoped models (if not continuing/resuming)
 * 3. Restored from session (if continuing/resuming)
 * 4. Saved default from settings
 * 5. First available model with valid API key
 */
export async function findInitialModel(options: FindInitialModelOptions): Promise<InitialModelResult> {
	const {
		cliProvider,
		cliModel,
		scopedModels,
		isContinuing,
		defaultProvider,
		defaultModelId,
		defaultThinkingLevel,
		modelRegistry,
	} = options;

	// 1. CLI args take priority
	const cliSelection = resolveInitialCliSelection(cliProvider, cliModel, modelRegistry);
	if (cliSelection) return cliSelection;

	// 2. Use first model from scoped models (skip if continuing/resuming)
	if (scopedModels.length > 0 && !isContinuing) {
		return {
			model: scopedModels[0].model,
			thinkingLevel: scopedModels[0].thinkingLevel ?? defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
			fallbackMessage: undefined,
		};
	}

	// 3. Try saved default from settings if auth is configured.
	if (defaultProvider && defaultModelId) {
		const found = modelRegistry.find(defaultProvider, defaultModelId);
		if (found && modelRegistry.hasConfiguredAuth(found)) {
			return {
				model: found,
				thinkingLevel: defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
				fallbackMessage: undefined,
			};
		}
	}

	// 4. Try first available model with valid API key
	const availableModels = await modelRegistry.getAvailable();

	const preferredModel = findPreferredAvailableModel(availableModels);
	if (preferredModel) {
		return { model: preferredModel, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
	}

	// 5. No model found
	return { model: undefined, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
}

interface RestoreModelResult {
	model: Model<Api> | undefined;
	fallbackMessage: string | undefined;
}

/**
 * Restore model from session, with fallback to available models
 */
export async function restoreModelFromSession(
	savedProvider: string,
	savedModelId: string,
	currentModel: Model<Api> | undefined,
	shouldPrintMessages: boolean,
	modelRegistry: ModelRegistry,
): Promise<RestoreModelResult> {
	const restoredModel = modelRegistry.find(savedProvider, savedModelId);
	// Check if restored model exists and still has auth configured
	const hasConfiguredAuth = restoredModel ? modelRegistry.hasConfiguredAuth(restoredModel) : false;

	if (restoredModel && hasConfiguredAuth) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Restored model: ${savedProvider}/${savedModelId}`));
		}
		return { model: restoredModel, fallbackMessage: undefined };
	}

	// Model not found or no API key - fall back
	const reason = !restoredModel ? "model no longer exists" : "no auth configured";

	if (shouldPrintMessages) {
		console.error(chalk.yellow(`Warning: Could not restore model ${savedProvider}/${savedModelId} (${reason}).`));
	}

	// If we already have a model, use it as fallback
	if (currentModel) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${currentModel.provider}/${currentModel.id}`));
		}
		return {
			model: currentModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${currentModel.provider}/${currentModel.id}.`,
		};
	}

	// Try to find any available model
	const availableModels = await modelRegistry.getAvailable();

	const fallbackModel = findPreferredAvailableModel(availableModels);
	if (fallbackModel) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${fallbackModel.provider}/${fallbackModel.id}`));
		}

		return {
			model: fallbackModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${fallbackModel.provider}/${fallbackModel.id}.`,
		};
	}

	// No models available
	return { model: undefined, fallbackMessage: undefined };
}
