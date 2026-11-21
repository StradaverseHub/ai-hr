# Register and section imports run as background jobs; register files stay all-or-nothing

Status: source implementation on `claude/bulkjob-register-20261110`; hosted verification and integration pending.
Base: `claude/import-staged-job-20261110` @ `0143d761c` (shared bulk-job kernel, ADR 2026-11-10 employee import).
Draft migrations (unallocated): 9930 (kinds `section_import`, `register_import`), 9931 (set-based register release),
9932 (employee import Revert job), 9933 and 9934 (both releases re-decide everything from the database, security
review of 7d2e19db1). Production and staging untouched.

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
3. **Release** is one statement on the worker's queue-owner connection (`app.register_import_release`, draft
   migration 9931), so its per-row cost is the tables' own triggers, not a re-decision per row. It opens the
   creator's session from the grants the database captured at admission (the job is readable only while they stay
   current), takes the writers' locks (Access, its tuples, then the profile policy) and decides once per statement
   what the app role decided once per row: the creator's grants and administration; every captured employee's code,
   person, live company and status; workforce maintain through the same two company-level predicates
   (`access_workforce_company`, `access_workforce_not_denied`) that `access_workforce_employment` and
   `access_workforce_person` apply in the profile value guard; the tables' row security conditions; and each
   employee's register fingerprint (every row's identity and row version, `xmin`, so the comparison does not depend on
   the session's time zone). It then re-validates every captured row against its own employee (a capture that names
   another employee's record is refused) and applies them set-based: changed rows that clear or keep an exclusive
   flag, then rows that take one, then new rows with their captured IDs, then the writers' audit events in file
   order. Draft 9933 makes the captured employee itself (the capture's key: the employment for qualifications, the
   person for contacts) the thing that is authorised, in the job's tenant, rather than the capture's subject list;
   see Trust boundary below. The system label guard and every audit-event trigger still run per row. A read-only organisation
   refuses first, in the creator's own transaction, as a write there would.
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

### Employee import Revert: review without locks, one short release

The employee import Revert (ADR-0155, ADR-0157; `core/employee-import-history.ts:72`) voided every hire of the attempt
in one request transaction under the Access and leave-dependency locks, and its review held the same locks. Now
(`core/employee-import-revert-job.ts`, kind `employee_import_revert`, draft migration 9932):

- The review (`previewImportRevertForAttempt`) and the job's own review read one snapshot with no lock; the
  confirmation only admits the job, inside the synchronous revert's input and authority checks.
- The release, `app.employee_import_revert_release`, is one owner-run statement under the revert's locks (Workforce
  barrier, leave dependency without waiting, the attempt row) and the creator's captured session. It refuses, in
  the synchronous words, when access changed, the import was already reverted or never saved, or what it would
  restore differs from what the creator reviewed: since draft 9934 it reads the attempt's applied items itself (each
  visible to the creator through Import History, every one of them) and recomputes the confirmed preview hash under
  its locks, exactly as the review computes it, instead of comparing with the plan stored on the job. Workforce maintain is decided once per company; the reference
  blockers come from `app.employment_void_reference_blockers`, which `app.employment_void_blockers` now calls, so
  there is one list of judged references; any blocker refuses the whole revert and the worker lists the blockers as
  before.
- The voids then run in the staged import discard's environment (owner connection, no request tenant or user), so
  the per-row guards take their owner path; the `employment.voided` events (in file order), the Import History
  `reverted` event and its audit event are written with the creator as actor, and the last-administrator rule is
  asserted once for the tenant (no voided person has a login: an `app_user` is a void blocker).
- A refused or failed revert records `revert_failed` with its blockers, as before. The history screen follows the
  job and rejoins it after navigation.

Register imports have no Revert: they never recorded an Import History attempt, and still do not.

### Trust boundary of the owner-run releases

Both releases write on the queue-owner connection, so nothing an app-role session can write may decide what they
write. Job and step rows are app-role writable today (kernel grants, migration 9003, hardened separately), so:

- **Who and where.** The job's tenant and creator are the same claim an app-role session already makes through its
  session settings; the grants captured at admission are honoured only while every one is still held by the
  creator's live principal (`app.bank_import_context_current`), so a rewritten grant list cannot widen them.
- **Register release (9933).** A capture is refused outright (`invalid`) without a subject, with a duplicate key, a
  subject that is not the key's own employment or person, or a key outside the job's tenant; and refused (`forbidden`)
  when the creator could not write that key's register through the profile value guard: a qualification's employment
  visible, in a company the creator administers with workforce maintain; a contact's person employed in such a
  company and in no company where workforce maintain is explicitly denied. A key whose status or
  register changed is recaptured from the file, which replaces anything forged. Created rows are inserted with the
  job's tenant and the key, never archived. Events: exactly one `added` per created row and one `updated` per changed
  row, and nothing else; each event's subject employment and every value that describes the row are rebuilt from the
  rows written; the referenced cleared or demoted holder must be a row of the same key changed in the same release;
  the count of events must equal the file's row count. `register-section-import-job.test.ts` forges a capture with no
  subjects, a key in a company the creator does not administer, a key the creator is explicitly denied, another
  tenant's employment, and a created row without its event: each fails the job with nothing written.
