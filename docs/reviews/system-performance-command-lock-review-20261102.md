# Ordinary-command lock review — 2 November 2026

Development candidate only. No installation, integration or deployment authority.

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

## AI source approval boundary

These core files are in the transitive privacy source closure. Any generated source digest change is source metadata only and does not renew the 24 literal source-bound approvals. Existing purposes, data contracts and two pending approvals must remain unchanged. No provider request or source-binding refresh is authorized by this review. Native non-AI performance tests can proceed without enabling provider access.
