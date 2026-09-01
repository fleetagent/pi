/**
 * One-time migrations that run on startup.
 */

import chalk from "chalk";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { CONFIG_DIR_NAME, getAgentDir, getBinDir } from "./config.ts";
import { migrateKeybindingsConfig } from "./core/keybindings.ts";
import { isLegacyEnvVarNameConfigValue } from "./core/resolve-config-value.ts";
import { stripJsonComments } from "./utils/json.ts";

const MIGRATION_GUIDE_URL =
	"https://github.com/fleetagent/pi/blob/main/packages/coding-agent/CHANGELOG.md#extensions-migration";
const EXTENSIONS_DOC_URL = "https://github.com/fleetagent/pi/blob/main/packages/coding-agent/docs/extensions.md";

const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

interface LegacyAuthMigrationState {
	credentials: Record<string, unknown>;
	providers: string[];
}

function migrateLegacyOauthFile(oauthPath: string, state: LegacyAuthMigrationState): void {
	if (!existsSync(oauthPath)) return;
	try {
		const oauth = JSON.parse(readFileSync(oauthPath, "utf-8"));
		for (const [provider, credential] of Object.entries(oauth)) {
			state.credentials[provider] = { type: "oauth", ...(credential as object) };
			state.providers.push(provider);
		}
		renameSync(oauthPath, `${oauthPath}.migrated`);
	} catch {
		// Skip on error
	}
}

function migrateLegacySettingsApiKeys(settingsPath: string, state: LegacyAuthMigrationState): void {
	if (!existsSync(settingsPath)) return;
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		if (!settings.apiKeys || typeof settings.apiKeys !== "object") return;
		for (const [provider, key] of Object.entries(settings.apiKeys)) {
			if (state.credentials[provider] || typeof key !== "string") continue;
			state.credentials[provider] = { type: "api_key", key };
			state.providers.push(provider);
		}
		delete settings.apiKeys;
		writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
	} catch {
		// Skip on error
	}
}

/**
 * Migrate legacy oauth.json and settings.json apiKeys to auth.json.
 *
 * @returns Array of provider names that were migrated
 */
export function migrateAuthToAuthJson(): string[] {
	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const oauthPath = join(agentDir, "oauth.json");
	const settingsPath = join(agentDir, "settings.json");

	// Skip if auth.json already exists
	if (existsSync(authPath)) return [];

	const migration: LegacyAuthMigrationState = { credentials: {}, providers: [] };
	migrateLegacyOauthFile(oauthPath, migration);
	migrateLegacySettingsApiKeys(settingsPath, migration);

	if (Object.keys(migration.credentials).length > 0) {
		mkdirSync(dirname(authPath), { recursive: true });
		writeFileSync(authPath, JSON.stringify(migration.credentials, null, 2), AUTH_FILE_WRITE_OPTIONS);
	}

	return migration.providers;
}

interface ConfigValueMigration {
	location: string;
	from: string;
	to: string;
}

function migrateLegacyEnvVarString(value: string): string | undefined {
	return isLegacyEnvVarNameConfigValue(value) ? `$${value}` : undefined;
}

function migrateStringProperty(
	record: Record<string, unknown>,
	key: string,
	location: string,
	migrations: ConfigValueMigration[],
): boolean {
	const value = record[key];
	if (typeof value !== "string") return false;
	const migrated = migrateLegacyEnvVarString(value);
	if (migrated === undefined) return false;
	record[key] = migrated;
	migrations.push({ location, from: value, to: migrated });
	return true;
}

function migrateHeadersConfig(headers: unknown, location: string, migrations: ConfigValueMigration[]): boolean {
	if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return false;
	const headerRecord = headers as Record<string, unknown>;
	let migrated = false;
	for (const [key, value] of Object.entries(headerRecord)) {
		if (typeof value !== "string") continue;
		const migratedValue = migrateLegacyEnvVarString(value);
		if (migratedValue === undefined) continue;
		headerRecord[key] = migratedValue;
		migrations.push({ location: `${location}[${JSON.stringify(key)}]`, from: value, to: migratedValue });
		migrated = true;
	}
	return migrated;
}

