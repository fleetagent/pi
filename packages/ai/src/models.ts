import { MODELS } from "./models.generated.ts";
import type { Api, KnownProvider, Model, ModelThinkingLevel, Usage, UsageCost } from "./types.ts";

const MODEL_CATALOG_SCHEMA_VERSION = 1;

interface ModelCatalogIndexEntry {
	minimumPiVersion: string;
	revision: string;
}

interface ModelCatalogIndex {
	schemaVersion: number;
	defaultRevision?: string;
	catalogs?: ModelCatalogIndexEntry[];
}

interface CachedModelCatalog {
	schemaVersion: number;
	indexUrl: string;
	revision: string;
	fetchedAt: number;
	etag?: string;
	lastModified?: string;
	models: Record<string, Record<string, Model<Api>>>;
}

export interface ModelCatalogRefreshOptions {
	/** URL of the upstream models/v1/index.json catalog index. Defaults to PI_MODEL_CATALOG_URL. */
	indexUrl?: string;
	/** Persistent cache file. Defaults to PI_MODEL_CATALOG_CACHE_PATH or ~/.cache/pi/model-catalog.json. */
	cachePath?: string;
	/** Reuse cache without a network request while it is this fresh. Default: 6 hours. */
	ttlMs?: number;
	/** Ignore TTL and conditional validators. */
	force?: boolean;
	signal?: AbortSignal;
	/** Test hook. Defaults to global fetch. */
	fetch?: typeof fetch;
	/** Test hook. Defaults to Date.now(). */
	now?: () => number;
}

export interface ModelCatalogRefreshResult {
	loaded: boolean;
	updated: boolean;
	fromCache: boolean;
	revision?: string;
	providerCount: number;
	modelCount: number;
}
interface NodeDirectoryCreationOptions {
	recursive: boolean;
}

interface ModelCatalogCounts {
	providerCount: number;
	modelCount: number;
}

type NodeFs = {
	existsSync(path: string): boolean;
	mkdirSync(path: string, options: NodeDirectoryCreationOptions): void;
	readFileSync(path: string, encoding: BufferEncoding): string;
	writeFileSync(path: string, content: string): void;
};

type NodeOs = { homedir(): string };

type NodePath = {
	dirname(path: string): string;
	join(...parts: string[]): string;
};

function getNodeBuiltin<T>(name: string): T | undefined {
	return typeof process === "undefined" ? undefined : (process.getBuiltinModule?.(name) as T | undefined);
}

function getNodeModelCatalogCachePath(): string | undefined {
	const os = getNodeBuiltin<NodeOs>("os");
	const path = getNodeBuiltin<NodePath>("path");
	if (!os || !path) return undefined;
	return path.join(os.homedir(), ".cache", "pi", "model-catalog.json");
}

const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFinitePositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isModelInput(value: unknown): boolean {
	return Array.isArray(value) && value.every((entry) => entry === "text" || entry === "image");
}

function isModelCost(value: unknown): boolean {
	if (!isRecord(value)) return false;
	for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		if (typeof value[field] !== "number" || !Number.isFinite(value[field])) return false;
	}
	return true;
}

function isModel(value: unknown, provider: string, id: string): value is Model<Api> {
	if (!isRecord(value)) return false;
	if (value.id !== id || value.provider !== provider) return false;
	if (typeof value.name !== "string" || value.name.length === 0) return false;
	if (typeof value.api !== "string" || value.api.length === 0) return false;
	if (typeof value.baseUrl !== "string" || value.baseUrl.length === 0) return false;
	if (typeof value.reasoning !== "boolean") return false;
	if (!isModelInput(value.input)) return false;
	if (!isModelCost(value.cost)) return false;
	return isFinitePositiveNumber(value.contextWindow) && isFinitePositiveNumber(value.maxTokens);
}

function validateCatalogModels(value: unknown): Record<string, Record<string, Model<Api>>> {
	if (!isRecord(value)) throw new Error("Model catalog must contain an object");
	const providers: Record<string, Record<string, Model<Api>>> = {};
	for (const [provider, providerModels] of Object.entries(value)) {
		if (!isRecord(providerModels)) throw new Error(`Model catalog provider must contain an object: ${provider}`);
		const models: Record<string, Model<Api>> = {};
		for (const [id, model] of Object.entries(providerModels)) {
			if (!isModel(model, provider, id)) throw new Error(`Invalid model catalog entry: ${provider}/${id}`);
			models[id] = model;
		}
		providers[provider] = models;
	}
	return providers;
}

