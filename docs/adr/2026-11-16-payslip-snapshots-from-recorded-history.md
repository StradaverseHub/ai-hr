# Payslip snapshots from recorded history

Status: implementation candidate for board item 4604dccc revision 3 (plan approved by the reporter, 15 November 2026).
Not merged, installed or accepted.

Supersedes: in ADR-0163, "Legacy payslips with intervening master changes and no independently reconciled original
snapshot refuse correction", and in ADR-0164 the same readiness refusal before a movement correction behind closed
payroll. Amends c063eea9 (2): a join-date movement across payslips is no longer refused.

## Context

Payslip documents read some employee details (Group Join Date, Join Date, grade, employment type, business unit,
department, position) from the live record until a snapshot fixes them. Information-Only Correction refused whenever a
payslip without a snapshot was followed by a change, so most employees with payroll history could not be corrected
(staging EMP-0004: nine payslips, later grade, transfer and confirmation events). The reporter requires that payroll
history never blocks a People correction, and that closed payroll stays exactly as paid.

## Decision

1. `app.preserve_information_payroll` (migration 5690) no longer requires readiness. For each payslip without a snapshot
   it fixes the details as at the batch time T = coalesce(closed_at, created_at): Group Join Date, Join Date and grade
   from the "before" value of the earliest recorded change after T; employment type, business unit, department and
   position from the assignment row that existed and had started at T; anything with no history as displayed today.
   `document_metadata.snapshotBasis` records which fields were reconstructed and which were kept as displayed. Existing
   snapshots are never changed. Payroll rows are never written. `app.information_payroll_ready` answers only who may
   correct. The 5055 staged-row predicate stays on every payslip read.
2. Information-Only Correction and Movement corrections behind closed payroll drop the readiness refusal. Two data
   refusals remain, in plain words: no access to a company that paid an earlier payroll, and an ambiguous current
   company/position record.
3. Group Join Date Correction and Join Date Change across payslips: an open run is not a block (hired_on still flags it
   for recalculation); a closed month in between needs HR's confirmation (`acknowledgeClosedPayroll`, entering Movement's
   correction authority for that writer only, on New Event and as the Movement import's batch confirmation), and the
   snapshots are fixed first. Moving the Group Join Date later past a closed month remains refused by the dated-history
   alignment (that month was paid).
4. The Information-Only Correction screen also corrects Business Unit, Department and Position, dated from the
   Effective Date like the template. The correction history shows the employee and the closed months confirmed.

## Consequences

- A reconstructed value is the recorded history's best statement, not an independently verified original document.
  `scripts/reconcile-information-snapshots.ts` remains available for verified originals but is no longer a prerequisite;
  it cannot overwrite a snapshot this owner wrote.
- Details with no recorded history (names, bank and statutory numbers, organisation labels) are kept as displayed at
  the first correction.
