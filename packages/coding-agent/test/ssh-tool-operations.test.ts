import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SshToolOperations } from "../src/core/tools/operations.ts";

const temporaryDirectories: string[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
	process.env.PATH = originalPath;
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function createFixture(
	options: {
		cancellationDelay?: number;
		failedPublication?: boolean;
		incompatiblePs?: boolean;
		readinessOutputDelay?: number;
	} = {},
): Promise<{
	operations: SshToolOperations;
	root: string;
	invocationLog: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "pi-ssh-operations-"));
	temporaryDirectories.push(root);
	const binDirectory = join(root, "bin");
	await mkdir(binDirectory);
	const invocationLog = join(root, "ssh-invocations.txt");
	const fakeSsh = join(binDirectory, "ssh");
	await writeFile(
		fakeSsh,
		`#!/bin/sh\nprintf '%s\\n' "$*" >> '${invocationLog}'\n[ "$1" = "--" ] || exit 97\ncase "$*" in\n  *pi-ssh-ready-*)\n    shift 2\n    if [ "${options.readinessOutputDelay ?? 0}" != "0" ]; then\n      /bin/sh -c "$1" | { IFS= read -r line; sleep ${options.readinessOutputDelay ?? 0}; printf '%s\\n' "$line"; cat; }\n      exit $?\n    fi\n    exec /bin/sh -c "$1"\n    ;;\n  *)\n    sleep ${options.cancellationDelay ?? 0}\n    shift 2\n    exec /bin/sh -c "$1"\n    ;;\nesac\n`,
	);
	await chmod(fakeSsh, 0o700);
	if (options.incompatiblePs) {
		const fakePs = join(binDirectory, "ps");
		await writeFile(fakePs, "#!/bin/sh\nexit 0\n");
		await chmod(fakePs, 0o700);
	}
	if (options.failedPublication) {
		const fakeMv = join(binDirectory, "mv");
		await writeFile(fakeMv, "#!/bin/sh\nexit 1\n");
		await chmod(fakeMv, 0o700);
	}
	process.env.PATH = `${binDirectory}${delimiter}${originalPath ?? ""}`;
	return { operations: new SshToolOperations({ remote: "fixture", cwd: root }), root, invocationLog };
}

async function expectInterruptedCommand(
	operations: SshToolOperations,
	root: string,
	options: { signal?: AbortSignal; timeout?: number },
	expectedError: string,
): Promise<void> {
	const heartbeat = join(root, "command-heartbeat.txt");
	const started = Date.now();
	const invocation = operations.exec(`trap '' TERM\nwhile :; do printf x >> '${heartbeat}'; sleep 0.05; done`, {
		onData: () => {},
		...options,
	});
	await expect(invocation).rejects.toThrow(expectedError);
	// A TERM-ignoring command requires the remote SIGKILL escalation but must still settle promptly.
	expect(Date.now() - started).toBeLessThan(5000);
	const heartbeatAtSettlement = await readFile(heartbeat, "utf8").catch(() => "");
	await new Promise((resolve) => setTimeout(resolve, 800));
	expect(await readFile(heartbeat, "utf8").catch(() => "")).toBe(heartbeatAtSettlement);
}

describe.skipIf(process.platform === "win32")("SSH tool operations", () => {
	it("terminates the remote process group when a command is aborted", async () => {
		const { operations, root } = await createFixture();
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		await expectInterruptedCommand(operations, root, { signal: controller.signal }, "aborted");
	});

	it("terminates the remote process group when a command times out", async () => {
		const { operations, root } = await createFixture();
		await expectInterruptedCommand(operations, root, { timeout: 0.1 }, "timeout:0.1");
	});

	it("does not submit buffered input when readiness arrives after cancellation begins", async () => {
		const { operations, root } = await createFixture({ cancellationDelay: 0.5, readinessOutputDelay: 0.3 });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		await expectInterruptedCommand(operations, root, { signal: controller.signal }, "aborted");
	});

	it("fails closed when remote process liveness cannot be parsed", async () => {
		const { operations, root } = await createFixture({ incompatiblePs: true });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		await expectInterruptedCommand(operations, root, { signal: controller.signal }, "ssh exited with code 1");
	});

	it("does not submit command input when atomic PID publication fails", async () => {
		const { operations, root } = await createFixture({ failedPublication: true });
		const sentinel = join(root, "should-not-exist.txt");
		await expect(operations.exec(`printf done > '${sentinel}'`, { onData: () => {} })).rejects.toThrow(
			"SSH command supervisor failed to initialize",
		);
		await new Promise((resolve) => setTimeout(resolve, 200));
		await expect(readFile(sentinel, "utf8")).rejects.toThrow();
	});

	it("does not start an SSH process for an already-aborted command", async () => {
		const { operations, invocationLog } = await createFixture();
		const controller = new AbortController();
		controller.abort();
		await expect(
			operations.exec("printf should-not-run", { onData: () => {}, signal: controller.signal }),
		).rejects.toThrow("aborted");
		await expect(readFile(invocationLog, "utf8")).rejects.toThrow();
	});
});
