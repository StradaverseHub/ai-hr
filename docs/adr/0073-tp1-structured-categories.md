# ADR-0073 — TP1 Relief: structured per-category breakdown (PDF form → interactive)

Status: Accepted · 2026-07-06 · Feedback a2f1fa24 · Extends ADR-0050

## Context

ADR-0050 shipped self-service TP1 relief as a **single annual scalar** `tp1_amount` per
`(person, assessment_year)` on `tp1_relief`, fed into monthly PCB/MTD by `prefillTp1FromSelfRelief`.
The reporter (a2f1fa24) is right that "the current implementation does not meet functional
expectations": the paper **LHDN TP1** form is organised **category by category** (individual, spouse,
children, parent, medical/insurance, lifestyle, education, ...), but the system captured only one opaque
box. HR/staff still fill the breakdown on paper; there is no structured, auditable per-category record.

This is a **data-entry / UX conversion**, NOT a calculation change. The monthly tax figure is produced by
a deliberately locked-down kernel covered by golden tests that fail if any cent moves.

## Decision

Capture the per-category breakdown on the **existing** `tp1_relief` store (do NOT create a third TP1
surface). The employee maintains it on `/me/tax-relief` as a sectioned form mirroring the paper TP1.

1. **Storage — additive JSONB.** One nullable `categories jsonb` column on `tp1_relief` (migration
   `0157`). Legacy rows keep `categories` NULL and their scalar `tp1_amount`; they read and prefill
   unchanged (backward compatible). The JSONB is the repo's "extension point" convention — new categories
   can be added without a migration. Shape:
   `{ individual, spouse, children, parent, medicalInsurance, lifestyle, education, other, remarks }`.

2. **`tp1_amount` REMAINS the authoritative roll-up.** On every save/submit the server computes
   `tp1_amount = round2(sum of the numeric categories)` and stores it alongside the breakdown. The client
   never sends the total. The PCB kernel keeps reading `tp1_amount` (the single LP input) — categories
   never reach the kernel — so **the MTD math is byte-identical** whether a given total arrived as a
   scalar or a breakdown. Guarded by a byte-stability test (C.7) that routes a breakdown-sum through the
   SUBMIT → prefill → generatePayslips path and asserts the PCB equals the scalar case to the cent.

3. **Validation.** Each category is non-negative + finite + 2dp-rounded. Where we have a **sourced**
   statutory cap it is enforced: `individual` ≤ RM 9,000 and `spouse` ≤ RM 4,000 (`MY_RELIEFS`, LHDN 2026
   MTD projection reliefs, VERIFIED). The SUM stays under the existing `TP1_MAX` sane ceiling. Categories
   with **no sourced cap** (medical/insurance, lifestyle, parent, education, other) get the non-negative
   check ONLY — inventing caps would violate ADR-0008 (no unsourced statutory number). `children` is NOT
   flat-capped because `MY_RELIEFS.perChild` is per-unit; a sourced aggregate rule is a follow-up.

4. **Append-only shape + events unchanged.** The `saveTp1Draft` / `submitTp1` writers keep the
   draft-in-place / submit-appends pattern and the `tp1.draft.saved` / `tp1.submitted` events. Empty
   category = 0 (optional-with-zero-default) — TP1 categories are optional by nature.

5. **PDPA Layer-0 (ADR-0030) unchanged.** Category amounts live ONLY on the RLS-protected `tp1_relief`
   row. The tp1.* event payloads reference row id + year + changed FIELD names (`['tp1Amount','categories']`)
   — never cleartext amounts. Guarded by test C.9.

6. **Ownership — employee-declared (recommendation from the plan's open question 1).** The structured
   record lives on the self-declaration store; `personId` is still resolved from `ctx.personId` ONLY and
   RLS (`app.can_see_person`, self + admin) confines every read/write. HR-driving-on-behalf (an
   admin-supplied `personId` parameter + guard) is NOT built in this pass — it is a small, cleanly-scoped
   follow-up if the reporter insists HR must key it for staff.

## Consequences

- Each employee now has an auditable, per-category TP1 record per year that matches the paper form.
- The kernel, `prefillTp1FromSelfRelief`, `setPayrollDeductionInput`, and the admin per-batch TP1
  deduction screen are **untouched** — the roll-up approach is precisely what keeps them stable.
- **Deferred (named follow-ups):** (a) sourced 2026 caps for medical/lifestyle/parent/education/other;
  (b) HR-on-behalf entry; (c) PDF export-back of the completed form (the ticket marks it optional; no PDF
  tooling exists in the repo today).
