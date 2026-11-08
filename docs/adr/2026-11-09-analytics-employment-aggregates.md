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

## Follow-up: one exact change-job page envelope

This isolated source candidate is a direct child of
`0bbef1ea9d11ad2ce00d94e21d9a70cd859f7c2d`. The authenticated later 48a46
course diagnosed an empty change-job page SELECT followed by a separate exact
count SELECT; their observed waits are historical measurements of that source,
not a causal speed prediction for this candidate. No new behavior or timing has
been executed locally. The one-second and complete application/browser goals
remain open.

Only `changeJobTransactionsPageTx` changes in product code, with a private typed
transport mapper. One explicit MATERIALIZED CTE contains the whole original
`changeJobTransactionsRowsTx` SELECT. The count and the ordered limited page
consume that same relation. The count is exact, including a past-end page; a
LEFT JOIN returns one transport envelope when the page is empty. Its absent
assignment ID maps to no business row. Dates still pass through the canonical
Assignment date-column decoder. Ordering remains effective date descending,
name, employment ID and assignment ID. Parameters use public Drizzle SQL and
execute APIs; no session internals, new filters, DISTINCT, nearest-predecessor
selection, estimated count, cache, index or concurrent borrowed work is added.

The original successor range/non-superseded predicate, INNER exact-boundary
non-superseded predecessor join, department-either-side predicate, free name/email
query and native scope semantics remain whole. Every other Analytics function,
export, admission, principal/JIT policy, money calculation and cursor owner is
unchanged. A native department value cannot currently be NULL under the actual
NOT NULL/FK and same-tenant label constraints; the public nullable label types
remain. Tests exercise actual nullable Position labels and the wholly null
empty envelope instead of disabling native constraints to fabricate a department.

The bounded-report owner adds three native cases: empty/first/last/past-end
pages with name/employment ties and string dates; exact-boundary multiplicity,
assignment ties, corrected predecessors, both department sides, wildcard/email,
genesis/termination exclusion, scope/foreign fences and fresh-principal refusal;
and an exact 2,052-row population past the All ceiling with complete export.
The multiplicity fixture uses an allowed zero-length `[D,D)` historical range,
which is empty for the existing no-overlap exclusion. It does not insert
nonempty overlapping current ranges or relax a constraint. Two composition
cases retain complete thirteen-DTO parity behind a held Access writer without
audit writes, and prove settlement/release when the envelope fails. All old
callbacks and assertions remain, except the two explicitly justified census
expectations below. Existing native snapshot-mutation and read-only controls
remain whole.

For the original empty-change 50k fixture, one envelope replaces two statements.
The source expectation is therefore 121 instead of 122 statements. Its one
sentinel transports the same one count row formerly returned by the fallback,
so the independently required row census remains 90,089. These are assertions
for a future native run, not rewritten receipts. Every older result remains
bound to its actual source, including the older 125-statement JIT course.

The existing native-scale test preserves every original timing, full export,
50k fact, four aggregate replay arms and seven aggregate plans before any new
fixture mutation. Its public SQL capture admits only the fixed product envelope
execute shape in addition to its existing SELECT builders. After those courses,
two separately named diagnostics observe the actual admitted app RR/RO/JIT-off
snapshot: the original empty 50k population, then the same 50k employees with
two owned abutting assignment histories. Each validates independently expected
DTO/count/transport facts, one product envelope, one native plan with one
materialized producer and two consumers, and identical actual app identity
before/after. The two inserted rows are deleted and their exact owned
predecessors reopened in `finally`, with original population/closed counts
checked after restoration. No product query is replaced by test SQL.

There are seven original plus two new sanitized, content-free plan objects,
with the existing 256-node detail bound per plan. The original 300-second case,
profile, pools and cleanup owner remain. These warmed extended callbacks have
separate timing names; they cannot establish a whole-dashboard or cold speedup.
The separate JIT owner changes only its prospective Analytics census assertion;
its three cases, five shape digests, twenty plans, cancellation, rollback,
identity, fingerprint and restoration controls remain whole. Hosted native fit,
source-qualified performance and all broader acceptance remain unknown.

The compact nonruntime source record uses whole-parent immutable Git blob
references and verified inverse hunks for the five changed owners. Existing
historical qualification maps and receipts remain byte-exact; the record does
not embed them or transfer their runtime status. Root and a different peer must
fully review this frozen source before existing hosted selectors run it.

## Carry page rank selection — bounded source candidate, 9 November 2026

The actual817f ordinary course returned50,000 carry identities in98 fixed512-row
FETCHes. This candidate changes the page reader to fixed4096-row FETCHes and
retains only the requested rank prefix in a max heap. Every native occurrence
is still read and counted. The comparator remains the existing runtime
`name.localeCompare`; native cursor input ordinal breaks equal comparisons,
matching the old stable full-array sort without adding a SQL collation.
The UUID-ordered population, DECLARE, normal CLOSE, permissions, one RR/RO
transaction and the complete export/financial owners remain unchanged.

