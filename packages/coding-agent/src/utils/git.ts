import hostedGitInfo from "hosted-git-info";

/**
 * Parsed git URL information.
 */
export type GitSource = {
	/** Always "git" for git sources */
	type: "git";
	/** Clone URL (always valid for git clone, without ref suffix) */
	repo: string;
	/** Git host domain (e.g., "github.com") */
	host: string;
	/** Repository path (e.g., "user/repo") */
	path: string;
	/** Git ref (branch, tag, commit) if specified */
	ref?: string;
	/** True if ref was specified (package won't be auto-updated) */
	pinned: boolean;
};

interface SplitGitUrl {
	repo: string;
	ref?: string;
}

interface GitSourceComponents {
	repo: string;
	host: string;
	path: string;
	ref?: string;
}

function splitProtocolUrlRef(url: string): [repo: string, ref: string] | null {
	try {
		const parsed = new URL(url);
		const pathWithMaybeRef = parsed.pathname.replace(/^\/+/, "");
		const refSeparator = pathWithMaybeRef.indexOf("@");
		if (refSeparator < 0) return null;
		const repoPath = pathWithMaybeRef.slice(0, refSeparator);
		const ref = pathWithMaybeRef.slice(refSeparator + 1);
		if (!repoPath || !ref) return null;
		parsed.pathname = `/${repoPath}`;
		return [parsed.toString().replace(/\/$/, ""), ref];
	} catch {
		return null;
	}
}

function splitRef(url: string): SplitGitUrl {
	const scpLikeMatch = url.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		const pathWithMaybeRef = scpLikeMatch[2] ?? "";
		const refSeparator = pathWithMaybeRef.indexOf("@");
		if (refSeparator < 0) return { repo: url };
		const repoPath = pathWithMaybeRef.slice(0, refSeparator);
		const ref = pathWithMaybeRef.slice(refSeparator + 1);
		if (!repoPath || !ref) return { repo: url };
		return {
			repo: `git@${scpLikeMatch[1] ?? ""}:${repoPath}`,
			ref,
		};
	}

	if (url.includes("://")) {
		const protocolRef = splitProtocolUrlRef(url);
		return protocolRef ? { repo: protocolRef[0], ref: protocolRef[1] } : { repo: url };
	}

	const slashIndex = url.indexOf("/");
	if (slashIndex < 0) {
		return { repo: url };
	}
	const host = url.slice(0, slashIndex);
	const pathWithMaybeRef = url.slice(slashIndex + 1);
	const refSeparator = pathWithMaybeRef.indexOf("@");
	if (refSeparator < 0) {
		return { repo: url };
	}
	const repoPath = pathWithMaybeRef.slice(0, refSeparator);
	const ref = pathWithMaybeRef.slice(refSeparator + 1);
	if (!repoPath || !ref) {
		return { repo: url };
	}
	return {
		repo: `${host}/${repoPath}`,
		ref,
	};
}

