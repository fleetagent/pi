# Name string-literal unions

## Goal

Give finite string-valued domains a stable, descriptive type while retaining string-literal runtime values.

## Preferred approach

1. Identify the domain represented by the literals.
2. Extract the complete union to a narrowly named type alias near the API that owns it:

   ```ts
   type WorkspaceAvailability = "remote" | "unavailable";
   ```

3. Use that named type for interface properties, class properties, parameters, and return types.
4. Export it only when a genuine package-boundary consumer needs it.
5. Reuse an existing named union only when its semantics and ownership match.

## Not acceptable

- Replacing the union with an `enum`; the contract must remain a string-literal union type.
- Widening the type to `string`.
- Hiding the union behind `any`, `unknown`, casts, generics, or an unrelated type.
- Giving it a context-free name such as `Status`, `Value`, `KindType`, or `StringUnion` when a domain name is available.
- Disabling or suppressing the rule.

## Completion check

The checked property, parameter, or return annotation should reference a domain-oriented named string-literal union, with runtime behavior unchanged. Run focused type checks/tests and rerun the custom check.
