# Register and section imports run as background jobs; register files stay all-or-nothing

Status: source implementation on `claude/bulkjob-register-20261110`; hosted verification and integration pending.
Base: `claude/import-staged-job-20261110` @ `0143d761c` (shared bulk-job kernel, ADR 2026-11-10 employee import).
Draft migration (unallocated): 9930 adds the kinds `section_import` and `register_import`. Production and staging untouched.

## Context

The per-section importer updates people who already exist. Before this change:

- **Register files** (Qualifications, Emergency Contacts, `core/personnel-register-import.ts`) were one transaction
  for the whole file under the tenant's Access lock, the profile-edit-policy lock and the audit-chain lock: 5.0 to
  7.8 s for a 500-row qualification file and 7.0 to 9.6 s for a 500-row contact file on the rehearsal host
  (3,008 employees, loaded host). Every clock-in, login audit and Access writer waited for it.
- **Profile and Family files** (`core/import-sections.ts`) were already one transaction per row, but each row's
  locked transaction re-analysed the whole file, including a database check per other row (card IDs, family
  members), so each row's lock hold grew with the file; and the whole file ran in the web request.
- The register **preview** held the Access lock for the whole dry run, which writes nothing.

Owner decision (10 Nov 2026): keep register import all-or-nothing if the staged approach can support it; whole-file
validation with per-employee writes and Revert only as the fallback.

## Decision

### Register files: captured writes, one release

A register file changes existing records, so the employee import's invisible staged rows do not apply: an update in
place is visible the moment it commits. Versioned rows with a "current" pointer were rejected: Record IDs are shown
to and typed by administrators, and audit events and the single-Highest/Primary transfers reference them, so a new
version would either change the ID or need a second, file-sized swap with its own visibility window.

Instead (`core/register-import-worker.ts`):

1. **Prepare** runs the commit's whole-file analysis on one read-only snapshot, with no tenant lock. Any invalid row
   refuses the file with the synchronous message ("Correct all register rows before importing...").
2. **One step per employee** (the employment for qualifications, the person for contacts), in chunk transactions of
   about 100 ms under the writers' first lock. The step locks that employee's subject rows, re-runs the same analysis
   for that employee's rows, then runs the **unchanged register writers** (`writeRegisterRowsTx`) inside a savepoint
   whose `app.import_attempt` is a throwaway token, so the database stamps exactly the audit events those writers
   append. It captures the employee's register rows before and after, the diff, and the events, then rolls the
   savepoint back. Nothing the file changes is ever visible before the release.
3. **Release** is one transaction under the writers' own locks (Access, then profile policy) and the creator's
   freshly resolved authority: it checks, by primary key, that every captured employee still holds the same code
   and person in a live company the creator administers, compares each employee's register fingerprint (an md5 of
   every row as the creator's session sees it) with the one captured before the writers ran, and then applies every
   capture set-based: changed rows that clear or keep an exclusive flag, then rows that take one, then new rows with
   their captured IDs, then all events in file order through `appendEvents`. The tables' own triggers and row
   security run as for the writers; at COMMIT the deferred profile value guard re-checks workforce maintain
   authority for every written row, exactly as it did for the synchronous write.
4. **Changed meanwhile.** An employee whose register or identity changed between capture and release is sent back
   for a fresh capture (its steps become pending again, the job returns to running); after three rounds the import
   stops with nothing written. Concurrent edits survive: the fresh capture runs the writers on top of them.
5. **Failure or cancel** needs no undo: nothing was committed before the release.

Results stay identical: the same validation messages (same analyzer, same writers), the same rows (the writers'
own output), the same events in the same order, the same `employee_import_run` row (only when something was
written), the same result object, and the same `No register rows were written. ...` shape when a write is refused.

### Profile and Family files: one row per step

`applySectionRowTx` is the old per-row transaction body, extracted unchanged, and both the synchronous commit and the
job (`core/section-import-worker.ts`, kernel `per-step` mode) run it. A row's commit-time re-analysis keeps the
whole-file in-memory checks but runs the per-row database checks (card ID free, family members valid) for that row
only: they decide only their own row's verdict. Busy refusals are retried by the kernel instead of becoming failed
rows. Child-relief refreshes run after the rows (bounded finalize units), then the history row. A cancelled or
stopped job keeps the rows already saved, as each row was its own commit, and records them in the history row.

### Read-only paths

The register preview (`validateRegisterImport`) and the "current records" download (`registerRecordsForEmployee`)
read one REPEATABLE READ snapshot and no longer take the Access lock: they write nothing, and in a read-only snapshot
taken at BEGIN the lock only made them wait.

