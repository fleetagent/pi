# ADR: Integrated remote workspace daemon

- Status: Accepted for implementation
- Date: 2026-07-20
- Scope: `@fleetagent/pi-coding-agent`, the remote workspace protocol, and retirement of `@fleetagent/pi-daemon`

## Context

Pi currently has two independently shaped remote-runtime halves:

- the normal `pi` process owns the agent loop and creates canonical built-in tool definitions around `ToolOperations`;
- `@fleetagent/pi-daemon` is a side-effect executable with a separate WebSocket parser and separate implementations of shell, filesystem, search, MIME, and file-transfer primitives.

This split keeps provider credentials and the LLM loop local, but it duplicates behavior and prevents the remote runtime from executing canonical Pi tools. The current daemon also advertises a working directory without confining filesystem paths or shell commands to it.

The current implementation is an explicitly rejected security baseline, not an acceptable transitional deployment: it can expose unauthenticated shell execution on non-loopback binds, accepts arbitrary host paths, inherits the full process environment, allows query tokens, performs destructive partial uploads, and has no graceful process shutdown. The existing unauthenticated `0.0.0.0` Docker example must not be used once work begins; the replacement Docker target cannot ship until it satisfies this ADR.

The separate package will be replaced by an early-dispatched `pi --daemon` command. This is an execution topology change, not a new agent presentation mode.

## Decision

A normal Pi process is the **orchestrator**. A `pi --daemon` process is a **workspace runtime**. They communicate through one validated, versioned remote-workspace protocol.

The workspace runtime hosts a reusable canonical `WorkspaceToolHost`. The same host is composed into local `AgentSession` instances. The daemon does not construct `PiAgent`, `AgentSession`, an `Agent`, a model registry, auth storage, a session store, compaction state, or a user interface.

`pi --daemon` is dispatched before migrations and before normal CLI/runtime initialization. It is not added to `PiAgentAppMode`, `Mode`, or `PiAgent.runMode()`.

### Process topology

```text
user / RPC host
      |
      v
normal pi (orchestrator)
  provider auth and calls
  LLM/agent loop
  conversation and session persistence
  prompt/resource assembly
  local policy extensions and tool lifecycle events
      |
      | authenticated, versioned remote-workspace protocol
      v
pi --daemon (one workspace runtime)
  canonical workspace tool host
  workspace filesystem and subprocesses
  transfer endpoints
  remote project resource I/O
  colocated LSP runtime
```

## Responsibility matrix

| Concern | Orchestrating Pi | Remote `pi --daemon` | Wire boundary |
|---|---|---|---|
| Provider authentication and OAuth | Sole owner | Forbidden; provider stores are never opened | None |
| Provider/LLM requests | Sole owner | Forbidden | None |
| Agent loop and tool-call scheduling | Sole owner | Executes one requested tool invocation; never schedules an LLM turn | Invocation, update, result, cancellation |
| Conversation messages | Sole owner | Forbidden except opaque tool arguments/results needed for one invocation | Tool arguments/results only |
| Session creation, lookup, persistence, branching, and labels | Sole owner | Forbidden | None |
| Compaction, retry, steering, and follow-ups | Sole owner | Forbidden | None |
| System-prompt assembly | Sole owner | Forbidden | Resource catalog/content returned to orchestrator |
| User and package instructions, skills, rules, and prompts | Loads locally | Never discovers or executes them | None |
| Project context files, skills, rules, prompts, and subagent presets | Owns remote traversal/parsing, trust, precedence, collision handling, diagnostics, and prompt/preset inclusion through a remote operations adapter | Owns confined stat/list/read I/O only; it does not parse or cache prompt resources | Validated primitive workspace operations with workspace provenance |
| User/package/project Pi extensions | Loads locally under existing trust rules | Not loaded in the initial daemon surface | Local extension tools may call the active remote operations adapter |
| Local extension `tool_call`/`tool_result` policy | Sole owner; wraps the remote invocation exactly once | Does not replay AgentSession lifecycle hooks | Invocation/result only |
| Built-in `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` | Owns active-tool policy, model-facing local definitions after catalog hash verification, argument preparation, and local rendering | Validates normalized arguments and executes the canonical shared definitions through `WorkspaceToolHost` | Catalog, invocation, updates, canonical result |
| Primitive `ToolOperations` for resources and backend-aware extensions | Exposes the existing interface to local loaders/extensions; mutation calls use the same daemon-global file queue | Provides confined access/read/write/mkdir/stat/readdir/glob/grep and optional exec/transfer capabilities without exposing them as model tools | Validated operation requests/results/cancellation |
| `load_tool` and `unload_tool` | Sole owner because they mutate orchestrator context | Forbidden | None |
| `subagent` | Sole owner; child LLM sessions and project-preset trust remain local and borrow the PiAgent-owned remote client | Forbidden; no daemon-side model calls | Child tool invocations use the same workspace protocol |
| Custom SDK/extension tools | Execute locally unless their implementation uses `ctx.toolOperations` or `ctx.execToolBackend` | Not auto-loaded or advertised | Backend-aware calls use primitive workspace capabilities and global mutation serialization |
| LSP configuration and trust | For a remote backend, suppresses the local manager and consumes the daemon catalog/status; it cannot reconfigure daemon LSP | Operator-owned daemon-global configuration and trust; starts/attaches servers, synchronizes documents, executes `lsp_*`, reports status, and shuts down owned servers | Catalog, LSP tool invocation, status; no client trust grant |
| LSP for local workspaces | Owns the existing AgentSession runtime | None | None |
| File upload/download | Selects local source/destination and authorizes the operation | Streams only confined remote paths and performs atomic destination publication | Bounded chunks, SHA-256/length, cancellation, terminal result |
| Interactive, JSON, print, and RPC UI | Sole owner | Forbidden | None |
| User-facing tool lifecycle events | Sole owner and emits one coherent lifecycle | Emits protocol progress only | Progress is translated into local events |
| Remote client lifecycle | `PiAgent` owns one client/deferred holder; AgentSessions and subagents borrow it and never dispose it | Owns each accepted connection and its per-connection work | Handshake, catalog refresh, close |
| Workspace tool-host lifecycle | Holds a negotiated immutable catalog view | Owns daemon-global host/LSP generations and daemon-side resources | Handshake, generation change, shutdown |
| Process signals and server readiness | PiAgent/CLI closes its owned client on final disposal | Owns listener, connections, subprocess trees, managed LSP, and readiness log | Connection close and structured shutdown errors |
| Telemetry and update checks | Normal Pi policy | Disabled in daemon mode | None |

