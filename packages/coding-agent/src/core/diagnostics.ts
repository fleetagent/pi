type ResourceCollisionCategory = "extension" | "skill" | "rule" | "prompt" | "theme";
type ResourceDiagnosticCategory = "warning" | "error" | "collision";

export interface ResourceCollision {
	resourceType: ResourceCollisionCategory;
	name: string; // skill/rule name, command/tool/flag name, prompt name, theme name
	winnerPath: string;
	loserPath: string;
	winnerSource?: string; // e.g., "npm:foo", "git:...", "local"
	loserSource?: string;
}

export interface ResourceDiagnostic {
	type: ResourceDiagnosticCategory;
	message: string;
	path?: string;
	collision?: ResourceCollision;
}
