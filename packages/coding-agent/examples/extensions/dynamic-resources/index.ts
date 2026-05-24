import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@fleetagent/pi-coding-agent";

const baseDir = dirname(fileURLToPath(import.meta.url));

export default function (pi: ExtensionAPI) {
	pi.on("resources_discover", () => {
		return {
			skillPaths: [join(baseDir, "SKILL.md")],
			rulePaths: [join(baseDir, "RULES.md")],
			promptPaths: [join(baseDir, "dynamic.md")],
			themePaths: [join(baseDir, "dynamic.json")],
		};
	});
}
