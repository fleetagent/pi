# Name inline object types

## Goal

Give function signature shapes and nested object contracts stable domain names so they are readable, reusable, and reviewable.

## Preferred approach

1. Identify what the object represents in the function's domain or lifecycle.
2. Extract each inline object type in a function signature or named object contract into a narrowly named `interface` or `type` near the API that owns it.
3. Prefer an `interface` for an extendable object contract and a `type` when composition, unions, or mapped types are required.
4. Use role-oriented names such as `LoadSkillResult`, `SandboxStartOptions`, or `HookExecutionContext`; do not derive names mechanically from implementation order.
5. Reuse an existing type only when its semantics and ownership genuinely match.
6. Update the signature without changing runtime behavior or preserving unnecessary compatibility overloads.

## Not acceptable

- Names such as `Result1`, `Params`, `Data`, `ObjectType`, `MethodAResult`, or other context-free labels.
- Creating a type alias that merely relocates a poorly understood collection of unrelated fields.
- Using `Record<string, unknown>`, `object`, `any`, tuples, casts, or generics to hide the object shape.
- Combining unrelated parameter objects solely to reduce the number of named types.
- Exporting an internal type without an actual package-boundary consumer.
- Disabling or suppressing the rule.

## Completion check

Function signatures and named object contracts should communicate the role of every structured shape without requiring readers to parse inline object types. Run focused type checks/tests and rerun Biome.
