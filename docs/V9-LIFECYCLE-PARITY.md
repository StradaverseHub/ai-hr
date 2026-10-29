# AI HR V9 behavior and screen reference

The supplied Admin V9 application defines the target experience. The handover explains the design but contains several omissions and inaccuracies. This reference records the implementation contract; its presence does not establish that the build has passed acceptance.

## Shared business model

One case belongs to onboarding or offboarding. Personnel supplies employee facts; case submission is a separate state from Personnel Draft or Active. Checklists instantiate work, assignment groups resolve owners, workflows schedule document and communication actions, and document completion can close a linked task. Return/revoke items are separate from checklist tasks.

The prototype stores all of this in browser memory. Production must persist revisions, case and configuration history, documents, signatures, uploaded files, workflow progress and delivery outcomes. Sending, queueing and delivery are distinct states. Employee form values become Personnel proposals until HR explicitly approves a writeback.

## Screens and interactions

| Area | Experience to reproduce |
| --- | --- |
| New Joiners | Name/employee search, Business Group, Personnel status, case state and join-date filters; separate case/request IDs, NEW marker and progress with pending-step details. |
| Joiner case | Case details, matched checklist, equipment/access, documents/emails and case history. Preserve Personnel-locked values, partial saves, submission, cancellation, date adjustments and progress by owner. |
| Onboarding checklists | List/detail and population preview; ordered tasks with owner, assignment mode/group, open/due days, required flag and document/action linkage. Warn about equally specific matches. |
| Leavers | Five case types, Business Group/status filters, readiness and last-day review states. |
| Leaver case | Case details, notice/leave/final-pay calculator, snapshotted checklist, return/revoke work, documents/emails, clearance and log. Reopen cleared figures only with a reason. |
| Offboarding checklists | Matching and task editing with Day 0 at the last working day; employee-linked exit form and survey; post-exit tasks remain part of clearance. |
| Document templates | Module filter, form/letter/acknowledgement/attachment definitions, ordered content and field blocks, conditional fields, owner/Personnel mapping, signature settings, drafts/publication/history, sample preview and import. |
| Email templates | Subject/body, merge help, sender, default CC, links/attachments, inline images, required per-person file slots and active switch. |
| Workflows | Module filter, trigger/conditions/ordered steps/description, working-day and repeat switches, skip conditions, dry run, case runs and preview/edit/test actions. |
| Settings | Separate onboarding/offboarding/shared tabs; configurable visible/required case fields and population rules; equipment catalogue/providers/approval settings; notice/leave/pay/revocation policy; company letterhead/signatory and PBP routing. |
| Assignment groups | Searchable membership, workload limits, leave awareness and an explanation of assignment behavior. |
| Tasks | Mine / My teams / Done across case tasks and equipment/access work; reassignment, bulk equipment assignment/dates and notes/mentions. The calendar belongs to employee home. |
| Request records | Onboarding REQ approvals/fulfilment and offboarding RVK return/revoke views, with case links and history. The handover omits the RVK view. |
| Role profiles (unreachable legacy) | Final navigation does not bind the legacy profile handler. Active `profileFor` uses catalogue matching rules; do not create a second active profile subsystem. |
| Module access | Module users, joiner page section presets and request-record groups. Production retains real identity, company scope and server checks. |
| Employee view | Own staged tasks, documents/forms, required-field enforcement, read-only Personnel fields, upload, signing/acknowledgement and task completion. |
| Personnel changes | Reviewable before/after proposals, explicit HR push, repeat protection and source-change handling. |

## Matching and assignment

Further source inspection distinguishes the tie breakers: onboarding `rrPick` uses assignment recency after open load; offboarding submission uses `rrItemPick`, whose equal-load tie retains configured member order. Its `openLoad` reads joiner group tasks and claimed equipment work, with a temporary extra-load counter for the new case. It does not add other leaver cases to that source count. The working candidate now consumes the native owner's workload and availability projections with these separate tie breakers. Its unallocated SQL draft extends the existing aggregate projection to include claimed equipment; it returns no task names or medical details.

Rules use AND across populated dimensions and OR within each dimension. An empty dimension matches everyone. Checklists select the highest number of populated dimensions and then display order; manual selection and manual None are real choices. Both checklist types support employment type, contrary to one passage in the handover. Onboarding locks the automatic choice once the person is Active; submitted offboarding snapshots its work.

PBP routing has a different specificity score: Business Group 4, company 2, department 1. A case-level PBP takes precedence. Do not reuse checklist ranking for this routing.

Checklist assignment excludes leave on the task due date, applies the group's open-task cap, then balances open work and least recent automatic assignment. An inability to assign remains visible with a reason. Approval assignment and equipment assignment have distinct paths in the source; they must not silently inherit checklist assignment assumptions. The application supports sequential and parallel request approval modes despite the handover emphasizing sequential approval.

The existing system already resolves Business Group from a draft department and, after activation, the dated assignment. Company is a separate dimension. Grade and employment-type rules must use actual master IDs and labels; source sample codes are not production reference data.

## Date conventions

Persist dates as ISO and display dates day-first. The business clock belongs to the repository's Malaysia date helper, never a hardcoded prototype date or the server host timezone.

Onboarding checklist Day 1 is the join date. Positive Day N means join date plus N minus 1; negative days are literal days before joining. Offboarding checklist Day 0 is the last working day and its offsets are literal. Workflow afterJoin offsets are elapsed days, so offset 6 releases on onboarding Day 7. Equipment/access uses a separate source control: its default is Day -1, and its four-character due-day input accepts Day0 as the join-date anchor. This does not change the checklist Day0 rejection.

