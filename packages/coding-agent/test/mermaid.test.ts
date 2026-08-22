import { stripVTControlCharacters } from "node:util";
import type { MermaidArt, Span } from "grok-mermaid";
import { describe, expect, it, vi } from "vitest";
import type { MarkdownTransformContext } from "../src/core/extensions/types.ts";
import {
	createMermaidMarkdownTransformer,
	type MermaidRenderingMode,
	type MermaidTransformerOptions,
} from "../src/modes/interactive/components/mermaid.ts";
import type { Theme, ThemeColor } from "../src/modes/interactive/theme/theme.ts";

interface TransformOptions {
	availableWidth?: number;
	isStreaming?: boolean;
	messageType?: MarkdownTransformContext["messageType"];
	mode?: MermaidRenderingMode;
	theme?: Theme;
	renderMermaid?: MermaidTransformerOptions["renderMermaid"];
}

function transformMermaid(markdown: string, options: TransformOptions = {}): string {
	const transformer = createMermaidMarkdownTransformer({
		getMode: () => options.mode ?? "streaming",
		theme: options.theme,
		renderMermaid: options.renderMermaid,
	});
	return transformer(markdown, {
		availableWidth: options.availableWidth ?? 200,
		isStreaming: options.isStreaming ?? false,
		messageType: options.messageType ?? "assistant",
	});
}

function mockArt(
	plain: string[],
	options: { styled?: Span[][]; warnings?: string[]; width?: number } = {},
): MermaidArt {
	return {
		plain,
		styled: options.styled ?? plain.map((line) => [{ text: line, cls: "none" }]),
		warnings: options.warnings ?? [],
		width: options.width ?? Math.max(0, ...plain.map((line) => [...line].length)),
	};
}

const SUPPORTED_DIAGRAMS = [
	["flowchart", "flowchart LR\n  A[Start] --> B[Done]"],
	["state", "stateDiagram-v2\n  [*] --> Idle\n  Idle --> [*]"],
	["class", "classDiagram\n  class Animal"],
	["entity relationship", "erDiagram\n  CUSTOMER ||--o{ ORDER : places"],
	["sequence", "sequenceDiagram\n  Alice->>Bob: Hello"],
] as const;

