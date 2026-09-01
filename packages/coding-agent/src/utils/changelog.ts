import { existsSync, readFileSync } from "fs";

interface ChangelogVersion {
	major: number;
	minor: number;
	patch: number;
}

export interface ChangelogEntry extends ChangelogVersion {
	content: string;
}

function parseChangelogVersionHeader(line: string): ChangelogVersion | null {
	const versionMatch = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
	if (!versionMatch) return null;
	return {
		major: Number.parseInt(versionMatch[1], 10),
		minor: Number.parseInt(versionMatch[2], 10),
		patch: Number.parseInt(versionMatch[3], 10),
	};
}

function appendChangelogEntry(entries: ChangelogEntry[], version: ChangelogVersion | null, lines: string[]): void {
	if (!version || lines.length === 0) return;
	entries.push({ ...version, content: lines.join("\n").trim() });
}

/**
 * Parse changelog entries from CHANGELOG.md
 * Scans for ## lines and collects content until next ## or EOF
 */
export function parseChangelog(changelogPath: string): ChangelogEntry[] {
	if (!existsSync(changelogPath)) {
		return [];
	}

	try {
		const content = readFileSync(changelogPath, "utf-8");
		const lines = content.split("\n");
		const entries: ChangelogEntry[] = [];

		let currentLines: string[] = [];
		let currentVersion: ChangelogVersion | null = null;

		for (const line of lines) {
			if (!line.startsWith("## ")) {
				if (currentVersion) currentLines.push(line);
				continue;
			}
			appendChangelogEntry(entries, currentVersion, currentLines);
			currentVersion = parseChangelogVersionHeader(line);
			currentLines = currentVersion ? [line] : [];
		}

		// Save last entry
		appendChangelogEntry(entries, currentVersion, currentLines);

		return entries;
	} catch (error) {
		console.error(`Warning: Could not parse changelog: ${error}`);
		return [];
	}
}

/**
 * Compare versions. Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 */
export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number {
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;
	return v1.patch - v2.patch;
}

/**
 * Get entries newer than lastVersion
 */
export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] {
	// Parse lastVersion
	const parts = lastVersion.split(".").map(Number);
	const last: ChangelogEntry = {
		major: parts[0] || 0,
		minor: parts[1] || 0,
		patch: parts[2] || 0,
		content: "",
	};

	return entries.filter((entry) => compareVersions(entry, last) > 0);
}
