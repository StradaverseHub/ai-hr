# ADR-0156 — Single-sheet Movement import, per-row company and whole-import revert

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

- **Date:** 2026-10-29
- **Status:** Proposed with board item ac6645ec (approved plan). Accepted is not merged, tested, installed or released.
- **Supersedes:** the company binding and the per-type sheet envelope of [ADR-0130](0130-movement-workbook-admission.md).
  ADR-0130's other decisions (Movement owner adjudicates, private sequence rehearsal/replay, the employment Test
  record marker and its admission lock, the dedicated `MOVEMENT_IMPORT_WORKBOOK_KEY` custody contract) stand.
- **Builds on:** [ADR-0155](0155-shared-import-history-and-revert.md) (shared import history and revert).
- **Migration:** none.
- **Amended by:** [ADR-0164](0164-movement-corrections-behind-closed-payroll.md) slice C (template version 4: Action, Movement Event ID and Reason columns; Update and Delete rows and their revert).

## 1. Context

The Movement workbook was one sheet per movement type, signed to ONE company chosen before download. HR asked
for one template for every type and company, one row per field change, a Before value checked against the
record, an import history and a safe undo of a whole import.

## 2. Decision

1. **One Movements sheet, eight columns in this order:** Company ID, Employee ID, Employee Name (optional,
   informational), Effective Date, Event Type, System Fields, Before, After. Instructions, a Reference sheet
   (event types × allowed System Fields, the exact Company ID of every company the user may import for, and
   per-company allowed values) and hidden drop-down lists accompany it. The same columns are accepted as CSV.
2. **The signature binds the tenant and the movement-type catalogue, not a company.** `_meta` version 3 carries a
   tenant MAC, the catalogue hash and the signed captions. It is context binding only and authorizes nothing.
   Internal UUIDs are still refused in every cell. A version 2 (per-type, per-company) workbook or the old CSV
   headers are refused with "download the new template"; there is no conversion.
3. **Company per row.** Company ID is resolved with the cost-allocation matcher (`matchAllocationCompany`:
   Company Code, else registration number, else legal name; unknown and ambiguous refused) over the companies
   the actor administers with Workforce view and maintain. A company outside the actor's rights is "unknown"
   (no existence disclosure). The employee is matched by `employee_code` within that company.
4. **Grouping.** Rows with the same company, employee, effective date and event type are ONE movement; System
   Fields map to the existing per-behaviour inputs (the same field set the per-type layout offered, including
   Increment Amount). One employee of one company is the unit of preview fingerprint, rehearsal and
   transaction, as before; limits are unchanged (200 rows, 50 employees, 20 movements per employee).
5. **Before** is optional. When given it must equal the as-of value immediately before that movement in the
   rehearsed sequence (reference fields by id, code or label; money to the cent; dates by day). A mismatch is a
   row error, which stops that whole employee; nothing is overwritten.
6. **History and revert (ADR-0155 kind `movement`).** The upload is an import attempt with the original bytes;
   `apply` names only the attempt, its preview hash and the chosen employees, and the server re-reads the stored
   file. Inside each employee's transaction the ledger marker before and after each movement captures the
   history rows (movement ids) it created; each is an `applied` item with the changed fields' display values
   and the raw values the movement left. Revert is all or nothing: every item must pass the Movement owner's
   own rollback guards (reversible type, not superseded, not already reversed, no closed payroll period — the
   same `reversalGuardTx` the rollback runs), and every changed field must still hold the value this import left
   (otherwise a later change blocks it). Movements are rolled back newest first through `reverseMovementTx`
   with the revert reason; they stay in Employment History marked reversed. The framework's `apply` now
   receives the validated reason.

## 3. Consequences

- One file may hold several companies; each administrator's history shows only their companies' items.
- A per-type prefilled workbook (grey current values, salary formulas, employee filters) is no longer offered;
  Before replaces the grey snapshot as the staleness check, and preview remains authoritative.
- The field check compares current values, so a later change that restores the imported value does not block a
  revert. Movements recorded before this change have no attempt and are rolled back one by one as today.
>>>
