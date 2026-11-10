# Bulk operations: migration to the job framework (phase 3 plan)

Status: proposal, 10 Nov 2026. No code is changed by this plan.
Base: `7b585515d`. Line numbers are at the base commit. `db/admission.ts`, `db/capacity.ts`, `db/client.ts` and `db/workload.ts` are being edited by the concurrent admission worker, so their current lines differ.
Companion to the access-lock design (`/private/tmp/aihr-lockdesign-exp/DESIGN.md`, phase table). Phase 1 means the staged employee import on `claude/import-staged-job-20261110` (`core/employee-import-worker.ts`, `db/migrations/9001_employee_import_staged_job.sql`, uncommitted in its worktree at the time of writing).

## Summary

- **Worst holders are not the leave imports.** On a private PostgreSQL 16 cluster with durability on, the Access lock was held exclusively for 57.5 s by a 2,400-line clocking import, 53 to 66 s by Recompute Attendance over one day, 26.4 s by a one-month roster import and 12.1 to 20.0 s by a 1,206-employee payroll run. Every one blocked clock-in for its whole duration. Leave ledger import, already one transaction per row, held 27 ms per row (section 1).
- **Proof conversion: Leave ledger import** (`core/leave-import.ts`). It is the smallest, already per-row, idempotent by its dedupe key, and needs no pending state. It proves the job row, worker, checkpoint, resume, progress and cancel. It does not by itself remove a long hold; the first conversion that does is Register import (step 4) or Roster import (step 7).
- **Total: 54 to 81 working days** for the conversions below, against 9 to 13 for phase 1. Payroll processing is 14 to 20 of that and should be built only after phase 2.
- **Clocking and Recompute also block clock-in without the Access lock.** They hold the per-employee key that clock-in takes (`core/attendance.ts:2263`) for every employee in scope until commit, so phase 2 alone does not fix them.
- **Read replica: yes, as a separate workstream after phase 2**, for Analytics, report runs and Personnel `mode=all` exports. Its purpose is capacity, not lock relief: those reads already run READ ONLY REPEATABLE READ and take no write locks. Section 6.

## 1. Evidence

Measured: private PostgreSQL 16.14 cluster on `127.0.0.1:54977` (initdb in the scratch directory, `fsync=on`, `synchronous_commit=on`, `full_page_writes=on`; stopped and deleted afterwards). Migrations and the first 300 fixture employees ran with fsync off; every timed operation and the other 900 fixture employees ran with durability on. Schema from all 769 migrations at `7b585515d`, applied with the drizzle migrator; `db/seed.ts` from a scratch copy with one failing demo step skipped (the `requestAttendanceCorrection` seed step, refused with `noMatch`; not used by the operations measured). 1,206 fictional employees added through `commitEmployeeImport` in 25-row chunks. A separate observer polled `pg_locks` every 12 to 20 ms while login, Access-writer and clock-in probes ran, in the style of `footprint.ts` and `chunk.ts`. Single client on a workstation, one or two runs each: read these as indicative, not as a benchmark. Payroll, roster, recompute, clocking, register, accrual and leave ledger were measured; movement, section, leave B/F and history, and the rows marked `est` below were not.

Held ms = wall time the lock was seen held by the operation's backend (poll resolution about 15 ms). Audit-chain figures come from poll counts, because a pooled backend can hold that key in an earlier, unrelated transaction.

