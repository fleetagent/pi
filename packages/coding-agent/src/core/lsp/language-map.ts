import { access } from "node:fs/promises";
import { minimatch } from "minimatch";
import { waitForAbort } from "./abort.ts";
import type { LspConfiguredServer, LspDocumentSelector, LspPathMapping, ResolvedLspConfiguration } from "./config.ts";
import {
	dirnamePortablePath,
	isPortableAbsolute,
	joinPortablePath,
	normalizePortablePath,
	type PortablePathFlavor,
	pathApi,
	pathComparisonValue,
	pathFlavor,
	portablePathToFileUri,
	relativeWithin,
	resolvePortablePath,
} from "./portable-path.ts";

export interface LspRouteTarget {
	server: LspConfiguredServer;
	serverId: string;
	languageId: string;
	workspaceRoot: string;
	instanceKey: string;
	serverUri: string;
	workspaceUri: string;
	mapper: LspPathMapper;
}

export interface LspRouteFailure {
	serverId: string;
	reason: string;
}

export interface LspRouteResult {
	targets: LspRouteTarget[];
	failures: LspRouteFailure[];
}

export type LspPathMappingResult = { ok: true; value: string } | { ok: false; reason: string };

export interface LspRouterOptions {
	pathExists?: (path: string) => Promise<boolean>;
}

interface NormalizedMapping {
	agentRoot: string;
	serverRoot: URL;
	agentFlavor: PortablePathFlavor;
}