## Workspace and process security

### Threat model

The daemon is an authenticated remote-code-execution service. A valid daemon credential grants the ability to use every advertised workspace capability. The application-level path policy reduces accidental and protocol-level filesystem escape, but it is not an operating-system sandbox.

If process execution is enabled, a shell command can read or modify anything accessible to the daemon OS user regardless of Pi path checks. Strong isolation therefore requires a dedicated unprivileged user, container, VM, or equivalent platform sandbox. Documentation must not describe the workspace root as a complete sandbox.

Malicious unauthenticated network clients, malformed protocol input, slow readers, disconnected clients, and an untrusted remote repository are in scope. A malicious process already running as the daemon OS user and filesystem time-of-check/time-of-use races caused by such a process are outside the application-layer confinement guarantee.

### Workspace root

One daemon process serves exactly one configured workspace root. The root is resolved to an absolute canonical path before listening. Startup fails if it does not exist or is not a directory.

All filesystem, resource, transfer, temporary-output, LSP document, marker-discovery, and subprocess-working-directory paths are interpreted in the daemon path flavor and checked against that root:

1. relative paths resolve against the workspace root;
2. absolute paths are accepted only when they remain inside the root;
3. lexical `..` escape is rejected;
4. existing path components are resolved through `realpath`; a symlink target outside the root is rejected;
5. for a new destination, the nearest existing ancestor is resolved and must remain inside the root;
6. mutation operations recheck the resolved parent immediately before publication;
7. transfer destinations use a same-directory temporary file and atomic rename; cancellation and failure remove the temporary file;
8. no initial `--allow-host-paths` bypass is provided.

Path comparisons are path-flavor aware. Windows roots compare case-insensitively while preserving spelling; POSIX roots compare case-sensitively. UNC authority/share roots are treated as Windows roots. Prefix matching must use path components, not raw string prefixes.

### Arbitrary process execution

`bash` (the canonical shell tool despite its name on non-Bash platforms) is a distinct unsafe capability.

