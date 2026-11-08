# V3 canonical Draft and ESS transaction adapters

Status: design only; base `c0fecc44d75dd60c6a2e4fd08704f20ba91d9dfd`.
No adapter, native handle, connection lease, fixture or browser execution is
implemented here. The v3 contracts stay unadmitted. Original v2, its 500-person
protocol, all application readers, commands, SQL and CI remain unchanged.

## Decision and scope

Extract canonical query ownership rather than recreating a screen's SQL in the
browser harness. First qualify the small Draft query. Then qualify an explicit
ESS presentation composition, initially Read Committed / Read Only with the
existing payroll History and profile/Access barriers retained. This is a probe
composition, not a change to the live page or a claim of lock-free ESS. A later
barrier-free Repeatable Read ESS owner requires separate correctness proof and
review. It must not be smuggled into a connection-passing refactor.

The connection requirement is at most one *simultaneously borrowed canonical app
connection* for this admitted probe family. It is not poolMax=1, a permanent
reserved backend, a second URL or a new postgres pool. Different probe
transactions may legitimately use different backends. Within one composed probe,
all statements must use the same real backend start/PID and root transaction.

## Verified caller and admission owners

`app/admin/personnel/new/page.tsx` calls `requireAdmin`, then `scopedSession`,
then `getEmployeeDraft(session, sp.draft)`. The draft decides Continue versus
Create; a missing/invisible ID may render Create rather than404. Catalogues and
numbering rules are separate page owners. A draft query alone cannot prove the
whole wizard usable, permitted to activate, or entitled to a numbering mode.

`getEmployeeDraft` in core/employee-draft.ts opens canonical withTenant, selects
exactly id/data/currentStep/companyId/reservedEmployeeCode by id/limit1, and runs
the private `asData` normalizer. It appends no event and takes no explicit lock.
Native RLS combines the tenant/company/author policy from0510 with restrictive
`app.access_workforce_draft(...,'read')` from0579. The reader itself is not an
admin-only gate. Preserve the route gate and the distinction between an author,
a scoped administrator and a foreign tenant; do not copy these predicates into
the planner or add a role string as authority.

`app/me/page.tsx` obtains the session, reads presentation policy and
myOwnEmploymentSubjects(profileEdit:true), selects an actual own employment or
renders the existing chooser/not-linked outcome, obtains myProfileRecord, and
runs workspace and facts concurrently. The page then performs additional
payslip/tax/request/document/loan reads. Those later panels and on-demand movement
comparison are outside this first Tx adapter; full ESS browser acceptance still
needs their canonical oracles and all visible menus. A facts DTO is not page
acceptance or permission to edit.

withTenant in db/client.ts owns the existing admission queue and actual Drizzle
transaction, native tenant/user/roles/grants/agent GUC setup, audit-chain bootstrap
and arming decision, suspension read-only enforcement and release. Its default is
RC/RW; explicit readOnlySnapshot starts RR/RO at BEGIN. It checks the existing
read signal before/after admission and before the callback. It does not join a
nested withTenant. Do not reproduce that setup in a harness transaction or assert
that supplied SessionContext JSON establishes current login authority.

`createDb` checks the exact-URL client cache before applying options. Calling it
with the original URL and max1 may simply return an existing larger pool;
changing the URL to bypass the cache is a second pool. Runtime importing this
module also initializes its configured singleton. Neither is a lease solution.

## Actual ESS dependency map and extraction boundary

