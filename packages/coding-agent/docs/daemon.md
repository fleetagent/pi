# Remote Workspace Daemon

`pi --daemon` starts Pi as a remote workspace runtime. A normal local Pi process remains the orchestrator: it owns provider credentials, model calls, prompts, sessions, compaction, extensions, subagents, RPC, and UI. The daemon owns one configured workspace and executes canonical workspace tools, primitive project-resource operations, streamed file transfers, optional process execution, and optional colocated LSP.

The retired `@fleetagent/pi-daemon` package and `pi-daemon` binary are not supported. Install and run `@fleetagent/pi-coding-agent`, then start the daemon with `pi --daemon`.

## Start a daemon

```bash
npm install -g --ignore-scripts @fleetagent/pi-coding-agent
PI_DAEMON_TOKEN='long-random-token' \
pi --daemon --daemon-cwd /workspace --daemon-host 127.0.0.1 --daemon-port 8787
```

Connect from another Pi process:

```bash
PI_REMOTE_TOKEN='long-random-token' pi --remote ws://127.0.0.1:8787/pi/workspace
```

Attach an interactive Pi session when the daemon is running in a sandbox whose workspace root is `/workspace`:

```bash
PI_REMOTE_TOKEN='long-random-token' pi
/sandbox --attach ws://127.0.0.1:8787/pi/workspace
```

For a deferred daemon backend, use `pi --remote-deferred --remote-cwd /workspace` followed by `/sandbox --attach <ws://url>`. `/sandbox` is the only interactive backend-management command.

Use `PI_REMOTE_TOKEN` on the client. Do not put tokens in query strings or URLs.

## Topology and trust boundary

One daemon process serves one workspace root and one trust domain. The daemon is an authenticated remote-code-execution service: anyone with the bearer token can use every advertised daemon capability.

Application-layer confinement prevents protocol paths and symlinks from escaping the configured workspace and optional temporary root for file tools, resource reads, file transfers, temporary outputs, subprocess working directories, and LSP paths. `PI_DAEMON_TEMP_ROOT` is opt-in and should point only to disposable storage inside an OS sandbox; it is unset by default. This is not an operating-system sandbox. If process execution is enabled, commands can access anything the daemon OS user can access. Run the daemon as a dedicated unprivileged user, in a container, VM, or equivalent sandbox for hostile repositories.

The daemon refuses root and insecure non-loopback deployment by default. Non-loopback HTTP requires explicit override and should only be used behind a trusted TLS terminator. Prefer TLS for direct non-local use.

## Configuration

Common options:

| Option | Environment | Description |
| --- | --- | --- |
| `--daemon-host <ip>` | `PI_DAEMON_HOST` | Bind address. Defaults to `127.0.0.1`. |
| `--daemon-port <port>` | `PI_DAEMON_PORT` | Bind port. Defaults to `8787`. |
| `--daemon-cwd <dir>` | `PI_DAEMON_CWD` | Canonical confined workspace root. Defaults to current directory. |
| environment only | `PI_DAEMON_TEMP_ROOT` | Optional additional confined temporary root. Intended for container/VM scratch storage such as `/tmp`. |
| environment only | `PI_DAEMON_TOKEN` | Server bearer token required by clients. |
| environment only | `PI_DAEMON_ORIGINS` | Optional comma-separated exact WebSocket Origin allowlist. |
| `--daemon-tls-cert <file>` / `--daemon-tls-key <file>` | `PI_DAEMON_TLS_CERT` / `PI_DAEMON_TLS_KEY` | Direct TLS listener material. |
| `--daemon-allow-process-exec` | `PI_DAEMON_ALLOW_PROCESS_EXEC` | Enable shell/tool subprocess execution and managed LSP spawns. |
| `--daemon-lsp-config <file>` | `PI_DAEMON_LSP_CONFIG` | Operator-reviewed LSP configuration layer. |
| `--daemon-trust-project-lsp` | `PI_DAEMON_TRUST_PROJECT_LSP` | Include workspace `.pi/settings.json` LSP config. |

