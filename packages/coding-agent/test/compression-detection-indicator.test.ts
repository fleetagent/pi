import { Container, type Loader } from "@fleetagent/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface IndicatorSession {
	isStreaming: boolean;
}

interface IndicatorUi {
	requestRender(): void;
}

interface IndicatorContext {
	compressionDetectionActive: boolean;
	compressionDetectionOwnsLoader: boolean;
	workingVisible: boolean;
	workingMessage?: string;
	defaultWorkingMessage: string;
	hookExecutionActivityDepth: number;
	loadingAnimation?: Loader;
	statusContainer: Container;
	session: IndicatorSession;
	ui: IndicatorUi;
	createWorkingLoader(): Loader;
	releaseCompressionDetectionLoader(): void;
	stopWorkingLoader(): void;
	getWorkingLoaderMessage(): string;
}

const methods = InteractiveMode.prototype as unknown as {
	handleCompressionDetectionActivity(this: IndicatorContext, active: boolean): void;
	releaseCompressionDetectionLoader(this: IndicatorContext): void;
	getWorkingLoaderMessage(this: IndicatorContext): string;
	stopWorkingLoader(this: IndicatorContext): void;
};

function createContext(streaming = false) {
	const stop = vi.fn();
	const setMessage = vi.fn<(message: string) => void>();
	const loader = { render: () => [], invalidate: () => {}, stop, setMessage } as unknown as Loader;
	const createdMessages: string[] = [];
	const context: IndicatorContext = {
		compressionDetectionActive: false,
		compressionDetectionOwnsLoader: false,
		workingVisible: true,
		defaultWorkingMessage: "Working...",
		hookExecutionActivityDepth: 0,
		loadingAnimation: undefined as Loader | undefined,
		statusContainer: new Container(),
		session: { isStreaming: streaming },
		ui: { requestRender: vi.fn() },
		createWorkingLoader() {
			createdMessages.push(this.getWorkingLoaderMessage());
			return loader;
		},
		releaseCompressionDetectionLoader: methods.releaseCompressionDetectionLoader,
		stopWorkingLoader: methods.stopWorkingLoader,
		getWorkingLoaderMessage: methods.getWorkingLoaderMessage,
	};
	return { context, loader, stop, setMessage, createdMessages };
}

describe("background compression working indicator", () => {
	it("shows and removes a dedicated loader while the idle detector runs", () => {
		const { context, loader, stop, createdMessages } = createContext();
		methods.handleCompressionDetectionActivity.call(context, true);
		expect(createdMessages).toEqual(["Working... [Evaluating compression possibility]"]);
		expect(context.statusContainer.children).toEqual([loader]);
		methods.handleCompressionDetectionActivity.call(context, false);
		expect(stop).toHaveBeenCalledOnce();
		expect(context.statusContainer.children).toEqual([]);
	});

	it("updates the agent's existing loader without stopping it and respects hidden indicators", () => {
		const { context, loader, stop, setMessage, createdMessages } = createContext(true);
		context.loadingAnimation = loader;
		context.statusContainer.addChild(loader);
		methods.handleCompressionDetectionActivity.call(context, true);
		expect(setMessage).toHaveBeenLastCalledWith("Working... [Evaluating compression possibility]");
		methods.handleCompressionDetectionActivity.call(context, false);
		expect(setMessage).toHaveBeenLastCalledWith("Working...");
		expect(stop).not.toHaveBeenCalled();
		expect(createdMessages).toEqual([]);

		const hidden = createContext();
		hidden.context.workingVisible = false;
		methods.handleCompressionDetectionActivity.call(hidden.context, true);
		expect(hidden.context.statusContainer.children).toEqual([]);
	});
	it("does not clear a newer status while stopping an orphaned detector loader", () => {
		const { context, stop } = createContext();
		methods.handleCompressionDetectionActivity.call(context, true);
		const newerStatus = new Container();
		context.statusContainer.clear();
		context.statusContainer.addChild(newerStatus);
		methods.handleCompressionDetectionActivity.call(context, false);
		expect(stop).toHaveBeenCalledOnce();
		expect(context.statusContainer.children).toEqual([newerStatus]);
	});
});
