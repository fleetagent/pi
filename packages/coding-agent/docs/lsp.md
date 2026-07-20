# Language Server Protocol

Pi can connect its `lsp_*` tools to explicitly configured Language Server Protocol (LSP) servers. Configuration controls document selection, workspace roots, transport, lifecycle, path mapping, initialization, settings, feature selection, priority, and timeouts.

Pi does not include or automatically select a TypeScript language server. Without LSP configuration, the LSP runtime and tools are disabled. Install and run the servers you configure yourself.

## Quick start: spawned TypeScript server

Install `typescript-language-server` and `typescript` in the project:

```bash
npm install --save-dev typescript-language-server typescript
```

Create `.pi/lsp.json`:

```json
{
  "servers": [
    {
      "id": "typescript",
      "selectors": [
        { "languageId": "javascript", "pattern": "**/*.js" },
        { "languageId": "javascriptreact", "pattern": "**/*.jsx" },
        { "languageId": "typescript", "pattern": "**/*.ts" },
        { "languageId": "typescriptreact", "pattern": "**/*.tsx" }
      ],
      "transport": {
        "type": "spawn",
        "command": "../node_modules/.bin/typescript-language-server",
        "args": ["--stdio"]
      },
      "lifecycle": { "type": "managed" },
      "workspace": {
        "type": "markers",
        "markers": ["tsconfig.json", "jsconfig.json", "package.json"],
        "fallback": "session"
      },
      "timeouts": {
        "connectMs": 5000,
        "initializeMs": 10000,
        "requestMs": 10000,
        "shutdownMs": 3000
      }
    }
  ]
}
```

Start Pi with the reviewed configuration file:

```bash
pi --lsp-config .pi/lsp.json
```

Paths containing a slash, such as the command above, resolve relative to the configuration file. A bare command such as `typescript-language-server` is resolved through `PATH`.

## Configuration sources and precedence

Pi resolves LSP layers from lowest to highest precedence:

1. `lsp` in `~/.pi/agent/settings.json`
2. `lsp` in `.pi/settings.json`
3. CLI input from `--lsp-config <file>` or `--no-lsp`
4. SDK or host input through `PiAgent.create({ lsp })` and LSP values returned by `resolveSessionOptions`

A settings file wraps the layer in an `lsp` property:

```json
{
  "lsp": {
    "servers": [
      {
        "id": "rust",
        "selectors": [{ "languageId": "rust", "pattern": "**/*.rs" }],
        "transport": { "type": "tcp", "host": "127.0.0.1", "port": 9257 },
        "lifecycle": { "type": "attached" },
        "workspace": { "type": "session" }
      }
    ]
  }
}
```

A file passed to `--lsp-config` contains the layer directly, as in the quick-start example.

Within a layer:

- `mode: "merge"` is the default. A higher-precedence entry replaces the complete lower-precedence server definition with the same `id`.
- `mode: "replace"` clears all lower-precedence server definitions before applying the layer.
- `{ "id": "name", "enabled": false }` removes an inherited server.
- Top-level `enabled: false` disables the resolved runtime. It does not make retained server definitions active.
- If no layer exists, LSP is disabled.

Disable LSP for one CLI invocation:

```bash
pi --no-lsp
```

Invalid JSON, invalid configuration, or an unreadable configured source fails closed: Pi reports source- and path-specific diagnostics at the source's applicable error or warning severity, disables LSP instead of using stale configuration, and continues startup. LSP configuration diagnostics are nonfatal; unrelated application errors remain fatal. `--no-lsp` is a reliable recovery path: it keeps the runtime and tools disabled and permits startup even when a lower-precedence LSP source is malformed or unreadable.

### Relative paths

Relative paths use the source that declared them:

- global settings: `~/.pi/agent`
- project settings: `.pi`
- `--lsp-config`: the configuration file's directory
- SDK inline configuration: `baseDir`, or the session working directory when omitted

This applies to path-like spawn commands, spawn `cwd`, Unix socket paths, fixed workspace roots, marker `stopAt`, and `agentRoot` path mappings. Path resolution follows the declaring source's path flavor rather than the host running Pi: Windows drive and UNC roots remain absolute on POSIX hosts, while backslashes in POSIX paths remain literal filename characters.

## Project transport trust

Every active project-settings LSP server can either execute code or receive document contents. Pi therefore blocks project-origin `spawn`, TCP, Unix socket, named-pipe, and host-factory `connection` entries unless the embedding host explicitly grants `trustProjectLspTransports: true`.

