# Biome remediation guides

The Stop hook maps a Biome diagnostic category to the final rule segment:

- `lint/complexity/noExcessiveCognitiveComplexity` → `noExcessiveCognitiveComplexity.md`
- `lint/complexity/useMaxParams` → `useMaxParams.md`
- formatter diagnostics → `format.md`
- plugin messages prefixed with `[ruleName]` → `ruleName.md`
- project analyzer messages use the same `[ruleName]` convention, including `noExcessiveCollectionIterations.md`, `noImplementationDerivedTypeAliases.md`, `noInlineStringLiteralUnions.md`, `noInlineTypeImports.md`, and `noNearIdenticalDataStructures.md`

When no matching file exists, the hook uses `general.md`. Keep each guide prescriptive and short: explain the design goal, preferred structural fixes, unacceptable lint-silencing patterns, and completion criteria.

The hook prioritizes the file with the most remaining diagnostics, then emits its next sorted rule group and one guide per Stop continuation. All diagnostics for that rule in the selected file are listed together, even when their messages or source patterns differ; diagnostics from other files or rules remain separate. File-count ties are broken by path. After the selected group is fixed, the next Stop reruns Biome and emits the next remaining group.
