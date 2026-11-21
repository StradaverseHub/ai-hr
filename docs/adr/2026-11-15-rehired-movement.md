# ADR 2026-11-15 — Rehired: a new employment period for a returning person

- Status: implementation candidate for approved feedback 511aa74a; not merged, tested on a target, installed or accepted.
- Migration: `5695_employment_rehire_link` (idx 5095, when 1793330005395; see docs/MIGRATION-ALLOCATION.md).
- Builds on: ADR-0157 (employment void), ADR-0166 (movement type controls), the employment status deriver
  (core/employment-status.ts) and the hire owner (core/org.ts `hireEmployee`).

## Context

A resigned employee who returns had to be added as a brand-new employee: nothing linked the new record to the old one
and HR re-keyed details the system already held. The model already keeps one PERSON across several EMPLOYMENT periods.

## Decision

1. **Built-in event type Rehired (`rehire`).** It joins `MOVEMENT_KINDS` and so appears in Movement Settings as a
   built-in that can be renamed or switched off. It is not a comparison kind and not in `CONFIGURABLE_BEHAVIOUR_KINDS`, so
   no tenant type can carry it. The movement catalogue is an overlay (0340): no per-tenant seed is needed.
2. **New employment, same person, new Employee ID.** `core/rehire.ts rehireEmploymentTx` composes `hireEmployee` with the
   person reused, the salary owner and the payment-method owner, sets `employment.rehired_from_employment_id` and appends
   the Rehired event (`employment.movement.recorded`, `type: 'rehire'`) on the new employment, in one transaction. The
   previous employment's rows and events are not written. Person-keyed facts (IC, statutory numbers, bank details,
   family, login) carry over by construction. Leave starts fresh on the new employment.
3. **Admission.** Admin (super_admin/hr_admin) with Workforce maintain on the previous period, the person and the
   destination company, who administers the destination company. The previous period must derive to Resigned today and
   not be blacklisted; no other live period of the person may be open (current or future-dated) or blacklisted, counted
   as the definer (`app.employment_rehire_person_state`) so a period in a company the actor cannot see still counts; the
   period must not already be rehired (partial unique index on live rows); the effective date must be after the latest
   end date of the person's periods. The Group Join Date defaults to the effective date and may be earlier (service
   continues); the join date, assignment, salary and opening leave grants start on the effective date.
4. **Employee ID.** The company's Employee ID setup decides, as on Create Employee: the suggested next number is issued
   at save (skipping numbers already held); a typed ID is used only where the setup allows manual entry, or where no
   setup exists (then it is required).
5. **Roll Back.** Only through `rollBackRehire`, never the generic movement rollback (`correctabilityOf` refuses the
   kind). Allowed while `app.employment_rehire_rollback_blockers` is empty: no recorded exit, later assignment or salary
   revision, leave debit or time-off-in-lieu credit, direct report, or row of any other table referencing the employment
   other than those the hire writes (derived from foreign keys, as in 0676). Entitlement credits and recalculations do not
   block. The new employment is voided through the 0676 void columns (Employee ID released, rows kept, person never
   voided); the link is kept on the voided row for audit and no longer counts against a later rehire of the same period.
6. **Screens.** New Event offers Rehired only while the rule above admits it (also for a terminated employee, whose
   other movements stay closed). Employment History shows the Rehired row with the previous Employee ID; an Employment
   Periods card lists the person's periods once there is more than one; the Personnel list shows "Rehired as {code}"
   on a previous period. The movement import does not offer Rehired (its catalogue and fingerprint are unchanged).

## Consequences

- Keeping the old Employee ID and Rehired in the movement import are not built.
- The previous period's events are untouched, so the Rehired audit lives on the new employment only.
- New translations in all six locales need translation review.
