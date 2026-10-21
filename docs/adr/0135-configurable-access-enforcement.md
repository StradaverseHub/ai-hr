# ADR-0135 — Configurable access has one effective-permission interpretation

Status: implementation in progress; source draft only; no migration execution or release yet.

The approved Security plan is not an editable copy of Function Access. The existing grid is a reference over route guards; record authority also lives in SQL, service owners, dated organisation relationships and specialised payroll/onboarding permissions. A role-to-group wrapper alone cannot satisfy individual-deny precedence over the actual operations.

The canonical group/membership/individual-override owner will produce bounded, revisioned effective permission snapshots. Positive grants combine and an explicit matching individual denial wins. A group grant is intersected with each membership scope: membership in a tenant-wide default group never converts a company-scoped member into a tenant-wide principal. Explanations retain both scope sources. Company coverage is evidence from the existing database company resolver, not a new JavaScript hierarchy. Tenant-scoped powers require tenant authority. Unsupported or incompletely bound capabilities refuse rather than appear as working controls.

A protected customer System Administrator and installation operator remain different authorities. The existing operator grant cannot be minted by this feature. Default conversion must demonstrate equivalence for real users and organisation-derived managers; a role name alone does not capture existing authority.

Every exposed capability needs a reviewed binding inventory for page, action, record query, export, background work and applicable SQL. Existing payroll/onboarding owners remain authoritative, with explicit adapters rather than copied permission tables. A signed-in cookie cannot freeze authority: the trusted owner must refresh principal, revision, current login and effective access inside the protected transaction. A stale or forged SessionContext cannot manufacture a grant.

All mutations require fresh actor ceiling and exact expected revision under one tenant access lock; preview and commit use the same resolver. Protect the final active system administrator against concurrent membership removal, denial and account deactivation. The surviving recovery administrator must retain both protected recovery identity and configuration authority; an administrator label with a denied editor is not a recovery path. Audit bounded identities and permission changes without HR payloads. A preview must also explain access remaining through another group after one grant is removed.

Source inventory and pure access-algebra regression cases are preparation, not executed acceptance. No feature may ship until its complete enforcement bindings, equivalence, revocation, concurrency, audit/recovery, actual role journeys and restricted-owner upgrade are demonstrated. Migration0579 is centrally reserved after Board1's0576/0577 and ESS0578; 0579 SQL is drafted but deliberately not journalled or applied yet.

The source command reducer accepts only bounded typed edits, never a client snapshot or protected-group flag. Preview fingerprints bind the actor, full current snapshot, supported consumer bindings, normalized command and a fresh dated scope fingerprint. A changed membership, active account, scope, catalogue or revision invalidates the preview. Grant ceilings apply to deny removal too, and an ancestor grant cannot cross the actor's explicit denial on a descendant subtree. These source contracts now have a draft restricted-runtime SQL storage adapter; the application and complete domain authorization bindings remain unfinished.

The source transaction coordinator uses one tenant access lock before loading fresh authority. Preview and save run the same transition; save verifies the fresh preview binding, advances the revision through compare-and-swap, and appends a bounded domain event in the same transaction. Its server-owned storage adapter now calls a private-table/definer-function storage owner. The SQL write seam independently validates and audits commands, including direct runtime SQL calls; the TypeScript coordinator does not append a duplicate event. The draft migration now integrates that lock into legacy role/account, invitation, company-scope and employment deactivation writers; actual concurrent last-administrator protection still needs execution under the restricted runtime. Mocked orchestration tests cannot prove database locking, rollback or RLS and do not replace those acceptance journeys.

The draft normalized store retains retired grants, memberships and overrides. Default group membership is a live view over role_assignment; the editor cannot fake removing a role-derived membership. Real role revocation therefore changes the next read without a synchronization copy. The new SQL entry points read the actual active login and company owner, intersect group and membership scopes, and preserve explicit-deny precedence. There is no runtime table-write or arbitrary-user evaluator grant. Legacy role, invitation, archive and employment writers join the tenant lock, advance the shared revision and receive deferred current-administrator protection. An explicit configuration denial also blocks older role writes and acceptance of an invitation from a denied inviter.

Defaults are drafted as migration-time installation for existing tenants with an actual usable durable customer administrator, and as a deferred first-administrator role hook for new tenants. A private owner installs groups from real role facts without rewriting them. A tenant with no qualifying real administrator remains uninitialized; the feature never invents a replacement login, promotes an installation operator or claims a recovery path that does not exist. The migration preflight and both populated restricted-owner rehearsals must enumerate and reconcile those tenant outcomes. A runtime caller cannot invoke the private tenant/user installer or arbitrary-user permission evaluator.

The six-locale editor draft supports group/name/grant/membership/individual-override previews and exact confirmation, preserves other-company grant rows, explains permission sources, and discards stale async or actor/scope/revision drafts. Its draft /admin/users/access page, account-menu discovery, preview/save actions and bounded change history now call the fresh SQL owner; they have not run yet. A locked read minimizes user/company labels and the latest 100 permission events, without lifecycle eligibility, whole personnel rows, owner functions or raw event payloads entering client props. The reference grid shows this screen as conditional on effective configuration permission for every role rather than claiming a role-only grant. General runtime audit insertion cannot manufacture access-history events; only the canonical definer owner can append them. Workforce view/maintain and profile-review capabilities stay unsupported in the catalogue until their complete read/write/export/SQL bindings are implemented. Do not mark them ready merely to make a control selectable.

