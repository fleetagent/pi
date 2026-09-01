/**
 * CLI argument parsing and help display
 */

import type { ThinkingLevel } from "@fleetagent/pi-agent-core";
import type { TuiMode } from "@fleetagent/pi-tui";
import chalk from "chalk";
import {
	APP_NAME,
	CONFIG_DIR_NAME,
	ENV_AGENT_DIR,
	ENV_REMOTE_PROJECT_ID,
	ENV_REMOTE_SESSION_BASE_URL,
	ENV_REMOTE_SESSION_TOKEN,
	ENV_SESSION_DIR,
} from "../config.ts";
import type { ExtensionFlag } from "../core/extensions/types.ts";

export type Mode = "text" | "json" | "rpc";

export type CliDiagnosticSeverity = "warning" | "error";

export interface CliDiagnostic {
	type: CliDiagnosticSeverity;
	message: string;
}

export interface Args {
	provider?: string;
	model?: string;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	thinking?: ThinkingLevel;
	continue?: boolean;
	resume?: boolean;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	noSession?: boolean;
	session?: string;
	fork?: string;
	sessionDir?: string;
	lspConfig?: string;
	noLsp?: boolean;
	remoteSessionBaseUrl?: string;
	remoteSessionToken?: string;
	remoteProjectId?: string;
	models?: string[];
	tools?: string[];
	noTools?: boolean;
	noBuiltinTools?: boolean;
	/** Explicitly trust project/local Claude hooks as trusted host code. */
	trustProjectHooks?: boolean;
	extensions?: string[];
	noExtensions?: boolean;
	print?: boolean;
	export?: string;
	noSkills?: boolean;
	skills?: string[];
	noRules?: boolean;
	rules?: string[];
	promptTemplates?: string[];
	noPromptTemplates?: boolean;
	themes?: string[];
	noThemes?: boolean;
	noContextFiles?: boolean;
	listModels?: string | true;
	offline?: boolean;
	tuiMode?: TuiMode;
	verbose?: boolean;
	remote?: string;
	remoteDeferred?: boolean;
	remoteCwd?: string;
	messages: string[];
	fileArgs: string[];
	/** Unknown flags (potentially extension flags) - map of flag name to value */
	unknownFlags: Map<string, boolean | string>;
	diagnostics: CliDiagnostic[];
}

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
}

type CliBooleanFlagHandler = (result: Args) => void;
type CliValueFlagHandler = (result: Args, value: string) => void;

interface CliArgumentParseContext {
	args: string[];
	result: Args;
	index: number;
	arg: string;
}

type CliSpecialFlagHandler = (context: CliArgumentParseContext) => number;

function appendArgumentValue(values: string[] | undefined, value: string): string[] {
	const nextValues = values ?? [];
	nextValues.push(value);
	return nextValues;
}

const BOOLEAN_FLAG_HANDLERS = new Map<string, CliBooleanFlagHandler>([
	["--help", (result) => (result.help = true)],
	["-h", (result) => (result.help = true)],
	["--version", (result) => (result.version = true)],
	["-v", (result) => (result.version = true)],
	["--continue", (result) => (result.continue = true)],
	["-c", (result) => (result.continue = true)],
	["--resume", (result) => (result.resume = true)],
	["-r", (result) => (result.resume = true)],
	["--no-session", (result) => (result.noSession = true)],
	["--no-lsp", (result) => (result.noLsp = true)],
	["--no-tools", (result) => (result.noTools = true)],
	["-nt", (result) => (result.noTools = true)],
	["--no-builtin-tools", (result) => (result.noBuiltinTools = true)],
	["-nbt", (result) => (result.noBuiltinTools = true)],
	["--trust-project-hooks", (result) => (result.trustProjectHooks = true)],
	["--no-extensions", (result) => (result.noExtensions = true)],
	["-ne", (result) => (result.noExtensions = true)],
	["--no-skills", (result) => (result.noSkills = true)],
	["-ns", (result) => (result.noSkills = true)],
	["--no-rules", (result) => (result.noRules = true)],
	["-nr", (result) => (result.noRules = true)],
	["--no-prompt-templates", (result) => (result.noPromptTemplates = true)],
	["-np", (result) => (result.noPromptTemplates = true)],
	["--no-themes", (result) => (result.noThemes = true)],
	["--no-context-files", (result) => (result.noContextFiles = true)],
	["-nc", (result) => (result.noContextFiles = true)],
	["--verbose", (result) => (result.verbose = true)],
	["--offline", (result) => (result.offline = true)],
	["--remote-deferred", (result) => (result.remoteDeferred = true)],
]);

