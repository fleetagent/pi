import type { SandboxContainer, SandboxRuntime, SandboxStartResult, SandboxStopResult } from "./docker.ts";

export interface SandboxStartUserCommand {
	subcommand: "start";
	image?: string;
	runtime?: SandboxRuntime;
	name?: string;
	template?: string;
}

export type SandboxUserCommand =
	| { subcommand: "status" }
	| { subcommand: "clear" }
	| { subcommand: "attach"; url: string }
	| SandboxStartUserCommand
	| { subcommand: "list"; runtime?: SandboxRuntime }
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

function parseRuntime(value: string | undefined, usage: string): SandboxRuntime {
	if (value === "docker" || value === "lima") return value;
	throw new Error(usage);
}

function parseSandboxStartCommand(tokens: string[]): SandboxUserCommand {
	let image: string | undefined;
	let runtime: SandboxRuntime | undefined;
	let name: string | undefined;
	let template: string | undefined;
	for (let index = 2; index < tokens.length; index++) {
		const option = tokens[index];
		const value = tokens[++index];
		if (!value)
			throw new Error(
				"Usage: /sandbox start [--runtime docker|lima] [--image <image>] [--name <lima-instance>] [--template <lima-template>]",
			);
		switch (option) {
			case "--image":
				image = value;
				break;
			case "--runtime":
				runtime = parseRuntime(value, "Usage: /sandbox start --runtime docker|lima");
				break;
			case "--name":
				name = value;
				break;
			case "--template":
				template = value;
				break;
			default:
				throw new Error(`Unsupported /sandbox start argument: ${option}`);
		}
	}
	if ((name || template) && runtime !== "lima") {
		throw new Error("/sandbox start --name and --template require --runtime lima");
	}
	if (image && runtime === "lima") throw new Error("/sandbox start --image is only supported by the Docker runtime");
	return {
		subcommand: "start",
		...(image ? { image } : {}),
		...(runtime ? { runtime } : {}),
		...(name ? { name } : {}),
		...(template ? { template } : {}),
	};
}

function parseSandboxListCommand(tokens: string[]): SandboxUserCommand {
	if (tokens.length === 2) return { subcommand: "list" };
	if (tokens.length !== 4 || tokens[2] !== "--runtime") {
		throw new Error("Usage: /sandbox list [--runtime docker|lima]");
	}
	return { subcommand: "list", runtime: parseRuntime(tokens[3], "Usage: /sandbox list --runtime docker|lima") };
}

export function parseSandboxUserCommand(input: string): SandboxUserCommand {
	const tokens = splitCommandLine(input.trim());
	if (tokens[0] !== "/sandbox") throw new Error("Sandbox command must start with /sandbox");

	const subcommand = tokens[1];
	switch (subcommand) {
		case undefined:
		case "status":
			if (tokens.length > 2) throw new Error("Usage: /sandbox status");
			return { subcommand: "status" };
		case "clear":
			if (tokens.length > 2) throw new Error("Usage: /sandbox clear");
			return { subcommand: "clear" };
		case "--attach":
			if (tokens.length !== 3) throw new Error("Usage: /sandbox --attach <ws://url>");
			return { subcommand: "attach", url: tokens[2]! };
		case "start":
			return parseSandboxStartCommand(tokens);
		case "list":
			return parseSandboxListCommand(tokens);
		case "stop":
			if (tokens.length > 3) throw new Error("Usage: /sandbox stop [container]");
			return tokens[2] ? { subcommand: "stop", target: tokens[2] } : { subcommand: "stop" };
		default:
			throw new Error(
				`Unsupported /sandbox subcommand: ${subcommand}. Use status, clear, --attach, start, list, or stop.`,
			);
	}
}

export function formatSandboxStartResult(result: SandboxStartResult): string {
	return [
		`Sandbox started: ${result.containerName} (${result.containerId})`,
		`Workspace: ${result.workspaceRoot} -> ${result.workspaceMountPath}`,
		`Daemon: ${result.daemonUrlRedacted}`,
		"Sandbox mode active: workspace tools/resources now route through the sandbox daemon.",
	].join("\n");
}

export function formatSandboxList(containers: SandboxContainer[]): string {
	if (containers.length === 0) return "No Pi sandboxes found for this workspace.";
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
