# Replace inline type imports with top-level contracts

## Goal

Make dependencies and type ownership visible at the top of each module. Expressions such as `typeof import("./theme.ts").theme` and `import("pkg").Type` hide both the dependency and the domain contract inside a signature or annotation.

## Preferred approach

1. Check whether the owner already exports a stable named type for the value or contract.
2. Add a top-level `import type` for that named type and use it directly.
3. If the value's type is part of the owner's API but has no name, define and export a domain-oriented type from the owner first.
4. Use a top-level namespace type import only when the whole module shape is genuinely the contract.
5. Keep runtime lazy-loading behavior unchanged; a type-only top-level import is erased at runtime.
6. Use dependency-exported types when available instead of recreating third-party contracts locally.

Example:

```ts
import type { Theme } from "./theme.ts";

function render(theme: Theme): string {
	return theme.fg("text", "content");
}
```

## Not acceptable

- Moving `typeof import(...)` into a type alias while retaining the inline import.
- Replacing the type with `any`, `unknown`, `object`, a cast, or a generic parameter.
- Recreating an owner contract locally when the owner can export it.
- Converting a type-only dependency into a runtime import without checking lazy-loading or platform behavior.
- Disabling or suppressing the rule.

## Completion check

The file should contain no import type expressions. Its dependencies should be declared through top-level imports, and consumers should use stable owner-defined names. Run the focused analyzer, type checks, and relevant tests.
