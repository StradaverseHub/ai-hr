# Analytics dashboard employment aggregates

Status: source candidate; no behavior has been executed for this change.

## Evidence and scope

The parent is `578cf5adc9f2938e7336b5f8e6aeb85095992e8e`. Its Analytics
source differs from the authenticated f924 diagnostic source only by the fixed
dashboard `SET LOCAL jit=off`. The later authenticated parent-source native
course, Actions 42503840637 attempt 1/controller 82859, completed all three
cases, 36 receipts and 20 counterfactual plans. Its four effective-OFF dashboard
reads took 4.692–4.773 seconds, with 125 statements and 90,091 returned rows.
Turnover's three counts awaited 391–397 ms; movement's two counts awaited
617–625 ms. These are statement awaits, not additive CPU attribution or a
prediction of improvement. The earlier f924 OFF timings belong to another
course and are not a paired comparison with this candidate.

This slice changes only two dashboard consumers. Demographics still transports
40,000 rows in that fixture, and carry pagination still transports 50,000
identities through its cursor. Their JavaScript age, tie-order and locale-sort
contracts remain separate open work. The unchanged one-second objective and
whole-module/browser acceptance remain unproved.

## Decision

The dashboard retains one `withAnalyticsPresentation` admission: captured
context/scope/filter/page inputs, native fresh principal, actual RR/RO snapshot,
then its one fixed local JIT command. It calls two private aggregate readers:

* Turnover uses one Employment-only filtered-count query for leavers and both
  endpoint headcounts. Its scope and optional company predicate are unchanged.
  It does not acquire the movement reader's Person/Assignment joins or other
  filters. Count conversion, `round1`, zero-denominator handling and percentage
  calculation retain the original expressions.
* Movement retains Employment INNER Person LEFT current open nonsuperseded
  Assignment. A lateral two-event VALUES source contributes each hire and each
  termination independently. The original inclusive event range and
  `analyticsWhere` predicates apply before monthly aggregation. Both events in
  one month count; nullable termination contributes none; employment and join
  multiplicity are never deduplicated. Existing JavaScript month ordering and
  subtraction form the result. `lifecycleStatus` and nationality retain their
  original ignored-filter behavior here.
* A truthy `assignmentStatus` delegates movement to the whole original two-query
  owner. That predicate derives today's status separately for the original
  branches. This change introduces no replacement clock or effective-date
  policy. Empty status follows the original falsy predicate behavior.

All standalone RC readers and original private query bodies remain byte-exact.
No public API, export, writer, money service, RLS policy, grant, module gate,
pool, global setting, cache, schema or migration changes. Existing empty-array
scope semantics still rely on native RLS rather than becoming an empty result.
Analytics has no separate ViewAs entry or SessionContext field; no Rewards-only
ViewAs mechanism is imported or claimed as Analytics coverage.

## Correctness controls

The frozen test oracle copies both original five-query function bodies from the
exact parent and borrows the test's explicit Tx. It imports the unchanged
canonical `analyticsWhere`, with its source pinned independently. Seven native
cases compare complete turnover/movement DTOs with the oracle and independently
known fictional counts: inclusive boundaries, same-day events, reversed/empty
windows, rounding, deliberately different filter sets, concurrent employment,
closed and historical assignments, scoped HR/employee/manager/foreign fences,
truthy-status fallback, a genuine committed transfer between report bodies,
fresh-principal refusals, native read-only enforcement, held Access writer and
absence of read audit events. They use current canonical hire/transfer/terminate
writers and the existing fixture owner; no authority is relaxed.

The existing composition case now proves five original aggregate SELECTs versus
two new SELECTs while comparing every other observed query byte-for-byte. Its
receipt says `equalUnaffectedNativeDataQueries`; it no longer falsely claims all
native data queries are equal. Every independent report DTO assertion remains.

The 50k census is predicted to change from 125 to 122 statements and from
90,091 to 90,089 returned rows. Turnover returns one row instead of three;
movement still returns two fixture months in one statement. Explicit native
summary assertions must establish those counts. This is not a universal bound
on the remaining dashboard transport or a measured performance claim.

## Measurement and lifetime

The existing 50k unobserved dashboard timing, subsequent instrumented timing,
standalone timings, full exports and all independent fixture facts remain.
After them, one additional real dashboard callback is observed through the
existing test-only `withTenant` seam and public Drizzle `getSQL`/`toSQL` APIs.
When that product callback finishes, its same actual admitted app RR/RO Tx runs
the frozen five reads, then immutable captured statement sets in the balanced
order OLD/NEW/NEW/OLD. It also runs exactly seven EXPLAIN ANALYZE plans: the five
old SELECTs and two new SELECTs. The product's native principal and fixed policy
have already run; no test GUC, second admission or new connection/pool is added.
Actual app login/role, PID, RLS, isolation, read-only mode and effective JIT are
checked before and after, with same-PID checks between arms. Every native await
settles before the next; any failure rolls back through the existing owner and
the observer is restored in `finally`.

This experiment compares target native statements only. Its extended callback
duration is separately named and cannot be presented as a whole-dashboard
timing, storage-cold sample or JIT ON/OFF experiment. Replay plan reuse is
ordinary and explicitly labelled. Repeated raw results stay in memory for
parity; receipts contain digests, row counts, timings, native identity and
bounded numeric plan nodes, never SQL, parameters, result content or new error
content. Seven plan records permit at most 256 nodes each and refuse overflow.
Partial started/completed records are persisted as the course progresses.

The case remains capped at 300 seconds. The previous ordinary parent case took
205.499 seconds; that is historical margin, not a guarantee. No fixture, old
timing, assertion or resource limit is removed to accommodate the experiment.

The existing three-case JIT diagnostic changes only its Analytics expected
statement/row census. All five native shape digests, 20 counterfactual plans,
principal/cancellation/commit/rollback/default/restoration controls and limits
remain whole. Prior evidence retains its original source identity.

## Qualification boundary

This seven-path source candidate must receive root and independent full source
review before publication or hosted execution. External AST/hash/Git analysis
is not a test pass. The CI owner must independently review the new oracle's
runtime source closure and any required registration under its own lease.
Hosted native parity, complete observed census, target plans/timings and cleanup
are required before judging improvement. No source-only, focused, staging or
production acceptance is inferred from this ADR.

## Receipt normalization and settlement

Repeated native statements compare numeric count vectors and sorted monthly
facts. Raw GROUP BY row order is not a contract, so reordering alone cannot
refuse a semantically identical replay. Independent known-value assertions,
actual statement objects and every original timing remain unchanged.
`callbackComplete` records the finished in-transaction experiment;
`transactionSettled` and `complete` become true only after the outer timed
dashboard await returns through COMMIT. A callback/commit failure retains its
partial receipt, and the test observer is always restored in `finally`.
