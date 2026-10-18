# ADR 0129 Kingdee onboarding and requisition workflow

Date: 18 October 2026
Status: Accepted for implementation by the owner
Supersedes: ADR 0095 onboarding decisions only
Reference: Kingdee AI HR Onboarding Handoff V3.1, prepared 16 October 2026

The owner approved the comparison and implementation plan, instructed exact handoff behavior, accepted the recommended resolutions of open points, and required preservation of existing data and history.

## Identity and ownership

Personnel owns supplied hire facts. A saved draft is captured input, not employment. The onboarding source link retains the draft UUID without a cascading draft foreign key. Activation attaches person and employment to the same case before deleting the draft. Draft discard cancels its onboarding work with a recorded reason. Source updates and backfill are retry-safe.

Business Group uses the existing Personnel Business Unit master and identifiers. Before activation it is derived from the Personnel department's Business Unit. After activation the dated assignment's explicit Business Unit owns the value. Company remains a distinct rule dimension. The employee's company join date is employment.joinDate with hiredOn as fallback; hiredOn is the group join date.

HR-entered missing values remain local onboarding answers. There is no implicit Personnel writeback. Personnel-supplied values lock individually; later source changes remain traceable.

## Separate process and preserved history

V3.1 uses separate storage from lc_case, lc_case_step and legacy ITR requisitions. Existing legacy cases, header approvals, asset issues, acknowledgements, employee requests, returns and offboarding retain their meanings.

The persisted case is an aggregate with stable child IDs for tasks, requisition generations, items and snapshotted approval steps. Its row version and transaction lock protect concurrent changes. Requisition history remains in the aggregate; superseded task runs and acknowledgements have explicit history collections. Definition revisions are retained in an append-only configuration-history table. Every changed case version is archived before replacement; HR-sensitive revisions use separate immutable storage and company-aware HR RLS. Notes are retained when edited or deleted. Domain events contain references, actor and action rather than copied HR field values.

Cost centre, IC and passport are stored separately under company-aware HR RLS. Task participation does not grant legacy staff privileges or Personnel draft access.

New-model intake is enabled through explicit setup. Existing Personnel drafts are backfilled at setup and the scheduled refresh. Legacy records remain accessible through Previous onboarding cases. Conversion of legacy completions into equipment handover or item approvals is prohibited: those facts did not exist in the old model.

## Submission and states

Personnel Draft/Active, case Pending/Submitted/Cancelled and derived requisition status are separate lifecycles. Checklist progress is derived, not the case submission state.

Save accepts incomplete pending details. Submit case and confirm checklist saves its supplied answers, validates, confirms the template, instantiates work, assigns group tasks and creates the requisition and item approval executions atomically. Optimistic version checks protect edits. Server counters create unique case and requisition display numbers.

Catalogue matching uses IDs and AND across populated dimensions, OR within each dimension. Checklists rank by number of populated dimensions; creation time and stable creation order resolve ties, with a warning. Manual None is a real override.

Day 1 is join date, positive Day N is join date + N - 1, negative Day N is join date + N. Day 0 is invalid. Opens cannot follow Due. Empty progress denominators display zero. Empty/all-excluded requisitions require explicit handover rather than becoming complete through an empty all-items test.

Recent Active joiners remain on the list for 30 days by default, with unfinished work retained. The window is configurable. Employee ID follows the platform's existing terminology.

## Assignment and approval

Checklist round robin checks approved leave, including partial-day leave, on the due date, applies the group's open-task limit and balances task count then least recent automatic assignment. Failure is stored and exposed to owners/editors; retry is explicit.

Approval round robin checks leave today, avoids the requester when another candidate exists, balances pending then lifetime group approvals, then member order. It has no task workload cap. The Leave owner's per-date approval semantics are preserved, including cancelled child dates and approved partial-day leave; the handoff's day-level unavailable rule applies to any approved duration; the narrow availability projection returns dates, never medical detail.

Item-mandatory workflows override exception settings and checkboxes. Matched nonmandatory items need no approval. Other exceptions follow their configured workflow and checkbox/always-required setting.

