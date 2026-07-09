# ADR-0056 — Individual Transaction (dated one-off payroll transaction ledger)

Status: Accepted
Date: 2026-06-27
Feature: 1.2.2 Individual Transaction

## Context

Spec 1.2.2 asks to record one-time (non-recurring) payroll transactions per employee — earnings /
deductions / overtime / unpaid / leave kinds — each tied to a transaction date, with a month + pay-cycle
selection, validated to fall in the selected period, processed only for that period (no carry-forward),
and viewable / editable / deletable before finalize.

`payroll_batch_component` cannot hold these: it is uniquely keyed `(batch, employment, component)` with no
date column (`db/schema.ts`), so it cannot store multiple dated one-offs of the same kind for one employee.
A dedicated table is therefore justified.

## Decision

1. **New table `payroll_individual_txn`** (migration `0116`): a pure dated ledger — `kind` (5-value enum) +
   `txnDate` + `amount` + descriptive `quantity`/`unit` + `notes`, scoped to one `batchId` and `employmentId`.
   No `componentId`, no per-kind columns — every kind stores uniformly.

2. **Month + cycle → batch mapping.** "Transaction month" is `payroll_batch.payPeriod` (`YYYY-MM`); "pay
   cycle" is `runType` + `runSeq` under a `pay_period` (ADR-0024). Selecting a month+cycle = selecting the
   target draft `payroll_batch`. The screen targets an existing draft batch; it does not create runs.

3. **No carry-forward is by construction.** A row belongs to exactly one batch via the `batchId` FK and
   nothing copies it forward. A test asserts a sibling batch's list is empty.

4. **Date-in-period = calendar-month bounds.** `txnDate` must fall within `[payPeriod-01, payPeriod-lastDay]`,
   derived with the same `daysInMonth` math the kernel uses (`core/payroll.ts`, now exported). Cutoff/cycle-
   aware windows (`payroll_config`) are a separate, deferred concern.

5. **Before-finalize = draft-only.** All writes reuse `BatchNotDraftError`; the screen only lists draft
   batches, and the service is the backstop.

6. **Substrate + RLS.** Every write appends a `DomainEvent` (`payroll.individual-txn.created/updated/deleted`)
   with redaction-safe payloads (references + kind, no cleartext amount — ADR-0030 Layer-0). RLS mirrors
   `payroll_input` (0099): tenant + `EXISTS(payroll_batch … can_admin_payroll_for(company_id))`, with the
   `WITH CHECK` re-deriving company from `batch_id` so a row can never reference a batch outside the actor's
   payroll-admin scope.

## Explicit deferral

This slice is **record / view / edit / delete only**. The ledger is **inert** with respect to computed pay —
nothing folds these rows into payslips, so `quantity`/`unit` are descriptive and read by no kernel math (a
byte-identical test guards this invariant). Kernel consumption is a separate future slice modeled on
`prefillClaimsForBatch` (`core/claims.ts`): resolve all 5 kinds to seeded componentIds, sum per
(emp, component) into one aggregate (`setPayrollBatchComponent` overwrites, so pre-summing is mandatory),
reconcile `unpaid` against leave-ledger-derived unpaid days, and add a flag-on zero-txn byte-identical guard.
That slice needs its own ADR and sign-off; no prose is pre-committed to its design here.

## Amendment (2026-07, feedback f1564110 Phase 2) — period-keyed rows; batch attachment is derived

The original decision required an existing DRAFT `payroll_batch` for every write (batch_id NOT NULL), which
dead-ended the keying screen when no run existed for the month, and a draft-batch delete destroyed the
keyed-in rows. Standard payroll practice is the reverse: one-off transactions are entered FIRST, the run is
calculated LAST. Migration `0175` therefore re-homes the row on the (company_id, pay_period) pair:

1. **`batch_id` is now NULLABLE.** A row with `batch_id NULL` is *unattached*: keyed in before any run
   exists, editable/deletable freely, and listed under an "Unattached" view on the keying screen and a
   dedicated 'unattached' status in the Transaction View inquiry. A CHECK guarantees every row carries
   either a batch reference or the (company_id, pay_period) pair; the service stamps company/pay-period on
   EVERY write (both shapes), and 0175 backfills all pre-existing rows from their batch.
