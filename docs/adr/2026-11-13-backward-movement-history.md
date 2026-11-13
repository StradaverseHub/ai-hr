# Backward movement history and company correction from the join date

Status: accepted (board item 154511c4, plan revision 2 approved 13 November 2026)

## Context

HR loads an employee's latest details first and then records the history backwards. Movements only worked
forwards: a movement changes the record from its effective date onward, and Correct information always
applies from today. On production (13 November 2026) an employee imported into the wrong company was
corrected with Correct information, which changed the company only from that day; the transfer HR then
imported for 01 April 2026 was refused, and the screen showed a generic "could not be applied" sentence, so
HR blamed the payroll history.

## Decision

1. **History is recognised from ordinary Create movements; there is no separate action or template
   change.** A new movement whose every field is a dated placement field (company, department, position,
   business unit, work location) with a Before value, whose After values already stand on its effective date
   D, and whose Before values differ from the record on D − 1, is history. That case was always refused as a
   no-change, so no movement that worked before changes meaning. Everything else stays a forward movement.
2. **A history movement rewrites only [start, D).** Every live assignment version before D is superseded
   and re-inserted with the Before values over the same dates; the version spanning D is split at D. D and
   everything after it, and `employment.company_id`, never change. It is refused when D is in the future;
   when the field already changes before D (that change owns its period); when the version spanning D was
   created by a recorded movement (Roll Back splices one version into its neighbour and cannot follow a
   split); when a closed payroll in the period was paid under a company other than the Before company; and
   when the Before company cannot use a carried label. Closed payroll that agrees, or does not depend on the
   company, is reported and stays as issued; no payslip is recalculated.
3. **Ordering.** An employee's new rows are classified together, newest first, against a simulated timeline
   after that employee's Update/Delete rows have acted; history rows are applied newest first, then ordinary
   movements in effective-date order. Preview, commit and the background check use the same order; the lean
   commit path declines any employee with a possible history row.
4. **Event and chain.** `employment.history.recorded` projects one movement row (marked history) and records
   `assignment: [{supersededId, replacementId}]` in the shape the hire correction's chain uses, so Roll Back
   of an older movement still finds the live row. Rolling a history movement back is allowed while every row
   it inserted is live; it re-inserts copies of the originals (`employment.history.reverted`). In-place edit
   is not offered; the import's Update deletes and re-records it. A whole-import revert of an Update/Delete of
   a history movement is refused (no forward original exists).
5. **Company display.** For an employee whose dated company was rewritten (a history movement, or a company
   correction from the join date), Employment History reads the company from the dated version instead of the
   sequence replay, which cannot place a later-recorded, earlier-dated change.
6. **Correct information.** The review states from which date the company changes and warns when the dated
   history starts before the Group Join Date. A company-only correction may be applied **from the join date**
   when the company never changed in the history: every version takes the new company (same payroll and label
   checks) and the replacements are recorded on the correction event.
7. **Named refusals.** Writer refusals that reached import rows as English sentences now map to row codes in
   all six locales (record start date, already in company, label of another company, unadministered
   destination, no change, backdated reason, before join date).
8. **Payroll history import** points out (without blocking) a month recorded under a company the employee's
   dated history does not place them in.

## Consequences

- Salary history is not recorded backwards; the dated placement fields only.
- A history movement cannot be inserted inside a period created by a recorded movement; HR deletes that
  movement or records history before it.
- Correcting a later Correct-information change that started the current record still requires reversing it
  first (on the same day, a second correction replaces it).
- New translations need translation review.
