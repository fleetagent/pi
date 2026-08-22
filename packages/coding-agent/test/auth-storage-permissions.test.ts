import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage.ts";

function permissionBits(path: string): number {
	return statSync(path).mode & 0o777;
}

describe("FileAuthStorageBackend creation permissions", () => {
	let tempDir: string;
	let authPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-auth-permissions-${process.pid}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authPath = join(tempDir, "auth.json");
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("applies mode 0600 at creation time on every auth-storage write path", () => {
		const source = readFileSync(new URL("../src/core/auth-storage.ts", import.meta.url), "utf-8");
		expect(source).toContain('const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;');
		expect(source.match(/writeFileSync\(this\.authPath, [^\n]+, AUTH_FILE_WRITE_OPTIONS\);/g)).toHaveLength(3);
	});

	it.runIf(process.platform !== "win32")("creates the initial auth file with mode 0600", () => {
		const backend = new FileAuthStorageBackend(authPath);
		backend.withLock(() => ({ result: undefined }));

		expect(permissionBits(authPath)).toBe(0o600);
	});

	it.runIf(process.platform !== "win32")("corrects permissions after synchronous credential writes", () => {
		const backend = new FileAuthStorageBackend(authPath);
		backend.withLock(() => ({ result: undefined }));
		chmodSync(authPath, 0o666);

		backend.withLock(() => ({ result: undefined, next: '{"provider":{"type":"api_key","key":"secret"}}' }));

		expect(permissionBits(authPath)).toBe(0o600);
	});

	it.runIf(process.platform !== "win32")(
		"corrects permissions after asynchronous credential refresh writes",
		async () => {
			const backend = new FileAuthStorageBackend(authPath);
			backend.withLock(() => ({ result: undefined }));
			chmodSync(authPath, 0o666);

			await backend.withLockAsync(async () => ({
				result: undefined,
				next: '{"provider":{"type":"oauth","access":"secret"}}',
			}));

			expect(permissionBits(authPath)).toBe(0o600);
		},
	);
});
