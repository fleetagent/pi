# Upstream Sync Ledger

This file tracks selective syncs from the upstream pi repository into this fork.

## Policy

- Prefer small topic ports over full upstream merges.
- Preserve fork-specific behavior: lazy tools, RPC instruction registration, remote commander daemon, streamed sandbox transfer, SSH ops, backend-aware instructions, session forking, structured responses, and paginated RPC sessions.
- Record upstream commit SHAs, fork commit SHAs, validation, and skip/defer rationale.
- Keep dependency, workflow/release, generated catalog, and broad refactor syncs in separate batches.
- Do not run `npm run build` unless explicitly requested.

## Sync: selective upstream update port

- Date: 2026-07-06
- Fork starting point: `7a21b11d`
- Upstream reference: upstream pi repository remote/checkout
- Upstream head reviewed: `647c5554`
- Common base: `60e2e433` / `v0.75.4`
- Trial full merge conflicts: 174
- Result: selective port; full merge avoided
- Final validation: `npm run check` passed
- Final status: `main...origin/main [ahead 20]`, working tree clean

### Ported / represented

| Area | Upstream reference | Fork commit | Notes |
| --- | --- | --- | --- |
| Stability fixes | mixed upstream fixes | `11288857` | Ported safe stability updates. |
| Test reporters | `47830134` | `2757172c` | Quiet reporters. |
| Startup fixes | mixed upstream fixes | `7cca1b32` | Remaining startup fixes. |
| Runtime fixes | mixed upstream fixes | `d8b2aa39` | Safe runtime updates. |
| Invalid session files | `543710f6` | `fb930fe0` | Reject invalid session files. |
| Startup display | mixed upstream fixes | `616376d1` | Startup display fixes. |
| Provider error bodies | `62fad94f` | `fa322f5b` | Surface provider HTTP error bodies. |
| Backslash escapes | `f2e9d753` | `8e2a5d93` | Preserve user backslash escapes. |
| Retry and extension events | `371adcf3`, `b91bdd5a`, related | `7328f37d` | Retry/extension/Z.AI fixes. |
| Generated model catalog | generated upstream catalog refreshes | `5ef1e4b8` | Regenerated models. |
| Generated image catalog | generated upstream catalog refreshes | `38b99b2a` | Regenerated image models. |
| `streamSimple` max tokens | `09f10595` | `56cfb7a7` | Clamp simple stream max tokens. |
| External editor setting | `5a073885` | `7efe5f35` | Added external editor setting. |
| Installer lock generation | `622eca76` | `5f1ab071` | Adapted to `@fleetagent/pi-*` package names. |
| Codex User-Agent race | `a3cc169d` | `4307990b` | Synchronous OS lookup in Node/Bun runtime guard. |
| Next-turn context refresh | `e547bb9f`, `fd6659dd` | `ad03b612` | Added context-aware prepare-next-turn flow. |
| Harness timeout validation | `85b7c247`, `cbcf4e04` | `ad03b612` | Reject invalid shell timeouts. |
| Output padding | `6564d947`, `9be55bc7` | `7b349788` | Added `outputPad` setting and UI wiring. |
| Vulnerable dependency updates | `ea65a51a`, `0680726a`, `a7f9fe68`, related | `716bea66` | Updated pinned deps and refreshed lockfiles/shrinkwrap/install-lock. |
| Bot gate hardening | `8f64353e` | `dacdb947` | Restrict gate bypasses to fixed trusted bot allowlist. |
| RPC unknown command IDs | `51f75235` | `9a3ebde4` | Return request id on unknown-command errors. |

### Already represented before or during sync

- OpenAI Responses max output token floor (`2e4ad6a0`).
- Cloudflare 524 retry (`d53b5676`).
- OAuth device-code `slow_down` handling (`8133c94d`).
- Stale Codex websocket rotation (`23d14626`).
- Bedrock Claude 5 prompt caching (`114bacf3`).
- Extra edit replacement fields (`a1b336d7`).
- pnpm self-update prune hint (`4a9c962b`).
- Abort stuck context hooks (`67575615`).
- Auth storage save failures (`f8bec25f`).
- Pre-prompt compaction no-continue (`73581ea9`).
- Shorter invalid-session errors (`0d145e89`).
- Session id for no-session runs (`e454f50b`).
- BMP image disk processing (`4cc339f5`).
- RPC `get_entries` / `get_tree` (`7ba1b6bf`).
- RPC bash `excludeFromContext` (`61babc24`).

### Skipped or deferred

| Area | Upstream references | Rationale |
| --- | --- | --- |
| Issue-analysis automation | `abe9c9d9`, `d1e72d05`, `3df11fd8`, `010e519c`, `4728706e`, `190b6459`, `7a92545b`, `fda6451a`, `647c5554` | Requires upstream-specific secrets, labels, runner policy, org/team auth, gist sharing, and `@earendil-works` package names. |
| Triage/contributor workflow churn | `783571a6`, `47d1d90a`, `226a3168`, `416c673d`, `350ac3f3`, `5641d6ba`, `1a418ad2`, related | Repo-process-specific labels and maintainer workflow. |
| Release/publish workflows | `ae50dec1`, `c3cfeac0`, `ec6311be`, `954ec998`, `f3b4e128`, `93600d89`, release-history commits | Fork package names and release policy differ; requires explicit release review. |
| Binary release/checksum sidecars | `8a7ad60f`, `31b961f2`, `3f89350c` | Only handle with requested release/binary validation. |
| Experimental orchestrator/RPC bridge | `7ece19b0`, `0563baa5`, `77f1fa62`, `9505389b`, `7f930076`, `0d02df76`, `8bc92fc9`, `52b7f774`, `9bfafc8c`, `5cb52842`, `c4e89b03`, `337de9b0`, `2f853bbc`, `122527b2` | Product-level migration conflicting with fork `packages/pi-daemon`, remote commander, RPC/session behavior. |
| Codex zstd/SSE and broad transport work | `0ac3cfe0`, `54113731`, `d0e0b84c`, `be7d5cf5`, `a36a132c`, `7c02a556`, `493efd42`, `26f1e00f`, `fc8a1559` | Transport-sensitive; overlaps divergent auth/session paths. Extract only for a targeted issue. |
| AI API/package export refactors | `ba93da9a`, `0d89a333`, `717a8f95`, `8a0903eb`, `2285f879` | Broad provider movement/export changes, partly reverted upstream, risky against fork lazy registration/API surface. |
| TUI status and entry renderers | `5d499272`, `ba10b60b` | Broad interactive/extension/session rendering changes; defer until a focused UI/extension task. |
| Broad docs/examples/release changelog history | many release/docs commits | Skip unless tied to a ported fork feature. |

### Validation performed

- Targeted AI Codex stream test passed for the Codex User-Agent race port.
- Targeted agent tests passed for next-turn context and timeout validation changes.
- `npm run check` passed after each code-changing batch and in pre-commit hooks.
- Final `npm run check` passed.
- Production audit after dependency update reported zero production vulnerabilities.

### Residual notes

- Full upstream merge remains high-risk due 174 trial conflicts.
- Remaining upstream-only commits are not literally in fork, but were classified as ported/represented, skipped, or deferred by area.
- A full audit previously still reported one low dev-only transitive `vite/node_modules/esbuild` advisory; resolving it likely needs broader Vite/Vitest updates.
