# ADR-0021 — Claims module (employee expense / benefit claims)

Status: **Accepted** · Date: 2026-06-16

## Context

The HRMS needs a **claims module**: an employee submits an expense or benefit claim (with a receipt), a
manager/HR approves it, and the approved amount becomes money. The product already has every structural
pattern this needs — the design reuses them rather than inventing infrastructure:

- **Request lifecycle** — `leave_request` / `attendance_correction` / `profile_change_request` (status enum,
  `decided_by_employment_id` / `decided_at`) gated by `assertCanDecide` (self-approval ban + active
  administrative-reporting-line check), each transition appending domain events.
- **Effective-dated catalog + policy** — `leave_type` + `leave_policy` (inline admin editor, CLOSE+INSERT
  versioning) is the template for a claim-type catalog with optional budgets.
- **Attachments** — the KB `bytea` + size-cap + sanitized streaming-download pattern.
- **Payroll input seam** — `generatePayslips` already consumes `payroll_input` lines (overtime/bonus/TP1/
  zakat) as separate tax-classified categories, and the OT-prefill step shows how an approved upstream
  artifact lands as a payroll line.
- **Off-cycle payout** — the existing payment-summary CSV export (manual bank upload).

### Owner decisions (2026-06-16)

1. **Payout — Hybrid (tax-correct).** Non-taxable reimbursements (receipted business expense) are paid
   **off-cycle** via a reimbursement export and never touch payroll; taxable allowances/benefits flow into
   the **next payslip** so PCB/EPF/SOCSO/EIS are computed on the right base.
2. **Tax — Flat (HR decides per claim).** No built-in MY exemption engine. Each claim carries a `taxable`
   boolean, **defaulted from the claim type** and **confirmable/overridable by the approver**. That boolean is
   the single routing signal for the hybrid payout. No per-claim sourced tax rules and no exemption-cap
   automation in v1 (deferred — see Risks).
3. **Catalog — Configurable + optional budgets.** Admin-managed claim types with an optional effective-dated
   per-type **annual budget** and **per-claim cap**, mirroring leave entitlement/policy.

## Decision

### 1. Data model (tenant-scoped, RLS)

- **`claim_type`** — `(id, tenant_id, code unique-per-tenant, name, default_taxable boolean, requires_receipt
  boolean default true, archived_at, created_at)`. The catalog (medical, travel/mileage, meals,
  phone/internet, professional development, misc). `default_taxable` seeds each claim's `taxable`.
- **`claim_policy`** — `(id, tenant_id, claim_type_id, annual_budget numeric(12,2) null, per_claim_cap
  numeric(12,2) null, valid_from date, valid_to date null, created_at)`. Effective-dated (CLOSE+INSERT on
  change). NULL = unlimited. Optional — a type with no policy is uncapped.
- **`claim_request`** — `(id, tenant_id, employment_id, claim_type_id, amount numeric(12,2), incurred_on
  date, description, taxable boolean, status claim_status, decided_by_employment_id, decided_at,
  payroll_batch_id null, paid_at null, payout_ref text null, created_at)`.
  `claim_status = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'paid'`. `taxable` is captured at
  submit (from the type) and is the approver's to confirm. `payout_method` is **derived**, not stored:
  `taxable ⇒ payroll`, `non-taxable ⇒ reimbursement`.