The supplied working-day trigger counts Monday to Friday and does not exclude holidays. A before-anchor workflow catches up within its due-to-anchor window; after-anchor workflows catch up after their due date. It is not an exact-date-only scheduler. A waiting execution resumes when its condition is met, while previously completed send steps remain deduplicated.

## Seeded automation

| Event | Effect |
| --- | --- |
| Join minus 7 calendar days | Welcome email from TA, copying the supervisor and PBP. |
| Submission with join fewer than 7 days away | Immediate readiness alert to supervisor, copying PBP. |
| Join minus 5 days through join date | Daily messages to each owner containing only that owner's pending pre-join work. |
| Join minus 2 days | Escalation to PBP, copying TA and supervisor, if pre-join work remains. |
| Join date | Release the device acceptance form in the system without an email. |
| Join plus 6 days | Generate and email the onboarding satisfaction survey. |
| Join plus 9 days | Remind about the survey unless its task is complete. |
| Resignation submission | Generate acceptance letter and wait for HR signature. The checklist task owns its single send, copying supervisor/PBP. |
| Last day minus 10 working days | Generate exit form and survey and email links. |
| Last day minus 7 working days | Remind unless both forms are complete. |
| Last day minus 5 calendar days | Leaver reminder, plus daily owner-specific pending-work reminders through the last day. |
| Last day minus 2 calendar days | Escalate open pre-exit work to PBP, copying People Ops. |
| On or after last day | Auto-close when every task/item is resolved and no item is not returned; otherwise flag HR and send one review alert. |

Two additional onboarding examples are drafts and do not run. There are 15 workflows in the supplied application. A late first run may send the initial exit-form message and its reminder together; changing that is a separate product decision.

## Documents and communication

Seven source document templates are present: personal details, code of conduct, resignation acceptance, device acceptance, onboarding satisfaction survey, exit interview and offboarding survey. The onboarding survey's current version contains 48 fields. Eight email definitions include the acceptance-letter CC and the form/survey communication paths.

Generation uses a published template version and snapshots its content and fields. Required and conditional fields govern completion. Personnel-locked fields cannot be overwritten through the employee form. An HR-before letter waits for HR's signature; an HR-after document waits for countersignature after employee completion. Withdrawn and superseded documents remain historical records.

An absent merge value becomes a labelled placeholder in the source, not an empty string as claimed in the handover. Production send/sign boundaries must reject unresolved required values. IC, passport, tax, EPF and bank tokens are excluded from email bodies; they may belong in an authorized document.

Preview, Edit for this person and Send test operate on the chosen case's output. Open workflow is a separate action. A per-case edit does not change the shared template. A test targets the signed-in user, clears real CC recipients, is visibly marked as a test and does not advance employee work.

## Clearance and final pay

Notice precedence is the employee contract term, then the matching policy band, then the configured default. Contract end and retirement use their fixed date. HR can record early release, waiver, pay-in-lieu or an immediate termination override. The system already stores before/after-confirmation notice terms; use those employment facts rather than interpreting Full-time as Permanent.

The source calculator derives leave to the last day, applies carry-forward/taken/approved leave, supports notice offset, encashment caps and documented HR reduction, and computes a configured pay-day result. The source divisor 26 and pay day 25 are seeded policy defaults, not independently established legal or employer facts. Read actual Leave/Payroll sources and preserve their ownership.

Manual clearance can proceed with outstanding work if HR records an exception reason. An item marked not returned also requires a reason. Automatic clearance never exercises this human exception. Post-last-day tasks block automatic closure even when none are overdue; this produces the otherwise surprising zero-overdue HR review banner. Repeated daily checks produce only one initial HR review email.

Clearance freezes figures and hands them to Payroll; it must not silently enact unreviewed pay changes. Reopening unlocks figures, retains history and requires a new clearance. The prototype's displayed success strings are not evidence that Payroll, Personnel or an identity provider was updated.

## Acceptance evidence

Analysis independently executed 15 checks against the supplied embedded logic. Development verification includes 43 passing no-database checks (rules, form controls, server runtime and repository boundaries) and 34 passing database checks across V9 and the existing onboarding regression suite. The seven V9 database checks, including final Payroll column privileges, were repeated successfully against backend checkpoint ace747860. Database checks used an owned temporary PostgreSQL cluster with the canonical baseline followed by the draft SQL overlay. These are development results, not release receipts.

The whole-repository compiler passed at ace747860 after correcting scheduler connection-type, attachment-slot inference and nullable fixture-ID errors. A controlled local rendering fixture confirmed the actual case list, calculator source warnings and generated form preview at 1440×1000 and 390×844. The first render exposed stacked icon buttons, stretched status pills and mobile navigation occupying the first screen; one layout batch corrected these, with desktop/mobile confirmation captures. The generated form's dialog title was also exposed to accessibility tools. Reference screenshots of the supplied HTML remain unavailable, so rendered comparison and exact visual parity are not established.

No full gate, production build, canonical migration rehearsal or complete native onboarding/delivery journey is accepted. The handover's reported 51 checks remain its author's claim rather than a verification run performed in this build. The temporary preview and its owned PostgreSQL server were stopped; its fictional fixture is preserved separately from installation data.

Merge requires current candidate verification, authenticated CI evidence where used, additive migration coordination and preserved concurrent work. Integrate main and alpha at the same final commit under the repository policy. No production deployment is authorized by this build-and-merge request.