The draft recovery constraint also considers known future employment endings. The existing login predicate is factored into a private dated owner, with its public current-date behavior retained; the recovery check looks beyond all known finite employment endings. It requires a protected administrator whose login will not disappear solely as those already-recorded dates pass. The internal state provides only eligible recovery IDs, not lifecycle dates, to the server transition; these IDs do not enter editor props. Prepared tests cover a currently active but future-ending administrator, denied private dated evaluation and refusal to remove the remaining durable recovery administrator. Current login equivalence and these new cases still require execution.

Remaining concrete risks include complete transaction-time principal freshness outside the new configuration owner, all specialized payroll/onboarding and self-approval boundaries, real app action/page/export wiring, and invitation/legacy concurrency acceptance. These are required work, not accepted deferrals. No compiler, test, fixture, app, migration or build has run for this draft while Board1 holds the resources.

Protected System Administrator enrollment stays with the existing real role owner. Neither a custom group grant nor an individual allow may manufacture that protected marker, and the new membership editor refuses manual changes to the protected group. This prevents a new configuration-only login from being misrepresented as the customer's full recovery administrator.

The legacy role/invitation/archive trigger now drafts a fresh actual-role floor in addition to the existing RLS matrix and new explicit configuration denial. A stale session cannot restore a deleted role; moving an existing role grant must authorize both its old and new scope. Pre-auth invitation acceptance rechecks a non-null inviter's actual live scope and denial, rather than treating the original issue as permanent authority. Runtime invitation creation must identify the real current actor as creator; a null creator remains reserved to the existing explicit owner-issued initial-activation path. The existing invitation lifecycle, person binding, customer-role set and no-operator constraints remain authoritative. Prepared positive acceptance and revoked/forged/denied regression cases have not executed yet; owner-issued initial activation and manual enrollment also require their existing full consumer regressions before release.

Company-scoped access history is a retained company reference, including retired decisions. The canonical company-referrer registry now names all three private company FKs and uses scoped boolean owner functions, so the existing delete-status and delete guard can agree without granting SELECT on private access records.

Workforce bindings must not widen app.visible_employment_ids or app.visible_person_ids indiscriminately: 0515's shared sets feed payroll, statutory, leave and other sensitive consumers. Directory grants need explicit Workforce consumers and their own scope/policy integration; specialized financial and onboarding owners remain separate. This is a source-derived integration risk, not a reproduced executed failure.

A draft profile-review adapter now narrows the existing request RLS and named-principal eligibility using actual live HR scope, separate from the configurable grant. Own active request history remains available, while a review grant cannot manufacture HR status, cross a named route or allow self-approval. Decisions and reasoned reassignment acquire the shared access lock before loading policy or proposal data. An individual review denial also removes maintenance-flag proposal reads; recovery uses another eligible reviewer or an explicit permission correction, rather than allowing a caller-set flag to defeat the denial. Existing privacy/retention definer paths remain separate. The catalogue keeps profile.review unsupported during source construction; an isolated DB fixture activates the adapter for prepared queue/raw-row/decision/own-history/self-approval cases only. Photo byte routes, named reassignment, closed-field/withdrawal/privacy, independent SQL policy oracle and concurrency consumers still require integration and execution before activation. This adapter has not run yet.


The source integration now includes ESS0578 and its photo request/route consumer. Review denial
must remove pending byte reads as well as queue/decision access; reasoned reassignment retains
only the new named reviewer's access. All profile policy operations now take the access lock
before their policy lock, matching decisions and permission changes.

A source integration finding exposed a separate consequence boundary: restrictive review denial
could prevent a configuration administrator from withdrawing now-closed fields. The draft
write-only SQL consequence reuses the fresh legacy group-administration floor and explicit
configuration-denial owner. It can only reject pending matching fields, purge decided photo
bytes through the existing retention trigger, and append bounded field-name audit metadata in
the same transaction. It returns only the affected count; it cannot grant review, reveal a
proposal, apply a master value or change a route. The prior public withdrawal operation already
permits an actual group administrator to refuse matching pending fields; that scope is retained.
Prepared service/route/SQL cases cover denial in an existing session, reassignment, closure by
a denied reviewer who retains configuration authority, forged-role refusal, permission/decision
serialization and complete rollback if the consequence audit fails. These cases have not run.


The next draft Workforce adapter uses Board1's existing `app.principal_snapshot_current()` proof
from reserved0576, followed by its own current HR scope and capability check. The proof is not a
capability grant and does not attest caller-supplied person identity. The SQL source dependency is
known, but remains unconsumed at runtime until Board1 releases its verified migration.

Personnel-purpose list, status totals, switcher, detail and listing export now opt into one
transaction-time predicate without modifying the shared visibility sets used by financial or
team-directory consumers. Empty selected company scope remains empty. Full profile saves and
Employee ID edits acquire the access lock and check current company/person authority in their
write transaction. A shared-person mutation retains the existing any-administered-employment owner; changing
a shared fact cannot cross an explicit denial on another retained employment's company.
The existing partial-profile approval/self-service owner is separate and remains under its own
binding requirements; an audit `via` string is never an authorization bypass.

