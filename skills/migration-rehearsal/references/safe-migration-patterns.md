# Safe migration patterns

General guidance for fixing a migration that failed rehearsal. Always re-rehearse the fixed SQL; a pattern is a
starting point, the rehearsal is the proof. Keep the fix minimal: change only what the rehearsal showed is broken.

## Unique index / constraint on dirty data
A unique index fails if existing rows already collide (including collisions that only exist after an expression such
as `lower(col)`). Don't drop the index and don't delete rows blindly.
- Measure first: count collision groups with the same expression the index uses.
- Decide a survivor per group, deterministically (usually the **oldest** row: earliest `created_at`, then lowest `id`).
- **Re-point every foreign key** that references the losing rows to the survivor (find referencing tables via
  `describe_schema.foreign_keys`), then delete the losing rows with a `WHERE` that targets only them.
- Then create the index. Invariants to check afterwards: no orphans, child row counts unchanged, parent count dropped by
  exactly the number of losing rows.
- Mention it in the PR comment: merging accounts is a product decision; say which row survived and why.

## Renaming a column (or table)
A rename breaks every running query that uses the old name, the instant it commits. Use **expand/contract**:
1. Expand (this release): add the new column, backfill it from the old one, keep the old one. Code can move over gradually.
2. Contract (a later release, after all code uses the new name): drop the old column.
pgwarden refuses `RENAME` and `DROP COLUMN` outright. Replay the app's queries to prove nothing references a missing column.

## Adding NOT NULL
Add the column nullable, backfill, then `SET NOT NULL` (or add a `CHECK … NOT VALID` then `VALIDATE`). Adding NOT NULL
with no default to a table with rows fails.

## Indexes on big tables
`CREATE INDEX CONCURRENTLY` avoids long write locks on big tables, but it cannot run inside a transaction. pgwarden
applies the whole migration in one transaction (with `lock_timeout` 5 s, `statement_timeout` 30 s), so at this scale use a
plain `CREATE INDEX`, and note in the PR comment that a large table would need a separate, non-transactional step.

## Changing a column type
Check every value converts (`USING` expression) and that app queries still type-check. Prefer a new column + backfill if
the conversion is lossy.

## General
- One logical change per statement; no `BEGIN`/`COMMIT` in the file (the server wraps it).
- Deterministic SQL only: no `random()`, no dependence on row order without `ORDER BY`.
- The rehearsal's `effects` must be exactly what you intend prod to experience; if they surprise you, the SQL is wrong.