function migrateAuthJsonConfigValues(agentDir: string): ConfigValueMigration[] {
	const authPath = join(agentDir, "auth.json");
	if (!existsSync(authPath)) return [];

	try {
		const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
		const authData = parsed as Record<string, unknown>;

		const migrations: ConfigValueMigration[] = [];
		for (const [provider, credential] of Object.entries(authData)) {
			if (typeof credential !== "object" || credential === null || Array.isArray(credential)) continue;
			const credentialRecord = credential as Record<string, unknown>;
			if (credentialRecord.type !== "api_key") continue;
			migrateStringProperty(credentialRecord, "key", `auth.json[${JSON.stringify(provider)}].key`, migrations);
		}

		if (migrations.length === 0) return [];
		writeFileSync(authPath, `${JSON.stringify(parsed, null, 2)}\n`, AUTH_FILE_WRITE_OPTIONS);
		chmodSync(authPath, 0o600);
		return migrations;
	} catch {
		return [];
	}
}

function asConfigRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function migrateProviderModelHeaders(
	providerRecord: Record<string, unknown>,
	providerLocation: string,
	migrations: ConfigValueMigration[],
): void {
	if (!Array.isArray(providerRecord.models)) return;
	for (let index = 0; index < providerRecord.models.length; index++) {
		const modelRecord = asConfigRecord(providerRecord.models[index]);
		if (!modelRecord) continue;
		const modelKey = typeof modelRecord.id === "string" ? JSON.stringify(modelRecord.id) : String(index);
		migrateHeadersConfig(modelRecord.headers, `${providerLocation}.models[${modelKey}].headers`, migrations);
	}
}

function migrateProviderModelOverrideHeaders(
	providerRecord: Record<string, unknown>,
	providerLocation: string,
	migrations: ConfigValueMigration[],
): void {
	const modelOverrides = asConfigRecord(providerRecord.modelOverrides);
	if (!modelOverrides) return;
	for (const [modelId, modelOverride] of Object.entries(modelOverrides)) {
		const modelOverrideRecord = asConfigRecord(modelOverride);
		if (!modelOverrideRecord) continue;
		migrateHeadersConfig(
			modelOverrideRecord.headers,
			`${providerLocation}.modelOverrides[${JSON.stringify(modelId)}].headers`,
			migrations,
		);
	}
}

function migrateProviderConfigValues(
	provider: string,
	providerConfig: unknown,
	migrations: ConfigValueMigration[],
): void {
	const providerRecord = asConfigRecord(providerConfig);
	if (!providerRecord) return;
	const providerLocation = `models.json.providers[${JSON.stringify(provider)}]`;
	migrateStringProperty(providerRecord, "apiKey", `${providerLocation}.apiKey`, migrations);
	migrateHeadersConfig(providerRecord.headers, `${providerLocation}.headers`, migrations);
	migrateProviderModelHeaders(providerRecord, providerLocation, migrations);
	migrateProviderModelOverrideHeaders(providerRecord, providerLocation, migrations);
}

