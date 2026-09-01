# Apply repository formatting

## Goal

Make the smallest formatting-only change required by the configured Biome formatter.

## Preferred approach

Apply Biome formatting only to the reported file, for example with `npm exec -- biome format --write <reported-file>`. Inspect that file's diff before rerunning the hook.

## Not acceptable

- Hand-formatting against the configured formatter.
- Mixing structural refactoring into a formatting fix.
- Changing formatter configuration to preserve a local preference.
- Reformatting files outside the reported scope without need.

## Completion check

The formatter reports no difference and the diff contains no behavioral change.
