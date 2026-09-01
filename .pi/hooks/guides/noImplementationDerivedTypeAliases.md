# Use owner-exported domain types

## Goal

Keep named contracts and function signatures stable and owned by the API that defines them instead of reconstructing them from implementation signatures with `ReturnType`, `Parameters`, or indexed member access.

## Preferred approach

1. Identify the semantic input, result, handler, or state contract represented by the alias.
2. Define and export that named type from the module that owns the API.
3. Use the named type in the owning function, method, property, or factory signature.
4. Import the type directly at consumers; do not recreate it through implementation-member traversal.
5. Use the named owner type directly in function and method signatures; wrappers such as `NonNullable<Owner["member"]>` do not create a stable contract.
6. Check dependency declarations before introducing a local contract. Use the dependency's exported type when one exists.
7. Add a type to a package's public entrypoint only when there is a genuine package-boundary consumer; an internal module export is sufficient for same-package consumers.

## Not acceptable

- Using `ReturnType`, `Parameters`, or indexed member access directly in a function signature instead of naming the owner contract.
- Wrapping `ReturnType`, `Parameters`, or indexed access in `Awaited`, `Exclude`, `NonNullable`, or another alias to disguise the derivation.
- Exporting an implementation class or unrelated internal state merely to make its nested member type reachable.
- Changing runtime behavior while repairing type ownership.
- Disabling or suppressing the rule.

## Completion check

The owning API and every consumer should refer to the same directly named contract, and changing unrelated implementation details should not redefine that contract implicitly. Run focused type checks/tests and rerun the repository checks.
