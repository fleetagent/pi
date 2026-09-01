# Use immutable bindings

## Goal

Represent values that are assigned once as immutable.

## Preferred approach

Change `let` to `const` when the binding itself is never reassigned. Confirm that later code mutates only the referenced object or collection, if such mutation is intentional.

## Not acceptable

- Changing runtime behavior to force immutability.
- Copying or rebuilding an object solely to satisfy this binding-level rule.
- Confusing a constant binding with a deeply immutable value.
- Disabling the rule.

## Completion check

The binding is declared with `const`, behavior is unchanged, and Biome passes.
