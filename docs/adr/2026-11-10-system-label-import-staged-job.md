# System Labels import runs as a staged job; capability publication runs per tenant

Date: 10 November 2026. Status: source implementation on `claude/bulkjob-labels-20261110`; hosted verification and
integration pending. Draft migrations (unallocated): 9961 staged label import, 9962 per-tenant capability publication.
Context: DESIGN.md (owner bar: no transaction holds a tenant-wide lock for more than about 1 s), the shared bulk-job
kernel (2026-11-10-employee-import-staged-job.md) and the operator-tools ADR (2026-11-10-operator-tools-bounded-transactions.md),
which left both operations open.

## System Labels import

The import held the tenant's Access, leave-dependency and criteria locks and four catalogue table locks for its whole
analysis and write (1.3 s idle, 9.7 s loaded at 445 codes). It stays **all-or-nothing**, as the owner set for register
import.

- **Request.** `startSystemLabelImportJob` checks the administrator and enqueues kind `system_label_import` (one active
  import per tenant) with the workbook, the preview token and the row selection. No HR change happens in the request.
- **Prepare** runs the preview's own analysis with no writer lock and refuses unless the token is unchanged
  ("Labels or permissions changed since preview"), exactly the check the single transaction made. The steps are the
  analysis's writes as plain data (`SystemLabelWrite`): flat codes in workbook order, then each organisation category.
- **Chunks** (about 100 ms) take the single transaction's locks in its order (the tenant writer lock through
  `lockOperatorChunkTx`) and apply each code through its ordinary writer (`bulkSaveLabels` with one create,
  `createProfileOption`, `createJobGrade`, `createGradeGroup`). A grade group first re-checks under the locks that none
  of its grades joined another group, since the group writer would otherwise move them.
- **Staged state.** The nine catalogue tables (department, position, cost_center, business_unit,
  label_company_assignment, profile_option, job_grade, grade_group, grade_group_member) carry
  `import_pending_attempt_id`, stamped by the 9001 trigger while `app.import_attempt` is set, guarded by the 9001
  guard and hidden by a RESTRICTIVE policy of the 9004 shape. The audit events of each chunk are stamped by the 9004
  domain_event trigger. Staged codes still hold their unique-index slots, so an ordinary writer cannot take one.
- **Definer audit.** Of the 99 definers reading these tables, 15 enumerate catalogue rows independently of any stored
  reference and would offer, count, fingerprint or route by a staged code (approval heads, organisation, contract and
  reward choice lists, the assistant's family context, archive entry points, profile value checks, promotion grade
  counts); 9961 re-creates each with `app.label_import_marker_visible` on exactly those reads, after checking their
  count. The rest reach a catalogue row only through a stored reference or a caller-supplied id: nothing references a
  new code and no reader discloses its id. `existing_system_label_import_keys` and `system_label_catalog_conflicts`
  keep seeing staged codes so they stay reserved. No view reads these tables.
