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

Stage 1 run42389556301 failed before cases because its guessed numeric worker-DB
regex rejected canonical /ai_hr_test_w_aifocus1. Original source and failed evidence
are preserved. Root assigned a separate child of6094 for an exact test/db-names.ts
namespace-binding repair; this checkpoint intentionally does not mix that recovery.
The inherited fixture namespace blocker must be merged before either stage can be
qualified. No passing claim is inferred from authored tests.

Native lifecycle and projection files must run in separate sole-file hosted jobs
with separate physical PostgreSQL clusters: the approved fixed LOGIN name is
cluster-wide, not isolated by per-worker database names. Before an ordinary broad
all-test run, consolidate fixture ownership or add a reviewed shared fixture lease;
parallel role creation is not qualified. Keep all compiler inputs included.

Run the projection sole-file selector on standard hosted resources, then affected
legacy readers/registry tests and the unchanged complete compiler. Keep original
failures and identities. The general regression selector intentionally excludes
both native fixed-role files; run those separately, never silently omit them from
release coverage.

Remaining work: canonical pure recipient/fact evaluators for unsupported families;
actual reminder preparation API with both epoch checks and same-Tx hidden writes;
all-registry legacy/native date/delegation/reminder/account parity and fault matrix;
canonical entitlement/settings/process kill-lever integration without an app pool;
safe owner recovery/retention and bounded resource measurements; final guarded
migration/owner/ACL installer; protected invocation/package/scheduler acceptance.
Existing fallback and all combined maintenance duties remain active and unchanged.
This checkpoint cannot authorize releasing a narrow worker or removing page catch-up.