function countCatalogModels(models: Record<string, Record<string, Model<Api>>>): ModelCatalogCounts {
	let modelCount = 0;
	for (const providerModels of Object.values(models)) modelCount += Object.keys(providerModels).length;
	return { providerCount: Object.keys(models).length, modelCount };
}

function applyCatalogModels(models: Record<string, Record<string, Model<Api>>>): void {
	for (const [provider, providerModels] of Object.entries(models)) {
		const registryProviderModels = modelRegistry.get(provider) ?? new Map<string, Model<Api>>();
		for (const [id, model] of Object.entries(providerModels)) {
			registryProviderModels.set(id, model);
		}
		modelRegistry.set(provider, registryProviderModels);
	}
}

function readCachedCatalog(cachePath: string | undefined, indexUrl?: string): CachedModelCatalog | undefined {
	try {
		if (!cachePath) return undefined;
		const fs = getNodeBuiltin<NodeFs>("fs");
		if (!fs?.existsSync(cachePath)) return undefined;
		const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as unknown;
		if (!isRecord(parsed)) return undefined;
		if (parsed.schemaVersion !== MODEL_CATALOG_SCHEMA_VERSION) return undefined;
		if (typeof parsed.indexUrl !== "string" || typeof parsed.revision !== "string") return undefined;
		if (indexUrl !== undefined && parsed.indexUrl !== indexUrl) return undefined;
		if (typeof parsed.fetchedAt !== "number" || !Number.isFinite(parsed.fetchedAt)) return undefined;
		const cached: CachedModelCatalog = {
			schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
			indexUrl: parsed.indexUrl,
			revision: parsed.revision,
			fetchedAt: parsed.fetchedAt,
			models: validateCatalogModels(parsed.models),
		};
		if (typeof parsed.etag === "string") cached.etag = parsed.etag;
		if (typeof parsed.lastModified === "string") cached.lastModified = parsed.lastModified;
		return cached;
	} catch {
		return undefined;
	}
}

function writeCachedCatalog(cachePath: string | undefined, catalog: CachedModelCatalog): void {
	const fs = getNodeBuiltin<NodeFs>("fs");
	const path = getNodeBuiltin<NodePath>("path");
	if (!cachePath || !fs || !path) return;
	fs.mkdirSync(path.dirname(cachePath), { recursive: true });
	fs.writeFileSync(cachePath, `${JSON.stringify(catalog, null, 2)}\n`);
}

function getCachePath(options?: Pick<ModelCatalogRefreshOptions, "cachePath">): string | undefined {
	const envPath = typeof process === "undefined" ? undefined : process.env.PI_MODEL_CATALOG_CACHE_PATH;
	return options?.cachePath ?? envPath ?? getNodeModelCatalogCachePath();
}

function getIndexUrl(options?: Pick<ModelCatalogRefreshOptions, "indexUrl">): string | undefined {
	return options?.indexUrl ?? (typeof process === "undefined" ? undefined : process.env.PI_MODEL_CATALOG_URL);
}

function resolveCatalogUrl(indexUrl: string, revision: string): string {
	return new URL(`revisions/${encodeURIComponent(revision)}/models.json`, indexUrl).toString();
}

function selectRevision(index: ModelCatalogIndex): string | undefined {
	return index.defaultRevision ?? index.catalogs?.at(-1)?.revision;
}

function createResult(
	models: Record<string, Record<string, Model<Api>>> | undefined,
	result: Pick<ModelCatalogRefreshResult, "loaded" | "updated" | "fromCache" | "revision">,
): ModelCatalogRefreshResult {
	const counts = models ? countCatalogModels(models) : { providerCount: 0, modelCount: 0 };
	return { ...result, ...counts };
}

function getFreshCatalogCache(
	options: ModelCatalogRefreshOptions,
	cached: CachedModelCatalog | undefined,
	now: number,
	ttlMs: number,
): CachedModelCatalog | undefined {
	if (options.force || !cached || now - cached.fetchedAt >= ttlMs) return undefined;
	return cached;
}

