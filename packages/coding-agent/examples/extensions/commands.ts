/**
 * Commands Extension
 *
 * Demonstrates the pi.getCommands() API by providing a /commands command
 * that lists all available slash commands in the current session.
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use /commands to see available commands
 * 3. Use /commands extensions to filter by source
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SlashCommandInfo,
	SlashCommandSource,
} from "@fleetagent/pi-coding-agent";

interface CommandSourceGroup {
	key: SlashCommandSource;
	label: string;
}

const COMMAND_SOURCE_GROUPS: CommandSourceGroup[] = [
	{ key: "extension", label: "Extensions" },
	{ key: "prompt", label: "Prompts" },
	{ key: "skill", label: "Skills" },
];

function buildCommandSelectionItems(commands: SlashCommandInfo[]): string[] {
	const items: string[] = [];
	const itemsBySource = new Map<SlashCommandSource, string[]>(COMMAND_SOURCE_GROUPS.map(({ key }) => [key, []]));
	for (const command of commands) {
		const description = command.description ? ` - ${command.description}` : "";
		itemsBySource.get(command.source)?.push(`/${command.name}${description}`);
	}
	for (const { key, label } of COMMAND_SOURCE_GROUPS) {
		const sourceItems = itemsBySource.get(key);
		if (!sourceItems || sourceItems.length === 0) continue;
		items.push(`--- ${label} ---`);
		items.push(...sourceItems);
	}
	return items;
}

async function showSelectedCommandPath(
	selected: string | undefined,
	commands: SlashCommandInfo[],
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!selected || selected.startsWith("---")) return;
	const commandName = selected.split(" - ")[0].slice(1);
	const command = commands.find((candidate) => candidate.name === commandName);
	if (!command?.sourceInfo.path) return;
	const showPath = await ctx.ui.confirm(command.name, `View source path?\n${command.sourceInfo.path}`);
	if (showPath) ctx.ui.notify(command.sourceInfo.path, "info");
}

export default function commandsExtension(pi: ExtensionAPI) {
	pi.registerCommand("commands", {
		description: "List available slash commands",
		getArgumentCompletions: (prefix) => {
			const sources = ["extension", "prompt", "skill"];
			const filtered = sources.filter((s) => s.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const commands = pi.getCommands();
			const sourceFilter = args.trim() as "extension" | "prompt" | "skill" | "";

			// Filter by source if specified
			const filtered = sourceFilter ? commands.filter((c) => c.source === sourceFilter) : commands;

			if (filtered.length === 0) {
				ctx.ui.notify(sourceFilter ? `No ${sourceFilter} commands found` : "No commands found", "info");
				return;
			}

			const items = buildCommandSelectionItems(filtered);

			// Show in a selector (user can scroll and see all commands)
			const selected = await ctx.ui.select("Available Commands", items);
			await showSelectedCommandPath(selected, commands, ctx);
		},
	});
}