| Result owner in readOwnProfileFacts | Current carrier/effects | Proposed canonical seam |
| --- | --- | --- |
| myOwnEmploymentSubjects | separate withTenant; native own employment predicate, dated company proof, hiredOn/id order | reuse myOwnEmploymentSubjectsTx, preserving all subjects and exact selection |
| policy | supplied policy or separate readProfilePresentationPolicy; fresh entitlements/visible IDs | compose one actual native fresh presentation policy; no caller policy object capability |
| employeeDetail | withProjectionTx; existingTx without workforce purpose invokes current-principal RC guard | reuse own course with exact Tx; never substitute workforce view for own rights |
| assignmentHistory | separate withTenant; unsuperseded ordered validFrom desc/id desc | extract its exact select to a private Tx query; legacy wrapper unchanged |
| compensationHistoryDetailed | withPayrollHistoryTenant, shared payroll History lock, unchanged decimal/string projection | private exact select; retain canonical History admission in composed purpose |
| ownReportingManagers | separate withTenant around existing Tx owner | reuse ownReportingManagersTx, administrative unique-manager rule unchanged |
| ownMovementHistory | separate withTenant; explicit own-person/tenant/nonvoided gate; detailed projection and closed-period facts | reuse ownMovementHistoryTx; preserve all nested same-Tx query owners |
| profile options | listAllProfileOptions separate withTenant; activeOnly, category/value ordering, all category buckets | private exact Tx query and mapping, no new catalogue policy |
| photo existence | separate RC/RO transaction; current-principal + native profile presentation policy for nonadmin | reuse hasPersonPhotoTx on admitted RC/RO purpose; no blob fetch or snapshot shortcut |
| recurring pay items | packs/payroll/service export of listEmploymentPayComponents; ordinary withTenant; exact joins/order | private Tx query exposed through service facade, not a kernel-to-pack implementation bypass |
| CP38 | service export of listCp38; shared payroll History; includes closed/superseded rows before canonical filter | private Tx query; retained History, month/status logic unchanged |
| shift arrangement history | service export; ordinary withTenant; ascending previous-shift derivation then reverse | private Tx query plus same transformation/order |
| leave balances/breakdowns/scheme | separate withTenant but already explicit Tx owners through packs/leave/service; real ledger/template/date rules | reuse actual Tx owners and ownBenefitSchemeViewTx; no financial formula fork |
| leave requests | existingTx supported, current principal guard; canonical status/partial/cancellation mapping | reuse existing seam, same locale default and ordered results |
| attendance summary | an additional later withTenant; scheduleGroupLookupTx plus attendanceRule/defaultShift reads | exact private Tx query; keep inclusive shift end and no-history legacy fallback |

The existing facts function first reads subjects, possibly reads policy, then
fans out twelve results and finally opens another attendance transaction. Several
owners have no borrowed Tx course. Passing a Tx to the outer function or holding
one connection while calling these wrappers would still fan out or deadlock a
max1 lease. Promise.all on queries *within the same Tx* does not create extra
connections, but it must not contain a hidden singleton wrapper; sequence the
top-level owner calls initially to make custody and cancellation observable.

The workspace has a more dangerous apparent seam:
`readOwnProfileWorkspace(..., existingTx)` means a *command carrier*. In its
current implementation that presence selects freshProfileEditPolicyTx (exclusive
Access/profile policy) when no policy is supplied, and passes true to subject and
master readers. They use FOR UPDATE for employment/person/dependents,
qualifications/emergency and country statutory edit snapshots. Even supplying a
presentation policy does not turn off those row locks. Do not reuse this course
for a read-only native probe.

## Proposed source interfaces, not implemented APIs

1. In core/employee-draft.ts factor the existing select/asData into a private
   `readEmployeeDraftRowTx(tx,id)`; the public legacy getEmployeeDraft remains the
   same withTenant wrapper. An explicit `getEmployeeDraftPresentationTx(tx,ctx,id)`
   course requires a real admitted RR/RO principal/read carrier, using the existing
   presentation principal owner, and delegates to that same query. This is an
   explicit admission-snapshot course, not a change to legacy RC freshness;
   current revocation must refuse the next fresh probe. Current native RLS still
   adjudicates the actual draft. Do not make
   `asData` a parallel harness codec. No changes to create/save/discard/activate.
2. In each canonical leaf owner above factor only its exact query/transformation
   into a Tx helper, retaining its legacy wrapper, locking wrapper and exports.
   Keep payroll/attendance/leave imports through pack service boundaries. Static
   whole-file inverse controls and actual legacy native checks must show that the
   refactor did not drop a join, order, default, mask or History barrier.
3. In core/profile-edit.ts add an explicit presentation-only Tx owner. Share the
   existing projection and register/master queries internally; choose the existing
   nonlocking presentation course explicitly, not by truthiness of existingTx.
   Legacy command paths keep true/locking flags and exact update baselines. Reuse
   native policy and country pack getEditSnapshot/get with forUpdate:false;
   preserve the 501-row read/500-row refusal and xmin-based public CAS metadata.
