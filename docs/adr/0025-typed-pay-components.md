# ADR-0025 — Typed pay components

Status: **Accepted — building, GATED OFF behind `TYPED_PAY_COMPONENTS_ENABLED`.** (2026-06-17)
Consultant item #9 (Wave 3). Design + decisions: `docs/wave34-design.md`. Statutory flag defaults:
`docs/architecture/MY-pay-component-treatment-matrix.md`.

> Until the flag is on, payroll computes exactly as today (basic + one allowance + OT + bonus + claims).
> The component tables can be populated and back-filled with the flag off; the kernel only *reads* them
> when the flag is on, and the backfill is proven **byte-identical** before that ever happens.

## 1. Context

Today earnings are `compensation.basicSalary` + a single `monthlyAllowance`, plus per-batch
`overtimeAmount` / `bonusAmount` / `claimAllowance`. One catch-all allowance; no way to list components
separately or carry per-component statutory treatment. The consultant (#9) wants configurable
**Allowance / Deduction / Contribution / Non-Payable** items, each with its own EPF / SOCSO-EIS / PCB /
HRDF treatment. The reason this is non-trivial is the four distinct statutory "wages" definitions — a
component can be EPF-liable but SOCSO-exempt (bonus), or SOCSO-liable but EPF-exempt (overtime, service
charge), etc. (see the treatment matrix).

## 2. Decision

A three-table typed model, with each component carrying **treatment flags** that drive which statutory
bases it feeds. The flags default from the verified matrix; admins can override per component.

```
pay_component                       (tenant catalog; admin-write, tenant-read)
  code, name, kind (allowance|deduction|contribution|non_payable)
  included_in_epf, included_in_socso_eis, included_in_pcb, included_in_hrdf_base   (treatment flags)
  is_non_payable   (BIK/perquisite: taxable but not paid in cash)
  prorates         (mid-period proration applies)
  archived_at
  UNIQUE (tenant_id, code)

employment_pay_component            (recurring per employee; effective-dated like compensation)
  employment_id, component_id, amount, valid_from, valid_to, recorded_at, superseded_at
  RLS: admin-or-self (amounts are pay — Wave 1 #5)

payroll_batch_component             (one-off per batch run)
  batch_id, employment_id, component_id, amount, notes
  UNIQUE (batch_id, employment_id, component_id)
  RLS: admin-only (like payroll_input)
```

**Kernel (gated).** With `TYPED_PAY_COMPONENTS_ENABLED`, `generatePayslips` rolls up each employee's
recurring + one-off components and derives the statutory bases **from the flags**:
`epfWage = Σ(included_in_epf earnings)`, `socsoEisWage = Σ(included_in_socso_eis)`,
`pcbWage = Σ(included_in_pcb)`, `hrdfBase = Σ(included_in_hrdf_base)` — preserving the exact agency split
the calculator already encodes (EPF excludes OT, SOCSO includes OT, HRDF = basic + fixed allowances).
`is_non_payable` components add to the PCB base but not to cash gross/net. Deductions reduce net only.
With the flag **off**, the kernel reads `compensation` + `payroll_input` exactly as today.

## 3. Treatment-flag defaults (seeded catalog)

Seeded from `MY-pay-component-treatment-matrix.md` (EPF / SOCSO-EIS / PCB / HRDF):

| Code | Kind | EPF | SOCSO/EIS | PCB | HRDF |
|------|------|:--:|:--:|:--:|:--:|
| BASIC | allowance | ✓ | ✓ | ✓ | ✓ |
| HOUSING (fixed) | allowance | ✓ | ✓ | ✓ | ✓ |
| COLA (fixed) | allowance | ✓ | ✓ | ✓ | ✓ |
| TRAVEL_FIXED | allowance | ✗ | ✗ | ✓* | ✗ |
| SHIFT | allowance | ✓ | ✓ | ✓ | ✗ |
| ATTENDANCE | allowance | ✓ | ✓ | ✓ | ✗ |
| OVERTIME | allowance | ✗ | ✓ | ✓ | ✗ |
| BONUS | allowance | ✓ | ✗ | ✓ | ✗ |
| COMMISSION | allowance | ✓ | ✓ | ✓ | ✗ |
| CLAIM (reimbursement) | allowance | ✗ | ✗ | ✗ | ✗ |
| BIK | non_payable | ✗ | ✗ | ✓ | ✗ |

`*` conditional in the matrix (Schedule 6 thresholds) — seeded as PCB-liable with a note; the exemption
amounts stay a documented open item, not auto-applied (see the matrix caveats).

## 4. Gating + byte-identical backfill

- Flag **`TYPED_PAY_COMPONENTS_ENABLED`** (env, default false).
- Backfill (flag-agnostic data): seed `BASIC` + `ALLOWANCE` recurring components from
  `compensation.basicSalary` / `monthlyAllowance`; `OVERTIME` / `BONUS` / `CLAIM` batch components from
  `payroll_input`. Every existing payslip must reproduce **byte-identical** when the flag flips on.
- A compat test (`test/typed-components-compat.test.ts`) runs the same batch with the flag on and off
  and asserts identical payslip columns + `statutory`. The flag is not enabled in production until that
  passes and an accountant has reviewed a sample.

## 5. Scope for v1 / out of scope

- **In:** earning components (the byte-identical path), the catalog + flags, recurring + one-off values,
  the admin UI. Deductions reduce net; non-payable adds to the PCB base only.
- **Out (later):** GL-account / cost-center per component, per-component proration policy beyond the
  `prorates` flag, the Schedule-6 conditional-exemption amounts (documented in the matrix), and treating
  a component differently per company.

## 6. Consequences

- A real, per-component payslip with correct, sourced statutory treatment; the foundation for cost
  allocation and GL posting later. Larger surface (3 tables × 6 flags) mitigated by the matrix-sourced
  defaults, the flag gate, and the byte-identical compat test before any tenant is switched over.
