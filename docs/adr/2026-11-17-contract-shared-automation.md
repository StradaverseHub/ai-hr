# Contract Management on shared HR Automation

Status: accepted product direction; implementation candidate under verification. No installation,
merge or release approval. Date: 17 November 2026. Decider: repository/product owner.
Refines [shared builders](2026-11-15-probation-shared-automation.md) for the Contract handoff.

## Context

The supplied Contract Management handoff and executable HTML define the reviewed navigation,
page flows and interaction structure. AIHR supplies its authenticated shell, current Personnel
facts, company scope, signing, assigned work, approvals, durable jobs and delivery history.
Prototype personas and examples never become accounts, grants or production employee records.
The owner explicitly chose HR Automation as the shared module name, manual Personnel termination
until Offboarding clearance is available, tenant-wide Contract access administration, and a
separate approval before merge or release.

## Decision

HR Automation owns shared Workflows, Templates and Assignment groups. Contract contributes its
trigger, condition, step, recipient and merge-field catalogue through the shared service.
Existing Onboarding/Offboarding entry points lead to shared builders where their supported
adapter applies. Their native case, checklist, assignment and signing behavior remains under
their existing owners. Shared configuration is not a new cross-module permission.

Contract Management owns its tracker, decisions, case progress, fallback/posting settings and
named scoped access. Its public interface is `packs/contracts/service`; shared definitions use
`packs/automation/service`, native On/Off Boarding uses `packs/lifecycle/service`, and Payroll
continues through its existing pack/native services. Personnel remains the owner of employment,
current contract periods, movement history and effective dates. Cases propose changes and keep
receipts; they do not create another employment truth.

The tracker follows the current authorized population, bounded filtering/counting, attention
flags and actual next owner. Case View, decision authority, configuration, posting-group work,
shared builder access and assigned document work are separate facts. Contract access
administration requires a tenant-wide Manage access grant or the system Access administrator;
a company-scoped grant does not administer Contract roles across tenants or all companies.
Assigned approvers/signers can act on their own routed work without gaining tracker access.

Renewal, permanent conversion and ending are explicit decisions. Preview records applicable
workflow versions, approvals, documents and blockers before submission. Accepted runs retain
frozen versions and current deterministic owners enforce each transition. Conversion changes
employment type through Personnel and does not start probation. Date-based workers may remind
and open eligible cases only within their approved provenance; they cannot decide, approve,
sign, post, change Payroll or terminate employment.

Documents use the existing Review/Approve/Sign engine and audit history. Their actual account
and Person identities, company, version and current routing govern access. Case View alone does
not expose Form answers. Live values freeze at the first signature, or at release when no Sign step is configured;
case wording edits do not change a published template. Send-backs retain their reasons and return through the real owner.
An employee's own unassigned email-document slot may bind only its unique verified account
under the exact waiting pin proof. Form values stay hidden until native routing grants access.
Employee email invitations wait for required HR document/file prerequisites. Recovery can resume
only the same waiting Send email step; it cannot authorize an authored business suffix.

Personnel postings require their configured posting approver group. Acceptance, queueing,
application, failure/reconciliation and actual completion remain distinct states. Posting
application uses the existing protected bulk-job and Movement owners, with immutable issued
Payroll and native effective-date/history protection. Agreed pay is entered manually in Payroll;
the designated posting approver group separately attests completion where required. Saving
Payroll or matching an amount does not automatically close a case.

Native Org publication retains exact passive Assignment replacement and mapping receipts in its
audit event. Existing audit readers and exports can show this added lineage metadata; no access
grant or provider disclosure is added. Automatic historical replay requires a provable one-to-one
full-range replacement. Split, legacy ID-less or unprovable projections require People Ops
reconciliation; the posting remains pending and its atomic application changes roll back.

A reviewed and released ending letter supplies the native Offboarding handoff. Contract can
close as handed to Offboarding; it does not imply clearance or termination is complete. People
Ops records termination manually in Personnel Management until clearance integration is available.

## Options considered and consequences

Keeping separate builder copies would retain different configuration and routing owners. The
chosen shared builders reuse definitions, versions and directory/group identities, while module
catalogues and native adapters preserve supported behavior. This increases the importance of
cross-module regression checks and explicit per-module permissions. Native On/Off Boarding and
Payroll effects remain separately owned; a shared workflow is not permission to bypass them.

## Verification and release follow-up

Source review, component screenshots, real native/restricted-owner tests, whole compiler,
production-rendered journeys and the complete release gate establish separate claims. This ADR
records the agreed boundaries; it does not certify pending tests or an installed outcome.
Preserve original failures and immutable SQL. Final pending migration identities must follow the
actual accepted earlier releases and ordered ledger. Finish the required native and rendered
checks, present the actual result for review, and wait for the owner's merge/release approval.