Project configuration cannot grant trust to itself. For an untrusted project layer, Pi removes active server entries and ignores top-level `enabled: true`, so the project cannot activate a globally configured transport that a lower-precedence layer left disabled. Safe `{ "id": "name", "enabled": false }`, top-level `enabled: false`, and `mode: "replace"` removal semantics remain effective. A blocked active same-ID entry does not remove the inherited server definition, but the project cannot positively activate it.

- move a trusted server definition to global settings;
- review it and pass it explicitly with `--lsp-config`; or
- in an SDK host with its own trust UI or policy, set `trustProjectLspTransports: true`.

Global settings, CLI inputs, and SDK/host layers are trusted by their source and are unchanged by this grant.

## Document selectors and server identity

Configuration is keyed by stable server `id`, independently from language IDs. One server can accept several selectors and language IDs. `languageId` is sent in `textDocument/didOpen`; `pattern` is a workspace-relative glob used for routing.

```json
{
  "id": "web-language-server",
  "selectors": [
    { "languageId": "javascript", "pattern": "**/*.js" },
    { "languageId": "typescript", "pattern": "**/*.ts" },
    { "languageId": "vue", "pattern": "**/*.vue" }
  ],
  "transport": { "type": "tcp", "host": "127.0.0.1", "port": 2087 },
  "lifecycle": { "type": "attached" },
  "workspace": { "type": "session" }
}
```

The optional selector `scheme` defaults to `file`. Selectors with the same scheme and pattern are rejected as ambiguous.

## Workspace roots

Each running instance is identified by server ID and resolved workspace root. One configured server can therefore create separate instances for nested projects.

### Session root

```json
{ "type": "session" }
```

Uses the active session working directory.

### Fixed root

```json
{ "type": "fixed", "path": "../workspace" }
```

Relative fixed paths resolve from the configuration source.

### Marker discovery

```json
{
  "type": "markers",
  "markers": ["package.json", "pyproject.toml", ".git"],
  "fallback": "session",
  "stopAt": ".."
}
```

Pi searches from the document directory upward and selects the nearest directory containing a marker. Discovery uses the active `ToolOperations` file backend, including SSH and remote backends; it does not probe the host filesystem for remote workspaces. `fallback: "session"` uses the active backend cwd when no marker is found; `fallback: "none"` leaves the document unrouted. `stopAt` limits the upward search and is source-relative when not absolute. Replacing the backend or changing its cwd invalidates cached roots and stale server instances.

## Transports and lifecycle

### Managed stdio

`spawn` starts one owned process per server/workspace instance and requires `lifecycle: { "type": "managed" }`. Pi sends protocol shutdown/exit messages, closes the connection, and terminates the child process if necessary.

```json
{
  "transport": {
    "type": "spawn",
    "command": "rust-analyzer",
    "args": [],
    "cwd": ".",
    "env": { "RUST_LOG": "warn" }
  },
  "lifecycle": { "type": "managed" }
}
```

### Attached TCP

```json
{
  "transport": { "type": "tcp", "host": "127.0.0.1", "port": 9257 },
  "lifecycle": { "type": "attached" }
}
```

Attached endpoints default to `shutdown: "disconnect"`. Pi closes only its connection and never sends an operating-system signal to a shared service process.

Use protocol shutdown only when the connection is dedicated to this Pi client and the server expects it:

```json
{
  "transport": { "type": "tcp", "host": "127.0.0.1", "port": 9257 },
  "lifecycle": { "type": "attached", "shutdown": "protocol" }
}
```

Even when a service process is shared, each Pi client generally needs a dedicated LSP connection. LSP maintains per-client initialization and document state; do not point several clients at one already-initialized byte stream. Use a listener that accepts a new connection per client, or a protocol-aware multiplexer.

### Unix socket

```json
{
  "transport": { "type": "unix", "path": "/run/user/1000/rust-analyzer.sock" },
  "lifecycle": { "type": "attached" }
}
```

Unix socket paths may be absolute or source-relative.

### Windows named pipe

```json
{
  "transport": { "type": "pipe", "path": "\\\\.\\pipe\\rust-analyzer" },
  "lifecycle": { "type": "attached" }
}
```

Named-pipe paths must be absolute Windows pipe paths such as `\\.\pipe\server`.

### Host-provided connection

A `connection` transport resolves an ID through the SDK host's `lspConnectionFactories`. Unlike built-in transports, it may declare either lifecycle:

- `managed` sends the current process ID during initialization and uses protocol shutdown before calling the handle's `close()`.
- `attached` sends a null process ID and either disconnects directly or performs explicit protocol shutdown according to `shutdown`.

