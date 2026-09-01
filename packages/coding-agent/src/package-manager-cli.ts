import { Markdown, type MarkdownTheme } from "@fleetagent/pi-tui";
import chalk from "chalk";
import { selectConfig } from "./cli/config-selector.ts";
import {
	APP_NAME,
	detectInstallMethod,
	getAgentDir,
	getPackageDir,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	PACKAGE_NAME,
	type SelfUpdateCommand,
	VERSION,
} from "./config.ts";
import { type ConfiguredPackage, DefaultPackageManager } from "./core/package-manager.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { spawnProcess } from "./utils/child-process.ts";
import { getLatestPiRelease, isNewerPackageVersion } from "./utils/version-check.ts";
import {
	cleanupWindowsSelfUpdateQuarantine,
	quarantineWindowsNativeDependencies,
} from "./utils/windows-self-update.ts";

export type PackageCommand = "install" | "remove" | "update" | "list";

type UpdateTarget = { type: "all" } | { type: "self" } | { type: "extensions"; source?: string };

const SELF_UPDATE_NOTE_MARKDOWN_THEME: MarkdownTheme = {
	heading: (text) => chalk.bold(chalk.yellow(text)),
	link: (text) => chalk.cyan(text),
	linkUrl: (text) => chalk.dim(text),
	code: (text) => chalk.yellow(text),
	codeBlock: (text) => chalk.dim(text),
	codeBlockBorder: (text) => chalk.dim(text),
	quote: (text) => chalk.dim(text),
	quoteBorder: (text) => chalk.dim(text),
	hr: (text) => chalk.dim(text),
	listBullet: (text) => chalk.yellow(text),
	bold: (text) => chalk.bold(text),
	italic: (text) => chalk.italic(text),
	strikethrough: (text) => chalk.strikethrough(text),
	underline: (text) => chalk.underline(text),
};

interface PackageCommandOptions {
	command: PackageCommand;
	source?: string;
	updateTarget?: UpdateTarget;
	local: boolean;
	force: boolean;
	help: boolean;
	invalidOption?: string;
	invalidArgument?: string;
	missingOptionValue?: string;
	conflictingOptions?: string;
}

type UpdateFlag = "self" | "extensions" | "force";

interface PackageCommandParseState {
	command: PackageCommand;
	local: boolean;
	help: boolean;
	invalidOption?: string;
	invalidArgument?: string;
	missingOptionValue?: string;
	conflictingOptions?: string;
	source?: string;
	updateFlags: Record<UpdateFlag, boolean>;
	extensionFlagSource?: string;
}

const UPDATE_FLAG_OPTIONS: ReadonlyMap<string, UpdateFlag> = new Map([
	["--self", "self"],
	["--extensions", "extensions"],
	["--force", "force"],
]);

function reportSettingsErrors(settingsManager: SettingsManager, context: string): void {
	const errors = settingsManager.drainErrors();
	for (const { scope, error } of errors) {
		console.error(chalk.yellow(`Warning (${context}, ${scope} settings): ${error.message}`));
		if (error.stack) {
			console.error(chalk.dim(error.stack));
		}
	}
}

function getPackageCommandUsage(command: PackageCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} install <source> [-l]`;
		case "remove":
			return `${APP_NAME} remove <source> [-l]`;
		case "update":
			return `${APP_NAME} update [source|self|pi] [--self] [--extensions] [--extension <source>] [--force]`;
		case "list":
			return `${APP_NAME} list`;
	}
}

function printPackageCommandHelp(command: PackageCommand): void {
	switch (command) {
		case "install":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("install")}

Install a package and add it to settings.

Options:
  -l, --local    Install project-locally (.pi/settings.json)

Examples:
  ${APP_NAME} install npm:@foo/bar
  ${APP_NAME} install git:github.com/user/repo
  ${APP_NAME} install git:git@github.com:user/repo
  ${APP_NAME} install https://github.com/user/repo
  ${APP_NAME} install ssh://git@github.com/user/repo
  ${APP_NAME} install ./local/path
`);
			return;

		case "remove":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("remove")}

Remove a package and its source from settings.
Alias: ${APP_NAME} uninstall <source> [-l]

Options:
  -l, --local    Remove from project settings (.pi/settings.json)

Examples:
  ${APP_NAME} remove npm:@foo/bar
  ${APP_NAME} uninstall npm:@foo/bar