function encodePathSegments(value: string, flavor: PortablePathFlavor): string {
	return value
		.split(flavor === "windows" ? /[\\/]/ : "/")
		.filter(Boolean)
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

function decodedUrlSegments(url: URL): string[] | undefined {
	try {
		const segments = url.pathname
			.split("/")
			.filter(Boolean)
			.map((segment) => decodeURIComponent(segment));
		return segments.some((segment) => segment === "." || segment === ".." || segment.includes("/"))
			? undefined
			: segments;
	} catch {
		return undefined;
	}
}

function sameFileAuthority(left: URL, right: URL): boolean {
	return (
		left.protocol === "file:" &&
		right.protocol === "file:" &&
		left.hostname.toLowerCase() === right.hostname.toLowerCase()
	);
}

function uriRelativeToRoot(root: URL, candidate: URL): string | undefined {
	if (!sameFileAuthority(root, candidate) || candidate.search || candidate.hash) return undefined;
	const rootSegments = decodedUrlSegments(root);
	const candidateSegments = decodedUrlSegments(candidate);
	if (!rootSegments || !candidateSegments || rootSegments.length > candidateSegments.length) return undefined;
	const windows = root.hostname.length > 0 || rootSegments[0]?.endsWith(":") === true;
	for (let index = 0; index < rootSegments.length; index++) {
		const left = windows ? rootSegments[index].toLowerCase() : rootSegments[index];
		const right = windows ? candidateSegments[index].toLowerCase() : candidateSegments[index];
		if (left !== right) return undefined;
	}
	return candidateSegments.slice(rootSegments.length).join("/");
}

function appendUriPath(root: URL, child: string, flavor: PortablePathFlavor): string {
	const output = new URL(root.toString());
	if (!child) return output.toString();
	const base = output.pathname.endsWith("/") ? output.pathname : `${output.pathname}/`;
	output.pathname = `${base}${encodePathSegments(child, flavor)}`;
	return output.toString();
}

function fileUriToPortablePath(url: URL): string {
	const segments = decodedUrlSegments(url);
	if (!segments) throw new Error(`File URI contains invalid percent encoding: ${url.toString()}`);
	if (url.hostname && segments.length === 0) throw new Error(`UNC file URI is missing a share: ${url.toString()}`);
	if (segments[0]?.endsWith(":") && segments.length === 1 && !url.pathname.endsWith("/")) {
		throw new Error(`Windows file URI is drive-relative: ${url.toString()}`);
	}
	if (url.hostname || segments[0]?.endsWith(":")) {
		if (segments.some((segment) => segment.includes("\\"))) {
			throw new Error(`Windows file URI contains an encoded path separator: ${url.toString()}`);
		}
		if (url.hostname) return `\\\\${url.hostname}\\${segments.join("\\")}`;
		if (segments.length === 1) return `${segments[0]}\\`;
		return normalizePortablePath(segments.join("\\"), "windows");
	}
	return `/${segments.join("/")}`;
}

/** Bidirectional, longest-root path mapper for one configured server. */
export class LspPathMapper {
	private readonly agentMappings: NormalizedMapping[];
	private readonly serverMappings: NormalizedMapping[];

	constructor(mappings: readonly LspPathMapping[] = []) {
		const normalized = mappings.map((mapping) => ({
			agentRoot: normalizePortablePath(mapping.agentRoot),
			serverRoot: new URL(mapping.serverRootUri),
			agentFlavor: pathFlavor(mapping.agentRoot),
		}));
		this.agentMappings = [...normalized].sort((left, right) => right.agentRoot.length - left.agentRoot.length);
		this.serverMappings = [...normalized].sort(
			(left, right) => right.serverRoot.pathname.length - left.serverRoot.pathname.length,
		);
	}

	agentPathToServerUri(agentPath: string): LspPathMappingResult {
		const absolutePath = normalizePortablePath(agentPath);
		if (this.agentMappings.length === 0) {
			return {
				ok: true,
				value: portablePathToFileUri(absolutePath),
			};
		}
		for (const mapping of this.agentMappings) {
			const child = relativeWithin(mapping.agentRoot, absolutePath);
			if (child !== undefined) {
				return { ok: true, value: appendUriPath(mapping.serverRoot, child, mapping.agentFlavor) };
			}
		}
		return { ok: false, reason: `Path ${JSON.stringify(agentPath)} is outside all configured agent path mappings` };
	}

	serverUriToAgentPath(serverUri: string): LspPathMappingResult {
		if (/^file:/i.test(serverUri) && !/^file:\//i.test(serverUri)) {
			return { ok: false, reason: `File URI ${JSON.stringify(serverUri)} must contain an absolute path` };
		}
		let url: URL;
		try {
			url = new URL(serverUri);
		} catch {
			return { ok: false, reason: `Server URI ${JSON.stringify(serverUri)} is malformed` };
		}
		if (url.protocol !== "file:") {
			return { ok: false, reason: `Server URI ${JSON.stringify(serverUri)} is not a file URI` };
		}
		if (url.search || url.hash) {
			return { ok: false, reason: `File URI ${JSON.stringify(serverUri)} must not contain a query or fragment` };
		}
		if (this.serverMappings.length === 0) {
			try {
				return { ok: true, value: fileUriToPortablePath(url) };
			} catch (error) {
				return { ok: false, reason: error instanceof Error ? error.message : String(error) };
			}
		}
		for (const mapping of this.serverMappings) {
			const child = uriRelativeToRoot(mapping.serverRoot, url);
			if (child === undefined) continue;
			if (mapping.agentFlavor === "windows" && child.split("/").some((segment) => segment.includes("\\"))) {
				return {
					ok: false,
					reason: `File URI ${JSON.stringify(serverUri)} contains an encoded Windows path separator`,
				};
			}
			const api = pathApi(mapping.agentFlavor);
			return { ok: true, value: api.join(mapping.agentRoot, ...child.split("/").filter(Boolean)) };
		}
		return {
			ok: false,
			reason: `File URI ${JSON.stringify(serverUri)} is outside all configured server path mappings`,
		};
	}
}

function selectorMatches(selector: LspDocumentSelector, relativePath: string, flavor: PortablePathFlavor): boolean {
	if ((selector.scheme ?? "file") !== "file") return false;
	const patternPath = flavor === "windows" ? relativePath.replace(/\\/g, "/") : relativePath;
	return minimatch(patternPath, selector.pattern, { dot: true });
}

async function defaultPathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** Resolves configured selectors into server/workspace instances without starting clients. */
export class LspRouter {
	private configuration: ResolvedLspConfiguration;
	private sessionRoot: string;
	private pathExists: (path: string) => Promise<boolean>;
	private contextGeneration = 0;
	private readonly rootCache = new Map<string, Promise<string | undefined>>();

	constructor(sessionRoot: string, configuration: ResolvedLspConfiguration, options: LspRouterOptions = {}) {
		this.sessionRoot = resolvePortablePath(process.cwd(), sessionRoot);
		this.configuration = configuration;
		this.pathExists = options.pathExists ?? defaultPathExists;
	}

	setRoutingContext(sessionRoot: string, pathExists: (path: string) => Promise<boolean>): void {
		const nextRoot = resolvePortablePath(process.cwd(), sessionRoot);
		if (nextRoot === this.sessionRoot && pathExists === this.pathExists) return;
		this.clearCache();
		this.sessionRoot = nextRoot;
		this.pathExists = pathExists;
	}

	setConfiguration(configuration: ResolvedLspConfiguration): void {
		this.configuration = configuration;
		this.clearCache();
	}

	clearCache(): void {
		this.contextGeneration++;
		this.rootCache.clear();
	}

	async routeFile(filePath: string, signal?: AbortSignal): Promise<LspRouteResult> {
		const generation = this.contextGeneration;
		const absolutePath = isPortableAbsolute(filePath)
			? normalizePortablePath(filePath)
			: resolvePortablePath(this.sessionRoot, filePath);
		const candidates = await waitForAbort(
			Promise.all(
				this.configuration.servers.map(async (server, serverIndex) => {
					const workspaceRoot = await this.resolveWorkspaceRoot(server, absolutePath);
					if (!workspaceRoot) return undefined;
					const flavor = pathFlavor(workspaceRoot);
					const workspacePath = relativeWithin(workspaceRoot, absolutePath);
					if (workspacePath === undefined) return undefined;
					const selectorIndex = server.selectors.findIndex((selector) =>
						selectorMatches(selector, workspacePath, flavor),
					);
					if (selectorIndex === -1) return undefined;
					const selector = server.selectors[selectorIndex];
					const mapper = new LspPathMapper(server.pathMappings);
					const mappedWorkspace = mapper.agentPathToServerUri(workspaceRoot);
					if (!mappedWorkspace.ok) return { server, serverIndex, failure: mappedWorkspace.reason };
					const mapped = mapper.agentPathToServerUri(absolutePath);
					if (!mapped.ok) return { server, serverIndex, failure: mapped.reason };
					return {
						server,
						serverIndex,
						selectorIndex,
						target: {
							server,
							serverId: server.id,
							languageId: selector.languageId,
							workspaceRoot,
							instanceKey: JSON.stringify([server.id, pathComparisonValue(workspaceRoot, flavor)]),
							serverUri: mapped.value,
							workspaceUri: mappedWorkspace.value,
							mapper,
						} satisfies LspRouteTarget,
					};
				}),
			),
			signal,
		);
		if (generation !== this.contextGeneration) return { targets: [], failures: [] };
		const failures: LspRouteFailure[] = [];
		const matched = candidates.flatMap((candidate) => {
			if (!candidate) return [];
			if ("failure" in candidate && typeof candidate.failure === "string") {
				failures.push({ serverId: candidate.server.id, reason: candidate.failure });
				return [];
			}
			return "target" in candidate ? [candidate] : [];
		});
		matched.sort(
			(left, right) =>
				(right.server.priority ?? 0) - (left.server.priority ?? 0) ||
				left.serverIndex - right.serverIndex ||
				left.selectorIndex - right.selectorIndex,
		);
		return { targets: matched.map((candidate) => candidate.target), failures };
	}

	private resolveWorkspaceRoot(server: LspConfiguredServer, filePath: string): Promise<string | undefined> {
		if (server.workspace.type === "session") return Promise.resolve(this.sessionRoot);
		if (server.workspace.type === "fixed") {
			return Promise.resolve(resolvePortablePath(this.sessionRoot, server.workspace.path));
		}
		const directory = dirnamePortablePath(filePath);
		const cacheKey = `${server.id}\u0000${pathComparisonValue(directory)}`;
		const cached = this.rootCache.get(cacheKey);
		if (cached) return cached;
		const discovery = this.discoverMarkerRoot(server, directory);
		this.rootCache.set(cacheKey, discovery);
		return discovery;
	}

	private async discoverMarkerRoot(server: LspConfiguredServer, startDirectory: string): Promise<string | undefined> {
		if (server.workspace.type !== "markers") return undefined;
		const api = pathApi(pathFlavor(startDirectory));
		const boundary = resolvePortablePath(this.sessionRoot, server.workspace.stopAt ?? this.sessionRoot);
		if (relativeWithin(boundary, startDirectory) === undefined) {
			return server.workspace.fallback === "session" ? this.sessionRoot : undefined;
		}
		let directory = normalizePortablePath(startDirectory);
		while (true) {
			for (const marker of server.workspace.markers) {
				if (await this.pathExists(joinPortablePath(directory, marker)).catch(() => false)) return directory;
			}
			if (pathComparisonValue(directory) === pathComparisonValue(boundary)) break;
			const parent = api.dirname(directory);
			if (parent === directory || relativeWithin(boundary, parent) === undefined) break;
			directory = parent;
		}
		return server.workspace.fallback === "session" ? this.sessionRoot : undefined;
	}
}
