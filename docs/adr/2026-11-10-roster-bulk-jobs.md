# Roster bulk operations run as background jobs on the shared kernel

Status: source implementation on `claude/bulkjob-roster-20261110`; hosted verification and integration pending.
Base: `claude/import-staged-job-20261110` @ `0143d761c` merged with `claude/candidate-behaviour-restore-20261110` @ `5e7d80ff6`.
Draft migration (unallocated, range 9920–9929): 9920 `roster_bulk_jobs`. Production and staging untouched.

Generate, Copy, the roster grid's bulk bar, Upload Shift Roster and Schedule Group bulk assignment each ran in one
transaction that held the tenant's Access lock (and, with the audit chain armed, the chain lock) for the whole grid:
26.4 s for a 1,200-employee month (docs/plans/bulk-operations-job-migration.md §3.6). They now run on the shared
bulk-job kernel (ADR 2026-11-10 employee import, "Shared job kernel") as two kinds:

- `roster_bulk` (Generate, Copy, the grid's bulk bar, Upload) and `schedule_group_bulk`; one active job of each per
  tenant (`exclusive:'tenant'`), so two bulk roster operations never interleave their per-employee writes. A second
  one is refused at admission with a translated "still being saved" sentence, never queued behind the first.
- **Admission** (`core/roster-bulk-job.ts`) keeps every check the click made: the administrator right, the posted
  targets' admission (`app/roster/command-targets.ts`, unchanged), the input capture and, for Generate, the
  generator's read-only nomination (template, nominated employments, reviewed department and team) so those
  refusals still answer the click. The request writes no roster row.
- **Steps** are one employee each (Generate: one per half of the generator, which is also one duty-guard event each in
  the synchronous run; an upload: one employee of one group, the group's summary, each clear). A step
  runs the same writers (`writeRosterShiftRowsTx`, `writeRosterRestRowsTx`, `copyRosterRowsTx`, `setRestDay`,
  `clearRoster`, `setEmploymentScheduleGroupTx`) with their guards: the duty-roster guard and its
  `roster.manual-changes` event, the Schedule Group check, payroll marking, the replacement-holiday queue triggers.
  Chunks take the Access and leave-configuration locks the synchronous writer took first and commit after about
  150 ms of work (`ROSTER_BULK_CHUNK_BUDGET_MS`).
- **Summary events** (`roster.bulk.assigned`, `roster.bulk.rest-day.set`, `roster.copied`, the upload's
  `roster.bulk.uploaded` history entry) are filed once, in the finalize transaction (an upload's per-group events in
  that group's summary step), counted from the rows actually written. Event payloads are unchanged; only their
  sequence among themselves differs (per employee instead of per half of the grid).
- **All-or-nothing is kept where it was promised.** Generate, Copy, the shift brush, each upload group and the
  Schedule Group batch refused the whole grid before writing. Their first steps are check steps: the same guards in
  the synchronous order (visibility, the duty guard by employment id, the Schedule Group check in employment order,
  the rest half), each in a savepoint that is always rolled back, inside the kernel's ordinary chunk transactions (so
  the kernel bounds them by the chunk budget, renews the lease and retries busy refusals). Writes run only after
  every check passed; the first refused check ends the job before any row with the same sentence. The upload's
  groups and the grid's rest/clear loop committed one by one and stopped at the first refusal; the job writes
  exactly that prefix and then fails with the same sentence (no history entry).
- **Concurrent change.** A change made before the checks finish refuses the whole grid. After them, each step
  re-checks its own employee (an upload step also re-checks that the employee
  number and shift code still resolve to the same employment and shift and that the cell still differs). A change
  made by someone else while the job runs is refused for that employee and recorded on the job; the others are
  written (the sequential upload and rest/clear loops stop instead). The job then ends as failed with that sentence.
  This is the one result that can differ from the single transaction, which would have serialised before or after.
- **Screens.** The click validates and enqueues; the page shows the progress panel (the employee-import panel's
  pattern) and, when the job ends, opens the same address the action used to redirect to (`?generated=`,
  `?copied=`, `?bulkChanged=`, or `?error=`), so the outcome banners are unchanged. The upload screen renders the
  same result panel in place. The grid's bulk bar keeps its painted cells while the job runs and reports the
  outcome as before. The creator gets the `bulk-job.finished` notice (`bulkJobs.notification.roster` /
  `.scheduleGroup`, six catalogues).

Measured (scripts/performance/roster-bulk-rehearsal.ts; private PostgreSQL 16, fsync on, audit chain armed, 3,000
fictional employees; a 12-core workstation shared with other build agents, load average 10–48, so absolute figures
are pessimistic; holds from scripts/performance/tenant-lock-sampler.ts per application_name):

| Run | Wall | Longest job hold | Login / Access writer / Clock-in max | Errors, Busy |
|---|---|---|---|---|
| Today's generator, one transaction, 1,200 × 31 | 209 s | Access X 207.5 s | 204.8 s / 208.5 s / 208.1 s | 0, 0 |
| Generate job, 1,200 × 31 (load ~13) | 341 s | 437 ms (p95 193 ms) | 212 ms / 717 ms / 855 ms | 0, 0 |
| Upload job, 1,200 × 31, 26,493 changed cells | 839 s | 981 ms (p95 217 ms) | 446 ms / 1.7 s / 1.8 s | 0, 0 |
| Schedule Group job, 1,200 employees | 131 s | 380 ms (p95 169 ms) | 194 ms / 504 ms / 569 ms | 0, 0 |
| Copy job, 1,200 × 31 (earlier build, load ~25) | 414 s | 600 ms (p95 299 ms) | 400 ms / 1.1 s / 1.1 s | 0, 0 |
| Idle baseline, no job (load ~10 / ~48) | 60 s | – | 38 ms / 281 ms / 304 ms; 317 ms / 1.6 s / 2.0 s | 0, 0 |

A refused Generate (1,200 employees whose Schedule Group has Duty Roster Control off) ended in 39 s with no row
written and the generator's own sentence. The upload's plan transaction (Access lock, the whole file planned) took
336 ms for 1,200 × 31. Personnel (a 20 s-bounded read-only snapshot, no tenant lock) rose from about 4 s idle to
7–9 s p95 during a job on this host: CPU contention, not a lock wait. `verifyTenantChain` stayed valid.

Known limits: the native no-JS confirmation now reports a per-row refusal (duty control off, a shift outside a
Schedule Group, an archived source shift) on the roster page rather than on its own retry page; template, department
and team refusals still answer the confirmation itself. The synchronous `generateRosterFromTemplate`, `copyRoster`,
`assignShiftBulk`, `analyzeRosterImport` and `setEmploymentScheduleGroupBulk` remain for tests and other callers.