4. In core/profile-view.ts add an explicit `readOwnProfileFactsPresentationTx`;
   its actual native admission proves RC/RO, exact current tenant/user/person and
   current grants. It obtains its own canonical policy/subject inside this Tx,
   rather than trusting supplied policy from a previous snapshot. Factor the
   final projection once so both legacy and new courses use the same field
   metadata/masking, amounts, ordering, conditions and null/unknown semantics.
   The legacy reader and its supplied-policy behavior remain unchanged.
5. A fixed native v3 resolver, not an arbitrary callback/SQL broker, later calls
   these named owners through a root-reviewed canonical connection lease. Only
   that admitted source/process/query/lifetime boundary can mint a private handle.
   The adapters return DTOs, never a portable verified flag or permission grant.

The minimal full ESS composition begins canonical withTenant with the original
RC isolation, issues SET TRANSACTION READ ONLY before business selects, joins
shared payroll History before any Access/profile barrier, then proves current
principal and reads fresh presentation policy. Native2135 explicitly requires
RC/RO and joins shared Access then profile policy. All owned leaf queries then
share this carrier; no FOR UPDATE and no commands are allowed. Existing command
and payroll calculation carriers, including their History correctness guarantees,
are unchanged. The History join is needed even though pay components themselves
use ordinary withTenant, because compensation and CP38 use it today.

Keeping these locks longer than the old separate transactions is an observable
composition change, not byte-equivalent concurrency. It needs native lock-order
and cancellation proof before adoption. Initial RC/RO also gives statement-level
visibility, not a whole-function snapshot; a changed record between statements
is not to be falsely labelled RR consistent. A future RR/RO purpose must review
native read guards, payroll-history stability, masks and every country owner
separately; simply choosing readOnlySnapshot would refuse current2135 and change
the existing History contract.

## DTO and effective-date invariants

Capture today via todayInKualaLumpur exactly as the current owner does; do not add
a public asOf override. The facts reader uses one `today` for current assignment,
salary, leave, CP38 month status and attendance. Current assignment/salary end
boundaries are half-open (>today), but shift periods use >=today. Subject company
proof and workspace child/service dates also have their existing HR-date reads;
do not silently merge their timing across midnight. Native comparison must pin a
controlled date away from midnight or explicitly model the transition.

Preserve unique-only assignment/salary/admin-superior selection, transferred
company proof Unknown, legacy shift fallback only with no shift history, masking,
visible-only empty-record removal, all choices/category order, exact movement IDs
and before/after ownership, superseded CP38 filtering and month status, money as
the canonical string/null/currency values, leave essView conditional breakdown
keys, service calculation owners and independent entitlement module flags.
Workspace retains all visible values, editability, approval rules, CAS/baselines,
register IDs/primary ordering, legacy address and statutory unsupported states.
No money is recomputed by a fixture or browser adapter.

## Required whole-statement native qualification

Use the existing admitted controlled DB fixture and actual nonowner app LOGIN;
owner is only fixture/setup/evidence custody. Source and fixed native process
admission must precede any query. Real session identity is resolved canonically,
then native principal_snapshot_current and exact tenant/user/person/roles/grants
are checked. A stale context, role string or cloned DTO must not mint a handle.
Root owns the finite cohort/realm/allocation and aggregate pool-budget admission.

Planned new selectors (not files implemented here):
`navigation-v3-draft-presentation-native.test.ts`,
`navigation-v3-own-profile-presentation-native.test.ts`, and
`navigation-v3-canonical-tx-ownership.test.ts`. Case counts and exact job profiles
are frozen only after implementation review; no predeclared PASS count.

Required actual controls:

- Draft: create through current real numbering/reservation writer, record native
  returned IDs and independent fictional name/mail/code/company; compare full
  canonical old/new DTOs and known inputs. Test author, group/scoped administrator,
  same-tenant wrong company, foreign tenant, unknown ID and current revocation.
  Unknown/invisible remains native null with the page's real Create outcome.
  Save/reopen, unsaved cancel/discard and final cleanup use canonical actions;
  assert reserved IDs/code/counter ownership and all original events/money intact.
