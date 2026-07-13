# Streaming and String Performance Audit

This document records static-analysis findings for incremental review. Each item should be benchmarked before and after implementation. Ordinary string concatenation is not automatically quadratic because V8 may retain rope strings; the higher-risk cases below repeatedly force materialization through `join`, `split`, parsing, serialization, rendering, slicing, or `Buffer.concat`.

## Status Legend

- `open`: not yet investigated in depth
- `validated`: reproduced or benchmarked
- `planned`: remediation selected
- `done`: implementation and validation complete
- `rejected`: measured impact does not justify a change

## P0: Interactive Streaming

### PERF-001: Bash output rebuilds the complete retained stream per chunk

- Status: `open`
- Files:
  - `packages/coding-agent/src/modes/interactive/components/bash-execution.ts`
- Current behavior:
  - Every chunk is split and appended to an unbounded `outputLines` array.
  - `updateDisplay()` joins all lines, truncates the resulting string, splits it again, and rebuilds the component tree.
  - Only a bounded tail is useful for display and model context, while complete output is already available through the temporary output file.
- Risk:
  - Approximately quadratic work over a long command stream.
  - Unbounded retained memory.
  - Excessive TUI invalidation and rendering.
- Candidate remediation:
  - Keep a bounded rolling line/byte tail.
  - Preserve complete output only in the output file.
  - Track the incomplete trailing line separately.
  - Coalesce display updates to a fixed interval such as 30–60 ms.
- Preallocation assessment:
  - A preallocated byte ring buffer could work, but output is displayed as lines and UTF-8 boundaries matter.
  - A bounded chunk deque plus line metadata is likely simpler and safer.
- Validation:
  - Benchmark many small chunks and fewer large chunks with equal total output.
  - Measure retained heap, update count, CPU time, and time-to-render.

### PERF-002: Streaming Markdown reparses the entire accumulated response

- Status: `open`
- Files:
  - `packages/tui/src/components/markdown.ts`
- Current behavior:
  - `setText()` invalidates the entire render cache.
  - The next render normalizes, lexes, renders, syntax-highlights, and wraps all accumulated Markdown.
- Risk:
  - Long streamed responses repeatedly process all completed content.
  - Old code blocks are highlighted and wrapped again for every update.
- Candidate remediation:
  - Split input into completed blocks and one incomplete trailing block.
  - Cache rendered completed blocks by source, width, and theme revision.
  - Reparse only the trailing block unless an earlier block changes.
  - Coalesce token updates before invoking the parser.
- Preallocation assessment:
  - Preallocated buffers are unlikely to address the dominant parser and rendering cost.
  - Incremental block caching is the preferred approach.
- Validation:
  - Stream large prose, list-heavy Markdown, and code blocks in token-sized deltas.
  - Compare total lexer calls, highlighted bytes, render time, and allocations.

### PERF-003: TUI frames render and scan the complete conversation

- Status: `open`
- Files:
  - `packages/tui/src/tui.ts`
- Current behavior:
  - Scheduled frames render the full component tree.
  - Line resets, old/new comparisons, and Kitty image scans operate across the complete output.
- Risk:
  - Frame cost grows with conversation history even when only the final line changes.
  - Streaming a response into a long session can approach quadratic total work.
- Candidate remediation:
  - Propagate dirty component and line ranges.
  - Preserve immutable rendered line arrays for historical components.
  - Diff from known dirty bounds.
  - Update Kitty image IDs only for replaced ranges.
- Preallocation assessment:
  - Preallocated line arrays may reduce allocations but do not solve full-tree work.
  - Dirty-range rendering and structural caching should come first.
- Validation:
  - Benchmark identical streamed responses with 10, 1,000, and 10,000 historical lines.
  - Measure frame time and number of lines visited.

### PERF-004: Tool-call JSON is reparsed after every streamed delta