| Operation | Size | Wall | Access X held | Other tenant-wide keys seen held | Probe max during |
|---|---|---|---|---|---|
| Payroll processing (`generatePayslips`) | 306 employees | 2.4 s | 2.35 s | `payroll-history` S, `pay-component-catalog` S | writer 2.3 s, clock-in 2.2 s |
| Payroll processing | 1,206 employees, two runs | 12.1 s, 20.1 s | 12.1 s, 20.0 s | as above, plus audit-chain near the end only (about 0.8 s by poll count) | writer 20.0 s, clock-in 20.0 s, login 1.1 s |
| Clocking import | 1,200 employees, 2,400 lines | 57.6 s | 57.5 s | `leave-dependency-configuration` X 57.5 s; audit-chain about 13 s; per-employee keys for all employees | writer 57.5 s, clock-in 57.4 s, login 13.4 s |
| Roster import | 1,200 employees x 31 days, 37,200 cells, one date-set group | 26.3 s | 26.4 s | `leave-dependency-configuration` S, audit-chain about 26 s | writer 26.1 s, clock-in 26.2 s, login 25.7 s |
| Recompute Attendance | 1,207 employees, one day, two runs | 52.6 s, about 66 s | 52.8 s, 66.0 s | `leave-dependency-configuration` S; per-employee keys for all employees | writer 52.6 s, clock-in 52.5 s, login 1.5 s |
| Register import (qualification) | 500 rows, the cap; two runs | 3.5 s, about 5.6 s | 3.5 s, 5.6 s | `profile-edit-policy` X and audit-chain 2.9 s, 4.6 s | writer 3.4 s, 5.6 s; clock-in 3.3 s, 5.5 s; login 2.9 s |
| Earned accrual (`accrueEarnedLeave`) | 1,207 grants | 3.5 s | 3.4 s | per-employee leave keys | writer 3.5 s, clock-in 3.4 s |
| Leave ledger import | 300 rows, one tx per row | 8.2 s total | 27 ms per row (mean) | per-employee leave key | writer max 111 ms, clock-in 119 ms |
| Payroll close (`closeBatch`) | 1,206-employee run | 0.29 s | 0.27 s | - | writer 0.3 s, clock-in 0.16 s |
| Employee import (fixture) | 25-row chunks | 52 ms per row with fsync off (first 300), 82 ms per row with fsync on (next 900) | - | - | - |

Linear extrapolations to 3,000 employees (`est`): payroll 30 to 50 s, clocking at 2 punches each 144 s, roster 66 s, recompute 131 to 165 s, accrual 9 s. The clocking file cap is 900,000 bytes (`lib/import-file.ts:33`), about 30,000 lines, so a capped file holds the Access lock for about 12 minutes (`est`, linear).

Row locks are not measured per row. Where they matter they are named from code.

## 2. Shared requirements for every conversion

Phase 1 is employee-import-specific. Before the proof, extract a small kernel from `core/bank-import-worker.ts` and the phase 1 worker. Four job tables already exist or are arriving (`bank_import_job`, `payroll_individual_import_job`, `payroll_reprocess_job`, `employee_import_job`) and each repeats the queue, admission and claim code.

Each conversion must keep:

1. **Chunk atomicity.** HR mutation, checkpoint row and audit item commit in one transaction (`core/bank-import-worker.ts:86-96`). Chunk budget about 250 ms (`EMPLOYEE_IMPORT_CHUNK_BUDGET_MS`, phase 1).
2. **Authority per chunk.** Fresh entitlements each tick (`freshImportContext`, `core/bank-import-worker.ts:23-27`); HR writes only through the app role, never the owner connection (`core/bank-import-worker.ts:1`, `core/bank-import-worker.ts:117`).
3. **Rejected row versus transient failure.** Only the analyzer may reject a row (`BankImportRowRejectedError`, `core/bank-import-worker.ts:100`). A no-wait `LeaveDependencyUnavailable('busy')` (`core/leave-dependency-lock.ts:31`) is transient inside a job: back off and retry, never mark the row failed and never surface Busy.
4. **Background admission** (`withBackgroundDatabaseWork`, `db/workload.ts`), so a chunk cannot crowd out interactive work.
5. **Revalidation narrowed to the chunk.** Today's per-group or per-row replays re-parse the whole file; that cost must move out of the transaction (roster and section imports below).

## 3. The named imports and payroll

### 3.1 Leave ledger import, PROOF CONVERSION (step 1)

- **Locks.** One transaction per row (`core/leave-import.ts:399`): Access X (`:400`), `leave-dependency-configuration` S plus `leave-dependency-employment:<id>` X, no-wait (`:401`, `core/leave-dependency-lock.ts:54-69`). Measured 27 ms per row; hot-path probes unaffected (max 119 ms).
- **All-or-nothing.** Not required. Row-level success is the design: "not-atomic-by-design" (`core/leave-import.ts:370-376`, `:393-396`).
- **Job mapping.** Job row kind `leave_ledger`, source file and validated plan stored once. Chunk boundary: one row per transaction, as today, so a row failure cannot abort neighbours. Pending or activate: none, because ledger rows are visible when written, unchanged from today. Progress: rows processed, imported, skipped, failed. Resume: job row state plus the existing duplicate check (`core/leave-import.ts:157`, "skip on commit"). Discard: cancel before apply only; no reversal exists today and none is added.
- **Size.** 2 to 3 days.

