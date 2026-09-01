# Reduce cognitive complexity structurally

## Goal

Make the control flow easier to understand while preserving behavior, error handling, cancellation, and ordering.

## Preferred approach

1. Identify the function's distinct responsibilities and invariants.
2. Remove unnecessary nesting with guard clauses, early returns, and explicit failure paths.
3. Replace repeated branching with a data-driven lookup only when the data model is clearer than the branches.
4. Extract a helper only when it represents a cohesive operation with a precise name, inputs, output, and independently testable contract.
5. Move behavior to an existing domain abstraction when that abstraction already owns the responsibility.
6. Add or update focused tests before changing subtle control flow.

## Not acceptable

- Splitting `methodA` into arbitrary `methodA1` and `methodA2` merely to lower the score.
- Creating one-call helpers that do not express a domain concept or remove genuine nesting.
- Moving branches into callbacks, closures, classes, or files while retaining the same tangled responsibility.
- Replacing readable control flow with clever boolean expressions, mutation, or opaque lookup tables.
- Removing validation, cancellation checks, cleanup, diagnostics, or error handling.
- Disabling the rule or increasing its threshold to avoid the refactor.

## Completion check

The resulting top-level function should read as orchestration over cohesive operations. Verify behavior with focused tests, then rerun Biome.
