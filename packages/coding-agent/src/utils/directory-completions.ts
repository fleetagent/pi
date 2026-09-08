import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AutocompleteItem } from "@fleetagent/pi-tui";

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
	return value;
}

export function resolveDirectoryPath(value: string, cwd: string): string | undefined {
	try {
		const directory = realpathSync(resolve(cwd, expandHome(value)));
		return statSync(directory).isDirectory() ? directory : undefined;
	} catch {
		return undefined;
	}
}

function isDirectory(directory: string, name: string): boolean {
	try {
		return statSync(join(directory, name)).isDirectory();
	} catch {
		return false;
	}
}

/** Build immediate child-directory completions for a path relative to cwd. */
export function getDirectoryCompletions(argumentPrefix: string, cwd: string): AutocompleteItem[] {
	const quoted = argumentPrefix.startsWith('"');
	const rawPrefix = (quoted ? argumentPrefix.slice(1) : argumentPrefix).replaceAll("\\", "/");
	if (rawPrefix === "~") {
		return [{ value: "~/", label: "~/" }];
	}

	const expandedPrefix = expandHome(rawPrefix);
	const hasTrailingSeparator = rawPrefix.endsWith("/");
	const searchDirectory = resolveDirectoryPath(hasTrailingSeparator ? rawPrefix : dirname(rawPrefix), cwd);
	if (!searchDirectory) return [];
	const namePrefix = hasTrailingSeparator ? "" : basename(expandedPrefix);
	const displayDirectory = hasTrailingSeparator
		? rawPrefix
		: rawPrefix.includes("/")
			? rawPrefix.slice(0, rawPrefix.lastIndexOf("/") + 1)
			: "";

	try {
		return readdirSync(searchDirectory, { withFileTypes: true })
			.filter((entry) => entry.name.toLowerCase().startsWith(namePrefix.toLowerCase()))
			.filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(searchDirectory, entry.name)))
			.map((entry) => {
				const directoryPath = `${displayDirectory}${entry.name}/`;
				const needsQuotes = quoted || directoryPath.includes(" ");
				return {
					value: needsQuotes ? `"${directoryPath}"` : directoryPath,
					label: `${entry.name}/`,
				};
			})
			.sort((left, right) => left.label.localeCompare(right.label));
	} catch {
		return [];
	}
}
