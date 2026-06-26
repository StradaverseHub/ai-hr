# ADR-0050 — Self Personal Tax Relief (LHDN TP1), yearly self-service + PCB divisor fix

Status: Accepted · 2026-06-26 · Feedback #1.1.3 (panel-refined)

## Context

Employees may claim optional personal tax reliefs (LHDN form **TP1**) — life insurance, medical,
lifestyle, education fees, etc. — which reduce monthly PCB/MTD (the **LP₁** term in the LHDN
computerised method, STATUTORY-SOURCES §E). Today the only way TP1 reaches PCB is an admin keying
`payroll_input.tp1_deduction` per batch. There is no employee self-service to declare the relief once
per assessment year and have it flow into payroll automatically, and there is no per-year record the
employee can maintain or review historically.

The panel converged on three load-bearing facts, all confirmed in code:

1. **The naive `annual/12` monthly feed is a real PCB bug.** `core/payroll.ts` SUMS each month's
   `st.lp` into `acc.lpAccumulated` when replaying prior payslips (`acc.lpAccumulated = round2(acc.lpAccumulated + Number(st.lp ?? 0))`),
   and the kernel passes `lp = acc.lpAccumulated + lpCurrent` into the calculator
   (`localization/my/payroll.ts`: `const lp = (acc.lpAccumulated ?? 0) + (p.lpCurrent ?? 0)`). Feeding
   `annual/12` every month makes the cumulative relief grow linearly and **over-relieves by December**.
   The feed convention is therefore a hard, sourced decision (this ADR), not a coded guess.
2. **`setPayrollInput` is a full-row overwrite** (`core/payroll.ts`: it writes
   `overtimeAmount/bonusAmount/tp1Deduction/zakat` unconditionally), so a TP1-only prefill through it
   would zero bonus/OT/zakat. The auto-feed uses the **targeted `.update(payrollInput).set({ tp1Deduction })`**
   pattern from `prefillClaimsForBatch`, never `setPayrollInput`.
3. **Bespoke `superseded_at` versioning is scope-creep.** We use the existing append-only request-row
   pattern (`profileChangeRequest` / `resignationRequest`: a `status` enum + `orderBy(desc(createdAt))`).
   Per-year isolation falls out of the `(person, assessmentYear)` WHERE clause; history falls out of
   never deleting + the DomainEvent log.

## Decision

A new per-`(person, assessmentYear)` table `tp1_relief` storing a **single annual scalar** `tp1_amount`
(this is exactly the one number the PCB kernel consumes), keyed by `personId` because TP1 is the
employee's own personal statutory declaration. The employee maintains it on `/me/tax-relief`
(self-service, no HR approval — the DomainEvent log is the audit trail). The **latest submitted** row
for an assessment year feeds monthly PCB through a new draft-batch prefill.

### 0.1 Monthly-feed convention (the #1 correctness item) — **(b) delta method, VERIFIED**

Because `lpAccumulated` SUMS each month's `st.lp`, the prefill must feed the **delta** between the
declared annual amount and the LP already accumulated this assessment year, so that across the year
`∑LP + LP₁ = annual` exactly once:

```
feed = max(0, annual_tp1Amount − ∑LP_already_accumulated_this_year_for_the_paymaster_employment)
```

`∑LP` is read by replaying prior payslips' `st.lp` — the SAME source the kernel uses
(`core/payroll.ts` PCB-accumulator replay). The delta method is the only convention that is
simultaneously correct under **mid-year adoption**, **re-run / idempotency**, and **mid-year
correction** (0.2/0.4). Worked example (RM4,800 declared annual, monthly RM4,000 wage, Jan–Dec):

- Months Jan–May already run with manual TP1 RM200/mo ⇒ `∑LP = 1,000`.
- June draft prefill feeds `max(0, 4,800 − 1,000) = 3,800` as June's LP₁.
- After June, `∑LP + LP₁ = 1,000 + 3,800 = 4,800` = the declared annual, claimed once. ✓

