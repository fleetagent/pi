import { parseDaemonCommand } from "./config.ts";
import { printDaemonHelp } from "./help.ts";
import { redactDaemonText } from "./security.ts";
import { createDaemonServer, type DaemonServer } from "./server.ts";

export interface DaemonCommandDependencies {
	readonly stdout?: (message: string) => void;
	readonly stderr?: (message: string) => void;
}

export async function runDaemonCommand(
	args: readonly string[],
	dependencies: DaemonCommandDependencies = {},
): Promise<void> {
	const stdout = dependencies.stdout ?? console.log;
	const stderr = dependencies.stderr ?? console.error;
	let token = process.env.PI_DAEMON_TOKEN;
	let tlsPassphrase = process.env.PI_DAEMON_TLS_PASSPHRASE;
	let server: DaemonServer | undefined;
	try {
		const command = await parseDaemonCommand(args);
		if (command.help) {
			printDaemonHelp(stdout);
			return;
		}
		const configuration = command.configuration!;
		token = configuration.token;
		tlsPassphrase = configuration.tls?.passphrase;
		const activeServer = createDaemonServer(configuration);
		server = activeServer;
		const address = await activeServer.listen();
		stdout(
			redactDaemonText(
				`pi daemon ready url=${address.url} workspace=${address.workspaceRoot} workspaceId=${address.workspaceId} auth=${configuration.token ? "required" : "disabled"} processExec=${configuration.allowProcessExec ? "enabled" : "disabled"}`,
				[token, tlsPassphrase],
			),
		);
		let signalCount = 0;
		let resolveShutdown: (() => void) | undefined;
		const shutdown = new Promise<void>((resolve) => {
			resolveShutdown = resolve;
		});
		const onSignal = () => {
			signalCount++;
			if (signalCount > 1) void activeServer.forceClose();
			void activeServer.close().then(
				() => resolveShutdown?.(),
				() => resolveShutdown?.(),
			);
		};
		const onReload = () => {
			void activeServer.reload().then(
				() => stdout("pi daemon workspace catalog reloaded"),
				(error: unknown) =>
					stderr(
						`Error: ${redactDaemonText(error instanceof Error ? error.message : String(error), [token, tlsPassphrase])}`,
					),
			);
		};
		process.on("SIGINT", onSignal);
		process.on("SIGTERM", onSignal);
		process.on("SIGHUP", onReload);
		try {
			await shutdown;
			await activeServer.close();
		} finally {
			process.off("SIGINT", onSignal);
			process.off("SIGTERM", onSignal);
			process.off("SIGHUP", onReload);
		}
	} catch (error) {
		await server?.close().catch(() => undefined);
		const message = error instanceof Error ? error.message : String(error);
		stderr(`Error: ${redactDaemonText(message, [token, tlsPassphrase])}`);
		process.exitCode = 1;
	}
}
