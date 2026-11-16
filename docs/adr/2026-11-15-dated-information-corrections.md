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
   through its ordinary legs; then each boundary is split back in on its own date with the values it changed relative
   to the record before it. A boundary that no longer changes anything (an earlier correction already gave the period
   before it the same values) is not put back: a record corrected the old way (from today) and then from the join date
   must end in the company a later-imported transfer sets. `employment.company_id` follows the record with the latest
   Effective Date. The re-application is recorded as `employment.information.boundary.reapplied`.
   This sits in the comparison writer, so New Event, the Movement import's ordered sequence, the effective-order replay
   of later movements and an older event's correction all place movements before or after corrections by date.
   `AssignmentBeforeCurrentStartError` still guards every other writer and any version that is not a correction boundary.
6. **Hire correction.** It always corrects as at the hire date and shows that date as its Effective Date. A version an
   information correction created is a boundary like a movement's: the carry-forward passes through it for fields the
   correction did not set and stops for fields it set.
7. **Payroll history import.** An employee is found under the company their dated history places them in during the
   month (current company, or a live assignment version in the importing company), read in one statement for the file.
   A month in another company's period is refused, naming that company. Migration 5680 lets the 0602 record-binding
   trigger accept the company of the record's month by the same dated rule (it required today's company).
8. **Review.** The review lists the dated records in Effective Date order, flagged corrected, unchanged or conflict,
   with closed payroll to acknowledge. History shows the Effective Date.

## Consequences

- Job Grade has no dated owner (it is a flat column replayed from events), so it stays undated, with Group Join Date,
  Join Date, Category, probation, confirmation, notice and end dates.
- The single-company-admin payroll history case (an administrator of the earlier company only, for an employee now in
  another company) is not opened here: the employment row and payslip writes are fenced by the current company
  (`can_see_employment`, `can_admin_payroll_employment`). Opening it is a security decision for the owner.
- The dated fields' existing values in the review are the record on the Effective Date, so a correction compares with
  that record (the form reloads them when the date changes).
- Statutory readers that use a correction's before-image (ADR-0163) key on `effectiveOn`; a correction bounded by a
  later change still returns current master data after its stop.
- The SQL company-on-date owner `app.company_org_employment_company` and its set-based copies (personnel overview and
  search, onboarding, staged import, rewards) still answer a day from the "before" company of the earliest correction
  dated after it. Where that disagrees with the dated record, the organisation-tag owner would refuse a placement
  movement's write: the movement is refused with `movement_correction_company_record` (named, not a database error) and
  the correction records no organisation tag for that day. Moving those readers to the dated record is a follow-up
  migration across all of them.
- New translations need translation review.

## Revision 2 — correcting dates to earlier values (board 4604dccc, plan revision 2, 15 November 2026)

The reporter contested that the saved Group Join Date and Join Date blocked corrections to earlier, real dates.

1. **The limit is the corrected Group Join Date, never the saved one.** The Information-Only Correction form's
   earliest Effective Date follows the Group Join Date entered in the same form; the server check (the corrected
   `hiredOn`) is unchanged and remains the authority. Join Date is never a limit for the Effective Date.
2. **Group Join Date Correction aligns the dated records.** After the movement (and after its Roll Back) moves
   `employment.hired_on`, `alignHistoryToGroupJoinDateTx` (core/movement-history.ts) starts the first assignment
   version, salary revision and reporting lines on it, as Information-Only Correction already did (board 154511c4).
   Exception (owner, 16 November 2026: "Completed payroll stays unchanged and no historical recalculation will
   run"): a salary record that a closed payroll was paid under is never superseded to move its start. It keeps its
   own start date, the other dated records still align, the review says so (`salaryStartKept`) and the event
   records it under `salaryKept`. Before this, such a save failed in the closed-period guard (migration 0277) with a
   generic database message (staging DB-V-06E997).
   It records `employment.history.start.aligned` with `assignment` and `aligned` replacements, which
   `isAssignmentReplacementEvent` and the hire-correction ledger follow. Moving it later (including a Roll Back) is
   refused when a recorded change or closed payroll lies in the dropped period.
3. **Movement import:** a Group Join Date Correction row goes before the employee's other new rows (preview, commit
   and history use the same order), so they are checked against the corrected date.
