#!/usr/bin/env node
import { APP_NAME } from "../config.ts";
import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

restoreSandboxEnv();

if (process.argv[2] !== "--daemon") {
	await import("./register-bedrock.ts");
}
await import("../cli.ts");
