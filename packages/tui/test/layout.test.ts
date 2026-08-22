import assert from "node:assert";
import { describe, it } from "node:test";
import { HStack, ScrollView, Text, VStack } from "../src/index.ts";
import { getScrollViewsAt, renderLayoutFrame } from "../src/layout.ts";
import { encodeKitty, registerKittyImageMetadata } from "../src/terminal-image.ts";
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";

function visibleLines(lines: string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line).trimEnd());
}

describe("viewport layout", () => {
	it("allocates vertical grow space deterministically", () => {
		const frame = renderLayoutFrame(
			new VStack([
				{ component: new Text("top", 0, 0), basis: 1, shrink: 0 },
				{ component: new Text("body", 0, 0), basis: 0, grow: 1 },
			]),
			10,
			4,
			() => {},
		);

		assert.deepStrictEqual(
			frame.root.children.map((child) => child.rect.height),
			[1, 3],
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["top", "body", "", ""]);
	});

	it("does not render fixed-basis scroll content during stack measurement", () => {
		let renderCount = 0;
		const transcript = new ScrollView({
			render: () => {
				renderCount += 1;
				return ["one", "two", "three"];
			},
			invalidate: () => {},
		});
		const root = new VStack([
			{ component: transcript, basis: 0, grow: 1 },
			{ component: new Text("dock", 0, 0), basis: "auto" },
		]);
		renderLayoutFrame(root, 10, 3, () => {});
		assert.strictEqual(renderCount, 1);
	});

	it("paints only clipped rows from very large scroll content", () => {
		const lineCount = 1_000_000_000;
		const lines: string[] = [];
		lines.length = lineCount;
		lines[lineCount - 4] = "before";
		lines[lineCount - 3] = "visible 1";
		lines[lineCount - 2] = "visible 2";
		lines[lineCount - 1] = "visible 3";
		const transcript = new ScrollView(
			{
				render: () => lines,
				invalidate: () => {},
			},
			{ follow: "end" },
		);

		const frame = renderLayoutFrame(transcript, 10, 3, () => {});
		assert.deepStrictEqual(visibleLines(frame.lines), ["visible 1", "visible 2", "visible 3"]);
	});

	it("shrinks entries to their minimum sizes", () => {
		const frame = renderLayoutFrame(
			new VStack([
				{ component: new Text("a1\na2\na3", 0, 0), shrink: 1, minSize: 1 },
				{ component: new Text("b1\nb2\nb3", 0, 0), shrink: 0 },
			]),
			10,
			4,
			() => {},
		);

		assert.deepStrictEqual(
			frame.root.children.map((child) => child.rect.height),
			[1, 3],
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["a1", "b1", "b2", "b3"]);
	});

	it("includes nested minimum sizes in intrinsic stack measurement", () => {
		const dock = new VStack([
			new Text("top1\ntop2\ntop3", 0, 0),
			{ component: new Text("selector", 0, 0), minSize: 3 },
			new Text("below", 0, 0),
			{ component: new Text("footer", 0, 0), minSize: 1 },
		]);
		const frame = renderLayoutFrame(
			new VStack([
				{ component: new Text("body", 0, 0), basis: 0, grow: 1, minSize: 1 },
				{ component: dock, basis: "auto", minSize: 1 },
			]),
			10,
			9,
			() => {},
		);

		assert.deepStrictEqual(visibleLines(frame.lines), [
			"body",
			"top1",
			"top2",
			"top3",
			"selector",
			"",
			"",
			"below",
			"footer",
		]);
	});

	it("crops Kitty images at a scroll view's lower boundary", () => {
		const imageId = 124;
		const imageLine = encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
		registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
		const transcript = new ScrollView({
			render: () => ["one", "two", imageLine, "", ""],
			invalidate: () => {},
		});
		const frame = renderLayoutFrame(
			new VStack([{ component: transcript, basis: 0, grow: 1 }, new Text("dock", 0, 0)]),
			20,
			4,
			() => {},
		);

		assert.ok(frame.lines[2]?.includes("y=0,h=34,r=1"));
		assert.strictEqual(stripTerminalSequences(frame.lines[3] ?? "").trimEnd(), "dock");
	});

	it("omits gaps around invisible entries", () => {
		const stack = new VStack(
			[new Text("one", 0, 0), { component: new Text("hidden", 0, 0), visible: () => false }, new Text("two", 0, 0)],
			{ gap: 1 },
		);
		assert.deepStrictEqual(
			stack.render(10).map((line) => line.trimEnd()),
			["one", "", "two"],
		);
	});

	it("composes horizontal children at allocated widths", () => {
		const frame = renderLayoutFrame(
			new HStack([
				{ component: new Text("left", 0, 0), basis: 6, shrink: 0 },
				{ component: new Text("right", 0, 0), basis: 6, shrink: 0 },
			]),
			12,
			1,
			() => {},
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["left  right"]);
	});

	it("does not paint zero-width horizontal children", () => {
		const frame = renderLayoutFrame(
			new HStack([
				{ component: new Text("hidden", 0, 0), basis: 0, shrink: 0 },
				{ component: new Text("shown", 0, 0), basis: 0, grow: 1 },
			]),
			5,
			1,
			() => {},
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["shown"]);
	});

	it("tracks follow-end state and returns unused scroll delta", () => {
		const scrollView = new ScrollView(new Text("1\n2\n3\n4\n5\n6", 0, 0), {
			follow: "end",
			primary: true,
		});
		renderLayoutFrame(scrollView, 10, 3, () => {});
		assert.strictEqual(scrollView.scrollTop, 3);
		assert.strictEqual(scrollView.isFollowingEnd, true);

		assert.strictEqual(scrollView.scrollBy(-2), 0);
		assert.strictEqual(scrollView.scrollTop, 1);
		assert.strictEqual(scrollView.isFollowingEnd, false);
		assert.strictEqual(scrollView.scrollBy(-3), -2);
		assert.strictEqual(scrollView.scrollTop, 0);
		assert.strictEqual(scrollView.scrollBy(10), 7);
		assert.strictEqual(scrollView.scrollTop, 3);
		assert.strictEqual(scrollView.isFollowingEnd, true);
	});

	it("renders transient, hidden, and reserved-column scrollbar policies", async () => {
		const sourceLines = ["abcd界", "abcde2", "abcde3", "abcde4", "abcde5", "abcde6", "abcde7", "abcde8"];
		const contentBackground = "\x1b[42m";
		const scrollbarBackground = "\x1b[48;5;1m";
		const scrollbarStyle = (text: string) => `${scrollbarBackground}${text}\x1b[49m`;
		const content = new Text(sourceLines.join("\n"), 0, 0, (text) => `${contentBackground}${text}\x1b[49m`);
		const scrollView = new ScrollView(content, {
			scrollbar: "auto",
			scrollbarStyle,
			scrollbarHideDelayMs: 10,
		});
		const render = () => renderLayoutFrame(scrollView, 6, 4, () => {}).lines;
		const thumbRows = (lines: string[]) => lines.map((line) => line.includes(scrollbarBackground));

		let lines = render();
		assert.deepStrictEqual(thumbRows(lines), [false, false, false, false]);
		assert.deepStrictEqual(lines.map(stripTerminalSequences), sourceLines.slice(0, 4));

		scrollView.scrollBy(2);
		lines = render();
		assert.deepStrictEqual(thumbRows(lines), [false, true, true, false]);
		assert.deepStrictEqual(lines.map(stripTerminalSequences), sourceLines.slice(2, 6));
		assert.ok(lines[1]!.lastIndexOf(contentBackground) < lines[1]!.lastIndexOf(scrollbarBackground));

		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.deepStrictEqual(thumbRows(render()), [false, false, false, false]);

		scrollView.setScrollbar("hidden");
		scrollView.scrollToEnd();
		assert.ok(render().every((line) => !line.includes(scrollbarBackground)));

		const always = new ScrollView(new Text("123456\nsecond", 0, 0), { scrollbar: "always", scrollbarStyle });
		const alwaysFrame = renderLayoutFrame(always, 6, 4, () => {});
		assert.strictEqual(alwaysFrame.root.children[0]?.rect.width, 5);
		assert.ok(alwaysFrame.lines.every((line) => line.includes(scrollbarBackground)));

		always.setScrollbar("hidden");
		const hiddenFrame = renderLayoutFrame(always, 6, 4, () => {});
		assert.strictEqual(hiddenFrame.root.children[0]?.rect.width, 6);
		assert.ok(hiddenFrame.lines.every((line) => !line.includes(scrollbarBackground)));

		always.setScrollbar("always");
		const narrowFrame = renderLayoutFrame(always, 1, 2, () => {});
		assert.strictEqual(narrowFrame.root.children[0]?.rect.width, 1);
		assert.ok(narrowFrame.lines.every((line) => visibleWidth(line) <= 1));
	});

	it("measures nested scroll content from constrained child geometry", () => {
		const inner = new ScrollView(new Text("1\n2\n3\n4\n5\n6", 0, 0));
		const outer = new ScrollView(new VStack([{ component: inner, basis: 2 }, new Text("tail", 0, 0)]));
		renderLayoutFrame(outer, 10, 2, () => {});

		assert.strictEqual(inner.viewportHeight, 2);
		assert.strictEqual(outer.scrollBy(10), 9);
		assert.strictEqual(outer.scrollTop, 1);
	});

	it("rebuilds geometry after content changes", () => {
		const text = new Text("one", 0, 0);
		const root = new VStack([text]);
		const first = renderLayoutFrame(root, 10, 4, () => {});
		text.setText("one\ntwo\nthree");
		const second = renderLayoutFrame(root, 10, 4, () => {});

		assert.strictEqual(first.root.children[0]?.lines?.length, 1);
		assert.strictEqual(second.root.children[0]?.lines?.length, 3);
	});

	it("clips nested scroll content and routes hit tests deepest-first", () => {
		const inner = new ScrollView(new Text("one\ntwo\nthree\nfour", 0, 0));
		const outer = new ScrollView(new VStack([{ component: inner, basis: 2 }, new Text("outer-tail", 0, 0)]));
		let frame = renderLayoutFrame(outer, 8, 2, () => {});
		assert.deepStrictEqual(visibleLines(frame.lines), ["one", "two"]);
		assert.deepStrictEqual(getScrollViewsAt(frame, 0, 0), [inner, outer]);
		assert.strictEqual(inner.scrollBy(2), 0);
		frame = renderLayoutFrame(outer, 8, 2, () => {});
		assert.deepStrictEqual(visibleLines(frame.lines), ["three", "four"]);
		assert.ok(!frame.lines.some((line) => line.includes("outer-tail")));
	});

	it("clips every row and column to the viewport at narrow sizes", () => {
		const overflowing = {
			render: () => ["LEFT-OVERFLOW", "VERTICAL-OVERFLOW"],
			invalidate: () => {},
		};
		const right = { render: () => ["RIGHT-OVERFLOW"], invalidate: () => {} };
		const horizontal = renderLayoutFrame(
			new HStack([
				{ component: overflowing, basis: 2 },
				{ component: right, basis: 2 },
			]),
			4,
			1,
			() => {},
		);
		assert.strictEqual(horizontal.lines.length, 1);
		assert.deepStrictEqual(visibleLines(horizontal.lines), ["LERI"]);
		assert.ok(horizontal.lines.every((line) => visibleWidth(line) <= horizontal.width));

		const nestedHorizontal = renderLayoutFrame(
			new HStack([
				{
					component: new HStack([
						{ component: { render: () => ["AA"], invalidate: () => {} }, basis: 2, shrink: 0 },
						{ component: { render: () => ["XX"], invalidate: () => {} }, basis: 2, shrink: 0 },
					]),
					basis: 2,
					shrink: 0,
				},
				{ component: { render: () => [], invalidate: () => {} }, basis: 2, shrink: 0 },
			]),
			4,
			1,
			() => {},
		);
		assert.deepStrictEqual(visibleLines(nestedHorizontal.lines), ["AA"]);
		assert.ok(!nestedHorizontal.lines[0]?.includes("X"));

		const vertical = renderLayoutFrame(
			new VStack([
				{ component: overflowing, basis: 1, shrink: 0 },
				{ component: new Text("OUTSIDE", 0, 0), basis: 1, shrink: 0 },
			]),
			4,
			1,
			() => {},
		);
		assert.strictEqual(vertical.lines.length, 1);
		assert.deepStrictEqual(visibleLines(vertical.lines), ["LEFT"]);
		assert.ok(vertical.lines.every((line) => visibleWidth(line) <= vertical.width));
		assert.ok(!vertical.lines.some((line) => line.includes("OVERFLOW") || line.includes("OUTSIDE")));

		const oneColumn = renderLayoutFrame(
			new HStack([
				{ component: new Text("hidden", 0, 0), basis: 0, shrink: 0 },
				{ component: new Text("shown", 0, 0), basis: 0, grow: 1 },
			]),
			1,
			1,
			() => {},
		);
		assert.strictEqual(oneColumn.lines.length, 1);
		assert.ok(oneColumn.lines.every((line) => visibleWidth(line) <= 1));
	});

	it("reflows and clamps follow-end scrolling across wide and narrow resizes", () => {
		const text = new Text("alpha beta gamma delta epsilon", 0, 0);
		const scrollView = new ScrollView(text, { follow: "end", primary: true });
		const sizes = [
			[12, 2],
			[2, 3],
			[20, 4],
		] as const;
		for (const [width, height] of sizes) {
			const frame = renderLayoutFrame(scrollView, width, height, () => {});
			assert.strictEqual(frame.lines.length, height);
			assert.ok(frame.lines.every((line) => visibleWidth(line) <= width));
			assert.strictEqual(scrollView.viewportHeight, height);
			assert.strictEqual(scrollView.isFollowingEnd, true);
		}
	});

	it("keeps component identities and caches repeated measurements within a frame", () => {
		let renders = 0;
		const child = {
			render: (width: number) => {
				renders++;
				return ["x".repeat(width)];
			},
			invalidate: () => {},
		};
		const root = new HStack([
			{ component: child, basis: 2 },
			{ component: child, basis: 2 },
		]);
		const frame = renderLayoutFrame(root, 4, 1, () => {});
		assert.strictEqual(frame.root.children[0]?.component, child);
		assert.strictEqual(frame.root.children[1]?.component, child);
		assert.strictEqual(renders, 1);
		assert.deepStrictEqual(visibleLines(root.render(4)), ["xxxx"]);
		assert.deepStrictEqual(new VStack([child]).render(2), ["xx"]);
		assert.deepStrictEqual(new ScrollView(child).render(3), ["xxx"]);
	});
});