### Web side

`commitSectionAction` parses as before, then admits the job (`createSectionImportJob`, inside `app.is_admin()` and
the kernel's captured grants); oversized register files are refused before admission in the synchronous words. The
section screen shows the employee import's progress panel pattern and hands the finished result to its existing
result card; it rejoins a running import after navigation. Completion notices: `bulkJobs.notification.sectionImport`
and `.registerImport` in all six catalogues, opening the import page whose history list shows the run.

## Measured (populated rehearsal, `scripts/performance/register-import-rehearsal.ts`)

Private PostgreSQL 16 cluster with durability on, 3,008 fictional employees each holding one live Highest
qualification and one Primary contact, audit chain armed, the real protected worker process. The host was shared
with other agents' clusters: load average 23 to 34 on 12 cores throughout, so every number is inflated; the baseline
row is the same probes with no import running. 500-row files (the register cap). Holds are tenant-wide advisory
keys sampled every 25 ms in the rehearsal's own database.

| Phase | Longest import hold | Import chunk holds p50 / p95 / max | Clock-in max | Login max | Access writer max |
|---|---|---|---|---|---|
| Baseline (no import) | - | - | 0.81 s | 0.15 s | 0.63 s |
| Synchronous register commit (before) | 30.4 s Access X (52.3 s in an earlier run) | one transaction | 29.6 s | 26.6 s | 30.2 s |
| Register job, Qualifications | release 1.65 s | 0.14 / 0.35 / 0.66 s | 1.64 s | 1.13 s | 1.67 s |
| Register job, Emergency Contacts | release 1.88 s | 0.13 / 0.25 / 0.55 s | 1.70 s | 1.17 s | 1.78 s |
| Section job, Profile | 0.74 s | 0.17 / 0.34 / 0.74 s | 1.01 s | 0.23 s | 1.13 s |
| Section job, Family | 0.54 s | 0.12 / 0.24 / 0.54 s | 1.21 s | 0.15 s | 1.17 s |
| Register job, late refusal (row 490) | 0.62 s | 0.16 / 0.35 / 0.62 s | 1.46 s | 0.28 s | 1.83 s |
| Employee import Revert, 500 hires (not converted) | 18.8 s Access and leave X | one transaction | 19.3 s | 5.5 s | 18.9 s |

No errors and no Busy in any probe (the Personnel list probe is 9 to 15 s on this host with or without an import).
A normal session saw a register file's rows jump from none to all (counts seen: 500 then 1,000; 0 then 500); after
the late refusal it saw none. `verifyTenantChain` valid after every run. Release parts (Qualifications /
Emergency): subject check 32 / 29 ms, apply 715 / 1,138 ms, COMMIT (deferred guards) 887 / 716 ms.

Release cost is linear: about 2.3 ms per written row on this host (audit event with its row triggers about 0.9 ms,
deferred profile value guard about 1.1 ms, keyed row write about 0.3 ms), measured at 100 to 500 rows.

## The fallback was not taken

The release is above the 1 s bar at the 500-row cap on this oversubscribed host (1.65 to 1.88 s); in the same window
ordinary clock-ins held the same Access lock for up to 1.34 s. Its cost is the register writers' own per-row
work (audit events and the authority guard), which no design can drop without changing audit or permission checks;
staging events ahead of the release would leave phantom audit rows for imports that are later refused. The fallback
(per-employee writes, then Revert) was not built because its Revert is, by ADR-0155, one all-or-nothing transaction
running the same writers over the same rows: the measured synchronous shape of that is 30 to 52 s at 500 rows
(compare the employee Revert, 18.8 s), so it moves the long hold to the undo path instead of removing it. Options for
the owner: accept the bounded release (cap 500 rows, linear, projected well under 1 s on an uncontended database);
lower the register file cap (200 rows measured about 0.5 s on this host); or the fallback with a chunked, not atomic,
Revert. Phase 0 (commit seal) takes the audit-chain lock off the event inserts and phase 2 makes the Access lock
shared, which leaves only the profile-policy lock exclusive during the release.

## Not changed here

- `core/employee-import-history.ts:72`, the employee import **Revert**, still voids every employment of the attempt
  in one transaction under the Access and leave-dependency locks. It is all-or-nothing by ADR-0155 and belongs to
  the import-revert conversion (plan step 12); its measured hold is recorded with the rehearsal.
- The synchronous `commitSectionImport` remains for its other callers (tests, the Bank & Statutory upload helper).
