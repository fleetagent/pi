/**
 * SSH Remote Execution Example
 *
 * Demonstrates delegating tool operations to a remote machine via SSH.
 * When --ssh is provided, read/write/edit/bash run on the remote.
 *
 * Usage:
 *   pi -e ./ssh.ts --ssh user@host
 *   pi -e ./ssh.ts --ssh user@host:/remote/path
 *
 * Requirements:
 *   - SSH key-based auth (no password prompts)
 *   - bash on remote
 */

import { spawn } from "node:child_process";
import type {
	ExtensionAPI,
	ToolAccessMode,
	ToolExecOptions,
	ToolFileStat,
	ToolOperations,
} from "@fleetagent/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	LocalToolOperations,
} from "@fleetagent/pi-coding-agent";

function sshExec(remote: string, command: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", [remote, command], { stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (data: Buffer) => chunks.push(data));
		child.stderr.on("data", (data: Buffer) => errChunks.push(data));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`));
			} else {
				resolve(Buffer.concat(chunks));
			}
		});
	});
}

function modeFlag(mode: ToolAccessMode | undefined): string {
	switch (mode) {
		case "read":
			return "-r";
		case "write":
			return "-w";
		case "readwrite":
			return "-r";
		case "exists":
		case undefined:
			return "-e";
	}
}

function createRemoteToolOperations(remote: string, remoteCwd: string, localCwd: string): ToolOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		cwd: localCwd,
		exec: (command: string, options: ToolExecOptions) =>
			new Promise((resolve, reject) => {
				const cmd = `cd ${JSON.stringify(toRemote(options.cwd ?? localCwd))} && ${command}`;
				const child = spawn("ssh", [remote, cmd], { stdio: ["ignore", "pipe", "pipe"] });
				let timedOut = false;
				const timer = options.timeout
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, options.timeout * 1000)
					: undefined;
				child.stdout.on("data", options.onData);
				child.stderr.on("data", options.onData);
				child.on("error", (error) => {
					if (timer) clearTimeout(timer);
					reject(error);
				});
				const onAbort = () => child.kill();
				options.signal?.addEventListener("abort", onAbort, { once: true });
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					options.signal?.removeEventListener("abort", onAbort);
					if (options.signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
					else resolve({ exitCode: code });
				});
			}),
		access: async (p, mode) => {
			await sshExec(remote, `test ${modeFlag(mode)} ${JSON.stringify(toRemote(p))}`);
			if (mode === "readwrite") {
				await sshExec(remote, `test -w ${JSON.stringify(toRemote(p))}`);
			}
		},
		readFile: (p) => sshExec(remote, `cat ${JSON.stringify(toRemote(p))}`),
		writeFile: async (p, content) => {
			const b64 = Buffer.from(content).toString("base64");
			await sshExec(remote, `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(toRemote(p))}`);
		},
		mkdir: (dir) => sshExec(remote, `mkdir -p ${JSON.stringify(toRemote(dir))}`).then(() => {}),
		stat: async (p): Promise<ToolFileStat> => {
			const isDir = await sshExec(remote, `test -d ${JSON.stringify(toRemote(p))} && echo dir || echo file`);
			return {
				isDirectory: () => isDir.toString().trim() === "dir",
				isFile: () => isDir.toString().trim() === "file",
			};
		},
		readdir: async (p) => {
			const output = await sshExec(
				remote,
				`find ${JSON.stringify(toRemote(p))} -maxdepth 1 -mindepth 1 -printf '%f\\n'`,
			);
			return output.toString().split("\n").filter(Boolean);
		},
		detectImageMimeType: async (p) => {
			try {
				const result = await sshExec(remote, `file --mime-type -b ${JSON.stringify(toRemote(p))}`);
				const mimeType = result.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType) ? mimeType : null;
			} catch {
				return null;
			}
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });

	const localCwd = process.cwd();
	const localOperations = new LocalToolOperations(localCwd);
	const localRead = createReadTool(localOperations);
	const localWrite = createWriteTool(localOperations);
	const localEdit = createEditTool(localOperations);
	const localBash = createBashTool(localOperations);

	// Resolved lazily on session_start (CLI flags not available during factory)
	let resolvedSsh: { remote: string; remoteCwd: string } | null = null;

	const getSsh = () => resolvedSsh;
	const getRemoteOperations = (ssh: { remote: string; remoteCwd: string }) =>
		createRemoteToolOperations(ssh.remote, ssh.remoteCwd, localCwd);

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createReadTool(getRemoteOperations(ssh));
				return tool.execute(id, params, signal, onUpdate);
			}
			return localRead.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createWriteTool(getRemoteOperations(ssh));
				return tool.execute(id, params, signal, onUpdate);
			}
			return localWrite.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createEditTool(getRemoteOperations(ssh));
				return tool.execute(id, params, signal, onUpdate);
			}
			return localEdit.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createBashTool(getRemoteOperations(ssh));
				return tool.execute(id, params, signal, onUpdate);
			}
			return localBash.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Resolve SSH config now that CLI flags are available
		const arg = pi.getFlag("ssh") as string | undefined;
		if (arg) {
			if (arg.includes(":")) {
				const [remote, path] = arg.split(":");
				resolvedSsh = { remote, remoteCwd: path };
			} else {
				// No path given, evaluate pwd on remote
				const remote = arg;
				const pwd = (await sshExec(remote, "pwd")).toString().trim();
				resolvedSsh = { remote, remoteCwd: pwd };
			}
			ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`));
			ctx.ui.notify(`SSH mode: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`, "info");
		}
	});

	// Handle user ! commands via SSH
	pi.on("user_bash", (_event) => {
		const ssh = getSsh();
		if (!ssh) return; // No SSH, use local execution
		return { operations: getRemoteOperations(ssh) };
	});

	// Replace local cwd with remote cwd in system prompt
	pi.on("before_agent_start", async (event) => {
		const ssh = getSsh();
		if (ssh) {
			const modified = event.systemPrompt.replace(
				`Current working directory: ${localCwd}`,
				`Current working directory: ${ssh.remoteCwd} (via SSH: ${ssh.remote})`,
			);
			return { systemPrompt: modified };
		}
	});
}
