# ADR-0164 — Movement corrections behind closed payroll

- Date: 2026-10-30
- Status: implementation candidate for approved feedback 646355e5 (plan revision 1). Not merged, tested on a target, installed or accepted.
- Amends: the 66a63bd6 rule "a closed payroll run blocks a Movement correction until it is reopened"; builds on [ADR-0163](0163-information-only-employment-corrections.md) and [ADR-0156](0156-single-sheet-movement-import.md).
- Migration: none for slices A to C (slice A reuses the ADR-0163 snapshot table and functions).

## Decision

1. **Closed payroll requires acknowledgement, not reopening.** A rollback or edit whose financial window overlaps a closed run is refused with `MovementClosedPayrollAcknowledgementError` (naming the closed months) unless the caller confirms that closed payroll stays as issued. The service entry points (`reverseMovementEvent`, `editMovementEvent`) are the only code that enters the transaction-bound `closed-payroll-correction-authority` scope, and only when the posted acknowledgement is present. The reason stays mandatory. Inside that scope, and only there, the resignation-date and exit-date writer guards admit the correction. Salary follows decision 3. Every other caller keeps the existing refusal.
2. **Issued documents are retained first.** Before the first compensating write, `app.preserve_information_payroll` snapshots the employee's payslip document metadata (ADR-0163). The same readiness rule applies: when original metadata cannot be verified after intervening changes, the correction is refused with the reconciliation message rather than stamping today's master data as issued. Payroll transactions, canonical payslip amounts and batch status are never written. Nothing is recalculated or reprocessed.
3. **Salary starts after the closed months (owner decision, 30 October 2026).** The migration 0277 guard stays: a salary record a closed run paid against is never removed. Undoing a movement's salary record shortens it to end on the first day after the last closed month it overlaps and restores the previous salary from that day. A corrected salary also starts on that day, never inside a closed month. The warning tells HR so. A record paid entirely inside closed months is left as it is. Any difference for the closed months remains a separate payroll correction or back-pay decision.
4. **Audit and downstream boundary.** The `employment.movement.reversed` event carries `closedPayrollPeriods`, `closedPayrollAcknowledged`, `closedPayrollCorrectedOn` and `snapshotCount`. The leave owner's historical-processing guard treats `closedPayrollCorrectedOn` the same way as an information correction's `effectiveOn`: earlier processing dates require review.
5. **Screen.** Rows behind a closed run keep their Edit and Roll Back actions and show the closed months. The edit form and the rollback dialog show the warning and a required confirmation box; the server refuses without it regardless of the screen.
6. **Unchanged import revert.** A whole-import revert has no acknowledgement step, so the shared blocker still reports a closed-payroll row as not revertible.

## Planned slices (same approved item)

- Slice B — any event editable: correcting an older state-changing movement rolls back the later movements, applies the correction and replays them in effective-date order in one transaction, refusing with the conflicting event named when the replay is invalid. Applied terminations need their own reversal leg (assignment reopening, reporting lines, lifecycle consequences) and are part of this slice.
- Slice C — import Action (Create, Update, Delete) with a Movement Event ID, export with IDs, and history/revert coverage. Decided below.

## Slice C — Movement import Update and Delete (amends ADR-0156)

1. **Template version 4.** The signed `_meta` becomes version 4 and the Movements sheet gains three columns appended after
   After: **Action** (Create, Update, Delete; blank means Create), **Movement Event ID** and **Reason**. Appending keeps
   every version 3 column in place: a version 3 workbook (eight captions) or an eight-column CSV is still read, with the
   three cells blank, so it imports as Create only. A value beyond a file's own columns is still
   `workbook_columns_changed`.
2. **The id is the one internal reference a cell may carry.** ADR-0156 §2 refuses internal ids in every cell; the
   Movement Event ID column is the single exception. It resolves only among the movements of the row's own employee,
   after the company and employee are fixed by the existing per-row matching (tenant by RLS, company by the
   cost-allocation matcher and administration rights, employee by Employee ID within that company). A movement is never
   matched by employee plus date. Row errors: missing id, unknown id (also a malformed id, and another tenant's or
   company's movement, which is not disclosed), another employee's movement in the same company, an already rolled-back or
   superseded movement, the Hired row, Delete with fields, a Delete whose filled date or type does not match, Create with
   an id or reason, the same id named twice, and Update or Delete without a reason.
3. **Reason column.** A correction reason is required per Update and Delete movement, in its own Reason column rather
   than Remarks, because Remarks is a field an Update may itself correct. Rows of one movement must agree on it.
4. **Update** overlays only the filled cells on the movement as recorded, read from its own legs by
   `movementCorrectionBaseTx` (never today's master data): a blank After, Effective Date or Event Type keeps the recorded
   value and nothing is cleared. The merged input is corrected through `editMovementEventTx`, the manual Edit's own body
   (rollback plus replay, older events included), in the employee's import transaction. Increment Amount is refused on
   Update (enter the corrected Basic Salary). Before, when filled, is checked against the movement's recorded value.
   **Delete** is `reverseMovementForImportTx` with the row's reason. Corrections run before the employee's new movements,
   in sheet order, in preview and commit alike.
5. **Closed payroll.** The confirm step shows the closed months found in preview and a confirmation box. Only when it is
   ticked does the server pass the acknowledgement to `editMovementEventTx` / `reverseMovementForImportTx`, which are
   still the only entry points to the closed-payroll correction authority. Without it the employee fails with
   `closed_payroll_acknowledgement_required` and the months. Preview always rehearses with the acknowledgement (inside its
   always-rolled-back transaction) so that it can name the months.
6. **History and revert.** Each Update or Delete is one attempt item: the movement's displayed values before and after,
   its recorded input (`original`), the original movement id and, for an Update, the movement the correction left.
   Revert of an Update corrects that movement again, back to `original`, through `editMovementEventTx`; revert of a Delete
   re-records `original` through `createMovementEventTx`. Both are refused with a reason when a later change touched the
   same movement: the movement the Update left was changed or rolled back, a field the import changed no longer holds
   the value it left, or (Delete) a later movement now follows the deleted one and would be overwritten. Inspection then
   rehearses the employee's whole compensation in a savepoint that always rolls back, so every owner refusal becomes a
   blocker and the preview and the commit cannot disagree. Like every whole-import revert, it passes no closed-payroll
   acknowledgement (§5 above).
7. **Export.** The Employment History download gains a final Movement Event ID column (blank for the Hired row). There is
   no bulk movement download in the product today, so none was extended.

## Consequences

Old payslips render their retained metadata; current and future processing use corrected data. Corrections that would change money already paid are flagged, not adjusted; adjustment remains a separate authorized payroll process.