Drafts have their own restrictive read/create/update/delete policies, including fresh current
principal and actual own-person binding. The pre-existing0510 author's read/discard relationship
source is preserved independently of role membership; an applicable explicit denial takes
precedence. Unassigned drafts require the existing global HR floor or that same author source,
with no invented company. Default source equivalence and role-removal/individual-denial behavior
need the existing draft-company-scope suite and the new adversarial cases, not just new test counts.

These controls narrow existing HR record authority. They do not manufacture a legacy HR role,
payroll authority, approval eligibility or operator status from a configurable grant. Workforce
catalogue entries remain unsupported until the complete action/import/export/master/related-file
consumer matrix and independent SQL bindings are complete. Remaining writes include lifecycle,
organisation/reporting, shared-person partial owner integration and related registers/files.
Prepared tests cover default projection equivalence, same-session denial across rows/counts/detail,
empty scope, no-write/no-event refusals, stale real roles, forged scopes, real foreign records and
author-retention versus explicit denial. None has executed while peer resources are held.


Workforce-purpose command composition is now a separate facade over the existing hire,
employment-info, grade/assignment, blacklist, transfer and structural-reporting writers. It holds
one access lock and reuses the same enclosing transaction. Full imports and draft activation
consume that facade; section imports gate the subject and shared person before locking or
carrying forward values. User-facing Movement create/edit/rollback and hire-correction entry
points now check the same permission. Entity change checks both source and destination scopes.
Delegation remains its separate relationship owner. Resignation approval and approved Rewards
posting retain their original termination/grade owners and independent decision authorization;
a generic Workforce grant cannot replace those controls. All changes remain source-only.


The direct HR master-photo controls and HR test-record classification now consume the maintenance
adapter too. Pending photo approval calls a private in-transaction master writer only after the
existing named-route/profile-review decision owner; that is a different authority from direct
Workforce maintenance. A prepared consumer regression explicitly denies direct HR photo editing
and still completes an eligible separately-authorized pending photo approval. Orphan person
records retain the existing global HR course through the unassigned-scope owner.

Personnel Profile and Employment forms have draft read-only states with all six locale captions;
new Movement and direct-photo controls follow actual maintenance permission. Independent delegation,
financial and privacy owners retain their own checks. The classification metadata reader uses a
single default-isolation read with its fresh Workforce predicate, avoiding a stale repeatable-read
snapshot for a permission decision. Actual rendering, keyboard/save behavior and source/SQL consumer
refusals remain unexecuted requirements; these UI changes are not acceptance evidence.

The shared-value writer review found a source compatibility gap in that privacy separation: a
Workforce maintenance denial would also reject the existing privacy owner's nullable cleartext
updates and emergency-contact deletion. The draft now gives that owner an independent finite
transaction witness. Actual current HR visibility, the canonical erasure scope and the existing
retention rule determine exact before/after hashes; callers cannot supply values, a clock, an owner
flag or a claimed completion. The private proof is bound to the actual user, tenant, transaction,
subject and canonical `pii.erased` audit metadata. Deferred checks require every captured effect and
the real audit to finish together. Arbitrary values, held identity values, partial effects, missing
or changed audit metadata and later-transaction replay cannot inherit that authority.

The service and frozen SQL snapshot share `lib/pdpa-erasure-policy.json`, preserving the existing
nullable field set and seven-year duration rather than creating another erasure policy. Both use
one database admission timestamp; calendar-year rollover follows the existing UTC date semantics.
The proof table and field-policy function remain private. This is source preparation only:
`workforce-privacy-owner.test.ts`, the cross-owner policy contract and the existing full privacy
and vault consumers must execute after the released-baseline reconciliation. No capability is
activated and no migration has been applied by this source checkpoint.

The bounded Family editor now applies the existing shared relationship-field predicate to its
interactive form and read-only view. A small client island holds only relationship state; controls,
labels and choices are server-rendered slots. Inapplicable controls are hidden and disabled, with
finite blank placeholders preserving the action's exact field contract. The canonical normalizer
still owns relationship changes and stale-field clearing. No form state is an authorization grant.
Forms also reset uncontrolled values together with their actual row/Person revision, preventing a
typed old value from inheriting a freshly rendered compare-and-swap token. A changed register set
resets its completed Add form. Six-locale interaction, field-posting and revision-refresh regressions
are drafted but unexecuted; actual permitted/denied/save-reopen journeys remain required.


The Workforce listing, export, status counts and switcher now draft an explicit definer projection
instead of borrowing raw person/employment SELECT. The projection names its fields and tenant-keyed
joins; no arbitrary table/field selector, private classification, person/card identifier, salary,
statutory/bank record or file bytes enter the listing contract. A manager name is projected only
inside the same permitted-company set. The application reuses its existing filter and SQL status
owners over that projection, so page rows, totals and buckets retain one interpretation; the
independent payroll/attendance picker is unchanged. Prepared tests compare paging/filter/status
results with the legacy owner and inspect the exact public projection and smaller picker shape.
None has executed. This does not yet activate grants for new non-HR readers: page/detail purpose
owners, complete maintenance and related-register/SQL bindings remain required source work.


Direct Family, Qualification and Emergency Contact actions now compose a distinct Workforce register
facade under the same access lock and transaction. Existing register IDs resolve their stored subject
before checking authority; posted redirect/employee IDs do not retarget a record. Register section
preview/export/commit use the same current read/maintenance gates and acquire the access lock before
record locks. Existing canonical own-profile and approved-proposal calls retain their separate owners,
without a request flag that could bypass a direct Workforce check. Archive services now accept the
existing in-transaction composition pattern; Family child-relief propagation uses that transaction too.