describe("Mermaid adapter", () => {
	it.each(SUPPORTED_DIAGRAMS)("renders a supported %s diagram", (_name, source) => {
		const fence = `\`\`\`mermaid\n${source}\n\`\`\``;
		const rendered = transformMermaid(fence);
		expect(rendered).not.toContain("```mermaid");
		expect(rendered).toContain("`");
	});

	it("recognizes the first language word case-insensitively and preserves unrelated fences", () => {
		const mermaid = "```MeRmAiD linenums\nflowchart LR\n  A --> B\n```";
		expect(transformMermaid(mermaid)).not.toContain("```MeRmAiD");

		const unrelated = "Before\n\n```typescript\nconst value = 1;\n```\nAfter";
		expect(transformMermaid(unrelated)).toBe(unrelated);
	});

	it("preserves unsupported, invalid, and nested Mermaid fences", () => {
		const unsupported = '```mermaid\npie\n  title Pets\n  "Dogs" : 4\n```';
		const invalid = "```mermaid\nflowchart LR\n  -->\n```";
		const nestedList = "- diagram\n\n  ```mermaid\n  flowchart LR\n    A --> B\n  ```";
		const nestedQuote = "> ```mermaid\n> flowchart LR\n>   A --> B\n> ```";

		expect(transformMermaid(unsupported)).toBe(unsupported);
		expect(transformMermaid(invalid)).toBe(invalid);
		expect(transformMermaid(nestedList)).toBe(nestedList);
		expect(transformMermaid(nestedQuote)).toBe(nestedQuote);
	});

	it("preserves original CRLF and CR bytes on fallback and around replacements", () => {
		const unsupported = "Before\r\n\r\n```mermaid\r\npie\r\n  title Pets\r\n```\r\nAfter";
		expect(transformMermaid(unsupported)).toBe(unsupported);

		const supported = "Before\r\n\r\n```mermaid\rflowchart LR\r  A --> B\r```\r\nAfter";
		const rendered = transformMermaid(supported);
		expect(rendered).toMatch(/^Before\r\n\r\n/);
		expect(rendered).toMatch(/ {2}\r\nAfter$/);
		expect(rendered).not.toMatch(/(?<!\r)\n/);
		expect(rendered).not.toContain("```mermaid");

		const noFinalNewline = "```mermaid\nflowchart LR\n  A --> B\n```";
		const noFinalOutput = transformMermaid(noFinalNewline);
		expect(noFinalOutput.endsWith("\n") || noFinalOutput.endsWith("\r")).toBe(false);
	});

	it("encodes backticks, blank rows, and Markdown metacharacters as collision-safe code spans", () => {
		const art = mockArt(["`edge`", "", "a * [b] <tag> &amp;"]);
		const source = "```mermaid\nflowchart LR\n  A --> B\n```";
		const rendered = transformMermaid(source, { renderMermaid: () => art });

		expect(rendered).toContain("`` `edge` ``  \n");
		expect(rendered).toContain("`\u00a0`  \n");
		expect(rendered).toContain("`a * [b] <tag> &amp;`");
	});

	it("maps every semantic span through ANSI-only theme styles without changing visible text", () => {
		const fg = vi.fn((_color: ThemeColor, text: string) => `\x1b[31m${text}\x1b[39m`);
		const bold = vi.fn((text: string) => `\x1b[1m${text}\x1b[22m`);
		const theme = { fg, bold } as unknown as Theme;
		const spans: Span[] = [
			{ text: "B", cls: "border" },
			{ text: "T", cls: "text" },
			{ text: "E", cls: "edge" },
			{ text: "L", cls: "edgeLabel" },
			{ text: "H", cls: "title" },
			{ text: "N", cls: "none" },
		];
		const art = mockArt(["BTELHN"], { styled: [spans] });
		const rendered = transformMermaid("```mermaid\nflowchart LR\nA --> B\n```", {
			theme,
			renderMermaid: () => art,
		});

		expect(stripVTControlCharacters(rendered)).toContain("BTELHN");
		expect(fg.mock.calls.map(([color]) => color)).toEqual(["borderMuted", "text", "accent", "muted", "accent"]);
		expect(bold).toHaveBeenCalledWith("H");
	});

	it("rejects theme output that adds visible text or non-SGR terminal controls", () => {
		const source = "```mermaid\nflowchart LR\nA --> B\n```";
		const art = mockArt(["A"], { styled: [[{ text: "A", cls: "text" }]] });
		const visibleTheme = { fg: (_color: ThemeColor, text: string) => `x${text}`, bold: (text: string) => text };
		const oscTheme = {
			fg: (_color: ThemeColor, text: string) => `\x1b]8;;https://example.com\x07${text}\x1b]8;;\x07`,
			bold: (text: string) => text,
		};

		expect(transformMermaid(source, { theme: visibleTheme as Theme, renderMermaid: () => art })).toBe(source);
		expect(transformMermaid(source, { theme: oscTheme as Theme, renderMermaid: () => art })).toBe(source);
	});

	it("strips unsafe source controls through the dependency render path", () => {
		const source = "```mermaid\nflowchart LR\n  A[bad\u001b] --> B[ok\u0085]\n```";
		const rendered = transformMermaid(source);
		expect(rendered).not.toContain("\u001b");
		expect(rendered).not.toContain("\u0085");
		expect(rendered).not.toContain("```mermaid");
	});

	it("preserves final warning sources safely and summarizes additional warnings", () => {
		const source = "```mermaid\nflowchart LR\nA --> B\n```";
		const art = mockArt(["A ───▶ B"], { warnings: ["bad `edge`", "second warning"] });
		const rendered = transformMermaid(source, { renderMermaid: () => art });

		expect(rendered).toContain(source);
		expect(rendered).toContain("``Mermaid diagram not rendered: bad `edge` (+1 more)``");
		expect(rendered).not.toContain("second warning");
	});

	it("rejects sparse warning arrays instead of interpolating missing warnings", () => {
		const source = "```mermaid\nflowchart LR\nA --> B\n```";
		const warnings: string[] = [];
		warnings.length = 1;
		expect(transformMermaid(source, { renderMermaid: () => mockArt(["A"], { warnings }) })).toBe(source);
	});

	it("shows partial art without warning text while streaming", () => {
		const source = "```mermaid\nflowchart LR\nA -->";
		const art = mockArt(["A ───▶"], { warnings: ["incomplete"] });
		const rendered = transformMermaid(source, { isStreaming: true, renderMermaid: () => art });

		expect(rendered).not.toContain("```mermaid");
		expect(rendered).not.toContain("Mermaid diagram not rendered");
		expect(rendered).toContain("A ───▶");
	});

	it("respects rendering modes and excludes assistant thinking without invoking the renderer", () => {
		const source = "```mermaid\nflowchart LR\nA --> B\n```";
		const renderMermaid = vi.fn(() => mockArt(["A ───▶ B"]));

		expect(transformMermaid(source, { mode: "off", renderMermaid })).toBe(source);
		expect(transformMermaid(source, { mode: "final", isStreaming: true, renderMermaid })).toBe(source);
		expect(transformMermaid(source, { messageType: "assistant-thinking", renderMermaid })).toBe(source);
		expect(renderMermaid).not.toHaveBeenCalled();
		expect(transformMermaid(source, { mode: "final", renderMermaid })).not.toContain("```mermaid");
		expect(renderMermaid).toHaveBeenCalledTimes(1);
	});

	it("enforces source, width, row, and area limits before reconstruction", () => {
		const source = "```mermaid\nflowchart LR\nA --> B\n```";
		const oversizedRenderer = vi.fn(() => mockArt(["unused"]));
		const oversizedSource = `\`\`\`mermaid\n${"x".repeat(64 * 1024 + 1)}\n\`\`\``;
		expect(transformMermaid(oversizedSource, { renderMermaid: oversizedRenderer })).toBe(oversizedSource);
		expect(oversizedRenderer).not.toHaveBeenCalled();

		expect(transformMermaid(source, { availableWidth: 10, renderMermaid: () => mockArt(["x".repeat(11)]) })).toBe(
			source,
		);
		expect(transformMermaid(source, { renderMermaid: () => mockArt(Array.from({ length: 201 }, () => "x")) })).toBe(
			source,
		);
		expect(
			transformMermaid(source, {
				availableWidth: 500,
				renderMermaid: () => mockArt(Array.from({ length: 101 }, () => "x".repeat(500))),
			}),
		).toBe(source);
	});

	it.each([
		null,
		{},
		{ plain: ["x"], styled: [], width: 1, warnings: [] },
		{ plain: ["x"], styled: [[{ text: "y", cls: "none" }]], width: 1, warnings: [] },
		{ plain: ["x"], styled: [[{ text: "x", cls: "invalid" }]], width: 1, warnings: [] },
		{ plain: ["x\n"], styled: [[{ text: "x\n", cls: "none" }]], width: 1, warnings: [] },
		{ plain: ["x"], styled: [[{ text: "x", cls: "none" }]], width: Number.NaN, warnings: [] },
	])("falls back for invalid art shape %#", (invalidArt) => {
		const source = "```mermaid\nflowchart LR\nA --> B\n```";
		expect(transformMermaid(source, { renderMermaid: () => invalidArt })).toBe(source);
	});

	it("isolates renderer failures per fence and invokes each eligible fence once", () => {
		const first = "```mermaid\nflowchart LR\nA --> B\n```";
		const second = "```mermaid\nflowchart LR\nC --> D\n```";
		const renderMermaid = vi
			.fn<NonNullable<MermaidTransformerOptions["renderMermaid"]>>()
			.mockImplementationOnce(() => {
				throw new Error("parser failed");
			})
			.mockImplementationOnce(() => mockArt(["C ───▶ D"]));
		const rendered = transformMermaid(`${first}\n${second}`, { renderMermaid });

		expect(rendered).toContain(first);
		expect(rendered).toContain("C ───▶ D");
		expect(renderMermaid).toHaveBeenCalledTimes(2);
	});
});