The retained prefix is at most `min(population, offset + limit)`, plus one fixed
batch. Safe arithmetic saturates a rank limit without allocating it. Deep pages
can retain the full population; this is no fixed global memory or subsecond
claim. All keeps its existing2000-row disclosure ceiling and complete total.
Only the selected IDs enter the unchanged historical entitlement/ledger reader.
Any cursor or comparator failure propagates to the existing transaction owner;
no retry or cleanup query can replace the original failure.

Three added bounded native controls use actual app RR/RO cursor rows as the old
stable-sort oracle, exercise fixed-batch boundaries/Unicode ties/All/deep pages
and cause a genuine native FETCH failure by closing the owned fixture cursor.
A composition control verifies that failure settles before the later master
report. Original callbacks remain whole except two explicit census assertions.
Current constraints forbid fabricating duplicate current Assignment matches;
duplicate names and concurrent distinct Employments are legal fixtures.

On the same50k source fixture the prospective census is23 unchanged statements
plus13 FETCHes=36, retaining90,089 driver rows. The two classifiers retain512
history and recognize only the additional fixed4096 shape. All seven aggregate,
two envelope and twenty JIT plans/limits remain. The ten unchanged financial
regressions are affected selectors alongside bounded/composition/native-scale;
the three-case JIT selector remains a separate sole-file course.

This is source implementation awaiting whole-source review and actual hosted
qualification. It does not transfer817f evidence or qualify one-second loading,
browser preflight, worker counts, zero Busy or staging. Historical indices stay
historical; the compact nonruntime source record binds actual immediate-parent
preimages and protected owners without becoming a runtime dependency.

### Carry boundary recovery: owned timeout settlement and bounded phases

The frozen carry selection candidate `fca1bdd3f9afcf598c643ac2c4cfb482a21bb824` retained the original business population and reduced the measured native Dashboard census to36 statements/90,089 rows. Its ordinary course42526765409 nevertheless failed the new B1 boundary case at120,993ms and retained one separate unhandled Postgres driver error. The original inner timeout phase and driver-error cause remain unknown; the separate JIT course42526767636 passed under its own identity. Those results are not transferred onto this source repair.

This follow-up changes only the bounded test's B1 operation lifetime and phase observations. Its seven original population boundaries, eleven real pages, Unicode/duplicate-person inputs, same-stream sort oracle and142 existing direct-case expect subtrees remain. The other thirteen callback bodies, financial/product functions, cursor4096, shared helpers, fixtures, resources and120s/30s/20m budgets are unchanged. There is no cohort redesign, row reduction, subcase timeout or query substitution.

B1 publishes its whole pending body before initial preparation, uses the existing owner pool's public Postgres `reserve()` API for one dedicated control connection, and holds each actual fixture/command/read transaction until its native work and any one issued cancellation request settle. Native target PID/start/database/login/local tag are private; the distinct reserved control must actually observe the held target. Synchronous closing disarms that callback before exit, preventing a later abort from enqueueing a stale cancellation. Cancellation never awaits the target body. Commit/rollback and the complete body settle before the reserved control verifies original backends idle or absent. Uncertain ownership stays poisoned: later reset/close refuse, and the unchanged external owned-job cleanup remains responsible. No pool, maximum, permission or production cancellation path is added.

A single fixed component-only artifact records at most128 events/64KiB, with a source-derived full-success census of125 events (126 with abort), seven phases, eleven pages, seventeen FETCH observations,30,212 oracle rows and60,424 completed row-type assertions. It exports timing/count/property facts, never names, internal IDs, SQL, parameters, raw errors or connection strings. Native-await and assertion costs remain distinct observations, not an inferred CPU/lock diagnosis. A would-be pass without complete required evidence fails.

This is source-only until independent full review and the affected14-case hosted course finish with no unhandled errors, complete phase/identity/resource evidence and owned settlement. It grants no1second, concurrent zeroBusy, staging or release claim. The compact source record binds exact Git preimages and retains the failed original course explicitly.

Pinned Postgres3.4.9 implementation review also found that the reserved SQL runtime exposes tagged SQL and `release`, although its declaration inherits a `begin` method. The private control owner therefore uses actual tagged SQL BEGIN/LOCAL bounds/COMMIT and awaited ROLLBACK on that reserved physical connection. It never calls the absent method or copies driver internals. If rollback cannot confirm control settlement, the target callback remains held and poisoned for external owned-job cleanup; a rejected control promise is not silently interpreted as native cancellation completion.