- **Owner-connection readers.** The storage-owner connection (scheduled sweeps, operator scripts, the import worker)
  bypasses row security. Every TypeScript read of the nine tables on it was traced from the owner handle
  (`createDb(MIGRATION_DATABASE_URL)`, `owner.withTenant`, `owner.client`, the worker's reserved connection):
  - *Enumerations, now filtered* with `releasedLabelRows` (core/system-label-visibility.ts): the unreachable
    approval rules report's code names (moved to scripts/lib/approval-rule-label-names.ts), the entitlement
    reset's active grades (`resetHealthGrades`) and its criteria catalogues (`loadCriteriaCatalogues`).
    `test/system-label-import-owner-readers.test.ts` proves each hides staged codes until release and pins that
    every catalogue read in them carries the predicate.
  - *By stored reference, unchanged* (no stored reference can name a staged code): lifecycle personnel refresh
    and V9 sweep/e-mail (case and draft ids; notification e-mail sweep), due movements (stored placement ids; review
    sweep), payroll loop acknowledgements (assignment departments; payroll loop tick), information snapshot
    reconciliation, child-relief resync, probation sweep (no catalogue read on its owner path).
  - *Intended*: the import worker's discard (`app.system_label_import_discard_batch`) deletes staged rows.
  - *Not deployed*: development fixtures, seeds and rehearsal scripts. Tenant provisioning writes catalogues
    only for a new tenant, which has no staged import.
 under the same locks: `app.system_label_import_conflicts` (codes that appeared
  while staged and that the preview's rules refuse; unique indexes caught the rest physically), the administrator's
  fresh authority over every staged code, one `app.system_label_import_release` row (which `app.import_released_attempt_ids`
  now includes, so codes and events become visible at once) and the import's `system-label-import.applied` history
  event, with the same payload as before. Markers are not settled afterwards: clearing them would re-fire the
  catalogue tables' update triggers (criteria locks and checks, assistant fences, provider guards) for no visible change.
- **Refusal or stop** deletes the staged rows in bounded owner batches (`app.system_label_import_discard_batch`) and
  records the attempt as discarded; its chunk events are never released. The visible result equals the old rolled-back
  transaction: no codes, no events. The job keeps the reason; the screen shows it and offers "Check again".
- **Screen.** The wizard's Import starts the job and follows it with a progress panel (employee import pattern),
  rejoins a running import after navigation and shows the existing summary and error workbook when it finishes; the
  creator gets the `bulk-job.finished` notice in all six languages.
- **Equivalence.** `test/system-label-import-staged-job.test.ts` imports the same workbook (every category, a head
  employee, inactive codes, a grade group) through the single transaction and through the job on identical tenants:
  codes, criteria, groups, the summary and the multiset of audit events (including the history event) are equal; the
  chain verifies. Event order differs: per code, its create and criteria events are adjacent.

## Workforce capability publication

The installation step flipped the global catalogue and fenced every tenant in one transaction holding every tenant's
access-configuration and profile-edit-policy locks (286 / 786 / 1,546 ms at 10 / 100 / 300 tenants).

- 9962 adds `app.access_capability_publication` (version, state, the rows it replaced) and
  `app.access_capability_tenant_publication`. `app.access_capability_effective(tenant)` shows a tenant the replaced
  rows while a version is publishing and has not reached it; the 14 installed readers of `supported`/`bindings` read
  through it (inlined; one empty partial-index probe when nothing is publishing).
- **Safety property**: no capability becomes effective for a tenant without that tenant's own immutable publication
  audit, which commits with its publication row, preview revision and writer generation. Tests: a refused audit rolls
  back that tenant's publication, revision and generation and every reader keeps the previous catalogue; tenants
  published earlier stay consistent (one audit, one generation step) and later ones stay unpublished; every
  installed reader of supported/bindings reads `app.access_capability_effective` (the four that still name the
  stored table read ids or scopes only) and an open version with no tenant row makes nothing effective; the resumed
  run publishes the refused tenant exactly once.
- The publisher opens the version in one short transaction (exact owner, catalogue, functions and every tenant's
  readiness, then the flip) holding no tenant lock, publishes each tenant in its own transaction (its two locks, its
  publication row, preview revision, writer generation and audit event, exactly as before for that tenant), and closes
  the version when no tenant (including one created meanwhile) is left. A stopped or refused run resumes where it
  stopped; the end state equals the single transaction's. Contract change: a refusal for one tenant no longer rolls back
  tenants already published (`test/workforce-capability-publication.test.ts`).

## Composition with the reader/writer Access lock (phase 2, `claude/access-wave4-admin-20261110`)

The label chunks and release take the tenant writer lock through `lockOperatorChunkTx`, which phase 2 turns into the
bounded exclusive wait (`app.access_configuration_exclusive_wait`, 9820) followed by
`app.access_configuration_write_lock()`; a chunk that meets a long shared holder rolls back and the kernel retries it.
The writers it calls take `app.access_workforce_write_lock()` themselves and follow phase 2's classification of those
sites. The publisher's per-tenant transaction takes `access-configuration:<tenant>` exclusively by name; at
integration it should take the same bounded wait first (one tenant, a few milliseconds of hold).
