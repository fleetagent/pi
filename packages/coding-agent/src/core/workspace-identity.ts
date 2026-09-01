import type { PortablePathFlavor } from "./lsp/portable-path.ts";

export interface WorkspaceIdentity {
	readonly id: string;
	readonly root: string;
	readonly pathFlavor: PortablePathFlavor;
}
