import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionRepo } from "../../src/harness/session/jsonl-repo.ts";
import { SessionError } from "../../src/harness/types.ts";

const [sessionsRoot, cwd, id] = process.argv.slice(2);
if (!sessionsRoot || !cwd || !id) throw new Error("Expected sessionsRoot, cwd, and id arguments");

try {
	await new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: sessionsRoot }), sessionsRoot }).create({ cwd, id });
	process.stdout.write("created");
} catch (error) {
	if (error instanceof SessionError) {
		process.stdout.write(error.code);
		process.exitCode = error.code === "already_exists" ? 0 : 1;
	} else {
		throw error;
	}
}
