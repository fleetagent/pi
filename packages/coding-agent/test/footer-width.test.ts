import { visibleWidth } from "@fleetagent/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { CompressionDetectionCounts } from "../src/core/compaction/compression-detector.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

interface AssistantUsageCost {
	total: number;
}

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: AssistantUsageCost;
};
interface FooterSessionFixtureOptions {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	includeReplayedUsage?: boolean;
	detectionCounts?: CompressionDetectionCounts;
	detectionModel?: string;
	detectionCost?: number;
	subscription?: boolean;
}

function createSession(options: FooterSessionFixtureOptions): AgentSession {
	const usage = options.usage;
	const entries =
		usage === undefined
			? []
			: [
					{
						type: "message",
						message: {
							role: "assistant",
							usage,
						},
					},
					...(options.includeReplayedUsage
						? [{ type: "message", replayedFromId: "original", message: { role: "assistant", usage } }]
						: []),
				];

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		session: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		getCompressionDetectionCounts: () => options.detectionCounts ?? { keep: 0, compress: 0 },
		getCompressionDetectionCost: () => options.detectionCost ?? 0,
		settingsManager: { getCompressionDetectionModel: () => options.detectionModel },
		modelRegistry: {
			isUsingOAuth: () => options.subscription ?? false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
	it("shows unknown context usage instead of zero when no estimate is available", () => {
		const session = createSession({ sessionName: "" });
		session.getContextUsage = () => undefined;
		const footer = new FooterComponent(session, createFooterData(1));
		expect(footer.render(100)[1]).toContain("?/200k");
	});
	it("shows cumulative detector verdicts in the stats line, including after detection is disabled", () => {
		const configured = new FooterComponent(
			createSession({ sessionName: "", detectionModel: "test/small", detectionCounts: { keep: 4, compress: 2 } }),
			createFooterData(1),
		);
		expect(configured.render(100)[1]).toContain("K4 C2");
		const disabled = new FooterComponent(
			createSession({ sessionName: "", detectionCounts: { keep: 4, compress: 2 } }),
			createFooterData(1),
		);
		expect(disabled.render(100)[1]).toContain("K4 C2");
		const unset = new FooterComponent(createSession({ sessionName: "" }), createFooterData(1));
		expect(unset.render(100)[1]).not.toContain("K0 C0");
	});

	it("shows detector spend after the session price, including when detection is disabled", () => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				detectionCost: 0.01345,
				detectionCounts: { keep: 2, compress: 1 },
				subscription: true,
				usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 1.234 } },
			}),
			createFooterData(1),
		);
		expect(footer.render(100)[1]).toContain("$1.234 (sub) (detect $0.0135) K2 C1");
		const unset = new FooterComponent(createSession({ sessionName: "" }), createFooterData(1));
		expect(unset.render(100)[1]).not.toContain("detect $");
	});

	it("keeps detector stats inside the footer width limit", () => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				detectionModel: "test/small",
				detectionCounts: { keep: 123, compress: 456 },
				detectionCost: 0.1234,
			}),
			createFooterData(1),
		);
		for (const line of footer.render(24)) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
	});
	it("does not charge replayed assistant messages twice", () => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				includeReplayedUsage: true,
				usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } },
			}),
			createFooterData(1),
		);
		const stats = footer.render(100)[1];
		expect(stats).toContain("↑100 ↓20 $1.000");
	});
});