`);
			return;

		case "update":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("update")}

Update pi and installed packages.

Options:
  --self                  Update pi only
  --extensions            Update installed packages only
  --extension <source>    Update one package only
  --force                 Reinstall pi even if the current version is latest

Short forms:
  ${APP_NAME} update                Update pi and all extensions
  ${APP_NAME} update <source>       Update one package
  ${APP_NAME} update pi             Update pi only (self works as alias to pi)
`);
			return;

		case "list":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("list")}

List installed packages from user and project settings.
`);
			return;
	}
}

function parsePackageCommandName(rawCommand: string | undefined): PackageCommand | undefined {
	if (rawCommand === "uninstall") return "remove";
	if (rawCommand === "install" || rawCommand === "remove" || rawCommand === "update" || rawCommand === "list") {
		return rawCommand;
	}
	return undefined;
}

function consumeExtensionOption(rest: string[], index: number, state: PackageCommandParseState): number {
	if (state.command !== "update") {
		state.invalidOption ??= "--extension";
		return index;
	}

	const value = rest[index + 1];
	if (!value || value.startsWith("-")) {
		state.missingOptionValue ??= "--extension";
		return index;
	}
	if (state.extensionFlagSource) {
		state.conflictingOptions ??= "--extension can only be provided once";
		return index + 1;
	}
	state.extensionFlagSource = value;
	return index + 1;
}

function recordUnrecognizedPackageArgument(arg: string, state: PackageCommandParseState): void {
	if (arg.startsWith("-")) {
		state.invalidOption ??= arg;
		return;
	}
	if (!state.source) state.source = arg;
	else state.invalidArgument ??= arg;
}

function consumePackageCommandArgument(rest: string[], index: number, state: PackageCommandParseState): number {
	const arg = rest[index];
	if (arg === "-h" || arg === "--help") {
		state.help = true;
		return index;
	}
	if (arg === "-l" || arg === "--local") {
		if (state.command === "install" || state.command === "remove") state.local = true;
		else state.invalidOption ??= arg;
		return index;
	}

	const updateFlag = UPDATE_FLAG_OPTIONS.get(arg);
	if (updateFlag) {
		if (state.command === "update") state.updateFlags[updateFlag] = true;
		else state.invalidOption ??= arg;
		return index;
	}
	if (arg === "--extension") return consumeExtensionOption(rest, index, state);
	recordUnrecognizedPackageArgument(arg, state);
	return index;
}

function resolveExtensionFlagUpdateTarget(state: PackageCommandParseState): UpdateTarget {
	if (state.updateFlags.self || state.updateFlags.extensions) {
		state.conflictingOptions ??= "--extension cannot be combined with --self or --extensions";
	}
	if (state.source) {
		state.conflictingOptions ??= "--extension cannot be combined with a positional source";
	}
	return { type: "extensions", source: state.extensionFlagSource };
}

function resolvePositionalUpdateTarget(state: PackageCommandParseState): UpdateTarget {
	const source = state.source!;
	if (source === "self" || source === "pi") {
		return state.updateFlags.extensions ? { type: "all" } : { type: "self" };
	}
	if (state.updateFlags.extensions || state.updateFlags.self) {
		state.conflictingOptions ??= "positional update targets cannot be combined with --self or --extensions";
	}
	return { type: "extensions", source };
}

function resolveUpdateTarget(state: PackageCommandParseState): UpdateTarget | undefined {
	if (state.command !== "update") return undefined;
	if (state.extensionFlagSource) return resolveExtensionFlagUpdateTarget(state);
	if (state.source) return resolvePositionalUpdateTarget(state);
	if (state.updateFlags.self && state.updateFlags.extensions) return { type: "all" };
	if (state.updateFlags.self) return { type: "self" };
	if (state.updateFlags.extensions) return { type: "extensions" };
	return { type: "all" };
}

function parsePackageCommand(args: string[]): PackageCommandOptions | undefined {
	const [rawCommand, ...rest] = args;
	const command = parsePackageCommandName(rawCommand);
	if (!command) return undefined;

	const state: PackageCommandParseState = {
		command,
		local: false,
		help: false,
		updateFlags: { self: false, extensions: false, force: false },
	};
	for (let index = 0; index < rest.length; index++) {
		index = consumePackageCommandArgument(rest, index, state);
	}

	return {
		command,
		source: state.source,
		updateTarget: resolveUpdateTarget(state),
		local: state.local,
		force: state.updateFlags.force,
		help: state.help,
		invalidOption: state.invalidOption,
		invalidArgument: state.invalidArgument,
		missingOptionValue: state.missingOptionValue,
		conflictingOptions: state.conflictingOptions,
	};
}

function updateTargetIncludesSelf(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "self";
}

function updateTargetIncludesExtensions(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "extensions";
}

function printSelfUpdateUnavailable(npmCommand?: string[], updatePackageName = PACKAGE_NAME): void {
	console.error(`error: ${APP_NAME} cannot self-update this installation.`);
	console.error(getSelfUpdateUnavailableInstruction(PACKAGE_NAME, npmCommand, updatePackageName));

	const entrypoint = process.argv[1];
	if (entrypoint) {
		console.error("");
		console.error(`Location of pi executable: ${entrypoint}`);
	}
}

function printSelfUpdateFallback(command: SelfUpdateCommand): void {
	console.error(chalk.dim(`If this keeps failing, run this command yourself: ${command.display}`));
}

function printPnpmSelfUpdateMetadataHint(): void {
	console.error(chalk.yellow("If pnpm reports missing package versions, its cached registry metadata may be stale."));
	console.error(chalk.yellow(`Run \`pnpm store prune\` and retry \`${APP_NAME} update --self\`.`));
}