### 3.2 Leave B/F and Leave history (step 2)

- **Locks.** Per line: leave-dependency S plus employment X, no-wait (`core/leave-bf-import.ts:799`, `core/leave-history-import.ts:775`); B/F also takes its run row FOR SHARE (`core/leave-bf-import.ts:800`). No Access X per row. `est` 20 to 40 ms per row (same shape as leave ledger). B/F reversal is one transaction that locks every subject (`core/leave-bf-import.ts:1030-1036`).
- **All-or-nothing.** Not required: "NOT ATOMIC, BY DESIGN" (`core/leave-history-import.ts:109`), "One transaction per LINE" (`core/leave-bf-import.ts:786`). A B/F replace line keeps its two rows in one transaction.
- **Job mapping.** Chunk per line. No pending state. Resume: B/F run row and its `bf_import_run_id`-keyed sum; history dedupe. Discard: B/F existing reversal; history cancel-before-apply.
- **Size.** 2 to 3 days. Chunking the B/F reversal is in step 12.

### 3.3 Section imports: profile and family (step 3)

- **Locks.** Per row (`core/import-sections.ts:957-958`): `app.access_workforce_write_lock()` (Access X, plus FOR SHARE on `access_profile_write_generation` and `access_configuration`), then `leave-dependency-configuration` X, no-wait. Person and `employee_statutory_my` FOR UPDATE (`:978`, `:980`). `est` 60 to 120 ms per row, based on the 82 ms per row measured for the employee import with durability on.
- **All-or-nothing.** Not required. Row-level results already (`failed[]`, `core/import-sections.ts:1040-1048`). Bank and statutory is already a job (`core/bank-import-worker.ts`).
- **Job mapping.** Extend the bank job kinds; generalise `applyBankImportRowTx` (`core/import-sections.ts:1111`) to the section. Pending none. Progress and resume: `bank_import_row.state`, exact as today's bank path. Discard: cancel before import only, no revert exists for these sections.
- **Size.** 2 to 3 days. Register sections are separate, below.

### 3.4 Register imports: qualification and emergency (step 4)

- **Locks.** One transaction for the whole file (`core/personnel-register-import.ts:136-146`): Access X (`:140`), `profile-edit-policy` X per writer call (`core/qualifications.ts:248`), audit-chain, FOR UPDATE on every employment and person row named in the file (`:33`) and on each updated record (`:116`, `:121`). Measured 3.5 to 5.6 s at the 500-row cap, so it exceeds the 1 s bar at the cap.
- **All-or-nothing.** Today's promise is whole-file: validation refuses any bad row ("Nothing from this register file will be written", `:96`) and a write failure writes nothing (`:145`). Whole-file validation should stay. Whether the write must also be atomic is an owner decision: the data is non-financial and each employee's rows are independent.
- **Recommendation.** Keep validation whole-file; apply per employee with import-history items and a whole-file Revert (ADR-0155), plus a job state that stops on the first non-retriable refusal and offers Revert. Owner to approve the relaxed write atomicity.
- **Job mapping.** Chunk: all rows of one employee. Pending: not in this step (updates to existing records are not stageable without before-image reads; a pending column on new rows is the optional follow-up). Progress: rows. Resume: history item per row in the same transaction. Discard: new Revert handler for register kinds.
- **Size.** 2 to 3 days. Add 1 to 2 days if the owner requires staged visibility for new records.

### 3.5 Movement import (step 8)