For a custom factory, `LspConnectionHandle.close()` defines actual resource disposal. Pi sends operating-system signals only through its built-in managed `spawn` transport; a host factory is responsible for any owned process or connection it creates.

```json
{
  "transport": { "type": "connection", "id": "workspace-lsp" },
  "lifecycle": { "type": "attached" }
}
```

The required lifecycle combinations are: `spawn` → managed, TCP/Unix/named pipe → attached, and host-provided `connection` → managed or attached.

## Remote and container path mapping

Use `pathMappings` when agent-visible paths differ from file URIs seen by the language server. Outgoing document and workspace URIs must map through the selected route. Pi maps interpreted URI fields in incoming results when possible; unmapped locations and edit previews are labeled as unmapped rather than treated as local paths.

For example, Pi's SSH/container tool backend may expose `/workspace`, while a daemon sees the same files at `/srv/repos/app`:

```json
{
  "servers": [
    {
      "id": "remote-typescript",
      "selectors": [{ "languageId": "typescript", "pattern": "**/*.ts" }],
      "transport": { "type": "tcp", "host": "127.0.0.1", "port": 2087 },
      "lifecycle": { "type": "attached" },
      "workspace": { "type": "session" },
      "pathMappings": [
        {
          "agentRoot": "/workspace",
          "serverRootUri": "file:///srv/repos/app"
        }
      ]
    }
  ]
}
```

`agentRoot` may be relative to the configuration source. `serverRootUri` must be an absolute `file:` URI without query or fragment components. Windows drive and UNC paths are supported on every host. Windows containment and identity comparisons are case-insensitive, but mapped paths and URIs preserve the original component spelling.

Mappings must be reversible. If roots overlap, the agent and server sides must have the same parent/child relationship and relative suffix. Pi uses the longest matching root. A remote tool backend is rejected before server startup when its cwd is not covered by an explicit mapping; Pi will not guess that local and remote filesystems are identical.

## Initialization, settings, features, priority, and timeouts

A server can customize initialization and workspace settings:

```json
{
  "initializationOptions": { "provideFormatter": true },
  "settings": {
    "typescript": { "format": { "enable": true } }
  },
  "clientInfo": { "name": "my-pi-host", "version": "1.0.0" },
  "locale": "en-US",
  "trace": "off",
  "features": {
    "diagnostics": true,
    "hover": true,
    "definition": true,
    "references": true,
    "rename": false,
    "codeActions": true
  },
  "priority": 100,
  "timeouts": {
    "connectMs": 5000,
    "initializeMs": 10000,
    "requestMs": 10000,
    "shutdownMs": 3000
  }
}
```

`initializationOptions` is sent during `initialize`. `settings` supplies `workspace/configuration` responses and the initial `workspace/didChangeConfiguration` notification. Pi advertises the protocol features its tools consume, including literal code-action kinds and preferred/data support, versioned `documentChanges`, and create/rename/delete workspace resource operations. A timeout of `0` disables that timeout.

`initializeMs` bounds the complete initialize/initialized/settings handshake. `shutdownMs` is one deadline for protocol shutdown, exit, connection disposal, and handle close. Reconfiguration and shutdown still abort pending connection creation when `connectMs` is `0`; a host factory cannot delay lifecycle completion by ignoring that abort, and any handle it returns late is closed exactly once.

Feature flags can disable selected tools for a server. Pi also checks advertised server capabilities before requests. Higher numeric `priority` runs first; ties preserve server and selector declaration order.

## Multiple servers and tool behavior

Several servers may match one document:

- Hover queries by priority and uses the first non-empty successful result.
- Definitions, references, and code actions aggregate capable providers, preserve configured priority/declaration order regardless of response timing, attribute providers, and deduplicate equivalent mapped results. Definition links use `targetSelectionRange` as the canonical jump location, so they merge with equivalent plain locations.
- Diagnostics aggregate and deduplicate providers, then sort by severity, path, position, and message rather than provider priority. Wildcard provider attribution follows configured priority/declaration order and stable workspace-instance identity. An unavailable provider set is rendered differently from a successful provider reporting zero diagnostics.
- Ordinary failure of one provider does not discard successful results from others. Caller cancellation propagates through routing, startup, synchronization, unavailable-reason resolution, and requests without becoming a provider failure or fallback.
- Rename includes successful null and empty responses in consensus, refuses empty/non-empty or differing edit sets, and rejects stale or unknown `TextDocumentEdit` versions. Valid route-local versions may differ between clients without making equivalent edits conflict.
- Wildcard diagnostics retain normalized server and workspace-instance attribution.

