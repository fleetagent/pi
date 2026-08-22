import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { openBrowser } from "../src/utils/open-browser.ts";

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

describe("openBrowser", () => {
	let onMock: ReturnType<typeof vi.fn>;
	let unrefMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		onMock = vi.fn();
		unrefMock = vi.fn();
		onMock.mockReturnValue({ unref: unrefMock });
		spawnMock.mockReturnValue({ on: onMock });
	});

	afterEach(() => {
		spawnMock.mockReset();
		if (originalPlatformDescriptor) {
			Object.defineProperty(process, "platform", originalPlatformDescriptor);
		}
	});

	it("opens macOS targets with a detached argv-based process", () => {
		setPlatform("darwin");
		openBrowser("https://example.com/login?state=a&code=b");

		expect(spawnMock).toHaveBeenCalledWith("open", ["https://example.com/login?state=a&code=b"], {
			stdio: "ignore",
			detached: true,
		});
		expect(unrefMock).toHaveBeenCalledOnce();
	});

	it("opens Linux targets with a detached argv-based process and ignores launcher errors", () => {
		setPlatform("linux");
		openBrowser("https://example.com/login");

		expect(spawnMock).toHaveBeenCalledWith("xdg-open", ["https://example.com/login"], {
			stdio: "ignore",
			detached: true,
		});
		expect(onMock).toHaveBeenCalledWith("error", expect.any(Function));
		const errorHandler = onMock.mock.calls[0]?.[1] as (() => void) | undefined;
		expect(errorHandler).toBeDefined();
		expect(() => errorHandler?.()).not.toThrow();
	});

	it("uses rundll32 on Windows without shell parsing metacharacters", () => {
		setPlatform("win32");
		const target = "https://example.com/login?state=a&next=b|calc.exe^&x=1";
		openBrowser(target);

		expect(spawnMock).toHaveBeenCalledWith("rundll32", ["url.dll,FileProtocolHandler", target], {
			stdio: "ignore",
			detached: true,
		});
		expect(spawnMock).not.toHaveBeenCalledWith("cmd", expect.anything(), expect.anything());
		expect(unrefMock).toHaveBeenCalledOnce();
	});
});