const VALUE_FLAG_HANDLERS = new Map<string, CliValueFlagHandler>([
	[
		"--mode",
		(result, value) => {
			if (value === "text" || value === "json" || value === "rpc") result.mode = value;
		},
	],
	["--provider", (result, value) => (result.provider = value)],
	["--model", (result, value) => (result.model = value)],
	["--api-key", (result, value) => (result.apiKey = value)],
	["--system-prompt", (result, value) => (result.systemPrompt = value)],
	[
		"--append-system-prompt",
		(result, value) => (result.appendSystemPrompt = appendArgumentValue(result.appendSystemPrompt, value)),
	],
	["--session", (result, value) => (result.session = value)],
	["--fork", (result, value) => (result.fork = value)],
	["--session-dir", (result, value) => (result.sessionDir = value)],
	["--remote-session-base-url", (result, value) => (result.remoteSessionBaseUrl = value)],
	["--remote-session-token", (result, value) => (result.remoteSessionToken = value)],
	["--remote-project-id", (result, value) => (result.remoteProjectId = value)],
	["--models", (result, value) => (result.models = value.split(",").map((item) => item.trim()))],
	[
		"--tools",
		(result, value) =>
			(result.tools = value
				.split(",")
				.map((item) => item.trim())
				.filter((name) => name.length > 0)),
	],
	[
		"-t",
		(result, value) =>
			(result.tools = value
				.split(",")
				.map((item) => item.trim())
				.filter((name) => name.length > 0)),
	],
	[
		"--thinking",
		(result, value) => {
			if (isValidThinkingLevel(value)) {
				result.thinking = value;
			} else {
				result.diagnostics.push({
					type: "warning",
					message: `Invalid thinking level "${value}". Valid values: ${VALID_THINKING_LEVELS.join(", ")}`,
				});
			}
		},
	],
	["--export", (result, value) => (result.export = value)],
	["--extension", (result, value) => (result.extensions = appendArgumentValue(result.extensions, value))],
	["-e", (result, value) => (result.extensions = appendArgumentValue(result.extensions, value))],
	["--skill", (result, value) => (result.skills = appendArgumentValue(result.skills, value))],
	["--rule", (result, value) => (result.rules = appendArgumentValue(result.rules, value))],
	[
		"--prompt-template",
		(result, value) => (result.promptTemplates = appendArgumentValue(result.promptTemplates, value)),
	],
	["--theme", (result, value) => (result.themes = appendArgumentValue(result.themes, value))],
	["--remote", (result, value) => (result.remote = value)],
	["--remote-cwd", (result, value) => (result.remoteCwd = value)],
]);

function handleLspConfigFlag(context: CliArgumentParseContext): number {
	const next = context.args[context.index + 1];
	if (next === undefined || next.startsWith("-")) {
		context.result.diagnostics.push({ type: "error", message: "--lsp-config requires a file path" });
		return context.index;
	}
	context.result.lspConfig = next;
	return context.index + 1;
}

function handlePrintFlag(context: CliArgumentParseContext): number {
	context.result.print = true;
	const next = context.args[context.index + 1];
	if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
		context.result.messages.push(next);
		return context.index + 1;
	}
	return context.index;
}

