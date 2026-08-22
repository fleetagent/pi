import { describe, expect, it } from "vitest";
import { formatProviderError, normalizeProviderError } from "../src/utils/error-body.ts";

describe("provider error body object classification", () => {
	it("preserves an AWS validation message instead of serializing a response wrapper", () => {
		class SdkHttpResponseBody {
			locked = false;
			state = { storedError: undefined };
		}
		const error = Object.assign(new Error("Input is too long for requested model."), {
			name: "ValidationException",
			$metadata: { httpStatusCode: 400 },
			$response: { statusCode: 400, body: new SdkHttpResponseBody() },
		});

		const normalized = normalizeProviderError(error);

		expect(normalized).toMatchObject({
			status: 400,
			body: undefined,
			message: "Input is too long for requested model.",
			messageCarriesBody: true,
		});
		expect(formatProviderError(normalized, "Validation error")).toBe(
			"Validation error (400): Input is too long for requested model.",
		);
	});

	it("preserves the SDK message when error contains a class instance", () => {
		class SdkInnerError {
			code = "EPROTO";
			internalState = {};
		}
		const error = Object.assign(new Error("TLS handshake failed"), {
			status: 502,
			error: new SdkInnerError(),
		});

		const normalized = normalizeProviderError(error);

		expect(normalized.body).toBeUndefined();
		expect(normalized.messageCarriesBody).toBe(true);
		expect(formatProviderError(normalized)).toBe("TLS handshake failed");
	});

	it("does not treat arrays and built-in transport-shaped objects as parsed object bodies", () => {
		for (const candidate of [["gateway error"], new ReadableStream(), new URL("https://provider.invalid/error")]) {
			const normalized = normalizeProviderError(
				Object.assign(new Error("Provider transport failed"), { status: 502, error: candidate }),
			);
			expect(normalized.body).toBeUndefined();
			expect(normalized.messageCarriesBody).toBe(true);
		}
	});

	it("still surfaces ordinary and null-prototype parsed JSON objects", () => {
		const nullPrototypeBody = Object.assign(Object.create(null) as Record<string, unknown>, {
			message: "quota exceeded",
			limit: 10,
		});

		for (const candidate of [{ message: "schema validation failed", field: "tools[0]" }, nullPrototypeBody]) {
			const normalized = normalizeProviderError(
				Object.assign(new Error("400 status code (no body)"), { status: 400, error: candidate }),
			);
			expect(normalized.body).toBe(JSON.stringify(candidate));
			expect(normalized.messageCarriesBody).toBe(false);
			expect(formatProviderError(normalized)).toBe(`400: ${JSON.stringify(candidate)}`);
		}
	});

	it("continues to ignore empty plain objects", () => {
		const normalized = normalizeProviderError(
			Object.assign(new Error("400 status code (no body)"), { status: 400, error: {} }),
		);

		expect(normalized.body).toBeUndefined();
		expect(normalized.messageCarriesBody).toBe(true);
	});
});
