export interface WorkspaceIdentity {
	readonly id: string;
	readonly root: string;
	readonly pathFlavor: "posix" | "windows";
}