function handleListModelsFlag(context: CliArgumentParseContext): number {
	const next = context.args[context.index + 1];
	if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
		context.result.listModels = next;
		return context.index + 1;
	}
	context.result.listModels = true;
	return context.index;
}

function handleTuiModeFlag(context: CliArgumentParseContext): number {
	const mode = context.args[context.index + 1];
	if (mode === "regular" || mode === "fullscreen") {
		context.result.tuiMode = mode;
		return context.index + 1;
	}
	if (mode === undefined || mode.startsWith("-")) {
		context.result.diagnostics.push({ type: "error", message: "--tui-mode requires regular or fullscreen" });
		return context.index;
	}
	context.result.diagnostics.push({
		type: "error",
		message: `Invalid TUI mode "${mode}". Valid values: regular, fullscreen`,
	});
	return context.index + 1;
}

function handleRemovedSshFlag(context: CliArgumentParseContext): number {
	context.result.diagnostics.push({
		type: "error",
		message:
			context.arg === "--ssh"
				? "--ssh was removed; use --remote <ws://url>"
				: `${context.arg} was removed; use --remote-deferred --remote-cwd <path>`,
	});
	const value = context.args[context.index + 1];
	if ((context.arg === "--ssh" || context.arg === "--ssh-cwd") && value !== undefined && !value.startsWith("-")) {
		return context.index + 1;
	}
	return context.index;
}

const SPECIAL_FLAG_HANDLERS = new Map<string, CliSpecialFlagHandler>([
	["--lsp-config", handleLspConfigFlag],
	["--print", handlePrintFlag],
	["-p", handlePrintFlag],
	["--list-models", handleListModelsFlag],
	["--tui-mode", handleTuiModeFlag],
	["--ssh", handleRemovedSshFlag],
	["--ssh-deferred", handleRemovedSshFlag],
	["--ssh-cwd", handleRemovedSshFlag],
]);

function handleMappedCliFlag(context: CliArgumentParseContext): number | undefined {
	const booleanHandler = BOOLEAN_FLAG_HANDLERS.get(context.arg);
	if (booleanHandler) {
		booleanHandler(context.result);
		return context.index;
	}
	const valueHandler = VALUE_FLAG_HANDLERS.get(context.arg);
	const value = context.args[context.index + 1];
	if (!valueHandler || value === undefined) return undefined;
	valueHandler(context.result, value);
	return context.index + 1;
}

function handleFallbackCliArgument(context: CliArgumentParseContext): number {
	const { arg, args, result, index } = context;
	if (arg.startsWith("@")) {
		result.fileArgs.push(arg.slice(1));
		return index;
	}
	if (arg.startsWith("--")) {
		const equalsIndex = arg.indexOf("=");
		if (equalsIndex !== -1) {
			result.unknownFlags.set(arg.slice(2, equalsIndex), arg.slice(equalsIndex + 1));
			return index;
		}
		const flagName = arg.slice(2);
		const next = args[index + 1];
		if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
			result.unknownFlags.set(flagName, next);
			return index + 1;
		}
		result.unknownFlags.set(flagName, true);
		return index;
	}
	if (arg.startsWith("-")) {
		result.diagnostics.push({ type: "error", message: `Unknown option: ${arg}` });
		return index;
	}
	result.messages.push(arg);
	return index;
}

export function parseArgs(args: string[]): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};
	for (let index = 0; index < args.length; index++) {
		const context: CliArgumentParseContext = { args, result, index, arg: args[index] };
		const mappedIndex = handleMappedCliFlag(context);
		if (mappedIndex !== undefined) {
			index = mappedIndex;
			continue;
		}
		const specialHandler = SPECIAL_FLAG_HANDLERS.get(context.arg);
		if (specialHandler) {
			index = specialHandler(context);
			continue;
		}
		index = handleFallbackCliArgument(context);
	}
	return result;
}

