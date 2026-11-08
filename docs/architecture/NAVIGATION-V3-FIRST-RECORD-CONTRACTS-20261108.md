# First-record V3 contracts and native lease proposal

Base: frozen design `7c127fc39a77b4e314ce04a228f4cb6334ef74ff`, retaining
`996cf85fdc0759bb01357b72927b24f897b95d79` source. This slice is **unadmitted
contract code**. It creates no native handle, fixture, DB connection, browser
interaction, capture or release witness. Original v2, application pages, domain
owners, system fixtures/load, CI and db/client are unchanged.

## Implemented contracts, separate from acceptance

The intent grammar takes existing descriptor IDs from the canonical Personnel,
ESS and draft owners: ten actual Personnel tabs, eleven ESS tabs and five draft
tabs. It copies no permission or href policy. Requests contain closed symbolic
record relations and one of the existing four fixture role labels; neither proves
permission. Raw URLs, UUID parameters, selectors, scripts, outcomes, verification
flags and grants are not request fields. Family/type/descriptor mismatch and
semantic duplicate requests refuse. Safe dirty/save research is restricted to an
owned draft Profile intention; no financial/ESS/foreign mutation intention exists.

The planner derives fixed bounded abstract steps, not executable callbacks or
selectors. It pins the original 249502-byte census SHA256
`746d8bbf9130588a91801d2b54983821cdf60cc5e4e748c908cc727e5cb3b930` through a
bounded NOFOLLOW stable-FD read. It always retains all46 family IDs, all four role
obligations and all120 actual parameterized page owners, including the two
invitation and one operator pages. Every native disposition, page/descriptor
association, fixture binding and baseline/loaded state stays unresolved. Any
selected prototype leaves sourceMatrixComplete/runtimeAcceptance/releaseAuthorized
false. Unsupported ScheduleGroup states remain in the unchanged source census;
none becomes usable data or is deleted. The 33 uncomposed families remain open.
The full source matrix must eventually distinguish actual leaf and realm roles;
these family obligations do not pretend to supply that matrix.

The admission module is deliberately not a handle factory. It exports only the
fixed missing-commissioning state. There is no setter, public callback, injected
verifier, private brand issuer or accepted JSON authority. Later real native
binding must be a separately reviewed fixed source/lifetime/process/query owner.
No validator in this slice turns a complete fake JSON row into a native capability.

## Exact first fixture and presentation owners read

Personnel uses the existing system-fixture hire500 input facts; this slice will
not hire a 501st employee. `hireEmployee(ctx,p,outerTx?)` in core/org.ts takes a
company/department, person name/mail, employment type/date and explicit employee
code, acquires canonical Workforce/Access/Leave/Criteria ownership, and returns
only personId/employmentId. The existing workload independently supplies name
`PERF Person NNNN` and code `PERFNNNN`. Real future probes must bind all actual
returned/native identities and current permitted Workforce projection through
assertWorkforcePresentationEmploymentTx + employeeDetail(...,'workforce',tx).
Per-panel child records still need separate canonical fixture/data proof; the
name/code pair does not make Family/Bank/Leave/etc usable.

ESS is the same actual actor's current own subject, never an administrator's row
or a role string. The real page reads its policy, own subjects, projected workspace
and facts and can show a subject chooser/error or no-linked state. Native owners:
myOwnEmploymentSubjectsTx(profileEdit:true),
readProfilePresentationSnapshotPolicyTx, readOwnProfileWorkspace(...,tx),
readOwnProfileFacts. Hidden tabs, visible fields, masks and edit/approval status
stay with the current policy owner. The planner does not infer a forbidden tab
from the fixture role or force an edit that native policy does not permit.

Draft creation is NOT activation. createEmployeeDraftWithReservedCode(ctx,p)
reads the current company numbering rule, then its canonical command transaction
rechecks access/company, holds a code, inserts currentStep1, appends
employee-draft.created and performs onboardingSyncDraftTx. It returns id/code.
The new pure input recipe generates a job-specific NAVD-code and example.invalid
name/mail using the unchanged requireEmployeeCode and missingToCreate rules. The
caller must first prove current manual entry is actually permitted; a native
refusal stays blocked and cannot trigger policy reconfiguration. No counter reset,
raw insert, auto-activation or stub grant is provided. The pure equality helper
checks only selected independent name/mail/code/company/id/step facts and returns
void; cloned JSON can satisfy that equality, explicitly without authority. Other
native defaults, audit and identity custody still require actual native proof.

