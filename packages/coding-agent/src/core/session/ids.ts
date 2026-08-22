import { randomUUID } from "node:crypto";
import { uuidv7 } from "@fleetagent/pi-agent-core";

const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function validateSessionId(id: string): void {
	if (!SESSION_ID_PATTERN.test(id)) {
		throw new Error(
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}

export function createSessionId(): string {
	return uuidv7();
}

/** Generate a unique short ID (8 hex chars, collision-checked). */
export function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	return randomUUID();
}
