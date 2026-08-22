# Workspace Sandbox

`/sandbox` is the single interactive command for workspace tool backends. It can show or clear the active backend, connect a deferred SSH backend, attach an existing sandbox daemon, or manage a Pi-owned Docker container. Local Pi remains the orchestrator: provider credentials, model calls, prompts, session history, extensions, subagents, RPC, and UI stay in the local process.

The command is user-only. It is shown in interactive slash-command completion, but it is not exposed through RPC `get_commands`, extension-visible command catalogs, system prompts, tool definitions, prompt templates, skills, or rules. This only hides the Pi operator command from LLM-visible catalogs; it does not prevent a model that has shell access from invoking Docker directly through normal shell tools.

## Commands

Type these commands in interactive mode:

```text
/sandbox [status]
/sandbox clear
/sandbox ssh <user@host[:/path]> [path]
/sandbox --attach <ws://url>
/sandbox start [--image <image>]
/sandbox list
/sandbox stop [container]
```

- `/sandbox` and `/sandbox status` show the active workspace tool backend.
- `/sandbox clear` disconnects the active deferred or sandbox backend without stopping a managed Docker container.
- `/sandbox ssh` configures SSH for a session started with `--remote-deferred --remote-cwd <path>`.
- `/sandbox --attach` connects to an already-running sandbox daemon without starting or managing its container. Set `PI_REMOTE_TOKEN` when the daemon requires authentication. The daemon workspace root must match `--remote-cwd` in deferred mode, or `sandbox.workspaceMountPath` (default `/workspace`) otherwise.
- `/sandbox start` launches or starts a Pi-owned Docker container for the current working directory, waits for `pi --daemon` readiness, then switches workspace tools and project resource loading to the container daemon.
- `/sandbox list` lists Pi sandbox containers for the current workspace.
- `/sandbox stop` stops the active Pi-owned sandbox. For a daemon connected with `--attach` or a deferred SSH backend, it only detaches and restores the previous tool backend. With an id or name, it stops that matching Pi sandbox container. Without an active sandbox, it may stop the single matching current-workspace sandbox; ambiguous cases require an explicit target.

Example:

```text
PI_REMOTE_TOKEN=... pi
/sandbox --attach ws://127.0.0.1:8787/pi/workspace
/sandbox stop

/sandbox start --image pi-sandbox:local
/sandbox list
/sandbox stop
```

When start succeeds, Pi shows the container name/id, the host-to-container workspace mount, a redacted daemon endpoint, and a status line that workspace tools/resources now route through the container daemon.

## Workspace mount and daemon endpoint

Defaults:

| Setting | Default |
| --- | --- |
| Host workspace | current working directory |
| Container workspace | `/workspace` |
| Daemon command | `pi --daemon` |
| Docker network mode | `host` |
| Daemon bind and endpoint | `127.0.0.1:8787` |
| Daemon token | generated per start |

The mounted workspace is read/write. Any process in the container can modify files in the mounted host directory. Paths reported by the daemon use the container workspace root (`/workspace`), while local Pi keeps session and UI state on the host. The container uses Docker host networking, so services bound to host loopback are directly reachable from the sandbox and the daemon occupies its configured port on the host. The default image also configures `/tmp` as an additional confined temporary root, so workspace tools can use disposable scratch files without exposing another host mount.

`/sandbox start` generates a bearer token and passes it to Docker through the container environment as `PI_DAEMON_TOKEN`. Pi uses that token in memory to connect to the daemon. Tokens are not put in Docker argv, image layers, container names, labels, URLs, or user-facing status. Status, list output, and errors redact secrets.

## Image and configuration

The default image is `ghcr.io/fleetagent/pi-sandbox:latest`. The sandbox image uses the integrated `pi --daemon` command from `@fleetagent/pi-coding-agent`; the retired `@fleetagent/pi-daemon` package and `pi-daemon` binary are not used or supported.

Configuration precedence for a start is:

1. command flag: `/sandbox start --image <image>`;
2. environment variables: `PI_SANDBOX_*`;
3. project settings in `.pi/settings.json`;
4. global settings in `~/.pi/agent/settings.json`;
5. defaults.

Sandbox settings:

```json
{
  "sandbox": {
    "image": "pi-sandbox:local",
    "dockerBinary": "docker",
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
| `PI_SANDBOX_IMAGE` | `sandbox.image` |
| `PI_SANDBOX_DOCKER` | `sandbox.dockerBinary` |
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

## Container identity, list, and stop

Pi labels sandbox containers and filters list/stop operations by those labels, not by name alone. Labels include sandbox ownership, workspace hash, workspace mount target, daemon port, owner uid when available, Pi version, and a session id. Labels do not contain tokens.

Container names use the configured prefix plus a sanitized workspace name, workspace hash, and per-start session suffix so stopped containers do not block a later `/sandbox start`. `/sandbox list` reports id/name, state/status, image, workspace mount target, and daemon endpoint when Docker inspect data is available. `/sandbox stop` only targets containers matching Pi sandbox labels; it does not stop unrelated containers with similar names.

Stopping the active sandbox clears the active remote tool backend and returns the session to the previous non-sandbox backend or local tool execution. If Pi was started in deferred remote mode, stop leaves the deferred backend unconfigured.

## Security boundaries

Docker sandbox mode is not a complete security sandbox.

- The current working directory is mounted read/write into the container.
- Container processes can read, write, delete, or chmod files in that mount as the container user.
- Files created by the default image are owned by uid `1000` unless Docker/user policy changes it.
- `/tmp` is writable container-local scratch storage and is removed with the container; it is not mounted from the host by default.
- The daemon token authorizes high-privilege workspace tool access for the mounted workspace.
- Anyone with Docker access on the host may inspect containers, images, mounts, labels, ports, and environment depending on host policy.
- Override images are trusted code. A malicious image can run arbitrary processes against the mounted workspace.
- Docker socket mounts, privileged mode, broad host volumes, or extra credentials can further break the intended boundary.
- The container uses host networking, so it can reach host network services and the wider network with the host's network identity.
- Hidden command behavior only keeps `/sandbox` out of LLM-visible Pi catalogs. It is not an OS policy or a Docker permission boundary.

Use trusted images, avoid mounting the Docker socket, avoid privileged containers, keep `sandbox.daemonHostBind` loopback-only unless you add a separate trusted network/TLS boundary, and do not place secrets in the mounted workspace unless the sandbox image should access them.

## Troubleshooting

- Docker missing: install Docker or set `PI_SANDBOX_DOCKER` / `sandbox.dockerBinary` to the correct executable.
- Permission denied connecting to Docker: add the user to the appropriate Docker group, start Docker Desktop, or run Pi where Docker is accessible. Treat Docker group membership as host-level administrative power.
- Image pull/build failure: verify the image name, registry authentication, network access, and local build command. For local images, build with the local release directory as context; do not use `--skip-install` for the sandbox Dockerfile.
- Port conflict: host networking requires the configured daemon port (default `8787`) to be free on the host. Stop the conflicting process or stale sandbox, or change `sandbox.daemonPort`. Docker Desktop requires host networking to be enabled in Settings > Resources > Network.
- Start succeeds but daemon activation fails: the container may still be running. Use `/sandbox list` and `/sandbox stop <id-or-name>` to clean it up.
- `/sandbox list` is empty: it only lists Pi-labeled sandbox containers for the current workspace by default. Check that you are in the same host workspace and that the container was created by `/sandbox start`.
- `/sandbox stop` says no sandbox was found: pass the listed id or name, or switch to the workspace that owns the sandbox.
- Already stopped: stop is idempotent for matching containers and reports already-stopped containers cleanly.
