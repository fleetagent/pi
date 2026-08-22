import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("export HTML markdown link sanitization", () => {
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");
	const escapeHtmlSource = templateJs.match(/function escapeHtml\(text\) \{[\s\S]*?^ {6}\}/m)?.[0];
	const sanitizeMarkdownUrlSource = templateJs.match(/function sanitizeMarkdownUrl\(value\) \{[\s\S]*?^ {6}\}/m)?.[0];

	it("escapes quote characters before values are interpolated into attributes", () => {
		expect(escapeHtmlSource).toBeDefined();
		const escapeHtml = new Function(`${escapeHtmlSource}; return escapeHtml;`)() as (text: unknown) => string;

		expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
		expect(escapeHtml(`" onmouseover="alert(1)`)).toBe("&quot; onmouseover=&quot;alert(1)");
		expect(escapeHtml(`' autofocus onfocus='alert(1)`)).toBe("&#39; autofocus onfocus=&#39;alert(1)");
	});

	it("uses scheme allow-list sanitization for markdown links", () => {
		expect(templateJs).toMatch(/link\s*\(\s*token\s*\)/);
		expect(templateJs).toMatch(/sanitizeMarkdownUrl\(token\.href\)/);
		expect(templateJs).toMatch(/\^\(https\?\|mailto\|tel\|ftp\)/);
	});

	it("uses scheme allow-list sanitization for markdown images", () => {
		expect(templateJs).toMatch(/image\s*\(\s*token\s*\)/);
		expect(templateJs).toMatch(/sanitizeMarkdownUrl\(token\.href\)/);
	});

	it("rejects unsafe and control-character-obfuscated markdown URLs", () => {
		expect(sanitizeMarkdownUrlSource).toBeDefined();
		const sanitizeMarkdownUrl = new Function(`${sanitizeMarkdownUrlSource}; return sanitizeMarkdownUrl;`)() as (
			value: unknown,
		) => string | null;

		for (const href of [
			"javascript:alert(1)",
			"JaVaScRiPt:alert(1)",
			"java\u0000script:alert(1)",
			"java\nscript:alert(1)",
			"vbscript:msgbox(1)",
			"data:text/html,<script>alert(1)</script>",
			"file:///etc/passwd",
			"blob:https://example.com/id",
		]) {
			expect(sanitizeMarkdownUrl(href)).toBeNull();
		}

		expect(sanitizeMarkdownUrl(" HTTPS://example.com/path ")).toBe("HTTPS://example.com/path");
		expect(sanitizeMarkdownUrl("mailto:user@example.com")).toBe("mailto:user@example.com");
		expect(sanitizeMarkdownUrl("tel:+15551234567")).toBe("tel:+15551234567");
		expect(sanitizeMarkdownUrl("ftp://example.com/file")).toBe("ftp://example.com/file");
		expect(sanitizeMarkdownUrl("/relative/path")).toBe("/relative/path");
		expect(sanitizeMarkdownUrl("#fragment")).toBe("#fragment");
		expect(sanitizeMarkdownUrl("https://exam\u007fple.com")).toBe("https://example.com");
	});

	it("preserves escaped embedded session images outside the markdown renderer", () => {
		expect(templateJs).toMatch(
			/images\.map\(img => `<img src="data:\$\{escapeHtml\(img\.mimeType \|\| 'image\/png'\)\};base64,\$\{escapeHtml\(img\.data \|\| ''\)\}"/,
		);
	});

	it("escapes href attributes in the custom link renderer", () => {
		// The link renderer must escape href values to prevent attribute breakout
		expect(templateJs).toMatch(/escapeHtml\(href\)/);
	});

	it("escapes image mimeType attributes", () => {
		// Image mimeType must be escaped to prevent attribute breakout
		expect(templateJs).not.toMatch(/\$\{img\.mimeType\}/);
		expect(templateJs).toMatch(/escapeHtml\(img\.mimeType/);
	});

	it("escapes image data attributes", () => {
		// Image data is embedded in src attributes and must not allow attribute breakout.
		expect(templateJs).not.toMatch(/;base64,\$\{img\.data\}"/);
		expect(templateJs).toMatch(/;base64,\$\{escapeHtml\(img\.data \|\| (?:''|"")\)\}"/);
	});

	it("escapes entry IDs before inserting them into attributes", () => {
		// Session entry IDs are embedded in id and data-entry-id attributes.
		expect(templateJs).not.toMatch(/id="\$\{entryId\}"/);
		expect(templateJs).not.toMatch(/data-entry-id="\$\{entryId\}"/);
		expect(templateJs).toMatch(/entry-\$\{escapeHtml\(entry\.id\)\}/);
		expect(templateJs).toMatch(/data-entry-id="\$\{escapeHtml\(entryId\)\}"/);
	});

	it("escapes tree metadata rendered from session fields", () => {
		// The tree renders session metadata via innerHTML, so dynamic fields must be escaped.
		expect(templateJs).not.toMatch(/\[\$\{msg\.toolName \|\| 'tool'\}\]/);
		expect(templateJs).not.toMatch(/\[\$\{msg\.role\}\]/);
		expect(templateJs).not.toMatch(/\[model: \$\{entry\.modelId\}\]/);
		expect(templateJs).not.toMatch(/\[thinking: \$\{entry\.thinkingLevel\}\]/);
		expect(templateJs).not.toMatch(/\[\$\{entry\.type\}\]/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(msg\.toolName \|\| 'tool'\)\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(msg\.role\)\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(entry\.modelId\)\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(entry\.thinkingLevel\)\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(entry\.type\)\}/);
	});

	it("escapes model names in the exported header", () => {
		// Assistant message provider/model values are collected from the session and rendered with innerHTML.
		expect(templateJs).not.toMatch(/\$\{globalStats\.models\.join\(', '\) \|\| 'unknown'\}/);
		expect(templateJs).toMatch(/\$\{escapeHtml\(globalStats\.models\.join\(', '\) \|\| 'unknown'\)\}/);
	});
});
