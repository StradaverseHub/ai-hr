# Operator tools and review sweeps run in bounded transactions

Date: 10 November 2026. Status: accepted for the sweeps and tools converted below; System Labels import remains open.
Context: DESIGN.md (Access lock and audit chain), owner bar "no transaction holds a tenant-wide lock for more than about
1 s", and the shared bulk-job kernel (2026-11-10-employee-import-staged-job.md).

## Decision

Cron sweeps and operator scripts that no administrator starts from the app do not need the web job UI. They keep
their callers and results but no longer hold the tenant's writer lock for a whole run. `core/operator-chunks.ts` gives
the shape: each transaction takes the same locks as before, re-reads what it needs, handles items until about
`OPERATOR_CHUNK_BUDGET_MS` (200 ms) has passed, and commits. Every item is still judged under the lock on fresh reads,
so the end state equals the single-transaction run; each tool is idempotent per item, so a stopped run is completed by
running it again. Every chunk takes its writer lock through `lockOperatorChunkTx`; with the reader/writer Access lock (branch
`claude/access-wave4-admin-20261110`) that one function becomes the bounded exclusive wait followed by
`app.access_configuration_write_lock()`, so each chunk queues briefly and backs off from a long holder.

- **Review sweeps** (`sweepDueReviews`, `sweepReviewReminders`): keyset chunks in id order. The reminder summary event
  is appended after the last chunk, once, with the run's total. A failure keeps earlier chunks (previously the whole
  run rolled back); the next nightly run carries on.
- **Backup-shift backfill** (`backfillBackupShift`): a lock-free preflight still refuses the run before any write while
  any nominated subject's leave source is held. Rows are then written in chunks; the tenant-wide uncovered image and the
  shift match are checked once per chunk instead of once per row, which is equivalent because nothing else can change
  either while the chunk holds the writer lock. Each row keeps its own audited assignment event.
- **Information snapshot reconciliation**: applying first checks the whole manifest without writing, so a refused item
  still leaves nothing reconciled. Snapshots are then written in chunks, each with its own
  `employment.information.snapshot-reconciled` event listing that chunk's snapshots (same aggregate, same payload
  shape). This is the one audit-shape change: one evidence event per chunk instead of one per manifest, so that no
  committed snapshot is ever without its evidence.

## Measured (fictional 3,000-employee tenant, audit chain armed, `scripts/performance/operator-bulk-rehearsal.ts`)

| Operation | Old max Access hold | New max Access hold |
|---|---|---|
| sweepDueReviews (678 reviews opened) | 23,047 ms | 248 ms |
| sweepReviewReminders (678 reminders) | 4,050 ms | 206 ms |
| backfillBackupShift (300 rows) | 144 ms per row, 19.4 s run | 233 ms per chunk, 8.4 s run |
| reconcileInformationSnapshots (200 items) | 972 ms | 211 ms |

Left unchanged, with measurements: the module change runner (one request, 15 ms; its single transaction is the
documented "no half-installed module" guarantee) and the workforce capability publication (about 240 ms plus 4.5 ms per
tenant: 286 ms at 10 tenants, 786 ms at 100, 1,546 ms at 300). Publication fences every tenant in the transaction that
flips the global catalogue; a chunked publication needs per-tenant publication state, a separate design.

## Open

System Labels import is started by an administrator and holds exclusive Access, the leave configuration lock and the
catalogue table locks for about 1.3–1.7 s at 445 new codes, mostly in analysis under the lock. It is all-or-nothing
today. Moving it to the kernel needs either staged, invisible labels released by one flip (pending markers and
restrictive policies on nine catalogue tables plus a definer audit, as the employee import did) or an owner decision
that a per-step import with a clear partial result is acceptable.
