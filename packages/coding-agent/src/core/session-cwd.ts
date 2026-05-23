import { existsSync } from "node:fs";

export interface SessionCwdIssue {
	sessionReference?: string;
	sessionCwd: string;
	fallbackCwd: string;
}

interface SessionCwdSource {
	getCwd(): string;
	getSessionReference(): string | undefined;
}

export function getMissingSessionCwdIssue(session: SessionCwdSource, fallbackCwd: string): SessionCwdIssue | undefined {
	const sessionReference = session.getSessionReference();
	if (!sessionReference) {
		return undefined;
	}

	const sessionCwd = session.getCwd();
	if (!sessionCwd || existsSync(sessionCwd)) {
		return undefined;
	}

	return {
		sessionReference,
		sessionCwd,
		fallbackCwd,
	};
}

export function formatMissingSessionCwdError(issue: SessionCwdIssue): string {
	const sessionReference = issue.sessionReference ? `\nSession reference: ${issue.sessionReference}` : "";
	return `Stored session working directory does not exist: ${issue.sessionCwd}${sessionReference}\nCurrent working directory: ${issue.fallbackCwd}`;
}

export function formatMissingSessionCwdPrompt(issue: SessionCwdIssue): string {
	return `cwd from session does not exist\n${issue.sessionCwd}\n\ncontinue in current cwd\n${issue.fallbackCwd}`;
}

export class MissingSessionCwdError extends Error {
	readonly issue: SessionCwdIssue;

	constructor(issue: SessionCwdIssue) {
		super(formatMissingSessionCwdError(issue));
		this.name = "MissingSessionCwdError";
		this.issue = issue;
	}
}

export function assertSessionCwdExists(session: SessionCwdSource, fallbackCwd: string): void {
	const issue = getMissingSessionCwdIssue(session, fallbackCwd);
	if (issue) {
		throw new MissingSessionCwdError(issue);
	}
}
