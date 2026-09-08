import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDirectoryCompletions } from "../src/utils/directory-completions.ts";

const tempDirectories: string[] = [];

function createFixture(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-cd-completions-"));
	tempDirectories.push(cwd);
	mkdirSync(join(cwd, "alpha"));
	mkdirSync(join(cwd, "directory with spaces"));
	mkdirSync(join(cwd, "nested", "child"), { recursive: true });
	writeFileSync(join(cwd, "not-a-directory.txt"), "test");
	return cwd;
}

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("getDirectoryCompletions", () => {
	it("lists only matching child directories", () => {
		const cwd = createFixture();

		expect(getDirectoryCompletions("a", cwd)).toEqual([{ value: "alpha/", label: "alpha/" }]);
		expect(getDirectoryCompletions("not", cwd)).toEqual([]);
	});

	it("completes nested directory paths", () => {
		const cwd = createFixture();

		expect(getDirectoryCompletions("nested/", cwd)).toEqual([{ value: "nested/child/", label: "child/" }]);
	});

	it("quotes directory paths containing spaces", () => {
		const cwd = createFixture();

		expect(getDirectoryCompletions("dir", cwd)).toEqual([
			{ value: '"directory with spaces/"', label: "directory with spaces/" },
		]);
	});
});