- Status: `open`
- Files:
  - `packages/ai/src/providers/anthropic.ts`
  - `packages/ai/src/providers/openai-completions.ts`
  - `packages/ai/src/providers/openai-responses-shared.ts`
  - `packages/agent/src/proxy.ts`
  - `packages/ai/src/utils/json-parse.ts`
- Current behavior:
  - Argument fragments extend accumulated JSON strings.
  - The complete prefix may be parsed as normal JSON, partial JSON, and repaired JSON after every delta.
- Risk:
  - Large edits and tool arguments can require quadratic parsing and allocation work.
- Candidate remediation:
  - Retain fragments and parse once when the tool call completes.
  - If partial argument previews remain necessary, parse only after a byte/time threshold.
  - Consider a genuinely incremental JSON parser for live structured previews.
  - Build repaired JSON from slices and `join` rather than character-by-character concatenation.
- Preallocation assessment:
  - A growable preallocated byte buffer could reduce fragment concatenation.
  - It will not solve repeated full-prefix parsing; throttling or incremental parsing is essential.
- Validation:
  - Benchmark 1 KiB, 100 KiB, and 1 MiB argument objects under different fragment sizes.
  - Record parse attempts, bytes reparsed, CPU time, and peak heap.

## P1: Queues and Aggregation

### PERF-005: Subagent streaming rebuilds aggregate state per message

- Status: `planned`
- Files:
  - `packages/coding-agent/src/core/tools/subagent.ts`
- Current behavior:
  - Incoming messages are serialized for retained-size accounting.
  - Display items and final output previously required scanning all retained messages on each render.
  - Parallel updates clone result arrays and recalculate status counts.
  - Complete details snapshots are emitted repeatedly.
- Implementation progress:
  - Presentation state is now derived inline once per retained message and cached by the retained message array.
  - Rendering reads precomputed display items and final output directly.
  - Eviction updates the presentation state inline so its memory remains bounded with retained messages.
  - Restored results lazily build the same cache once.
  - Parallel snapshots, update coalescing, and retained-size accounting remain to be optimized.
- Risk:
  - Verbose agents and parallel workers multiply serialization, scanning, and rendering costs.
- Candidate remediation:
  - Maintain incremental display items and final-output state per task.
  - Maintain running status counters rather than filtering all results.
  - Emit lightweight deltas during execution and a complete snapshot at completion.
  - Coalesce updates on a short timer.
  - Replace `JSON.stringify` size estimation with one bounded content traversal.
- Preallocation assessment:
  - Fixed-size result arrays are already useful for parallel mode.
  - Preallocation does not address repeated message serialization or aggregate snapshots.
- Validation:
  - Benchmark one verbose worker and four concurrent verbose workers.
  - Measure update payload bytes, serialization time, render count, and retained heap.

### PERF-006: EventStream uses `Array.shift()` and has no queue bound

- Status: `open`
- Files:
  - `packages/ai/src/utils/event-stream.ts`
- Current behavior:
  - Queued events and waiting consumers are removed with `Array.shift()`.
  - Producers can enqueue without backpressure.
- Risk:
  - Reindexing creates quadratic dequeue behavior when queues become large.
  - A slow or absent consumer can retain unbounded events.
- Candidate remediation:
  - Use arrays with head indexes and occasional compaction, or a deque.
  - Add an optional high-water mark.
  - Consider an awaitable producer API where provider reads pause under backpressure.
- Preallocation assessment:
  - A preallocated circular buffer is a strong candidate when a bounded queue is acceptable.
  - If queue growth must remain dynamic, use segmented fixed-size blocks or a head-indexed array.
- Validation:
  - Benchmark immediate consumers, delayed consumers, and abandoned consumers.
  - Measure enqueue/dequeue throughput and retained memory.

### PERF-007: Retained process output repeatedly copies a near-limit string

