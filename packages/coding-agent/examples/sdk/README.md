# SDK Examples

Programmatic usage of pi-coding-agent via `PiAgent`.

`PiAgent` is the SDK composition root. It owns shared services, creates the active `AgentSession`, and manages session replacement flows.

## Examples

| File | Description |
|------|-------------|
| `01-minimal.ts` | Simplest usage with all defaults |
| `02-custom-model.ts` | Select model and thinking level |
| `03-custom-prompt.ts` | Replace or modify system prompt |
| `04-skills.ts` | Discover, filter, or replace skills |
| `05-tools.ts` | Built-in tool allowlists |
| `06-extensions.ts` | Logging, blocking, result modification |
| `07-context-files.ts` | AGENTS.md context files |
| `08-slash-commands.ts` | File-based slash commands |
| `09-api-keys-and-oauth.ts` | API key resolution, OAuth config |
| `10-settings.ts` | Override compaction, retry, terminal settings |
| `11-sessions.ts` | In-memory, persistent, continue, list sessions |
| `12-full-control.ts` | Replace everything, no discovery |
| `13-session-runtime.ts` | Manage runtime-backed session replacement |

## Running

```bash
cd packages/coding-agent
npx tsx examples/sdk/01-minimal.ts
```

## Quick Reference

```typescript
import { getModel } from "@fleetagent/pi-ai";
import {
  AuthStorage,
  DefaultResourceLoader,
  InMemorySessionManager,
  ModelRegistry,
  PiAgent,
  SettingsManager,
} from "@fleetagent/pi-coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const model = getModel("anthropic", "claude-opus-4-5");
const loader = new DefaultResourceLoader({
  systemPromptOverride: () => "You are helpful.",
});
await loader.reload();

const pi = await PiAgent.create({
  authStorage,
  modelRegistry,
  model,
  thinkingLevel: "high",
  resourceLoader: loader,
  tools: ["read", "grep", "find", "ls"],
  sessionManager: new InMemorySessionManager(),
  settingsManager: SettingsManager.inMemory(),
});

const session = await pi.createAgentSession();
session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});
await session.prompt("Hello");
await pi.dispose();
```

## Options

Most one-off session options can be passed directly to `PiAgent.create()`:

| Option | Default | Description |
|--------|---------|-------------|
| `authStorage` | `AuthStorage.create()` | Credential storage |
| `modelRegistry` | `ModelRegistry.create(authStorage)` | Model registry |
| `cwd` | `process.cwd()` | Working directory |
| `agentDir` | `~/.pi/agent` | Config directory |
| `sessionManager` | local JSONL manager | Session lifecycle backend |
| `model` | From settings/first available | Model to use |
| `thinkingLevel` | From settings/`"off"` | off, low, medium, high |
| `tools` | `[
"read", "bash", "edit", "write"]` built-ins | Allowlist tool names across built-in, extension, and custom tools |
| `customTools` | `[]` | Additional tool definitions |
| `resourceLoader` | DefaultResourceLoader | Resource loader for extensions, skills, rules, prompts, themes |
| `settingsManager` | SettingsManager.create(cwd, agentDir) | Settings source |
| `resolveSessionOptions` | undefined | Per-session override hook for model, tools, and diagnostics |

Use `pi.createAgentSession({ session })` when you need to provide an already-created or opened `Session`.
