import { spawn } from "node:child_process";
import { analyzeRepository as analyzeExcessiveCollectionIterations } from "../biome/noExcessiveCollectionIterations.mjs";
import { analyzeRepository as analyzeImplementationDerivedTypeAliases } from "../biome/noImplementationDerivedTypeAliases.mjs";
import { analyzeRepository as analyzeInlineTypeImports } from "../biome/noInlineTypeImports.mjs";
import { analyzeRepository as analyzeInlineStringLiteralUnions } from "../biome/noInlineStringLiteralUnions.mjs";
import { analyzeRepository as analyzeNearIdenticalDataStructures } from "../biome/noNearIdenticalDataStructures.mjs";
import { formatDiagnosticFeedback, loadGuide, parseBiomeReport, selectNextDiagnosticGroup } from "./biome-feedback.mjs";

const MAX_REPORT_CHARS = 8 * 1024 * 1024;
const MAX_FEEDBACK_CHARS = 9_000;
let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	input += chunk;
});
process.stdin.on("end", async () => {
	let event;
	try {
		event = JSON.parse(input);
	} catch {
		return;
	}
	if (event.hook_event_name !== "Stop") return;

	const child = spawn(
		process.platform === "win32" ? "npm.cmd" : "npm",
		["exec", "--silent", "--", "biome", "check", "--reporter=json", "--error-on-warnings"],
		{
			cwd: event.cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		},
	);

	let stdout = "";
	let stderr = "";
	let reportOverflowed = false;
	let spawnError;
	const append = (target, chunk) => {
		if (target.length >= MAX_REPORT_CHARS) {
			reportOverflowed = true;
			return target;
		}
		const next = target + chunk.toString();
		if (next.length <= MAX_REPORT_CHARS) return next;
		reportOverflowed = true;
		return next.slice(0, MAX_REPORT_CHARS);
	};
	child.stdout.on("data", (chunk) => {
		stdout = append(stdout, chunk);
		if (reportOverflowed) child.kill();
	});
	child.stderr.on("data", (chunk) => {
		stderr = append(stderr, chunk);
		if (reportOverflowed) child.kill();
	});
	child.on("error", (error) => {
		spawnError = error;
	});

	const code = await new Promise((resolve) => child.on("close", resolve));
	if (spawnError) {
		writeFeedback(`Biome could not run: ${spawnError.message}`);
		return;
	}
	if (reportOverflowed) {
		writeFeedback("Biome JSON output exceeded 8 MiB. Run npm run biome:check manually and reduce the diagnostic set.");
		return;
	}

	let report;
	try {
		report = parseBiomeReport(stdout);
	} catch (error) {
		const details = stderr.trim().slice(0, MAX_FEEDBACK_CHARS);
		writeFeedback(
			`Biome failed, but its JSON report could not be parsed: ${error instanceof Error ? error.message : String(error)}${details ? `\n\n${details}` : ""}`,
		);
		return;
	}
	try {
		report.diagnostics.push(...(await analyzeNearIdenticalDataStructures(event.cwd)));
	} catch (error) {
		writeFeedback(
			`The noNearIdenticalDataStructures check failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}
	try {
		report.diagnostics.push(...(await analyzeImplementationDerivedTypeAliases(event.cwd)));
	} catch (error) {
		writeFeedback(
			`The noImplementationDerivedTypeAliases check failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}
	try {
		report.diagnostics.push(...(await analyzeInlineTypeImports(event.cwd)));
	} catch (error) {
		writeFeedback(`The noInlineTypeImports check failed: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	try {
		report.diagnostics.push(...(await analyzeInlineStringLiteralUnions(event.cwd)));
	} catch (error) {
		writeFeedback(
			`The noInlineStringLiteralUnions check failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}
	try {
		report.diagnostics.push(...(await analyzeExcessiveCollectionIterations(event.cwd)));
	} catch (error) {
		writeFeedback(
			`The noExcessiveCollectionIterations check failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}
	const diagnostics = selectNextDiagnosticGroup(report.diagnostics);
	const diagnostic = diagnostics[0];
	if (!diagnostic) {
		if (code === 0) return;
		const details = stderr.trim().slice(0, MAX_FEEDBACK_CHARS);
		writeFeedback(`Biome failed without a diagnostic.${details ? `\n\n${details}` : ""}`);
		return;
	}
	const guide = await loadGuide(diagnostic);
	writeFeedback(formatDiagnosticFeedback(diagnostics, report.diagnostics.length, guide), report.diagnostics.length);
});

function writeFeedback(additionalContext, continuationProgress) {
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "Stop",
				additionalContext: additionalContext.slice(0, MAX_FEEDBACK_CHARS),
				...(continuationProgress === undefined ? {} : { continuationProgress }),
			},
		}),
	);
}