- Remote process execution requires explicit daemon startup opt-in (`--daemon-allow-process-exec` or its dedicated environment equivalent).
- Without opt-in, `bash` is absent from the negotiated tool catalog and raw process execution is unavailable.
- The requested process cwd must pass workspace confinement, but commands themselves are not parsed or sandboxed.
- Children run as the daemon OS user. The daemon does not elevate privileges or implement setuid.
- Startup as root is refused unless an explicit `--daemon-allow-root` override is supplied.
- Child environments are deny-by-default. The base contains only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LC_*`, `TERM`, `COLORTERM`, `NO_COLOR`, and, on Windows, `SystemRoot`, `ComSpec`, and `PATHEXT`. Names are matched case-insensitively on Windows.
- Operators may copy additional startup variables by repeated `--daemon-env <NAME>` or a validated dedicated environment list. Invocation-supplied environment overrides are rejected in the initial protocol. After base, operator, and LSP environments are merged, a final non-bypassable filter removes names case-insensitively if they are `PI_DAEMON_TOKEN`, `PI_REMOTE_TOKEN`, a configured TLS private-key/passphrase variable, begin with `PI_DAEMON_TLS_`, or end in `_API_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD`, `_PRIVATE_KEY`, or `_CREDENTIALS`. Thus a base-looking name such as `LC_API_KEY` is still removed. LSP-specific values come only from trusted daemon LSP configuration and pass the same final filter.
- Every child is placed in an owned process tree/group where supported. Cancellation, connection loss, deadline, daemon host reload, and shutdown terminate the complete owned tree with a bounded graceful-then-force sequence.

A deployment needing arbitrary host access must choose that through OS privileges and process-exec opt-in; the protocol does not add an unrestricted path mode.

### External command dependencies

Daemon startup does not require `fd`, `rg`, or `file`. Canonical tools use the same dependency discovery/fallback behavior as local Pi. A missing optional executable makes only the affected tool unavailable or produces its canonical actionable error; it does not crash the server. Availability is reflected in the negotiated catalog. Shell availability is checked when process execution is enabled.

### WorkspaceToolHost configuration and invocation

`WorkspaceToolHost` has an explicit immutable construction contract: canonical workspace root/cwd, a confined `ToolOperations`, tool availability, image handling, shell executable, optional LSP runtime, optional local-only read-operation resolver, artifact store, and bounded disposal. It does not read `SettingsManager` itself.

For a local AgentSession, Pi maps local settings into host options and may provide the existing read resolver for user/package resources. For a daemon, the operator chooses the shell executable and LSP settings; the read resolver is absent so the host cannot reach orchestrator resources. Presentation metadata, active-tool selection, renderers, and prompt snippets remain local.

Connection-scoped execution options that already affect canonical behavior, currently image auto-resize and shell command prefix, are carried in the invocation envelope, not global daemon state. The local proxy applies `prepareArguments` exactly once before its normal schema validation and sends `argumentsPrepared: true`. The daemon verifies the exact catalog/schema hash, requires `argumentsPrepared: true`, validates the normalized arguments again against the same schema, and invokes a host path that does not rerun `prepareArguments`. The daemon applies the invocation envelope exactly once. Non-agent protocol clients must use the shared proxy library rather than constructing raw prepared requests.

The daemon catalog is authoritative for availability. It contains stable tool name, execution mode, canonical parameter schema, schema hash, and feature flags. The orchestrator exposes only tools for which it has the same compiled canonical definition and exact schema hash; it uses that local definition for the model schema and renderer. Capability changes remove or add whole tools (`bash`, `lsp_*`) but do not mutate their schemas. The initial protocol does not synthesize model tools from arbitrary remote schemas.

## Network, authentication, and credential policy

### Bind and TLS

- Default bind: `127.0.0.1` on the configured port.
- Loopback may run without a token for local development, but browser-originated upgrades are still rejected by default.
- A non-loopback bind requires authentication.
- A non-loopback bind also requires native TLS configuration unless the operator supplies an explicit `--daemon-allow-insecure-transport` acknowledgement for a trusted private network or an explicitly documented reverse-proxy deployment.
- Forwarded headers are not trusted by default and do not silently satisfy the TLS requirement.
- Native TLS key material is read only by daemon startup and is never included in child environments, logs, protocol messages, backend status, or diagnostics.

The WebSocket upgrade endpoint is exactly `/pi/workspace` with no URL user information or query parameters. Other HTTP requests and upgrade targets are rejected. Upgrade, Connection, WebSocket version, subprotocol, and key headers are validated.

### Authentication and Origin

- New clients authenticate with `Authorization: Bearer <token>`.
- Query-string tokens and URL user information are rejected. They are not retained for compatibility because URLs are rendered in diagnostics, RPC state, shell history, and proxy logs.
- A configured token must encode 32–1024 UTF-8 bytes, contain at least one non-whitespace byte, and pass startup validation. Authentication hashes both presented and configured token bytes with SHA-256, compares the fixed-size digests with `timingSafeEqual`, and separately requires the original byte lengths to match; no truncation, prefix, or normalized-length acceptance is allowed.
- Missing `Origin` is accepted for non-browser clients.
- Any present `Origin` is rejected unless it exactly matches an explicit daemon origin allowlist. Wildcard origins are not supported.
- Authentication is performed before allocating a full connection runtime.
- Authentication failures use generic responses and never reveal whether a token prefix was correct.

Server and client credentials are separate inputs. `PI_DAEMON_TOKEN` configures the server's expected token. `PI_REMOTE_TOKEN` supplies the orchestrator client's default token and is never forwarded into daemon child environments. The shared client constructor changes to `createRemoteToolOperations({ url, token })`; string-only construction is removed. Direct `--remote`, interactive `/sandbox --attach`, and the default RPC/SDK paths resolve `PI_REMOTE_TOKEN` unless their typed API supplies a token explicitly. RPC `set_remote_sandbox` gains an optional write-only `token` field; SDK/deferred configuration gains an optional `token`; neither value is returned by status APIs. Interactive commands do not accept a token argument, avoiding editor/session history leakage. A missing token against an authenticated daemon fails with an actionable message naming `PI_REMOTE_TOKEN` or the typed host API, never the token value.

Tokens and URLs containing user information or sensitive query keys are redacted in all logs, thrown errors, diagnostics, interactive status, RPC state, and snapshots. The client API stores credentials separately from the display URL. Protocol tracing is off by default and redacts authorization material when enabled.

## Multi-client isolation

A daemon process is a single-workspace, single-trust-domain service, not a multi-tenant service.

- All authenticated clients can observe and mutate the same workspace.
- Deployments requiring tenant isolation must run separate daemon processes under separate OS identities/workspace roots/tokens.
- Request IDs and cancellation ownership are per connection. One client cannot cancel or complete another client's request.
- Tool-host mutation queues are daemon-global and keyed by confined canonical path so concurrent clients cannot bypass edit/write serialization.
- Active-call, transfer, byte, output, and outbound-queue limits apply both per connection and globally.
- No conversation, active-tool selection, project-resource trust decision, LSP trust decision, or session state is accepted from or stored on behalf of a connection.
- Core tool-host and LSP configuration generations are daemon-global and operator-controlled. Every authenticated client sees the same catalog. Connection close never changes the global configuration.
- A catalog/reload generation is immutable. Stateless filesystem tool calls already acquired from a retired generation may finish; service/process-backed calls are cancelled before their old dependencies are disposed. A retired generation is disposed after its drain/cancel rule or the shutdown deadline.

## Daemon-safe tool and extension surface

The initial daemon tool surface is deliberately narrower than `AgentSession`:

- canonical workspace tools: `read`, `edit`, `write`, `grep`, `find`, and `ls`;
- canonical `bash` only when process execution is explicitly enabled;
- `lsp_*` tools only when the daemon owns an enabled validated LSP runtime;
- resource discovery/read and file transfer as non-model protocol capabilities.

The daemon does not initially load arbitrary Pi extensions. In particular it does not expose or fake:

- `AgentSession`, `Session`, conversation messages, session entries, or compaction;
- models, providers, auth storage, provider request hooks, or model selection;
- `ctx.ui`, commands, shortcuts, themes, editor state, or user-facing notifications;
- `sendMessage`, `sendUserMessage`, steering/follow-ups, shutdown of the orchestrator, or session replacement;
- user/package extension discovery;
- `load_tool`, `unload_tool`, or `subagent`.

A future daemon extension API, if implemented, must be a separately named opt-in workspace-tool contract containing only catalog registration, confined workspace operations, logging, cancellation, and bounded host lifecycle. It must not reuse `ExtensionContext` with unavailable fields. Project-origin executable extensions require an explicit trust grant from the authenticated orchestrator and an explicit daemon enablement flag. Absence of this future API is the accepted initial behavior.

Local extensions continue to run in the orchestrator. Their tool-call and tool-result hooks wrap remote calls once. Extension tools that directly use local Node APIs remain local by definition. Backend-aware tools keep the complete operation surface through a remote primitive adapter: access/read/write/mkdir/stat/readdir/glob/grep, `detectImageMimeType`, optional process exec, transfer, cancellation, backend info, and owner-only awaited disposal. `ToolOperations` evolves so every asynchronous method accepts an optional trailing operation-options object containing `signal`; canonical tools, resource loaders, and extensions propagate it.

Borrowers never receive the owning object's `dispose`. `ctx.toolOperations`, resource loaders, AgentSessions, and subagents use a typed `BorrowedToolOperations = Omit<ToolOperations, "dispose">` facade. Only `PiAgent` or a standalone SDK caller holds the owning `ToolOperations` and may dispose it. The adapter is confined and validated server-side. Primitive writes and canonical edit/write calls enter the same daemon-global canonical-path mutation queue, so extensions cannot bypass cross-client serialization.

## Project resources and prompt trust

The daemon exposes a confined primitive operations adapter, not a pre-parsed resource catalog. The orchestrator runs the existing resource loaders through that adapter and remains responsible for traversal, ignore-file reads, parsing/frontmatter validation, precedence, collisions, project trust, diagnostics, and prompt/preset inclusion. Stat, directory listing, and file reads are individually bounded and preserve daemon-native spelling; each response includes the immutable workspace identity used for provenance.

Remote ancestor discovery stops at the daemon workspace root. It never walks to the daemon filesystem root. Explicit remote resource paths outside the root fail with a source-attributed confinement diagnostic. Within the root, existing traversal order, `.gitignore`/resource ignore behavior, and `.pi`/`.agents` precedence are preserved. This intentional ancestor boundary is included in migration guidance.

Remote project resources and project-local subagent presets keep project/remote provenance and never masquerade as user resources. Project subagent preset parsing and trust confirmation remain in the orchestrator. The authenticated workspace identity, path flavor, and canonical root are included in provenance diagnostics without credentials. Resource content is treated as untrusted instructions under the same project trust policy as a local checkout.

`/reload`, session replacement, and deferred backend changes are initiated by the orchestrator. Ordinary `/reload` explicitly fetches the current catalog and reruns resource traversal; it does not reconfigure the daemon. An operator triggers daemon reload with SIGHUP or the importable server's `reload()` handle. The daemon validates a complete replacement host/LSP generation, publishes it atomically, then sends an ordered `catalog_changed` event containing the new generation and catalog hash to every handshaken connection.

Every catalog-dependent invocation carries the client's expected generation. After `catalog_changed`, the client pauses new catalog-dependent calls, fetches/verifies the new catalog, atomically swaps proxy definitions, and resumes. A request carrying an old generation is rejected before admission as `stale_generation`/`not_started`; the client may refresh and retry that request once, including a mutation, because the server proves it never began. Acquired stateless filesystem calls may finish on the old generation; `bash` and `lsp_*` calls tied to retired process/service state are cancelled with `generation_retired` using the execution-state rules below before dependencies are disposed. Failed replacement retains the last published generation and emits no change event.

The daemon never sends unsolicited prompt text or mutates the orchestrator session. Files remain a mutable workspace, so multi-call resource traversal has the same possible concurrent-change behavior as local traversal; each operation is internally consistent and bounded, but the protocol does not promise a filesystem snapshot.

## LSP ownership

For a remote workspace, LSP processes/endpoints and document synchronization are colocated with and owned by the daemon. The orchestrator suppresses its local `LspManager` for remote files and consumes only the daemon's negotiated `lsp_*` catalog and status.

LSP configuration and trust are daemon-global operator policy, never connection-scoped. Sources are limited to an explicit daemon CLI configuration (`--daemon-lsp-config`) and an optional project layer under the confined workspace enabled by `--daemon-trust-project-lsp`. The daemon does not load orchestrator global settings or accept per-client LSP reconfiguration. Project configuration cannot grant trust to itself. All relative paths and attached endpoints are interpreted in the daemon filesystem/network namespace. Host-provided orchestrator `connection` factories are unsupported; an equivalent endpoint/factory must be configured in the daemon process. Ordinary colocated servers need no agent/daemon path mapping; explicit mappings remain available only for an attached server in a different daemon-side namespace.

Any managed/spawn LSP transport additionally requires `--daemon-allow-process-exec`; `--daemon-trust-project-lsp` is not an implicit process-execution grant. Attached transports require project-LSP trust because they receive document content but do not require process-exec. Managed LSP children use the same final environment filter, owned process-tree tracking, startup/request deadlines, output bounds, reload cancellation, and graceful/forced shutdown policy as other daemon children.

Every authenticated client observes the same daemon-global LSP tools/status. A client disconnect does not start, stop, grant, or revoke LSP. Managed children stop on operator reload or daemon shutdown. Attached transports receive protocol/disconnect shutdown according to configured ownership and never receive OS signals. On reload, in-flight old-generation `lsp_*` requests are cancelled with `generation_retired` before the old manager is disposed. LSP status, diagnostics, tool availability, cancellation, and errors cross the protocol as workspace data; prompt and session effects remain local.

## File transfer

File transfer is a protocol capability rather than a model tool.

- Remote source/destination paths use the confinement policy. An upload acquires the daemon-global canonical-path mutation queue at upload start and holds it through verification, atomic publication, or cleanup, serializing against canonical edit/write and primitive write/mkdir operations.
- Chunks, total bytes, concurrent transfers, duration, idle time, and transfer-ID tombstones are bounded.
- Upload start declares exact byte length, mandatory SHA-256 digest encoded as 64 lowercase hexadecimal characters, and explicit `overwrite` (default `false`). Reusing an active or tombstoned transfer ID is rejected.
- The daemon writes a random same-directory temporary file with mode `0o600`, verifies length and digest, then atomically publishes it. A new destination receives mode `0o666 & ~umask`; overwriting preserves the existing regular file's mode. Directory/symlink/device destinations and unsupported ownership/time metadata are rejected.
- Downloads return declared length and SHA-256 before chunks and repeat verified length/digest in the terminal result. The client verifies both before publishing its local destination.
- Cancellation, disconnect, checksum failure, duplicate ID, or shutdown removes partial files and closes streams.
- Backpressure is awaited through the connection's single outbound queue.
- Local destination publication/cleanup is symmetric and remains the orchestrator client's responsibility.

### Full-output artifacts

Large canonical tool outputs are stored in a bounded daemon artifact store, not returned as host temporary paths. Remote results use `fullOutputPath: "pi-artifact://<workspace-id>/<artifact-id>"`. The remote `read` proxy and download capability recognize that URI, verify the authenticated workspace ID, and stream the artifact; filesystem tools and shell cwd do not treat it as a real path. Artifact IDs are random and connection-independent within the same single trust domain. Artifacts have configured per-file/global byte limits and TTL, are mode `0o600`, are removed on expiry or daemon shutdown, and never participate in project resource discovery. Local WorkspaceToolHost execution retains its existing local temporary-file behavior; the shared result contract permits either a local path or a `pi-artifact` URI.

## Protocol contract and rollout

The remote-workspace protocol is private and versioned independently from provider/RPC protocols. It has one authoritative TypeScript schema/validator module used by client and server.

The first message is a handshake containing protocol major/minor range and client capabilities. The server returns the selected version, immutable workspace identity/root/path flavor, catalog generation, feature limits, tool catalog/schema hashes, and authentication-safe backend metadata. No tool/resource/transfer request is accepted before a successful handshake.

Compatibility and schema-authority rules:

- major versions must match;
- a minor version is selected only from the intersection advertised by both peers;
- optional behavior is used only after explicit capability negotiation;
- the daemon catalog is authoritative for availability, while exact schema hashes prove the client's compiled canonical definitions are identical;
- unknown required capabilities, missing versions, schema-hash mismatch, or an empty version intersection fail closed before execution;
- invocation IDs are unique per connection and cannot be reused while active or during a bounded tombstone period;
- cancellation, timeout, disconnect, and late results have explicit terminal states and never trigger automatic replay of a mutating tool;
- reconnect creates a new connection and generation negotiation; in-flight mutating calls are reported `indeterminate` rather than retried.

Wire text is decoded with a fatal UTF-8 decoder. Framing violations close with WebSocket protocol error; invalid UTF-8 closes with invalid-payload status; frame/message/structural-limit violations close with message-too-large or policy status. After JSON parsing, validators enforce maximum nesting depth, object-key count, array length, string length, and total decoded size. Request schemas reject unknown fields. A syntactically valid request with an identifiable unused ID but invalid fields receives one structured `invalid_request` terminal error; three such strikes close the connection. Unknown methods receive `method_not_supported` without consuming an execution slot. Messages without a usable ID, duplicate/tombstoned IDs, and pre-handshake requests fail and close.

Every terminal error includes `executionState: "not_started" | "completed" | "indeterminate"` and a stable code. The state describes externally visible side effects, not whether CPU work began. Validation, authorization, catalog, queue-admission, and stale-generation failures are `not_started`. All file-content mutations, including primitive write, canonical edit/write, and upload, use temporary-file plus atomic-publication semantics: failure before publication is `not_started`, and confirmed publication is `completed`. A non-recursive mkdir failure is `not_started` only when the daemon confirms no directory was created; success is `completed`. Recursive mkdir and any future non-atomic mutation become `indeterminate` after the first externally visible change if they later fail, cancel, time out, reload, disconnect, or shut down. After a shell or managed LSP child is spawned, those terminal paths are likewise `indeterminate` because child side effects cannot be rolled back. A transport loss during any potentially side-effecting operation is `indeterminate` unless the server has a confirmed pre-effect failure or committed result.

If a mutating operation completed but its result exceeds an absolute wire bound, the server sends a bounded `result_too_large` with `completed` and an artifact reference when possible; the client must not retry it. During graceful shutdown/reload the server queues terminal cancellation errors before close and drains them within the outbound deadline. If delivery cannot be confirmed, the client maps every admitted side-effecting request without a terminal message to `indeterminate`; read-only requests may fail without retry unless the caller explicitly starts a new request.

The current unversioned primitive pi-daemon protocol is not supported by `pi --daemon`, and the new client does not fall back to it. There is no rolling mixed-version guarantee for the initial migration.

### Preserved user flows

The following orchestrator entry points remain supported, but use the new protocol:

- `pi --remote <url>`, with an optional client token from `PI_REMOTE_TOKEN` or the typed SDK host option;
- `pi --remote-deferred --remote-cwd <path>` followed by `/sandbox --attach ...`, using `PI_REMOTE_TOKEN` unless configured through the SDK;
- RPC `set_remote_sandbox` (including its write-only optional token), `upload_file`, and `download_file`;
- session replacement and subagents borrowing the PiAgent-owned remote workspace client.

The direct connection uses the canonical root returned by the handshake. In deferred mode, `--remote-cwd` is a required expected workspace root used before connection for stable provenance; configuration succeeds only if it equals the handshake root under daemon path-flavor comparison. It is never silently overwritten or treated as an arbitrary in-root cwd.

`PiAgent` is the concrete owner of a connected remote client or `DeferredRemoteToolOperations` holder. AgentSessions, replacement sessions, resource loaders, and subagent sessions borrow it and never call `dispose`. Session replacement preserves the owner and connection. A deferred holder owns whichever configured connection is current, awaits disposal before replacement/clear, and disposes a failed candidate. `PiAgent.dispose()` first stops and awaits borrowed sessions/subagents, then awaits final client disposal; CLI startup wraps ownership in `try/finally`.

Canonical tool output may change where the old daemon differed from local Pi; the target behavior is equivalence with local canonical tools, not compatibility with daemon bugs.

### Intentionally breaking migration

- remove the `@fleetagent/pi-daemon` workspace/package/export;
- remove the `pi-daemon` executable with no forwarding shim;
- replace launch commands with `pi --daemon`;
- reject the unversioned primitive wire protocol;
- reject query-string tokens;
- remove generic `HOST`/`PORT` aliases;
- remove unrestricted filesystem path behavior;
- require explicit process-execution opt-in;
- refuse root and insecure non-loopback operation without explicit overrides.

`PI_DAEMON_HOST`, `PI_DAEMON_PORT`, `PI_DAEMON_CWD`, `PI_DAEMON_TOKEN`, and the existing `PI_DAEMON_MAX_*` names remain as integrated server-command inputs with strict validation and the safer semantics in this ADR. `PI_REMOTE_TOKEN` is the distinct client default. Dedicated boolean/config inputs are added for process execution, root, insecure transport, origins, TLS files, environment allowlisting, and daemon LSP. Generic `HOST`/`PORT` aliases are removed. Keeping selected names is configuration continuity, not a package or protocol compatibility promise.

## Lifecycle, bounds, and shutdown

Configuration values are finite validated integers within documented ranges. The server bounds:

- pre-authentication sockets and handshake time;
- total/per-connection clients, active calls, uploads, and downloads;
- inbound frame/message size, fatal UTF-8 decoding, JSON nesting/key/array/string limits, and parser buffering;
- one per-connection outbound queue by messages and bytes;
- ordinary results, streaming updates, subprocess output, resource content, artifacts, and file-transfer chunks/total bytes;
- heartbeat/idle time, invocation time, transfer time, reload drain, and shutdown drain.

All writes, including ordinary results and errors, use the same per-connection outbound queue. Producers pause at a low-water threshold and their operation fails at a hard byte/message bound. Slow-client failure marks unfinished mutations `indeterminate`, cancels that client's active work, closes that connection, and cannot block other connections. Limit and parser errors follow the stable execution-state/error rules above; accounting slots and queued bytes are released exactly once.

On SIGINT/SIGTERM or explicit close:

1. stop accepting HTTP upgrades;
2. mark connections draining and reject new requests;
3. cancel active tool/resource/transfer work;
4. close upload/download streams and remove partial uploads;
5. perform bounded graceful shutdown for managed workspace services and process trees;
6. disconnect attached services without OS signals;
7. force-kill remaining owned process trees after the grace period;
8. close sockets and listener;
9. resolve the close handle only after accounting and owned-resource cleanup complete.

A second termination signal may force the bounded cleanup deadline but still must not expose secrets in diagnostics.

## Executable test plan

All tests use temporary directories, ephemeral loopback ports, faux tool definitions/connections, and fixture child processes. They must not require an installed language server, external endpoint, API key, provider call, or paid token.

| Decision | Planned focused coverage | Required assertions |
|---|---|---|
| Early command dispatch and startup isolation | `test/daemon-cli.test.ts` | `main(["--daemon", ...])` reaches daemon before migrations/settings/auth/PiAgent/session/UI, telemetry, update checks, or piped input; conflicting flags fail; imports have no side effects |
| Configuration, readiness, and optional dependencies | `test/daemon-cli.test.ts`, `test/workspace-tool-host.test.ts` | finite/range-checked env/CLI inputs; removed HOST/PORT aliases; redacted readiness emitted exactly once; missing fd/rg/file does not fail startup; affected catalog/error is actionable; enabled shell is preflighted |
| Responsibility boundary | `test/daemon-cli.test.ts`, `test/daemon-integration.test.ts` | no provider/model/session constructors; local agent loop emits one lifecycle; daemon receives only negotiated workspace requests |
| Host options and preparation | `test/workspace-tool-host.test.ts` | explicit host options; settings mapped only by owning process; `prepareArguments` runs locally once; daemon validates normalized arguments without rerunning preparation; prefix/image options apply once |
| Shared canonical host | `test/workspace-tool-host.test.ts` | local AgentSession and direct host catalogs/schemas/results match; truncation, mutation queues, cancellation, artifacts, and disposal match |
| Catalog/schema authority | `test/remote-workspace-protocol.test.ts` | daemon availability is authoritative; exact local schema hashes required; capability variants add/remove whole tools; unknown remote tools are not synthesized |
| Versioned and malformed-input validation | `test/remote-workspace-protocol.test.ts` | exact handshake; fatal UTF-8; depth/key/array/string/byte bounds; unknown fields; strike/close policy; version/schema/capability mismatch; duplicate/tombstoned IDs; late responses |
| Canonical remote tools | `test/daemon-integration.test.ts` | read/bash/edit/write/grep/find/ls updates and results match local fixtures; mutating calls are not replayed on disconnect |
| Primitive operations adapter | `test/daemon-integration.test.ts`, `test/extensions-runner.test.ts` | access/read/write/mkdir/stat/readdir/glob/grep/detectImageMimeType/optional exec/transfer; optional signal on every async call; non-owning borrower facade has no dispose; owner disposal awaited; validation/confinement; all mutations share one path queue |
| Path confinement | `test/daemon-security.test.ts` | relative/absolute in-root success; dot-dot, sibling-prefix, POSIX/Windows/UNC, existing symlink, new-path ancestor, transfer, artifact, LSP, and cwd escape rejection |
| Process-exec boundary and environment | `test/daemon-security.test.ts` | absent without opt-in; root refusal; confined cwd; exact cross-platform base/allowlist; final non-bypassable secret filtering including LC_API_KEY; invocation env rejection; timeout/abort/disconnect/reload/shutdown kill fixture process trees |
| Bind/auth/TLS/Origin | `test/daemon-security.test.ts` | loopback defaults; non-loopback auth/TLS requirement; explicit insecure override; fixed path/no query/header/version checks; token 32–1024-byte validation and digest+original-length comparison; bearer success; query/userinfo token and unlisted Origin rejection |
| Client credential flow | `test/main-remote.test.ts`, RPC and SDK focused tests | PI_DAEMON_TOKEN and PI_REMOTE_TOKEN remain distinct; typed token inputs work; interactive history/status/RPC never echoes token; missing-token diagnostic is actionable and redacted |
| Token redaction | `test/daemon-security.test.ts`, `test/main-remote.test.ts`, RPC focused test | no secret in readiness, URL display, diagnostics, errors, backend state, RPC responses, child env, or trace output |
| Multi-client isolation | `test/daemon-integration.test.ts` | per-connection IDs/cancellation; global file queue and operator catalog/LSP generation; per/global limits; no connection-scoped trust/state leakage; failure isolation |
| Outbound backpressure and execution-state errors | `test/daemon-transport.test.ts` | one bounded queue; low/hard water behavior; slow reader isolation; bounded completed/indeterminate errors; ordinary/stream results bounded; accounting released once |
| File transfer | `test/daemon-transfer.test.ts`, RPC focused test | mandatory lowercase SHA-256 and length; overwrite/mode policy; ID tombstones; upload holds global path queue against edit/write/mkdir; atomic publication; chunk/total/deadline bounds; cancellation/disconnect cleanup; symmetric local publication |
| Full-output artifacts | `test/workspace-tool-host.test.ts`, `test/daemon-integration.test.ts` | pi-artifact URI workspace authorization; read/download routing; byte/TTL bounds; no shell/resource traversal; expiry and shutdown cleanup |
| Project resources | `test/daemon-resources.test.ts` | primitive traversal preserves order/ignore/precedence inside root; ancestor stop and out-of-root diagnostics; provenance, collisions, malformed resources, trust, reload, backend change, no unsolicited prompt mutation |
| Extension boundary | `test/daemon-resources.test.ts`, `test/extensions-runner.test.ts` | local extensions/hooks run once; backend-aware full operations work remotely; user/package extensions never load remotely; unsupported daemon context APIs do not exist; direct Node APIs stay local |
| Colocated LSP | `test/daemon-lsp.test.ts` | operator-global CLI/project sources; project trust distinct from required process-exec grant; final env filter/process-tree/deadline/output rules; daemon path/network semantics; host-factory rejection; mapping migration; same catalog for clients; faux managed/attached lifecycle; no local duplicate |
| Subagent presets and runtime | `test/suite/agent-session-runtime.test.ts`, `test/daemon-resources.test.ts`, `test/daemon-integration.test.ts` | remote project presets traverse through primitive operations and are trusted locally; subagent LLM loop stays local; child sessions borrow the PiAgent client |
| Client ownership and remote cwd | `test/main-remote.test.ts`, `test/suite/agent-session-runtime.test.ts` | PiAgent owner versus BorrowedToolOperations facade; owner awaits disposal; sessions/subagents cannot dispose; candidate failure disposes; replacement preserves; deferred expected root equals handshake root |
| Reload generations | `test/daemon-integration.test.ts`, `test/daemon-lsp.test.ts` | SIGHUP/server.reload validates before publish; ordered catalog_changed; clients pause/fetch/hash/swap; expected generation on calls; stale_generation not_started permits one retry; stateless calls drain; process/LSP receive generation_retired before disposal; failure retains prior generation |
| Graceful shutdown and mutation state | `test/daemon-lifecycle.test.ts` | not_started/completed/indeterminate classification for atomic mutations, child spawn, cancel, timeout, reload, disconnect, and shutdown; terminal delivery attempted before close; managed versus attached cleanup; process-tree force deadline; close resolves after exact accounting |
| Packaging/removal | local-release focused smoke and tracked-reference scan | Node/Bun `pi --daemon` works; authenticated Docker uses packaged command; old unsafe Docker target is gone; no active package/bin/release/build/shim references remain |

During implementation, each listed file is run from `packages/coding-agent` with:

```bash
node ../../node_modules/vitest/dist/cli.js --run test/<focused-file>.test.ts
```

After every code-changing step:

```bash
npm run check
git diff --check
```

The final validation runs every modified focused test at least twice after formatting, checks Node and Bun local-release artifacts, exercises the packaged Docker command when Docker is available, performs tracked-reference/package/export scans, and obtains independent architecture and security reviews with no high- or medium-severity findings.

## Consequences

### Positive

- Pi has one distributed executable and one canonical tool behavior.
- Provider credentials, sessions, and prompt state remain outside the workspace daemon.
- Remote tool execution can grow through explicit capabilities without duplicating each tool in a primitive server.
- Colocated services and full-output artifacts live with the workspace that owns them.
- Security and compatibility behavior become explicit and testable.

### Costs

- Extracting `WorkspaceToolHost` is a substantial internal refactor.
- The new protocol intentionally breaks old daemons and deployment scripts.
- A daemon with process execution remains an RCE endpoint requiring OS isolation.
- Remote LSP generations and repeated project-resource traversal add lifecycle coordination.
- Dynamic daemon-side arbitrary Pi extensions are deferred until a safe context exists.

## Non-goals

- Running provider calls or an LLM loop in the daemon.
- Sharing conversation/session state with the daemon.
- Turning daemon mode into RPC mode or an interactive Pi mode.
- Making application path checks an OS sandbox.
- Supporting multiple mutually untrusted tenants in one daemon process.
- Preserving the old package, executable, unversioned protocol, query-token transport, or unrestricted paths.
- Inventing fake AgentSession, model, or UI APIs for daemon tools.
