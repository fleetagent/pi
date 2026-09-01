# Reduce excessive parameters by modeling the call

## Goal

Make dependencies and inputs explicit without hiding them or weakening types.

## Preferred approach

1. Decide whether the function is doing more than one job. If so, separate cohesive responsibilities first.
2. Group parameters into a named options object when they belong to one operation or are commonly passed together.
3. Keep essential identity/primary input positional; place optional policy, limits, callbacks, and environment dependencies in the options object.
4. Reuse an existing domain type when it already describes the values. Otherwise introduce a narrowly named interface or type near the owning API.
5. For constructors or services with many dependencies, prefer a typed dependency object or an existing context abstraction; do not use ambient globals.
6. Update all call sites directly. Do not preserve a compatibility overload unless compatibility was explicitly requested.

## Not acceptable

- Packing unrelated values into an anonymous tuple, array, `Record<string, unknown>`, or untyped object.
- Replacing parameters with module globals, mutable singleton state, closures, or hidden service locators.
- Introducing a generic `context`, `data`, or `params` bag with unclear ownership.
- Moving the same long parameter list into a new one-call helper or constructor.
- Making required inputs optional just to simplify call sites.
- Disabling the rule or increasing its limit to avoid modeling the API.

## Completion check

The new signature should reveal the operation's primary input and a cohesive typed set of supporting values. Verify every call site and run focused tests before rerunning Biome.
