# ADR-0059 — EA Data Overwrite (EA-only amendment layer)

Status: Accepted (1.2.6)
Date: 2026-06-27

## Context
The annual EA (C.P.8A) Statement of Remuneration is a **pure derived read** — both the HTML page
(`app/payroll/reports/ea/[employmentId]/page.tsx`) and the PDF (`lib/ea-pdf.ts` via
`app/me/ea/[employmentId]/pdf/route.ts`) go through `employeeEaStatement()` → the MY pack's
`eaStatement()` (`localization/my/reports.ts`), which sums the year's payslips. Authorized HR sometimes
needs to overwrite/amend specific EA-form figures (employment income, allowances, bonus, tax deduction,
statutory values) — e.g. an arrears or correction known only at filing — **without touching the original
payroll records**, and have the change reflected **only** in the generated EA form.

## Decision

### EA-only override layer (no payroll mutation)
A per `(employmentId, year, field)` table `ea_override` (migration 0119) holds the amended amount. The
read overlays each row onto the payroll-derived figure inside `eaStatement()`; `payslip` / `payroll_input`
are never written. So amendments affect **only** the EA form — not payroll, not CP8D / Form E (which read
payslips directly), not any other surface. A user-facing note states this on the EA page.

### In-scope fields (8)
Part B `grossSalary`, `bonus`, `allowances`, `gross`; Part D `mtd`; Part E `epf`, `socso`, `eis`. BIK /
VOLA / tax-exempt allowances are **out of scope** (no source figure today — a distinct follow-up).

### Gross-total consistency (load-bearing)
After overlaying component overrides, `partB.gross` is **recomputed** from the post-overlay
`grossSalary + bonus + allowances` so the printed Part B lines always sum to their own total — UNLESS an
explicit `gross` override row exists, in which case that wins (HR may set a known total directly).

### Modelled on `statutory_component_override`, NOT a pgEnum
`field` is a plain `text` discriminator validated in TS against `EA_FIELDS as const` (mirrors the
pay-components precedent). No `original_amount` snapshot (the derived baseline is recomputed live every
read; the audit "before" lives in the DomainEvent payload). No soft-delete / supersede lifecycle: a plain
upsert keyed on `(tenant, employment, year, field)`; `clearEaOverride` is a hard DELETE; the immutable
event log is the audit trail.

### RBAC: service guard + RLS backstop
The service (`core/ea-override.ts`) guards writes with `isAdmin` / `canManagePayroll` (primary). The
`ea_override` RLS is `USING can_see_employment` (the subject can read their own amended EA — the figures
land on their own form) and `WITH CHECK can_admin_employment` (only HR admins of the company write — the
SQL backstop). No approval / maker-checker workflow: HR amends directly, RBAC-gated.

### Substrate
Every write appends a DomainEvent in the same tx: `ea.override.set` / `ea.override.cleared` with
`subjectEmploymentId` and `{ field, before, after, reason }`. A no-op amend (amended == derived) is treated
as a clear.

## Consequences
- The EA form can carry HR amendments while payroll stays the source of truth.
- An "Amended" badge / footnote marks amended figures on both HTML and PDF. **Flagged for product /
  compliance sign-off:** whether the employee-facing EA PDF should disclose figures as "amended by HR" — an
  EA/C.P.8A is a statutory document the employee files with LHDN.
- Negative corrections are out of scope for v1 (`amount >= 0`); widen only if a real case appears.
