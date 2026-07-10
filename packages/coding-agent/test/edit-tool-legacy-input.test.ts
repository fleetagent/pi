import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { initHasher, lineHashes } from "../src/core/tools/hashline/index.ts";
import { LocalToolOperations } from "../src/core/tools/index.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-hashline-input-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("edit tool hashline input", () => {
	it("exposes hashline schema instead of legacy oldText/newText", () => {
		const definition = createEditToolDefinition(new LocalToolOperations(process.cwd()));
		expect(definition.parameters.properties).not.toHaveProperty("oldText");
		expect(definition.parameters.properties).not.toHaveProperty("newText");
		expect(definition.parameters.properties).toHaveProperty("changes");
	});

	it("normalizes flat hashline input into changes", () => {
		const definition = createEditToolDefinition(new LocalToolOperations(process.cwd()));
		const prepared = definition.prepareArguments!({
			path: "file.txt",
			hash_range_inclusive: ["abc", "def"],
			content_lines: ["after"],
		});
		expect(prepared).toEqual({
			path: "file.txt",
			changes: [{ hash_range_inclusive: ["abc", "def"], content_lines: ["after"] }],
		});
	});

	it("rejects legacy oldText/newText at execution", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "legacy.txt"), "before\n", "utf8");
		const definition = createEditToolDefinition(new LocalToolOperations(dir));
		await expect(
			definition.execute(
				"tool-legacy",
				{ path: "legacy.txt", oldText: "before", newText: "after" } as never,
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/E_LEGACY_SHAPE/);
	});

	it("executes hash-anchored replacements", async () => {
		await initHasher();
		const dir = await createTempDir();
		const filePath = join(dir, "hashline.txt");
		const content = "before\nkeep\n";
		await writeFile(filePath, content, "utf8");
		const hashes = await lineHashes(content.replace(/\n$/, ""), filePath);

		const definition = createEditToolDefinition(new LocalToolOperations(dir));
		const result = await definition.execute(
			"tool-1",
			{
				path: "hashline.txt",
				changes: [{ hash_range_inclusive: [hashes[0], hashes[0]], content_lines: ["after"] }],
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const firstContent = result.content[0];
		expect(firstContent?.type).toBe("text");
		expect(firstContent?.type === "text" ? firstContent.text : "").toContain(
			"Successfully replaced in hashline.txt.",
		);
		expect(await readFile(filePath, "utf8")).toBe("after\nkeep\n");
	});
});
