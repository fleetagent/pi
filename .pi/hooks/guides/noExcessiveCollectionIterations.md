# Reduce avoidable collection iterations

## Goal

Prevent accidental superlinear work and unnecessary repeated full-array passes inside one function while keeping the implementation readable and behaviorally equivalent.

The check reports candidates such as nested traversal over outer-invariant collections or bounds, repeated linear lookups over invariant data, nested `map`/`filter`/`find`-style traversals, and adjacent repeated `map` or `filter` calls. Item-dependent child collections and distinct `filter().map()` stages are not reported.

## Preferred approach

1. Confirm the actual collection sizes, ownership, and required ordering.
2. Move invariant collection work outside loops and callbacks.
3. Build a `Set` or `Map` once when membership or keyed lookup is repeated.
4. Replace accidental nested scans with an indexed or single-pass algorithm.
5. Combine repeated collection passes only when the combined operation remains easier to understand.
6. Preserve stable ordering, duplicate handling, side effects, short-circuit behavior, and error propagation.
7. Add a focused regression or performance-oriented test for nontrivial changes.

## Intentional pairwise work

Some algorithms are inherently pairwise, operate on strictly bounded inputs, or are clearer as a small number of sequential passes. Keep those implementations and add a specific directive directly above the function:

```ts
// pi-ignore noExcessiveCollectionIterations: Grid dimensions are validated to at most 4x4.
function evaluateGrid(grid: Cell[][]): Score {
```

The reason must state the bound or algorithmic requirement that makes the cost acceptable.

## Not acceptable

- Replacing clear pipelines with a stateful `reduce` solely to silence the check.
- Caching mutable data without preserving invalidation semantics.
- Changing output order, duplicate behavior, callback side effects, or short-circuiting.
- Moving the same nested traversal into an unexamined helper.
- Adding an ignore without a concrete bound or algorithmic reason.
- Disabling the analyzer globally.

## Completion check

Verify the expensive operation is removed, indexed, bounded with a reason, or intentionally retained. Run focused tests and the analyzer again.