Document synchronization is per client. Pi respects each server's advertised open/change/save/close capabilities, tracks independent versions, and replays current open documents after reconnect. Changed content observed by either a read or write advances only the successfully notified client's version; saves remain write-only. A rejected, timed-out, or cancelled synchronization notification leaves remote state indeterminate, so Pi invalidates only that exact client, discards its document versions, and performs one bounded replacement replay starting at client-local version 1. A failed save is replayed after the replacement `didOpen`; replay failure does not reconnect recursively. Other providers continue independently, and normal read/write hooks synchronize only already-running clients without starting inactive servers.

LSP enablement and model tool allowlisting are separate. An enabled runtime can synchronize a running client even when `lsp_*` tools are not exposed to the model. A disabled runtime allocates no manager or synchronization hooks.

## SDK and host configuration

Pass inline layers or files through `PiAgent`:

```typescript
import {
  InMemorySessionManager,
  PiAgent,
  createTcpConnectionFactory,
} from "@fleetagent/pi-coding-agent";

const pi = await PiAgent.create({
  cwd: process.cwd(),
  sessionManager: new InMemorySessionManager(process.cwd()),
  lsp: {
    type: "configuration",
    configuration: {
      servers: [
        {
          id: "hosted",
          selectors: [{ languageId: "typescript", pattern: "**/*.ts" }],
          transport: { type: "connection", id: "workspace-lsp" },
          lifecycle: { type: "attached" },
          workspace: { type: "session" },
        },
      ],
    },
  },
  lspConnectionFactories: {
    "workspace-lsp": createTcpConnectionFactory("127.0.0.1", 2087),
  },
});

const session = await pi.createAgentSession();
console.log(session.getLspStatus());
await pi.dispose();
```

`connection` IDs are resolved only against host-provided `lspConnectionFactories`; JSON cannot load functions. A custom factory receives the server ID, agent workspace root, mapped workspace URI, abort signal, connection timeout, and stderr callback, and returns an `LspConnectionHandle`.

Hosts can return `lsp`, factories, and project-transport trust from `resolveSessionOptions`. `PiAgent.create()` and `resolveSessionOptions` inputs are re-applied on session replacement and reload, with source-relative paths resolved for the destination cwd. An ad-hoc `session.configureLsp()` or `ctx.configureLsp()` change is runtime-only and is replaced when normal sources are re-resolved. `session.reload()` returns current source- and JSON-path-attributed LSP diagnostics. `PiAgent.diagnostics` exposes formatted diagnostics from initial session creation and refreshes them after reload or replacement. Invalid or unreadable LSP configuration produces visible, nonfatal diagnostics and an empty disabled configuration without retaining stale runtime state; severity reflects the source and failure, while unrelated application diagnostics keep their existing fatal behavior.

## Extensions and status

Normal extensions must use the single `AgentSession`-owned runtime:

```typescript
import type { ExtensionAPI } from "@fleetagent/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const status = ctx.getLspStatus();
    ctx.ui.notify(`LSP enabled: ${status.enabled}`, "info");

    if (!status.enabled) {
      await ctx.configureLsp({
        servers: [
          {
            id: "attached",
            selectors: [{ languageId: "typescript", pattern: "**/*.ts" }],
            transport: { type: "tcp", host: "127.0.0.1", port: 2087 },
            lifecycle: { type: "attached" },
            workspace: { type: "session" },
          },
        ],
      });
    }
  });
}
```

`getLspStatus()` returns the owner, resolved configuration, and per-server/instance state including workspace, endpoint, lifecycle, capabilities, diagnostics count, stderr, synchronization errors, and last transport/request errors. During `session_shutdown`, a superseded extension runner observes the latest LSP configuration and exact manager that runner owned, even if it configured LSP multiple times; the current runner continues to observe live AgentSession state.

`configureLsp()` validates one complete replacement layer, resolves relative paths from the current session cwd, and replaces the current session runtime. A later normal reload re-resolves settings, CLI, and host sources. Old extension contexts become stale after reload or session replacement and cannot reconfigure the new runtime.

