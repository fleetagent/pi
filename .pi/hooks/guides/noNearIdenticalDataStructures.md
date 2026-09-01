# Review near-identical data structures

## Goal

Find interfaces whose member structures become identical after harmless representation differences are normalized. The check ignores member order, `readonly`, optional-property syntax, top-level `null`/`undefined`, whitespace, and top-level union ordering.

A finding is a design-review candidate, not proof that two contracts share ownership.

## Preferred approach

1. Inspect every candidate named in the diagnostic and identify its domain owner and package boundary.
2. If the contracts represent the same concept, keep one named contract and import it from the owning module. Export it only when there is a genuine package-boundary consumer.
3. If the structures are expected to evolve together, centralize the contract rather than maintaining synchronized copies.
4. If the structures have distinct semantics, lifecycle, validation, security, or dependency ownership, keep both and document that decision with a reasoned ignore directive directly above one declaration:

   ```ts
   // pi-ignore noNearIdenticalDataStructures: Wire payload and persisted record evolve independently.
   interface PersistedRecord {
   ```

5. Keep the reason specific enough that a later reviewer can tell when the exception is no longer valid.

## Not acceptable

- Merging contracts solely because their current fields happen to match.
- Moving an internal contract into a shared dumping-ground module.
- Renaming fields, weakening types, adding casts, or using generic bags to evade the comparison.
- Adding an ignore without a reason, or using a vague reason such as "intentional".
- Ignoring an entire file when only one domain distinction needs documentation.

## Completion check

Either reuse the contract owned by the correct domain, or retain the distinct contracts with one narrowly placed, reasoned ignore directive. Run the focused tests and rerun the check.