- Status: `open`
- Files:
  - `packages/agent/src/harness/env/nodejs.ts`
  - `packages/agent/src/harness/utils/shell-output.ts`
  - `packages/coding-agent/src/core/bash-executor.ts`
- Current behavior:
  - Once retained output reaches its cap, new chunks can rebuild and slice a string near the full cap.
  - Other rolling output implementations use repeated `Array.shift()`.
- Risk:
  - High allocation and copying rates for long-running noisy processes despite bounded final memory.
- Candidate remediation:
  - Consolidate around one bounded output accumulator.
  - Store chunks in a deque with a head offset.
  - Join only when a snapshot or final result is requested.
- Preallocation assessment:
  - A preallocated circular byte buffer is well suited to tail retention.
  - It must preserve UTF-8 decoding boundaries or store decoded string segments instead.
- Validation:
  - Benchmark millions of small chunks after the cap has been reached.

### PERF-008: Remote dirty-entry synchronization repeatedly clones queue suffixes

- Status: `open`
- Files:
  - `packages/coding-agent/src/core/session/stores/remote-session-store.ts`
- Current behavior:
  - Flushes clone the dirty queue and slice accepted prefixes.
  - A server accepting only a few entries per request causes repeated suffix copying.
- Risk:
  - Quadratic array-copying behavior under partial acceptance.
- Candidate remediation:
  - Maintain a head index into an append-only queue.
  - Send bounded batches.
  - Compact only after the consumed prefix crosses a threshold.
- Preallocation assessment:
  - A preallocated circular buffer is possible, but a head-indexed array is probably sufficient because entries are object references and append rates are moderate.
- Validation:
  - Simulate acceptance of one entry per response over a large dirty queue.

## P1: Protocol Buffers and Backpressure

### PERF-009: Daemon receive buffering copies the complete partial frame per TCP chunk

- Status: `open`
- Files:
  - `packages/pi-daemon/src/index.ts`
- Current behavior:
  - Each incoming fragment executes `Buffer.concat([connection.buffer, next])`.
- Risk:
  - Highly fragmented frames can cause quadratic copying up to the configured frame limit.
- Candidate remediation:
  - Parse the header from a small fixed buffer.
  - Once payload length is known and validated, allocate one exact-size frame buffer.
  - Copy each subsequent fragment directly into the allocated destination.
  - Alternatively, retain chunks and consume them through offsets without concatenating.
- Preallocation assessment:
  - This is the strongest preallocation candidate in the audit.
  - Exact allocation after validating the declared payload length avoids both over-allocation and repeated copying.
- Validation:
  - Deliver equal-size frames as one chunk, 1 KiB chunks, and single-byte fragments.
  - Measure bytes copied, allocations, CPU time, and peak heap.

### PERF-010: Daemon outbound responses lack connection-wide buffering control

- Status: `open`
- Files:
  - `packages/pi-daemon/src/index.ts`
- Current behavior:
  - Many `sendFrame()` callers ignore a `false` return from `socket.write()`.
  - Each concurrent exec coordinates backpressure independently.
  - Frame creation serializes JSON and copies payload data into another combined buffer.
- Risk:
  - Slow clients can accumulate queued frames.
  - Concurrent producers resume together and refill the socket queue in bursts.
  - Streaming frames incur avoidable full payload copies.
- Candidate remediation:
  - Introduce one serialized outbound queue per connection with byte high/low watermarks.
  - Pause all producers when the connection queue is full.
  - Write frame headers and payload buffers separately with socket corking or vectored writes.
  - Close clients that exceed a strict queued-byte limit.
- Preallocation assessment:
  - Reusable small header buffers may help but are secondary.
  - Do not preallocate unbounded outbound payload storage; enforce a bounded queue instead.
- Validation:
  - Use a client that stops reading while multiple exec and file operations produce output.

### PERF-011: Whole-file RPCs create multiple complete representations

- Status: `open`
- Files:
  - `packages/pi-daemon/src/index.ts`
