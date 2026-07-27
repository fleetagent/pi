import type { SandboxContainer, SandboxStartResult, SandboxStopResult } from "./docker.ts";

export type SandboxUserCommand =
	| { subcommand: "start"; image?: string }
	| { subcommand: "list" }
	| { subcommand: "stop"; target?: string };

function splitCommandLine(input: string): string[] {
	const tokens = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
	return tokens.map((token) => {
		if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
			return token.slice(1, -1);
		}
		return token;
	});
}

export function parseSandboxUserCommand(input: string): SandboxUserCommand {
	const tokens = splitCommandLine(input.trim());
	if (tokens[0] !== "/sandbox") {
		throw new Error("Sandbox command must start with /sandbox");
	}
	const subcommand = tokens[1];
	if (!subcommand) {
		throw new Error("Usage: /sandbox start [--image <image>] | /sandbox list | /sandbox stop [container]");
	}
	if (subcommand === "start") {
		let image: string | undefined;
		for (let index = 2; index < tokens.length; index++) {
			const token = tokens[index];
			if (token === "--image") {
				const value = tokens[++index];
				if (!value) throw new Error("Usage: /sandbox start --image <image>");
				image = value;
				continue;
			}
			throw new Error(`Unsupported /sandbox start argument: ${token}`);
		}
		return image ? { subcommand: "start", image } : { subcommand: "start" };
	}
	if (subcommand === "list") {
		if (tokens.length > 2) throw new Error("Usage: /sandbox list");
		return { subcommand: "list" };
	}
	if (subcommand === "stop") {
		if (tokens.length > 3) throw new Error("Usage: /sandbox stop [container]");
		return tokens[2] ? { subcommand: "stop", target: tokens[2] } : { subcommand: "stop" };
	}
	throw new Error(`Unsupported /sandbox subcommand: ${subcommand}`);
}

export function formatSandboxStartResult(result: SandboxStartResult): string {
	return [
		`Sandbox started: ${result.containerName} (${result.containerId})`,
		`Workspace: ${result.workspaceRoot} -> ${result.workspaceMountPath}`,
		`Daemon: ${result.daemonUrlRedacted}`,
		"Sandbox mode active: workspace tools/resources now route through the container daemon.",
	].join("\n");
}

export function formatSandboxList(containers: SandboxContainer[]): string {
	if (containers.length === 0) return "No Pi sandbox containers found for this workspace.";
	return containers
		.map((container) => {
			const endpoint = container.daemonEndpoint ? ` daemon=${container.daemonEndpoint}` : "";
			const mount = container.workspaceMountPath ? ` workspace=${container.workspaceMountPath}` : "";
			return `${container.id}\t${container.name}\t${container.state ?? container.status}\t${container.image}${mount}${endpoint}`;
		})
		.join("\n");
}

export function formatSandboxStopResult(result: SandboxStopResult): string {
	if (result.status === "not-found") return result.message;
	if (result.status === "already-stopped")
		return `Sandbox already stopped: ${result.container.name} (${result.container.id})`;
	if (result.status === "removed") return `Sandbox removed: ${result.container.name} (${result.container.id})`;
	return `Sandbox stopped: ${result.container.name} (${result.container.id})`;
}
