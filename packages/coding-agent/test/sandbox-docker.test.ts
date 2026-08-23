import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import {
	allocateSandboxDaemonPort,
	buildDockerRunInvocation,
	DEFAULT_SANDBOX_IMAGE,
	type DockerCommandResult,
	type DockerRunner,
	DockerSandboxService,
	type ManagedSandboxContainer,
	parseDockerInspectContainers,
	parseDockerPortOutput,
	redactSecrets,
	resolveSandboxConfig,
	SANDBOX_LABEL_DAEMON_PORT,
	SANDBOX_LABEL_ENABLED,
	SANDBOX_LABEL_WORKSPACE_HASH,
} from "../src/core/sandbox/docker.ts";
import type { SandboxSettings } from "../src/core/settings-manager.ts";

class FakeDockerRunner implements DockerRunner {
	readonly calls: { command: string; args: string[]; env?: Record<string, string> }[] = [];
	private readonly responses: DockerCommandResult[];

	constructor(responses: DockerCommandResult[]) {
		this.responses = [...responses];
	}

	async run(
		command: string,
		args: string[],
		options: { env?: Record<string, string> } = {},
	): Promise<DockerCommandResult> {
		this.calls.push({ command, args, env: options.env });
		const response = this.responses.shift();
		if (!response) return { exitCode: 0, stdout: "", stderr: "" };
		return response;
	}
}

function ok(stdout = ""): DockerCommandResult {
	return { exitCode: 0, stdout, stderr: "" };
}

function fail(stderr: string): DockerCommandResult {
	return { exitCode: 1, stdout: "", stderr };
}

