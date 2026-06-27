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
