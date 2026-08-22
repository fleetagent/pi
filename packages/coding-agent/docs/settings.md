# Settings

Pi uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.pi/agent/settings.json` | Global (all projects) |
| `.pi/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `defaultThinkingLevel` | string | - | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `quietStartup` | boolean | `false` | Hide startup header |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `enableInstallTelemetry` | boolean | `true` | Send an anonymous install/update version ping after first install or changelog-detected updates. This does not control update checks |
| `doubleEscapeAction` | string | `"tree"` | Action for double-escape: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show terminal cursor |
| `tuiMode` | string | `"regular"` | Interactive TUI mode: `"regular"` uses the main screen and terminal scrollback; experimental `"fullscreen"` uses an application-owned viewport. `/settings` changes apply immediately and persist; `--tui-mode` overrides the startup value |
| `fullscreenExitOutput` | string | `"transcript"` | Fullscreen exit output: `"transcript"` replays the complete logical transcript, while `"resume-hint"` restores the previous main screen without replaying transcript content so any shell or launcher resume affordance remains visible. Has no effect in regular TUI mode |
| `fullscreenScrollbar` | string | `"auto"` | Fullscreen transcript scrollbar: `"auto"` shows a draggable thumb temporarily while scrolling or hovering it, `"always"` reserves the rightmost column and keeps the draggable thumb visible, and `"hidden"` disables it. Has no effect in regular TUI mode |

### Telemetry and update checks

`enableInstallTelemetry` only controls the anonymous install/update ping to `https://pi.dev/api/report-install`. Opting out of telemetry does not disable update checks; Pi can still fetch npm metadata for `@fleetagent/pi-coding-agent` to look for the latest version.

Set `PI_SKIP_VERSION_CHECK=1` to disable the Pi version update check. Use `--offline` or `PI_OFFLINE=1` to disable all startup network operations described here, including update checks, package update checks, and install/update telemetry.

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable bounded retry for transient agent-turn, compaction, and branch-summary errors |
| `retry.maxRetries` | number | `3` | Maximum additional attempts for agent turns and summary operations |
| `retry.baseDelayMs` | number | `2000` | Base delay for exponential backoff (2s, 4s, 8s) |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetries` | number | `0` | Provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs`, the request fails immediately with an informative error instead of waiting silently. Set it to `0` to disable the limit.

Keep `retry.provider.maxRetries` at `0` unless provider-level retries are explicitly needed. Provider-level attempts happen inside each agent-turn or summary attempt, so enabling both layers multiplies the possible request count. SDK/provider retries may also handle out-of-usage-limit errors before Pi sees them, which can block until provider quota resets.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"sse"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, or `"auto"` |

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show images in terminal (if supported) |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows) |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. User-scoped npm packages install under `~/.pi/agent/npm/`; project-scoped npm packages install under `.pi/npm/`. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

### Tool Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `tools` | object | `{}` | Per-tool configuration keyed by tool name |
| `tools.websearch.provider` | string | `"duckduckgo"` | Web search provider: `"duckduckgo"`, `"brave"`, or `"firecrawl"` |
| `tools.websearch.apiKey` | string | - | Provider API key. Brave env fallback: `PI_WEBSEARCH_BRAVE_API_KEY` or `BRAVE_SEARCH_API_KEY`. Firecrawl env fallback: `PI_WEBSEARCH_FIRECRAWL_API_KEY` or `FIRECRAWL_API_KEY` |
| `tools.websearch.baseUrl` | string | Provider default API URL | Override the Brave or Firecrawl endpoint for compatible/proxy APIs |

```json
{
  "tools": {
    "websearch": {
      "provider": "firecrawl",
      "apiKey": "YOUR_FIRECRAWL_API_KEY"
    }
  }
}
```

Global and project `tools` settings merge per tool name, so a project can override `tools.websearch.baseUrl` while keeping a global `tools.websearch.apiKey`. Environment variables remain supported for `websearch`; explicit settings take precedence. Firecrawl uses `POST /v2/search` with web results only.

### Docker Sandbox

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sandbox.image` | string | `"ghcr.io/fleetagent/pi-sandbox:latest"` | Docker image used by `/sandbox start` |
| `sandbox.dockerBinary` | string | `"docker"` | Docker executable |
| `sandbox.workspaceMountPath` | string | `"/workspace"` | Container path for the mounted current workspace |
| `sandbox.containerNamePrefix` | string | `"pi-sandbox"` | Prefix for generated container names |
| `sandbox.daemonPort` | number | `8787` | Container daemon port |
| `sandbox.daemonHostBind` | string | `"127.0.0.1"` | Host bind address for the published daemon port |
| `sandbox.cleanup` | string | `"stop"` | Stop behavior: `"stop"` or `"remove"` |

```json
{
  "sandbox": {
    "image": "pi-sandbox:local",
    "cleanup": "remove"
  }
}
```

Precedence for sandbox starts is command flag, then `PI_SANDBOX_*` environment variables, then project settings, then global settings, then defaults. See [Docker Sandbox](sandbox.md) for command syntax, environment variable names, and security notes.

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".pi/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, then `sessionDir` in settings.json.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Ctrl+P cycling (same format as `--models` CLI flag) |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |
| `markdown.mermaid` | string | `"streaming"` | Terminal Mermaid rendering: `"off"`, `"final"`, or `"streaming"`. Invalid values fall back to `"streaming"` |

Built-in Mermaid rendering applies only to ordinary user and assistant messages in the interactive transcript. `"final"` keeps streaming assistant fences as source until the message finishes; `"streaming"` renders best-effort partial diagrams while streaming. The built-in does not render Mermaid in thinking or custom messages, summaries, print/RPC/JSON output, or HTML export, and never changes session storage or model context.

### Language Servers

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `lsp` | object | - | Validated external language-server configuration layer |

Pi does not include a default language server. Configure spawned or attached servers explicitly:

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

Global and project `lsp` values are separate layers; project definitions override complete servers by ID. Active project-settings transports and positive top-level `enabled: true` activation are blocked unless an SDK host grants `trustProjectLspTransports`; this host-only decision cannot be enabled by project settings. Safe disable/removal entries remain effective. Malformed or unreadable LSP sources produce visible nonfatal diagnostics at the applicable error or warning severity and disable LSP; `--no-lsp` remains available as a per-invocation recovery path. CLI and host layers have higher precedence. See [Language Server Protocol](lsp.md) for spawn examples, merge/replace/disable semantics, trust, roots, transports, remote path mapping, and troubleshooting.

### Resources

These settings define where to load extensions, skills, rules, prompts, and themes from.

Paths in `~/.pi/agent/settings.json` resolve relative to `~/.pi/agent`. Paths in `.pi/settings.json` resolve relative to `.pi`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `rules` | string[] | `[]` | Local rule file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills and rules as `/skill:name` and `/rule:name` commands |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["pi-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "pi-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["pi-skills"]
}
```

## Project Overrides

Project settings (`.pi/settings.json`) override global settings. Nested objects are merged, except `lsp`, which uses the server-ID layer semantics documented in [Language Servers](#language-servers):

```json
// ~/.pi/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .pi/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