export function printHelp(extensionFlags?: ExtensionFlag[]): void {
	const extensionFlagsText =
		extensionFlags && extensionFlags.length > 0
			? `\n${chalk.bold("Extension CLI Flags:")}\n${extensionFlags
					.map((flag) => {
						const value = flag.type === "string" ? " <value>" : "";
						const description = flag.description ?? `Registered by ${flag.extensionPath}`;
						return `  --${flag.name}${value}`.padEnd(30) + description;
					})
					.join("\n")}\n`
			: "";
	console.log(`${chalk.bold(APP_NAME)} - AI coding assistant with read, bash, edit, write tools

${chalk.bold("Usage:")}
  ${APP_NAME} [options] [@files...] [messages...]

${chalk.bold("Commands:")}
  ${APP_NAME} install <source> [-l]     Install extension source and add to settings
  ${APP_NAME} remove <source> [-l]      Remove extension source from settings
  ${APP_NAME} uninstall <source> [-l]   Alias for remove
  ${APP_NAME} update [source|self|pi]   Update pi and installed extensions
  ${APP_NAME} list                      List installed extensions from settings
  ${APP_NAME} config                    Open TUI to enable/disable package resources
  ${APP_NAME} --daemon [options]        Start the remote workspace runtime
  ${APP_NAME} <command> --help          Show help for install/remove/uninstall/update/list

${chalk.bold("Options:")}
  --daemon                       Start daemon mode; use --daemon --help for daemon options
  --provider <name>              Provider name (default: google)
  --model <pattern>              Model pattern or ID (supports "provider/id" and optional ":<thinking>")
  --api-key <key>                API key (defaults to env vars)
  --system-prompt <text>         System prompt (default: coding assistant prompt)
  --append-system-prompt <text>  Append text or file contents to the system prompt (can be used multiple times)
  --mode <mode>                  Output mode: text (default), json, or rpc
  --print, -p                    Non-interactive mode: process prompt and exit
  --continue, -c                 Continue previous session
  --resume, -r                   Select a session to resume
  --session <path|id>            Use specific session file or partial UUID
  --fork <path|id>               Fork specific session file or partial UUID into a new session
  --session-dir <dir>            Directory for session storage and lookup
  --lsp-config <file>            Load an explicit LSP configuration file
  --no-lsp                      Disable the LSP runtime regardless of tool selection
  --remote-session-base-url <url> Use remote session service for persistence
  --remote-session-token <token> Bearer token for remote session service
  --remote-project-id <id>       Project id sent to remote session service
  --no-session                   Don't save session (ephemeral)
  --models <patterns>            Comma-separated model patterns for Ctrl+P cycling
                                 Supports globs (anthropic/*, *sonnet*) and fuzzy matching
  --no-tools, -nt                Disable all tools by default (built-in and extension)
  --no-builtin-tools, -nbt       Disable built-in tools by default but keep extension/custom tools enabled
  --tools, -t <tools>            Comma-separated allowlist of tool names to enable
                                 Applies to built-in, extension, and custom tools
  --thinking <level>             Set thinking level: off, minimal, low, medium, high, xhigh
  --trust-project-hooks          Trust and run project .pi/.claude hooks as host code (review them first)
  --extension, -e <path>         Load an extension file (can be used multiple times)
  --no-extensions, -ne           Disable extension discovery (explicit -e paths still work)
  --skill <path>                 Load a skill file or directory (can be used multiple times)
  --no-skills, -ns               Disable skills discovery and loading
  --rule <path>                  Load a rule file or directory (can be used multiple times)
  --no-rules, -nr                Disable rules discovery and loading
  --prompt-template <path>       Load a prompt template file or directory (can be used multiple times)
  --no-prompt-templates, -np     Disable prompt template discovery and loading
  --theme <path>                 Load a theme file or directory (can be used multiple times)
  --no-themes                    Disable theme discovery and loading
  --no-context-files, -nc        Disable AGENTS.md and CLAUDE.md discovery and loading
  --export <file>                Export session file to HTML and exit
  --list-models [search]         List available models (with optional fuzzy search)
  --tui-mode <mode>              TUI mode: regular (default) or fullscreen
  --verbose                      Force verbose startup (overrides quietStartup setting)
  --offline                      Disable startup network operations (same as PI_OFFLINE=1)
  --remote <url>                 Run built-in tools through a pi --daemon backend (ws:// or wss://)
  --remote-deferred              Start without a connected daemon backend; configure later with /sandbox
  --remote-cwd <path>            Stable backend cwd for --remote-deferred
  --help, -h                     Show this help
  --version, -v                  Show version number

Extensions can register additional flags (e.g., --plan from plan-mode extension).${extensionFlagsText}

${chalk.bold("Examples:")}
  # Interactive mode
  ${APP_NAME}

  # Interactive mode with initial prompt
  ${APP_NAME} "List all .ts files in src/"

  # Include files in initial message
  ${APP_NAME} @prompt.md @image.png "What color is the sky?"

  # Non-interactive mode (process and exit)
  ${APP_NAME} -p "List all .ts files in src/"

  # Multiple messages (interactive)
  ${APP_NAME} "Read package.json" "What dependencies do we have?"

  # Continue previous session
  ${APP_NAME} --continue "What did we discuss?"

  # Use different model
  ${APP_NAME} --provider openai --model gpt-4o-mini "Help me refactor this code"

  # Use model with provider prefix (no --provider needed)
  ${APP_NAME} --model openai/gpt-4o "Help me refactor this code"

  # Use model with thinking level shorthand
  ${APP_NAME} --model sonnet:high "Solve this complex problem"

  # Limit model cycling to specific models
  ${APP_NAME} --models claude-sonnet,claude-haiku,gpt-4o

  # Limit to a specific provider with glob pattern
  ${APP_NAME} --models "github-copilot/*"

  # Cycle models with fixed thinking levels
  ${APP_NAME} --models sonnet:high,haiku:low

  # Start with a specific thinking level
  ${APP_NAME} --thinking high "Solve this complex problem"

  # Read-only mode (no file modifications possible)
  ${APP_NAME} --tools read,grep,find,ls -p "Review the code in src/"

  # Run built-in tools through a remote workspace daemon
  ${APP_NAME} --remote ws://localhost:8787 "Inspect this repo"

  # Start without a connected daemon backend and attach later with /sandbox
  ${APP_NAME} --remote-deferred --remote-cwd /workspace

  # Export a session file to HTML
  ${APP_NAME} --export ~/${CONFIG_DIR_NAME}/agent/sessions/--path--/session.jsonl
  ${APP_NAME} --export session.jsonl output.html

${chalk.bold("Environment Variables:")}
  ANTHROPIC_API_KEY                - Anthropic Claude API key
  ANTHROPIC_OAUTH_TOKEN            - Anthropic OAuth token (alternative to API key)
  OPENAI_API_KEY                   - OpenAI GPT API key
  AZURE_OPENAI_API_KEY             - Azure OpenAI API key
  AZURE_OPENAI_BASE_URL            - Azure OpenAI/Cognitive Services base URL (e.g. https://{resource}.openai.azure.com)
  AZURE_OPENAI_RESOURCE_NAME       - Azure OpenAI resource name (alternative to base URL)
  AZURE_OPENAI_API_VERSION         - Azure OpenAI API version (default: v1)
  AZURE_OPENAI_DEPLOYMENT_NAME_MAP - Azure OpenAI model=deployment map (comma-separated)
  DEEPSEEK_API_KEY                 - DeepSeek API key
  GEMINI_API_KEY                   - Google Gemini API key
  GROQ_API_KEY                     - Groq API key
  CEREBRAS_API_KEY                 - Cerebras API key
  XAI_API_KEY                      - xAI Grok API key
  FIREWORKS_API_KEY                - Fireworks API key
  TOGETHER_API_KEY                 - Together AI API key
  OPENROUTER_API_KEY               - OpenRouter API key
  AI_GATEWAY_API_KEY               - Vercel AI Gateway API key
  ZAI_API_KEY                      - ZAI API key
  MISTRAL_API_KEY                  - Mistral API key
  MINIMAX_API_KEY                  - MiniMax API key
  MOONSHOT_API_KEY                 - Moonshot AI API key
  OPENCODE_API_KEY                 - OpenCode Zen/OpenCode Go API key
  KIMI_API_KEY                     - Kimi For Coding API key
  CLOUDFLARE_API_KEY               - Cloudflare API token (Workers AI and AI Gateway)
  CLOUDFLARE_ACCOUNT_ID            - Cloudflare account id (required for both)
  CLOUDFLARE_GATEWAY_ID            - Cloudflare AI Gateway slug (required for AI Gateway)
  XIAOMI_API_KEY                   - Xiaomi MiMo API key (api.xiaomimimo.com billing)
  XIAOMI_TOKEN_PLAN_CN_API_KEY     - Xiaomi MiMo Token Plan API key (China region)
  XIAOMI_TOKEN_PLAN_AMS_API_KEY    - Xiaomi MiMo Token Plan API key (Amsterdam region)
  XIAOMI_TOKEN_PLAN_SGP_API_KEY    - Xiaomi MiMo Token Plan API key (Singapore region)
  AWS_PROFILE                      - AWS profile for Amazon Bedrock
  AWS_ACCESS_KEY_ID                - AWS access key for Amazon Bedrock
  AWS_SECRET_ACCESS_KEY            - AWS secret key for Amazon Bedrock
  AWS_BEARER_TOKEN_BEDROCK         - Bedrock API key (bearer token)
  AWS_REGION                       - AWS region for Amazon Bedrock (e.g., us-east-1)
  ${ENV_AGENT_DIR.padEnd(32)} - Config directory (default: ~/${CONFIG_DIR_NAME}/agent)
  ${ENV_SESSION_DIR.padEnd(32)} - Session storage directory (overridden by --session-dir)
  ${ENV_REMOTE_SESSION_BASE_URL.padEnd(32)} - Remote session service URL
  ${ENV_REMOTE_SESSION_TOKEN.padEnd(32)} - Bearer token for remote session service
  ${ENV_REMOTE_PROJECT_ID.padEnd(32)} - Project id sent to remote session service
  PI_PACKAGE_DIR                   - Override package directory (for Nix/Guix store paths)
  PI_OFFLINE                       - Disable startup network operations when set to 1/true/yes
  PI_TELEMETRY                     - Override install telemetry when set to 1/true/yes or 0/false/no
  PI_SHARE_VIEWER_URL              - Base URL for /share command (default: https://pi.dev/session/)

${chalk.bold("Built-in Tool Names:")}
  read   - Read file contents
  bash   - Execute bash commands
  edit   - Edit files with find/replace
  write  - Write files (creates/overwrites)
  grep   - Search file contents (read-only, off by default)
  find   - Find files by glob pattern (read-only, off by default)
  ls     - List directory contents (read-only, off by default)
  websearch - Search the web for relevant links using DuckDuckGo, Brave Search, or Firecrawl

${chalk.bold("Conditional LSP Tool Names:")}
  Requires a valid LSP configuration; unavailable when LSP is disabled or unconfigured.
  lsp_diagnostics   - Get diagnostics for a file
  lsp_hover         - Get hover information for a symbol
  lsp_definition    - Find a symbol definition
  lsp_references    - Find symbol references
  lsp_rename        - Preview a symbol rename
  lsp_code_actions  - List code actions and refactorings
`);
}
