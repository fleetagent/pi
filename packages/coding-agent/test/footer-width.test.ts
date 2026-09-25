import { fauxAssistantMessage } from "@fleetagent/pi-ai";
import { visibleWidth } from "@fleetagent/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { CompressionDetectionCounts } from "../src/core/compaction/compression-detector.ts";
import { COMPRESSION_ECONOMICS_ENTRY_TYPE } from "../src/core/compaction/compression-economics.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import type { SessionEntry } from "../src/core/session/types.ts";
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
	priorUsage?: AssistantUsage;
	contextTokens?: number;
	contextPercent?: number;
	includeReplayedUsage?: boolean;
	detectionCounts?: CompressionDetectionCounts;
	detectionModel?: string;
	detectionCost?: number;
	subscription?: boolean;
	branchEntries?: SessionEntry[];
	sessionEntries?: SessionEntry[];
}

function createSession(options: FooterSessionFixtureOptions): AgentSession {
	const usage = options.usage;
	const entries = [
		...(options.priorUsage ? [{ type: "message", message: { role: "assistant", usage: options.priorUsage } }] : []),
		...(usage === undefined
			? []
			: [
					{ type: "message", message: { role: "assistant", usage } },
					...(options.includeReplayedUsage
						? [{ type: "message", replayedFromId: "original", message: { role: "assistant", usage } }]
						: []),
				]),
	];

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				cost: { input: 4, output: 20, cacheRead: 1, cacheWrite: 5 },
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		session: {
			getEntries: () => [...entries, ...(options.sessionEntries ?? options.branchEntries ?? [])],
			getBranch: () => options.branchEntries ?? [],
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({
			contextWindow: 200_000,
			percent: options.contextPercent ?? 12.3,
			tokens: options.contextTokens ?? 24_600,
		}),
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
		expect(configured.render(100)[1]).toContain("D4/2 C0");
		const disabled = new FooterComponent(
			createSession({ sessionName: "", detectionCounts: { keep: 4, compress: 2 } }),
			createFooterData(1),
		);
		expect(disabled.render(100)[1]).toContain("D4/2 C0");
		const unset = new FooterComponent(createSession({ sessionName: "" }), createFooterData(1));
		expect(unset.render(100)[1]).not.toContain("D0/0 C0");
	});
	it("counts completed compressions across archived branches without counting replayed summaries", () => {
		const summary = (id: string, fromId: string): SessionEntry => ({
			type: "custom_message",
			id,
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: "compress_context",
			content: "summary",
			display: true,
			details: { fromId },
		});
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				sessionEntries: [
					summary("archived", "old-leaf"),
					summary("replayed", "old-leaf"),
					summary("active", "new-leaf"),
				],
				branchEntries: [summary("active", "new-leaf")],
			}),
			createFooterData(1),
		);
		expect(footer.render(100)[1]).toContain("D0/0 C2");
	});
	it("labels subscription catalog estimates and cumulative detector spend", () => {
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
		expect(footer.render(120)[1]).toContain("catalog $1.234 (sub) (detect est $0.0135 total) D2/1 C0");
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
		expect(footer.render(24)[1]).toContain("ctx ~25k/200k");
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
		expect(stats).toContain("total ↑100 ↓20 catalog $1.000");
	});
	it("shows cumulative billed usage alongside current context", () => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				priorUsage: {
					input: 141_000_000,
					output: 372_000,
					cacheRead: 78_000_000,
					cacheWrite: 0,
					cost: { total: 301.99 },
				},
				usage: { input: 98_854, output: 36, cacheRead: 6528, cacheWrite: 0, cost: { total: 0.199 } },
				contextTokens: 101_456,
				contextPercent: 50.7,
			}),
			createFooterData(1),
		);
		const stats = footer.render(160)[1];
		expect(stats).toContain("total ↑141M ↓372k R78M catalog $302.189");
		expect(stats).toContain("ctx ~101k/200k (50.7%)");
	});
	it("shows cumulative removal and estimated break-even before claiming net avoidance", () => {
		const reply = fauxAssistantMessage("later response");
		const branchEntries: SessionEntry[] = [
			{
				type: "custom_message",
				id: "summary",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: "compress_context",
				content: "short summary",
				display: true,
			},
			{
				type: "custom",
				id: "ledger",
				parentId: "summary",
				timestamp: new Date().toISOString(),
				customType: COMPRESSION_ECONOMICS_ENTRY_TYPE,
				data: {
					version: 1,
					summaryEntryId: "summary",
					provider: reply.provider,
					modelId: reply.model,
					removedTokens: 1200,
					readRate: 1,
					oneTimeCost: 0.002,
				},
			},
			{ type: "message", id: "reply", parentId: "ledger", timestamp: new Date().toISOString(), message: reply },
		];
		const footer = new FooterComponent(
			createSession({ sessionName: "", branchEntries, modelId: reply.model, provider: reply.provider }),
			createFooterData(1),
		);
		const stats = footer.render(120)[2];
		expect(stats).toContain("~1.2k fewer cumulative");
		expect(stats).toContain("(est $0.0008 to break even)");
		expect(stats).toContain("(cache ~1/new ~1 turns)");
		branchEntries.push({ ...branchEntries[2], id: "reply-2", parentId: "reply" });
		const recovered = footer.render(120)[2];
		expect(recovered).toContain("(est $0.0004 net avoided)");
	});
});
