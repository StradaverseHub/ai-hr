# Canonical ESS leaf queries on an explicit transaction

Implementation child of qualified Draft source d45c1fbc4e91aa0edb261b52e4fa8016e223740e,
following step 2 of the approved canonical-Tx adapter design. Root approved this
finite extraction scope, including the previously missing detailed compensation
history seam. All new behavior is UNRUN. No staging or production operation is
made or authorized by this source record.

Seven exact private query/transformation owners now serve legacy wrappers and
explicit low-level Tx helpers. There is one SQL spelling per leaf:

| Canonical owner | Explicit Tx helper | Preserved legacy carrier |
| --- | --- | --- |
| core/read.ts | assignmentHistoryTx(tx, employmentId) | ordinary withTenant |
| core/profile-options.ts | listAllProfileOptionsTx(tx, opts) | ordinary withTenant |
| core/pay-components.ts | listEmploymentPayComponentsTx(tx, employmentId) | ordinary withTenant |
| core/comp.ts | compensationHistoryDetailedTx(tx, employmentId) | withPayrollHistoryTenant |
| core/cp38.ts | listCp38Tx(tx, {employmentId}) | withPayrollHistoryTenant |
| core/shift-arrangement.ts | shiftArrangementHistoryTx(tx, employmentId) | ordinary withTenant |
| packs/attendance/own-profile-read.ts | ownProfileAttendanceSummaryTx(tx, {employmentId,today,defaultShiftId,shifts}) | existing final facts withTenant |

Payroll/attendance seams are exposed through their pack service facades. The
attendance implementation consumes canonical schedule-group owners inside its
pack surface. Kernel consumers gain no direct implementation import or new
country fallback. No pack drift allowlist is expanded.

## Authority and preserved behavior

These helpers are transaction queries, not admitted own-profile purposes. A real
Tx does not grant History, principal, tenant, own-person, presentation or edit
permission. No caller policy flag or portable verified object is introduced.
Future composition must establish actual canonical shared History before Access
and fresh native current principal/policy; that separate purpose is not built
here. The existing payroll History owner and all public legacy transaction
carriers remain in place. No new lock, timeout, isolation, pool, GUC, suspension,
cancellation, admission or command rule is added or removed.

The complete original query bodies retain all columns, joins, filters, ordering
and mappings. Assignment excludes superseded rows and keeps validFrom/id DESC.
All profile-option buckets remain present, activeOnly is unchanged, and category,
sortOrder/value order and unknown-category handling are retained. Pay components
exclude superseded rows while retaining ended rows, catalogue flags and complete
cycle joins. Compensation keeps its event/actor/person joins, salary/allowance
strings and validFrom order. CP38 keeps every closed/superseded row and its
validFrom/id DESC order. No money, month status or country calculation is copied
into a helper or fixture.

Shift rows are still queried ascending before previous-shift derivation, then
reversed; actor, ISO timestamps and first unowned backfill metadata are intact.
The attendance helper keeps the same schedule-group lookup, inclusive end date,
unique-only active period, and legacy default lookup only when history is empty.
The legacy facts reader captures the same HR today once and still opens its
separate final transaction. Its fan-out, policy behavior, masking, visibility,
financial/leave/service projection, module flags and movement comparison remain
unchanged outside that exact leaf call. Workspace and all command writers are
unchanged. This is no new facts/workspace composition or live Tx-course adoption.

## Prepared verification

The new real DB selector navigation-v3-ess-leaf-parity.test.ts has 8 cases. Actual
canonical writers create fictional dated assignments, options, compensation,
recurring items, CP38 instructions and shifts. Whole old/new DTO equality is
checked with independent known IDs/dates/amounts/labels/actor inputs. It checks
ended/superseded distinctions, complete catalogue buckets, previous-shift order,
inclusive attendance end and no-history fallback. Real app transactions record
native backend/start/root-XID/GUC continuity and refuse privileged role use.
Relevant complete business/history rows and DomainEvents are compared before and
after reads. Own-person and foreign-tenant RLS are exercised. These cases do not
prove every statement's backend, peak borrowed connections, lock-free reads or a
full ESS presentation purpose; those remain later native obligations.

Four new source controls reconstruct all 12 changed parent files, compare exact
original private SQL/transformation AST source, preserve legacy carrier identity
and explicit delegating interfaces, and prove that the rest of facts composition
and movement comparison is byte-exact. TypeScript is used for source AST only;
no custom compiler Program or native type-check authority is inferred. The
whole-parent inverse also preserves both generated source identities and the
inherited manifest control rather than rewriting its historical record.

The sidecar lists every actual affected legacy selector and its exact current
hash. Run the new 8 DB cases, new 4 source controls, actual existing manifest
admission and all listed affected legacy checks on standard hosted Actions after
root plus independent complete review. Let every planned chunk reach terminal
state before repair; require complete coverage and no skipped/cancelled/pending
assertions. Authenticate actual source/controller/run/API/artifact identities.
Record successful/failed results at their actual source; do not transfer the
prior Draft 178 PASS at run 42460068064 onto these changed owners.

## Source identity and scope

Static independent replay retains the generator algorithms/scope and finds
provider 1487 sources at fa64944fa991a89f2d3c682b4f2c8c33a9040e1b41d0efd4531f64421aa8c096,
agent 472 at 210567d30486763dce401c69b24ba2d88081b5e86596afdd191c1bbb2875b8dd.
The only provider membership addition is packs/attendance/own-profile-read.ts;
reconstructing the parent graph without that member yields the exact previous
1486-source provider digest. Only generated digest literals are changed. The
inherited real admitAiManifests case updates its exact provider count 1486→1487;
its clean frozen Git/source/controller checks, both actual original --check
scripts, 180-second case and 160-second existing child envelope are unchanged.

All 28 human disclosure approval provenance, both pending contracts, capability
inventory and generator/scope bytes are unchanged. A regenerated source identity
carries no human approval, provider/evaluation or real HR-data authority. No
provider or real-data call is part of this task.

The current explicit source map rebinds every predecessor Draft record member,
all changed/new owners, inverses, actual affected checks and source-identity
owners. Historical maps are retained unchanged. This is a complete current map
of the declared review/check scope; it does not claim a complete transitive native
installed-runtime closure, lease admission or browser acceptance. Source/process,
installed grants, full runtime closure and max-one canonical borrowed connection
remain separate future work before any v3 handle can be minted.

Local checks were Git, byte hashes, complete source inverses and AST syntax only.
No model, application, test, database, compiler Program or build was executed.
Normal History-free RR/RO ESS correctness, explicit presentation workspace,
facts composition, lease/cancellation, all-module browser preflight and worker
capacity/zero Busy qualification remain OPEN. This leaf extraction makes no
speed, zero Busy, lock contention, crash or release claim.