General employee document metadata/byte reads and writes join the access lock. Add/edit/replace/delete
check the actual document's employment; additive restrictive SQL policies independently guard raw CRUD.
The read predicate replaces the existing HR arm with Workforce view while preserving actual own-person,
current administrative-tree and HOD authority through existing relationship helpers. It grants no new
raw table visibility. The download route binds the employment URL before fetching bytes or appending a
download event. Pending profile-proposal files remain a separate store and approval owner.

Read-only related-register screens retain View controls; mutation dialogs and destructive forms are
omitted. Documents retain search/filter/view/download. The client receives an explicit maintenance
boolean; the server and RLS still authorize independently. Prepared service/raw-SQL/route and rendered
DOM regressions cover revoked direct maintenance, no partial rows/events, preserved self reads, wrong
URL audit refusal and a separately authorized Highest-qualification approval after Workforce denial.
All remain unrun. Complete related-register raw SQL/approval composition, roleless grant detail/write
projections and the remaining downstream matrix are still required before catalogue activation.


A positive view grant now enters a separate bounded projection-company owner, which delegates the
permission decision to the same canonical effective-access resolver. The legacy raw-row/write helper
is not widened. A prepared real non-HR principal case projects a colleague's declared list fields and
counts, while populated compensation and raw colleague person/employment rows remain inaccessible;
revocation removes the projection in the same context and retains the user's independent own record.
This is a source seam, not a claim of a completed roleless screen: capability page/detail/read-only
consumer integration and all execution evidence remain outstanding. The catalogue is still disabled.


Movement catalogue/template/preview/commit now take the access lock before Movement reference and
catalogue locks, with the existing request/statement bounds established first. The selected company
needs both read and maintenance; denied subjects never reach name/fingerprint projection. Destination
choices and manager labels are similarly narrowed. This fixes a source-discovered lock-order inversion
introduced by composing the new maintenance writer after the old Movement admission locks; no executed
deadlock or passing concurrency claim is made.

Employee import resolves only currently viewable/writable companies, narrows superior identifiers by
current Workforce view, rechecks all valid row-company owners at the public validation response, and
acquires the access lock before its enclosing write transaction. The direct compliance-field facade
checks both employment and the shared person in the same transaction. Its admin forms, imports and
draft activation use that facade; independently authorized ESS scalar/approval owners remain canonical.
Prepared regressions reuse a genuinely valid Movement preview, revoke permission, then require its
subsequent preview/download/commit to refuse without names/fingerprints or state/events. Full Employee
validation/commit and direct compliance refusal are covered too. All are unexecuted source work.


A source compatibility review found that existing due-Movement execution uses a null-user system
context. The new direct owner checks cannot equate that caller-supplied context with authenticated HR.
The nightly script therefore supplies its already-existing actual owner connection only to the fixed
ledger-driven Movement sweep. Application callers retain the runtime connection and fresh subject
maintenance checks. The write, pre-write grade read and summary event share the supplied transaction
owner. Existing separately-owned leave reprojection remains unchanged after the committed application.

The private system-company proof checks both session_user and the effective SET ROLE against the real
app_user table owner, plus null-user identity and exact tenant/company scope. Checking current_user or
acting_as_owner() inside a definer function would bless the function owner for every caller; this draft
explicitly does not do that. ai_hr_app has no EXECUTE on the private proof and cannot manufacture owner
credentials with GUC claims. Existing admitted dated intents retain their original durable-ledger
semantics; revoking a screen permission does not silently cancel a recorded future business event.
Cancellation/reversal remains the existing audited command. A user-driven replay checks that user's
current authority. Prepared real-runtime/owner cases require fake system refusal, legitimate due-only
application and repeated-run no-op. Restricted-owner and actual script lifecycle verification remain
required and unrun; this is not evidence that background compatibility has passed.


The next source read composition connects positive view grants to the listing, bounded record, export,
user-owned column preferences and account-menu discovery. Workforce derives its own current company
scope instead of widening the shared switcher for other modules. Read/import-create routes now have
separate, accurately described guard columns; the grid marks effective permission as conditional for
all roles. Six locale scope captions describe that boundary. Create/import controls still require the
actual existing HR maintenance floor and permitted company choices.

The bounded record declares 31 physical normal-profile fields from the canonical Personnel registry
and the existing employment list projection. No salary, bank/statutory rows, paymaster link, private
classification, arbitrary person/employment row or file bytes are returned. Non-HR view grants and HR
read grants beyond their legacy scope enter this separate server composition before any HR-detail
payload read. It renders personal/contact/correspondence and employment readouts using the existing
field labels, choices and status/date owners; it has no master-update form. Its picker remains a smaller
purpose DTO. Malformed/unreachable/revoked records refuse. Prepared six-language DOM and live-role DB
cases include exact projection shape, populated salary refusal, same-session revocation and no hidden
maintenance forms. All remain unrun; the actual app still requires representative role/RSC/viewport,
keyboard/save/navigation/error reviews before this surface can be called verified.

