# Compaction & Branch Summarization

LLMs have limited context windows. When conversations grow too long, pi uses compaction to summarize older content while preserving recent work. This page covers both auto-compaction and branch summarization.

**Source files** ([pi-mono](https://github.com/fleetagent/pi)):
- [`packages/coding-agent/src/core/compaction/compaction.ts`](https://github.com/fleetagent/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) - Auto-compaction logic
- [`packages/coding-agent/src/core/compaction/branch-summarization.ts`](https://github.com/fleetagent/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts) - Branch summarization
- [`packages/coding-agent/src/core/compaction/utils.ts`](https://github.com/fleetagent/pi/blob/main/packages/coding-agent/src/core/compaction/utils.ts) - Shared utilities (file tracking, serialization)
- [`packages/coding-agent/src/core/session/types.ts`](https://github.com/fleetagent/pi/blob/main/packages/coding-agent/src/core/session/types.ts) - Entry types (`CompactionEntry`, `BranchSummaryEntry`)
- [`packages/coding-agent/src/core/extensions/types.ts`](https://github.com/fleetagent/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts) - Extension event types

For TypeScript definitions in your project, inspect `node_modules/@fleetagent/pi-coding-agent/dist/`.

## Overview

Pi has two summarization mechanisms:

| Mechanism | Trigger | Purpose |
|-----------|---------|---------|
| Compaction | Context exceeds threshold, or `/compact` | Summarize old messages to free up context |
| Branch summarization | `/tree` navigation | Preserve context when switching branches |

Both use the same structured summary format and track file operations cumulatively.

### Agent-initiated range compression

The built-in `compress_context` tool lets the agent replace at least two messages in the active conversation with its own summary, independently of automatic or manual compaction. Pass `startEntryId` and `summary` to replace from that entry through the last entry **before the current user request**, or add an inclusive `endEntryId` to replace an earlier bounded range and retain later messages. The triggering user request, assistant tool call, and brief completion result stay visible after the summary. The tool call must be the only call in its assistant message; the replacement takes effect after its result is recorded. A bounded range must include complete tool-call/result groups.

When `compress_context` is active, the provider also receives model-only context metadata after each user message and after each completed batch of tool results. It gives the persisted user, assistant tool-call, and tool-result entry IDs plus approximate context utilization at each point; tool-result IDs are for lookup, not compression cut points. These notices are not shown in the TUI or saved to session history, and tool-result batches remain contiguous for provider compatibility. The estimates are recalculated for each request, may be `?` when usage is unavailable, and do not include the notices themselves. Choose a user or assistant cut point from this metadata. `session_search` defaults to entries in the current model context; use `scope: "branch"` or `scope: "all"` to retrieve older history for reference, but replaced or archived IDs are not valid cut points.
Pi appends a `compress_context` custom message with an explicit inclusive `startEntryId`/`endEntryId` replacement range. The JSONL remains append-only: context reconstruction projects the summary at the selected range, removes its original entries from model context, and preserves the later entries and their IDs in order without replaying them. A range may include the latest standard compaction summary and its retained messages; the projection respects their model-visible order. The TUI replaces the selected transcript range with a green `[compress_context]` summary and refreshes the context-utilization footer. The originals remain accessible through `session_entry_get` or `session_search` with `scope: "branch"` or `scope: "all"`; only context-scope search excludes them. Compression cannot start at a tool result or split a tool call from its results. Preserve important user instructions, decisions, and current file state in the summary.

### Optional background compression detection

Use `/compress-detection-model` to choose a separate, preferably inexpensive model. `/compress-detection-model provider/model-id` selects one directly; `/compress-detection-model clear` disables it. Selection is saved in `compressionDetectionModel` in global settings and does not switch the primary agent's model. With no selection, pi makes **no detection requests**.

At turn boundaries, a rise of at least five context percentage points **after context reaches 15%**, or ten new incoming messages (user messages and tool results, not assistant responses) since the previous check schedules a detector request, whichever happens first. The ten-message trigger also works below 15% or when context usage is unknown. After compression, the percentage trigger starts from the rebuilt context rather than zero; if usage is temporarily unknown, the first available post-compaction reading becomes the baseline. The primary agent waits for the check, read-only session lookups, and any corrective request before continuing to its next model request. A new model request also waits if a detector check from the previous run is still in flight; aborting the agent releases that wait. If context grows while a request is in flight, pi coalesces the latest observation and rechecks before the agent proceeds. The detector receives the primary agent's system prompt as reference data, the full active conversation in message order (including complete tool results and multimodal content), current active entry IDs, and the context percentage (or `unknown` if unavailable). Messages are not excerpted or truncated by the detector; choose a model with a context window and input modalities large enough for the active session. It can use `session_search` and `session_entry_get` to verify facts and cut points, with a shared limit of four read-only calls across the initial decision and corrective retry. Tool results are capped at 8,000 characters for the detector; other tools (including file mutation and `compress_context`) are not available. Detector tool calls and results are not added to the main session history.
It may answer `CONTINUE`, `COMPRESS`, or `COMPRESS startEntryId endEntryId` to suggest an inclusive bounded range. If it answers `COMPRESS` without IDs or suggests an invalid or stale range, pi gives it the validation reason and current branch IDs for one corrective model request. An unsuccessful retry keeps a range-free `COMPRESS` advisory. During an active run, a `COMPRESS` verdict is queued as a steering message for the next turn; if the run has already ended or the agent is waiting to start its first request, its advisory is attached to the next model request instead. These messages are model-visible but not saved to session history. Suggested IDs are checked again against the current branch before delivery and are **not** executed automatically. The agent decides when and what to compress. Detection and corrective requests consume tokens on the chosen model.
The footer's `D<keep>/<compress> C<n>` indicators show successful detector `CONTINUE` and `COMPRESS` verdicts across the entire session file, followed by the number of completed `compress_context` operations (including archived branches; replayed records count once). Failed, canceled, and invalid detector responses are excluded from verdict counts; detector counts remain visible after disabling detection and do not reset on context compaction or reload. Detector provider responses (model, stop reason, reported catalog cost) and accepted verdicts (including validated suggested range IDs, when available) are persisted as `compression_detection_event` custom entries. These records do not enter the primary model context; replayed records count once. `total ↑… ↓… R… W…` reports **cumulative provider-reported primary-model usage**, persisted as context-excluded ledger checkpoints across branch changes; replayed copies do not count again. Existing sessions bootstrap primary-model usage from their stored responses, but detector activity before these records were introduced cannot be recovered. `ctx ~N/window (P%)` estimates only the **current active context**, which can shrink after compression. `catalog $X (sub)` is a hypothetical catalog price on a subscription, not an additional charge. `(detect est $X total)` separately reports cumulative persisted detector catalog cost, including invalid verdicts; canceled requests without a response cannot contribute reported cost. `/session` also shows lifetime primary-model totals.

### Compression economics estimates

Before presenting a valid suggested range, pi estimates its token reduction assuming a summary one quarter the size of the selected content, and gives an approximate number of future requests needed to break even at the primary model's catalog rates. The one-time estimate budgets summary output and its first input, plus a possible cache-miss premium on the **model-visible suffix after the replaced range that was already sent to the model** (including the triggering user request). The new compression tool call and result were not previously cached and are excluded from this premium. The prefix before the range remains unchanged and is not charged a miss. A cache miss is estimated at the ordinary input rate rather than the cache-write rate: automatic caching providers such as OpenAI report newly processed tokens as input, not separate cache writes. The detector also receives the primary model's catalog rates as reference. The agent still decides whether the context is safe to summarize.

After `compress_context`, pi persists context-excluded economics entries on the active branch. The footer shows `~<tokens> fewer cumulative` across overlapping compressions, and estimated remaining cost `to break even` until subsequent primary-model requests cover the one-time estimate; only then does it show estimated **net** avoided cost. While recovery remains, `(cache ~N/new ~M turns)` compares estimated catch-up requests at the current model's cached-read and uncached input catalog rates; `?` means that rate is unavailable. Replayed responses and responses using a different model are not counted; standard compaction ends accrual for earlier summaries, although past estimates remain in the ledger. Replacing a prior compression summary ends its individual future accrual but retains its historical estimate. Branching away removes the compression economics ledger from the active branch, not the cumulative usage ledger. These are **counterfactual estimates**, not measured savings: token counts use a chars/4 heuristic, cache hits, TTL, pricing, and future requests are uncertain, and subscriptions do not imply cash savings. The session's billed assistant usage includes provider responses across archived branches once, excluding replayed copies; detector cost remains separate.

## Compaction

### When It Triggers

Auto-compaction triggers when:

```
contextTokens > contextWindow - reserveTokens
```

By default, `reserveTokens` is 16384 tokens (configurable in `~/.pi/agent/settings.json` or `<project-dir>/.pi/settings.json`). This leaves room for the LLM's response.

You can also trigger manually with `/compact [instructions]`, where optional instructions focus the summary.

### How It Works

1. **Find cut point**: Walk backwards from newest message, accumulating token estimates until `keepRecentTokens` (default 20k, configurable in `~/.pi/agent/settings.json` or `<project-dir>/.pi/settings.json`) is reached
2. **Extract messages**: Collect messages from the previous kept boundary (or session start) up to the cut point
3. **Generate summary**: Call LLM to summarize with structured format, passing the previous summary as iterative context when present
4. **Append entry**: Save `CompactionEntry` with summary and `firstKeptEntryId`
5. **Reload**: Session reloads, using summary + messages from `firstKeptEntryId` onwards

```
Before compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9     10
        ┌─────┬─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

On repeated compactions, the summarized span starts at the previous compaction's kept boundary (`firstKeptEntryId`), not at the compaction entry itself, falling back to the entry after the previous compaction if that kept entry cannot be found in the path. This preserves messages that survived the earlier compaction by including them in the next summarization pass as well. Pi also recalculates `tokensBefore` from the rebuilt session context before writing the new `CompactionEntry`, so the token count reflects the actual pre-compaction context being replaced.

### Split Turns

A "turn" starts with a user message and includes all assistant responses and tool calls until the next user message. Normally, compaction cuts at turn boundaries.

When a single turn exceeds `keepRecentTokens`, the cut point lands mid-turn at an assistant message. This is a "split turn":

```
Split turn (one huge turn exceeds budget):

  entry:  0     1     2      3     4      5      6     7      8
        ┌─────┬─────┬─────┬──────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴──────┴──────┴─────┴──────┘
                ↑                                     ↑
         turnStartIndex = 1                  firstKeptEntryId = 7
                │                                     │
                └──── turnPrefixMessages (1-6) ───────┘
                                                      └── kept (7-8)

  isSplitTurn = true
  messagesToSummarize = []  (no complete turns before)
  turnPrefixMessages = [usr, ass, tool, ass, tool, tool]
```

For split turns, pi generates two summaries and merges them:
1. **History summary**: Previous context (if any)
2. **Turn prefix summary**: The early part of the split turn

### Cut Point Rules

Valid cut points are:
- User messages
- Assistant messages
- BashExecution messages
- Custom messages (custom_message, branch_summary)

Never cut at tool results (they must stay with their tool call).

### CompactionEntry Structure

Defined in [`session/types.ts`](https://github.com/fleetagent/pi/blob/main/packages/coding-agent/src/core/session/types.ts):

```typescript
interface CompactionEntry<T = unknown> {
  type: "compaction";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
}

// Default compaction uses this for details (from compaction.ts):
interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Extensions can store any JSON-serializable data in `details`. The default compaction tracks file operations, but custom extension implementations can use their own structure.

See [`prepareCompaction()`](https://github.com/fleetagent/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) and [`compact()`](https://github.com/fleetagent/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) for the implementation.

## Branch Summarization

### When It Triggers

When you use `/tree` to navigate to a different branch, pi offers to summarize the work you're leaving. This injects context from the left branch into the new branch.

### How It Works

1. **Find common ancestor**: Deepest node shared by old and new positions
2. **Collect entries**: Walk from old leaf back to common ancestor
3. **Prepare with budget**: Include messages up to token budget (newest first)
4. **Generate summary**: Call LLM with structured format
5. **Append entry**: Save `BranchSummaryEntry` at navigation point

```
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D ─ [summary of B,C,D]
    A ───┤
         └─ E ─ F (new leaf)
```

### Cumulative File Tracking

Both compaction and branch summarization track files cumulatively. When generating a summary, pi extracts file operations from:
- Tool calls in the messages being summarized
- Previous compaction or branch summary `details` (if any)

This means file tracking accumulates across multiple compactions or nested branch summaries, preserving the full history of read and modified files.

### BranchSummaryEntry Structure

Defined in [`session/types.ts`](https://github.com/fleetagent/pi/blob/main/packages/coding-agent/src/core/session/types.ts):

```typescript
interface BranchSummaryEntry<T = unknown> {
  type: "branch_summary";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  fromId: string;      // Entry we navigated from
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
}

// Default branch summarization uses this for details (from branch-summarization.ts):
interface BranchSummaryDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Same as compaction, extensions can store custom data in `details`.

See [`collectEntriesForBranchSummary()`](https://github.com/fleetagent/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts), [`prepareBranchEntries()`](https://github.com/fleetagent/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts), and [`generateBranchSummary()`](https://github.com/fleetagent/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts) for the implementation.

## Summary Format

Both compaction and branch summarization use the same structured format:

```markdown
## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Data needed to continue]

<read-files>
path/to/file1.ts
path/to/file2.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>
```

### Message Serialization

Before summarization, messages are serialized to text via [`serializeConversation()`](https://github.com/fleetagent/pi/blob/main/packages/coding-agent/src/core/compaction/utils.ts):

```
[User]: What they said
[Assistant thinking]: Internal reasoning
[Assistant]: Response text
[Assistant tool calls]: read(path="foo.ts"); edit(path="bar.ts", ...)
[Tool result]: Output from tool
```

This prevents the model from treating it as a conversation to continue.

Tool results are truncated to 2000 characters during serialization. Content beyond that limit is replaced with a marker indicating how many characters were truncated. This keeps summarization requests within reasonable token budgets, since tool results (especially from `read` and `bash`) are typically the largest contributors to context size.

## Custom Summarization via Extensions

Extensions can intercept and customize both compaction and branch summarization. See [`extensions/types.ts`](https://github.com/fleetagent/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts) for event type definitions.

### session_before_compact

Fired before auto-compaction or `/compact`. Can cancel or provide custom summary. See `SessionBeforeCompactEvent` and `CompactionPreparation` in the types file.

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, signal } = event;

  // preparation.messagesToSummarize - messages to summarize
  // preparation.turnPrefixMessages - split turn prefix (if isSplitTurn)
  // preparation.previousSummary - previous compaction summary
  // preparation.fileOps - extracted file operations
  // preparation.tokensBefore - context tokens before compaction
  // preparation.firstKeptEntryId - where kept messages start
  // preparation.settings - compaction settings

  // branchEntries - all entries on current branch (for custom state)
  // signal - AbortSignal (pass to LLM calls)

  // Cancel:
  return { cancel: true };

  // Custom summary:
  return {
    compaction: {
      summary: "Your summary...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      details: { /* custom data */ },
    }
  };
});
```

#### Converting Messages to Text

To generate a summary with your own model, convert messages to text using `serializeConversation`:

```typescript
import { convertToLlm, serializeConversation } from "@fleetagent/pi-coding-agent";

pi.on("session_before_compact", async (event, ctx) => {
  const { preparation } = event;
  
  // Convert AgentMessage[] to Message[], then serialize to text
  const conversationText = serializeConversation(
    convertToLlm(preparation.messagesToSummarize)
  );
  // Returns:
  // [User]: message text
  // [Assistant thinking]: thinking content
  // [Assistant]: response text
  // [Assistant tool calls]: read(path="..."); bash(command="...")
  // [Tool result]: output text

  // Now send to your model for summarization
  const summary = await myModel.summarize(conversationText);
  
  return {
    compaction: {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    }
  };
});
```

See [custom-compaction.ts](../examples/extensions/custom-compaction.ts) for a complete example using a different model.

### session_before_tree

Fired before `/tree` navigation. Always fires regardless of whether user chose to summarize. Can cancel navigation or provide custom summary.

```typescript
pi.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;

  // preparation.targetId - where we're navigating to
  // preparation.oldLeafId - current position (being abandoned)
  // preparation.commonAncestorId - shared ancestor
  // preparation.entriesToSummarize - entries that would be summarized
  // preparation.userWantsSummary - whether user chose to summarize

  // Cancel navigation entirely:
  return { cancel: true };

  // Provide custom summary (only used if userWantsSummary is true):
  if (preparation.userWantsSummary) {
    return {
      summary: {
        summary: "Your summary...",
        details: { /* custom data */ },
      }
    };
  }
});
```

See `SessionBeforeTreeEvent` and `TreePreparation` in the types file.

## Settings

Configure compaction in `~/.pi/agent/settings.json` or `<project-dir>/.pi/settings.json`:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable auto-compaction |
| `reserveTokens` | `16384` | Tokens to reserve for LLM response |
| `keepRecentTokens` | `20000` | Recent tokens to keep (not summarized) |

Disable auto-compaction with `"enabled": false`. You can still compact manually with `/compact`.
