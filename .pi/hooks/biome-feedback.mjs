import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GUIDE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "guides");
const FALLBACK_GUIDE = "general";
const SINGLE_DIAGNOSTIC_RULE_KEYS = new Set(["lint/complexity/noExcessiveCognitiveComplexity"]);

function diagnosticPosition(diagnostic) {
	const location = diagnostic.location;
	const path =
		typeof location?.path === "string"
			? location.path
			: typeof location?.path?.file === "string"
				? location.path.file
				: "unknown file";
	const hasLineAndColumn = Number.isInteger(location?.start?.line) && Number.isInteger(location?.start?.column);
	const offset = Array.isArray(location?.span) && Number.isInteger(location.span[0]) ? location.span[0] : 0;
	return {
		path,
		line: hasLineAndColumn ? location.start.line : undefined,
		column: hasLineAndColumn ? location.start.column : undefined,
		offset,
	};
}

function diagnosticMessage(diagnostic) {
	return typeof diagnostic?.message === "string"
		? diagnostic.message
		: typeof diagnostic?.description === "string"
			? diagnostic.description
			: "";
}

function diagnosticRuleKey(diagnostic) {
	const category = String(diagnostic?.category ?? "");
	if (category !== "plugin") return category;
	const pluginRuleName = /^\[([A-Za-z][A-Za-z0-9]*)\]/.exec(diagnosticMessage(diagnostic))?.[1];
	return pluginRuleName ? `${category}/${pluginRuleName}` : `${category}/${diagnosticMessage(diagnostic)}`;
}

function compareDiagnostics(left, right) {
	const leftPosition = diagnosticPosition(left);
	const rightPosition = diagnosticPosition(right);
	return (
		leftPosition.path.localeCompare(rightPosition.path) ||
		(leftPosition.line ?? 0) - (rightPosition.line ?? 0) ||
		(leftPosition.column ?? 0) - (rightPosition.column ?? 0) ||
		leftPosition.offset - rightPosition.offset ||
		String(left.category ?? "").localeCompare(String(right.category ?? ""))
	);
}

export function parseBiomeReport(output) {
	const report = JSON.parse(output);
	if (!report || typeof report !== "object" || !Array.isArray(report.diagnostics)) {
		throw new Error("Biome JSON output did not contain a diagnostics array");
	}
	return report;
}

export function selectNextDiagnosticGroup(diagnostics) {
	const sorted = [...diagnostics]
		.filter((diagnostic) => diagnostic && typeof diagnostic === "object")
		.sort(compareDiagnostics);
	if (sorted.length === 0) return [];
	const diagnosticsByPath = new Map();
	for (const diagnostic of sorted) {
		const path = diagnosticPosition(diagnostic).path;
		const pathDiagnostics = diagnosticsByPath.get(path);
		if (pathDiagnostics) pathDiagnostics.push(diagnostic);
		else diagnosticsByPath.set(path, [diagnostic]);
	}
	const selectedPathDiagnostics = [...diagnosticsByPath.entries()].sort(
		([leftPath, leftDiagnostics], [rightPath, rightDiagnostics]) =>
			rightDiagnostics.length - leftDiagnostics.length || leftPath.localeCompare(rightPath),
	)[0]?.[1];
	const first = selectedPathDiagnostics?.[0];
	if (!first) return [];
	const ruleKey = diagnosticRuleKey(first);
	if (SINGLE_DIAGNOSTIC_RULE_KEYS.has(ruleKey)) return [first];
	return selectedPathDiagnostics.filter((diagnostic) => diagnosticRuleKey(diagnostic) === ruleKey);
}

export function selectNextDiagnostic(diagnostics) {
	return [...diagnostics]
		.filter((diagnostic) => diagnostic && typeof diagnostic === "object")
		.sort(compareDiagnostics)[0];
}

export function guideNameForDiagnostic(diagnostic) {
	const category = typeof diagnostic?.category === "string" ? diagnostic.category : "";
	const message =
		typeof diagnostic?.message === "string"
			? diagnostic.message
			: typeof diagnostic?.description === "string"
				? diagnostic.description
				: "";
	const pluginRuleName = category === "plugin" ? /^\[([A-Za-z][A-Za-z0-9]*)\]/.exec(message)?.[1] : undefined;
	if (pluginRuleName) return pluginRuleName;
	const ruleName = category.split("/").at(-1) ?? "";
	if (category === "format") return "format";
	return /^[A-Za-z][A-Za-z0-9]*$/.test(ruleName) ? ruleName : FALLBACK_GUIDE;
}

export async function loadGuide(diagnostic) {
	const guideName = guideNameForDiagnostic(diagnostic);
	try {
		return {
			guideName,
			content: await readFile(join(GUIDE_DIRECTORY, `${guideName}.md`), "utf8"),
		};
	} catch {
		return {
			guideName: FALLBACK_GUIDE,
			content: await readFile(join(GUIDE_DIRECTORY, `${FALLBACK_GUIDE}.md`), "utf8"),
		};
	}
}

export function formatDiagnosticFeedback(selectedDiagnostics, totalDiagnostics, guide) {
	const diagnostics = Array.isArray(selectedDiagnostics) ? selectedDiagnostics : [selectedDiagnostics];
	const diagnostic = diagnostics[0];
	const category = typeof diagnostic.category === "string" ? diagnostic.category : "unknown";
	const severity = typeof diagnostic.severity === "string" ? diagnostic.severity : "error";
	const message = diagnosticMessage(diagnostic) || "Biome reported a violation.";
	const locations = diagnostics.map((item) => {
		const position = diagnosticPosition(item);
		return position.line === undefined
			? `${position.path} (byte offset ${position.offset})`
			: `${position.path}:${position.line}:${position.column}`;
	});
	const repeated = diagnostics.length > 1;
	const sameMessage = diagnostics.every((item) => diagnosticMessage(item) === message);
	const details = repeated
		? sameMessage
			? [`Locations:\n${locations.map((location) => `- ${location}`).join("\n")}`, `Message: ${message}`]
			: [
					`Diagnostics:\n${diagnostics
						.map((item, index) => `- ${locations[index]} — ${diagnosticMessage(item) || "Biome reported a violation."}`)
						.join("\n")}`,
				]
		: [`Location: ${locations[0]}`, `Message: ${message}`];
	return [
		repeated
			? "Biome reported multiple violations of the same rule in one file. Resolve only these issues, then stop so the hook can rerun and provide the next issue."
			: "Biome reported a violation. Resolve only this issue, then stop so the hook can rerun and provide the next issue.",
		"Do not batch diagnostics from other files or rules. Do not suppress or weaken the rule unless the guide explicitly permits it.",
		`Remaining diagnostics in this run: ${totalDiagnostics}`,
		"",
		`${repeated ? "Issues" : "Issue"}: ${category} (${severity})`,
		...details,
		`Guide: .pi/hooks/guides/${guide.guideName}.md`,
		"",
		guide.content.trim(),
	].join("\n");
}
