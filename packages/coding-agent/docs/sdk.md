> pi can help you use the SDK. Ask it to build an integration for your use case.

# SDK

The SDK provides programmatic access to pi's agent capabilities. Use `PiAgent` as the composition root for embedded apps, custom interfaces, automated workflows, and tests.

See [examples/sdk/](../examples/sdk/) for working examples from minimal to full control.

## Quick Start

```typescript
import { AuthStorage, InMemorySessionManager, ModelRegistry, PiAgent } from "@fleetagent/pi-coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const pi = await PiAgent.create({
  sessionManager: new InMemorySessionManager(),
  authStorage,
  modelRegistry,
});

const session = await pi.createAgentSession();

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("What files are in the current directory?");
await pi.dispose();
```

## Core Concepts

### PiAgent

`PiAgent` owns shared app services, the session lifecycle backend, and the current active `AgentSession`.

```typescript
import { InMemorySessionManager, PiAgent } from "@fleetagent/pi-coding-agent";

const pi = await PiAgent.create({
  sessionManager: new InMemorySessionManager(),
});

const session = await pi.createAgentSession();
```

The session manages agent lifecycle, message history, model state, compaction, and event streaming.

```typescript
interface AgentSession {
  // Send a prompt and wait for completion
  prompt(text: string, options?: PromptOptions): Promise<void>;

  // Queue messages during streaming
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;

  // Subscribe to events (returns unsubscribe function)
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;

  // Session info
  sessionFile: string | undefined;
  sessionId: string;

  // Model control
  setModel(model: Model): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  cycleModel(): Promise<ModelCycleResult | undefined>;
  cycleThinkingLevel(): ThinkingLevel | undefined;

  // State access
  agent: Agent;
  model: Model | undefined;
  thinkingLevel: ThinkingLevel;
  messages: AgentMessage[];
  isStreaming: boolean;

  // In-place tree navigation within the current session file
  navigateTree(targetId: string, options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }): Promise<{ editorText?: string; cancelled: boolean }>;

  // Compaction
  compact(customInstructions?: string): Promise<CompactionResult>;
  abortCompaction(): void;

  // Abort current operation
  abort(): Promise<void>;

  // Cleanup
  dispose(): void;
}
```

Most one-off session options can be passed directly to `PiAgent.create()`:

```typescript
const pi = await PiAgent.create({
  cwd: process.cwd(),
  model,
  thinkingLevel: "high",
  tools: ["read", "grep", "find", "ls"],
  authStorage,
  modelRegistry,
  settingsManager,
  resourceLoader,
  sessionManager,
});
```

Use `pi.createAgentSession({ session })` when you already have an opened or created `Session`.

### AgentSession

`AgentSession` owns active conversation behavior: prompts, message history, model state, compaction, event streaming, and in-place tree navigation.

Use `session.sessionReference` when you need the backend-neutral active session reference. For local JSONL sessions this is the session file path; for in-memory sessions it is `undefined`. `session.sessionFile` remains available as a local-file-oriented alias.

Session replacement APIs such as new-session, resume, fork, clone, and import live on `PiAgent`, not on `AgentSession`.

```typescript
interface PromptOptions {
  expandPromptTemplates?: boolean;
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";
  source?: InputSource;
  preflightResult?: (success: boolean) => void;
}
```

### SessionManager and Session

`SessionManager` handles lifecycle and discovery: create, open, continue, list, fork, and import. It returns a `Session`.

`Session` owns active persisted conversation state and tree operations.

## Prompting

```typescript
await session.prompt("What files are here?");

await session.prompt("What's in this image?", {
  images: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } }],
});

await session.prompt("After you're done, also check X", { streamingBehavior: "followUp" });
```

Use `steer()` or `followUp()` for explicit queueing during streaming:

```typescript
await session.steer("New instruction");
await session.followUp("After you're done, also do this");
```

## Events

```typescript
const unsubscribe = session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});
```

Subscriptions are attached to a specific `AgentSession`. Re-subscribe after `PiAgent` replaces the active session.

## Session Replacement

```typescript
import { LocalSessionManager, PiAgent } from "@fleetagent/pi-coding-agent";

const pi = await PiAgent.create({
  cwd: process.cwd(),
  sessionManager: new LocalSessionManager({ cwd: process.cwd() }),
});

await pi.createAgentSession();
await pi.newSession();
await pi.switchSession("/path/to/session.jsonl");
await pi.fork("entry-id");
await pi.fork("entry-id", { position: "at" });
await pi.importFromJsonl("/path/to/old-session.jsonl");
```

After replacement, use `pi.session` for the new active `AgentSession`.

## Common Configuration

### Model

```typescript
import { getModel } from "@fleetagent/pi-ai";
import { AuthStorage, ModelRegistry, PiAgent } from "@fleetagent/pi-coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const model = getModel("anthropic", "claude-opus-4-5");

const pi = await PiAgent.create({
  authStorage,
  modelRegistry,
  model,
  thinkingLevel: "medium",
});
const session = await pi.createAgentSession();
```

### API keys and OAuth

```typescript
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
authStorage.setRuntimeApiKey("anthropic", "sk-my-temp-key");

const pi = await PiAgent.create({ authStorage, modelRegistry });
await pi.createAgentSession();
```

### Resource loading

Use `DefaultResourceLoader` to override or discover extensions, skills, rules, prompt templates, themes, and context files.

```typescript
const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  systemPromptOverride: () => "You are a helpful assistant.",
});
await loader.reload();

const pi = await PiAgent.create({ resourceLoader: loader });
await pi.createAgentSession();
```

### Tools

```typescript
const pi = await PiAgent.create({
  tools: ["read", "grep", "find", "ls"],
  noTools: "builtin",
  customTools: [myTool],
});
await pi.createAgentSession();
```

Built-in tool names: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

### Settings

```typescript
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: true, maxRetries: 2 },
});

const pi = await PiAgent.create({ settingsManager });
await pi.createAgentSession();
```

## Run Modes

The SDK exports run mode utilities for building custom interfaces on top of `PiAgent`.

```typescript
import { InteractiveMode, LocalSessionManager, PiAgent, runPrintMode, runRpcMode } from "@fleetagent/pi-coding-agent";

const pi = await PiAgent.create({
  cwd: process.cwd(),
  sessionManager: new LocalSessionManager({ cwd: process.cwd() }),
});
await pi.createAgentSession();

await runPrintMode(pi, {
  mode: "text",
  initialMessage: "Hello",
  initialImages: [],
  messages: [],
});

await runRpcMode(pi);

const mode = new InteractiveMode(pi, {
  migratedProviders: [],
  modelFallbackMessage: pi.modelFallbackMessage,
  initialMessage: "Hello",
  initialImages: [],
  initialMessages: [],
});
await mode.run();
```

See [RPC documentation](rpc.md) for the JSON protocol.

## Main Exports

```typescript
PiAgent
AgentSession
AuthStorage
ModelRegistry
DefaultResourceLoader
defineTool
InMemorySessionManager
LocalSessionManager
SettingsManager
createEventBus
createCodingTools
createReadOnlyTools
createReadTool, createBashTool, createEditTool, createWriteTool
createGrepTool, createFindTool, createLsTool
```

For extension types, see [extensions.md](extensions.md).
