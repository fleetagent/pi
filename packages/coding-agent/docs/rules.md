# Rules

Rules are on-demand, mandatory instruction files. Use them for constraints and policies that must apply when the current task or files match the rule description.

Rules use progressive disclosure like skills: pi lists available rules in the system prompt, and the agent loads the full file only when applicable.

## Locations

Pi loads rules from:

- Global:
  - `~/.pi/agent/rules/`
  - `~/.agents/rules/`
- Project:
  - `.pi/rules/`
  - `.agents/rules/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)
- Packages: `rules/` directories or `pi.rules` entries in `package.json`
- Settings: `rules` array with files or directories
- CLI: `--rule <path>` (repeatable, additive even with `--no-rules`)

Discovery rules:

- In `~/.pi/agent/rules/` and `.pi/rules/`, direct root `.md` files are discovered as individual rules
- In all rule locations, directories containing `RULES.md` are discovered recursively
- In `~/.agents/rules/` and project `.agents/rules/`, root `.md` files are ignored

Disable discovery with `--no-rules` (explicit `--rule` paths still load).

## How Rules Work

1. At startup, pi scans rule locations and extracts names and descriptions
2. The system prompt includes available rules in XML format
3. When a task or file matches, the agent uses `read` to load the full `RULES.md`
4. Applicable rules are mandatory and constrain normal behavior and skills

Only descriptions are always in context. Full instructions load on demand.

## Rule Commands

Rules register as `/rule:name` commands when skill commands are enabled:

```bash
/rule:typescript          # Load the rule
/rule:naming-conventions use for new files
```

Arguments after the command are appended to the rule content as user text.

## Rule Structure

A rule is a directory with a `RULES.md` file. Everything else is freeform.

```text
typescript/
├── RULES.md
└── references/
    └── examples.md
```

### RULES.md Format

```markdown
---
name: typescript
description: Mandatory TypeScript rules. Load before editing *.ts or *.tsx files.
---

# TypeScript Rules

- No `any` unless absolutely necessary.
- Use top-level imports only.
```

Use relative paths from the rule directory:

```markdown
See [examples](references/examples.md).
```

## Frontmatter

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Max 64 chars. Lowercase a-z, 0-9, hyphens. Falls back to parent directory name. |
| `description` | Yes | Max 1024 chars. Defines when the rule applies. |
| `tools` | No | Tool name or YAML list of lazy tools to load automatically when the rule is loaded via `read` or `/rule:name`. |
| `disable-model-invocation` | No | When `true`, the rule is hidden from the system prompt. Users must use `/rule:name`. |

Example with associated lazy tools:

```yaml
---
name: github-review
description: Mandatory PR review rules. Load when reviewing GitHub pull requests.
tools:
  - github_get_pr
  - github_list_review_comments
---
```

When the agent loads this rule, pi loads those tools into the active tool context for the next turn.

## Description Best Practices

The description determines when the agent loads the rule. Write applicability, not capability.

Good:

```yaml
description: Mandatory TypeScript rules. Load before editing *.ts or *.tsx files.
```

Poor:

```yaml
description: TypeScript help.
```