This is not yet full Workforce maintenance. A new positive maintenance grant still needs bounded
canonical write admission, shared-person partial/register SQL composition, every affected downstream
consumer and default/independent-owner equivalence. Missing profile-derived/photo/register read
contracts also require outcome reconciliation. The view/maintain/profile-review catalogue controls stay
unsupported during construction; their public page/source scaffolding is not proof of a complete or
shippable capability. No Board status has been advanced to Done or Deployed for this source work.


Board1's committed but unreleased5b8dbeb2f shares profile decision eligibility with its task reader using
a metadata-only request shape. Our ESS source also distinguishes photo from fields during routing.
Integration must retain that distinction without loading proposal values into task metadata. The draft
route subject accepts either the real writer row or an explicit stored request type; it exports a SQL
classifier twin beside the existing JavaScript owner. Prepared adversarial vectors distinguish numeric
version3 from string3, arrays, scalars and other versions. After verified peer handover, reconcile the
new actionable reader by selecting only that SQL-derived request type and retaining the shared writer
helper, fresh access/policy lock order, named routes, no-self and group-only checks. Do not overwrite the
peer's canonical reader or resurrect the old independent bell count. This compatibility is source-only
and unexecuted, and no Board1 feature has been merged into this branch yet.


Canonical hiring now acquires Workforce maintenance authority before Criteria/data locks, including
callers that do not use the page/import facade. Reusing a person also checks their shared record owner.
The facade delegates to this one admission owner instead of repeating a second hire interpretation.
An additional SQL INSERT guard refuses denied employment creation and a shared-person rehire; a
failed hire rolls back its person, number, assignment and events in the enclosing transaction.

Employee code and test-record classification updates now have bounded SQL guards. These facts have
only direct Workforce writers; a blanket employment UPDATE restriction would incorrectly block
independent approved grade, termination and scheduled work. The guard checks retained and destination
companies and leaves unchanged values alone. Explicit owner repair/restore uses a private credential
proof shared with the existing scheduled owner adapter: session_user AND the effective SET ROLE must
hold the actual storage-owner role. A definer's current_user or a null claimed login is not that proof.

Workforce maintenance admission also locks the actual access-configuration tuple after the tenant
advisory lock. Prepared stale REPEATABLE READ cases require serialization refusal after committed
revocation, rather than approval from an old snapshot. The logical permission revision/history is not
changed by that lock. Employment INSERT/identifier/classification and document/draft SQL statements
join this barrier before their target row locks. Document and draft row guards then recheck their
canonical predicates; retained document subject and draft authorship cannot be reassigned by runtime
SQL. New draft authorship must match the actual app_user's nullable person binding, not a supplied
SessionContext personId. Draft RLS and row guards share one operation predicate, retaining0510's
independent author read/discard and company admission rules. These locks do not add raw table grants.

Prepared regressions include actual SQL refusals, transactional hire rollback, no state/events after
denial, explicit owner repair, removal of denial, document/draft identity retention, independent grade
posting, and pinned old-snapshot command/document/draft writes. They have NOT executed. New non-HR
maintenance admission, shared-person partial/register SQL versus approved ESS composition, remaining
related read contracts and full consumer/outcome verification still block catalogue activation.


Positive non-HR maintenance now has a first fixed command in source: correct an Employee ID. A separate
command-company predicate requires fresh actual principal, effective Workforce view and maintenance,
and current company scope. It is not fed into shared employment/person visibility, HR-role checks,
financial owners or the legacy generic writer predicate. The SQL command accepts only employment ID,
canonical code and an optional old-code baseline; it locks current authority and the target, rechecks
scope, checks uniqueness, updates only employee_code and appends the existing code-change event in one
transaction. Existing service callers delegate to this owner and preserve their normalization/no-op
contract. It does not authorize test classification or any other field. The server form sends a baseline,
offers only that implemented edit, rereads the actual session and returns finite translated feedback.
Its props contain the existing bounded projection; no private HR detail is loaded for this user.

Hire, draft and correction now share one SQL employee-code claim owner returning only employment/draft
collision kind. A collision in another company cannot disappear because raw visibility excludes that
record. It returns no other record identity or payload. The public query checks actual current authority;
the fixed correction command supplies its own exclusion. Draft number reservation acquires access before
counter/data locks, matching canonical hiring and correction rather than adding a reversed lock order.

Register identity guards prevent runtime retargeting of Family, Qualification and Emergency Contact rows.
Canonical proposal edits retain their subject. Family/Qualification archive owners and direct SQL now
join the access barrier and recheck maintenance; ordinary proposal highest-qualification edits do not
archive. Emergency-contact archival is deliberately not generalized into that guard: the established
own primary-contact clear can archive its row independently. Privacy value erasure and deletion remain
with their existing owner. This is not a claim that every partial/register SQL mutation has been bound.

New endpoint, six-locale DOM and actual restricted-runtime tests are authored for non-HR command success,
no HR promotion/raw employment/salary grant, no-op, stale record, revoked view/maintenance, retained draft
code, audit rollback and SQL register identity/archive refusals. None has executed. Other non-HR normal
profile/register commands, shared partial-value SQL versus valid ESS decisions, relevant raw deletes and
related read contracts still require completion. All three capability controls remain unsupported;
0578/0579 remain unjournalled/unapplied until complete source, peer handover and required evidence.

### Profile/register physical value boundary — source checkpoint, not verification