- **Locks.** One transaction per employee. Preview and commit both take Access X (`core/movement-import.ts:405`, `:456`), `movement-import-reference-admission` X and the type catalogue lock. Corrections add `access_workforce_write_lock` and `leave-dependency-configuration` X (`:463`). Each transaction sets `lock_timeout` 1 s and `statement_timeout` 5 s (`:55`, `lib/movement-import-contract.ts:8`), so a held Access lock turns into a refused employee. Code-bounded at 15 s per employee and 45 s per request (`lib/movement-import-contract.ts:8`, 50 employees, 200 rows). Not measured.
- **Preview cost.** Preview runs every row inside a rolled-back transaction under Access X (`:405-426`), so it is the same lock footprint as commit and must also leave the request path.
- **All-or-nothing.** Per employee, yes (`whole_employee_selection_required`, `:447`; `employee_sequence_invalid`). Across the file, no: employees fail independently today. Whole-import Revert exists (ADR-0155, `core/movement-import-history.ts`).
- **Job mapping.** Job row links the existing `import_attempt` (`previewMovementUpload`). Chunk: one employee, unchanged, including its history items (`:488`, `:495`). Pending: none, the employee is the atomic unit. Progress: employees. Resume: skip employees whose items exist for the attempt. Discard: existing Revert.
- **Size.** 4 to 6 days, including background preview.

### 3.6 Roster import (step 7)

- **Locks.** Plan transaction: Access X plus leave-dependency S (`core/roster-import.ts:115-116`). Then one transaction per brush and date-set group (`:276-279`): Access X, leave-dependency S, employment X for every employee in the group, no-wait. Each group replays the whole file (`:280`). Upserts in 1,000-row statements inside the group transaction (`core/roster-write-batches.ts:4`, `core/roster.ts:2262`). Measured: 26.4 s Access X for one 37,200-cell group, audit-chain held for the same period.
- **All-or-nothing.** Not required across groups: each group already commits separately and a later failure leaves earlier groups (`:276`, `:309`, `:315`). Within a group it is an implementation accident. The "fails whole rather than half" comment (`core/roster.ts:2275`) is about the generator's allowance check; keep that check per chunk.
- **Job mapping.** Plan persisted at validation as rows per employee. Chunk: about 10 employees' month, about 250 ms at the measured 22 ms per employee-month, with revalidation narrowed to those employees. Pending: none. Progress: cells or employees. Resume: writes are idempotent upserts. Discard: none today; `recordRosterUpload` only on completion (`:122`).
- **Size.** 3 to 5 days.

### 3.7 Clocking import (step 11)

- **Locks.** One transaction for the file (`core/attendance-clocking-import.ts:845`): Access X via try-then-blocking (`core/attendance.ts:4399`, `:4410`), `leave-dependency-configuration` X (`core/attendance.ts:4437`), `leave-dependency-employment` X for every employee, no-wait (`core/attendance-clocking-import.ts:574`), and the per-employee key clock-in uses (`:578`, same key as `core/attendance.ts:2263`). Measured 57.5 s for 2,400 lines (24 ms per line).
- **Key finding.** Clock-in for any employee in the file waits for the per-employee key until commit, even after phase 2 makes the Access lock shared. Only chunking fixes this.
- **All-or-nothing.** Not required by the rules: "one bad line never stops the others" (`:15`); re-importing a file adds nothing twice (`:20-23`, minute-level duplicate check). The single transaction is an implementation choice.
- **Job mapping.** Extend `clocking_import_run` with job state. Chunk: all lines of one employee, in order (about 5 employees per 250 ms at the measured rate). Pending: none. Progress: lines processed, per-result counts already on the run row. Resume: `clocking_import_line` rows plus the duplicate check. Discard: none today; a stopped run writes a Failed row (`:31`), keep that. Finalise step, separate from chunks: run totals, `markBatchNeedsRecalc`, the summary event (`:922`, `:937`, `:946`). Move `decideLines` validation out of the write transaction.
- **Size.** 6 to 9 days.

### 3.8 Payroll processing (step 13, after phase 2)

