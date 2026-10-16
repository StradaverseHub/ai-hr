# ADR-0125: shared Personnel facts, explicit employee permissions and atomic editing

Status: implementation in progress; runtime verification pending.

The approved cf588903 plan aligns My Profile with Personnel without turning administrative projections
into employee authority. Every shared descriptor declares employee visibility and its update route.
Labels, types and choices retain their existing canonical owners. Import/report eligibility and the
`scope` property do not imply ESS permission. Protected HR notes, audit/private reasons, operational
configuration and draft-only controls remain excluded with a stated owner reason.

The existing `ess.profile_change_fields` remains the policy store. Legacy `all` means exactly the old
request field set; newly supported facts start View Only. Legacy arrays govern only requests, so legacy
`[]` denies requests while retaining the previous finite phone/personal-email and primary-contact course.
A newly saved complete policy uses `{version:2,fields:[...]}` in the SAME setting. Its explicit empty list
denies every edit, and omission of a direct/primary capability means View Only. Malformed new shapes
fail closed. No fake field marker, second setting or migration rewrites existing values/history. Existing
shared phone/personal-email direct rights are finite compatibility defaults. The old primary-emergency self-edit is a distinct compatibility capability:
only its five previous fields on the exact current primary record, rechecked in the mutation Tx. It is
never permission to create a record, edit another ID, set priority or edit new fields. Explicit View Only
closes that capability. Permanent/Correspondence are the shared address targets. Old legacy address
values/history remain read-only reconciliation evidence; no automatic copy/drop or permission mapping.

The profile_change_request owner retains legacy requests and decisions and gains bounded versioned
scalar/register proposals. The server derives subject identity, freshly checks policy and exact record
IDs, and composes immediate updates and request creation in one outer transaction. Approval rechecks
current policy, owner scope, master baselines, references and archived state before canonical Tx writers.
Primary/Highest transfers, family child-relief synchronization, tax selections and historical Payroll
protections remain under those owners. Pending facts never replace master facts or AI context.

My Profile uses a safe explicit projection and shared presentation, never the administrative page/full
rows. All eleven applicable tabs retain module/document permissions. Country-specific statutory reads
and writes follow the selected own employment's company pack; missing pack is explicitly unavailable.

This decision does not attest arbitrary application SQL, grant manager salary visibility, add a second
approval engine, or claim runtime verification. The acceptance map records the required actual journeys.

The original request aliases bind only their actual scalar Personnel facts. Repeated-dependent names,
gender, birth date and passport never inherit an employee scalar permission merely because their owner
field has the same spelling. This prevents the legacy `all` sentinel from opening new registers.

The partial Person adapter shares canonical validation/write/event handling; omitted nullable core
values retain their exact stored state. Canonical contacts preserve account/email consent behavior.
The country pack explicitly says whether an IC change is representable by its existing owner; ESS
refuses unsupported clearing instead of recording an approved proposal that the owner would no-op.

Self-edit starts only for the current verified login's own hired, nonblacklisted employment through the
canonical inclusive final-day boundary in Kuala Lumpur. Decision/history/PDPA access are separate.
Same-transaction policy, employment, Person and register/pack-row locks protect fresh checks. Dependent
rows precede statutory rows to retain child-relief owner ordering; primary/highest rows lock before
other register targets to follow canonical transfers. These source contracts still need concurrency,
actual app-role RLS/privilege and full journey verification.
