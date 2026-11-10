# Clocking imports and Recompute Attendance run as background jobs, one employee per step

Status: source implementation on `claude/bulkjob-clocking-20261110`; hosted verification and integration pending.
Base: `claude/import-staged-job-20261110` @ `0143d761c` (the shared bulk-job kernel). Production and staging untouched.
Draft migration (unallocated, range 9940–9949): 9940 `attendance_bulk_jobs` (three `bulk_job_kind` rows, no table).
Amends ADR-0096 (where an import runs, not what it decides) and the Recompute Attendance design (feedback 1c1b321a).

## Context

Both operations ran in one transaction holding the tenant-wide Access lock exclusively, the leave-dependency
configuration lock and the clock key of every employee in scope until commit. Measured on the bulk-job plan's private
cluster: a 2,400-line clocking import held them 57.5 s and Recompute Attendance over one day for 1,207 employees
53–66 s; every clock-in waited the whole time. Clock-in takes the same per-employee key, so a shared Access lock
alone would not have fixed them (docs/plans/bulk-operations-job-migration.md 3.7 and section 4).

## Decision

- **Kinds** (9940): `clocking_import` (one per tenant at a time, as the synchronous import's one background slot),
  `attendance_recompute_preview` and `attendance_recompute` (one per administrator at a time). Mode `per-step`,
  as the owner-approved plan allows: neither is all-or-nothing by its rules except where noted below.
- **Admission.** The web request checks what it always checked (administrator, the file and an active mapping; the
  recompute scope and `app.is_admin_for(company)`) and enqueues. The import worker
  (`aihr-bank-import.service`) runs the job under the creator's freshly resolved authority; every chunk re-takes the
  synchronous path's own locks (Access exclusive plus the leave-dependency configuration lock, exclusive for an
  import and shared for a recompute) for about 100 ms of work, and a recompute chunk re-checks the company authority.
- **Clocking import.** Prepare reads the file and matches every line once, with no lock held (stages 1–2 of
  `decideLines`). One step per matched employee, in employment-id order: under that employee's leave-dependency
  lock and clock key, the step re-reads the employment (a changed card, code, IC or employment span refuses that
  employee's step; their lines are logged `other`/`not_imported`), then decides the employee's lines against their
  days as they stand now (stage 3: business day, corrected day, closed run, Clock-screen day, duplicates, in/out
  reading) and adds them through `addImportedPunchesBatchTx` with the run id minted at prepare. Every decision is per
  (employee, business day). Finalize writes the run log exactly as the synchronous import did: the run row (dated
  when the import was requested) with its pay-run marks and summary event in one short transaction, then the line
  rows in bounded batches. A job that stops before anything was added leaves the synchronous import's Failed row;
  one that stops after some employees were added logs those, with the reason (it reads Failed), their marks and the
  summary event, so nothing added is unlogged. A refusal before anything was read (mapping gone or inactive, empty
  or oversized file) logs no run, as `ClockingImportError` did.
- **Recompute.** Prepare reads the scope's people and authority once. One step per employee: still in scope now
  (labels as they are now; an employee who left the scope is skipped), under the employee's clock key (and, applying,
  leave-dependency lock), `computeRecomputeDaysTx` re-works that employee's stored days exactly as before and an
  apply step writes them (`writeRecomputedDaysTx`). Finalize assembles the synchronous result (rows and flags in
  (date, employment) order, the pay-run warnings) and, applying, appends the run's history event and raises the
  marks. **All-or-nothing where it was:** a changed day owned by a CLOSED run refuses the whole preview or apply.
  An apply therefore first runs read-only `check` steps for the employees whose stored days a closed run may own;
  one hit (or a failed check) skips every apply step and the job fails with the synchronous message. An apply step
  still re-checks under the payroll lock; a run closed in between refuses that employee alone, reported on the job.
- **Screens.** Import Clocking Data and Recompute Attendance show the job in the employee import's progress panel
  pattern (`app/attendance/attendance-job-panel.tsx`), rejoin a running job after navigation, and hand the finished
  job to the existing result: the import log page, or the preview / result tables. Employees a job left out are
  listed. Completion notices: `bulkJobs.notification.{clockingImport,attendanceRecomputePreview,attendanceRecompute}`.

## Consequences

- Equivalence is pinned on a populated fixture (24 employees, three weeks of rotating day/early/night shifts, a
  holiday, Clock-screen and offline clockings, a corrected and a legacy day, a processed and a closed run):
  `test/clocking-import-job-equivalence.test.ts` and `test/attendance-recompute-job-equivalence.test.ts` compare every
  attendance table, the import log, the pay-run marks and the whole audit trail of the job against the synchronous
  call. The only normalisations are generated ids and timestamps.
- Known limits: the AI Centre's chat import still commits a clocking file synchronously (`core/chat-import/confirm.ts`);
  the synchronous `commitClockingImport` and `recomputeAttendance` remain for it and for the equivalence suites. An
  employee whose own work in one file is very large (a month of clockings) is still one step.
- Under concurrent change the job is per employee where the synchronous call was per file: a clock-in made while
  the import runs is respected by that employee's step; an employment changed mid-import refuses that employee only.
