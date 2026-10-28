# ADR-0157 — Voiding employments created in error by an import

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

- **Date:** 2026-10-29
- **Status:** Proposed with board item 524303d9 ("Everything — new employees", approved plan). Accepted is not merged,
  tested, installed or released.
- **Related:** ADR-0155 (shared import history and revert — this is the `employee_full` kind's compensation),
  ADR-0006 (domain events), ADR-0135 (configurable access), migration 0594 (NRIC policy), 0668 (duplicate email
  policy).
- **Migration:** `0676_employment_import_void` (journal position provisional until integration).

## 1. Context

An "Everything — new employees" file can create hundreds of employees at once. When the file was wrong (wrong
company, wrong month, a shifted column) HR needs to undo it and import the corrected file. Nothing in the product
could remove an employment: about 140 foreign keys reference `employment` and `person`, `domain_event` is
append-only, and deleting an employee would destroy the audit trail of the import and of the revert itself.

## 2. Decision

1. **Revert is a VOID, never a delete.** `employment` gains `voided_at`, `voided_by`, `void_reason`,
   `voided_import_attempt_id` and `voided_employee_code`; `person` gains `voided_at` and `voided_ic_number`. The
   person, the employment, every row the hire wrote and every domain event stay. Each voided employment appends
   `employment.voided` (subject = the employment) and the attempt appends its once-only `reverted` event.
2. **Final and tied to an import.** The only writer is `app.employment_void(uuid[], attempt, reason)`, a definer
   (a voided row no longer satisfies the read policy its own UPDATE is checked against) that re-checks the actor,
   `workforce.maintain`, the attempt's applied items and every blocker before voiding person, statutory IC and
   employment in one statement each. Trigger `employment_void_guard` allows a void only for an *applied* item of an
   `employee_full` attempt, by the signed-in actor holding `workforce.maintain` on the employment, and refuses any
   later change to the void columns (`person_void_guard` likewise; a person with a login cannot be voided). The
   owner role keeps repair authority. `employment_void_complete_ck` requires all void columns together.
3. **Eligibility, per employment, all or nothing.** `app.employment_void_blockers(uuid[])` (definer, so RLS
   cannot hide a payslip from the check) enumerates **every foreign key to employment and person at run time**
   and counts referencing rows, so a table added later blocks a void by default. Not blocking, with reasons:
   - *judged by shape* — one `assignment` (the hire's), one `compensation` revision (the hire salary), leave
     ledger `accrual` rows dated on the hire date (opening grants), `reporting_line` rows where the employment is
     the subordinate (the import's Direct Superior) or the manager of another employment in the same revert,
     and other employments of the person only when they are in the same revert;
   - *written by the same import* — `employee_statutory_my`, `employee_dependent`, `person_emergency_contact`,
     `employee_qualification`, `employment_cost_allocation_head`, `employment_tax_selection_my`,
     `employment_tax_scheme_my`;
   - *configuration, not activity* — `employment_holiday_calendar`, `employment_shift_arrangement`,
     `overtime_pattern_assignment_employment`, `employee_clocking_location`, `notification_pref`;
   - *system projections and audit* — `domain_event`, `import_attempt_item`, `leave_generation_run_item`,
     `leave_entitlement_recalc_audit`, `notification`, `notice_recipient`, and the replacement-holiday entitlement
     projection (`replacement_holiday_queue`, `replacement_holiday`, `replacement_holiday_revision`) that the hire
     queues — a replacement holiday actually taken is a leave request and blocks.
   Everything else blocks, including payroll inputs and results, leave applications and non-opening ledger
   rows, attendance and clocking, claims, documents and attachments, movements (a second assignment or salary
   revision, any resignation/termination/blacklist date, lifecycle cases, reviews), login accounts and
   invitations, being the direct superior of someone outside the import, and the person holding another
   employment. One blocker refuses the whole revert and every blocker is listed with the employee.
4. **Central exclusion, not per query.** Voided rows leave ordinary reads at the two chokepoints every
   `ai_hr_app` read shares: `employment_rls` and `person_rls` gain `voided_at IS NULL` in USING (writes keep their
   WITH CHECK). Definer functions that bypass RLS are amended: `app.access_workforce_list_rows()` (Personnel list,
   counts and pickers), `app.access_workforce_employment()` (every Workforce gate), `app.create_login_person()`.
   Reads covered through RLS include the Personnel list and its counts, `listEmployees*`/pickers, the dashboard
   and analytics headcount, payroll run selection and payslip generation, roster/scheduling, reports and the
   duplicate email/NRIC/Employee ID checks of every import.
5. **Identifiers are released.** On void, `employee_code` moves to `voided_employee_code` (the unique index is
   on the live column), the statutory `ic_number` moves to `person.voided_ic_number` (the NRIC admission rule
   counts live rows), and the voided person's work email leaves every duplicate-email read with the person. A
   corrected file therefore re-imports the same Employee IDs, emails and NRICs.
6. **Revert discipline is ADR-0155's:** writer locks, attempt `FOR UPDATE`, preview hash over the blockers and
   items, a 3–1,000 character reason (now passed to the kind's `apply`, stored on each void), once only.

## 3. Consequences

- Reads made as the database owner (migrations, repair scripts) still see voided rows and must filter
  `voided_at IS NULL` themselves.
- Domain events of a voided employment remain readable by aggregate; projections that join `employment` drop
  them with it.
- A void cannot be undone in the product. Re-import the corrected file instead.
- Imports made before this change have no `employee_full` attempt and cannot be reverted.
