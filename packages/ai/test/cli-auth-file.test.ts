import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("pi-ai OAuth CLI credential writes", () => {
	it("applies mode 0600 at file creation and corrects existing permissions", () => {
		const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf-8");
		expect(source).toContain(
			'writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { encoding: "utf-8", mode: 0o600 });',
		);
		expect(source).toContain("chmodSync(AUTH_FILE, 0o600);");
		expect(source).not.toContain('writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), "utf-8");');
	});
});
