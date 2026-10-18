# Kingdee onboarding and requisition comparison and implementation plan

Prepared 18 October 2026. Planning artifact only; no application changes.

The requested change replaces our manual onboarding case and provisioning checklist with a Personnel driven onboarding process: HR prepares and submits a case, configurable rules select its checklist and equipment, and teams complete assigned tasks, item approvals, fulfilment and Day 1 handover. Requisitions here are IT and facilities work orders, not hiring or headcount requests.

The target is the behavior in the supplied V3.1 handoff, including its 16 business rules and 17 acceptance scenarios. Its explicit production corrections take precedence over documented prototype shortcuts. Unsettled behavior remains visible below rather than being presented as an established requirement.

## Evidence and scope

**FACT — reference:** [Kingdee handoff V3.1](/Users/zenlam/Downloads/Kingdee-AI-HR-Onboarding-Handoff-V3_1.html), prepared 16 October 2026. SHA256 eb7f8e72639c61704d0960d570396fc3454288d97135d3691485a796724d73ba. References such as H§7 R4 identify the handoff section and rule.

**FACT — code baseline:** main at 66788b21417158f0d6f06502661bfac84dbbe3fe, read from /Users/zenlam/Projects/ai-hr/.claude/worktrees/mainwt. The root scratch checkout was excluded. Its redirect to .Codex/worktrees/mainwt is stale; Git registration and mainwt/CLAUDE.md identify the actual checkout. AGENTS.md is retired there.