Each item snapshots its execution. Sequential steps cannot be skipped; parallel steps are independently actionable. Group backups record the actual actor. Manual steps must first be assigned. Compatible items batch by requisition. Later leave does not automatically move assignments.

The owner's exact-parity instruction selects the handoff's logged requester auto-approval for this new process. It does not change the no-self-approval rules of legacy requisitions, employee asset requests, leave or other modules.

Rejected executions retain their decisions. A new request after removal creates a new audited item execution. Missing routing/definition references remain unresolved, with an explicit retry-routing action for module users. Repair preserves decided steps.

## Configuration rights and deletion

Module access, task/group participation, checklist ownership and HR-sensitive access are independent. Master Admin maps to the platform's group-administrator authority. Module grants are explicit. Team participation remains available from My tasks without Onboarding page access. Members of configured catalogue fulfilling groups, approval workflow/routing groups, Group Tech and add-system groups can read the requisition list and details, matching the handoff’s operational roles. This read access persists across the Facility-to-Tech stage change; action rights remain bound to the current team or approval step. Mention-only users receive the scoped thread rather than the full requisition.

The specific owner-only checklist deletion rule governs over the handoff's broader permission summary. Ownership transfer requires current owner and a new owner with module access. Last checklist/fallback and used/last workflow protections apply.

Group deletion redirects unfinished tasks to a selected replacement or No group yet with manual assignment. Pending approval references remain unresolved where no replacement exists. Group Tech fulfilment and confirming group are explicit configuration so deleting a sample-named group cannot strand the system behind a hardcoded name. Existing execution and definition history survives.

An HR administrator with Onboarding access or an authorized Master Admin may explicitly release a stuck team claim, with audit. There is no automatic reassignment timer.

## Fulfilment and acknowledgement

Starting a team item claims it; teammates see the claimant and locked controls. Returning To do releases it. Access cards move from Facility printing to Group Tech activation. Preparation is distinct from Day 1 handover.

Handover checks readiness and pending approvals atomically, marks active items handed and unlocks the signed-in device acknowledgement. The form remains authenticated; no public token route or unselected e-signature vendor is introduced. Joiner and manager task accounts resolve through canonical person/reporting references. Ambiguous or missing logins remain unassigned rather than guessing.

Equipment progress follows R9, including the extra denominator slot before handover. Reconfirmation preserves completed work, archives the prior task run, updates dates and creates/assigns new tasks. Personnel Draft checklist changes require explicit reconfirmation after submission; Active checklist choice remains fixed. Approval executions retain their history and targets, with explicit repair for unresolved routing.

## Conversations and notifications

Notes use stable conversation IDs and explicit user mentions. Replying resolves outstanding mentions of the author in that conversation. HR note acknowledgement is tied to the note revision. NEW joiner seen state is separate from notification reads and is set after the page actually opens, avoiding prefetch-induced reads.

Onboarding notices target app_user, including login-only users. They integrate with the system-wide bell. My tasks remains a live authorized projection and composes existing approval work without broadening old approval permissions.

The minute workflow-email sweep refreshes Personnel and produces due, overdue, needs-owner, assignment-failure, mention and sync notices. A daily digest is deduplicated after 08:00 Malaysia time. Managed email uses the existing policy, verified-identity consent, relay and reauthorization controls under a distinct Onboarding category. Login-only and ambiguous employment mappings receive in-app notices without a fabricated employment or arbitrary email target.

Cancellation suppresses actionable queues and later delivery eligibility. Reopen returns pending; resubmission creates a fresh requisition generation while preserving prior task, approval and acknowledgement history.

## Verification obligations

The implementation must demonstrate all handoff scenarios 1–17 and R1–R16. Focused pure-rule tests cover matching, both assignment paths, item approval precedence, manual/backup/sequential/parallel behavior, claims, card stages, weighted progress, gates and retained generations. Database tests cover source synchronization, HR RLS, task-only participants, stale writes, cancellation/discard and note ownership. Actual app journeys, all locales, migration rehearsals and the repository's final release gate remain separate required evidence.
