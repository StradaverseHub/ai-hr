# Ordinary-command lock review — 2 November 2026

Development candidate only. No protected-branch integration, installation or deployment.

## Reproduced defect

Hosted run 41331746162, source 07951dae7, executes two real employee Leave submissions. A fixture-only native BEFORE INSERT gate pauses the first before its request or audit append. Both requests persist successfully, but the second cannot commit while the first is paused. The exact overlap assertion fails. This isolates the tenant Access lock independently of the audit-chain append lock.

The previous complete 500-user runs on 32c2332fb failed at both activity levels: read p95 65.87s/62.70s and write p95 88.16s/88.18s. Native wait samples show hundreds of Access-exclusive holders/waiters during ordinary Attendance/Leave processing. These are development HTTP tests, not installed-system acceptance or production-equivalent capacity.

## Candidate ownership model

Only opted-in outer USER commands share Access authority in an actual READ COMMITTED READ WRITE transaction. They repeat the existing native current-carrier proof after ownership, including after an exclusive replay. This ownership state is per transaction, not a permission cache. Original RLS, scope checks, workflow authority and per-employment dependency locks remain active.

The audited roots are ordinary Leave submission/edit and decision/cancellation owners; Attendance check-in/out, correction submission/decision and own pending correction cancellation. Existing transactions, SYSTEM and agent owners retain the original exclusive interval. Configuration, Personnel identity, grants, reporting and other Access writers retain their existing native exclusive locks. A configuration writer therefore still conflicts with every shared command.

Attendance shares Leave configuration while owning affected employments. Creating a missing replacement-leave catalogue is a configuration change. A precise internal sentinel rolls back the entire shared attempt before one replay under the original exclusive Access/configuration path. External effects cannot participate. SQL failures, busy dependency refusals, deadlocks and business validation errors are not automatically retried. Existing transactions never partially replay. No PostgreSQL timeout or resource budget is raised; no native migration changes.

The read-only Access helper remains reserved for fully read-only transactions. Ordinary commands use a separate explicit interface. Uppercase UUID aliases normalize to the same native advisory key.

## Verification status

