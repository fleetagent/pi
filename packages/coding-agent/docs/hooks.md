# Hooks

Pi supports host-local automation with a Phase 0 Claude Code-compatible hook schema. Hooks are separate from Pi extensions. Native Pi settings are preferred; Claude settings remain supported for compatibility.

## Configuration and precedence

For every new session, `PiAgent` captures an immutable snapshot. Trusted user sources are discovered in this order:

1. `<agentDir>/settings.json` (native Pi settings; normally `~/.pi/agent/settings.json`)
2. `~/.claude/settings.json` (Claude compatibility)

Project sources are disabled by default. When the interactive CLI starts in a local repository containing project hooks, it asks whether to **Don't trust**, **Trust once**, or **Trust always**. Trust once applies only to the initial session snapshot. Trust always stores the canonical repository location in `<agentDir>/trusted-project-hooks.json` (normally `~/.pi/agent/trusted-project-hooks.json`) and trusts all future hook changes at that location without prompting again. `--trust-project-hooks` bypasses the prompt. Embedding hosts must explicitly set `trustProjectHooks: true`. Trusted project sources are appended in this order:

1. `<cwd>/.pi/settings.json` (native Pi settings)
2. `<cwd>/.claude/settings.json` (Claude compatibility)
3. `<cwd>/.claude/settings.local.json` (Claude compatibility local override)

Handlers are additive in source order. Exact duplicate event/matcher/handler combinations execute once, with the earlier native Pi source preferred over its Claude compatibility counterpart. `disableAllHooks` retains final-included-source precedence. Initial project discovery requires local built-in operations or a custom backend identity explicitly reporting `local`; unknown and remote startup backends fail closed. After an approved local snapshot is loaded, project/local command hooks follow the active workspace backend: host-local while local, and container/remote-local after a Docker daemon or sandbox transition. Host-injected snapshots are trusted host configuration and do not use discovery.

