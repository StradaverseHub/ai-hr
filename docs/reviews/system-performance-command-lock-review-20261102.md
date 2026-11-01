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

Original native red result preserved under /private/tmp/aihr-data-command-red-0795-attempt1.
Hosted run 41332094287 qualifies the initial candidate 79cf59bf9 against the native interleaving, revocation, rollback, read-only contract and existing Leave/Attendance/TOIL behavior, plus the whole compiler. Results must be recorded after terminal completion; no pass is presumed here.

Additional native same-subject coverage and UUID-key normalization follow in a separately identified candidate. Full 500-user comparisons must use frozen exact source identities and the original 1s/5s activity, 5-minute hold, 500 identities, 30 routes, six mixed workflows, two million retained Claims/Attendance rows and unchanged worker/pool/heap/PostgreSQL limits. Preserve failures and report completed/failed users as well as latency.

## AI source approval boundary

These core files are in the transitive privacy source closure. Any generated source digest change is source metadata only and does not renew the 24 literal source-bound approvals. Existing purposes, data contracts and two pending approvals must remain unchanged. No provider request or source-binding refresh is authorized by this review. Native non-AI performance tests can proceed without enabling provider access.
