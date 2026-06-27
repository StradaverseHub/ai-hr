# ADR-0057 — CP38 Deduction (LHDN instalment instruction)

Status: Accepted (1.2.3)
Date: 2026-06-27

## Context
CP38 is a court/LHDN-ordered instalment deducted from an employee's pay each month *in addition to*
monthly MTD/PCB. It was already a first-class field in the CP39 e-Data file (`cp38Cents` / `cp38Records`
in `localization/my/cp39-file.ts`) but hardcoded to 0 ("we do not track CP38"). The feature: make CP38 a
real, period-effective per-employment record that auto-applies by payroll month, flows onto the payslip
and into the CP39 statutory file, and is manageable (view / edit / terminate) before processing.

## Decision

### Dedicated effective-dated table, not a typed pay-component
CP38 is a dedicated `employee_cp38` table (migration 0117) rather than a `kind:'deduction'` pay-component:
1. The kernel's deduction-folding (`en.deduct`) lives only in the gated `TYPED_PAY_COMPONENTS_ENABLED`
   path; CP38 must work flag-independent.
2. A pay-component deduction collapses into `otherDeductions` with no code/ref carried into `statutory`,
   so it could not populate the CP39 `cp38` field distinctly from MTD. CP38 needs a CP39-distinct line +
   its own LHDN ref + period lifecycle.

### Supersede-on-write + gist EXCLUDE (mirrors `compensation`)
Effective dating uses the project's verified convention (`core/comp.ts` `setCompensation`): read the open
row, close it (`validTo`), insert a new open row — backed by a Postgres `EXCLUDE USING gist (... daterange
... WHERE superseded_at IS NULL)`. No app-level overlap check; the constraint makes a silent duplicate
garnishment (a compliance hazard) structurally impossible even under concurrent writes.

### Month-aligned
The feature is "by year and month". `validFrom`/`validTo` are `date` but the service normalises any input
to the first of its month; `cp38ForPeriod` compares against the period's month bucket. A mid-month
instruction charges the whole month it starts in.

### Auto-apply, regular-run only
`generatePayslips` loads `cp38ForPeriod` and folds the instalment once into `slipExtraDeduct`
(→ `otherDeductions` → `totalDeductions`/`net`) and stamps `statutory.cp38` + `statutory.cp38Ref` as the
distinct CP39 source. Like basic/OT/unpaid/HRDF, an additional run (off_cycle/bonus/adjustment) carries
`cp38 = 0` — so a regular + bonus run in one month charges exactly one instalment, and CP39 summing across
the period's runs single-counts.

### Processed-period guard
`updateCp38` / `terminateCp38` refuse if a non-draft payslip already covers a month the record touches
(`Cp38PeriodProcessedError`). The frozen payslip snapshot stays authoritative for CP39/EA.

### Audit ⊥ PDPA (ADR-0030 Layer 0)
Every write appends a DomainEvent (`employee-cp38.added/updated/terminated`) carrying refs + dates only —
never the cleartext amount, which lives on the aggregate row.

## Out of scope (deferred)
- EA Part-D annual CP38 line — deferred to the future slice that lights up all five intentionally-deferred
  EA Part-D lines together (CP38 already flows into the `statutory.cp38` substrate for it).
- Bulk CSV import of CP38; cumulative-cap / running-balance auto-stop (the requirement expresses different
  amounts via explicit period rows, not a balance); a CP38 column on the PCB/CP39 *view* report.
