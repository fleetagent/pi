import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getModels, loadCachedModelCatalog, refreshModelCatalog, resetModelCatalog } from "../src/models.ts";
import type { Api, Model } from "../src/types.ts";

const temporaryRoots: string[] = [];

function temporaryCachePath(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-model-catalog-test-"));
	temporaryRoots.push(root);
	return join(root, "catalog.json");
}

function catalogModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
		...init,
	});
}

afterEach(() => {
	resetModelCatalog();
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime model catalog cache", () => {
	it("refreshes from a hosted index and overlays generated models", async () => {
		const cachePath = temporaryCachePath();
		const model = catalogModel("gpt-runtime-new");
		const calls: string[] = [];
		const fetchImpl: typeof fetch = async (url) => {
			const href = String(url);
			calls.push(href);
			if (href.endsWith("/index.json")) {
				return jsonResponse(
					{ schemaVersion: 1, defaultRevision: "sha256-test", catalogs: [] },
					{ headers: { etag: "test-etag", "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT" } },
				);
			}
			return jsonResponse({ openai: { [model.id]: model } });
		};

		const result = await refreshModelCatalog({
			indexUrl: "https://catalog.example/models/v1/index.json",
			cachePath,
			fetch: fetchImpl,
			now: () => 1000,
		});

		expect(result).toMatchObject({ loaded: true, updated: true, fromCache: false, revision: "sha256-test" });
		expect(calls).toEqual([
			"https://catalog.example/models/v1/index.json",
			"https://catalog.example/models/v1/revisions/sha256-test/models.json",
		]);
		expect(getModels("openai").find((entry) => entry.id === model.id)).toMatchObject({
			id: model.id,
		});
	});

	it("loads cached catalogs synchronously", async () => {
		const cachePath = temporaryCachePath();
		const model = catalogModel("gpt-runtime-cached");
		await refreshModelCatalog({
			indexUrl: "https://catalog.example/models/v1/index.json",
			cachePath,
			fetch: async (url) =>
				String(url).endsWith("/index.json")
					? jsonResponse({ schemaVersion: 1, defaultRevision: "sha256-cached", catalogs: [] })
					: jsonResponse({ openai: { [model.id]: model } }),
		});
		resetModelCatalog();

		const result = loadCachedModelCatalog({ indexUrl: "https://catalog.example/models/v1/index.json", cachePath });

		expect(result).toMatchObject({ loaded: true, updated: false, fromCache: true, revision: "sha256-cached" });
		expect(getModels("openai").find((entry) => entry.id === model.id)?.id).toBe(model.id);
	});

	it("uses conditional index validators and keeps cached models on 304", async () => {
		const cachePath = temporaryCachePath();
		const model = catalogModel("gpt-runtime-304");
		await refreshModelCatalog({
			indexUrl: "https://catalog.example/models/v1/index.json",
			cachePath,
			fetch: async (url) =>
				String(url).endsWith("/index.json")
					? jsonResponse(
							{ schemaVersion: 1, defaultRevision: "sha256-304", catalogs: [] },
							{ headers: { etag: "etag-304" } },
						)
					: jsonResponse({ openai: { [model.id]: model } }),
			now: () => 1000,
		});
		resetModelCatalog();
		let receivedIfNoneMatch: string | null = null;

		const result = await refreshModelCatalog({
			indexUrl: "https://catalog.example/models/v1/index.json",
			cachePath,
			ttlMs: 0,
			fetch: async (_url, init) => {
				receivedIfNoneMatch = new Headers(init?.headers).get("if-none-match");
				return new Response(null, { status: 304 });
			},
			now: () => 2000,
		});

		expect(receivedIfNoneMatch).toBe("etag-304");
		expect(result).toMatchObject({ loaded: true, updated: false, fromCache: true, revision: "sha256-304" });
		expect(getModels("openai").find((entry) => entry.id === model.id)?.id).toBe(model.id);
	});
});