**UNKNOWN — prototype runtime and deployed behavior:** the [linked prototype](https://claude.ai/artifact/TySsV5rrLWp2xGNoB9qEUY) was inaccessible through the web tool. The handoff declares that runtime authoritative where it differs. This comparison establishes handoff versus current main source behavior, not visual/runtime parity or production deployment. ADR-0095's old “not merged” status is historical and is not evidence of today's deployed state.

**Scope:** New Joiners, onboarding case, Checklist Management, universal My tasks, onboarding requisitions, catalogue, workflow/routing settings, groups, module access, notes, notifications and the Personnel/Leave integrations needed to make them work.

**Preserved adjacent scope:** offboarding, returns, standalone requisitions, asset register, employee asset requests, existing acknowledgement and other modules' approval inboxes. They need compatibility tests where shared code changes. The new handoff excludes offboarding, employee self-service requests and a redesign of employee-facing onboarding. Real completion adapters for joiner/manager tasks are still required; pretending their read-only admin rows are executable would not satisfy the flow.

## What the handoff describes

The handoff is an integration specification for an admin prototype, not source code for an application. It defines a coordinated HR, Group Tech, Facility and approver workflow.

Three separate lifecycles matter:

| Lifecycle | Target states or milestones | Meaning |
| --- | --- | --- |
| Personnel | Draft / Active | Personnel owns hire and employment status. |
| Onboarding case | Pending submission / Submitted / Cancelled | HR readiness and submission, separate from task completion. |
| Requisition | Submitted / Awaiting approval / In progress / Ready for Day 1 / Completed / Cancelled | Derived from item approvals, preparation and handover. |

Checklist progress is a fourth, derived measure. A submitted case may have unfinished tasks; an Active employee may still have a Day 7 survey. Equipment readiness is distinct from physical handover and from employee acknowledgement. (H§1, §4, §7 R7–R10.)

The principal changes from the older design are catalogue rules instead of Role profiles, one combined submission/checklist confirmation, independent per-item approvals, one queue across teams and explicit handover. The automatic “IT requisition” checklist task was removed; the equipment panel and progress calculation represent that work without duplicating it. (H§5, §10.)

## How our current system differs

All “current” findings in this table are FACT about the source baseline. Evidence keys resolve to the file table at the end.

| Area | Current main | Required V3.1 behavior | Impact |
| --- | --- | --- | --- |
| Intake | Staff manually enter or spreadsheet-import an onboarding case; name, employee number and join date required. Case creates its requisition immediately. [C1, C5] | Personnel Draft produces one pending case automatically; incomplete details can be saved; requisition starts only on submission. H§5.2, §6 | Replace intake trigger and submission boundary. |
| Personnel integration | Case stores its own name, title, department and supervisor; person/employment links optional. Personnel drafts live separately. [C1, C9] | Personnel owns supplied values and their provenance; lock supplied fields individually; consume subsequent updates. H§7 R11, §9 | Add a stable source link and synchronization contract. |
| Business Group | Legacy lifecycle defaults equate Business Group to company short code. [C4, C11] | Business Group, Company and Department are separate matching dimensions, sourced from Personnel. H§1, §9 | Resolve the master-data mapping before rules are seeded. |
| Case state | In progress / Completed / Cancelled; completion changes with applicable checklist steps. [C1, C3, C11] | Pending / Submitted / Cancelled; task completion and Personnel status are independent. H§4 | Separate submission state from progress, preserve historical records. |
| Checklist selection | One configurable onboarding step definition set, with laptop/carpark rules and phase locks. [C2–C4] | Many named checklists; five-dimensional matching; most-specific wins; oldest breaks ties; manual override including None. H§5.3, R2 | New templates, rules, owners and task instances. |
| Task assignment | Owner team is text on a step; module staff mark steps done; no per-task assignee/open/due dates. [C2, C4, C11] | Real groups/users; Manual or Round robin; approved-leave and workload checks; explicit failure/retry. H§5.2, R3 | New assignment engine and persistent assignment history. |
| Timing | Earlier applicable phase must finish before the next phase. [C3] | Opens on and Due by relative to join date; acknowledgement waits for recorded handover. H§7 R10 | Replace phase gating for new onboarding cases. |
| Equipment selection | Company access-system list and laptop/carpark flags; requisition gets common plus company provisioning rows. [C1, C4, C6] | Active catalogue matches BG/company/department/title; select matching entries or justified exceptions. One item per selected system/device/access entry. H§5.2, R1 | New onboarding catalogue and item provenance. |
| Catalogue | Existing hardware/software catalogue primarily serves separate employee asset requests. [C6, C11] | Onboarding catalogue includes systems, devices and facility access, rule matching, fulfilling team, mandatory workflow, retirement. H§5.6 | Extend through a defined contract or introduce a distinct onboarding catalogue; do not break employee requests. |
| Approval | Requisition-wide 0/1/2 levels by company; any authorized module manager can decide; requester cannot approve own record; L2 differs from L1. [C3, C7] | Each item resolves its own workflow; sequential/parallel group, routing or person steps; backup/manual/batched decisions; requester auto-approval logged. H§7 R4–R6 | New item approval executions. Intentional policy reversal. |
| Fulfilment | Pending / Done / N/A for provisioning checklist rows; approval gates completion and device issue. [C7] | Per-item To do / In progress / Ready, claims, Facility print → Group Tech activation, then handover. Pending-approval items not fulfilment-active. H§7 R7–R8 | New stage model and item authorization. |
| Progress | Done applicable steps / applicable steps. [C3] | Optional weighted equipment credit, deliberately reserving credit for handover. H§7 R9 | Shared progress projection across all screens. |
| Work queue | Lifecycle hub has “needs attention”; existing system inbox is approval-oriented and has no lifecycle kind. [C8, C12] | My tasks available without Onboarding page access, covering tasks, approval batches, team items, tags, HR notes, handover, pending cases and unassigned tasks. H§5.4 | Add a shared task projection with scoped inline actions. |
| Sensitive data | Staff case screen displays cost centre and combined IC/passport to module staff. [C5, C11] | Cost centre, IC and passport only visible to HR users, independently of module access. H§7 R11 | Split authorization and response projections, including notes/export/AI paths. |
| Notes | Case-level comments and per-step note text; no lifecycle mentions/read receipts in the queue. [C1, C2] | Task/requisition threads, mentions, automatic reply clearing, unread HR banner receipt, reminder window and confirming-person suggestion. H§5.2–5.5, R12 | Thread, mention and acknowledgement models. |
| Cancellation | Manager-only case cancellation changes the case; linked requisition stays open. Reopen returns in progress. [C1, C5] | Module user cancellation requires reason, cancels linked requisition and hides work; reopen pending; next submission creates new requisition. H§7 R14 | Atomic cancellation and preserved requisition generations. |
| Settings/access | Admin config with agent/manager company staff levels. [C6, C10] | Module access, group membership, checklist ownership and HR-sensitive access are independent. Master Admin grants module access. H§3 | Capability model and RLS changes; no blanket staff promotion. |
| Acknowledgement | Existing signed-in acknowledgement becomes available after laptop distribution step is ticked. [C13] | Becomes available after requisition Day 1 handover. H§7 R10 | Preserve existing form/privacy boundary and change its gate. |

**Correction to older documentation:** lifecycle-worklist.ts and ADR-0095 say there is no email transport. Current notifications.ts and notification-email-delivery.ts implement conditional managed SMTP delivery. Reuse that infrastructure; lifecycle recipient/event mapping and a digest still need implementing. Actual relay readiness, scheduler deployment and tenant policy are UNKNOWN until checked in the implementation environment. [C8, C14.]

## The target journey

1. **Personnel saves Draft.** Create or synchronize a joiner and one pending case. No employment is manufactured just to support onboarding. Identify the source by tenant and stable hire/draft identity, never by email alone.
2. **HR opens New Joiners.** Display Draft and recent Active hires, filters, counts, per-user NEW and current progress. Opening one clears only that user's NEW.
3. **HR prepares the case.** Show Personnel-supplied fields locked; permit missing fields and local onboarding details to be completed. Save incomplete input safely. Preview automatic/manual/no checklist.
4. **HR selects equipment.** Show only matching active catalogue choices; provide separate systems/devices Select all plus combined Select all matching. Extra active entries require reasons and show the effective approval policy.
5. **HR submits once.** “Submit case and confirm checklist” validates, confirms checklist, creates instances, assigns group work and creates the requisition and item workflows in one authoritative transaction.
6. **Approvers decide item requests.** Match workflows/routings, resolve approvers, apply sequential/parallel gates, batch compatible work and record actual decision actors.
7. **Teams prepare work.** Users act through My tasks even without page access. Starting a team item claims it; returning to To do releases it. Facility prints access card before Group Tech activates it and printer access.
8. **Group Tech hands over on Day 1.** After required readiness and approvals, record handover once, mark active items handed, complete requisition and unlock acknowledgement.
9. **Personnel activates the hire.** Attach the resulting person/employment to the same joiner and case; retain confirmed identity/history and the Active hire's checklist choice. Later due tasks continue.
10. **Changes remain traceable.** Case edits reconcile only case-managed selections/extras; removal withdraws pending approvals; cancellation ends current work; reopen/resubmit creates a new requisition generation. (H§5–§7.)

Recommended diagram for product and engineering review:

    Personnel Draft
        ↓
    New Joiner + Pending case
        ↓ HR Save / select catalogue / review checklist
    Submit case and confirm checklist
        ├── Confirmed task instances → assignment → My tasks
        └── Requisition items → item approvals → team preparation
                                                  ↓
                                    Facility print → Tech activate
                                                  ↓
                                          Day 1 handover
                                                  ↓
                                  Requisition completed + DAA unlocked
    Personnel Active ──→ same joiner/case; remaining dated tasks continue

## Screen plan

### New Joiners

Replace the current active/history-only list for new-model onboarding with the target list. Include name search; Business Group, Personnel status, case status and join-date range filters; totals for all, next seven days, overdue and no checklist; identity/position, BG, date/relative date, Personnel/case state, Automatic/Manual/None and progress. Provide progress breakdown, next step, due date and linked ticket on hover/focus. Display DD/MM/YYYY with accessible validation and auto slashes in inputs. Keep recent-Active retention configurable pending the source gap below. (H§5.1.)

### Joiner page

Use Employee, Hiring, IT/facilities, HR-only and Additional notes sections. Lock source-provided fields with the specified hint and visual treatment. Use separate IC and Passport values in the new model. Save pending details without submission-required-field validation; basic authorization, data type and size validation still applies.

Required on Submit: full name, join date, title, department, company, supervisor, hire/replacement selection, replacement name when applicable, email format when populated, reasons on extras and no stale nonmatching selected item. Employee ID is not a mandatory submission field in this reference.

Show checklist match explanation/tie warning, confirm override, preview and one combined submit action. After submit, show open/due/gate state, assignee, method, progress and threaded notes. Manual assignee selection can use any eligible directory user, not only members of the configured automatic-assignment group; it must still pass tenant/scope checks. Joiner and line-manager task controls are read-only on this page. Include equipment panel and ordered audit timeline. (H§5.2.)

### Checklist Management

“Owned by you” and “Other checklists”; all module users can edit within their authorized scope. Owner alone transfers ownership to a user with module access. Five multi-value dimensions; specificity/tie/duplicate/fallback warnings. Tasks support keyboard and pointer reorder, Completed by group/joiner/manager, manual/round-robin method, opens/due Day values and deletion, with autosave. Bulk method changes preserve task groups. Owner-only deletion and last-checklist/last-fallback protection follow the specific R16 over the broader §3 wording. (H§5.3, R2, R16.)

### My tasks

Add a universal page first under Manage with badge and counted filters: All, Assigned to me, Tagged, Team items, Overdue. Sort overdue first, then due date, with a stable ID tie-break.

Support checklist work, assigned and backup approval actions, per-requisition batches, manual Choose an approver, team items, handover, tags, HR note receipts, pending cases due seven days before joining, and unassigned tasks needing owner action when near due or assignment failed.

Use inline authorized detail/reply panels for users lacking full Onboarding access. Do not send Kevin or Nadia into protected pages or grant them Personnel access to make actions work. Existing approval inbox counts and mobile contracts must remain coherent without automatically expanding native app scope. (H§5.4.)

### Requisitions

List derived status, item readiness, pending approvals and unread HR notes. Detail includes People GBS banner/read receipt, unanswered-mention reminder, approval section, system/device/facility items, provenance/reasons/confirmation, item add/remove, notes, handover, timeline and case backlink.

Only the fulfilling team changes an item's operational state. Configured add groups, the item author and HR admins for HR-requested items receive the specific add/remove rights described in H§3, subject to R13. Starting work claims the item and locks peer controls. Catalogue additions show approval preview; “Confirmed by” is conversational provenance, not an approval decision. Default it from the latest replying confirming-group member only where that group can be identified. (H§5.5.)

### Settings and access

Onboarding settings order: equipment progress toggle (default on), systems, devices/facility catalogue, workflow/routing library, exception policy. Large panels start collapsed with summaries.

Catalogue entries have active state, four rules, fulfilment team, mandatory approval/workflow, match counts, retirement/restore and optional open-item flags. Show zero matches prominently. No Role profiles or duplicate automatic IT checklist task.

Workflow library has group/routing/person steps, manual/round robin, ordering and sequential/parallel mode when multiple steps exist. Routing has four single-value dimensions and Any fallback rows. Exceptions configure add groups, workflow/No approval, always require approval and reminder days.

Assignment groups have directory members, open-task limits, load/leave status, prefix-of-any-name-word search, alphabetical order and highlighted matches. Groups do not grant module access. Group deletion redirects tasks to a replacement or No group yet and changes unresolved task assignment to Manual.

Master Admin alone changes module-access toggles. The existing system-wide bell is the production notification surface for all eligible users; module menu visibility remains separate. (H§5.6–5.9, §9.)

## Exact rules to encode

| Rule | Implementation contract and observable result |
| --- | --- |
| R1 Catalogue matching | Active AND every populated BG/company/department/title dimension contains the joiner's ID. OR inside a dimension, AND across dimensions, empty is Any. Preserve a stale selection visibly until unticked; block submission. Offered-to counts exclude cancelled joiners. |
| R2 Checklist matching | Same matching pattern across department/grade/BG/company/employment type. Score number of populated dimensions, not number of values. Highest score; oldest checklist wins tie and warn. Manual selection, including None, overrides. Draft rematches; Active retains choice. Submitted-Draft reconciliation requires the explicit decision below. |
| R3 Task round robin | At submit, unassigned group tasks only. Exclude approved leave on task due date and members at limit. Fewest open group onboarding tasks across submitted noncancelled joiners, then least recent automatic assignment. Store failure reason; alert owners/editors; expose Assign an owner and retry/reassign actions. Do not apply task limits to approval workload. |
| R4 Approval precedence | Catalogue mandatory workflow always wins, including exceptions under No approval. Otherwise matched items need none. Otherwise exception workflow runs when selected or always-required; No approval skips only nonmandatory exceptions. |
| R5 Approval resolution | Group directly, routing most-specific row, or named person. Round robin excludes leave today, avoids requester where another eligible member exists, sorts pending group approvals, lifetime group assignments, then member order. Same group on one requisition resolves consistently. Routed group all on leave tries available default group; preserve fallback reason. No eligible member yields original/any-member state as specified, never a fabricated approval. |
| R6 Approval execution | Only current sequential step, or all open parallel steps, actionable. All approved approves item; any rejection rejects it. Assigned requester step auto-approves with audit. Group backups decide on behalf under their own identity or reassign. Manual steps must first be taken/assigned; same unassigned step propagates assignment across matching items. Batch compatible approvals by actor and requisition. Later leave never auto-reassigns. |
| R7 Operational state | Generic Tech: To do → In progress → Ready. Card Facility: To do → In progress → Printed; Tech: Printed → In progress → Ready. In progress claims; To do releases; handover marks active items Handed. Checklist has independent To do/In progress/Done and opening gate. |
| R8 Requisition state | Derive in order: Cancelled; Completed if active items handed and no pending approval; Awaiting approval if any nonremoved item pending; Ready for Day 1 if active items ready/handed; In progress if any active started; Submitted otherwise. Active excludes removed, rejected and awaiting-approval items. Use neutral Awaiting approval label. |
| R9 Progress | With count-equipment on and a requisition: (done tasks + equipment credit)/(tasks + 1). Equipment credit is 1 after handover, else ready count/(active count + 1). With setting off use done/tasks. Explain checklist/equipment separately. Unhanded equipment makes the joiner overdue by join date when counted. |
| R10 Timing | Day 1 = join date, negative Day values are before joining; opening day locks tasks; due day drives overdue; DAA waits for handover. Case due date = join date − 7 calendar days. Day 0/positive conversion edge must be explicit. |
| R11 Provenance/privacy | Personnel-supplied fields immutable in onboarding; unsupplied fields editable. HR alone receives cost centre/IC/passport. Enforce on server projections, actions and exports, not merely CSS. |
| R12 Mention reminders | Outstanding requisition tag becomes banner and overdue queue item when join date is within configured reminder window, default three days; tagged person's reply clears it. |
| R13 Removal | Requisition removes only outside-rules additions, before handover/completion. Soft-remove, withdraw pending steps/tasks and preserve audit. HR-requested item removal also updates case. Removing Ready logs revoke instruction. Case edits touch only case-managed items, including matched selections; preserve Tech additions. |
| R14 Cancellation | Required reason; cancel case and active requisition, mark items cancelled in UI, suppress all actionable queues and record history. Reopen pending; resubmit creates new requisition. Historical decisions and asset facts remain. |
| R15 Retirement | Inactive catalogue entries disappear from new offers. Optional flag on open requisition items; Keep providing acknowledges retention. Restore reactivates. Existing supplied assets are not silently revoked. |
| R16 Deletion | Used workflows and last workflow cannot be deleted. Groups can be deleted with task redirection. Owner-only checklist deletion; last and last fallback protected. Existing executions/history survive definition deletion. |

The two round-robin algorithms are deliberately different. Checklist assignment uses leave on the due date and task limits; approval assignment uses leave today, pending/lifetime approval counts and no limit. They must not share a single generic load query.

Numeric witnesses: 2 of 5 tasks done, 4 of 6 equipment ready = (2 + 4/7)/6 = 42.857%, shown 43%. Five of seven tasks plus handed equipment = 6/8 = 75%; equipment excluded = 5/7, shown 71%. (H§7 R9, §8 scenarios 15 and progress example.)

## Proposed domain design

This section is RECOMMENDATION, not an assertion that these tables already exist. Preserve one owner per business fact and expose the module through packs/lifecycle/service.ts.

| Owner | Proposed responsibility |
| --- | --- |
| Personnel draft / person / employment / assignment | Authoritative supplied personal/job facts and status. Draft remains a draft until normal activation. Stable joiner source survives draft deletion. |
| Joiner/source link | Tenant, stable hire identity, source draft ID, later person/employment IDs, Personnel state, source version and field provenance; safe projection rather than entire draft JSON. |
| Onboarding case | Pending/submitted/cancelled, local answers, case version, checklist override state, confirmation, submission actor/time, cancellation and source link. |
| Checklist definition/version + rules + task templates | Stable IDs, owner, creation order, matching dimensions, order, actor kind, assignment group/method, open/due offsets and gates. |
| Task instance | Case/submission/template version, status, assignee, planned dates, automatic-assignment history/failure and completion history. Runtime rows cannot be keyed by mutable array index. |
| Assignment group + ordered membership | Directory user references, limit, capabilities/context and auditable membership changes. Membership is not page or HR access. |
| Onboarding catalogue + rule rows | Type, fulfilment stages/team, active/retired state, mandatory workflow and stable master IDs. Keep employee asset-request catalogue contract intact. |
| Requisition + item | Case generation, display number, lifecycle version, handover/cancel; item catalogue identity, provenance, from-case ownership, actor/reason/confirmation, state/stage/claim, approval and removal/retirement markers. |
| Workflow version + routing version | Ordered step definitions, mode, ID-based rules and fallback. Definitions and executed approvals are different records. |
| Item approval execution + step | Snapshot of requested workflow, resolved group/user, manual/fallback state, requester, active step, actual decision actor/time, withdrawal and on-behalf audit. |
| Thread + note + mention + receipt | Task or requisition context, author, edits, explicit mention targets, resolution and per-user read state; no raw-name parsing as identity. |
| Settings + access + seen state | Module grants, HR-sensitive capability, exception/progress/reminder policy, per-user joiner-seen and note/notification receipts. |
| Existing asset service | Single owner of issued holder and return facts. New fulfilment calls its service when a physical asset is actually issued; no second inventory ledger. |
| Derived task/notification/progress views | Read authoritative domain state; no separate mutable completion truth for each screen. |

### Personnel integration

A Personnel draft currently contains captured input and a reserved Employee ID but no person/employment. Activation creates those through canonical writers and deletes the draft, with an employee-draft.completed event carrying employmentId. New onboarding must not create employment early or lose its link at activation. [C9.]

Subscribe through a pack facade/outbox or a narrowly defined in-transaction service seam; avoid importing pack internals into core Personnel writers. Use existing employee-draft.created/updated/completed/discarded events where suitable and handle later canonical Personnel changes. Event payloads carry IDs/versions, not copied draft data. For asynchronous delivery, ensure retry-safe materialization and a durable mapping before draft deletion; completed events alone cannot recover data from a deleted draft.

At submission, use the latest authorized Personnel projection and detect source/version changes. Blank job values may leave a new pending case incomplete; creation must still succeed. HR-added local fields must remain distinguishable from later source-supplied values. Do not write back to Personnel implicitly.

### Atomic commands and concurrency

- Sync: unique tenant/source-hire link and case; duplicate events/retries do not duplicate either.
- Submit: lock expected case version, validate, confirm checklist, create instances/requisition/items/approval executions and record events atomically. Duplicate clicks return the same result. One active requisition per case, multiple historical generations.
- Approval: validate actor, current step, group membership, case/requisition state and expected version inside transaction. Batch only currently actionable steps and recheck authorization; never skip a sequential stage through Approve all.
- Claim/release: conditional item-version update ensures two teammates cannot both claim. Scope and current actor checked server-side.
- Edit/remove: diff stable case-owned catalogue identities; add missing entries, soft-remove deleted ones, withdraw pending decisions; never erase Tech-owned additions. Preserve unrelated completed steps and decision history.
- Handover: atomic readiness/no-pending-approval check plus idempotent timestamp, item handed states, asset-service effects and DAA gate event.
- Cancel: cancel requisition generation and actionable tasks/approvals/mentions, suppress future dispatch, keep audit and physical asset facts.
- Reopen: keep prior requisition immutable as cancelled history; pending case prepares the next generation.
- Assign: serialize load selection/update enough to prevent concurrent submit from overshooting limits. Save assignment order/time and deterministic tie-breaks.

Authoritative mutations plus audit commit together. Task projections update immediately after commit; asynchronous bell/email delivery uses a durable cursor/outbox and deduplication. Do not make successful submission depend on SMTP availability.

### Authorization

Replace the single “is staff” test for new-model onboarding with separate capabilities: page access, case edit, checklist edit/ownership, settings/groups management, assigned task action, team fulfilment, configured item add/remove, workflow decision, module grant and HR-sensitive read. Tenant entitlement remains separate from per-user page access.

A task participant receives only its task detail and allowed actions. The ability to reply, claim, approve or be tagged must not permit arbitrary case reads, Personnel draft JSON reads, salary/statutory access or unrelated company data. Existing notification recipients are employment-based; resolve staff login to a legitimate recipient employment without using the not-yet-employed joiner as recipient. Support or explicitly resolve users with no usable recipient employment.

Enforce company scope at every read/write and service boundary, including assignment directory, exported CSV, notes/history, notifications and AI context. New task endpoints may use narrow policies/functions, but must not disable RLS or grant full case access as a workaround.

**Policy reversals selected by the request for exact parity:** new-model item steps follow R6 requester auto-approval rather than the old requisition no-self-approval policy; sequential workflows do not inherit an undocumented fixed L1/L2-distinct-person rule. Log automatic decisions and actual backup actors. Legacy requisitions retain their old policy unless separately migrated. Case cancellation follows R14 rather than ADR-0095's leave-requisition-open behavior. Record the new behavior in a scoped superseding ADR during implementation.

### Notifications and time

Use the platform's real Malaysia date helper and approved leave records, resolved by directory identity; never return another person's leave reason to explain availability. Distinguish leave on due date from leave today.

Register lifecycle events for sync, due within two days, overdue, needs owner, auto-assignment failure, mention and relevant assignments/decisions/handover. Resolve owners/editors without broadcasting sensitive case content tenant-wide. Per-user NEW and bell read state are independent. Reminder sweep stops when work is cancelled, done, removed, withdrawn or mentioned person replies.

Reuse the system-wide bell and managed email delivery with current tenant policy/recipient consent. Add daily 08:00 local digest, duplicate prevention, late-run handling and observable delivery results. Re-evaluate recipient eligibility before delivery. No automatic timed reassignment is part of parity: §11 explicitly says it does not happen. Schedule reminders, not invented escalation. Teams, ITSM, stock and purchasing connectors remain optional integration choices. (H§9–§11.)

## Implementation work packages

Every explicit handoff behavior remains required for parity. The following are dependency stages, not permission to ship a permanently reduced version.

| Stage | Work | Completion evidence |
| --- | --- | --- |
| 1. Contracts and source mapping | Resolve Business Group master and missing draft dimensions; define stable draft→employment handoff, actor/privacy mapping, disputed behavior decisions; record scoped ADR; prepare screen/role acceptance inventory. | Approved definitions/fixtures; every rule and scenario mapped; no unresolved owner for a required field. |
| 2. Domain and migration | Add new-model entities, versions, references, unique constraints, RLS/grants, module guards, event vocabulary and legacy version discriminator. Reserve migration number only when building. | Migration rehearsal against current and representative existing data; real RLS tests; old readers preserved. |
| 3. Configuration and rule engines | Checklist editor/matching, catalogue/rules, workflow/routing, exception settings, groups/access; implement two deterministic assignment algorithms. | R1–R6/R15–R16 behavior tests and realistic admin walkthrough. |
| 4. Personnel intake and case | Retry-safe sync, field provenance, New Joiners, pending save, matching selection/extras, confirmation, single submission and post-submit reconciliation. | Incomplete draft→case→submit→one requisition; activation retains case; scenarios 1–5 and 10–12. |
| 5. Approvals and fulfilment | Item execution, manual/backup/batch actions, claims, card stages, add/remove/retire, handover, DAA gate, derived status/progress. | Scenarios 6–13/15; multi-user stage and claim walkthrough; R4 priority cannot be bypassed. |
| 6. Shared work and collaboration | Universal My tasks, inline detail, threads/mentions, receipts, NEW/bell/reminders/digest; reuse existing inbox/SMTP contracts. | Kevin/Nadia/Raj without module access complete scoped actions; scenarios 14/16; delivery eligibility and cancellation tests. |
| 7. Migration rehearsal and complete parity review | Seed approved reference configuration, reconcile existing cases, complete cancellation/reopen, all 17 scenarios, adversarial cross-scope/privacy review, release checks. | Recorded journeys at realistic desktop/mobile sizes, state readback, complete scenario/rule matrix and appropriate release gate evidence. |

Suggested ownership seams for future implementation: lifecycle domain/configuration; Personnel integration; task/notification projections; UI; migrations/access. Create isolated build worktrees only when implementation starts; do not run parallel schema allocations or a release gate alongside builders.

No calendar estimate is justified until Stage 1 defines the source mapping, in-flight migration volume and unresolved behaviors. This is a multi-area workflow replacement, not a form-only patch.

## Migration and rollout

1. Inventory real existing lifecycle cases, linked requisitions/items, asset issues, approvals and acknowledgement records before allocating changes. This review did not read production data.
2. Use an explicit process version. Preserve legacy in-flight cases and their genuine evidence while enabling V3.1 for newly synchronized drafts. Display version clearly to staff where behavior differs.
3. Match legacy cases to Personnel only through reviewed stable references; never auto-merge by name/email. Report unmatched cases for review.
4. Convert configuration deliberately: old company provisioning lists are not automatically V3.1 catalogue entitlements; owner-team text is not a real assignment group; old company short codes are not a proven Business Group mapping.
5. Do not infer Handed from old Done or Completed: old completion lacks a handover event. Do not fabricate per-item approvals from a requisition-wide L1/L2 decision. A conversion needs explicit reviewed mappings and retained original records.
6. If live legacy cases must immediately adopt V3.1, prepare a case-by-case conversion preview covering item provenance, approvals, task completion, assets and missing handover evidence before applying it. This is a migration decision, not an automatic consequence of new schema.
7. Backfill only approved new-model drafts, retry safely, enable per tenant/company after configuration validation, then verify task/notification availability for non-module staff.
8. Rollback disables new intake/activation of the new process, preserves history and exposes existing new-model work safely. Never route new-model items back through legacy completion logic.
9. Preserve offboarding/returns/standalone/employee requests. Where shared tables gain new state values, scope constraints/readers by process kind/version and test all existing consumers.
10. Update ADR-0095 references and config/help copy only for the superseded onboarding decisions. Apply the repository's impact gate, migration rehearsal, experience review and release process during implementation.

**RECOMMENDATION:** phased intake with legacy in-flight continuity is safest. **DECISION REQUIRED before migration:** whether the business requires every live case to change immediately. Completion of implementation must state the chosen coverage; a phased rollout is not “every old case converted.”

## Acceptance and verification

### The handoff's 17 scenarios

These restate H§8 as implementation acceptance checks. Use its supplied personas/data but a controllable clock relative to fixture join/leave dates; do not freeze production “today” at 12 October 2026.

| # | Acceptance outcome |
| --- | --- |
| 1 | Haziq's Personnel-supplied fields locked; unsupplied Employee no., Supervisor and Cost centre editable for HR. Server rejects tampered writes to supplied fields. |
| 2 | Haziq sees M365, HR self-service, Power BI and VPN; Laptop/Desktop/Access card/Parking; no retired Locker or Construction-only Procore. |
| 3 | Missing Supervisor and hire/replacement selection block submission with named inline errors. Pending Save still works. |
| 4 | Daniel's Contract pack assigned to Sarah because Farid is on leave; Facility safety work unassigned because Nadia is on leave, with explanatory reason and owner alert. |
| 5 | Submit produces next unique IT-REQ number and one item per selection; access card starts with Facility. Repeated submit creates nothing extra. |
| 6 | Haziq VPN routes to Manufacturing Mei/Hafiz; other group member sees backup action. |
| 7 | Both routed members on leave causes default Tech BP Raj assignment, recording Manufacturing unavailable. |
| 8 | Two flagged items using same group resolve to Raj and one Approve 2 items task. |
| 9 | Manual VPN shows Choose approver to Mei/Hafiz; Mei assigns Hafiz; assigned and backup controls then reflect authority. |
| 10 | Nonmandatory AutoCAD exception with Send for approval unticked starts To do and retains exception provenance/reason. |
| 11 | Mandatory SAP uses its Standard workflow even with exceptions set to No approval; UI and server cannot bypass it. |
| 12 | Removing HR AutoCAD while CRM remains pending withdraws only AutoCAD approval and shrinks Raj's batch; Tech-added items untouched. |
| 13 | Kevin claims printer; Aina sees Kevin's ownership with locked control; ready item leaves actionable queues. Concurrent claims have one winner. |
| 14 | Raj's unanswered mention inside three-day window raises banner and overdue task; his reply clears them. |
| 15 | Jia Hui at five/seven completed tasks plus handed equipment displays 75%; disabling equipment displays 71%. |
| 16 | Kevin without module access updates assigned work and replies in inline My tasks; granting module access adds menu/page access separately. |
| 17 | Cancel submitted case with reason removes active queues and cancels requisition; reopen returns pending; resubmit has a different requisition number, preserving old history. |

### Additional outcomes needed for the production build

- Test every R1–R16 path, not only fixture examples: specificity/ties/None, real leave/load limits, reruns, no candidates, no route/default, manual and parallel execution, requester auto-approval, backup actor attribution, withdrawal, retirement/deletion and empty cases.
- Negative tests at service and real RLS boundaries: forged company/tenant, task ID substitution, unauthorized backup decision, stale group membership, arbitrary HR field read, hidden fields in RSC/JSON/export/notes/history/email/AI, and assignment to another tenant.
- Transaction tests: duplicate sync/submit/handover; cancel-versus-approve; edit-versus-claim; two claims; concurrent load assignment; failed batch atomicity; draft activation/delete/event lag; source changes during submission.
- Persist and reopen journeys for HR, Master Admin, Group Tech, Facility, approver, backup and staff without module access. Include empty/error/unassigned/overdue/retired/cancelled states.
- Verify DAA refuses before handover, succeeds for the legitimate joiner once and updates the task; a forged case/email selector cannot expose another person's data.
- Preserve existing tests in lifecycle.test.ts, lifecycle-rules.test.ts, lifecycle-worklist.test.ts, lifecycle-import.test.ts, lifecycle-i18n.test.ts and lifecycle-pack-drift.test.ts; add meaningful behavior coverage for the new model and update only intentionally superseded guards.
- Test existing Personnel activation, duplicate employee ID reservation, no early headcount/payroll appearance, existing approvals inbox, notifications and offboarding/return/asset issue/request journeys.
- Verify all six locale message contracts and actual rendered pages; keyboard task reorder, screen-reader names, date errors, hover/focus detail, 390px layout and realistic dense desktop tables.
- Notification tests distinguish queued, SMTP-accepted and read/acknowledged; cancelled/withdrawn work cannot trigger later mail. Scheduler replays do not duplicate digest or reminders.
- Record acceptance against actual local/test environment; verify deployed arrival/health separately only when release occurs.

Parity completion targets: all 17 scenarios and every applicable R1–R16 branch pass; no duplicate active case/requisition, unauthorized transition or sensitive-field disclosure in the required tests. These are release criteria, not invented adoption or time-saving forecasts. Measure actual case preparation time, unassigned work and Day 1 readiness after rollout to establish product baselines.

## Decisions and unresolved details

Specific rules have a clear implementation interpretation; the following items genuinely need evidence or a recorded decision. Recommendations here are proposals, not existing source behavior.

| Topic | Evidence / issue | Recommended resolution |
| --- | --- | --- |
| Business Group identity | New reference separates it from company. Main has company hierarchy and a business-unit master; no verified separate Personnel Business Group mapping in the inspected draft contract. | Confirm the canonical Personnel field and ID. If it is Business unit, expose that same owner with configured label; otherwise extend Personnel master/draft contract once. Never derive it silently from company short code. Architecture prerequisite. |
| Missing draft dimensions | Current draft employment schema has company/department/position/grade/type but not the handoff's full BG contract. Initial draft has minimal data. | Add only required canonical Personnel fields. Create pending case even while dimensions/date absent; validate at submit. |
| Draft activation and discard | Activation deletes draft; discard also deletes it. Handoff does not define how discarded drafts with submitted work behave. | Preserve source identity mapping on activation; define discard as a traced cancellation event for existing case/work, retaining audit. Confirm operational policy before enabling sync. |
| Personnel blank-field writeback | H§11 leaves it open. | Keep local onboarding values distinct; no implicit writeback. Use Personnel's own edit flow for canonical corrections. |
| Draft-but-submitted rematch | R2 rematches Draft; a Draft may already have a submitted/confirmed case. Template edits and task history migration are unspecified. | Keep versioned execution/history; present a reconciliation preview for submitted changes and require explicit reconfirmation for replacing work. Confirm this extension against prototype before implementation; automatic pending-case preview rematch and Active freeze are clear. |
| Personnel updates after submission | Join-date, company/job and catalogue/routing changes can invalidate timing/items/approvals. | Recalculate pending previews; flag submitted changes for an audited reconciliation, never erase prior decisions or work. Define due-date and approval rerouting rules before this path ships. |
| Day indexing | Day 1 and negative days clear; Day 0 is not defined. | Day N positive maps to join date + N − 1; negative maps to join date + N; reject Day 0 until agreed. Validate due/open order. |
| No tasks / no items | R8/R9 can be vacuous or divide by zero; all-rejected/removed and pending-only cases also ambiguous. | Specify explicit status/progress/handover outcomes; never label Completed through an empty every() result accidentally. Keep pending approval ahead of readiness. Confirm against runtime. |
| Routing ties/missing refs | Oldest rule applies to checklists only; routing tie/no-match, inactive/deleted workflow/group/person not fully specified. | Deterministic routing order plus visible validation; missing required approver remains unresolved, not silently approved. Agree tie-break and group-deletion behavior for workflow/routing references. |
| Shared groups and settings access | All module users edit shared settings/groups; this can alter approval authority and cross-company configuration. H§11 asks whether membership should be Master Admin-only. | Preserve explicit target rights within tenant/company scope and audit changes; show impact before edits. Any extra restriction is an explicit policy change, not silent implementation. Resolve shared-global scope for company-limited admins. |
| HR users and Master Admin mapping | The handoff names roles independently of page grants, without mapping to platform grants. | Map to existing platform authority; never infer HR from Onboarding access or People GBS membership alone. Define privacy for notes/provenance too. |
| Checkbox under No approval | H§5.2 says hidden, scenario 11/R4 says mandatory cannot be bypassed. | Show mandatory item's locked required state and own workflow; hide optional exception control only. Specific precedence resolves conflict. |
| Checklist deletion wording | §3 says any module user deletes; §5.3/R16 owner-only. | Follow specific owner-only rule and preserve execution history. |
| Requester auto-approval | Explicit R6 differs from current safeguards. | Implement and audit for new process as requested; document change prominently in new ADR. Do not propagate to legacy employee asset requests or other modules. |
| Approval changes/resubmission | Reasons for ordinary approval requests, rejection notifications and retry are open in H§11. | Preserve existing decision history; rejection is terminal for that item execution. Specify retry/re-add as a new audited execution if desired; do not invent automatic retry. |
| Repeated group steps | Same-group same-requisition consistency versus sequential repeated steps/manual assignment/batching is not fully specified. | Define consistency per execution and actionable step; batch never opens future steps. Test with explicit example before finalizing. |
| Catalogue duplicates and removal | Same selection can potentially appear as matched, HR extra and Tech addition; remove/re-add identity undefined. | Enforce one live requested catalogue identity per requisition with explicit provenance/ownership; re-add creates a new audit generation. Validate against desired prototype behavior. |
| Group deletion | Task reassignment defined; existing workflow/routing/exception references not. | Preserve historical resolved groups and mark future missing references unresolved; preview replacements. Do not leave dangling IDs or silently open approvals to everyone. |
| Note semantics | Reply clearing, remention/edit/delete, confirming group and when HR-note edits reset receipts not fully defined. | Explicit thread/mention links; acknowledge targeted outstanding mentions on reply; receipt tied to note revision; select confirmed-by from a known configured group only. Confirm policy. |
| Lost claimant | Leave/archived user/admin override for claimed fulfilment item unspecified. | Audited authorized release/reassign recovery, preserving original claim history; no automatic reassignment timer. |
| Employee and manager tasks | Read-only in admin; full employee view is excluded. | Bind to existing signed-in DAA and define actual completion source for manager/joiner tasks. Any external e-signature provider or public perimeter is a separate unresolved integration, not presumed available. |
| Recent Active / labels | Window and Employee no. vs Employee ID undecided. | Use platform Employee ID terminology; configure recent-Active window, proposed 30 days with outstanding work retained, subject to business decision. |
| Notifications versus prototype | Bell module-only in prototype but §9 requests system-wide; digest fake. | Use existing system-wide bell and real managed email integration; implement digest. No timed reassignment, per explicit §11 limitation. |
| In-flight migration | Source says nothing about our legacy records. | New-model intake plus legacy continuity; explicit reviewed conversion if immediate all-case migration required. |

These unresolved points do not invalidate the comparison or prevent the clear work packages from being designed. They do prevent an honest claim that an exact production implementation is fully specified today. Settle each at its dependency stage; no screen should hide an unresolved business rule behind an arbitrary default.

## Source file index

Code links below are relative to this report in the canonical main worktree. Line anchors identify the inspected implementation; line numbers may move during later work.

| Key | Evidence |
| --- | --- |
| C1 | [Case creation, updates, cancellation and reopening](../../core/lifecycle-cases.ts#L105), especially creation 105–147, edit 310–348, cancel/reopen 392–414. |
| C2 | [Checklist UI](../../app/lifecycle/_case-parts.tsx#L12) and [task mutations](../../core/lifecycle-cases.ts#L251). |
| C3 | [Applicability, phase gates, completion, progress and approval policy](../../core/lifecycle-rules.ts#L1). |
| C4 | [Reference defaults and team-text steps](../../core/lifecycle-defaults.ts#L23), provision rows 85–108 and company levels 143–145. |
| C5 | [Onboarding list](../../app/lifecycle/onboarding/page.tsx#L8), [manual new form](../../app/lifecycle/onboarding/new/page.tsx#L8), [case detail/privacy/edit/cancel](../../app/lifecycle/onboarding/[number]/page.tsx#L13). |
| C6 | [Configuration services](../../core/lifecycle-config.ts#L113), company config 275–302 and catalogue 389–434; [admin page tabs](../../app/admin/lifecycle/page.tsx#L16). |
| C7 | [Requisition creation, fulfilment and decisions](../../core/lifecycle-it.ts#L36), particularly 131–179 and 203–232; [requisition UI](../../app/lifecycle/requisitions/[number]/page.tsx#L12). |
| C8 | [Lifecycle attention worklist](../../core/lifecycle-worklist.ts#L1) and [hub](../../app/lifecycle/page.tsx#L9). |
| C9 | [Personnel draft identity and no-early-employee contract](../../core/employee-draft.ts#L1), draft CRUD events and activation 1275–1295; [draft dimensions](../../lib/employee-draft-schema.ts#L173). |
| C10 | [Company-scoped staff levels and transactional audit](../../core/lifecycle-base.ts#L1); [pack service facade](../../packs/lifecycle/service.ts#L1). |
| C11 | [Lifecycle schema](../../db/schema.ts#L9738), [migration constraints and RLS](../../db/migrations/0516_lifecycle_module.sql#L158); [historical architecture](../adr/0095-lifecycle-module-onboarding-offboarding-it-assets.md). |
| C12 | [Shared approval inbox kinds and behavior](../../core/approvals-inbox.ts#L1); [mobile tasks projection](../../app/api/mobile/v1/tasks/route.ts#L1). |
| C13 | [Existing safe acknowledgement service and laptop-distribution gate](../../core/lifecycle-self.ts#L1). |
| C14 | [Current notification channel contract](../../core/notifications.ts#L13); [managed email delivery](../../core/notification-email-delivery.ts#L11). |
| C15 | [Versioned attendance workflow patterns](../../core/attendance-workflow.ts#L59) and [system label master ownership](../../core/system-labels.ts#L1). These are reusable patterns, not a proven generic engine for onboarding. |

## Review result

The detailed comparison is supported by the supplied handoff and current main source. All 16 rules and 17 scenarios are mapped into the plan. No application tests, browser app walkthrough, production reads, board writes, deployment or implementation were performed for this planning-only request. Existing unrelated working-tree changes were left untouched.