The draft now covers the remaining ordinary Person/compliance values, retained legacy address
columns, and Family/Qualification/Emergency register value writes and removal. Direct maintenance
still uses its current real-principal/company/shared-Person owner; positive non-HR maintenance is
still limited to the separately implemented Employee ID command. The three catalogue controls
remain unsupported. This section does not declare a completed general maintenance editor.

An independently eligible ESS reviewer denied direct Workforce maintenance uses a different graph:
actual pending request → fixed request-ID SQL preparation → canonical validators/owners → actual
pending-to-approved transition → actual immutable decision audit → transaction completion. Preparation
accepts no actor, company, table, column or proposed patch from its caller. Database-private evidence
contains xid8, identities and digests, never proposal values. Only real transition/audit triggers mark
it complete; the runtime cannot read or write those private tables. Deferred row guards require the
same transaction/principal, the unchanged real approved proposal and route, current field/group policy,
exact submitted values and retained register subject. A pending request, preparation alone, a prior
transaction, a caller GUC, or an event without its matching transition grants nothing. Additional new
register rows cannot reuse a submitted client identity. Private evidence is pruned on later writes and
cascades with its tenant/request; it is not a second business record or an authorization cache.

The route witness checks the existing subjectContext byte contract and locks its exact subject,
Person and dated assignment projection before the first master mutation. It must not recompute the
before snapshot after applying an approved gender/nationality change. Current route revision, actual
named principal, no-self, group-only ceilings and review capability remain required. SQL/JavaScript
witness equivalence, including Unicode/escapes/dates and retained pre-upgrade requests, needs executed
coverage before release. Core remains the business-value/catalog/baseline validator; SQL provenance
is not a claim that PostgreSQL attested execution of JavaScript validation.

Finite side effects preserve the existing single Highest/Primary transfer, relationship-inapplicable
Family clears, legacy own primary-contact edits/clear, and the independently callable 0485 Marriage
Leave state transitions with their persisted cause/no-live-sibling reversal. No Personnel/financial
row visibility is widened and no caller receives a manufactured HR role. The marital cause pointer
cannot be manufactured by a runtime profile write. Applied 0485 is unchanged; the new guard recognizes
only those already-existing fixed effects. The existing Marriage Leave consumer suite is required.

All relevant core writers now join access/policy barriers before locking their subjects. A physical
per-tenant generation is pre-created for existing and new tenants, advances only on real access or
ESS policy writes, and is share-locked by writers. This covers REPEATABLE READ snapshots that cannot
yet see a first settings/access-configuration insertion. Reads/barriers do not advance logical access
revision or emit configuration history. Canonical decisions translate only known SQL permission/
serialization refusals into finite ESS errors; unexpected storage/audit faults keep their diagnostics.

Authored but UNRUN: binding-inventory parity; raw value/delete refusal and rollback; actual scalar
approval while maintenance is denied; pending/prepared-only/no-audit/extra-field/wrong-value refusal;
request fabrication/rewrite/reopen/replay refusal; real foreign request refusal; new-register one-time
binding; a pinned old snapshot after a first policy insertion; existing Highest transfer and photo
approval separation. Required next: integrate only Board 1's released principal/navigation baseline,
check/journal the reserved migration order, compile, execute focused runtime and compatibility tests,
repair actual failures, exercise real-app journeys, rehearse populated upgrades as restricted owner,
then obtain the authentic final security/full gate and official Linux release/arrival proof. No new
compiler, SQL, app, rehearsal, gate or deployment result exists for this checkpoint.

### Positive profile, Qualification and Emergency editors — source only

The next fixed maintenance command and server forms are drafted for the 31 normal Person/compliance
fields, nine Qualification fields and six Emergency Contact fields. A bounded editor projection returns
only those register values and opaque row revisions. Profile values and their revision are obtained in
one SQL statement; independent page-summary reads cannot pair old form values with a newer CAS token.
Qualification maintenance is employment-scoped. Shared Person/contact maintenance retains applicable
explicit view/maintenance denials on every retained employment of the same Person. No role is fabricated,
and raw Person/employment/register or financial visibility is not widened.

The SQL command accepts a closed kind/operation/field vocabulary, takes the existing access/policy barrier
before record locks, checks actual current authority and row version, normalizes only declared values,
checks current catalogs and fixed scalar/date constraints, and performs the existing single Highest or
Primary transfer. New catalog acceptance has one SQL owner shared with the existing profile validator;
Qualification/Emergency cross-field validation continues through their existing kernel validators.
Inactive stored relationships retain the Emergency Contact owner's existing tolerance. Each changed row
has a private transaction/actor/subject/before/after digest witness, linked to the command's real immutable
event. Runtime code cannot mint a witness, reuse it for a different value, or borrow raw row authority.
Audit failure must roll back the target and any transferred marker. No submitted value is copied into
the command's event payload. Archive is a separate explicit form with retained history.

The six-locale forms reuse Personnel descriptors, current catalogs and retained choices, bound revision
metadata, pending buttons, and finite durable saved/changed/denied/invalid feedback. Server actions choose
the field set from a finite section/kind and ignore posted actor/company/role/permission or unrelated
fields. These forms never contain private classifications, documents, bank/payroll/statutory values or
internal Person identity. Authored regressions cover the actual non-HR command, minimal audit/no-op/CAS,
Highest/Primary transfers, archives, legacy catalog tolerance, real foreign/revoked subjects, forged private
intents, raw-followup refusal, audit rollback, request binding and six-locale rendering. All are UNRUN.