- **`claim_attachment`** — `(id, tenant_id, claim_request_id, content bytea, file_name, mime_type,
  size_bytes, uploaded_by_user_id, created_at)`. Receipts — the KB storage pattern, but a **dedicated,
  claim-scoped table** (KB docs are tenant-wide; receipts are per-claim and follow the claim's RLS).

### 2. Lifecycle + authorization

`submit → pending → (approve | reject) ; approved → paid ; pending/approved → cancelled`. Mirrors the leave
request service:
- **Submit** (employee, for their own employment): validate against the active policy — `per_claim_cap`
  (single claim ≤ cap) and `annual_budget` (year-to-date approved + this ≤ budget, computed from prior
  approved claims of the type); enforce `requires_receipt` (≥1 attachment). Append `claim-request.submitted`.
- **Decide** (manager/HR): `assertCanDecide(tx, ctx, employment_id, 'claim')` — the exact self-approval ban +
  active-administrative-line gate used for leave. Re-check the budget at approval (the source of truth, since
  other claims may have approved since submit). Set status + `decided_by` + `decided_at`; append
  `claim-request.approved` / `.rejected`.
- **Cancel** (claimant while pending, or admin) → `claim-request.cancelled`.
- Every write appends a `DomainEvent` (`aggregateType: 'claim-request'`, `subjectEmploymentId: employment_id`
  for RLS read-scoping) in the same transaction.

### 3. Payout — hybrid, derived from `taxable`

- **Non-taxable ⇒ reimbursement (off-cycle).** Approved non-taxable claims surface in a **"Reimbursements
  due"** admin view and aggregate into a **reimbursement payment export** (bank CSV, reusing the
  payment-summary pattern). Exporting marks the claims `paid` with `paid_at` + a `payout_ref`. Reimbursements
  **never enter payroll** (a repayment of business expense is not income).
- **Taxable ⇒ payroll allowance line.** Approved taxable claims are **prefilled into the next draft payroll
  batch** for the employee's company (the same affordance as OT prefill): their sum lands in a new
  `payroll_input.claim_allowance numeric(12,2)` column, which `generatePayslips` adds to the **taxable
  allowance base** (alongside `allowance` → contributes to PCB/EPF/SOCSO/EIS exactly like a regular monthly
  allowance). The claim row gets `payroll_batch_id`; when the batch **processes**, the claim → `paid`. No
  open draft batch ⇒ the claim waits (visible as "pending payout"). The payslip shows a **Claims allowance**
  line; per-claim payslip detail is a follow-up nicety.

> Why taxable claims ride the standard allowance base: under "flat", the engine makes no finer
> EPF-exemption distinction — a taxable cash allowance is treated like any monthly allowance (the
> conservative, contribution-inclusive default). Finer per-type contribution rules are deferred with the rest
> of the tax automation.

### 4. The localization pack barely changes

Because tax is flat, the MY pack needs **no claim tax-intelligence**. The only payroll change is that
`generatePayslips` folds `payroll_input.claim_allowance` into the existing taxable allowance term — a generic
kernel change, jurisdiction-neutral. A later `myPack.claims` (exemption classification + caps) is the upgrade
path, not a v1 requirement.

### 5. RLS

- `claim_type` / `claim_policy`: tenant-isolated; SELECT to all members; write admin-only.
- `claim_request`: tenant-isolated; SELECT via `app.can_see_employment(employment_id)` (employee sees own,
  manager sees reports, admin sees all); INSERT by the claimant for their own employment; decide/pay writes
  admin-or-manager (RLS + the service `assertCanDecide`).
- `claim_attachment`: SELECT/visibility follows the parent claim (`can_see_employment` via the claim);
  INSERT by the uploader on their own claim; DELETE admin-only.
- `payroll_input.claim_allowance` inherits the existing payroll_input RLS (admin-write, draft-only).

### 6. Module build order (per CLAUDE.md vertical-slice discipline)

Schema migration (+ RLS migration, journal-registered) → `core/claims.ts` service injecting
`appendEvent` from the first commit → server actions passing the `@CurrentUser` actor → frontend:
employee `/claims` (submit + my claims), admin reimbursements + claim-config, and **plug the claim approval
into the existing `/approvals` inbox**.

## Consequences

- One coherent claims surface that reuses five proven patterns; the only genuinely new kernel behaviour is a
  taxable-allowance payroll line and a reimbursement export.
- The substrate is universal: every claim transition is a domain event (audit, the Self-Improvement Loop, the
  approvals inbox, scorecards all see claims for free).