function createConditionalCatalogHeaders(
	options: ModelCatalogRefreshOptions,
	cached: CachedModelCatalog | undefined,
): Record<string, string> {
	const headers: Record<string, string> = {};
	if (!options.force && cached?.etag) headers["If-None-Match"] = cached.etag;
	if (!options.force && cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;
	return headers;
}

function reuseCachedCatalog(
	cachePath: string | undefined,
	cached: CachedModelCatalog,
	fetchedAt: number,
): ModelCatalogRefreshResult {
	const refreshedCache = { ...cached, fetchedAt };
	writeCachedCatalog(cachePath, refreshedCache);
	applyCatalogModels(refreshedCache.models);
	return createResult(refreshedCache.models, {
		loaded: true,
		updated: false,
		fromCache: true,
		revision: refreshedCache.revision,
	});
}

function validateCatalogIndex(value: unknown): ModelCatalogIndex {
	if (!isRecord(value) || value.schemaVersion !== MODEL_CATALOG_SCHEMA_VERSION) {
		throw new Error("Unsupported model catalog index schema");
	}
	return value as unknown as ModelCatalogIndex;
}

function initializeStaticRegistry(): void {
	modelRegistry.clear();
	for (const [provider, models] of Object.entries(MODELS)) {
		const providerModels = new Map<string, Model<Api>>();
		for (const [id, model] of Object.entries(models)) {
			providerModels.set(id, model as Model<Api>);
		}
		modelRegistry.set(provider, providerModels);
	}
}

initializeStaticRegistry();

/**
 * Load a previously refreshed model catalog from disk and overlay it on the generated catalog.
 * This is synchronous so callers can update built-in model lists before constructing registries.
 */
export function loadCachedModelCatalog(
	options: Pick<ModelCatalogRefreshOptions, "cachePath" | "indexUrl"> = {},
): ModelCatalogRefreshResult {
	const cached = readCachedCatalog(getCachePath(options), getIndexUrl(options));
	if (!cached) return createResult(undefined, { loaded: false, updated: false, fromCache: true });
	applyCatalogModels(cached.models);
	return createResult(cached.models, {
		loaded: true,
		updated: false,
		fromCache: true,
		revision: cached.revision,
	});
}

/** Reset runtime overlays. Intended for tests. */
export function resetModelCatalog(): void {
	initializeStaticRegistry();
}

/**
 * Fetch an upstream model catalog index, cache the selected revision, and overlay it on generated models.
 * The upstream format matches the catalog produced by the publish-model-catalog workflow.
 */
export async function refreshModelCatalog(
	options: ModelCatalogRefreshOptions = {},
): Promise<ModelCatalogRefreshResult> {
	const indexUrl = getIndexUrl(options);
	if (!indexUrl) return createResult(undefined, { loaded: false, updated: false, fromCache: false });
	const cachePath = getCachePath(options);
	const cached = readCachedCatalog(cachePath, indexUrl);
	const now = options.now?.() ?? Date.now();
	const ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000;
	const freshCache = getFreshCatalogCache(options, cached, now, ttlMs);
	if (freshCache) {
		applyCatalogModels(freshCache.models);
		return createResult(freshCache.models, {
			loaded: true,
			updated: false,
			fromCache: true,
			revision: freshCache.revision,
		});
	}

	const fetchImpl = options.fetch ?? fetch;
	const headers = createConditionalCatalogHeaders(options, cached);
	const indexResponse = await fetchImpl(indexUrl, { headers, signal: options.signal });
	if (indexResponse.status === 304 && cached) return reuseCachedCatalog(cachePath, cached, now);
	if (!indexResponse.ok) throw new Error(`Model catalog index request failed: ${indexResponse.status}`);
	const index = validateCatalogIndex(await indexResponse.json());
	const revision = selectRevision(index);
	if (!revision) throw new Error("Model catalog index does not contain a revision");
	if (!options.force && cached?.revision === revision) return reuseCachedCatalog(cachePath, cached, now);

	const catalogResponse = await fetchImpl(resolveCatalogUrl(indexUrl, revision), { signal: options.signal });
	if (!catalogResponse.ok) throw new Error(`Model catalog request failed: ${catalogResponse.status}`);
	const models = validateCatalogModels(await catalogResponse.json());
	const nextCached: CachedModelCatalog = {
		schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
		indexUrl,
		revision,
		fetchedAt: now,
		models,
	};
	const etag = indexResponse.headers.get("etag");
	if (etag) nextCached.etag = etag;
	const lastModified = indexResponse.headers.get("last-modified");
	if (lastModified) nextCached.lastModified = lastModified;
	writeCachedCatalog(cachePath, nextCached);
	applyCatalogModels(models);
	return createResult(models, { loaded: true, updated: true, fromCache: false, revision });
}

type ModelApi<
	TProvider extends KnownProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

export function getModel<TProvider extends KnownProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

export function getProviders(): KnownProvider[] {
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getModels<TProvider extends KnownProvider>(
	provider: TProvider,
): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[]) : [];
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): UsageCost {
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh") return mapped !== undefined;
		return true;
	});
}

export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	const availableLevelSet = new Set(availableLevels);
	if (availableLevelSet.has(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevelSet.has(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevelSet.has(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
