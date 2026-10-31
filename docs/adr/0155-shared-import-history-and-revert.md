# ADR-0155 — Shared personnel import history and all-or-nothing revert

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

- **Date:** 2026-10-29
- **Status:** Proposed with board item c4055300 (approved plan). The same history and revert design is part of the
  approved plans for 0db97f14 (Bank & Statutory), 524303d9 ("Everything — new employees") and ac6645ec (movement
  import); those items are built separately on this foundation. Accepted is not merged, tested, installed or released.
- **Related:** ADR-0006 (domain events), ADR-0135 (configurable access), ADR-0130 (movement workbook admission),
  migration 0602 (Payroll history import log and revert, the pattern followed here), migration 0341
  (`employee_import_run`).
- **Migration:** `0675_import_attempt_history` (journal position provisional until integration).

## 1. Context

Four personnel imports need the same thing: every upload recorded with its file, who imported it, for which
companies, what each record held before and after, and a Revert that is safe. Payroll history import (0602)
already does this for payroll with an immutable attempt, the original bytes plus sha256, append-only events,
a preview hash, `FOR UPDATE` and a once-only revert index. Personnel imports today record only
`employee_import_run` (0341): a deletable read model with no kind, no source file, no before values, no events
and tenant-wide visibility.

## 2. Decision

1. **New shared tables, not an extension of `employee_import_run`.** `import_attempt` (kind, original file up to
   10 MB with a checked sha256, company ids, the kind's sealed preview plan, creator, operation key),
   `import_attempt_item` (one row per unit the kind writes: company, employment, kind-specific `before`/`after`
   JSON, `applied|failed`, errors) and `import_attempt_event` (`previewed|confirmed|failed|reverted|revert_failed`,
   actor, reason, detail). All three are append-only (trigger), with exact grants (SELECT, INSERT, and
   `UPDATE(id)` on the attempt only so writers can `SELECT … FOR UPDATE`). `employee_import_run` is deliberately
   not reused: it is documented as deletable and as never holding the file, and changing that contract would
   silently change an existing screen's retention promise. It stays as the "Everything" run summary until its
   item replaces it.
2. **Permission per kind lives in one SQL function**, `app.import_company_access(kind, company, 'view'|'maintain')`.
   Today every kind maps to the Workforce purpose capability of the company (`workforce.view` /
   `workforce.maintain`). A later kind that needs a different capability replaces this function; policies stay.
   - List and detail: an attempt is visible with **view on at least one** listed company; each **item** only with
     view on its own company. A multi-company file therefore shows each administrator only their employees.
   - Original file download: view on **every** listed company (the file contains all of them).
   - Import (attempt insert): maintain on every listed company. Revert: maintain on **every** listed company.
   - An attempt naming no company (an unreadable or old-layout file) is visible to its creator only.
   - Screens: `/admin/personnel/import/history` and `/[attemptId]` keep the `requireAdmin()` floor and are
     registered in `lib/permissions.ts` as their own column with a scope note.
3. **Revert framework.** `core/import-history.ts` owns the generic discipline; each kind registers one
   `ImportRevertHandler` in `core/import-history-handlers.ts` (explicit import, no side-effect registration):
   `inspect` returns per-item blockers, what will be restored and a fingerprint of the current state; `apply`
   writes the compensation **through the kind's own owner** (never by editing history rows). The framework:
   requires a reason (3–1,000 characters), takes the kind's writer locks then the attempt row lock, recomputes the
   preview under lock and requires the reviewed preview hash, refuses the **whole** revert when any item is
   blocked (listing every blocker), appends exactly one `reverted` event (unique index) and the
   `import-attempt.reverted` domain event, and records `revert_failed` with the reason when refused.
4. **Cost Center Allocation (c4055300)** is the first kind. Each employee's dated sets are saved in their own
   transaction (latest date first) so one employee's failure never undoes another's. An item stores the
   allocation in effect at its date and the head revision before and after. Revert is eligible only while the
   employee's head revision still equals the last revision the import left, the company on the date is
   unchanged and every earlier cost center is still available; it re-commits the earlier rows (or a clear) at
   the same date through `app.employment_cost_allocation_commit` with the new source `import-revert`, newest
   import write first.

## 3. Consequences

- Kind builders add: a plan type, item `before/after` shapes, a revert handler and (optionally) a renderer in
  `app/(app)/admin/personnel/import/history/import-history-views.tsx`. They reuse `ImportRevertControl` unchanged.
- Revert never deletes. Allocation, movement and employment history keep the imported and the reverting
  writes; the import keeps its attempt, items and events.
- Imports made before 0675 have no attempt and cannot be reverted as a batch.
- The source bytes are personal data of the listed companies' employees; they are retained with the attempt
  and released only under rule 2.

## 4. Amendment — Bank & Statutory (0db97f14)

- **Kind `bank_statutory`.** The section file's original bytes are posted to
  `/admin/personnel/import/bank-statutory/upload`, re-read with the browser's reader and heading grammar,
  recorded as an attempt (plan = the dry run per row), then saved by the section importer one employee per
  transaction. Each transaction writes the employee's item: `before`/`after` hold only the columns whose value
  changed, as canonical strings of the tab's own projection (`lib/bank-statutory-import.ts`).
  `employee_import_run` keeps being written for the existing run list.
- **Merged writer.** `core/bank-statutory-import.ts` overlays supplied cells onto the locked statutory row,
  validates with the tab's rules and calls the pack's `set`/`setTax`/`setOthersStatutory`/`setBank` with the
  whole merged row. The three fence entries (`eis_eligible`, `epf_citizenship`, `is_resident`) are removed;
  the first and last are bounded adapters onto EIS category and income tax residency. The new columns are
  `import.updateOnly` and stay off the create template until 524303d9 adopts them.
- **Revert** is eligible only while every changed field still equals the value the import set; it restores the
  recorded values through the same writer. ~~A field that was empty before (payment method, unconfirmed income
  tax residency) cannot be emptied by a revert and blocks it.~~ Superseded by §5.
- **Permission** stays `workforce.view`/`workforce.maintain`: the section import already requires
  `workforce.maintain` on each employment (`assertWorkforceEmploymentTx`), so `app.import_company_access` is
  unchanged and no SQL is added.

## 5. Amendment — "Everything — new employees" (524303d9)

- **Kind `employee_full`.** The full import records an attempt for every commit by a signed-in actor: the
  original file posted to `/admin/personnel/import/employee/upload` (a paste or prepared text is recorded as its
  CSV text), the per-row outcome as the plan, and one applied item per created employment written in the hire
  transaction (`after` = Employee ID, name, row; no identity, salary or bank value). `confirmed` carries
  succeeded/failed; a refused file or a rolled-back write appends `failed`. `employee_import_run` is still written.
- **Revert voids** the created employments (ADR-0157). `ImportRevertHandler.apply` now receives the normalized
  revert reason as an optional fourth argument, so a kind can store it on its own rows.
- **Bank & Statutory revert restores empty values the tab can hold.** Payment method "" is the Payroll tab's own
  "Not set" choice and its owner accepts null, so it is restored. Blank bank fields, numbers and tax circumstance
  were already restorable through the merged writer. The one blank that still blocks is income tax residency:
  "" there means the employer-scoped selection is awaiting confirmation, a state only the selection's transition
  produces — the tab cannot choose it and no owner writes it.
