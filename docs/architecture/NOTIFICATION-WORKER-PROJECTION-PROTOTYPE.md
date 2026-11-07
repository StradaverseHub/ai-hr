# Notification projection capability: stage 2 checkpoint

Status: source only, incomplete and uncommissioned. Parent is frozen lifecycle
6094fb821429c27e17430422ea1192a9c7ba1075. No local app/DB/runtime/compiler/build
checks were run. No source upload, numbered migration, journal, live role/schema,
installer, scheduler, delivery/provider or deployment operation is part of this work.

## Single canonical recipe owner

core/notification-registry.ts contains the original registry's kind, category,
render and payload-only recipient decisions. Both the existing web engine and the
new direct-postgres adapter construct this registry. The 30 named web reader ports
retain the previous recipient resolver bodies; explicit assessment phase binding
and approval-chase source binding preserve their existing arguments and guards.
All web dispatcher, delivery reauthorization, point greeting, RLS, command, sweep,
page catch-up and schedule behavior remain with their existing owners.

This is a meaningful extraction of the render/payload decisions, not a claim that
every recipient evaluator has been separated into pure fact calculations. Complex
organization, chase, performance and automatic-followup decisions still live in
the unchanged web reader bodies and are unsupported by the narrow adapter.

## Executable bounded native source

The unnumbered projection.sql fixture applies after the exact lifecycle fixture,
guarding four predecessor bodies. It adds real facts, project,
project_reward_account and finish_event functions and replaces empty-only
finish_batch and native terminal counter derivation. The actual worker LOGIN has
only twelve exact API EXECUTE grants and no table, column, app/private-schema,
source, role membership or SQL broker capability. Every call retains the existing
real-login/backend-start/PID/xid8/run/tenant/event/consumer binding and finite caps.

Owner-only registry metadata is derived from the single TypeScript registry, never
accepted through a worker API. It closes kind/category admission and marks missing
recipient families unsupported. An event with any unsupported required port refuses
before settlement; assessment reminders cannot be marked processed. Unknown and
native obsolete legacy events alone may be ignored. A known event with zero current
recipients is correctly processed without inventing a notification.

Implemented native fact branches are payroll audience, immutable published Notice
snapshot, delegation-row recipient, and existing bounded native Contracts,
onboarding and Rewards recipient helpers. Facts derive every aggregate/user/case
argument from the admitted event and retain tenant linkage. Helper-based family
branches are source implementations, not independently qualified recipient parity.
Native calls initialize protected tenant/system-admin helper context after admission;
caller GUCs never establish authority. Existing app helper bodies/owners/configuration
are frozen into a private fixture contract, and later drift refuses admission.
The fixture's public owner is postgres in hosted CI; final installer/native owner
proof remains an independent unfinished gate.

project validates canonical kind/category, same-tenant Employment, exact bounded
render object, local link and severity. Duplicate event/kind/recipient projection
returns the existing ID and contributes zero created count. Actual notification
insertion invokes the existing consent/category/external-identity enqueue owner in
the same transaction. Account-addressed Rewards suspension invokes the existing
bounded native projector once and counts actual inserts. No SMTP, delivery leasing,
transport-state mutation, source account or role/access update is exposed.

finish_event records protected native disposition; finish_batch requires every
admitted event finished, updates exactly those pending processing rows, advances
only the appropriate cursor monotonically, aggregates actual committed counters,
and removes admission. Source intent selection never filters by high-water cursor.
An error at any point rolls back notification, consent outbox, receipt, cursor and
private counters together. Native terminal CAS uses these actual counts; unfinished
or unsupported work cannot turn a run into success. Abandoned run recovery/retention
is still absent, and the existing lease deliberately remains visibly blocking.

## Authored qualification and known blockers

The real LOGIN test constructs two separate equivalent fictional tenants. It compares
canonical web and narrow output without replaying into one changed fixture, including
recipient IDs, exact copy, actual consent outbox, processing dispositions, native
cursor and nonzero job counters. Independent assertions expect eight source events,
seven notices and five pending email outbox rows; no transport is called. Additional
cases fault notification/outbox/receipt/cursor writes and require complete rollback;
retain late commits below the cursor; re-admit overlap duplicates; deny wrong event,
family, kind, category, recipient, rendered shape and direct source writes under
forged GUCs; deny helper drift and inspect actual twelve-API/zero-table exposure.
These tests have not run, and broader helper-family parity remains required.

Original stage 1 run42389556301 failed before cases because its guessed numeric
worker-DB regex rejected canonical /ai_hr_test_w_aifocus1. Source632902895 repaired
that exact harness binding and is merged normally here. Its hosted42390475450 then
failed before role creation on PostgreSQL's127.0.0.1/32 inet text representation.
The consolidated owner now compares native inet equality to explicit127.0.0.1::inet
and requires true plus exact database. Root's independently reviewed a42ed60e source
recovery is to be merged with the equivalent moved-query proof preserved. Original
failed runs and frozen sources remain independent; no capability case pass is claimed.

Run the combined sole-file selector on standard hosted resources, then affected
legacy readers/registry tests and the unchanged complete compiler. Keep original
failures and identities. The general regression selector contains the ordinary
reader tests; the combined real LOGIN suite is a separate substantive required
selector, not an omission from release coverage. Ordinary all-test discovery now
registers the fixed-role fixture only once, as detailed below.

Remaining work: canonical pure recipient/fact evaluators for unsupported families;
actual reminder preparation API with both epoch checks and same-Tx hidden writes;
all-registry legacy/native date/delegation/reminder/account parity and fault matrix;
canonical entitlement/settings/process kill-lever integration without an app pool;
safe owner recovery/retention and bounded resource measurements; final guarded
migration/owner/ACL installer; protected invocation/package/scheduler acceptance.
Existing fallback and all combined maintenance duties remain active and unchanged.
This checkpoint cannot authorize releasing a narrow worker or removing page catch-up.

## Serialized fixture ownership checkpoint

The stage 1 namespace recovery632902895 is merged normally into this source branch;
its frozen source and isolated hosted run remain independent. The projection fixture
now follows the exact canonical marker binding already proved by lifecycle.sql in
the same owner installation transaction.

Only test/notification-worker-lifecycle.test.ts registers native worker tests. Its
explicit sequential outer suite creates the one fixed LOGIN once, runs all ten
original lifecycle/namespace cases under the unchanged stage 1 capability profile,
cleans that owned stage, then registers every nonempty projection case from
fixtures/notification-worker/projection-cases.ts under stage 2. The latter is a
helper, not a second auto-discovered test file. The old projection filename is
removed; selectors now point to the substantive combined suite. No empty/no-tests
artifact or test-discovery/configuration/compiler exclusion is introduced.

One helper owns only the role it created, tracked physical connections, its installed
native schemas and collected test-owned job IDs. Failed installation does not confer
ownership of pre-existing schemas; only a successfully committed fixture stage may
be dropped. The actual owner pools close once after both stages, while case-owned
worker sessions and stage-owned schemas close between stages. This removes the
intra-run cluster-global role race without pretending advisory locks in different
worker databases serialize cluster roles. Two independent complete Vitest invocations
still require separate job-owned clusters, as the repository's global DB fixture
policy already requires. Consolidation does not qualify projection or fill missing
recipient/preparation families.