- **Locks.** One transaction per batch (`core/payroll.ts:3781`): Access X (`core/pay-component-catalog-lock.ts:12-15`), `pay-component-catalog` S, company-month payroll period key X (`core/payroll-period-lock.ts:64-71`), `payroll-history` S, overtime batch context (`core/payroll.ts:3857`), batch row FOR UPDATE (`:3859`), audit-chain for the end of the run. Measured 2.35 s for 306 employees, 12.1 to 20.0 s for 1,206.
- **All-or-nothing.** Yes at run level: one run is either draft or processed, with totals, GL, loan-ledger and claim side effects applied once (`core/payroll.ts:3766-3777`). Per-employee processing is already proven by selective reprocess: per-employee transaction, job row, worker token, outcomes and history (`core/payroll.ts:9741-10030`, `:9868`).
- **Job mapping.** Job row modelled on `payroll_reprocess_job`. Chunk: one employee via the subset path of `generatePayslipsTx`. Pending: new `processing` batch status, hidden from every payslip reader, with status filter or RLS. Activate: one short transaction that flips the status, writes totals, status history and applies run-level side effects. Progress: employees. Resume: `outcomes` plus the payslip identity. Discard: existing `teardownDraftChildren` (`core/payroll.ts:2455`), return to `draft`.
- **Cannot start before phase 2.** The advisory period key is transaction-scoped and cannot span chunks, so it needs a durable lease on the batch row. The (M) blockers in the design (compensation, statutory, fixed-item writers and bonus input against an in-flight run) become hard requirements. Note E1: even under a shared Access lock, a queued configuration editor stalls new writers behind a 20 s shared holder, so phase 2 alone does not meet the 1 s bar.
- **Size.** 14 to 20 days.

## 4. Other operations that can hold a tenant lock past 1 s

| Operation | Code | Locks | Hold | All-or-nothing? | Treatment | Size |
|---|---|---|---|---|---|---|
| Recompute Attendance | `core/attendance-recompute.ts:230-232`, `:284`, `:289` | Access X, leave-dep S, employment X and clock key for each employee | Measured 53 to 66 s / 1,207 employees, one day | No, recomputation with its own run id | Job, chunk per employee (step 9) | 3-4 |
| Earned accrual, carry expiry, year open, leave generation | `core/leave.ts:10082`, `:11896`, `:8800`, `core/leave-generation.ts:240`; cohort lock `core/leave.ts:5962-5979` | Access X, leave-dep S, no-wait employment X for the entire cohort in one transaction | Accrual measured 3.4 s; others not measured, `est` same order or larger | No, idempotent (`scripts/accrue-earned.ts:5`) | Chunk per employee under `job_run`; busy on any one employee today fails the whole tenant sweep (step 10) | 4-6 |
| Individual payroll transaction import | `core/individual-txn-import.ts:82-83`; 2,002-row cap `core/individual-import-worker.ts:40` | Access X, payroll period keys held for the whole file, savepoint per row | Not measured, `est` 20 to 60 s at cap | No, per-row outcomes | Chunk the existing job, about 20 rows each (step 5) | 3-4 |
| Cost-allocation preview | `core/cost-allocation-import.ts:52` | `access_workforce_write_lock` X for a preview of up to 5,000 rows | Not measured | Preview writes nothing | Read-only snapshot preview (step 6) | 1-2 |
| Import reverts | `core/import-history.ts:194-201`, handlers (`core/movement-import-history.ts:103`) | Access X, `leave-dependency-configuration` X, attempt row across all items | Not measured, scales with items | Yes, ADR-0155 | Keep atomic, cap item count, chunk only if needed (step 12) | 2-3 |
| Payroll anomaly evaluation | `core/payroll-anomaly.ts:570`; sweep `scripts/anomaly-sweep.ts:125` | Access X for the batch | Not measured | No, recomputation | Shared lock after phase 2, then chunk if still long (step 12) | 0-1 |
| System labels import | `core/system-label-import.ts:272-276` | Access X, `leave-dependency-configuration` X, SHARE ROW EXCLUSIVE on `profile_option`, `job_grade`, `grade_group`, `grade_group_member`, label criteria lock | Not measured, `est` under 2 s | Yes by design (`:274` comment) | Chunk by sheet and category, or cap rows per file (step 12) | 1-2 |
| Publish workforce capabilities | `deploy/access/publish-workforce-capabilities.ts:73-74`, `:92-93`, timeouts `:65` | SHARE on `tenant`, SHARE ROW EXCLUSIVE on `access_capability`, Access X and `profile-edit-policy` X on every tenant | Not measured; scales with tenant count | Yes for the published version; no for each tenant fence | Publish version once, then fence per tenant; run in a maintenance window (step 12) | 1-2 |
| Module change runner | `scripts/module-change-runner.ts:132-144`, contract `:125-126` | Access X, `leave-dependency-configuration` X no-wait, `operator-modules` X | Not measured | Yes, comment `:125-126` | Keep; move seeding out only if measured over 1 s (step 12) | 1 |
| Payroll history confirm | `core/payroll-history-revisions.ts:263-264` | `payroll-history` X, Access X, FOR SHARE on company, employment, cycle rows | Not measured | Yes, "atomic commit" (`core/payroll-history-import.ts:926`) | Optional. Pending revisions plus activation only if file size requires; not in totals | (3-5) |
| Reconcile information snapshots | `scripts/reconcile-information-snapshots.ts:41` | `access_workforce_write_lock` X for the manifest | One-off operator tool | Yes for the manifest | Leave | 0 |
| Payroll reset, unlock | `core/payroll.ts:9330`, `:9642` | Access X, period key | Not measured (reset disabled in the fixture) | Yes | Measure before deciding | 0 |

