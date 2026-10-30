# ADR-0164 — Movement corrections behind closed payroll

- Date: 2026-10-30
- Status: implementation candidate for approved feedback 646355e5 (plan revision 1). Not merged, tested on a target, installed or accepted.
- Amends: the 66a63bd6 rule "a closed payroll run blocks a Movement correction until it is reopened"; builds on [ADR-0163](0163-information-only-employment-corrections.md) and [ADR-0156](0156-single-sheet-movement-import.md).
- Migration: none for slice A (reuses the ADR-0163 snapshot table and functions).

## Decision

1. **Closed payroll requires acknowledgement, not reopening.** A rollback or edit whose financial window overlaps a closed run is refused with `MovementClosedPayrollAcknowledgementError` (naming the closed months) unless the caller confirms that closed payroll stays as issued. The service entry points (`reverseMovementEvent`, `editMovementEvent`) are the only code that enters the transaction-bound `closed-payroll-correction-authority` scope, and only when the posted acknowledgement is present. The reason stays mandatory. Inside that scope, and only there, the resignation-date and exit-date writer guards admit the correction. Salary follows decision 3. Every other caller keeps the existing refusal.
2. **Issued documents are retained first.** Before the first compensating write, `app.preserve_information_payroll` snapshots the employee's payslip document metadata (ADR-0163). The same readiness rule applies: when original metadata cannot be verified after intervening changes, the correction is refused with the reconciliation message rather than stamping today's master data as issued. Payroll transactions, canonical payslip amounts and batch status are never written. Nothing is recalculated or reprocessed.
3. **Salary starts after the closed months (owner decision, 30 October 2026).** The migration 0277 guard stays: a salary record a closed run paid against is never removed. Undoing a movement's salary record shortens it to end on the first day after the last closed month it overlaps and restores the previous salary from that day. A corrected salary also starts on that day, never inside a closed month. The warning tells HR so. A record paid entirely inside closed months is left as it is. Any difference for the closed months remains a separate payroll correction or back-pay decision.
4. **Audit and downstream boundary.** The `employment.movement.reversed` event carries `closedPayrollPeriods`, `closedPayrollAcknowledged`, `closedPayrollCorrectedOn` and `snapshotCount`. The leave owner's historical-processing guard treats `closedPayrollCorrectedOn` the same way as an information correction's `effectiveOn`: earlier processing dates require review.
5. **Screen.** Rows behind a closed run keep their Edit and Roll Back actions and show the closed months. The edit form and the rollback dialog show the warning and a required confirmation box; the server refuses without it regardless of the screen.
6. **Unchanged import revert.** A whole-import revert has no acknowledgement step, so the shared blocker still reports a closed-payroll row as not revertible.

## Planned slices (same approved item)

- Slice B — any event editable: correcting an older state-changing movement rolls back the later movements, applies the correction and replays them in effective-date order in one transaction, refusing with the conflicting event named when the replay is invalid. Applied terminations need their own reversal leg (assignment reopening, reporting lines, lifecycle consequences) and are part of this slice.
- Slice C — import Action (Create, Update, Delete) with a Movement Event ID, export with IDs, and history/revert coverage.

## Consequences

Old payslips render their retained metadata; current and future processing use corrected data. Corrections that would change money already paid are flagged, not adjusted; adjustment remains a separate authorized payroll process.