4. **Refusals name the date:** `MovementBeforeGroupJoinDateError`, `event_before_hire:<date>` and
   `movement_before_join_date:<date>`. Older recorded codes without a date drop the bracketed date when shown.

Kept, by decision: nothing is dated before the corrected Group Join Date (no employment record covers it; leave
service bands read `hiredOn`); Join Date stays on or after Group Join Date; Historical Hire records an earlier
separate stint; Organisation Hire Correction gains no date inputs and anchors on the current Group Join Date.

## Revision 4 — the latest saved correction controls (board 4604dccc, plan revision 4, approved 16 November 2026)

The reporter contested that an older correction still won over a newer one saved for an earlier Effective Date
(corrected from 1 November, then corrected again from 1 March: the March correction stopped on 31 October and
reports used the older correction first).

1. **Rule.** For Information-Only Correction (screen and Excel version 3) and Organisation Hire Correction, the
   correction saved LAST (`domain_event.sequence`) controls each field it changes from its Effective Date onward. An
   earlier-saved correction no longer ends it or overrides it. A recorded movement (transfer, promotion,
   confirmation, history movement …, as `recordedMovementChangesTx` lists them) still owns its own date for the fields
   it changes. Events are read in Effective Date order for dates and in saved order only to decide which correction
   controls. Earlier corrections stay in the correction history and audit trail unchanged.
2. **Dated assignment fields.** `planDatedCorrection` / `writeDatedCorrectionTx` take `carry`: per corrected field,
   the later boundary dates that an earlier information correction (or its `employment.information.boundary.reapplied`
   re-application) created for that field and that no recorded movement owns for that field on the same date. The new
   correction is carried through them (those versions are superseded and re-inserted, never updated in place, with the
   replacements on the event as before) and stops only at a recorded movement or any other writer's boundary. A
   Company correction's boundary also carries its derived Business Unit. The conflict rule (decision 3) is unchanged.
3. **Labels and Direct Superior.** Only a later recorded movement that changes the field ends the correction
   (`until`, `labelsNotCurrent`); otherwise the newest correction's value is current. A later Direct Superior line an
   earlier correction wrote (its recorded `reportingLine`, or its Effective Date and superior) is superseded and the new
   line runs over it to the next other line, or open-ended.
4. **Readers.** `employmentInformationAt` (pay formula runtime, Borang A/8A, CP39, PCB2(II), CP21/EA readers in
   localization/my/reports.ts): the correction in force on a day is the latest saved one that changed the field and is
   dated on or before it; a before-image is read only from a correction saved after that one and dated after the day
   (earliest saved wins); else current master data. Corrections saved in Effective Date order give exactly the earlier
   answer (equivalence test).
5. **Organisation Hire Correction** is always saved after every existing information correction, so its walk passes
   through a version an information correction created for the fields that correction set (it stopped there before).
   Its reporting line at hire is unchanged (it still ends at the next line).
6. **Review.** `replacedCorrections` lists the earlier corrections dated on or after the new Effective Date and before
   the field's next recorded movement, for the fields both change (Effective Date, saved at, fields, actor). It is
   information, never a refusal, on the screen review and each Excel row. The event records `replacedCorrectionSequences`.
   The caption "Future processing uses these corrected details from {date}" (`effective`) is removed in all six
   locales; the correction history shows the Effective Date on its own line.
7. **Payroll** protection is unchanged from revision 3 (5690 snapshots, closed-payroll acknowledgement over the now
   longer corrected period, closed months under another company refused).

Consequences:

- Corrections already saved are re-read under the new rule. Saved in Effective Date order (or a single correction):
  nothing changes. Saved out of date order: `employmentInformationAt` answers by the new rule at once; the dated
  assignment records, labels and lines written by the earlier save stay as written until the next correction or
  movement rewrites them (no data repair runs).
- No migration. The SQL readers that copy ADR-0163's before-image rule (`app.company_org_employment_company` and its
  set-based copies in Personnel overview/search, `app.information_report_records`) still answer "earliest later
  correction wins". For out-of-order corrections they can disagree with the dated record for the replaced period; the
  existing named refusal (`movement_correction_company_record`) and the tag-only-where-they-agree rule apply. Moving
  them to this rule is the follow-up migration already recorded above.
- New and changed translations need translation review.
