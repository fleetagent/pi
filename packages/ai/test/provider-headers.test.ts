import { describe, expect, it } from "vitest";
import { providerHeadersToRecord } from "../src/utils/headers.ts";

describe("providerHeadersToRecord", () => {
	it("applies null deletion markers case-insensitively", () => {
		expect(
			providerHeadersToRecord({
				Authorization: "Bearer secret",
				authorization: null,
			}),
		).toBeUndefined();
	});

	it("uses the last case-insensitive override and preserves its spelling", () => {
		expect(
			providerHeadersToRecord({
				"X-Trace-Id": null,
				"x-trace-id": "trace-123",
				"X-Tenant": "first",
				"x-tenant": "last",
			}),
		).toEqual({
			"x-trace-id": "trace-123",
			"x-tenant": "last",
		});
	});
});