function printSelfUpdateNote(note: string): void {
	const trimmedNote = note.trim();
	if (!trimmedNote) {
		return;
	}

	console.log();
	console.log(chalk.bold(chalk.yellow("Update note")));
	try {
		const width = Math.max(20, process.stdout.columns ?? 80);
		const renderedLines = new Markdown(trimmedNote, 0, 0, SELF_UPDATE_NOTE_MARKDOWN_THEME)
			.render(width)
			.map((line) => line.trimEnd());
		console.log(renderedLines.join("\n"));
	} catch {
		console.log(trimmedNote);
	}
	console.log();
}

interface SelfUpdatePlan {
	packageName: string;
	shouldRun: boolean;
	note?: string;
}

async function getSelfUpdatePlan(force: boolean): Promise<SelfUpdatePlan> {
	if (force) {
		return { packageName: PACKAGE_NAME, shouldRun: true };
	}

	try {
		const latestRelease = await getLatestPiRelease(VERSION);
		const packageName = latestRelease?.packageName ?? PACKAGE_NAME;
		if (!latestRelease || packageName !== PACKAGE_NAME || isNewerPackageVersion(latestRelease.version, VERSION)) {
			return { packageName, shouldRun: true, ...(latestRelease?.note ? { note: latestRelease.note } : {}) };
		}
	} catch {
		return { packageName: PACKAGE_NAME, shouldRun: true };
	}

	console.log(chalk.green(`${APP_NAME} is already up to date (v${VERSION})`));
	return { packageName: PACKAGE_NAME, shouldRun: false };
}

async function runSelfUpdate(command: SelfUpdateCommand): Promise<void> {
	console.log(chalk.dim(`Updating ${APP_NAME} with ${command.display}...`));
	for (const step of command.steps ?? [command]) {
		await new Promise<void>((resolve, reject) => {
			const child = spawnProcess(step.command, step.args, {
				stdio: "inherit",
			});
			child.on("error", (error) => {
				reject(error);
			});
			child.on("close", (code, signal) => {
				if (code === 0) {
					resolve();
				} else if (signal) {
					reject(new Error(`${step.display} terminated by signal ${signal}`));
				} else {
					reject(new Error(`${step.display} exited with code ${code ?? "unknown"}`));
				}
			});
		});
	}
}

function prepareWindowsNpmSelfUpdate(): void {
	if (process.platform !== "win32") {
		return;
	}

	const packageDir = getPackageDir();
	cleanupWindowsSelfUpdateQuarantine(packageDir);
	quarantineWindowsNativeDependencies(packageDir);
}

