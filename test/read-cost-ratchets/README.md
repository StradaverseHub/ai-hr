# Read-cost ratchets (ADR 0181 standard)

These allowlists record the old read patterns that were in `alpha` at release 9, when the owner made ADR 0181 the
standard for new work (25 November 2026). The rules are in `docs/architecture/FUTURE-BUILD-CONTRACT.md`
("Database read cost"). The checks are `test/read-cost-ratchets.test.ts` (no database) and
`test/read-cost-policy-authority.test.ts` (the migrated test database). The scanners are in
`test/helpers/read-cost-ratchet.ts`.

Every list only shrinks:

- A new use fails. The failure lists each new site with its file and line. Do not add an entry. Change the code to
  the standard pattern instead.
- A removed use also fails, until the list is lowered. The failure prints the replacement JSON. Check it in with the
  conversion, so the win is locked in.

| File | What one entry counts | How to shrink it |
|---|---|---|
| `policy-authority.json` | `schema.table \| policy \| function`: an installed policy that calls a `SECURITY DEFINER` or plpgsql function with a column of the row, so the call runs for every row | Move that table family to precomputed access (7210/7240/7280 pattern) through legacy → shadow → precomputed. Once the old text is gone from the policy, remove the entries. |
| `policy-rewrite-migrations.json` | A migration, already applied, that changed policy text or redefined a function a policy calls, with no registered timing test | Never shrinks in practice, because applied migrations are immutable. New migrations of this kind go in `policy-rewrite-evidence.json` with their timing test. |
| `policy-rewrite-evidence.json` | Not an allowlist. It maps a migration to the test that times its old and new rule text with `EXPLAIN ANALYZE` on a scale fixture | Add one entry per new migration of that kind. |
| `page-by-number.json` | `file \| pattern` → count: `parsePageQuery`, `pageState` (exact total), `paginateRows` (in-memory page) and `OFFSET` | Convert the list to `parseKeysetPageQuery` / `keysetSlice` / `keysetPageState` / `cappedTotal`, as `listEmployeesDirectoryPage` and `auditEventsPage` do. |
| `layout-revalidate.json` | `file` → count of `revalidatePath(…, 'layout')` | Move the form to `ActionNavigateForm` and return the next address (`lib/action-navigation.ts`). |
| `request-loops.json` | `file` → count of loops or array callbacks that make a data call for each company or row, in `app/`, `components/` and the mobile API | Read the set once (one statement with an id array) and group it in memory. Hotspots: `app/admin/personnel/import/page.tsx` reads four catalogues once per company on every load. Also in Approvals: `app/approvals/leave-recommendations.tsx` reads one recommendation per pending request (capped by `RECOMMEND_ON_OPEN`), and `app/approvals/page.tsx` reads manager reviews once per own employment. |
| `unbudgeted-routes.json` | A `page.tsx` path or a server action `file#name` with no measured read budget | Measure it with `observeStatements` on the scale fixture, assert its budget, and register it in `read-budget-registry.json` (remove it from this list in the same PR). |
| `read-budget-registry.json` | Not an allowlist. It maps a page or action to the test that measures it against recorded budgets | Add an entry. Budgets only go down. A raised budget needs an ADR note. |

Regenerating a list from scratch is never the way to make a check pass. The only edits are removals that the
failure message asks for.