If the delta is negative (prior manual LP₁ already exceeds the new declaration) the prefill feeds 0.

### 0.2 Mid-year adoption / no double-count
Prior manually-keyed `tp1_deduction` is already stamped on earlier payslips and lives in `∑LP`. The
delta in 0.1 makes manual-then-auto coexist without double-counting.

### 0.3 Prospective-only / closed-batch immutability
A TP1 submitted/corrected mid-year affects only **open/draft** batches; it never mutates closed
payslips. The cumulative method self-corrects by year-end via `∑LP` + the delta. The prefill guards
`batch.status === 'draft'` and throws `BatchNotDraftError` (mirroring `prefillOvertimeFromAttendance`).

### 0.4 Provenance / refresh — **store a provenance marker on `payroll_input`**
To distinguish "a prior TP1 prefill set this" from "an admin manually overrode it," `payroll_input`
gains a nullable `tp1_source` flag (`'tp1_self' | null`). A row whose `tp1_source = 'tp1_self'` is
**refreshable** by a later prefill; a row last set by the admin form (`tp1_source = null`, the default,
as `setPayrollInput` / `setPayrollDeductionInput` leave it untouched) is **sticky** and survives a
re-prefill. Both directions are tested.

### 0.5 Multi-employment routing (Chin Hin anchor, ADR-0029)
`tp1_relief` is keyed by `personId`; `payroll_input.tp1_deduction` is per-employment. A person with ≥2
active employments has ONE annual relief that must hit PCB exactly once. In the default
designated-paymaster mode the feed is routed ONLY to `person.designated_paymaster_employment_id` (when
set; else the single employment in the batch). Other employments of the same person in the batch are
skipped (left at 0). Group-coordinated aggregation mode is not in scope here (no aggregation path runs
in the per-employer kernel today).

### 0.6 Assessment-year ↔ pay-period mapping
Assessment year = the **year of `batch.payPeriod`** (Jan–Dec MY tax year), for both regular and
additional/off-cycle runs (an additional run belongs to its parent pay-period's year). Tested.

### 0.7 Approval posture
The employee self-submits TP1 without HR approval — it is the employee's own statutory declaration; the
DomainEvent log (`tp1.draft.saved` / `tp1.submitted`) is the audit trail. `can_see_person` grants
self + global-admin only (NOT HR-in-subtree) — an acceptable conscious choice for a personal statutory
declaration. HR-in-subtree visibility would be a separate read addition (out of scope).

### Data model
`tp1_relief` (`person_id`, `assessment_year` int, `status` enum `tp1_status` draft|submitted,
`tp1_amount` numeric(12,2) default 0, `submitted_at` timestamp nullable, append-only request-row shape).
Latest row per `(person, year)` via `orderBy(desc(createdAt))`; the editable draft for a year is
UPDATEd in place; a submitted row is immutable and a correction is a new submitted row (latest wins).
RLS `USING / WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_person(person_id))`.

### PDPA Layer-0 (ADR-0030)
The `tp1.*` event payloads reference the `tp1_relief` row id + assessment year + field names — never
the cleartext `tp1_amount`. The amount lives only on the RLS-protected row (and on `payroll_input` once
fed). Mirrors `payroll-batch.input-set`.

## Out of scope (flagged, not built)
- Per-category LHDN TP1 catalogue (~20 categories with sourced 2026 caps + per-line validation + dynamic
  per-category i18n labels). v1 is a single annual scalar; the breakdown is a clean follow-up that only
  changes capture/validation, not the kernel seam.
- LHDN electronic TP1 e-submission; supporting-document upload; HR-in-subtree visibility; HR approval gate.

## Consequences
- The kernel divisor bug is structurally avoided: nothing ever feeds `annual/12`; the prefill feeds the
  delta so `∑LP + LP₁` converges to the declared annual.
- A module fully on the DomainEvent substrate (self + admin readable), per CLAUDE.md substrate discipline.
