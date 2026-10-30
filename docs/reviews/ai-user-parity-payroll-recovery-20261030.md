# Payroll recovery handoff slice

This slice adds current-month native reset/reopen navigation to the existing Assistant Payroll close workspace. It performs no mutation, accepts no model inputs, and issues no execution receipt. Native pages collect reasons and confirm consequences; native services recheck authority and state.

## Verified source inventory

- `app/payroll/process/actions.ts`: regular/additional draft creation, resume and multi-company orchestration. Existing Assistant `multi_cycle_payroll.create_run` covers additional draft creation only, not regular creation or processing.
- `app/payroll/actions.ts`: generation/preprocessing, input updates, contributors, close, reset, unlock, deletion, reprocessing and anomaly decisions.
- Existing Assistant `payroll.close` uses native reviewed close/source/custody; it is preserved.
- `resetProcessedBatch`: risk switch, required reason, period lock, company `payroll.rollback`, processed-only, reversals of claims/loans and payslip destruction. Native reset confirmation route is `/payroll/[batchId]/reset`, guarded by requireAdmin.
- `unlockClosedBatch`: risk switch, required reason, company `payroll.unlock`, closed-only, import-adoption refusal, downstream warnings and parent-period reopening. Native confirmation is on `/payroll/[batchId]`, guarded by requirePayrollAccess.
- Imported effective history is intentionally excluded from recovery nominations, as on native run controls.
- Transactions include individual adjustments, fixed items, deductions, TP1, TP3, zakat and imports. Personnel owns fixed-item archive and TP3 opening; no changes made here.
- Export/statutory surfaces include payment submission, statutory form generation, statutory adjustments, EA/PCB/EPF/SOCSO and history exports. Binary generation, external submissions and imports remain native handoffs; no claim of execution coverage.

Follow-up reopening execution is implemented through the native unlock owner and shared encrypted custody in PR119; verification is still in progress. This document records the initial handoff slice. See the reopening contract review for current execution boundaries. Reset remains handoff-only.

## Boundary and integration

The reader uses the Payroll pack's existing RLS-scoped list owner, filters each row to the actor's payroll company grant, admits a real user without requiring a PERSON, respects reset/admin and reopen/payroll native page floors, and suppresses disabled switches. Only identity labels and native hrefs render; money, employee details and receipts are excluded. Up to 25 eligible current-month runs render; Payroll list links expose older runs through native navigation.

Shared edits: additive six-locale message namespace and source manifest regeneration; existing close page mounts the new server section and its composition test mocks it. No registry, custody, native transaction, historical migration, provider or Bank changes. No new migration required for this handoff. Locale strings are authored and require fluent review; no rendered journey claimed.

Full execution needs a separate coordinated contract: private before/after provenance of every reset/reopen effect, stale review refusal, exact event references, recovery and erasure. No migration number is requested until that contract is defined. A native link does not establish permission to execute.

## Verification

Authored focused reader tests cover real unlinked USER, SYSTEM refusal, employee/manager refusal, payroll partner reset restriction, company scoping, risk switches, native states/history, output minimization and bounds/source refusal. Local tests/collection/compiler/build/DB/server were not run. Hosted focused results are recorded in the exclusive external phase status file, on their actual SHA. No deployment or release authorization.