- **Employee import Revert release (9934).** The items and the confirmation come from the attempt, never from the
  job's plan; the hash the creator confirmed is recomputed inside the release. `employee-import-revert-job.test.ts`
  rewrites the job's plan and stored hash after the review: the revert is refused with nothing voided.
- **Audit chain.** Both callers arm `app.audit_hash_chain` from the creator's live session, not from captured data.
- **Owner-path triggers.** The revert's voids run with the request tenant and user cleared, so session-aware guards
  on person, employment and employee_statutory_my take their owner path.
  `employee-import-revert-owner-path.test.ts` pins every trigger on those tables and which trigger functions read the
  session, so a new or changed guard fails until the release is reviewed against it.

## Measured (populated rehearsal, `scripts/performance/register-import-rehearsal.ts`)

Private PostgreSQL 16 cluster with durability on, 3,008 fictional employees each holding one live Highest
qualification and one Primary contact, audit chain armed, the real protected worker process, 500-row files (the
register cap) and two 500-hire employee import files for the Revert rows. The host is shared with other agents'
clusters. The table is the run with drafts 9933 and 9934 applied (11 Nov, load average 6 to 9 on 12 cores); the
run before them (9931 and 9932, load about 12) measured the releases at 0.30 s (Qualifications), 0.79 s (Emergency
Contacts) and 0.64 s (Revert): the added checks stay within this shared host's run-to-run variation. A round-1 run at load 23 to 34
measured the old synchronous register commit at 30 to 52 s. Holds are tenant-wide advisory keys sampled every 25 ms in the
rehearsal's own database; the baseline row is the same probes with no import running.

| Phase | Longest import hold | Import chunk holds p50 / p95 / max | Clock-in max | Login max | Access writer max | My Profile / Home max |
|---|---|---|---|---|---|---|
| Baseline (no import) | - | - | 0.75 s | 0.09 s | 0.75 s | 0.12 / 0.51 s |
| Synchronous register commit (before) | 11.8 s Access X | one transaction | 11.0 s | 10.2 s | 11.6 s | 0.02 / 0.15 s |
| Register job, Qualifications | release 0.32 s | 0.08 / 0.14 / 0.17 s | 0.31 s | 0.16 s | 0.24 s | 0.03 / 0.13 s |
| Register job, Emergency Contacts | release 0.43 s | 0.11 / 0.17 / 0.44 s | 0.68 s | 0.07 s | 0.66 s | 0.10 / 0.38 s |
| Section job, Profile | 0.22 s | 0.11 / 0.14 / 0.22 s | 0.40 s | 0.13 s | 0.27 s | 0.03 / 0.14 s |
| Section job, Family | 0.14 s | 0.08 / 0.11 / 0.14 s | 0.32 s | 0.07 s | 0.22 s | 0.02 / 0.08 s |
| Register job, late refusal (row 490) | 0.14 s | 0.08 / 0.14 / 0.14 s | 0.26 s | 0.02 s | 0.24 s | 0.01 / 0.10 s |
| Employee import Revert, synchronous (before) | 5.52 s Access and leave X | one transaction | 4.69 s | 1.49 s | 5.76 s | 0.05 / 0.12 s |
| Employee import Revert, job | release 0.71 s | - (review 0.7 s, no lock) | 0.79 s | 0.19 s | 0.79 s | 0.02 / 0.14 s |

No errors and no Busy in any probe (the Personnel list probe is 3 to 6 s on this host with or without an import).
A normal session saw no partial register file (none, then all) and nothing after the late refusal; the database then
held exactly 1,000 imported qualifications (500 synchronous, 500 by the job), 500 contacts, none from the refused
file, and 500 voided hires for each Revert. `verifyTenantChain` valid at the end.

## Release cost

Measured with `track_functions` on a 500-row file: through the app role the register release paid the profile
value guard (about 1.3 ms per emergency contact, most of it `access_workforce_person`), row security and the
statement lock per row. The set-based statement removes those; what remains per row is the system label guard and
the audit events' own triggers (about 0.76 ms per event at load 13, chain hash included), which are the same for any
writer of these rows. The employee Revert paid `access_workforce_employment` per item twice, the guards per voided
row and the last-administrator assertion per row at COMMIT.

## Not changed here

- The other import kinds' Reverts (Bank & Statutory, Movement, Cost allocation) are unchanged.
- The synchronous `commitSectionImport` remains for its other callers (tests, the Bank & Statutory upload helper).