At the preceding checkpoint, Family positive maintenance was still incomplete. Its existing owner synchronizes automatic child-relief
head count and grid through the jurisdiction's statutory writer, preserving every other tax fact and
open-payroll alert. That checkpoint did not admit Family: bypassing that
coupling or granting a non-HR caller raw tax access would be incorrect. The following checkpoint drafts that bounded composition
through the canonical owners; it is not yet verified for release. Employment structural/specialist commands and the
remaining domain/current-principal matrix also require reconciliation. All three capability controls
remain unsupported; 0578/0579 are unjournalled/unapplied. This is a source checkpoint, not acceptance or
release evidence. Board 1 still owns all three resource leases; no compiler/test/app/SQL/build ran here.

### Family command, derived consequence and remaining SQL bindings — source only

Family maintenance is now drafted for its 20 explicitly selected normal register fields, alongside the
existing normal profile, Qualification and Emergency editors. Workforce field selection is a closed
permission binding, independent from ESS visibility/edit policy: adding a self-service field cannot
silently admit it to the Workforce form, command or projection. Physical field meaning still comes from
the Personnel registry. Internal remarks, private classifications, documents and general financial rows
remain outside this consumer. The SQL command repeats the closed selection and rejects unknown columns.

The Family add/update normalizer was extracted from the existing owner and is shared by ordinary HR,
imports, approved ESS and the new purpose command. Built-in/custom/retained relationships, nullable
undecided claims, and clearing relationship-inapplicable fields retain the existing rules. The new form
does not coerce a never-decided claim into an explicit refusal. Add, update and soft archive use the same
row version, actual subject/scope and immutable audit boundary as the other normal registers.

Automatic Family relief now has one private Malaysia SQL write owner, reached by the existing kernel
`syncChildReliefFromFamily` route and atomically by the bounded Family command. It accepts no proposed
count, grid, tax patch or caller authorization flag. Current eligibility and positive-grid completeness
are one declarative decision graph consumed by the existing JavaScript derivations and installed SQL;
the SQL renderer lives on the country side, not in a browser import. No tax rates or monetary computation
were copied. The retained r355 rule still requires justification for consent past 18; explicit refusal,
unknown consent, student status, supported categories, birthdays and leap days remain separate cases.

The private owner locks the actual Person/statutory row, honors manual mode/no-row/no-op, derives only
the head count/grid from actual Family facts and updates just those two values plus the row timestamp.
Every other tax/registration/selection value is left unchanged rather than copied through a full tax
setter. Incomplete/empty grids retain null fallback. It preserves current open-payroll detection and
records an audited automatic consequence. Its current clock is one database instant with KL eligibility
date and the existing UTC payroll-period convention. Only real owner credentials can select a private
deterministic replay instant; runtime/public/Workforce calls cannot select their clock. Birthday tests
are adapted to that real owner seam without removing their before/on-birthday, KL-midnight, no-op or
unchanged-Family assertions. Unsupported/ambiguous jurisdiction refuses instead of inventing policy.

The ordinary kernel wrapper retains the legacy statutory read/write floor. A positive Workforce caller
cannot execute either the private financial owner or obtain the legacy tax summary. Its fixed command
returns only row identity, changed state and a generic Family-review notice; no tax amounts,
before/after values, periods or payroll batch details reach the editor. The durable notice is constant
for Family operations, not derived from hidden tax mode or another company's open-payroll state; it adds
no approval step. Detailed open-payroll alerts remain with the financial owner/audit, while the notice
lets HR review related inputs. Detailed tax audit follows the financial
reader boundary; an ordinary reporting relationship alone is not a tax-audit grant. Failure to append
either immutable event must roll back the Family and derived effects together.

The nightly script now composes the same kernel function on its actual owner `withTenant` connection.
It does not simulate an HR user on ai_hr_app. A real error is counted and produces nonzero exit while
other tenants/people can continue. Read-only tenant treatment and resolved entitlement context remain
in place. The actual sanitized CLI/app-role/system-owner/suspension outcomes still require execution.

The canonical employment-info owner now takes fresh Workforce admission before data locks, covering
direct imports/drafts/Movement callers as well as the UI facade. SQL independently guards the eight flat
organisation labels and plain contract remark. Its field inventory is pinned to the Personnel registry;
independent grade/compensation, financial, dated and resignation owners are not blanket-restricted.
Remaining lifecycle/assignment/specialist exception consumers must be reconciled against Board 1's
released baseline before catalogue activation, rather than guessed from role names or broad SQL flags.

Authored but UNRUN: the shared rule/installed-SQL and independent policy expectations, age/leap-day/grid
boundaries, Family value/relationship/manual-mode preservation, actual derived effects, current-session
and foreign refusals, raw/private owner and clock refusal, manager tax-audit denial, real nightly owner
versus a synthetic app context, idempotence, open-payroll bounded warning, full audit rollback, six-locale
form and nullable-choice behavior, and canonical/raw flat-info denial. A bounded unavailable editor now
keeps the ordinary record view available while unrelated infrastructure errors still propagate.

Board 1 confirmed that the existing `app.is_self_person` resolves actual app_user/tenant identity in
0029; db/client sets no app.person_id. The earlier speculative person-GUC finding was retracted after
that source check. No change to their 0576 owner was requested. All three leases remain with Board 1;
all new code, SQL, fixtures, app journeys, rehearsals and deployment remain UNRUN. The three capability
controls stay unsupported and 0578/0579 remain unjournalled/unapplied.


