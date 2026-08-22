import { describe, expect, it } from "vitest";
import { parseGitUrl } from "../src/utils/git.ts";

describe("Git URL Parsing", () => {
	describe("protocol URLs (accepted without git: prefix)", () => {
		it("should parse HTTPS URL", () => {
			const result = parseGitUrl("https://github.com/user/repo");
			expect(result).toMatchObject({
				host: "github.com",
				path: "user/repo",
				repo: "https://github.com/user/repo",
			});
		});

		it("should parse ssh:// URL", () => {
			const result = parseGitUrl("ssh://git@github.com/user/repo");
			expect(result).toMatchObject({
				host: "github.com",
				path: "user/repo",
				repo: "ssh://git@github.com/user/repo",
			});
		});

		it("should parse protocol URL with ref", () => {
			const result = parseGitUrl("https://github.com/user/repo@v1.0.0");
			expect(result).toMatchObject({
				host: "github.com",
				path: "user/repo",
				ref: "v1.0.0",
				repo: "https://github.com/user/repo",
			});
		});
	});

	describe("shorthand URLs (accepted only with git: prefix)", () => {
		it("should parse git@host:path with git: prefix", () => {
			const result = parseGitUrl("git:git@github.com:user/repo");
			expect(result).toMatchObject({
				host: "github.com",
				path: "user/repo",
				repo: "git@github.com:user/repo",
			});
		});

		it("should parse host/path shorthand with git: prefix", () => {
			const result = parseGitUrl("git:github.com/user/repo");
			expect(result).toMatchObject({
				host: "github.com",
				path: "user/repo",
				repo: "https://github.com/user/repo",
			});
		});

		it("should parse shorthand with ref and git: prefix", () => {
			const result = parseGitUrl("git:git@github.com:user/repo@v1.0.0");
			expect(result).toMatchObject({
				host: "github.com",
				path: "user/repo",
				ref: "v1.0.0",
				repo: "git@github.com:user/repo",
			});
		});
	});

	it("should reject unsafe Git install path inputs before URL normalization", () => {
		for (const source of [
			"git:git@evil.example:../../victim/repo",
			"git:git@evil.example:user/./repo",
			"git:git@evil.example:user//repo",
			"https://evil.example/a/../victim/repo",
			"https://evil.example//absolute/repo",
			"https://evil.example/..%2F..%2Fvictim/repo",
			"https://evil.example/%2e%2e%5cvictim/repo",
			"https://evil.example/user%2Frepo/name",
			"https://evil.example/%252e%252e/repo",
			"https://evil.example/%252e./repo",
			"https://evil.example/.%252e/repo",
			"https://evil.example/user/%252f/repo",
			"https://evil.example/user/repo%",
			"https://user%2Fname@evil.example/user/repo",
			"https://evil%0d.example/user/repo",
			"https://evil.example/C:%2Frepo/name",
			"git:git@evil.example:/absolute/repo",
			"git:git@evil.example:C:/absolute/repo",
			"git:git@evil.example:team/C:/repo",
			"git:git@evil.example:user\\repo/name",
			"git:git@evil.example:user/repo\0name",
			"git:git@evil.example:user/repo\rname",
			"git:git@evil.example:user/repo\nname",
			"git:git@evil.example:user/repo\u007fname",
			"git:evil%2fhost.example:user/repo",
		]) {
			expect(parseGitUrl(source), source).toBeNull();
		}
	});

	it("should preserve valid protocol casing, SSH syntax, nested paths, refs, and host identity", () => {
		expect(parseGitUrl("https://Git.Example.com/team/nested/repo.git@v1")).toMatchObject({
			host: "git.example.com",
			path: "team/nested/repo",
			ref: "v1",
		});
		expect(parseGitUrl("git:git@Git.Example.com:team/nested/repo.git@v1")).toMatchObject({
			host: "Git.Example.com",
			path: "team/nested/repo",
			ref: "v1",
		});
		expect(parseGitUrl("HTTPS://Git.Example.com/team/nested/repo")).toMatchObject({
			host: "git.example.com",
			path: "team/nested/repo",
		});
		expect(parseGitUrl("Git:git@Git.Example.com:team/nested/repo")).toMatchObject({
			host: "Git.Example.com",
			path: "team/nested/repo",
		});
	});

	describe("unsupported without git: prefix", () => {
		it("should reject git@host:path without git: prefix", () => {
			expect(parseGitUrl("git@github.com:user/repo")).toBeNull();
		});

		it("should reject host/path shorthand without git: prefix", () => {
			expect(parseGitUrl("github.com/user/repo")).toBeNull();
		});

		it("should reject user/repo shorthand", () => {
			expect(parseGitUrl("user/repo")).toBeNull();
		});
	});
});
