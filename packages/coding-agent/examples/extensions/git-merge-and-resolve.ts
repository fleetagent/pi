/**
 * Merge and Resolve
 *
 * Keeps the working branch up to date with its upstream tracking ref.
 * After each agent turn, fetches and merges. Clean merges complete
 * silently. When conflicts arise, the working tree is left dirty and
 * the agent receives a follow-up message listing each conflict block
 * with file, line range, and ours/theirs sections so it can resolve them.
 * Also re-sends unresolved conflicts from a previous incomplete merge.
 *
 * Start pi with this extension:
 *   pi -e ./examples/extensions/git-merge-and-resolve.ts
 */
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionAPI, ExtensionContext } from "@fleetagent/pi-coding-agent";

interface ConflictBlock {
	file: string;
	startLine: number;
	separatorLine: number;
	endLine: number;
}

async function parseConflictFile(cwd: string, file: string): Promise<ConflictBlock[]> {
	const blocks: ConflictBlock[] = [];
	const lines = createInterface({ input: createReadStream(join(cwd, file), "utf-8") });
	let lineNumber = 0;
	let blockStart: number | undefined;
	let separatorLine: number | undefined;
	for await (const line of lines) {
		lineNumber++;
		if (line.startsWith("<<<<<<<")) {
			blockStart = lineNumber;
			separatorLine = undefined;
		} else if (line.startsWith("=======") && blockStart !== undefined) {
			separatorLine = lineNumber;
		} else if (line.startsWith(">>>>>>>") && blockStart !== undefined && separatorLine !== undefined) {
			blocks.push({ file, startLine: blockStart, separatorLine, endLine: lineNumber });
			blockStart = undefined;
			separatorLine = undefined;
		}
	}
	return blocks;
}

/** Parse conflict markers from working tree files with unmerged paths. */
async function findConflicts(pi: ExtensionAPI, cwd: string): Promise<ConflictBlock[]> {
	const { stdout, code } = await pi.exec("git", ["diff", "--name-only", "--diff-filter=U"]);
	if (code !== 0 || !stdout.trim()) return [];

	const blocks: ConflictBlock[] = [];
	for (const file of stdout.trim().split("\n")) {
		try {
			blocks.push(...(await parseConflictFile(cwd, file)));
		} catch {}
	}
	return blocks;
}

function formatRange(start: number, end: number): string {
	if (start > end) return "empty";
	if (start === end) return `${start}`;
	return `${start}-${end}`;
}

function formatConflicts(ref: string, blocks: ConflictBlock[]): string {
	const lines = [`Merged ${ref} with conflicts:`, ""];
	for (const b of blocks) {
		const ours = formatRange(b.startLine + 1, b.separatorLine - 1);
		const theirs = formatRange(b.separatorLine + 1, b.endLine - 1);
		lines.push(`  ${b.file}:${b.startLine}-${b.endLine} (ours ${ours}, theirs ${theirs})`);
	}
	lines.push("", "Resolve these conflicts.");
	return lines.join("\n");
}

async function attemptUpstreamMerge(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string | undefined> {
	const { stdout: status } = await pi.exec("git", ["status", "--porcelain"]);
	if (status.trim()) return undefined;

	const { stdout: upstream, code: upstreamCode } = await pi.exec("git", [
		"rev-parse",
		"--abbrev-ref",
		"--symbolic-full-name",
		"@{u}",
	]);
	if (upstreamCode !== 0) return undefined;

	const ref = upstream.trim();
	const remote = ref.split("/")[0];
	ctx.ui.notify(`git-merge-and-resolve: fetching ${remote}, merging ${ref}`, "info");

	const { code: fetchCode, stderr: fetchErr } = await pi.exec("git", ["fetch", remote]);
	if (fetchCode !== 0) {
		ctx.ui.notify(`git-merge-and-resolve: fetch failed: ${fetchErr.trim()}`, "warning");
		return undefined;
	}

	const { code: mergeCode } = await pi.exec("git", ["merge", "--no-ff", ref]);
	return mergeCode === 0 ? undefined : ref;
}
export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (_event, ctx) => {
		const { code: revParseCode } = await pi.exec("git", ["rev-parse", "--git-dir"]);
		if (revParseCode !== 0) return;

		let ref = "MERGE_HEAD";

		// If not already in a merge, attempt one
		const { code: mergeHeadCode } = await pi.exec("git", ["rev-parse", "MERGE_HEAD"]);
		if (mergeHeadCode !== 0) {
			const upstreamRef = await attemptUpstreamMerge(pi, ctx);
			if (upstreamRef === undefined) return;
			ref = upstreamRef;
		}

		// Either we just merged with conflicts, or we were already in an unfinished merge
		const conflicts = await findConflicts(pi, ctx.cwd);
		if (conflicts.length === 0) return;

		pi.sendUserMessage(formatConflicts(ref, conflicts), { deliverAs: "followUp" });
	});
}