function migrateModelsJsonConfigValues(agentDir: string): ConfigValueMigration[] {
	const modelsPath = join(agentDir, "models.json");
	if (!existsSync(modelsPath)) return [];

	const parsed = JSON.parse(stripJsonComments(readFileSync(modelsPath, "utf-8"))) as unknown;
	const modelsData = asConfigRecord(parsed);
	if (!modelsData) return [];
	const providers = asConfigRecord(modelsData.providers);
	if (!providers) return [];

	const migrations: ConfigValueMigration[] = [];
	for (const [provider, providerConfig] of Object.entries(providers)) {
		migrateProviderConfigValues(provider, providerConfig, migrations);
	}
	if (migrations.length === 0) return [];
	writeFileSync(modelsPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
	return migrations;
}

function migrateExplicitEnvVarConfigValues(): void {
	const agentDir = getAgentDir();
	const migrations = [...migrateAuthJsonConfigValues(agentDir), ...migrateModelsJsonConfigValues(agentDir)];
	if (migrations.length === 0) return;

	const details = migrations.map((migration) => `  - ${migration.location}: ${migration.from} -> ${migration.to}`);
	console.log(
		chalk.yellow(
			[
				"Warning: Migrated API key/header environment references to explicit $ENV_VAR syntax. Plain strings will be treated as literals.",
				...details,
			].join("\n"),
		),
	);
}

/**
 * Migrate sessions from ~/.pi/agent/*.jsonl to proper session directories.
 *
 * Bug in v0.30.0: Sessions were saved to ~/.pi/agent/ instead of
 * ~/.pi/agent/sessions/<encoded-cwd>/. This migration moves them
 * to the correct location based on the cwd in their session header.
 *
 * See: https://github.com/fleetagent/pi/issues/320
 */
export function migrateSessionsFromAgentRoot(): void {
	const agentDir = getAgentDir();

	// Find all .jsonl files directly in agentDir (not in subdirectories)
	let files: string[];
	try {
		files = readdirSync(agentDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(agentDir, f));
	} catch {
		return;
	}

	if (files.length === 0) return;

	for (const file of files) {
		try {
			// Read first line to get session header
			const content = readFileSync(file, "utf8");
			const firstLine = content.split("\n")[0];
			if (!firstLine?.trim()) continue;

			const header = JSON.parse(firstLine);
			if (header.type !== "session" || !header.cwd) continue;

			const cwd: string = header.cwd;

			// Compute the correct session directory (same encoding as session-manager.ts)
			const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			const correctDir = join(agentDir, "sessions", safePath);

			// Create directory if needed
			if (!existsSync(correctDir)) {
				mkdirSync(correctDir, { recursive: true });
			}

			// Move the file
			const fileName = file.split("/").pop() || file.split("\\").pop();
			const newPath = join(correctDir, fileName!);

			if (existsSync(newPath)) continue; // Skip if target exists

			renameSync(file, newPath);
		} catch {
			// Skip files that can't be migrated
		}
	}
}

/**
 * Migrate commands/ to prompts/ if needed.
 * Works for both regular directories and symlinks.
 */
function migrateCommandsToPrompts(baseDir: string, label: string): boolean {
	const commandsDir = join(baseDir, "commands");
	const promptsDir = join(baseDir, "prompts");

	if (existsSync(commandsDir) && !existsSync(promptsDir)) {
		try {
			renameSync(commandsDir, promptsDir);
			console.log(chalk.green(`Migrated ${label} commands/ → prompts/`));
			return true;
		} catch (err) {
			console.log(
				chalk.yellow(
					`Warning: Could not migrate ${label} commands/ to prompts/: ${err instanceof Error ? err.message : err}`,
				),
			);
		}
	}
	return false;
}

function migrateKeybindingsConfigFile(): void {
	const configPath = join(getAgentDir(), "keybindings.json");
	if (!existsSync(configPath)) return;

	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return;
		}
		const { config, migrated } = migrateKeybindingsConfig(parsed as Record<string, unknown>);
		if (!migrated) return;
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch {
		// Ignore malformed files during migration
	}
}

/**
 * Move fd/rg binaries from tools/ to bin/ if they exist.
 */
function migrateToolsToBin(): void {
	const agentDir = getAgentDir();
	const toolsDir = join(agentDir, "tools");
	const binDir = getBinDir();

	if (!existsSync(toolsDir)) return;

	const binaries = ["fd", "rg", "fd.exe", "rg.exe"];
	let movedAny = false;
	for (const binary of binaries) {
		if (migrateManagedBinary(toolsDir, binDir, binary)) movedAny = true;
	}

	if (movedAny) {
		console.log(chalk.green(`Migrated managed binaries tools/ → bin/`));
	}
}

