# Workspace Sandbox

`/sandbox` is the single interactive command for workspace tool backends. It can show or clear the active backend, attach an existing sandbox daemon, or manage a Docker container or Lima VM. Sandbox connections are session-local: a new session starts on its underlying backend, returning to an earlier session reconnects its remembered sandbox while Pi remains running, and multiple session sandboxes may coexist. Local Pi remains the orchestrator: provider credentials, model calls, session history, extensions, RPC, and UI stay in the local process; subagent workspace tools inherit the parent session's active sandbox.

The command is user-only. It is shown in interactive slash-command completion, but it is not exposed through RPC `get_commands`, extension-visible command catalogs, system prompts, tool definitions, prompt templates, skills, or rules. This only hides the Pi operator command from LLM-visible catalogs; it does not prevent a model with host shell access from invoking Docker or Lima directly.

## Commands

Type these commands in interactive mode:

```text
/sandbox [status]
/sandbox clear
/sandbox --attach <ws://url>
/sandbox start [--runtime docker|lima] [--image <image>] [--name <lima-instance>] [--template <lima-template>]
/sandbox list [--runtime docker|lima]
/sandbox stop [sandbox]
```

- `/sandbox` and `/sandbox status` show the active workspace tool backend.
- `/sandbox clear` disconnects the active deferred or sandbox backend without stopping a managed container or VM.
- `/sandbox --attach` connects to an already-running sandbox daemon without starting or managing its container. Set `PI_REMOTE_TOKEN` when the daemon requires authentication. The daemon workspace root must match `--remote-cwd` in deferred mode, or `sandbox.workspaceMountPath` (default `/workspace`) otherwise.
- `/sandbox start` launches a Docker container by default. With `--runtime lima`, it creates a Lima VM from `template:docker-rootful`, mounts the current working directory read-write at `/workspace`, starts `pi --daemon` inside the VM, and switches workspace tools and project resource loading to that daemon. Use `--template` to override the Lima template. `--name` reuses an existing Lima instance after verifying that its writable `/workspace` mount maps to the current directory.
- `/sandbox list` lists sandboxes for the current workspace. Use `/sandbox list --runtime lima` to list matching Lima instances that can be reused by name.
- `/sandbox stop` stops the active Pi-owned sandbox. For a daemon connected with `--attach`, it only detaches and restores the previous tool backend. Reused user-owned Lima VMs remain running, but their Pi daemon is stopped. With an id or name, it uses the active runtime, or `sandbox.runtime` when no sandbox is active. Ambiguous cases require an explicit target.

Example:

```text
PI_REMOTE_TOKEN=... pi
/sandbox --attach ws://127.0.0.1:8787/pi/workspace
/sandbox stop

/sandbox start --image pi-sandbox:local
/sandbox list

/sandbox start --runtime lima
/sandbox start --runtime lima --template template:alpine
/sandbox list --runtime lima
/sandbox stop

/sandbox start --runtime lima --name pi-sandbox-project-abcd-session-1234
/sandbox stop
```

When start succeeds, Pi shows the sandbox name/id, the host-to-sandbox workspace mount, a redacted daemon endpoint, and a status line that workspace tools/resources now route through the sandbox daemon.

## Workspace mount and daemon endpoint

Defaults:

| Setting | Default |
| --- | --- |
| Host workspace | current working directory |
| Container workspace | `/workspace` |
| Daemon command | `pi --daemon` |
| Docker network mode | `bridge` |
| Daemon preferred bind and endpoint | `127.0.0.1:8787` |
| Daemon token | generated per start |
| Lima binary | `limactl` |
| Lima template | `template:docker-rootful` |

The mounted workspace is read/write. Any process in the container can modify files in the mounted host directory. Paths reported by the daemon use the container workspace root (`/workspace`), while local Pi keeps session and UI state on the host. The container uses Docker bridge networking and publishes only the authenticated daemon port to the configured host bind address (`127.0.0.1` by default), so sandbox processes cannot directly access host loopback services. Pi uses the configured daemon port when available and otherwise selects an available host port, allowing separate sessions to keep concurrent sandbox containers. The default image also configures `/tmp` as an additional confined temporary root, so workspace tools can use disposable scratch files without exposing another host mount.

