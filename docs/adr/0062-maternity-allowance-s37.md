# ADR-0062 — Maternity: separate the unconditional 98-day LEAVE from the conditional paid ALLOWANCE (EA s.37)

Status: Accepted (1.2.5)
Date: 2026-06-28

Addendum to ADR-0038 (Leave 2.0), the 2A-1 eligibility engine (#25), and ADR-0008 (MY localization pack).
Phase-B audit #13.

## Context

Maternity is seeded in `localization/my/leave.ts` as a single leave type: `MATERNITY`, `paid: true`,
`counting: calendar_days`, `eligibility: { gender: 'female' }`, 98 days (EA-1955 s.37 as amended by Act A1651,
2022). The female-only eligibility gate is correct, but `paid: true` is applied **flatly** to every maternity
request.

EA-1955 s.37 actually distinguishes two entitlements:

1. **The 98-day maternity LEAVE** — unconditional for a female employee. It is never gated beyond female-only.
2. **The paid maternity ALLOWANCE** — a *separate* entitlement that is **withheld** when EITHER:
   - **qualifying-service fails** — she must have been employed by the employer at ANY time in the **4 months
     immediately before** confinement AND for a total of **≥90 days in the 9 months immediately before**
     confinement; OR
   - **the 5th-child proviso** — she already has **5 or more surviving children** at the time of confinement
     (no allowance for the 5th+).

When the allowance is withheld, the leave is still granted, but the **period is unpaid** (no-work-no-pay for
those days), which must flow to payroll exactly like other unpaid leave so the EA / Form-E figures are right.
Before this change a non-qualifying employee (e.g. hired two weeks before confinement, or with a 5th surviving
child) was silently paid the allowance — a compliance error.

## Decision

### Separate the LEAVE from the ALLOWANCE; per-request override of the type's paid default

The maternity **leave-type** keeps `paid: true` as a *default*. The s.37 decision is computed **per request**
and OVERRIDES that default for maternity only:

- **Pure resolver** (`core/leave.ts → maternityAllowanceEligibility(hiredOn, confinementDate, survivingChildren)`)
  returns `{ eligible, reason?, qualifyingService }`:
  - qualifying service met AND `survivingChildren < 5` → `{ eligible: true }` (paid — current behaviour),
  - qualifying service **fails** → `{ eligible: false, reason: 'qualifying_service' }`,
  - qualifying met but `survivingChildren ≥ 5` → `{ eligible: false, reason: 'fifth_child' }`.
  Qualifying-service has precedence: when BOTH fail, `'qualifying_service'` is reported (it is the threshold
  check). Qualifying service = employed at any time in the 4 months before confinement (the employment
  `[hiredOn, …)` overlaps `[conf−4mo, conf)` iff `hiredOn < confinement`) AND ≥90 days employed inside
  `[conf−9mo, conf)`.

- **`requestLeave`** computes the decision for a `MATERNITY` request from `employment.hiredOn` + the supplied
  `confinementDate` + `survivingChildren`. When the allowance is **withheld**, `leave_request.allowance_eligible`
  is persisted `false`; the 98-day leave is still created, but it now reads as **unpaid** for the period.

- **Payroll** (`core/payroll.ts → unpaidDaysByEmployment`) already keyed off `leave_type.paid = false`. It now
  ALSO counts an approved request whose `allowance_eligible = false` — so a withheld-allowance maternity
  request drives the existing unpaid-days deduction with no new payroll plumbing. `allowance_eligible` TRUE /
  NULL on a paid type stays paid (the override only ever *removes* pay, never adds it).

### Belt-and-braces: missing inputs default to paid + a warning

If `confinement_date` / `surviving_children` are not supplied (legacy rows, or a UI not yet updated), the
service does **not** guess. It keeps the conservative current behaviour — leave **paid** (`allowance_eligible`
left NULL) — and returns `maternityAllowanceWarning: true` so HR is told the paid-allowance eligibility is
**unconfirmed** rather than silently wrong. This preserves every pre-existing maternity test.

### Schema (migration 0125, additive + nullable + backfill-safe)

`leave_request` gains:

- `surviving_children integer` — the count at confinement (maternity requests only),
- `confinement_date date` — the date qualifying-service is computed against,
- `allowance_eligible boolean` — the per-request override: TRUE = paid, FALSE = withheld/unpaid, NULL = not a
  maternity decision or inputs unconfirmed.

All three are NULL for every non-maternity / legacy row. They are reachable by the existing `leave_request`
FOR ALL tenant + `can_see_employment` policies (same inheritance as 0124's `unpaid_consent_*` and 0106's
`parent_group_id`), so they need **no new RLS policy** and the `ai_hr_app` DML grants cover them by
inheritance.

### Domain event

The `leave-request.submitted` event for a maternity request carries a `maternityAllowance` object —
`{ allowanceEligible, reason, qualifyingService, survivingChildren, confinementDate, unconfirmed }` — so the
decision is on the audit substrate (and the approver view re-reads `reason` off it). `unconfirmed: true` marks
the missing-inputs default.

### UI

The maternity request form captures `confinement_date` + `surviving_children` (optional — empty ⇒ paid +
warning). The approver inbox shows the computed allowance eligibility + reason on the maternity row (withheld /
paid / unconfirmed). All new strings are localized in the 6 locales.

## Consequences

- The 98-day leave remains unconditional; only the *pay* is now correctly conditional on s.37.
- Payroll is right by construction — withheld allowance flows through the single `unpaidDaysByEmployment`
  source of truth, no double entry.
- The conservative default keeps existing behaviour for rows without the new inputs and never silently
  under-pays; HR is warned to confirm.
- A future refinement could re-evaluate the decision at approval time (if `hiredOn` were backdated between
  submission and approval); v1 freezes it at submission, consistent with the EL split.

## Alternatives considered

- **A separate maternity-detail table.** Rejected — three nullable columns on `leave_request` are simpler,
  inherit RLS, and match the 0124 / 0106 precedent for point-in-time per-request facts.
- **Gating the leave itself when the allowance is withheld.** Rejected — unlawful; s.37 grants the 98-day
  leave regardless. Only the allowance is conditional.
- **A second UNPAID child (like Emergency Leave).** Rejected — maternity is a single 98-day absence, not a
  paid/unpaid split across dates; the whole period is simply unpaid when the allowance is withheld. The
  per-request `allowance_eligible` override is the minimal, correct model.