The original native red result is preserved under `/private/tmp/aihr-data-command-red-0795-attempt1` ([41331746162](https://github.com/StradaverseHub/ai-hr/actions/runs/41331746162)).

Initial qualification on 79cf59bf9 failed only in a new rollback fixture missing person.primary_email (186 native checks passed; the compiler reported the same fixture error). Expanded 1fab controls passed126 database and60 additional checks except the same fixture. Those failures remain recorded rather than relabeled.

Corrected frozen source172f78860778c9f2a1a342902672f82f5a3459bb passed205 database and20 additional checks and the whole-repository compiler ([41332635520](https://github.com/StradaverseHub/ai-hr/actions/runs/41332635520)). Native controls cover concurrent real creates/edits, same-employment refusal, native account revocation, complete rollback before one exclusive replay, actual read-only refusal and canonical PostgreSQL UUID lock aliases.

Two further real clock-out controls passed in the complete47-case Plan OT suite on test-only source d987990d7 ([41333481368](https://github.com/StradaverseHub/ai-hr/actions/runs/41333481368)); its application files are identical to172f. Success creates one replacement catalogue, one credit, two punches and one clock-out event. A deliberately injected late SQL failure is observed in PostgreSQL and leaves no new catalogue, credit or clock-out. Only that passing test commit is integrated; separate failing Payroll diagnostic files are excluded.

### Both 500-user reruns failed

Both immutable aliases use source/controller172f, one worker, total pool10/heap4GiB, durable PostgreSQL with the original approximately2GiB cap, a standard four-CPU host, 500 identities, two million retained Claims/Attendance rows and a five-minute hold. These remain development tests, not production-equivalent acceptance. The previous comparator is32c, not installed staging.

| Activity | Previous32c | Current172f | Outcome |
| --- | --- | --- | --- |
|1s|234 completed/266 failed; read p9565.87s, write p9588.16s|386 completed/114 failed; read p9567.76s, write p9587.25s;438.04s traffic elapsed|Complete accounting; target FAIL; loaded browsers1/6; both audit chains valid |
|5s|184 completed/316 failed; read p9562.70s, write p9588.18s|Original600s HTTP parent budget exceeded; last traffic snapshot475.01s:131 completed,2 failed,367 active,538 iterations|Incomplete accounting; target FAIL; no final p95/browser/audit acceptance |

Exact runs: [1s41332662698](https://github.com/StradaverseHub/ai-hr/actions/runs/41332662698), [5s41332665509](https://github.com/StradaverseHub/ai-hr/actions/runs/41332665509). Artifacts: `/private/tmp/aihr-data-command-one-172f-attempt1` and `/private/tmp/aihr-data-command-five-172f-attempt1`. No timeout, SLO or budget was relaxed. Partial five-second snapshots cannot establish an overall speedup percentage. At1s there are fewer failed users and more completed workflows, but p95 latency remains unacceptable.

The traces show fewer Access-exclusive wait samples, but repeated native visibility checks, Attendance-to-Payroll row protection and audit-chain waits remain. The actual0602 attendance_payroll_protection_rows function locks ALL matching batches, including drafts, before returning processed/closed coverage. Any optimization must preserve that complete membership and ordered FOR UPDATE ownership. A separate native Payroll/Leave write-overlap probe remains red; an actual employee Home identity reader already overlaps Payroll, ruling out a direct Access lock in that reader. No Payroll authority relaxation is promoted on these observations.

## Additional physical no-op write fix

Source4431661b7 conditionally removes an overtime marker only when that JSON key exists. An empty refresh previously performed a physical Attendance UPDATE and fired row/source/financial triggers without changing the stored value. The native regression41336682983 failed precisely on that write while its stale-key cleanup control passed. Corrected run41336968478 passes155 database and8 additional checks plus the whole compiler, including source/financial ownership, workflows, real clock-out replay and actual cleanup. Existing markers still follow every original row guard. No migration or permission predicate changes. This source has not yet repeated the full500-user workloads; the172f results above retain their original source identity.

The subsequent reversible Attendance-to-Payroll candidate-set rewrite passed exact native lock/scope oracles but showed no useful gain (3.87ms original,3.83ms candidate,3.59ms restored). It is rejected and excluded from the application. A separate visibility experiment remains diagnostic only.

## Date-bounded Attendance Payroll locks — qualified source; targets unmet

Native red source c69e64973, run41339198062, reproduces a second lock defect through the actual restricted transaction and guard. A draft six months before today blocks an unrelated employee's current Attendance command. Both commands remain valid after release, and the same-period exclusion control passes. This is a physical batch-row wait, independent of audit appends.

The full-load fixture includes June/July2026 historical Payroll, current-month processing drafts and November Attendance. All sampled backends executing its financial protection helper are waiting on transaction/tuple locks. Excluding unrelated historical months does not remove contention on relevant current-month drafts; their protection must remain intact. The rejected candidate-set rewrite retained the original row-lock set.

Unapplied0900 adds two guarded native overloads. The public overload repeats the exact existing correction-authority check; its private owner retains current/former-company and effective-payslip membership, stable exclusive FOR UPDATE ordering, and draft protection before the first payslip. For actual Attendance dates it excludes only canonical pay periods outside the date-month through the month after the last date. The canonical cutoff owner still determines exact coverage. Tests compare its calendar, anchor1–28 and frequency/type overrides over leap/year boundaries against that conservative bound. Malformed legacy period strings and unusual/empty native date arguments retain conservative protection.

Only lockPayrollForAttendanceChange passes its already validated dates. Undated schedule/calendar functions, own-removal guard and raw canonical-source trigger protection are unchanged. Native donor bodies and every non-signature function attribute are pinned; original unary functions remain unchanged. No applied SQL bytes, tenant boundaries, authority caches, timeouts or resource budgets change.

Candidate529923a8f passes75 native and one cutoff-bound check (41339533476); its whole compiler fails only on missing element types in the new batches/employees test arrays. Test-expanded9ca1056b3 passes132/133 native and nine other checks in41339652437, including all three populated upgrades. The sole new authority assertion incorrectly matched the query wrapper instead of its native cause; PostgreSQL independently records the expected correction-authority refusal. Test-only repair82cf0ec69 adds explicit array element types and exact nested native denial matching. Its four affected native cases and fresh whole compiler PASS in41340838746. Runtime, SQL and manifest bytes remain identical to9ca. Across these development receipts,187 distinct native checks in12 files and nine other checks in two files have successful observations after the focused repair; original failed workflow conclusions remain unchanged. This is development recovery, not an authenticated release witness.

Both immutable500-user reruns use9ca and FAIL:

|Activity|Run|Observed outcome|
|---|---|---|
|1s|[41339834763](https://github.com/StradaverseHub/ai-hr/actions/runs/41339834763)|Original600s parent budget exceeded. Last480.02s traffic snapshot:295 completed,1 failed,204 active;732 iterations. Accounting, final p95, browser and audit acceptance incomplete.|
|5s|[41339843517](https://github.com/StradaverseHub/ai-hr/actions/runs/41339843517)|Traffic accounting complete:495 completed/5 failed,539 iterations in443.69s. Final aggregate read p9557.16s/write87.15s. Six browser journeys completed, zero runtime errors, but three loaded Home-card failures. Both audit chains valid. Original600s parent budget also exceeded; no target acceptance.|

Four five-second failures are native Personnel draft-delete busy refusals; one journey aborts. One Attendance POST is observed at the original90s request limit. One-second incomplete progress must not be compared as a final latency improvement. The prior172f five-second run also lacks final accounting, so it cannot supply a valid final before/after percentage. Resources, budgets and SLOs are unchanged;0/2 activity levels accepted. Artifacts are retained under `/private/tmp/aihr-period-one-9ca1-attempt1` and `/private/tmp/aihr-period-five-9ca1-attempt1`.

Relevant batch-row contention persists:24/18 sampled protection-helper backends respectively wait on native tuple/transaction locks. The complete five-second SQL snapshot reports221.31s of planning and zero JIT compilation time. PostgreSQL consumes973.56 CPU seconds and the app384.68 over443.79s; host IO wait is0.44s and PostgreSQL has no CPU throttling. These counters overlap and cannot be added to host totals. Next hypotheses must preserve financial exclusion, rather than weakening draft or first-payslip protection.

## Changed canonical baseline

Fresh19:37 UTC main/alpha are438bfae3d,21 commits beyond the e158 development baseline. Staging still read-only verifies the exact640-row e158 applied ledger. The frozen load sources and financial receipts remain original development evidence. Aggregate source/journal integration, reallocation of all unapplied performance migrations above the then-current tail and exact aggregate verification are still required. No lease or release ticket is claimed.

## AI source approval boundary

These core files are in the transitive privacy source closure. Any generated source digest change is source metadata only and does not renew the 24 literal source-bound approvals. Existing purposes, data contracts and two pending approvals must remain unchanged. No provider request or source-binding refresh is authorized by this review. Native non-AI performance tests can proceed without enabling provider access.
