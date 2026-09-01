# Remove internal barrel indirection

## Goal

Keep implementation dependencies explicit and avoid broad re-export graphs.

## Preferred approach

- Import internal symbols directly from their defining module.
- Delete an internal barrel only after all references have moved to concrete modules.
- Preserve intentional published package entrypoints. If the flagged file is a documented public API barrel, use the repository's exact-path Biome override rather than flattening the API.
- Check for import cycles and package export-map expectations before changing an entrypoint.

## Not acceptable

- Moving the same re-exports to another internal index file.
- Removing or narrowing published exports to satisfy the rule.
- Adding a broad directory override that disables the rule for implementation files.
- Duplicating implementations to avoid a direct import.

## Completion check

Internal imports identify their concrete owner, while intentional public entrypoints retain their documented API.