`/sandbox start` uses a fresh bearer token for every daemon. Docker receives it through the container environment. Lima generates it inside the guest and returns it directly to the host launcher. Pi keeps the token in memory and uses it to connect to the daemon. Tokens are not put in Docker or Lima command arguments, image layers, container or instance names, labels, URLs, or user-facing status. Status, list output, and errors redact secrets.

## Image and configuration

The default image is `ghcr.io/fleetagent/pi-sandbox:latest`. The sandbox image uses the integrated `pi --daemon` command from `@fleetagent/pi-coding-agent`; the retired `@fleetagent/pi-daemon` package and `pi-daemon` binary are not used or supported.

Configuration precedence for a start is:

1. command flags: `/sandbox start --runtime <runtime>`, `--image <image>`, `--name <lima-instance>`, and `--template <lima-template>`;
2. environment variables: `PI_SANDBOX_*`;
3. project settings in `.pi/settings.json`;
4. global settings in `~/.pi/agent/settings.json`;
5. defaults.

Sandbox settings:

```json
{
  "sandbox": {
    "runtime": "docker",
    "image": "pi-sandbox:local",
    "dockerBinary": "docker",
    "limaBinary": "limactl",
    "limaTemplate": "template:docker-rootful",
    "limaInstanceNamePrefix": "pi-sandbox",
    "workspaceMountPath": "/workspace",
    "containerNamePrefix": "pi-sandbox",
    "daemonPort": 8787,
    "daemonHostBind": "127.0.0.1",
    "cleanup": "stop"
  }
}
```

Environment overrides:

| Variable | Setting |
| --- | --- |
| `PI_SANDBOX_RUNTIME` | `sandbox.runtime` (`docker` or `lima`) |
| `PI_SANDBOX_IMAGE` | `sandbox.image` |
| `PI_SANDBOX_DOCKER` | `sandbox.dockerBinary` |
| `PI_SANDBOX_LIMA` | `sandbox.limaBinary` |
| `PI_SANDBOX_LIMA_TEMPLATE` | `sandbox.limaTemplate` |
| `PI_SANDBOX_LIMA_INSTANCE_PREFIX` | `sandbox.limaInstanceNamePrefix` |
| `PI_SANDBOX_WORKSPACE_MOUNT` | `sandbox.workspaceMountPath` |
| `PI_SANDBOX_CONTAINER_PREFIX` | `sandbox.containerNamePrefix` |
| `PI_SANDBOX_DAEMON_PORT` | `sandbox.daemonPort` |
| `PI_SANDBOX_DAEMON_HOST_BIND` | `sandbox.daemonHostBind` |
| `PI_SANDBOX_CLEANUP` | `sandbox.cleanup` (`stop` or `remove`) |

## Base image

Build the local base image from repository release artifacts:

```bash
npm run release:local -- --out /tmp/pi-local-release --force
docker build \
  -f packages/coding-agent/examples/sandbox-docker/Dockerfile \
  -t pi-sandbox:local \
  /tmp/pi-local-release
```

Then use it for one start:

```text
/sandbox start --image pi-sandbox:local
```

Or make it the default:

```bash
PI_SANDBOX_IMAGE=pi-sandbox:local pi
```

See [`../examples/sandbox-docker/README.md`](../examples/sandbox-docker/README.md) for image build inputs and manual `docker run` commands.

## Sandbox identity, list, and stop

Pi labels sandbox containers and filters list/stop operations by those labels, not by name alone. Labels include sandbox ownership, workspace hash, workspace mount target, daemon port, owner uid when available, Pi version, and a session id. Labels do not contain tokens.