- Current behavior:
  - `readFile` can retain the file buffer, base64 string, JSON string, encoded JSON buffer, and framed copy simultaneously.
  - `writeFile` similarly retains encoded and decoded forms.
- Risk:
  - Large files multiplied by concurrent requests can create severe transient heap spikes.
- Candidate remediation:
  - Apply strict whole-file RPC limits.
  - Route larger files through existing streamed upload/download methods.
  - Avoid concatenating frame header and payload into another complete buffer.
- Preallocation assessment:
  - Preallocation does not remove base64 and JSON amplification.
  - Protocol-level streaming is the correct solution.
- Validation:
  - Measure peak RSS for concurrent file reads near the configured limit.

## P2: Parsing and Persistence

### PERF-012: SSE parsers repeatedly slice buffers and may retain unterminated events

- Status: `open`
- Files:
  - `packages/ai/src/providers/anthropic.ts`
  - `packages/ai/src/providers/openai-codex-responses.ts`
  - `packages/agent/src/proxy.ts`
- Current behavior:
  - Some parsers repeatedly slice the unconsumed suffix.
  - Unterminated events can grow buffers indefinitely.
  - Some paths do not flush `TextDecoder` or process a final buffered event at EOF.
- Risk:
  - Quadratic copying for chunks containing many lines.
  - Memory growth for malformed streams.
  - Lost final events and incomplete stream termination.
- Candidate remediation:
  - Scan with a cursor and slice the remaining suffix once.
  - Enforce event and line byte limits.
  - Flush the decoder at EOF and process the final complete event.
- Preallocation assessment:
  - A reusable or growable byte buffer can help large events.
  - Cursor-based scanning and hard limits should be implemented first.
- Validation:
  - Cover LF, CRLF, bare CR, fragmented multibyte characters, no trailing separator, and oversized unterminated events.

### PERF-013: Compaction materializes several complete history representations

- Status: `open`
- Files:
  - `packages/coding-agent/src/core/compaction/compaction.ts`
  - `packages/coding-agent/src/core/compaction/utils.ts`
- Current behavior:
  - Compaction creates message arrays, converted messages, serialized conversation parts, joined text, and a final tagged prompt.
  - Independent split-turn summaries may run sequentially.
- Risk:
  - Multiple times the context size can exist transiently, producing GC pauses.
  - Sequential independent model calls increase compaction latency.
- Candidate remediation:
  - Serialize into bounded chunks and avoid retaining redundant intermediate forms.
  - Estimate directly from entries where possible.
  - Run independent summary requests concurrently after confirming provider/concurrency semantics.
- Preallocation assessment:
  - Preallocating one large string is difficult and may increase peak memory.
  - Chunked builders and fewer representations are safer.
- Validation:
  - Profile heap and latency for sessions near the context limit.

### PERF-014: Remote snapshot serialization blocks on complete session history

- Status: `open`
- Files:
  - `packages/coding-agent/src/core/session/remote-session-client.ts`
  - `packages/coding-agent/src/core/session/stores/remote-session-store.ts`
- Current behavior:
  - Snapshot replacement synchronously serializes complete entry arrays.
- Risk:
  - Large sessions duplicate history in memory and block interactive rendering.
- Candidate remediation:
  - Prefer append-only synchronization.
  - Stream or chunk snapshot replacement.
  - Enforce snapshot payload limits.
- Preallocation assessment:
  - Preallocation is unlikely to help because `JSON.stringify` still materializes a complete string.
- Validation:
  - Measure event-loop delay during replacement of large sessions.

### PERF-015: JSONL session loading eagerly duplicates complete files

- Status: `open`
- Files:
  - `packages/agent/src/harness/session/jsonl-storage.ts`
- Current behavior:
  - Loading retains the full file string, split line strings, parsed entries, arrays, and indexes concurrently.
- Risk:
  - High peak memory and synchronous pauses for large histories.