function migrateManagedBinary(toolsDir: string, binDir: string, binary: string): boolean {
	const oldPath = join(toolsDir, binary);
	if (!existsSync(oldPath)) return false;

	if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });
	const newPath = join(binDir, binary);
	if (existsSync(newPath)) {
		try {
			rmSync?.(oldPath, { force: true });
		} catch {
			// Ignore cleanup errors
		}
		return false;
	}

	try {
		renameSync(oldPath, newPath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check for the deprecated tools/ extension directory.
 * The hooks/ name is active again for command-hook scripts and must not be treated as a legacy extension directory.
 * tools/ may contain fd/rg binaries extracted by pi, so only warn if it has other files.
 */
function checkDeprecatedExtensionDirs(baseDir: string, label: string): string[] {
	const toolsDir = join(baseDir, "tools");
	const warnings: string[] = [];

	if (existsSync(toolsDir)) {
		// Check if tools/ contains anything other than fd/rg (which are auto-extracted binaries)
		try {
			const entries = readdirSync(toolsDir);
			const customTools = entries.filter((e) => {
				const lower = e.toLowerCase();
				return (
					lower !== "fd" && lower !== "rg" && lower !== "fd.exe" && lower !== "rg.exe" && !e.startsWith(".") // Ignore .DS_Store and other hidden files
				);
			});
			if (customTools.length > 0) {
				warnings.push(
					`${label} tools/ directory contains custom tools. Custom tools have been merged into extensions.`,
				);
			}
		} catch {
			// Ignore read errors
		}
	}

	return warnings;
}

/**
 * Run extension system migrations (commands→prompts) and collect warnings about deprecated directories.
 */
function migrateExtensionSystem(cwd: string): string[] {
	const agentDir = getAgentDir();
	const projectDir = join(cwd, CONFIG_DIR_NAME);

	// Migrate commands/ to prompts/
	migrateCommandsToPrompts(agentDir, "Global");
	migrateCommandsToPrompts(projectDir, "Project");

	// Check for deprecated directories
	const warnings = [
		...checkDeprecatedExtensionDirs(agentDir, "Global"),
		...checkDeprecatedExtensionDirs(projectDir, "Project"),
	];

	return warnings;
}

/**
 * Print deprecation warnings and wait for keypress.
 */
export async function showDeprecationWarnings(warnings: string[]): Promise<void> {
	if (warnings.length === 0) return;

	for (const warning of warnings) {
		console.log(chalk.yellow(`Warning: ${warning}`));
	}
	console.log(chalk.yellow(`\nMove your extensions to the extensions/ directory.`));
	console.log(chalk.yellow(`Migration guide: ${MIGRATION_GUIDE_URL}`));
	console.log(chalk.yellow(`Documentation: ${EXTENSIONS_DOC_URL}`));
	console.log(chalk.dim(`\nPress any key to continue...`));

	await new Promise<void>((resolve) => {
		process.stdin.setRawMode?.(true);
		process.stdin.resume();
		process.stdin.once("data", () => {
			process.stdin.setRawMode?.(false);
			process.stdin.pause();
			resolve();
		});
	});
	console.log();
}
interface MigrationRunResult {
	migratedAuthProviders: string[];
	deprecationWarnings: string[];
}

/**
 * Run all migrations. Called once on startup.
 *
 * @returns Object with migration results and deprecation warnings
 */
export function runMigrations(cwd: string): MigrationRunResult {
	const migratedAuthProviders = migrateAuthToAuthJson();
	migrateExplicitEnvVarConfigValues();
	migrateSessionsFromAgentRoot();
	migrateToolsToBin();
	migrateKeybindingsConfigFile();
	const deprecationWarnings = migrateExtensionSystem(cwd);
	return { migratedAuthProviders, deprecationWarnings };
}