getEmployeeDraft and saveEmployeeDraft retain RLS/current rights; save forces a
held code/company back onto the draft. Existing `?draft=` unknown identity may
render the Create screen rather than404. The future denial oracle must model
that exact native outcome rather than accept200 or invent404. Save must use the
real UI server action, validate persisted phone against independent edited input
and preserve actual reserved identity, all other fields/defaults and native events.
Unsaved cancel must keep the dirty value/current panel with no persistence;
discard must perform the actual prompt transition, restore source value on reopen,
and produce no save event. A saved reopen must show canonical persisted values.
No phone edit is executed in this slice; control metadata, actual prompt selection,
native cleanup/discard receipt and exact full before/after snapshots remain gates.

## Concrete connection seam: review before any native resolver

Actual db/client.ts has module-level DATABASE_URL initialization and createDb
caches postgres clients by exact connection string. `createDb(url,{max:1})` is NOT
a new bounded lease if that URL already has a pool: options are ignored for the
cached client. Changing URL query/credentials to evade that cache creates another
pool and consumes undeclared capacity. Importing the factory at runtime also
initializes the default singleton. This slice imports neither it nor business
service modules at runtime. No DATABASE_URL or role/environment override is used.

Preferred minimal root-owned review direction:

1. Use the existing application's withTenant and admission owner, with a serial
   one-active-probe gate in the existing workload family. This reserves at most
   ONE simultaneous connection from existing pool capacity; it does not claim to
   reduce configured poolMax or create a separate max1 full pool. Keep actual
   backend PID/start and transaction identity per probe, signal before admission
   and every new statement, owned drain before release, and no nested withTenant.
2. Compose canonical Tx-aware owners on that exact admitted transaction. Existing
   employeeDetail(existingTx), ownSubjectsTx, policySnapshotTx and ownWorkspace(tx)
   are concrete seams. A fixed native current identity/session proof must be
   included before the family reader and compared to the actual signed-in browser
   account/current cookie. Do not turn fixture role labels into SessionContext.
3. Draft getEmployeeDraft has NO existingTx; readOwnProfileFacts has NO existingTx
   and fans out through Promise.all into several independent singleton reads.
   Merely calling these inside a max1 wrapper does not join it and can deadlock or
   break the budget/snapshot claim. Those canonical owners need reviewed narrow
   Tx-aware purpose adapters (and their full authority/DTO equivalence proof), or
   the corresponding complete-panel binding stays uncommissioned. A small first
   own-workspace projection is not a full ESS page/facts proof.
4. Native fixture commands preserve their actual command isolation, Access/History
   barriers and audit. createEmployeeDraftWithReservedCode performs a separate
   current-rule read and then its command; no outer Tx is currently available.
   Seed it before capture through the canonical constructor, under the root-owned
   budget/lifetime, retaining complete input/output and cleanup authority. Do not
   blanket-wrap all commands/GET owners in RRRO or drop onboarding/audit effects.

An alternative protected process-local max1 factory requires a proper root-owned
client/transaction-factory split and aggregate reservation, not a wrapper around
createDb, copied withTenant code or borrowed owner credential. No such factory,
client change, domain adapter or process admission is implemented/approved here.

## Required next proof and remaining scope

After root reviews these exact seams: real fictional native restricted-LOGIN
principal/session/projection and record reservation proof; current revocation,
foreign/same-tenant-out-of-scope/unknown/mismatched/stale binding refusal; exact
native outcome oracle; actual rendered/browser mounted panel/dirty/save/history/
query behavior; full before/after identity/financial/history preservation; bounded
owned construction/abort/drain/cleanup; source/build-data custody and role/realm
matrix. No hidden panel/heading/200/metadata-only witness can qualify content.

All90s/1024case/8step/16check limits, four real sign-ins, six loaded browser
contexts, steady500 and existing ramp/hold/latency/error/Busy conditions remain.
Planner capacity stays unproven; it has no loaded scheduler/cohort authority. Root
owns data-Git-blob/tree sealing for oversize locale inputs (without raising code
limits), pool/process/profile/CI integration, load/cohort/2/4/8 and staging. All46 /
120 obligations remain open until actually resolved/executed; these eleven proposed
pure tests are not native or browser evidence. Production remains held.