SDK hosts can use `CreatePiAgentOptions.hooks` to disable discovery, override the home directory used for Claude compatibility, inject a snapshot, or impose HTTP URL/environment ceilings. Native user hooks follow the active Pi `agentDir`. Injected snapshots are cloned and recursively frozen. `loadHooks()` likewise defaults to user-only discovery; callers must explicitly select project/local sources. The complete parsing/execution types and helpers are exported from `@fleetagent/pi-coding-agent/hooks`; only stable host options are exported at the package root.
Example:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write",
        "hooks": [{ "type": "command", "command": "./check-tool.sh", "timeout": 10 }]
      }
    ]
  }
}
```

## Supported events

| Event | Timing and behavior |
|---|---|
| `SessionStart` | Lazily, once, immediately before the session's first submitted prompt in interactive, print, JSON, RPC, and SDK modes. |
| `UserPromptSubmit` | On raw submitted text, before extension commands/input handlers, skill/rule/template expansion, persistence, or provider submission. Blocking rejects the submission without persisting it. Context output is inserted once as hidden model-visible custom context. |
| `PreToolUse` | After Pi's initial argument validation and before extension `tool_call`. Deny/block prevents execution. `ask` and `defer` also fail closed with distinct diagnostics because Pi has no permission engine. For Read/Edit/Write, Pi's `path` is exposed as Claude `file_path`, lexically resolved to an absolute path with the active backend's path flavor. Local POSIX `~` paths use the host home; remote or otherwise unknown homes fail closed. `updatedInput` fully replaces the arguments; `file_path` is safely mapped back to Pi `path` under the same home rule and revalidated against the active tool schema. Invalid or unsupported replacement fails closed. Deny-time additional context is included once in the blocked tool result feedback. |
| `PostToolUse` | After successful execution. Post ordering is: built-in LSP synchronization, extension `tool_result`, then this hook. It therefore observes the extension-adjusted result. |
| `PostToolUseFailure` | At the same post position when execution has failed. It cannot turn a failure into a successful execution. |
| `Stop` | After retry and auto-compaction decisions, before session settlement. Receives the final assistant text directly. Blocking or additional context inserts hidden, model-visible custom hook feedback and continues the loop. Continued calls set `stop_hook_active`. Pi normally allows at most eight consecutive hook continuations; a hook can continue beyond that while reporting decreasing `continuationProgress` as described below. |
| `StopFailure` | Emitted for a final assistant failure after retry/compaction decisions. Its output cannot continue the loop. |
| `PreCompact` / `PostCompact` | Around successful manual and automatic compaction. Trigger is `manual` or `auto`; `PostCompact` receives the saved summary. A blocking `PreCompact` cancels compaction. |
| `SessionEnd` | Once during `PiAgent` session replacement or disposal, before extension shutdown and session disposal. Default shared budget is 1.5 seconds; an explicit handler timeout may raise it, capped at 60 seconds. |

Common input fields include a stable Pi session ID, the host repository cwd, a UUID `prompt_id` for the submitted prompt and its work, and a local file-backed session reference as `transcript_path` when available (otherwise an empty string). Hooks receive no remote transcript fetch. Built-in names are normalized to Claude names (`Read`, `Bash`, `Edit`, `Write`, `WebSearch`, `Grep`, and `Glob`); custom tool names are unchanged. File-tool inputs still use the active workspace backend's lexical paths.

Matchers support match-all, exact comma/pipe alternatives, and JavaScript regular expressions. `UserPromptSubmit` and `Stop` ignore matchers, matching Claude behavior. Tool `if` conditions support the common tool/argument glob form.

## Handlers and output

Phase 0 executes synchronous `command` and `http` handlers. Matching handlers run concurrently; their results are aggregated deterministically in settings-source/order order. Command handlers receive JSON on stdin. HTTP handlers receive a JSON POST, reject redirects, and stream response bodies into the configured bound. Only structured JSON from successful HTTP responses is actionable; 2xx plain text is diagnosed and ignored. Plain text from successful command `SessionStart` and `UserPromptSubmit` handlers becomes context. Object-looking malformed stdout is diagnosed and discarded. Structured JSON supports common controls, but `hookSpecificOutput` fields apply only when `hookEventName` matches the active event. `systemMessage` is aggregated for every supported event and emitted only as host-facing diagnostic output; it is never added to model context. Supported model-context controls include:
- `additionalContext`
- `permissionDecision`, `permissionDecisionReason`, and `updatedInput` for `PreToolUse`
- `updatedToolOutput` for `PostToolUse` (built-in tools conservatively accept strings only; custom tools may use valid `{ content, details? }` shapes)
- `updatedMCPToolOutput` only for `mcp__` tools

`continue:false` is aggregate termination, not an event block. In particular, Stop settles without a continuation. Stop continuation is requested only by `decision:"block"`, exit status 2, or Stop `additionalContext`. Pre-tool context is attached once to its corresponding result; post-tool context and block reasons are returned as model feedback.

A Stop handler may set `hookSpecificOutput.continuationProgress` to a finite nonnegative number representing remaining work, where lower is better. Pi sums progress reported by matching Stop handlers. The ordinary eight-continuation limit remains when progress is absent or stalled. Beyond eight continuations, Pi keeps running while the aggregate metric establishes a new low, tolerating up to three consecutive equal or higher reports so short regressions do not terminate a converging loop. A fourth report without a new low settles the session. Progress state is local to the current prompt continuation chain and resets when the chain settles, fails, aborts, or a new prompt starts.
Exit status 2 blocks only events with compatible preflight semantics. Timeouts, process failures, malformed output, and HTTP failures are nonfatal/fail-open unless a valid blocking result was returned. Stdout/stderr are bounded to 1 MiB each by default, while every individual model-visible context/reason field is independently capped at 10,000 characters. The session owns cancellation for all hooks; replacement/disposal cancels outstanding work, and active tool hooks also compose with the agent signal. User-aborted assistant runs do not emit Stop or StopFailure.

## Interactive visibility

The interactive TUI adds a dedicated, distinctly colored card after each hook event that executed at least one matching handler. The card shows the invoked command or HTTP target, source, completion status, duration, and explicit returned model-visible prompts. Non-actionable raw stdout and stderr are not rendered; successful plain command output accepted as model context is shown as a returned prompt.

Hook cards are UI-only activity records. A bounded history is retained for the active interactive session and replayed after in-process transcript rebuilds, but it is not persisted, added to model context, emitted as ordinary conversation messages, or carried to another session. Print, JSON, and RPC modes do not render hook cards.

Use `/hooks disable` to skip subsequent hook events for the current interactive session and `/hooks enable` to resume dispatch. Disabling hooks does not cancel a handler already executing, skipped events are not replayed, and each newly created or resumed session starts enabled. The command is user-only and excluded from model-visible slash-command catalogs.

Not implemented in Phase 0: `prompt`, `agent`, and `mcp_tool` handlers; asynchronous/background handlers; prompt/agent/MCP lifecycle events; and permission events. Unsupported handlers are diagnosed and never executed.

## Security and locality

Hooks are trusted code. Interactive project settings are not discovered until the user approves them; the host-only SDK grant and `--trust-project-hooks` are explicit alternatives. Initial remote backends do not discover project settings. Review both `.pi` and compatibility `.claude` hook configuration before granting trust. **Trust always is location-based and includes arbitrary future hook changes at that repository path.**

Project/local command hooks execute through the active workspace backend. Locally they run as the host user; after a sandbox or remote transition they execute inside that backend with its cwd and sanitized backend environment. They never fall back to host execution when a non-local backend is unavailable. Project/local HTTP hooks are rejected on non-local backends because proxying them through host networking would escape isolation. User hooks and host-injected snapshots remain host-owned even when tools are remote. File-tool input paths are lexically normalized using the active backend's POSIX/Windows semantics without probing the remote filesystem.

Hook environments remove OpenTelemetry variables and Pi credential-like variables. This is defense in depth, not a general secret sandbox: locally executing hooks retain the authority of the Pi host user, while sandbox/remote project hooks retain the authority granted by that backend. Host HTTP destinations honor merged `allowedHttpHookUrls` settings policy and any host URL ceiling, require HTTPS except for literal loopback destinations, and reject redirects. HTTP header interpolation is restricted by the handler `allowedEnvVars`, merged `httpHookAllowedEnvVars` policy, and any host environment ceiling. Host and backend command execution applies bounded output, cancellation, timeout, and process-tree cleanup.
