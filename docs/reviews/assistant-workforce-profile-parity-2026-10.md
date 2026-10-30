# Positive Workforce profile maintenance parity

Isolated source package based on `460f70436002781704ae47e75730fb3a30ce29be`. Freshly fetched main and
alpha aligned at `2f81373e5e18fb2b734dba0ded94866446afc065`; this package's base was ahead237/behind0.
Source implementation and authored evidence are not executed verification, installation or acceptance.

## Native source-to-effect map

`app/admin/personnel/[employmentId]/workforce-record-actions.ts#saveWorkforceRecordAction` calls
`requireWorkforceAccess`, parses one finite section and opaque version, and reaches
`core/workforce-maintenance.ts#maintainWorkforceRecord`. For `kind='person'` it supports only `update`:

| Native section | Finite intent | Native owners retained |
| --- | --- | --- |
| Personal | Salutation, names, nationality, religion, race, date of birth, gender and marital status | `workforceMaintenanceFields('person','personal')`, Personnel descriptors and native scalar/catalog validators |
| Contact | Work/personal email, phones and permanent address | `workforceMaintenanceFields('person','contact')` and the same validators |
| Correspondence | Correspondence address and phones | `workforceMaintenanceFields('person','correspondence')` and the same validators |

The SQL owner is `app.access_workforce_maintain_record` in migration0579. It locks policy generation,
selected employment and the real shared Person, enforces `expectedVersion` against that Person's xmin,
normalizes only the finite command fields, writes one exact private intent and appends `person.updated`
with `via='workforce-maintenance'` and field NAMES only. Personal marital-status changes retain the
native clearing of its old approved marriage-leave source-request cause (migration0485); it does not refer to a profile-change proposal. When canonical personal before/after values change marital status, the review explains this provenance consequence in all six locales without exposing a request ID. Unchanged marital status and other sections show no such note. This package does not calculate pay, reproject benefits,
change access or introduce a separate HR fact owner. Register kinds are not executed by its preview.

The exported `saveWorkforceRecordAction` ALSO reaches qualification/emergency/dependent commands. Its
inventory row remains backlog; three supported Person sections do not establish parity for that whole
export. This package adds one distinct action with three section intents.

## Current authority and privacy

No `isAdmin` requirement is added. The native positive command-company boundary requires current view
and maintain authority, including positively granted non-HR users, and the native command-person boundary
refuses an explicit view OR maintain denial on ANY retained employment company. The finite command-field
list, scalar constraints and catalog rules are the Workforce per-field boundary. ESS visibility/edit
policies and payroll/report grants are separate owners and are not borrowed as new Workforce grants.

Purpose DTOs remain the only private data path. The native Workforce projection intentionally omits
internal Person identifiers and unrelated salary/statutory/bank data. Browser choices, human content,
review and receipt therefore use the already-known selected employment as `subjectId`; actual Person
ownership stays server-side in the encrypted ledger binding, source fingerprint, erasure targets and
native completion proof. No raw Person SELECT grant or provider request is added.

The same physical prepared ledger and compatibility engine retain the exact selected employment/company
and actual shared-person receipt subject. Fresh command-person ownership and policy locks precede
private source reads or body decryption. The reviewed digest binds selected ownership/labels, the retained
employment membership fingerprint and policy generation, exact Person version, human section/values,
canonical native before/after and current option catalog. A changed source, version, permission or catalog
requires a fresh review. Arbitrary text is data and cannot select a service, expand fields or waive a gate.

Intentional narrowing: the Assistant refuses the caller's own Person for EVERY role, including positively
granted maintainers and super administrators. The native self-service or Workforce screen remains the
handoff for own changes. This is explicitly tested against a native-authorized own command; it is not
claimed as complete own-profile parity. An unchanged native command is also refused as having no effect.

Registry actor metadata is `workforce_maintainer`, rather than mislabelling non-HR users `hr_admin`.
Cached role strings cannot prove that capability, so the pure actor mapper conservatively leaves this
class unoffered. There is no inline hint protocol for this action. Existing Assistant module-read admission
is not widened; positive maintainers can use the guarded review page directly, while general chat/module
read discoverability remains a separate limitation.

## Native preview, receipt and recovery

The existing public native command retains its default owned transaction. An optional supplied Tx lets
this package keep native writes, encrypted custody, event capture and receipt atomic. A person-only native
preview calls that SAME command inside a rollback savepoint after acquiring source/policy locks. It reads
only the selected section into the canonical review, then rolls back the Person row, exact intent and
event, including on failure. No Family synchronization or independent transaction executes in this lane.
Statement authority metadata and ordinary sequence allocation are not HR effects or outgoing work.

The preview event helper proves the existing native intent's top-level xid and complete after-state hash;
this supports savepoint subtransaction xmin without weakening completion. The final ledger verifier
separately requires the current outer-transaction Person row and event, selected employment, true Person,
current user, native `via` stamp and matching native intent. Prior events cannot prove a new effect.
Completion clears sealed bodies. Reopen recovers the original receipt; duplicate/uncertain delivery does
not repeat the native effect.

## Authored evidence, not yet executed

- Real-DB profile tests cover all three positive non-HR sections, no-effect preparation, exact once-only
  concurrent confirmation, replay/reopen, absence of raw-row/financial access, view+maintain prerequisites,
  retained-company view/maintain denials, version/catalog staleness, retained-membership changes with an unchanged Person version, allowed-to-allowed policy-generation changes while native maintenance remains accessible, private Person-ID minimization,
  selected-profile binding, explicit self narrowing, hidden/cross-section/invalid fields, injection-as-data,
  cross-login/tenant/grant refusal, old-event proof and supplied/native transaction behavior.
- The registry role matrix compares the same native command against offer/prepare/confirm for all11
  existing roles. Separate positive-grant fixtures prevent an all-denied non-HR matrix from passing vacuously.
- A direct preview fixture probes both native selected employment and Person row locks with competing owner NOWAIT transactions after savepoint rollback, expects SQLSTATE55P03 until the outer transaction ends, then expects both locks to succeed with no preview effects. This is authored evidence pending CI execution.
- Contract checks require each complete finite section, exact human text, opaque version, no hidden fields,
  serialized Unicode budgets, and no authority inferred from cached role strings.
- UI tests cover explicit confirmation, section/version reload, substituted subject refusal, expiry and
  same-ID uncertainty recovery. Six locales have CI-only desktop/mobile fixtures for Personal and
  Correspondence reviews, using real controls and fictional same-origin responses.

No local tests/compiler/build/DB/dev server, CI dispatch, credential access, staging business action, merge
or deployment is claimed. Parent owns frozen exact40-character-SHA GitHub Actions focused checks with
whole typecheck ON on standard hosted runners. The global release hold remains. SQL0717/idx698/
when1793330000046 is an unapplied PROVISIONAL source claim, with no installation priority; integration
freeze must reconcile the actual ordered ledger. Prior SQL bytes and all predecessor action kinds remain.

Independent source review after the primary-session lock/transport repair found no material defect in
the positive non-HR inherited custody chain, native scope, top-level proof or closed transport wiring.
This is source review only. Actual-parser transport fixtures cover six operations, streamed reviews
above32KiB, forged fields/subjects/action IDs and oversized cancellation; all await hosted Actions.
