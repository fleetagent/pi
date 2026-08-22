import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.ts";
import { visibleWidth } from "../src/utils.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

describe("Markdown transform", () => {
	it("runs before tab normalization and parsing with the exact effective content width", () => {
		const calls: Array<[string, number]> = [];
		const transform = (markdown: string, availableWidth: number): string => {
			calls.push([markdown, availableWidth]);
			return `${markdown}\t**${availableWidth}**`;
		};
		const markdown = new Markdown("source", 3, 0, defaultMarkdownTheme, undefined, { transform });

		const lines = markdown.render(4);

		assert.deepEqual(calls, [["source", 2]]);
		assert.doesNotMatch(lines.join("\n"), /\t/);
		assert.ok(lines.every((line) => visibleWidth(line) <= 4));
	});

	it("caches by source and width and reruns after width, text, or explicit invalidation changes", () => {
		let callCount = 0;
		const transform = (markdown: string): string => {
			callCount++;
			return markdown;
		};
		const markdown = new Markdown("one", 1, 0, defaultMarkdownTheme, undefined, { transform });

		markdown.render(20);
		markdown.render(20);
		assert.equal(callCount, 1);

		markdown.render(21);
		assert.equal(callCount, 2);

		markdown.setText("two");
		markdown.render(21);
		assert.equal(callCount, 3);

		markdown.invalidate();
		markdown.render(21);
		assert.equal(callCount, 4);
	});

	it("uses transformed emptiness rather than source emptiness", () => {
		const markdown = new Markdown("", 0, 0, defaultMarkdownTheme, undefined, {
			transform: () => "created",
		});
		assert.match(markdown.render(20).join("\n"), /created/);
	});
});
