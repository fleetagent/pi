import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { matchHookValue } from "./matcher.ts";
import {
	type CommandHookHandler,
	HOOK_EVENT_NAMES,
	type HookDiagnostic,
	type HookEventName,
	type HookHandler,
	type HookHandlerCommon,
	type HookSettingsSource,
	type HookSettingsSourceKind,
	type HttpHookHandler,
	type LoadedHookHandler,
	type LoadedHooks,
} from "./types.ts";

export interface LoadHooksOptions {
	cwd: string;
	home?: string;
	/** Active Pi agent directory. Defaults to ~/.pi/agent. */
	agentDir?: string;
	/** Settings sources to discover. Defaults to trusted user hooks only. */
	sources?: readonly HookSettingsSourceKind[];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isEvent(value: string): value is HookEventName {
	return (HOOK_EVENT_NAMES as readonly string[]).includes(value);
}
function optionalCommon(value: Record<string, unknown>): boolean {
	return (
		(value.timeout === undefined ||
			(typeof value.timeout === "number" && Number.isFinite(value.timeout) && value.timeout > 0)) &&
		(value.if === undefined || typeof value.if === "string") &&
		(value.statusMessage === undefined || typeof value.statusMessage === "string")
	);
}
function parseHookHandlerCommon(value: Record<string, unknown>): HookHandlerCommon | undefined {
	if (!optionalCommon(value)) return undefined;
	return {
		...(typeof value.timeout === "number" ? { timeout: value.timeout } : {}),
		...(typeof value.if === "string" ? { if: value.if } : {}),
		...(typeof value.statusMessage === "string" ? { statusMessage: value.statusMessage } : {}),
	};
}

function parseCommandHookHandler(
	value: Record<string, unknown>,
	common: HookHandlerCommon,
): CommandHookHandler | undefined {
	// Background hooks are outside Phase 0; do not silently run them synchronously.
	if (value.async !== undefined || value.asyncRewake !== undefined) return undefined;
	if (typeof value.command !== "string" || (value.args !== undefined && !isStringArray(value.args))) {
		return undefined;
	}
	if (value.shell !== undefined && value.shell !== "bash" && value.shell !== "powershell") return undefined;
	return {
		type: "command",
		command: value.command,
		...common,
		...(value.args !== undefined ? { args: value.args } : {}),
		...(value.shell !== undefined ? { shell: value.shell } : {}),
	};
}

function parseHttpHookHandler(value: Record<string, unknown>, common: HookHandlerCommon): HttpHookHandler | undefined {
	if (typeof value.url !== "string") return undefined;
	let headers: Record<string, string> | undefined;
	if (value.headers !== undefined) {
		if (!isObject(value.headers) || !Object.values(value.headers).every((item) => typeof item === "string")) {
			return undefined;
		}
		headers = Object.fromEntries(Object.entries(value.headers).map(([key, item]) => [key, String(item)]));
	}
	if (value.allowedEnvVars !== undefined && !isStringArray(value.allowedEnvVars)) return undefined;
	return {
		type: "http",
		url: value.url,
		...common,
		...(headers ? { headers } : {}),
		...(value.allowedEnvVars !== undefined ? { allowedEnvVars: value.allowedEnvVars } : {}),
	};
}

function parseHandler(value: unknown): HookHandler | undefined {
	if (!isObject(value) || typeof value.type !== "string") return undefined;
	const common = parseHookHandlerCommon(value);
	if (!common) return undefined;

	switch (value.type) {
		case "command":
			return parseCommandHookHandler(value, common);
		case "http":
			return parseHttpHookHandler(value, common);
		case "prompt":
		case "agent":
		case "mcp_tool":
			return { type: value.type, ...common };
		default:
			return undefined;
	}
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isObject(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

function handlerKey(event: HookEventName, matcher: string | undefined, handler: HookHandler): string {
	return `${event}\0${matcher ?? ""}\0${canonical(handler)}`;
}

function urlAllowed(url: string, allowlist: readonly string[]): boolean {
	return allowlist.some((pattern) => {
		if (pattern === url) return true;
		const expression = pattern
			.split("*")
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*");
		return new RegExp(`^${expression}$`).test(url);
	});
}

export function hookSettingsSources(
	cwd: string,
	home = homedir(),
	kinds: readonly HookSettingsSourceKind[] = ["user"],
	agentDir = join(home, ".pi", "agent"),
): HookSettingsSource[] {
	const available: Record<"user" | "project" | "local", HookSettingsSource[]> = {
		user: [
			{ kind: "user", path: join(agentDir, "settings.json") },
			{ kind: "user", path: join(home, ".claude", "settings.json") },
		],
		project: [
			{ kind: "project", path: join(cwd, ".pi", "settings.json") },
			{ kind: "project", path: join(cwd, ".claude", "settings.json") },
		],
		local: [{ kind: "local", path: join(cwd, ".claude", "settings.local.json") }],
	};
	return kinds.flatMap((kind) => (kind === "host" ? [] : available[kind]));
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return Object.freeze(value);
}

/** Clone and recursively freeze a host-provided hook snapshot. */
export function freezeLoadedHooks(loaded: LoadedHooks): LoadedHooks {
	return deepFreeze(structuredClone(loaded));
}

interface HookLoadState {
	diagnostics: HookDiagnostic[];
	handlers: LoadedHookHandler[];
	allowedHttpHookUrls: string[];
	httpHookAllowedEnvVars: string[];
	hasHttpUrlPolicy: boolean;
	hasHttpEnvPolicy: boolean;
	seen: Set<string>;
	disableAllHooks: boolean | undefined;
	nextOrder: number;
}

interface ValidatedHookGroup {
	hooks: unknown[];
	matcher?: string;
}

async function readHookSettings(
	source: HookSettingsSource,
	diagnostics: HookDiagnostic[],
): Promise<Record<string, unknown> | undefined> {
	let text: string;
	try {
		text = await readFile(source.path, "utf8");
	} catch (error) {
		if (isObject(error) && error.code === "ENOENT") return undefined;
		diagnostics.push({
			level: "error",
			code: "read",
			message: `Unable to read ${source.path}: ${String(error)}`,
			source,
		});
		return undefined;
	}

	let settings: unknown;
	try {
		settings = JSON.parse(text);
	} catch (error) {
		diagnostics.push({
			level: "error",
			code: "parse",
			message: `Malformed JSON in ${source.path}: ${String(error)}`,
			source,
		});
		return undefined;
	}
	if (isObject(settings)) return settings;
	diagnostics.push({
		level: "error",
		code: "schema",
		message: `Expected an object in ${source.path}`,
		source,
	});
	return undefined;
}

function applyHookPolicySettings(
	settings: Record<string, unknown>,
	source: HookSettingsSource,
	state: HookLoadState,
): void {
	if (settings.disableAllHooks !== undefined) {
		if (typeof settings.disableAllHooks === "boolean") state.disableAllHooks = settings.disableAllHooks;
		else {
			state.diagnostics.push({
				level: "error",
				code: "schema",
				message: "disableAllHooks must be a boolean",
				source,
			});
		}
	}
	if (settings.allowedHttpHookUrls !== undefined) {
		if (isStringArray(settings.allowedHttpHookUrls)) {
			state.hasHttpUrlPolicy = true;
			state.allowedHttpHookUrls.push(...settings.allowedHttpHookUrls);
		} else {
			state.diagnostics.push({
				level: "error",
				code: "schema",
				message: "allowedHttpHookUrls must be a string array",
				source,
			});
		}
	}
	if (settings.httpHookAllowedEnvVars !== undefined) {
		if (isStringArray(settings.httpHookAllowedEnvVars)) {
			state.hasHttpEnvPolicy = true;
			state.httpHookAllowedEnvVars.push(...settings.httpHookAllowedEnvVars);
		} else {
			state.diagnostics.push({
				level: "error",
				code: "schema",
				message: "httpHookAllowedEnvVars must be a string array",
				source,
			});
		}
	}
}

function validateHookGroup(
	event: HookEventName,
	rawGroup: unknown,
	source: HookSettingsSource,
	diagnostics: HookDiagnostic[],
): ValidatedHookGroup | undefined {
	if (
		!isObject(rawGroup) ||
		!Array.isArray(rawGroup.hooks) ||
		(rawGroup.matcher !== undefined && typeof rawGroup.matcher !== "string")
	) {
		diagnostics.push({
			level: "error",
			code: "schema",
			message: `Malformed ${event} hook group`,
			source,
			event,
		});
		return undefined;
	}
	const matcher = typeof rawGroup.matcher === "string" ? rawGroup.matcher : undefined;
	if (event !== "UserPromptSubmit" && event !== "Stop" && matcher !== undefined) {
		const result = matchHookValue(matcher, "");
		if (result.error !== undefined) {
			diagnostics.push({
				level: "error",
				code: "invalid-regex",
				message: result.error,
				source,
				event,
			});
			return undefined;
		}
	}
	return { hooks: rawGroup.hooks, ...(matcher !== undefined ? { matcher } : {}) };
}

function appendLoadedHookHandler(
	rawHandler: unknown,
	event: HookEventName,
	group: ValidatedHookGroup,
	source: HookSettingsSource,
	state: HookLoadState,
): void {
	const handler = parseHandler(rawHandler);
	if (!handler) {
		state.diagnostics.push({
			level: "error",
			code: "schema",
			message: `Malformed ${event} hook handler`,
			source,
			event,
		});
		return;
	}
	const key = handlerKey(event, group.matcher, handler);
	if (state.seen.has(key)) return;
	state.seen.add(key);
	state.handlers.push({
		event,
		matcher: group.matcher,
		handler,
		source,
		order: state.nextOrder++,
	});
	if (handler.type === "prompt" || handler.type === "agent" || handler.type === "mcp_tool") {
		state.diagnostics.push({
			level: "warning",
			code: "unsupported-handler",
			message: `${handler.type} hook handlers are not supported and will not execute`,
			source,
			event,
		});
	}
}

function loadHookEvent(eventName: string, rawGroups: unknown, source: HookSettingsSource, state: HookLoadState): void {
	if (!isEvent(eventName)) {
		state.diagnostics.push({
			level: "warning",
			code: "schema",
			message: `Unsupported hook event ${eventName}`,
			source,
		});
		return;
	}
	if (!Array.isArray(rawGroups)) {
		state.diagnostics.push({
			level: "error",
			code: "schema",
			message: `${eventName} must be an array`,
			source,
			event: eventName,
		});
		return;
	}
	for (const rawGroup of rawGroups) {
		const group = validateHookGroup(eventName, rawGroup, source, state.diagnostics);
		if (!group) continue;
		for (const rawHandler of group.hooks) {
			appendLoadedHookHandler(rawHandler, eventName, group, source, state);
		}
	}
}

function loadHookDefinitions(
	settings: Record<string, unknown>,
	source: HookSettingsSource,
	state: HookLoadState,
): void {
	if (settings.hooks === undefined) return;
	if (!isObject(settings.hooks)) {
		state.diagnostics.push({
			level: "error",
			code: "schema",
			message: `Expected an object-valued hooks field in ${source.path}`,
			source,
		});
		return;
	}
	for (const [eventName, groups] of Object.entries(settings.hooks)) {
		loadHookEvent(eventName, groups, source, state);
	}
}

function applyHttpHookPolicies(state: HookLoadState): LoadedHookHandler[] {
	return state.handlers.flatMap((loaded) => {
		if (loaded.handler.type !== "http") return [loaded];
		if (state.hasHttpUrlPolicy && !urlAllowed(loaded.handler.url, state.allowedHttpHookUrls)) {
			state.diagnostics.push({
				level: "warning",
				code: "policy",
				message: `HTTP hook URL is not in allowedHttpHookUrls: ${loaded.handler.url}`,
				source: loaded.source,
				event: loaded.event,
			});
			return [];
		}
		const handlerAllowed = loaded.handler.allowedEnvVars;
		const policyAllowed = state.hasHttpEnvPolicy ? state.httpHookAllowedEnvVars : (handlerAllowed ?? []);
		const effective = handlerAllowed ? policyAllowed.filter((name) => handlerAllowed.includes(name)) : policyAllowed;
		return [{ ...loaded, httpHookAllowedEnvVars: [...new Set(effective)] }];
	});
}

export async function loadHooks(options: LoadHooksOptions): Promise<LoadedHooks> {
	const sources = hookSettingsSources(options.cwd, options.home, options.sources, options.agentDir);
	const state: HookLoadState = {
		diagnostics: [],
		handlers: [],
		allowedHttpHookUrls: [],
		httpHookAllowedEnvVars: [],
		hasHttpUrlPolicy: false,
		hasHttpEnvPolicy: false,
		seen: new Set(),
		disableAllHooks: undefined,
		nextOrder: 0,
	};
	for (const source of sources) {
		const settings = await readHookSettings(source, state.diagnostics);
		if (!settings) continue;
		applyHookPolicySettings(settings, source, state);
		loadHookDefinitions(settings, source, state);
	}
	const handlers = applyHttpHookPolicies(state);
	return freezeLoadedHooks({
		handlers: state.disableAllHooks === true ? [] : handlers,
		diagnostics: state.diagnostics,
		sources,
	});
}
