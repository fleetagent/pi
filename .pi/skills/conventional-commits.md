---
name: conventional-commits
description: Use when creating git commits. Ensures commit messages follow Conventional Commits with concise types, optional scopes, and imperative summaries.
---

# Conventional Commits

When the user asks you to create a commit, write the commit message using the Conventional Commits format.

## Format

```text
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

## Types

Use the most specific applicable type:

- `feat`: user-facing feature or capability
- `fix`: bug fix
- `docs`: documentation-only change
- `style`: formatting-only change with no behavior impact
- `refactor`: code restructuring with no behavior change
- `perf`: performance improvement
- `test`: tests only
- `build`: build system, dependencies, package metadata, lockfiles
- `ci`: CI workflow/configuration
- `chore`: maintenance that does not fit another type
- `revert`: revert a previous commit

## Scope

Use a short lowercase scope when it adds clarity, usually the package or subsystem:

- `agent`
- `ai`
- `coding-agent`
- `tui`
- `release`
- `deps`
- `ci`

Omit the scope if it would be vague or redundant.

## Description Rules

- Use imperative mood: `fix`, `add`, `update`, not `fixed`, `adds`, `updated`.
- Keep the first line concise, ideally under 72 characters.
- Do not end the description with a period.
- Do not use emojis.
- Mention issue close keywords only when the user asks or the change is intended to close an issue.

## Body and Footers

Add a body only when the commit needs context that is not obvious from the summary. Wrap body lines near 72 characters.

For breaking changes, include both:

```text
<type>[scope]!: <description>

BREAKING CHANGE: <migration or impact summary>
```

## Examples

```text
fix(coding-agent): route print help output to stderr
```

```text
ci(release): publish packages after release please merges
```

```text
build(deps): update shrinkwrap for fleetagent packages
```