Run `pi --daemon --help` for the complete limit and deployment option list.

## Resources, extensions, and LSP

Project instructions, skills, rules, and prompt templates are read through the daemon's confined primitive operations and parsed by the local orchestrating Pi with remote provenance. User and package resources remain local.

Extensions always run in the orchestrating Pi process. `pi --daemon` does not discover or execute user, package, or project extensions and does not provide a fake `ExtensionContext`. Local extension hooks still wrap remote tool calls once, and backend-aware extensions may use the borrowed daemon `ToolOperations` facade.

Daemon LSP is operator-owned and daemon-global. Configure it with `--daemon-lsp-config`; optionally include trusted project LSP settings with `--daemon-trust-project-lsp`. Managed spawned servers require `--daemon-allow-process-exec`. The orchestrator suppresses its local LSP manager for remote files and consumes the daemon's negotiated `lsp_*` tools and sanitized status.

## Operations and file transfer

The daemon publishes a negotiated catalog of canonical Pi workspace tools. Local Pi prepares tool arguments once; the daemon validates again before execution. Catalog generation changes pause and refresh the local proxy. Stale, not-started calls may be retried once; calls that may have started side effects are not replayed.

File uploads/downloads and artifact reads use bounded streamed transfer messages. Whole responses, updates, transfer chunks, inbound frames, outbound queues, active calls, subprocess output, request duration, connections, and shutdown are bounded. Partial upload/write state is cleaned up on abort, timeout, disconnect, or shutdown.

## Docker examples

A local daemon smoke-test image lives at `packages/coding-agent/examples/daemon-docker` and starts the packaged `pi --daemon` command inside the container.

The sandbox base image used by `/sandbox start` lives at `packages/coding-agent/examples/sandbox-docker`. It builds from local release artifacts, expects the host workspace to be mounted at `/workspace`, and receives `PI_DAEMON_TOKEN` from the sandbox launcher environment. See [Docker Sandbox](sandbox.md) for the hidden `/sandbox` command, configuration precedence, auto-switch behavior, and security limits.

```bash
docker build -f packages/coding-agent/examples/daemon-docker/Dockerfile -t pi-remote-daemon-test .
docker run --rm -p 8787:8787 --name pi-remote-daemon-test pi-remote-daemon-test
PI_REMOTE_TOKEN=dev-token-dev-token-dev-token-dev-token ./pi-test.sh --remote ws://127.0.0.1:8787/pi/workspace
```

## Troubleshooting

- `401`/`403`: check `PI_DAEMON_TOKEN` on the server and `PI_REMOTE_TOKEN` on the client. Tokens are header-only.
- `404`: connect to `/pi/workspace`.
- Non-loopback bind rejected: use loopback, enable TLS, or explicitly accept insecure transport only behind a trusted boundary.
- `bash` unavailable: start the daemon with `--daemon-allow-process-exec` and isolate the OS user/container.
- LSP unavailable: verify `--daemon-lsp-config`, process-exec grants for managed spawns, confined paths, and daemon status.
- Resource reload mismatch: reconnect or run `/reload` after changing remote project resources.

## Migration from `pi-daemon`

Replace global installs and commands:

```bash
npm uninstall -g @fleetagent/pi-daemon
npm install -g --ignore-scripts @fleetagent/pi-coding-agent
pi --daemon --daemon-cwd /workspace --daemon-port 8787
```

Breaking changes from the retired daemon:

- no `@fleetagent/pi-daemon` package, `pi-daemon` binary, compatibility shim, or old unversioned protocol;
- no query-string or userinfo tokens; use `Authorization: Bearer` via `PI_REMOTE_TOKEN`;
- no `HOST`/`PORT` aliases; use `PI_DAEMON_HOST`/`PI_DAEMON_PORT` or CLI flags;
- workspace paths, symlinks, transfers, subprocess cwd, temporary outputs, resources, and LSP paths are confined;
- process execution is disabled unless explicitly granted;
- non-loopback and root deployments are refused unless explicitly overridden.
