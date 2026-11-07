# Native process identity and cost recovery

Fixture-only child of `72adf357379ce4c02a76d2a6d1db179f72061365`.
The original hosted run `42406535776` is retained as **FAIL:44 passed,
7 failed,51 collected**. Its owner catalogue measured55 sealed and55 actual
triggers,3 custom triggers, zero drift and zero unexpected triggers. The complete
guard/hostile controls passed. Earlier `42405285922` remains41 passed/10 failed;
the unaffected pure `42405291849` success is retained separately.

Six failures occur at an incorrect `Date` assertion: the actual raw PostgreSQL
driver returns `backend_started_at` as text, including microseconds. This recovery
compares backend PID/start natively against `pg_stat_activity` at admission and
checks both exact-identity absence and PID absence after exit. A reused PID still
refuses. The hostile recovery case constructs a live-PID start mismatch of exactly
one microsecond in PostgreSQL. Its `finally` restores the original text through an
explicit text-to-timestamptz conversion and verifies the full original identity.
No JavaScript Date parsing, truncation or `getTime` conversion remains.

The seventh failure is real and unresolved: the161-event, eight-batch case took
31.599 seconds and hit the unchanged30-second case timeout. The retained artifact
has no per-batch progress record; neither throughput nor a specific API's cost can
be inferred from that timeout. No process-budget success is claimed.

Each real child now has an exclusive0600 owner-side JSONL progress file in the
canonical focused/full-CI evidence directory. Its header binds source, hosted run,
attempt, owned database, fixed scenario, ordinal and unchanged bounds. Synchronous
transition records survive a later timeout. Parent monotonic elapsed times measure
observed IPC acknowledgements, including admitting-to-committed intervals; the
worker sends `committed` only after its real transaction resolves. These are wall
intervals, not isolated CPU or exact database commit timestamps.

One serialized owner query per transition records actual run/job counters, native
committed receipt count, settled-batch counts/timestamps, scoped pending count and
the exact backend's state/wait event. SQL text is reduced to a fixed phase label;
no raw query, credentials, HR content, event payload or environment is written.
Snapshots record request and observation times because they can lag transitions.
The existing ledger timestamp is captured inside settlement, not an exact commit
timestamp. The recorder does not pause/await the child or supply authority/counts.
It adds some diagnostic observer work, which must be acknowledged in measurements.

After each case, all owned children are killed if needed, awaited and sampled
before fixture cleanup, including timeout failures. Diagnostics refuse beyond64
children,128 records or256KiB per child; a failed snapshot fails the fixture rather
than pretending complete evidence. No polling/background task outlives cleanup.

The worker process, child entrypoint, native SQL/privilege/profile guards,51 case
declarations,161-event workload,20-event/eight-batch/240-second worker limits,
20-second statement/300ms lock limits and30-second case timeout are unchanged.
The sole affected selector is
`notification-process-native-identity-cost-tests.json`; the pure test is unchanged.
Original failures and valid unaffected passes retain their exact source/run claims.

This candidate is **unrun**. Root and independent review precede hosted recovery.
The next artifact must identify actual completed batches, pending work and observed
intervals before any workload/test-budget change or throughput conclusion. There
is no installed/package/process-service qualification, page catch-up removal,
provider call, numbered migration, upload, deployment or production operation.
Rewards prototype WIP remains untouched in its separate worktree.