Already per-row or own-transaction, no conversion for lock reasons: shift import (`core/shift-import.ts`), onboarding import (`core/lifecycle-import.ts:190-200`), fixed and individual payroll transaction import (`core/payroll-txn-import.ts:1024`). Cost-allocation commit is per employee already (`core/cost-allocation-import.ts:175-176`). Payroll close measured 0.27 s: leave.

## 5. Size and order

Yardstick: phase 1 is 9 to 13 days and includes pending state, activation and discard. Conversions without pending state are a fraction of that once the kernel exists.

| Step | Conversion | Days | Why here |
|---|---|---|---|
| K | Shared job kernel, extracted during step 1 | 3-4 | Stops a fifth bespoke queue |
| 1 | **Leave ledger import (proof)** | 2-3 | Smallest; proves worker, checkpoint, resume, progress, cancel |
| 2 | Leave B/F, Leave history | 2-3 | Same shape |
| 3 | Section imports: profile, family | 2-3 | Reuses bank job |
| 4 | Register imports | 2-3 | First real hold removed (3.5 to 5.6 s); owner decision |
| 5 | Individual transaction import | 3-4 | Job row already exists |
| 6 | Cost-allocation preview | 1-2 | Preview only, no business logic |
| 7 | Roster import | 3-5 | Idempotent upserts; large measured hold |
| 8 | Movement import | 4-6 | Employee already atomic; preview to background |
| 9 | Recompute Attendance | 3-4 | Same chunk shape as clocking |
| 10 | Leave sweeps | 4-6 | Idempotent; touches annual-leave engines |
| 11 | Clocking import | 6-9 | Worst measured hold; most semantics to preserve |
| 12 | Operator tools, anomaly sweep, import reverts (including the B/F reversal) | 5-9 | Low frequency |
| 13 | Payroll processing, after phase 2 | 14-20 | Money; visibility status; lease |
| | **Total** | **54-81** | |

Dependencies: phase 0 (commit seal) shortens every audit-chain hold and should land first; phase 1 provides the framework; phase 2 is required before step 13 and improves all others.

Deviation allowed: this order is smallest and lowest-risk first, as requested. Steps 1 to 3 remove no measured hold over 1 s. If impact matters more than risk after the proof, take Clocking (step 11) and Roster (step 7) straight after step 2; nothing in the framework prevents it.

Not sized here: raw-client admission and the optional async sequencer from the design's phase 3.

## 6. Read replica for Personnel exports and Analytics

**Recommendation: yes, one physical hot standby, as a separate workstream after phase 2; 5 to 8 days of engineering.** Its benefit is CPU and connection isolation for scans and exports. It does not help the lock problem: the reads below already take no write locks.

**Facts (code).** Personnel `mode=all` export runs `{ readOnlySnapshot: true }` (`app/admin/personnel/export/route.ts:125`, base), with a 20 s statement ceiling (`core/personnel-read-bounds.ts:7-11`), 10,000-row cap and 500,000-cell cap. Analytics dashboard runs READ ONLY REPEATABLE READ (`core/analytics.ts:427-430`). `masterDataExport` is plain `withTenant` (`core/analytics.ts:399`) and should move to the same snapshot form. Report runs: `core/custom-reports.ts:410-425`, `core/employee-master-reports.ts:104-114`. Today there is no standby: one 4-vCPU/16-GiB HR database (`deploy/CUSTOMER.md:7`), `wal_level=replica`, `archive_mode=off` (`deploy/DEPLOY.md:548`). A streaming replica is already named as an open option for durability (`deploy/DEPLOY.md:566-567`); it serves that too, but PITR still needs WAL archiving.

**Requirements.**

