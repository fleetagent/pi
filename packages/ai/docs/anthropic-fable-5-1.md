# Direct Anthropic Claude Fable 5.1

Select `anthropic/claude-fable-5-1` in `/model`, or start with:

```sh
pi --provider anthropic --model claude-fable-5-1
```

The model accepts text/images, with a 1,000,000-token context and up to 128,000 output tokens. Catalog prices in USD per million tokens are input 10, output 50, cache read 0.25, and cache write 12.50. Normal context-aware simple-API output budgeting still applies. Default model selection is unchanged.

## Thinking and tools

Thinking is always adaptive. In pi and the simple API, `off` (including persisted sessions and omitted reasoning) and `minimal` map to `low` effort. `low`, `medium`, `high`, and `xhigh` map to their corresponding effort values. **Off does not disable reasoning or its cost.**

The provider-specific API defaults to `high` effort; `thinkingEnabled: false` maps to `low`. Explicit effort, including `max`, is supported; token-based thinking budgets are not sent. `thinkingDisplay` controls summarized versus omitted display without disabling thinking. Temperature is omitted, and pi does not add the redundant interleaved-thinking beta.

Tool choices `auto` and `none` are supported. Forced choices `any` and `{ type: "tool", name: ... }` produce the normal stream error result before HTTP rather than silently changing the request.

## Edited history and reasoning loss

Signed thinking, including empty-text and redacted blocks, is retained on same-model replay. Direct Fable requests enable `thinking-binding-controls-2026-08-01` and set `thinking.block_binding.prefix_mismatch_behavior` to `drop_block`.

After compaction, earlier-message edits, system-prompt changes, or tool-set changes such as lazy loading, Anthropic may discard prefix-invalidated thinking. **That reasoning is lost for the continuation.** This avoids prefix-mismatch failures without stripping all reasoning client-side. Ordinary cross-model signature sanitization remains in effect. Other server errors are still reported normally; this policy does not fix every malformed history.

The recovery beta is appended after SDK header merging, preserving existing headers on normal and injected-client paths. Custom payload hooks remain responsible for any request fields they replace.

## Scope and verification

These policies target only provider `anthropic`, API `anthropic-messages`, model `claude-fable-5-1`. They do not imply support for gateways, aliases, other Fable variants, or custom endpoints overriding the direct provider.

API-key/OAuth header composition and injected clients are covered by mocked HTTP/SSE tests. No live request or OAuth subscription entitlement was verified. Access still depends on the account. Progress-update betas, turn-scoped system prompts, and per-message effort are intentionally excluded.

References: [what's new](https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1), [migration guide](https://platform.claude.com/docs/en/models/fable-5-1/migration-guide), [preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking), [effort](https://platform.claude.com/docs/en/build-with-claude/effort).