function handlePackageCommandPreflight(options: PackageCommandOptions): boolean {
	if (options.help) {
		printPackageCommandHelp(options.command);
		return true;
	}
	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "${options.command}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getPackageCommandUsage(options.command)}".`));
	} else if (options.missingOptionValue) {
		console.error(chalk.red(`Missing value for ${options.missingOptionValue}.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
	} else if (options.invalidArgument) {
		console.error(chalk.red(`Unexpected argument ${options.invalidArgument}.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
	} else if (options.conflictingOptions) {
		console.error(chalk.red(options.conflictingOptions));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
	} else if ((options.command === "install" || options.command === "remove") && !options.source) {
		console.error(chalk.red(`Missing ${options.command} source.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
	} else {
		return false;
	}
	process.exitCode = 1;
	return true;
}

function printConfiguredPackage(pkg: ConfiguredPackage): void {
	const display = pkg.filtered ? `${pkg.source} (filtered)` : pkg.source;
	console.log(`  ${display}`);
	if (pkg.installedPath) console.log(chalk.dim(`    ${pkg.installedPath}`));
}

function listConfiguredPackages(packageManager: DefaultPackageManager): void {
	const configuredPackages = packageManager.listConfiguredPackages();
	const userPackages = configuredPackages.filter((pkg) => pkg.scope === "user");
	const projectPackages = configuredPackages.filter((pkg) => pkg.scope === "project");
	if (configuredPackages.length === 0) {
		console.log(chalk.dim("No packages installed."));
		return;
	}
	if (userPackages.length > 0) {
		console.log(chalk.bold("User packages:"));
		for (const pkg of userPackages) printConfiguredPackage(pkg);
	}
	if (projectPackages.length > 0) {
		if (userPackages.length > 0) console.log();
		console.log(chalk.bold("Project packages:"));
		for (const pkg of projectPackages) printConfiguredPackage(pkg);
	}
}

async function updateConfiguredPackages(packageManager: DefaultPackageManager, target: UpdateTarget): Promise<void> {
	if (!updateTargetIncludesExtensions(target)) return;
	const updateSource = target.type === "extensions" ? target.source : undefined;
	await packageManager.update(updateSource);
	console.log(chalk.green(updateSource ? `Updated ${updateSource}` : "Updated packages"));
}

async function updateSelf(force: boolean, npmCommand?: string[]): Promise<void> {
	const selfUpdatePlan = await getSelfUpdatePlan(force);
	if (!selfUpdatePlan.shouldRun) return;
	const installMethod = detectInstallMethod();
	if (process.platform === "win32" && installMethod !== "npm" && installMethod !== "pnpm") {
		console.error(chalk.red(`${APP_NAME} self-update on Windows is only supported for npm and pnpm installs.`));
		console.error(chalk.dim(`Detected install method: ${installMethod}. Update ${APP_NAME} manually.`));
		process.exitCode = 1;
		return;
	}
	const selfUpdateCommand = getSelfUpdateCommand(PACKAGE_NAME, npmCommand, selfUpdatePlan.packageName);
	if (!selfUpdateCommand) {
		printSelfUpdateUnavailable(npmCommand, selfUpdatePlan.packageName);
		process.exitCode = 1;
		return;
	}
	if (selfUpdatePlan.note) printSelfUpdateNote(selfUpdatePlan.note);
	try {
		if (installMethod === "npm") prepareWindowsNpmSelfUpdate();
		await runSelfUpdate(selfUpdateCommand);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown package command error";
		console.error(chalk.red(`Error: ${message}`));
		if (installMethod === "pnpm") printPnpmSelfUpdateMetadataHint();
		printSelfUpdateFallback(selfUpdateCommand);
		process.exitCode = 1;
		return;
	}
	console.log(chalk.green(`Updated ${APP_NAME}`));
}

async function executePackageCommand(
	options: PackageCommandOptions,
	packageManager: DefaultPackageManager,
	selfUpdateNpmCommand: string[] | undefined,
): Promise<boolean> {
	const source = options.source;
	switch (options.command) {
		case "install":
			await packageManager.installAndPersist(source!, { local: options.local });
			console.log(chalk.green(`Installed ${source}`));
			return true;
		case "remove": {
			const removed = await packageManager.removeAndPersist(source!, { local: options.local });
			if (!removed) {
				console.error(chalk.red(`No matching package found for ${source}`));
				process.exitCode = 1;
				return true;
			}
			console.log(chalk.green(`Removed ${source}`));
			return true;
		}
		case "list":
			listConfiguredPackages(packageManager);
			return true;
		case "update": {
			const target = options.updateTarget ?? { type: "all" };
			await updateConfiguredPackages(packageManager, target);
			if (updateTargetIncludesSelf(target)) await updateSelf(options.force, selfUpdateNpmCommand);
			return true;
		}
	}
}

export async function handleConfigCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "config") {
		return false;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "config command");
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const resolvedPaths = await packageManager.resolve();

	await selectConfig({
		resolvedPaths,
		settingsManager,
		cwd,
		agentDir,
	});

	process.exit(0);
}

export async function handlePackageCommand(args: string[]): Promise<boolean> {
	const options = parsePackageCommand(args);
	if (!options) return false;
	if (handlePackageCommandPreflight(options)) return true;

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "package command");
	const selfUpdateNpmCommand = settingsManager.getGlobalSettings().npmCommand;
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	packageManager.setProgressCallback((event) => {
		if (event.type === "start") process.stdout.write(chalk.dim(`${event.message}\n`));
	});

	try {
		return await executePackageCommand(options, packageManager, selfUpdateNpmCommand);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown package command error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}