### Direct structural entry points — source only

The canonical assignment, retained transfer, structural reporting and blacklist entry points now take
fresh maintenance admission before subject/data locks, even when a caller bypasses the Workforce facade.
An assignment's supplied company also requires current destination maintenance. Direct termination takes
that same admission; the shared in-transaction termination writer remains the existing consequence of
an independently authorized resignation. Delegation retains its own relationship owner. This change
neither claims that an audit label is authority nor adds a caller flag for bypassing permission.

A prepared regression bypasses the facade for all five direct operations, asserts every refusal leaves
employment/assignment/reporting/event snapshots unchanged, then restores permission and writes a normal
reporting edge. This remains UNRUN. The following draft SQL binds structural/lifecycle writes to their finite owners. Its consequence
semantics and actual released peer baseline still require executed compatibility evidence before
enabling the three draft capabilities. Specialist Attendance/payroll configuration retains its independent owner;
a Workforce grant does not become a grant to those controls.


The draft SQL now checks assignment insert/update/delete, structural reporting writes and the finite
employment lifecycle/identity fields. Actual owner recovery and the independently authorized scheduled
owner retain their real connection authority. A normal runtime caller needs current maintenance on
both old/new subjects and any recorded assignment company. Structural row subjects and creation identity
cannot be reassigned. Delegation edges retain their existing owner; neither a profile editor nor a
Workforce group grant manufactures delegation/approval authority.

Termination may close incoming administrative edges outside the terminated employee's company. The
canonical writer therefore prepares a private transaction/actor/subject-bound intent, limited to the
actual termination patch and open range closures, and must append its real immutable termination event.
For an accepted resignation, the separate preparation function locks the actual pending request and
subject, checks fresh current legacy decision authority and the existing self/super-admin rule, and
derives only that request's fixed voluntary date/reason. It admits no caller-supplied termination patch.
The completed transaction must contain the accepted status and both matching immutable events. Missing,
replayed, unrelated or partial evidence refuses at commit and rolls the whole transaction back. Runtime
code cannot select or write the private intent table. No mutable GUC, audit label or supplied role acts
as a bypass. Rewards grade posting, payroll/statutory values and specialist Attendance configuration
are deliberately outside the lifecycle field list and retain their own existing owners.

Prepared but UNRUN regressions cover raw structural/lifecycle refusal, genuine separately authorized
resignation acceptance under a direct-maintenance denial, incomplete/private/self/replayed evidence,
full atomic rollback and actual actor audit. Required execution also includes cross-company incoming
edge closure, revoked and real foreign request refusal, delegation, entity transfer/hire correction,
scheduled sweep, default and independent grade posting, pinned-snapshot revocation and owner recovery.
The source is not a claim that those outcomes or SQL syntax/ACL/trigger semantics have passed.


A source review tightened the final resignation witness to recheck the actual request's Person and
normalized reason as well as employment/date/status. Another writer in the same transaction must not
change the source after preparation and still commit the old fixed termination effect. The authored
regression injects such a request change while retaining the ordinary decision and both events, and
expects the employment, request and events all to roll back. This is a source-derived correction and
an UNRUN regression, not an observed runtime result.


### Direct service-date and period bindings — source only

The remaining ordinary employment service/date inputs now have a draft SQL statement/row boundary:
the canonical period/value/unit and normal date fields, derived confirmation dates and source review
end dates. The inventory is tied to the actual org writer's declared input arrays; resignation/last-day
fields remain in the lifecycle boundary. The existing review workflow explicitly records advisory
outcomes on its own rows and never changes these source dates. Its separate `setReviewEndDate` function
is therefore direct maintenance and now checks fresh Workforce authority before data locks. Advisory
review decisions retain their existing owner and cannot mint maintenance authority.

The added database guard permits unchanged-value no-ops and credential-backed owner repair, and refuses
changed source values after maintenance denial. It adds no date, period, closed-payroll or pricing rules:
those remain in the canonical owners. Grade, payroll policy, cost allocation, card and holiday calendar
columns are excluded because they belong to independent specialist/approval owners. Authored UNRUN
contracts pin the exact 22 fields and both trigger lists; the prepared service/SQL case checks default
review-date writes, revoked service/raw period/date refusal, unchanged rows/events and restoration.
Actual old-snapshot revocation, owner repair, existing end-date/Movement/import/derived-status and review
consumer compatibility must pass under the leases before this is accepted or the catalogue enabled.


The corresponding Personnel review card now receives the page's actual maintenance metadata, displays
existing six-locale read-only feedback and omits only the source-date form when permission is absent.
Start Review and existing advisory actions keep their separate authority. The core/SQL checks repeat
at mutation time, so rendered metadata is not a write grant. A prepared DOM case covers permitted,
read-only and independent-initiation states; actual app/locale/keyboard outcomes remain required.

The request-preparation conflict check also uses SQL null-safe identity comparison: an existing direct
termination intent with no request cannot be relabelled as a request-bound resignation intent. Its
regression checks the immediate conflict state rather than accepting a later generic incomplete-audit
refusal. Family refresh comments now describe both retained standalone after-commit behavior and
atomic enclosing-transaction failure correctly. These source changes remain UNRUN.