| Area | Requirement |
|---|---|
| Topology | One asynchronous streaming hot standby, same PostgreSQL major, same instance class as the primary at first, private network, verify-full TLS. Physical replication so roles, RLS, policies, functions and GUC definitions are identical by construction. Replication slot with a retention cap, `max_standby_streaming_delay` about 30 s, `hot_standby_feedback` on (trades some primary bloat for fewer cancelled exports). Optional per installation, off by default. |
| RLS and GUC | `withTenant` sets tenant, user, roles and grants with `set_config(..., true)` and `SET TRANSACTION READ ONLY` (`db/client.ts`, base `:236-336`); both work on a standby. REPEATABLE READ is allowed; SERIALIZABLE is not, and it is not used here. Same policies apply. The principal check functions checked are STABLE (`principal_snapshot_current`, `access_workforce_employment`, `access_workforce_company`, `is_admin_for`, `can_admin_payroll_for`, `current_tenant_id`, `current_user_id`), measured in catalog. 1,285 of 2,398 `app` functions are VOLATILE (measured), so run each presentation query against a staging standby and fix any writer. |
| Advisory locks | Local to each server (PostgreSQL 16 documentation, not exercised here). Any shared Access or leave lock taken on a read path protects nothing on a standby. Route only paths that do not depend on them. |
| Staleness | Target under 5 s. Router checks replication lag with a heartbeat row or LSN delta, not `pg_last_xact_replay_timestamp()` alone (it stalls when the primary is idle). Above 30 s, fall back to the primary silently. Show "data as at" on Analytics and exports. Sessions that wrote in the last 60 s read from the primary. |
| Revocation | `withPersonnelRead` promises that a committed revocation applies to the next snapshot (`core/personnel-read-bounds.ts:26-27`). A replica weakens that by the lag. Run the authority check (`workforceViewScope`, `assertAiPresentationPrincipalTx`) on the primary in a short transaction first, then read on the replica; or accept the lag window as an owner decision. |
| Connection budget | Separate replica pool, `AIHR_DB_READ_URL`, `AIHR_DB_READ_POOL_MAX` about 4 per worker. Add to the fleet equation the admission worker is building (`db/capacity.ts`). Standby `max_connections` >= primary. `deploy/admission/next_profile.py:37` allowlists fleet environment keys and needs the new keys. |
| Stays on primary | All writes and every job or chunk; authentication, MFA, session and principal checks; `app.record_custom_report_run` (`core/employee-master-reports.ts:125`, VOLATILE) and report audit events (`core/custom-reports.ts:444`); import previews and rehearsals; any read inside a command transaction (`withPersonnelRead` with `existingTx`, `core/personnel-read-bounds.ts:31-36`); Personnel list and detail screens in the first step; payroll runs and close preflights. |
| Failure handling | Replica unreachable, lag above limit, query cancelled by recovery conflict (SQLSTATE 40001 on standby), undefined column or function during deploy: retry the read on the primary, never show an error. The concurrent read-retry work in `db/client.ts` is the natural place. |
| Migrations | `drizzle-kit migrate` runs only on the primary; DDL replays. An `ACCESS EXCLUSIVE` replay can cancel long standby queries: expected and covered by the retry. Deploy order stays primary first; a lagging standby during deploy falls back through the undefined-column path. |
| Cost | One more database instance, roughly doubling HR database compute (`est`; no provider price in the repository). 5 to 8 engineering days: replica pool and router 2, primary-first authority and fallback 2, deploy and installer 1 to 2, staging standby rehearsal including conflict and failover 1 to 2. |

**Not recommended in the first step:** Personnel list, My Profile, Home or anything a user just edited. Those need read-your-writes and are the acceptance rehearsal's hot paths.

## 7. Decisions for the owner

1. Register import: confirm that whole-file validation with per-employee writes and Revert replaces the current whole-file write atomicity (`core/personnel-register-import.ts:96`, `:145`).
2. Payroll processing: confirm a `processing` run status visible to payroll operators and hidden from employees, and a run-level durable lease in place of the advisory period key.
3. Read replica: confirm revocation-on-replica handling (primary-first authority check versus accepting replica lag) and whether a standby should be funded per installation.
4. Sequence: strict smallest-first, or Clocking and Roster immediately after the leave family.
