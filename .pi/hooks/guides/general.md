# Resolve the reported Biome rule at its cause

## Goal

Understand the named rule and make the smallest behavior-preserving change that improves the code for the reason the rule exists.

## Preferred approach

1. Read the diagnostic, highlighted location, and rule name.
2. Inspect the surrounding implementation and relevant tests before editing.
3. Fix the underlying design or correctness issue rather than only changing syntax around the highlighted token.
4. Preserve public APIs, behavior, validation, errors, cancellation, cleanup, and ordering unless the task explicitly requires a change.
5. Run the narrowest relevant test and rerun Biome.

## Not acceptable

- Disabling the rule, adding a suppression, or weakening configuration without explicit approval.
- Type casts, `any`, non-null assertions, ignored promises, or dead code used to silence analysis.
- Arbitrary helper extraction, renaming, file movement, or abstraction that does not clarify ownership.
- Removing intentional functionality or checks.
- Fixing unrelated diagnostics in the same pass.

## Completion check

The diagnostic is gone because its underlying issue was corrected, behavior remains covered, and the resulting code is simpler to explain.
