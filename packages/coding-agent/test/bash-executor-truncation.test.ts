import { describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import type { ToolOperations } from "../src/core/tools/operations.ts";

function createOutputOperations(output: string): ToolOperations {
	return {
		cwd: process.cwd(),
		async exec(_command, options) {
			options.onData(Buffer.from(output));
			return { exitCode: 0 };
		},
		async access() {},
		async readFile() {
			return Buffer.alloc(0);
		},
		async writeFile() {},
		async mkdir() {},
		async stat() {
			return {
				isDirectory: () => false,
				isFile: () => true,
			};
		},
		async readdir() {
			return [];
		},
	};
}

describe("executeBashWithOperations truncation", () => {
	it("returns complete output when truncation is disabled", async () => {
		const output = `${"x".repeat(60 * 1024)}\ncomplete-marker`;

		const truncated = await executeBashWithOperations(
			"generate-output",
			process.cwd(),
			createOutputOperations(output),
		);
		const complete = await executeBashWithOperations(
			"generate-output",
			process.cwd(),
			createOutputOperations(output),
			{ truncate: false },
		);

		expect(truncated.truncated).toBe(true);
		expect(truncated.output.length).toBeLessThan(output.length);
		expect(complete.truncated).toBe(false);
		expect(complete.output).toBe(output);
	});
});