`registerStandaloneLspLifecycleHandlers()` is only for extension hosts that do not use `AgentSession`. Registration is idempotent for one `ExtensionAPI`: repeated calls and `session_start` events reuse one tool set while replacing and shutting down runtime state. If that API later reports AgentSession ownership, the helper unregisters its tools, shuts down its standalone manager, and permanently delegates rather than creating a parallel runtime. Lifecycle reconfiguration is serialized, including nested work started by lifecycle callbacks, so shutdown status and disposal cannot overtake accepted reconfiguration. See [Migration](#migration) below.

## Public API exports

`core/lsp/index.ts` is the authoritative LSP API surface. Its public runtime values and types are re-exported through both the core and package-root barrels, including configuration, client, routing, synchronization, lifecycle, and transport APIs. Import public APIs from `@fleetagent/pi-coding-agent`; deep internal helpers are not part of the contract.

## Migration

This release intentionally replaces the old hardcoded and language-keyed LSP API:

- Pi no longer exports `getLspLanguageId` or `LSP_LANGUAGE_BY_EXTENSION`, and no longer supplies a built-in `typescript-language-server --stdio` command. Replace extension inference with explicit `selectors` entries whose `pattern` routes files and whose `languageId` is sent to the server, plus an explicit transport.
- The old `LspServerConfig` language-keyed command shorthand and associated manager configuration surface are removed. Use `LspConfigurationLayer`, `LspConfiguredServer`, `ResolvedLspConfiguration`, and server IDs.
- Direct `LspClient` users must provide `serverId` and an `LspConnectionFactory`; process and socket creation now live in transport factories.
- `registerLspLifecycleHandlers()` remains as a deprecated alias. Standalone extension hosts should migrate to `registerStandaloneLspLifecycleHandlers()`.
- Extensions running inside normal Pi/`AgentSession` must not register a second LSP manager. Use `ctx.getLspStatus()` and `ctx.configureLsp()`; the deprecated helper detects AgentSession ownership, declines standalone registration, and requires the context APIs.

Example conceptual migration:

```typescript
// Before: language key implied identity, routing, and a spawned command.
// const servers: LspServerConfig = { typescript: { command: "typescript-language-server", args: ["--stdio"] } };

// After: server identity, selectors, transport, lifecycle, and workspace are explicit.
const configuration = {
  servers: [
    {
      id: "typescript",
      selectors: [{ languageId: "typescript", pattern: "**/*.ts" }],
      transport: { type: "spawn" as const, command: "typescript-language-server", args: ["--stdio"] },
      lifecycle: { type: "managed" as const },
      workspace: { type: "session" as const },
    },
  ],
};
```

## Troubleshooting

### No LSP tools appear

- No configuration means LSP is disabled.
- Check for top-level `enabled: false`, `--no-lsp`, or a higher-precedence replacement/removal.
- Tool allowlisting is separate: `--tools` must include the desired `lsp_*` names if an allowlist is used.
- Read startup diagnostics for the source and JSON path that failed validation. LSP configuration diagnostics do not terminate Pi; use `--no-lsp` to recover while correcting malformed or unreadable lower-precedence sources.
### A project server is missing

Project-settings spawn and attached endpoint definitions are blocked unless the host grants `trustProjectLspTransports`. An untrusted project also cannot use `enabled: true` to activate inherited transports. Blocked active entries leave inherited same-ID definitions intact, while explicit disable/removal entries remain effective. Move the definition to trusted global settings, pass a reviewed file with `--lsp-config`, or configure host trust explicitly.

### Connection refused or initialization timed out

- Confirm the command exists or the endpoint is listening and reachable from the Pi process.
- Confirm an attached service accepts a new dedicated connection for each client.
- Increase `connectMs` or `initializeMs` for slow servers.
- Inspect `getLspStatus().servers` for `endpoint`, `state`, `lastError`, and managed-process `stderr`.

### A file is not routed

- Check that the selector pattern is relative to the resolved workspace and that `languageId` is correct for the server.
- Check marker discovery, `stopAt`, and `fallback`.
- Check disabled feature flags and advertised server capabilities.
- For several matching servers, inspect priorities and per-server failures.

### Remote files report a mapping or synchronization error

- Add an explicit mapping covering the active tool backend cwd.
- Ensure the server URI is an absolute `file:` URI and maps back to the same relative path.
- Preserve equivalent parent/child relationships for overlapping roots.
- Server-returned locations and workspace-edit previews outside configured mappings are marked as unmapped and are never interpreted as local paths or applied.

### Changes are not synchronized

- Synchronization does not start an inactive server; invoke an LSP tool first when needed.
- The server's advertised text-document sync capability controls open/change/save/close notifications.
- Inspect `synchronizationError` in status, especially after switching to an SSH, container, or daemon backend.
- Unexpected disconnects are reconnectable; the next routed request starts a replacement and replays open documents.
