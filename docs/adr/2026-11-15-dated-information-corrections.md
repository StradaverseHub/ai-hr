# Dated information-only corrections

Status: implementation candidate for board item 4604dccc (plan approved by the reporter, 15 November 2026).
Not merged, installed or accepted.

Supersedes: ADR-0163 "Assignment changes start on the business day of correction", and the limitation in
[2026-11-13 backward movement history](2026-11-13-backward-movement-history.md) Consequences ("Correcting a later
Correct-information change that started the current record still requires reversing it first"). Decision 6 of that
ADR (company "from the join date") is generalised below.

## Context

After a migration HR loads an employee's latest details, corrects them, then imports the earlier history. A
correction always started today, so its assignment version blocked every earlier-dated movement ("The date … is
before the current assignment record"), and payroll history import looked only at the employee's company today.

## Decision

1. **Effective Date.** Information-Only Correction (screen and Excel) takes an Effective Date, default today, from the
   start of the dated history (the Group Join Date, which the history is aligned to) up to `todayInKualaLumpur()`.
   Future dates are refused. The `fromJoinDate` tickbox is removed: choosing the Group Join Date is the from-start case.
2. **Dated fields.** Company, Employment Type, Business Unit, Department and Position are written on `assignment`:
   the version covering the Effective Date ends on it (keeping its id, as every assignment writer and Roll Back do) and
   a corrected piece starts there; each corrected field is carried through later versions that merely inherited it
   and stops at the first version where it changes again. Carried versions are superseded and re-inserted with the
   replacements on the correction event (`assignment`, `inserted`). Nothing after a stop changes. `employment.company_id`
   changes only when the corrected company reaches the current record. Organisation labels (flat columns) and the
   Direct Superior (dated reporting line) apply from the Effective Date until their next recorded change; a label a
   later change owns today keeps its current value and the event records the dated correction (`labelsNotCurrent`).
3. **Conflicts.** When a field stops at a later movement (or history movement) whose recorded Before value differs
   from the corrected value, the correction is refused, naming the movement, its date and the field. Later rows are
   never rewritten. A later correction boundary is not a conflict: it owns its own period.
4. **Payroll.** Closed payroll overlapping the corrected period (Effective Date before today) requires an
   acknowledgement (the movement closed-payroll pattern; batch-level for the Excel import) and is never recalculated.
   A closed month in the corrected company period that was paid under another company refuses the correction. The 0698
   payslip snapshots and the ADR-0163 readiness, year-open, accrual and entitlement refusals are unchanged; they read
   the event's `effectiveOn`, which is now the chosen date.
5. **Corrections are dated boundaries for movements.** Before a comparison movement dated D writes placement legs,
   versions after D that start on an information correction's Effective Date and were not created by a movement,
   history movement or other assignment writer are merged back into the version covering D; the movement writes
   through its ordinary legs; then each boundary is split back in on its own date with the values it set (the fields
   that differed from its predecessor plus the fields the correction named). `employment.company_id` follows the
   record with the latest Effective Date. The re-application is recorded as `employment.information.boundary.reapplied`.
   This sits in the comparison writer, so New Event, the Movement import's ordered sequence, the effective-order replay
   of later movements and an older event's correction all place movements before or after corrections by date.
   `AssignmentBeforeCurrentStartError` still guards every other writer and any version that is not a correction boundary.
6. **Hire correction.** It always corrects as at the hire date and shows that date as its Effective Date. A version an
   information correction created is a boundary like a movement's: the carry-forward passes through it for fields the
   correction did not set and stops for fields it set.
7. **Payroll history import.** An employee is found under the company their dated history places them in during the
   month (current company, or a live assignment version in the importing company), read in one statement for the file.
   A month in another company's period is refused, naming that company.
8. **Review.** The review lists the dated records in Effective Date order, flagged corrected, unchanged or conflict,
   with closed payroll to acknowledge. History shows the Effective Date.

## Consequences

- Job Grade has no dated owner (it is a flat column replayed from events), so it stays undated, with Group Join Date,
  Join Date, Category, probation, confirmation, notice and end dates.
- The single-company-admin payroll history case (an administrator of the earlier company only, for an employee now in
  another company) is not opened here: the employment row and payslip writes are fenced by the current company
  (`can_see_employment`, `can_admin_payroll_employment`). Opening it is a security decision for the owner.
- Statutory readers that use a correction's before-image (ADR-0163) key on `effectiveOn`; a correction bounded by a
  later change still returns current master data after its stop.
- New translations need translation review.