describe("Docker sandbox core", () => {
	it("configures container-local temporary storage for daemon workspace tools", () => {
		const dockerfile = readFileSync(new URL("../examples/sandbox-docker/Dockerfile", import.meta.url), "utf8");
		expect(dockerfile).toContain("ENV PI_DAEMON_TEMP_ROOT=/tmp");
		expect(dockerfile).toContain("ENV TMPDIR=/tmp");
	});
	it("resolves config with override, environment, settings, and default precedence", () => {
		const settings: SandboxSettings = {
			image: "settings-image",
			dockerBinary: "settings-docker",
			workspaceMountPath: "/settings-workspace",
			containerNamePrefix: "settings-prefix",
			daemonPort: 9000,
			daemonHostBind: "127.0.0.2",
			cleanup: "remove",
		};

		const config = resolveSandboxConfig(
			settings,
			{
				PI_SANDBOX_IMAGE: "env-image",
				PI_SANDBOX_DOCKER: "env-docker",
				PI_SANDBOX_WORKSPACE_MOUNT: "/env-workspace",
				PI_SANDBOX_CONTAINER_PREFIX: "env-prefix",
				PI_SANDBOX_DAEMON_PORT: "9100",
				PI_SANDBOX_DAEMON_HOST_BIND: "127.0.0.3",
				PI_SANDBOX_CLEANUP: "stop",
			},
			{ image: "override-image", daemonPort: 9200 },
		);

		expect(config).toMatchObject({
			image: "override-image",
			dockerBinary: "env-docker",
			workspaceMountPath: "/env-workspace",
			containerNamePrefix: "env-prefix",
			daemonPort: 9200,
			daemonHostBind: "127.0.0.3",
			cleanup: "stop",
		});
		expect(resolveSandboxConfig(undefined, {}, {}).image).toBe(DEFAULT_SANDBOX_IMAGE);
		expect(() => resolveSandboxConfig(undefined, { PI_SANDBOX_DAEMON_PORT: "nope" }, {})).toThrow("decimal integer");
	});

	it("builds docker run arguments without putting daemon token in argv", () => {
		const config = resolveSandboxConfig(undefined, {}, { image: "pi-sandbox:test" });
		const invocation = buildDockerRunInvocation(
			config,
			{ workspaceRoot: "/tmp/My Project", sessionId: "session-1" },
			"secret-token-012345678901234567890123456789",
		);

		expect(invocation.command).toBe("docker");
		expect(invocation.containerName).toMatch(/^pi-sandbox-my-project-[a-f0-9]{16}-session-1$/);
		expect(invocation.args).toEqual(
			expect.arrayContaining([
				"run",
				"--detach",
				"--network",
				"host",
				"--mount",
				"type=bind,source=/tmp/My Project,target=/workspace",
				"--env",
				"PI_DAEMON_TOKEN",
				"pi-sandbox:test",
				"pi",
				"--daemon",
				"--daemon-host",
				"127.0.0.1",
				"--daemon-cwd",
				"/workspace",
			]),
		);
		expect(invocation.args).not.toContain("--publish");
		expect(invocation.args.join(" ")).not.toContain("secret-token");
		expect(invocation.env.PI_DAEMON_TOKEN).toContain("secret-token");
		expect(invocation.labels[SANDBOX_LABEL_ENABLED]).toBe("true");
		expect(invocation.labels[SANDBOX_LABEL_WORKSPACE_HASH]).toMatch(/^[a-f0-9]{16}$/);
		expect(invocation.labels[SANDBOX_LABEL_DAEMON_PORT]).toBe("8787");
	});

	it("allocates distinct host-network daemon ports for concurrent session sandboxes", async () => {
		const runner = new FakeDockerRunner([ok("29.3.1\n"), ok("container123\n"), ok("29.3.1\n"), ok("container456\n")]);
		const service = new DockerSandboxService({
			runner,
			env: {},
			tokenGenerator: () => "generated-token-012345678901234567890123456789",
			portAllocator: async (_host, preferredPort) => (preferredPort === 0 ? 49153 : preferredPort),
			readinessWaiter: async () => {},
		});

		const [first, second] = await Promise.all([
			service.start({ workspaceRoot: "/tmp/workspace", image: "pi-sandbox:test" }),
			service.start({ workspaceRoot: "/tmp/workspace", image: "pi-sandbox:test" }),
		]);

		expect(first).toMatchObject({
			containerId: "container123",
			daemonUrl: "ws://127.0.0.1:8787/pi/workspace",
		});
		expect(second).toMatchObject({
			containerId: "container456",
			daemonUrl: "ws://127.0.0.1:49153/pi/workspace",
		});
		expect(runner.calls).toHaveLength(4);
		expect(runner.calls[1].args).toContain("8787");
		expect(runner.calls[3].args).toContain("49153");
		expect(runner.calls[1].args.join(" ")).not.toContain("generated-token");
		expect(runner.calls[1].env?.PI_DAEMON_TOKEN).toBe("generated-token-012345678901234567890123456789");
	});

	it("removes stopped containers started by another service during managed shutdown", async () => {
		const runningRow = JSON.stringify({
			ID: "managed",
			Names: "pi-sandbox-workspace-hash",
			Image: "pi-sandbox:test",
			State: "exited",
			Labels: `${SANDBOX_LABEL_ENABLED}=true,${SANDBOX_LABEL_DAEMON_PORT}=49200`,
		});
		const runner = new FakeDockerRunner([
			ok("29.3.1\n"),
			ok("managed123\n"),
			ok(`${runningRow}\n`),
			ok("managed123\n"),
		]);
		const managedContainers = new Map<string, ManagedSandboxContainer>();
		const service = new DockerSandboxService({
			runner,
			env: {},
			portAllocator: async () => 49200,
			readinessWaiter: async () => {},
			managedContainers,
		});
		const shutdownService = new DockerSandboxService({
			runner,
			env: { PI_SANDBOX_CLEANUP: "remove" },
			managedContainers,
		});

		await service.start({ workspaceRoot: "/tmp/managed-workspace", image: "pi-sandbox:test" });
		await shutdownService.stopManagedContainers();
		await shutdownService.stopManagedContainers();

		expect(runner.calls).toHaveLength(4);
		expect(runner.calls[2].args.some((arg) => arg.startsWith(`label=${SANDBOX_LABEL_WORKSPACE_HASH}=`))).toBe(true);
		expect(runner.calls[3].args).toEqual(["rm", "--force", "managed"]);
	});

	it("forgets missing managed containers only within the requested workspace", async () => {
		const runner = new FakeDockerRunner([ok(""), ok("")]);
		const managedContainers = new Map<string, ManagedSandboxContainer>([
			["missing123", { workspaceRoot: "/tmp/other-workspace", daemonPort: 49400 }],
		]);
		const service = new DockerSandboxService({ runner, env: {}, managedContainers });

		await service.stop({ workspaceRoot: "/tmp/current-workspace", target: "missing123" });
		expect(managedContainers.size).toBe(1);
		await service.stop({ workspaceRoot: "/tmp/other-workspace", target: "missing123" });

		expect(managedContainers.size).toBe(0);
		expect(runner.calls).toHaveLength(2);
	});

	it("retains failed-readiness ports until the surviving container is cleaned up", async () => {
		const runningRow = JSON.stringify({
			ID: "failed123",
			Names: "pi-sandbox-workspace-hash",
			Image: "pi-sandbox:test",
			State: "running",
			Labels: `${SANDBOX_LABEL_ENABLED}=true,${SANDBOX_LABEL_DAEMON_PORT}=49300`,
		});
		const runner = new FakeDockerRunner([
			ok("29.3.1\n"),
			ok("failed123\n"),
			fail("cleanup failed"),
			ok(`${runningRow}\n`),
			ok("failed123\n"),
		]);
		const managedContainers = new Map<string, ManagedSandboxContainer>();
		const preferredPorts: number[] = [];
		const service = new DockerSandboxService({
			runner,
			env: {},
			managedContainers,
			portAllocator: async (_host, preferredPort) => {
				preferredPorts.push(preferredPort);
				if (preferredPorts.length > 1) throw new Error("stop after observing fallback allocation");
				return 49300;
			},
			readinessWaiter: async () => {
				throw new Error("daemon not ready");
			},
		});

		await expect(
			service.start({ workspaceRoot: "/tmp/failed-workspace", image: "pi-sandbox:test", daemonPort: 49300 }),
		).rejects.toThrow("Sandbox readiness and cleanup both failed");
		await expect(
			service.start({ workspaceRoot: "/tmp/other-workspace", image: "pi-sandbox:test", daemonPort: 49300 }),
		).rejects.toThrow("stop after observing fallback allocation");
		expect(preferredPorts).toEqual([49300, 0]);

		await new DockerSandboxService({ runner, env: {}, managedContainers }).stopManagedContainers();
		expect(runner.calls.at(-1)?.args).toEqual(["stop", "failed123"]);
	});

	it("falls back when the preferred host-network daemon port is occupied", async () => {
		const blocker = createServer();
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
		const address = blocker.address();
		if (!address || typeof address === "string") throw new Error("Expected a TCP listener address");
		try {
			const allocated = await allocateSandboxDaemonPort("127.0.0.1", address.port);
			expect(allocated).not.toBe(address.port);
			expect(allocated).toBeGreaterThan(0);
		} finally {
			await new Promise<void>((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it("lists only label-filtered Pi sandbox containers and redacts displayed endpoints", async () => {
		const runner = new FakeDockerRunner([
			ok(
				`${JSON.stringify({
					ID: "abc123",
					Names: "pi-sandbox-workspace-hash",
					Image: "pi-sandbox:test",
					Status: "Up 3 seconds",
					State: "running",
					Labels: `${SANDBOX_LABEL_ENABLED}=true,ai.fleetagent.pi.workspace-mount=/workspace`,
					Ports: "127.0.0.1:49153->8787/tcp",
				})}\n`,
			),
		]);
		const service = new DockerSandboxService({ runner, env: {} });

		const containers = await service.list({ workspaceRoot: "/tmp/workspace" });

		expect(runner.calls[0].args).toEqual(
			expect.arrayContaining(["--filter", `label=${SANDBOX_LABEL_ENABLED}=true`, "--format", "{{json .}}"]),
		);
		expect(runner.calls[0].args.join(" ")).toContain(`label=${SANDBOX_LABEL_WORKSPACE_HASH}=`);
		expect(containers).toHaveLength(1);
		expect(containers[0]).toMatchObject({ id: "abc123", name: "pi-sandbox-workspace-hash", state: "running" });
		expect(redactSecrets("Authorization: Bearer secret PI_DAEMON_TOKEN=secret")).toBe(
			"Authorization: Bearer [REDACTED] PI_DAEMON_TOKEN=[REDACTED]",
		);
	});

	it("stops only selected Pi-owned sandbox containers and handles missing or already stopped targets", async () => {
		const runningRow = JSON.stringify({
			ID: "abc123",
			Names: "pi-sandbox-workspace-hash",
			Image: "pi-sandbox:test",
			State: "running",
			Labels: `${SANDBOX_LABEL_ENABLED}=true`,
		});
		const runner = new FakeDockerRunner([ok(`${runningRow}\n`), ok("abc123\n")]);
		const service = new DockerSandboxService({ runner, env: {} });

		await expect(service.stop({ workspaceRoot: "/tmp/workspace", target: "abc" })).resolves.toMatchObject({
			status: "stopped",
		});
		expect(runner.calls[1].args).toEqual(["stop", "abc123"]);

		const stoppedRunner = new FakeDockerRunner([
			ok(`${JSON.stringify({ ...JSON.parse(runningRow), State: "exited" })}\n`),
		]);
		const stoppedService = new DockerSandboxService({ runner: stoppedRunner, env: {} });
		await expect(stoppedService.stop({ workspaceRoot: "/tmp/workspace" })).resolves.toMatchObject({
			status: "already-stopped",
		});

		const missingRunner = new FakeDockerRunner([ok(""), fail("No such container")]);
		const missingService = new DockerSandboxService({ runner: missingRunner, env: {} });
		await expect(missingService.stop({ workspaceRoot: "/tmp/workspace", target: "missing" })).resolves.toMatchObject({
			status: "not-found",
		});
	});

	it("parses inspect and port output for smoke validation helpers", () => {
		const inspect = parseDockerInspectContainers(
			JSON.stringify([
				{
					Id: "abcdef",
					Name: "/pi-sandbox-workspace-hash",
					Config: { Image: "pi-sandbox:test", Labels: { "ai.fleetagent.pi.workspace-mount": "/workspace" } },
					State: { Status: "running", Running: true, StartedAt: "2026-01-01T00:00:00Z" },
					Mounts: [{ Type: "bind", Source: "/host/workspace", Destination: "/workspace" }],
					NetworkSettings: { Ports: { "8787/tcp": [{ HostIp: "0.0.0.0", HostPort: "49153" }] } },
				},
			]),
		);

		expect(inspect[0]).toMatchObject({
			id: "abcdef",
			name: "pi-sandbox-workspace-hash",
			workspaceRoot: "/host/workspace",
			daemonEndpoint: "ws://127.0.0.1:49153/pi/workspace",
		});
		expect(parseDockerPortOutput("0.0.0.0:49154\n")).toBe("ws://127.0.0.1:49154/pi/workspace");
	});

	it("reports docker diagnostics with secrets redacted", async () => {
		const runner = new FakeDockerRunner([fail("Cannot connect to Docker daemon PI_DAEMON_TOKEN=secret-token")]);
		const service = new DockerSandboxService({ runner, env: {} });

		let message = "";
		try {
			await service.checkDockerAvailable();
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("[REDACTED]");
		expect(message).not.toContain("secret-token");
	});
});