2. **Attach-on-generate.** Inside `generatePayslips`' transaction (full draft→processed generation of the
   month's **REGULAR run only** — off-cycle/bonus/adjustment runs keep explicit-batch targeting via the
   wizard, so a row can never be double-collected in a multi-cycle month), unattached rows matching
   (company, pay month, employment ∈ batch scope) are stamped with the batch id, with one
   `payroll.individual-txn.attached` event per row.
3. **Detach, not delete, on draft teardown.** `teardownDraftChildren` now sets `batch_id := NULL` (one
   `payroll.individual-txn.detached` event per row) instead of deleting — deleting or resetting a draft run
   no longer destroys keyed-in one-offs; they re-attach at the next generation. This mirrors the claim
   detach that already existed.
4. **"No carry-forward" is re-keyed.** The invariant moves from "by the batch FK" to "by `pay_period`": a
   row belongs to exactly one month (date-in-period is validated against that month's calendar bounds) and
   nothing copies it forward. The sibling/next-month-empty test still holds.
5. **RLS** gains a second branch: unattached rows authorise on their own `company_id` via
   `app.can_admin_payroll_for()`; attached rows keep the original batch-derived check. Both branches appear
   in USING and WITH CHECK so attach/detach updates pass on old and new row images.

The "Explicit deferral" above still stands: the ledger remains INERT w.r.t. computed pay (the byte-identical
test now also covers the attach step). Kernel consumption is Phase 3, flag-gated, with its own sign-off.

## Amendment (2026-07, feedback f1564110 Phase 3) — flag-gated kernel consumption

The "Explicit deferral" above is now closed **behind `INDIVIDUAL_TXN_PAY_ENABLED` (default OFF)**. Flag off,
the ledger stays record-only and every payslip is byte-identical — the original inert byte-identical test is
retained verbatim as the flag-off guard. Flag on, `generatePayslips` folds the batch's (post-attach) ledger
rows into pay:

1. **Component-carrying earning/deduction rows** (migration `0176` adds `component_id` → `pay_component`;
   the wizard now PERSISTS the picked Payroll Item Master item instead of flattening it to
   kind+label-in-notes) are pushed into the existing `batchCompByEmp` typed-component fold, so the
   catalog's statutory flags (EPF/SOCSO/PCB/HRDF), rounding, prorates and non-payable treatment apply
   identically to a one-off batch component. The keyed amount is authoritative — the catalog `rule` is
   deliberately not applied (it would replace the keyed figure).
2. **Componentless legacy rows** fold with conservative defaults: an earning is EPF+SOCSO-liable wages (and
   in the PCB base via the wage figure); a deduction is post-statutory (net-only, EA s.24-clamped like a
   manual deduction). **New** payable rows require a component while the flag is on
   (`ComponentRequiredError`; the wizard hides the generic earning/deduction options).
3. **Overtime rows** add to the OT figure BEFORE the policy OT caps, with `otSource: 'individual-txn'`
   provenance when no manual/attendance figure contributes. **Unpaid rows** add their keyed RM amount to
   the unpaid deduction (pre-statutory, like derived unpaid leave). Both regular-run-only, matching the
   existing additional-run semantics.
4. **Leave rows are RECORD-ONLY in v1 (documented skip):** leave pay flows through the leave module
   (unpaid-leave derivation / entitlements); folding a raw leave amount here would double-count. The row
   still appears on the payslip as a named record line.
5. **Payslip provenance:** every consumed row appends a NAMED `statutory.recordLines` entry
   (deductions negative), so the payslip shows the one-off items by name.
6. **Dependency (documented):** the earning/deduction fold rides `TYPED_PAY_COMPONENTS_ENABLED`. With typed
   components off, a batch carrying payable one-off rows FAILS CLOSED at generation
   (`IndividualTxnRequiresTypedComponentsError`) rather than silently leaving them unpaid. The anchor
   deployment and the demo (`deploy/enable-demo-flags.sh`) run both flags on.

Consumption happens only at draft→processed generation — closed-batch immutability (0011) is untouched, and
a draft reset detaches the rows (Phase 2) so a re-generation re-attaches and re-consumes them exactly once.