- Reimbursements are correctly out of payroll; taxable claims are correctly in the PCB base — without a tax
  engine, because HR makes the taxable call per claim.
- Closed/processed payroll batches stay immutable; a claim paid via payroll is pinned to its batch.

## Implementation slices

1. **Schema + RLS** — `claim_type` / `claim_policy` / `claim_request` / `claim_attachment` +
   `payroll_input.claim_allowance`; migrations + RLS + journal; privilege/visibility tests.
2. **Catalog + policy service & admin UI** — claim-type CRUD + effective-dated budgets (mirror leave config),
   events.
3. **Claim lifecycle service** — submit (policy/cap/receipt validation) / decide (`assertCanDecide` + budget
   re-check) / cancel + events; receipts upload/download (KB pattern); tests.
4. **Employee UI** — `/claims` submit form + receipt upload + "my claims" list/detail; plug approval into
   `/approvals`.
5. **Payout** — taxable: claim-prefill into a draft batch + `generatePayslips` folds `claim_allowance` into
   the taxable base + mark-paid on process; non-taxable: "Reimbursements due" + bank-CSV export + mark-paid.
   Equivalence test: no claims ⇒ payroll byte-identical.
6. **Verify + tests + merge.**

**Status: implemented (all 6 slices).** Payout landed as designed — `prefillClaimsForBatch` queues approved
taxable claims onto a draft batch (`claim-request.queued-for-payroll`), `generatePayslips` folds
`claim_allowance` into the non-prorated taxable allowance line and marks the linked claims `paid` on process
(`claim-request.paid`, `via: payroll`); non-taxable claims flow through `listReimbursementsDue` →
`reimbursementCsv` (read-only bank file) → `markReimbursementsPaid` (`via: reimbursement`). Equivalence is
structural: `claim_allowance` defaults `0`, so a batch with no prefilled claims is byte-identical (covered by
`test/claims-payout.test.ts`). Side-fix: the `/payroll/[batchId]` page referenced a `payroll.batch` i18n
namespace that was never added in the ADR-0016 extraction (the whole page rendered raw fallback keys) — added
the full namespace to `messages/en.json` while wiring the "Prefill claims" affordance.

## Alternatives considered (the rejected forks)

- **All-through-payroll payout** — rejected: forces receipted reimbursements (not income) through the monthly
  cycle and onto payslips, delaying repayment and muddying the "is this taxable" line. Hybrid keeps
  reimbursements off payroll where they belong.
- **All-separate payout** — rejected: taxable claims would need a manual PCB adjustment, re-introducing the
  exact compliance risk the payroll engine exists to remove.
- **Full exemption-cap tax engine now** — deferred: sourcing every MY exemption (travelling RM6k/yr, medical,
  childcare, meal/parking, BIK prescribed values) + per-employee annual cap tracking with PCB spillover is a
  large, statutory-sourcing-heavy build. Flat-per-claim ships a correct, auditable system now and leaves a
  clean upgrade seam (`myPack.claims`).
- **Receipts in `kb_document`** — rejected: KB docs are tenant-wide shared knowledge; receipts are per-claim
  PII with the claim's visibility rules. A dedicated `claim_attachment` table keeps the RLS honest.

## Risks / deferred

- **Operator carries the tax call.** "Flat" means a wrong taxable/non-taxable decision produces a wrong (and
  non-compliant) outcome. The UI must surface the claim type's `default_taxable` and a clear taxable toggle at
  approval; the per-claim `taxable` is audited in the event log. Document that the engine validates shape, not
  gazette-correctness — the same posture as ADR-0019.
- **Deferred (clean upgrade path):** sourced MY exemption classification + annual-cap tracking with taxable
  spillover into PCB (`myPack.claims`); EA/EA-form BIK reporting of taxable benefits; per-claim line-item
  detail on the payslip; multi-currency claims (v1 is MYR); MyInvois self-billed e-invoice for reimbursements.