- ESS: actual own record, multiple/terminated own subjects and chooser, no link,
  foreign same-tenant record and foreign tenant, archived/login blocked,
  revoked/relinked person and forged/stale grants. Nonempty independent dated
  assignment/salary/CP38/pay item/leave/register/shift data are required, not just
  an empty old/new DTO comparison. Canonical writers supply data; no raw fixture
  financial write or altered permission policy. Test enabled/disabled modules,
  visible/hidden/masked/readonly/editable fields and exact denied content.
- Pin every statement's real backend PID/start/root XID/current_user/GUCs and
  transaction mode using a source-bound actual query observer, including nested
  pack/leave/movement/statutory calls. Count peak simultaneous probe connections
  from native activity and admission observations, not an injected spy. Refuse
  accidental wrapper reentry; a hidden second connection must fail the test.
- In explicit native RC/RO prove INSERT/UPDATE/DELETE and FOR UPDATE refuse and
  that normal reads cause zero new DomainEvents, receipts, outbox/notifications,
  row revisions or money changes. Preserve all command and audit effects by
  proving legacy commands still acquire their original barriers and write/audit.
- Hold actual exclusive History, Access and profile policy writers independently:
  Draft has no new broad barrier; the initial ESS purpose must retain bounded
  native lock refusal behind the relevant writers. Exercise an inverse holder
  with History->Access and prove no Access->History wait/deadlock in the new
  carrier. This suite does not claim zero page Busy for ESS until the separately
  reviewed presentation redesign passes. Never rename/refashion refusal as usable.
- Flip policy/revoke while waiting: RC rechecks native current authority after
  locks, no old caller policy object or editable cache survives. Original
  RR/RO presentation guards retain their independent admission semantics; no
  command may use a presentation identity to authorize an effect.
- Compare entire native before/after business/history/event/ACL inventories with
  stable independent expected values, not a selected-field digest alone. All
  destructive fixture work remains job-owned with exact native cleanup identity.

## Lease, cancellation and ownership prerequisites

Root must supply one serial admission gate in the existing workload family and
budget, then an original withTenant callback using the same existing pool. It may
not monkey-patch db.client, swap environment URLs or mutate global harness owner.
This design proposes named purpose entrypoints, not a generic public acquire-Tx
capability. Original application pool construction/defaults stay unchanged.

withTenant's existing signal checkpoints do not themselves cancel every in-flight
query. A native lease needs an owned pending-work promise registered before any
microtask/admission; checks before each new normal SQL; native 20s statement and
300ms lock limits and actual cancellation/rollback/drain before release. Startup,
cleanup and signal restoration need their separately bounded owned lifetime and
poison latch. Timeout/ambiguous settlement may not free the lease or let the next
case reuse an uncertain backend. Do not add another cancel connection outside
the reviewed aggregate budget. A max1 connection cannot service its own pending
query cancellation through another query on that same socket; the actual driver/
canonical cancellation mechanism must be reviewed before claiming a safe lease.

Pure deferred models must cover queued abort before admission, abort during
connection creation, late resources, hidden nested acquisition, pending SQL,
primary+rollback/drain failures, no successor before actual cleanup and distinct
versus identical repeated errors. Those models do not substitute for real backend
disappearance/rollback and current principal tests.

## Gates and honest coverage

This document is not a runtime source closure or an allocation manifest. Its owner
index pins reviewed source bytes and identifies future edits; future executable
imports/dynamic packs/native helper bodies/current installed grants require a
separate complete source and native dependency closure. Root owns max1 lease,
pool/resource accounting, fixture principal/record/role/cohort allocation,
operator/invite realms, exact whole-plan registration and 90-second scenario
capacity. Keep v3 UNADMITTED until those are qualified.

All46 families,120 parameterized page owners, unsupported destinations, original
v2 obligations, real baseline plus 500-loaded cases and all2/4/8 comparisons stay
open. Source composition, DTO parity and a typed resolver are different from
rendered usable content, dirty/save interactions or release acceptance. No
production or staging operation is authorized by this design.
