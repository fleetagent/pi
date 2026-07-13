import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Loader } from "../src/components/loader.ts";
import type { TUI } from "../src/tui.ts";

describe("Loader lifecycle", () => {
	it("does not start an interval until rendered or explicitly started", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		let renderRequests = 0;
		const ui = { requestRender: () => renderRequests++ } as unknown as TUI;
		const loader = new Loader(
			ui,
			(text) => text,
			(text) => text,
		);
		try {
			const constructorRequests = renderRequests;
			mock.timers.tick(500);
			assert.equal(renderRequests, constructorRequests);

			loader.render(80);
			mock.timers.tick(80);
			assert.ok(renderRequests > constructorRequests);
		} finally {
			loader.stop();
			mock.timers.reset();
		}
	});
});
