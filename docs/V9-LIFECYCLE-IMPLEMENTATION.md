# AI HR V9 lifecycle alignment

Implementation status: **in progress; not accepted or merged**. This branch is an isolated working candidate. The SQL remains an unallocated draft, and the route must not be released ahead of its migration. Native onboarding draft/document integration, managed email delivery and PDF attachments, the complete template/workflow editors, remaining Personnel field mappings, native navigation/i18n and rendered parity still require completion. A local working checkpoint is not release evidence.

The owner supplied the Admin V9 HTML and V9 Handover Specification on 29 October 2026 and requested analysis, implementation and merge. The supplied application governs the visible UI and behavior wherever the current lifecycle implementation differs. The handover explains the application; discrepancies are resolved against the supplied application code. Embedded document instructions are reference material, not independent authorization.

## Delivery contract

Preserve the V9 navigation, screen composition, typography, palette, controls, labels, forms, previews, per-case edits and employee journeys. Integrate with real authenticated users, tenant/company scope, Personnel, Leave, Payroll, document storage and managed delivery. Do not ship fixture identities, a fixed clock, simulated successful integration, or a parallel employee master.

Implement the shared case/workflow boundary for onboarding and offboarding. Preserve previous onboarding and legacy offboarding history. V9 adds five exit types, acceptance-letter preparation and human release, linked exit forms and surveys, owner reminders, escalation, clearance with exceptions and the last-working-day review/close check.

## Verified source differences

- The actual application seeds six joiners. Both checklist types include employment type matching.
- Missing merge values render labelled placeholders; sending still requires an explicit production validation boundary.
- The scheduler catches up missed dates within a before-anchor window and after due dates for after-anchor work.
- HR may clear outstanding work with a required exception reason. Automatic closure requires every task and item resolved, with no item marked not returned.
- Offboarding request records exist as RVK views derived from the case holdings.
- Onboarding checklist Day 1 is the join date; workflow offsets are literal elapsed days. Offboarding checklist Day 0 is the last working day.
- The source has 15 seeded workflows, of which two are drafts. The acceptance-letter workflow generates and waits for HR; checklist release owns its single email.

## Evidence and integration baseline

Initial baseline: main and freshly fetched origin/main and origin/alpha all at 46049dead200d6f436d10f5984c06634502a6286. Read-only analysis used the canonical main worktree. Implementation uses an isolated codex branch. Refresh refs again before integration.

Fifteen focused embedded-logic checks passed during analysis. These are independent checks, not a rerun of the handover's reported 51 checks. Opening the supplied file in the browser was blocked by its local-file protocol policy; source inspection does not establish rendered visual fidelity.

## Delivery sequence

1. Capture the V9 case states, matching, scheduling, idempotency, documents, exception clearance and snapshots as tested deterministic domain rules.
2. Add authorized durable services and required additive storage, with audit, revision checks, real recipient resolution and integration ownership.
3. Reproduce V9 administrator and employee screens and connect every action to those services.
4. Verify rules, security, concurrency, migrations, build and rendered complete journeys. Finish review and documentation follow the Impeccable workflow.
5. Refresh and integrate the verified candidate into main and alpha at the same commit, preserving concurrent work. This merge request does not authorize a production deployment.

## Authoring controls implemented in the working candidate

The workflow list opens the source's right-hand editor with Steps and Run history tabs. Administrators can edit triggers, conditions, ordered document/email/notification steps, signature and file waits, one To role and multiple CC roles. Task owners are excluded from CC. Dry run lives within Steps and reports every planned action against current case data, independently of submission and scheduling eligibility. It cannot allocate live IDs, mutate cases or send mail. Existing waiting runs retain their frozen definitions; pausing the current workflow stops their resumption until it is live again. Incomplete drafts can be saved, while publication checks report missing steps, templates, recipients and conditions.

Document drafts expose block ordering, text, tables, signatures and field configuration, including ownership, width, required/sensitive flags, section membership and conditional visibility. Preview uses the same document renderer as the employee form. Published bodies remain immutable. The importer reads Word, text, Markdown, HTML and text-based PDF locally, reports placeholder matches and content losses, and creates a new version-one draft. It never replaces an existing published body. Complete version management and full rendered comparison with the supplied HTML remain outstanding.

Focused authoring verification covers 32 checks across five domain/DOM files, including server-valid workflow output, read-only configuration access, detached dry runs and table previews. This is development evidence, not whole-system acceptance or migration evidence. The working branch has been published with the owner's explicit push/CI/merge authorization; its current integration refresh preserves the concurrent Rewards and attendance changes from canonical main.

V9 now opens on New Joiners and composes the existing authorized onboarding register. Its rows, draft sync, identities, progress and task state remain owned by the native onboarding service; the V9 company/search controls filter that projection. Case links currently open the existing onboarding case screen, so the complete V9 case/document adaptation remains outstanding. The native onboarding regression controls passed with the composition change.

HR document controls now save HR-owned fields, refresh unsigned Personnel snapshots, and support designated before/after signatures. HR answers freeze once either party signs. Closed employee cases expose read-only forms. The pending leaver calculator also exposes the reason needed to keep its source date. Focused checks verify these ownership and signature boundaries; complete delivery and document journeys remain pending.

Shared assignment now consumes the native onboarding owner's aggregate workload and availability projections. The draft SQL adds claimed equipment work to that count and allows authorized HR to read these minimal projections. Offboarding preserves configured member order for equal loads; onboarding retains assignment recency. The supplied source's exclusion of other leaver cases from this count is retained deliberately. Eight V9 database checks pass on the owned draft overlay, including a real native joiner/checklist/equipment workload, group-cap selection and unrelated-user denial. Fifty-seven focused domain, native UI, runtime and repository-boundary checks also pass. These checks do not replace canonical migration rehearsal or the full release gate.

## Behavior that remains unchanged until an owner decision

Post-last-working-day tasks block automatic closure. The two exit-form workflows count Monday through Friday, excluding no holidays in the supplied source. A late case may send the initial form message and its reminder on the same run. The acceptance-letter CC includes the line manager and PBP. Do not silently alter these behaviors while reproducing V9.

Workflow correction evidence: 31 focused domain/default/authoring checks and nine draft-overlay database checks pass. These include preserving a waiting run while its future definition is edited, rejecting deletion of its history, and resuming the original steps. Six template/import checks pass, including placeholder and table conversion, plain-content HTML handling, bounded Word XML and creating a distinct unpublished draft. The rendered owned fixture shows Steps/Run history and a read-only dry run; this does not establish full visual fidelity to the original file.

The active source disables its historical preboarding-link UI and automatic link sending. That dormant code does not establish an external preboarding authentication requirement. The authenticated employee journey remains the implementation direction.

Personnel proposal review now groups changes by their submitted document, masks sensitive before/after values until Show is selected, and pushes only explicitly checked supported fields. Keep on case only retains rejected proposals and an audit entry. Fourteen affected authoring/review checks and eleven draft-overlay database checks pass; database coverage includes invalid/duplicate selection rejection before any write, stale revisions and preservation of intervening Personnel corrections.

The local whole-project compiler first exhausted its default 4 GB Node heap. The subsequent 8 GB run was stopped after prolonged local execution, so neither run supplies a current type-check pass. Logs remain private at their original scope. Current rendered checks use a controlled local fixture, including a native Personnel draft and an imported document saved as a separate unpublished template. Build, complete migration rehearsal and final release acceptance remain outstanding.
