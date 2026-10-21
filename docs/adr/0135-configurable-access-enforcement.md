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