- Candidate remediation:
  - Parse through streaming line iteration.
  - Discard source lines after parsing.
  - Consider lazy loading or a compact index for old entries.
- Preallocation assessment:
  - Preallocation is not the primary solution; streaming parsing reduces duplicate representations.
- Validation:
  - Compare peak heap and load latency across increasing session sizes.

## P2: Editor and Rendering Utilities

### PERF-016: Editor layout recomputes complete Unicode and wrapped-line state

- Status: `open`
- Files:
  - `packages/tui/src/components/editor.ts`
  - `packages/tui/src/components/input.ts`
  - `packages/tui/src/utils.ts`
- Current behavior:
  - Renders and navigation repeatedly segment graphemes, measure widths, wrap all lines, and slice from column zero.
- Risk:
  - Large prompts make each keypress and cursor movement proportional to total prompt size.
- Candidate remediation:
  - Cache grapheme boundaries, prefix widths, and wrapped lines by logical-line identity and width.
  - Invalidate only edited lines.
  - Lay out only the visible viewport plus a small margin.
  - Reuse indexed ANSI/grapheme line representations across width and slicing operations.
- Preallocation assessment:
  - Typed arrays for grapheme offsets and prefix columns may be useful for large lines.
  - Incremental invalidation is more important than initial allocation strategy.
- Validation:
  - Benchmark editing and navigation in large single-line and multiline prompts.

### PERF-017: Undo stores complete editor snapshots without a byte budget

- Status: `open`
- Files:
  - `packages/tui/src/undo-stack.ts`
  - `packages/tui/src/components/editor.ts`
- Current behavior:
  - Undo snapshots clone complete editor state and can retain many copies of unchanged text.
- Risk:
  - Repeated edits to a large prompt can cause quadratic cumulative copying and memory retention.
- Candidate remediation:
  - Store edit deltas or persistent line structures.
  - Cap undo history by both operation count and retained bytes.
- Preallocation assessment:
  - Preallocation is not appropriate; structural sharing is the better solution.
- Validation:
  - Measure heap growth while editing a large prompt repeatedly.

### PERF-018: System-prompt assembly repeatedly appends large sections

- Status: `open`
- Files:
  - `packages/coding-agent/src/core/system-prompt.ts`
- Current behavior:
  - Context files and resource sections are appended with repeated `+=` operations whenever the prompt is rebuilt.
- Risk:
  - Potential transient copies when many large instruction files are embedded.
  - Repeated work when only the active tool set changes.
- Candidate remediation:
  - Accumulate sections in arrays and join once.
  - Cache invariant context, rules, and skills sections separately from tool-dependent sections.
- Preallocation assessment:
  - Estimating and preallocating JavaScript strings is not directly available.
  - Section arrays and caching are the practical equivalent.
- Validation:
  - Benchmark prompt rebuilds with many large project instruction files.

## Investigation Order

1. `PERF-001` Bash streaming output
2. `PERF-002` Incremental Markdown rendering
3. `PERF-003` TUI dirty-range rendering
4. `PERF-004` Incremental/throttled tool-argument parsing
5. `PERF-005` Subagent update aggregation
6. `PERF-006` EventStream queue implementation
7. `PERF-009` Preallocated daemon frame receive buffers
8. `PERF-010` Connection-wide daemon outbound queue
9. Remaining persistence, editor, and compaction items

## Benchmarking Principles

- Separate many-small-chunk behavior from few-large-chunk behavior.
- Record total bytes processed as well as elapsed time.
- Measure event-loop delay, allocations, peak heap/RSS, frame count, and rendered lines.
- Test both immediate and deliberately slow consumers.
- Preserve protocol ordering, cancellation, and backpressure semantics.
- Prefer bounded memory over merely faster unbounded accumulation.
- Verify whether V8 ropes defer string copies before replacing simple concatenation.
- Use exact-size preallocation only after validating attacker- or peer-declared lengths against hard limits.