Docker container names use the configured prefix plus a sanitized workspace name, workspace hash, and per-start session suffix. Managed Lima names use `sandbox.limaInstanceNamePrefix` with the same workspace/session identity and a random suffix. Daemon ports are allocated per start, preferring `sandbox.daemonPort` and falling back to an available host port. `/sandbox list --runtime lima` reports Lima instances whose writable `/workspace` mount maps to the current host workspace; their names can be passed back to `/sandbox start --runtime lima --name <name>`. Reused user-owned VMs are left running by `/sandbox stop`, while Pi stops or removes managed VMs according to `sandbox.cleanup`.

Stopping the active sandbox clears the current session's remote tool backend and returns it to the previous non-sandbox backend or local tool execution. If Pi was started in deferred remote mode, stop leaves that session's deferred backend unconfigured. Switching sessions disconnects the old live client without stopping its managed sandbox; returning to that session reconnects it from memory. On graceful Pi shutdown, Docker containers and Lima instances started by that Pi process are stopped or removed according to `sandbox.cleanup`; reused user-owned Lima VMs remain running. Tokens are never persisted to session files, so sandboxes are not restored after Pi exits.

## Security boundaries

Docker and Lima sandbox modes are not complete security sandboxes.

- The current working directory is mounted read/write into the container or VM.
- Subagents inherit the active workspace backend. Sandboxed subagents reject host cwd overrides, do not load host project context or extensions, treat custom system prompts as literal text, and cannot continue an older run after the parent backend changes.
- Sandbox processes can read, write, delete, or chmod files in that mount as the guest user.
- Files created by the default image are owned by uid `1000` unless Docker/user policy changes it.
- `/tmp` is writable container-local scratch storage and is removed with the container; it is not mounted from the host by default.
- The daemon token authorizes high-privilege workspace tool access for the mounted workspace.
- Anyone with Docker access on the host may inspect containers, images, mounts, labels, ports, and environment depending on host policy.
- Override Docker images and Lima templates are trusted code. A malicious image or template can run arbitrary processes against the mounted workspace.
- Docker socket mounts, privileged mode, broad host volumes, or extra credentials can further break the intended boundary.
- Bridge networking prevents direct host-loopback access, but the container may still reach external networks and host services deliberately exposed beyond loopback.
- Reused Lima instances retain their existing filesystem, software, credentials, and network access; only reuse instances you trust.
- Hidden command behavior only keeps `/sandbox` out of LLM-visible Pi catalogs. It is not an OS, Docker, or VM permission boundary.

Use trusted images, avoid mounting the Docker socket, avoid privileged containers, keep `sandbox.daemonHostBind` loopback-only unless you add a separate trusted network/TLS boundary, and do not place secrets in the mounted workspace unless the sandbox image should access them.

## Troubleshooting

- Docker missing: install Docker or set `PI_SANDBOX_DOCKER` / `sandbox.dockerBinary` to the correct executable.
- Lima missing: install Lima or set `PI_SANDBOX_LIMA` / `sandbox.limaBinary`. Managed Lima VMs provision the current `@fleetagent/pi-coding-agent` version through npm; custom or reused instances must provide a compatible `pi` command.
- Permission denied connecting to Docker: add the user to the appropriate Docker group, start Docker Desktop, or run Pi where Docker is accessible. Treat Docker group membership as host-level administrative power.
- Image pull/build failure: verify the image name, registry authentication, network access, and local build command. For local images, build with the local release directory as context; do not use `--skip-install` for the sandbox Dockerfile.
- Port conflict: Pi prefers the configured daemon port (default `8787`) and automatically selects an available port when it is occupied. A remaining bind failure can indicate an invalid `sandbox.daemonHostBind`, exhausted local resources, or a race with another process.
- Start succeeds but daemon activation fails: the container or VM may still be running. Use the runtime-specific `/sandbox list` and `/sandbox stop <id-or-name>` commands to clean it up.
- `/sandbox list` is empty: Docker listing only includes Pi-labeled containers; Lima listing only includes instances with the current workspace mounted at `/workspace`. Check that you selected the intended runtime and workspace.
- `/sandbox stop` says no sandbox was found: pass the listed id or name, or switch to the workspace that owns the sandbox.
- Already stopped: stop is idempotent for matching containers and reports already-stopped containers cleanly.