function decodeForValidation(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const ENCODED_SEPARATOR_OR_CONTROL_PATTERN = /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i;
const WINDOWS_DRIVE_PATTERN = /^[a-z]:/i;

function hasUnsafeGitInstallPart(value: string, allowSlash: boolean): boolean {
	const decoded = decodeForValidation(value);
	if (decoded === null) {
		return true;
	}

	for (const candidate of [value, decoded]) {
		if (
			CONTROL_CHARACTER_PATTERN.test(candidate) ||
			candidate.includes("\\") ||
			candidate.startsWith("/") ||
			ENCODED_SEPARATOR_OR_CONTROL_PATTERN.test(candidate)
		) {
			return true;
		}
		if (!allowSlash && candidate.includes("/")) {
			return true;
		}
		const components = candidate.split("/");
		if (
			components.some((component) => {
				const decodedDots = component.replace(/%2e/gi, ".");
				return (
					!component ||
					component === "." ||
					component === ".." ||
					WINDOWS_DRIVE_PATTERN.test(component) ||
					(decodedDots !== component && (decodedDots === "." || decodedDots === ".."))
				);
			})
		) {
			return true;
		}
	}

	return false;
}

export function isSafeGitInstallPath(source: Pick<GitSource, "host" | "path">): boolean {
	return (
		Boolean(source.host) &&
		Boolean(source.path) &&
		source.path.split("/").length >= 2 &&
		!hasUnsafeGitInstallPart(source.host, false) &&
		!hasUnsafeGitInstallPart(source.path, true)
	);
}

function hasUnsafeRawGitSource(url: string): boolean {
	if (CONTROL_CHARACTER_PATTERN.test(url) || url.includes("\\")) {
		return true;
	}

	const scpLikeMatch = url.match(/^git@([^:]+):(.*)$/);
	if (scpLikeMatch) {
		return (
			hasUnsafeGitInstallPart(scpLikeMatch[1] ?? "", false) || hasUnsafeGitInstallPart(scpLikeMatch[2] ?? "", true)
		);
	}

	const protocolMatch = url.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)([^?#]*)/i);
	if (protocolMatch) {
		const rawAuthority = protocolMatch[1] ?? "";
		const rawPath = protocolMatch[2] ?? "";
		if (hasUnsafeGitInstallPart(rawAuthority, false) || !rawPath.startsWith("/") || rawPath.startsWith("//")) {
			return true;
		}
		return hasUnsafeGitInstallPart(rawPath.slice(1), true);
	}

	const slashIndex = url.indexOf("/");
	if (slashIndex < 0) {
		return false;
	}
	return (
		hasUnsafeGitInstallPart(url.slice(0, slashIndex), false) ||
		hasUnsafeGitInstallPart(url.slice(slashIndex + 1), true)
	);
}

function buildGitSource(args: GitSourceComponents): GitSource | null {
	if (args.path.startsWith("/")) {
		return null;
	}
	const normalizedPath = args.path.replace(/\.git$/, "").replace(/^\/+/, "");
	const source = { host: args.host, path: normalizedPath };
	if (!isSafeGitInstallPath(source)) {
		return null;
	}

	return {
		type: "git",
		repo: args.repo,
		host: source.host,
		path: source.path,
		ref: args.ref,
		pinned: Boolean(args.ref),
	};
}

function parseGenericGitUrl(url: string): GitSource | null {
	const { repo: repoWithoutRef, ref } = splitRef(url);
	let repo = repoWithoutRef;
	let host = "";
	let path = "";

	const scpLikeMatch = repoWithoutRef.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		host = scpLikeMatch[1] ?? "";
		path = scpLikeMatch[2] ?? "";
	} else if (/^(?:https?|ssh|git):\/\//i.test(repoWithoutRef)) {
		try {
			const parsed = new URL(repoWithoutRef);
			host = parsed.hostname;
			path = parsed.pathname.replace(/^\/+/, "");
		} catch {
			return null;
		}
	} else {
		const slashIndex = repoWithoutRef.indexOf("/");
		if (slashIndex < 0) {
			return null;
		}
		host = repoWithoutRef.slice(0, slashIndex);
		path = repoWithoutRef.slice(slashIndex + 1);
		if (!host.includes(".") && host !== "localhost") {
			return null;
		}
		repo = `https://${repoWithoutRef}`;
	}

	return buildGitSource({ repo, host, path, ref });
}

interface HostedGitSourceMatch {
	matched: boolean;
	source: GitSource | null;
}

function findHostedGitSource(candidates: string[], split: SplitGitUrl, forceHttps: boolean): HostedGitSourceMatch {
	for (const candidate of candidates) {
		const info = hostedGitInfo.fromUrl(candidate);
		if (!info) continue;
		if (split.ref && info.project?.includes("@")) continue;
		const normalizedRepo = split.repo.toLowerCase();
		const hasExplicitProtocol =
			normalizedRepo.startsWith("http://") ||
			normalizedRepo.startsWith("https://") ||
			normalizedRepo.startsWith("ssh://") ||
			normalizedRepo.startsWith("git://") ||
			normalizedRepo.startsWith("git@");
		const repo = forceHttps || !hasExplicitProtocol ? `https://${split.repo}` : split.repo;
		return {
			matched: true,
			source: buildGitSource({
				repo,
				host: info.domain || "",
				path: `${info.user}/${info.project}`,
				ref: info.committish || split.ref || undefined,
			}),
		};
	}
	return { matched: false, source: null };
}

/**
 * Parse git source into a GitSource.
 *
 * Rules:
 * - With git: prefix, accept all historical shorthand forms.
 * - Without git: prefix, only accept explicit protocol URLs.
 */
export function parseGitUrl(source: string): GitSource | null {
	const trimmed = source.trim();
	const hasGitPrefix = /^git:/i.test(trimmed);
	const url = hasGitPrefix ? trimmed.slice(4).trim() : trimmed;
	if (hasUnsafeRawGitSource(url)) {
		return null;
	}

	if (!hasGitPrefix && !/^(https?|ssh|git):\/\//i.test(url)) {
		return null;
	}

	const split = splitRef(url);

	const hostedCandidates = [split.ref ? `${split.repo}#${split.ref}` : undefined, url].filter(
		(value): value is string => Boolean(value),
	);
	const hostedMatch = findHostedGitSource(hostedCandidates, split, false);
	if (hostedMatch.matched) return hostedMatch.source;

	const httpsCandidates = [split.ref ? `https://${split.repo}#${split.ref}` : undefined, `https://${url}`].filter(
		(value): value is string => Boolean(value),
	);
	const httpsMatch = findHostedGitSource(httpsCandidates, split, true);
	if (httpsMatch.matched) return httpsMatch.source;

	return parseGenericGitUrl(url);
}
