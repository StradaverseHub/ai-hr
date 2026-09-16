# Monthly payroll runbook

**Readiness 2.3.** Written 2026-09-17 (r296) against `main`, from the code rather than from memory: every
step below names the action that performs it, and every claim about what is and is not automatic was
checked by finding the callers.

**Why this document exists.** Several steps that feed money into a payroll run happen **only if a human
presses a button**. Nothing schedules them, nothing warns when they are skipped, and a run that skipped one
looks exactly like a run that did not need it. `packs/attendance/index.ts:33-37` records the first of these
as acknowledged debt. Until they are automated, the runbook IS the control — so it has to be followed, not
merely filed.

---

## Before you start

| Check | Why |
|---|---|
| Attendance for the period is final | Steps 2 and 3 read it. Correcting attendance afterwards does **not** flow through — see §Recompute |
| Cut-off and pay day are configured for the company | `company_payroll_config` is empty by default, in which case the cut-off silently resolves to the plain calendar month and pay day to month-end (readiness 2.4) |
| Every employee has TIN, EPF, SOCSO and bank account | The CP39 builder throws on a missing TIN, and Borang A/8A block the download. Better to find this now than at filing (readiness 2.2) |

---

## The sequence

Steps marked **MANDATORY-MANUAL** have no scheduler and no reminder. Skipping one produces a payroll run
that is wrong in a way the system will not tell you about.

### 1. Generate the batch
`generateAction` — creates the draft batch for the period.

### 2. Recompute attendance — MANDATORY-MANUAL if anything changed
`/attendance/recompute`. **This page has no navigation row**; it is reachable only by typing the URL.
Nothing recomputes attendance after a shift change, a roster change or an attendance-rule change — there is
no scheduled recompute anywhere in the codebase (`core/attendance-recompute.ts` is called only from
`app/attendance/recompute/actions.ts` and `app/attendance/page.tsx`).

**Do this whenever any of these changed during the period:** shift definitions, rosters, schedule groups /
attendance rules, holiday calendars, or an employee's shift arrangement.

**If you skip it:** overtime and lateness are computed from stale attendance, and step 3 then carries the
stale figures into payroll.

### 3. Prefill overtime from attendance — MANDATORY-MANUAL
`prefillOvertimeAction` → `prefillOvertimeFromAttendance`. Its **only** caller is that button
(`app/payroll/actions.ts:179`).

**If you skip it:** overtime earned in the period is simply absent from the payslip. No warning, no
zero-line, nothing — the run completes and looks normal.

### 4. Transfer attendance allowances — MANDATORY-MANUAL
`transferAllowancesAction` → `transferAllowancesToBatch`. Only caller: `app/payroll/actions.ts:318`.

**If you skip it:** attendance-derived allowances are absent from the payslip, the same silent way.

### 5. The remaining prefills, as they apply
`prefillShiftDifferentialAction`, `prefillClaimsAction`, `prefillLoansAction`,
`prefillFixedZakatAction`. Each is a button; each is silent if skipped. Run the ones your company uses,
every month, rather than deciding case by case — deciding case by case is how one gets missed.

### 6. Review the anomaly findings
`evaluateAnomaliesAction`. **Read the threshold disclosure on that screen before trusting a verdict**: any
threshold marked "shipped default" is a placeholder with no empirical basis (r292 made this visible;
`core/payroll-anomaly.ts` says so itself).

### 7. Close
`closeAction`. Closed payslips are immutable at the database trigger.

---

## Correcting a closed month

There is **no** `paid`, `reversed` or `void` status and no contra (readiness 3.4). The only path is
unlock → reset → regenerate → re-close, and **reset DELETES the payslips**. Both
`PAYROLL_UNLOCK_ENABLED` and `PAYROLL_RESET_ENABLED` are currently **on** in production.

Before a customer deployment, decide whether they stay on. Before using them on a month that has been
**filed**, understand that the filing record (r293's `submitted` / `amended` states) refers to figures you
are about to delete.

---

## What would retire this document

Automating steps 3 and 4 — a `PayrollInputContributor` for attendance, which `packs/attendance/index.ts`
already names as the intended home — and either scheduling the recompute or making a stale-attendance
batch refuse to close. Until then, **this runbook is the control**, and a run that skipped a step is
indistinguishable from one that did not need it.
