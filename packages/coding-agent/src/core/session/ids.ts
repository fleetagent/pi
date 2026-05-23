import { randomUUID } from "node:crypto";
import { uuidv7 } from "@fleetagent/pi-agent-core";

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
