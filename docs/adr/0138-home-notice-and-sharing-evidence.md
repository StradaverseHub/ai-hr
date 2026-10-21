# ADR-0138: Bind Home disclosures and notice actions to retained evidence

**Status:** Accepted implementation direction; implementation and acceptance remain incomplete
**Date:** 2026-10-21
**Deciders:** Codex within the approved Employee Home plan

## Context

The approved Home item `d4989b16-09e5-4fb9-ac55-0b1b1034f9aa` includes scoped HR notices,
pinning, categories, attachments, explicit acknowledgement, minimal team visibility and celebration
opt-outs. These are required outcomes. A working presentation component or a test count does not
establish that they have been delivered.

FACT: Notice Board already owns publication, the employment audience snapshot, viewing, popup
dismissal and the notification event. Published content can currently be edited. Its administrator
RLS checks tenant and administrator role without a recorded notice company boundary. A read-only
production aggregate on this date found one published notice and no archived notices. No notice
body or employee detail was retrieved for that audit.

FACT: middleware replaces `x-pathname` with the actual pathname and the root layout already reads
it. The personal Home can omit the popup reader specifically at `/`; a new client-supplied path
claim or a hidden modal containing preloaded notice bodies is unnecessary.

## Decision

Extend the existing owners. Notice is the announcement; a retained content revision is the exact
content against which a human action was recorded; Notice Recipient is publication membership.
Viewing, popup dismissal and explicit acknowledgement remain separate facts.

1. Record a stable notice owner company, or group ownership. A company administrator can author
   only inside actual current company authority. Group ownership requires actual group authority.
   The ownership boundary does not move when a recipient transfers. Existing notices without
   recorded company ownership remain group-owned; do not invent historical ownership from today's
   employee placement. Preserve their content, publication dates and audience.
2. Resolve the audience through the existing org-criteria owner and enforce the notice's ownership
   boundary at publication. Retain the publication snapshot. A content edit cannot silently add or
   remove recipients. A changed audience requires an explicitly published new notice.
3. Retain immutable content revisions at publication and on subsequent content changes. Revision
   identity includes the content and attachment references used by the reader. Category and pinning
   are presentation metadata; changing only their order does not manufacture new acknowledgement.
   Requiring acknowledgement after publication is a new content requirement and receives a revision.
4. Retaining an existing published notice during migration records its current content at rollout.
   Label this origin and retention time. It cannot reconstruct earlier edited content, name an
   unrecorded editor, backdate an action or create historical acknowledgements.
5. An acknowledgement names the retained revision, snapshotted recipient employment, actual login
   and server time. Only that recipient can act. Repeat submissions return the same receipt. An old
   page cannot acknowledge newer content. Passive opening or dismissing a popup cannot create an
   acknowledgement. Preserve receipts after expiry, withdrawal, content changes and transfers.
6. Keep private attachment bytes behind notice ownership and current recipient/content checks.
   Do not expand a Knowledge Base document's audience merely because a notice links to it. List and
   Home reads return bounded metadata, never attachment bytes. Bound size, filenames and media types;
   recheck access at download and use safe response headers. Published revision references survive edits.
7. Home reads live recipients through the Notice owner, with pinned/newest/stable-identity ordering,
   a minimal summary, true unread and acknowledgement state, and a path to the full searchable board.
   Counts cannot be inferred from a truncated list. Required acknowledgements remain visible in Home
   and assigned work; skipping the Home popup does not satisfy them or mark them viewed.
8. Resolve team sharing against explicit company policy and current reporting/department facts.
   Return only the permitted person's display identity and evidenced public status. Do not reuse a
   broader Personnel/My Team projection or create a Manager context for an ordinary employee.
   Unknown presence remains unknown, and medical reasons and salary never enter this projection.
9. Celebration disclosure is person-grained and respects separately saved birthday and anniversary
   opt-outs on every peer read. Share only the permitted month/day occurrence and anniversary count;
   do not return a birth year. A greeting opens as editable text and sends only after explicit Send.
   The existing notification owner rechecks the current recipient and deduplicates delivery.
10. Display preferences stay in the existing own-account dashboard preference owner. Language stays
    with the existing UI locale owner. Display timezone and week start cannot change Attendance's
    business date, Payroll's run identity, company scope or any business record.

Notice projection and email revalidation share the existing notification registry. A fresh actual group
administrator may run complete global web projection. A company-scoped or user-less APP call cannot
consume a partial global event stream: it leaves the global cursor untouched. Assessment-only scoped
projection retains its separate cursor contract. A database trigger also rejects old APP callers that
try to advance the global cursor without complete current authority during rollout.

The installed sweep uses its existing explicit maintenance connection. Authenticate SESSION_USER and
its explicit effective SET ROLE, excluding an intervening definer's current_user. Respect FORCE RLS
when relying on table ownership. Inside one transaction, read a tenant-fenced bounded event batch and
immutable Notice recipient IDs, then SET LOCAL ROLE ai_hr_app for every canonical recipient resolver,
notification insert and outbox operation. Restore the authenticated role only to write the cursor. A
failure rolls back the business writes and cursor together; no generic owner-write callback is exposed.

Email revalidation receives a separate sealed read-only capability from that authenticated connection.
It returns only tenant-bound Notice recipient IDs and an exact Notice source event's required metadata.
Recheck connection authority on every read; a human context, APP connection, downgraded connection or
cloned capability cannot use it. Missing source/audience authority is an error, not ineligibility: retain
queued delivery for the authorized sweep. No system GUC privilege exception or additional sender exists.

Required Notice acknowledgement work is a live projection in the existing assigned-work inbox, across
actual own recipient employments. Its identity binds Notice, employment and content version; completion
comes only from the current version's immutable acknowledgement. Reading, popup dismissal, publication
notification delivery and expiry do not create a receipt. Withdrawal or expiry removes current work;
retained receipts remain. No separate task row or action-severity publication notification duplicates
this state. The task links to its exact own-employment reader. The source timestamp is the Notice's
recorded update time; an expiry date is not fabricated into a workflow due date. The legacy approval
workbench and native v1 approval-only UUID/kind contract explicitly exclude this new web task kind.

The framework's proxy/middleware clone budget must cover the application multipart budget plus an
excess-byte witness. A10MiB file remains the service limit; the bounded reader allows64KiB for multipart
overhead and the framework clones one further byte. Thus an otherwise valid maximum-size file is not
silently truncated, while a lying over-budget stream can still be positively refused before parsing.
These shared technical constants live in a leaf module; build configuration never imports a DB service.

An attachment upload may stage immutable private bytes without changing published content. The editor
saves the selected attachment IDs together with its text under the displayed content-version check.
An upload intent is bound to the author and Notice, and a retry must name the same bytes. Staged files
are not visible to recipients. Download checks current live membership and current selected references;
HR may still inspect retained historical attachments under the immutable Notice authoring boundary.
Receipts have physical tenant/parent/revision/recipient relationships and a deferred event foreign key,
so committing acknowledgement evidence without its event is impossible through an interrupted command.

## Personal greeting decisions

The deterministic self greeting uses the account's saved display timezone for time of day and
birthday month/day, with the platform timezone as its default. Employment anniversaries and leave
stay on the existing Kuala Lumpur business-date owner. Use recorded preferred name, then given name,
then the complete recorded legal name; never split a name to guess its given part. A missing name
leaves the personal sentence absent. February 29 does not acquire an invented February 28 or March 1
birthday. HR's enabled-template priority resolves simultaneous events, with stable event ordering
for ties. Birth date/year and leave reasons are not transported.

A return greeting needs today's canonical scheduled work classification, no approved leave today,
and approved full-day leave on the preceding scheduled work date. The reader checks through at most
fourteen intervening dates, including ordinary rest days and actual holidays. If that positive evidence
cannot be established within the bound, use the ordinary greeting; this does not assert attendance or
an employee's return. It never creates a clock capture, leave state or notification.

## Personal landing admission

The default employee/manager landing returns before the legacy first-employment read, which includes
compensation, as well as before legacy aggregates and assistant composition. The selected salary-free
Home identity determines the manager-workbench affordance. Its selected-company role uses the existing
SQL grant/subtree predicates, because the flattened role list loses company scope. Its link retains that selected employment;
an explicit workbench request must repeat the same own-identity and real management-authority proof.
An organizational manager on a second employment is not replaced by the first employment. A real
manager role without an own employment retains its separately authorized legacy workbench. Admin
workbench composition keeps its existing service-level permissions.

## Personal calendar projection

Month, week and list are views over the same selected own employment and complete calendar weeks
(at most 42 dates per month). Leave supplies approved and pending presence through its existing
child-date versus whole-span distinction. Pending presence does not relieve an attendance absence.
The canonical holiday and retained replacement owners supply holiday dates; tentative holidays stay
explicitly tentative. Payroll supplies only recorded run dates with actual own result membership and
no stale calculation. A recorded payday never asserts that a bank payment occurred.

The transport contains dates, statuses and holiday labels, never leave reasons, medical facts,
private types, payroll amounts, bank details or peer records. Team sharing requires its separate
explicit policy and minimal disclosure owner; this own-calendar slice does not establish team
calendar acceptance or introduce a WFH workflow. Calendar reads never allocate a replacement holiday.

Employment, leave, holiday and payroll civil dates retain their owners' business meaning. The saved
display timezone determines the current-date outline and initial month, not a shift of those civil
dates. Week start follows the existing account preference (Monday by default). Full-calendar month
navigation records the selected employment and month using Next's supported native History API so
reload and back navigation retain the period.

An empty covered day may open the existing Leave form with the selected employment and date. This
is permission to open that form, not an approval or a promise that a request will pass its policies.
Home must not invent a prohibition on past dates: Leave owns configurable backdating, notice,
blackouts, overlap, eligibility and balance validation at submission.

## Verification and rollout

The unshipped Home migration is `0582` (moved from its unapplied `0577` allocation so Feedback
Automation can release first); the shared current-principal proof is owned once by Security in `0576`.
Do not alter an applied migration or consume another
session's reserved numbers. A changed migration requires a new named fictional database/receipt,
not replaying an edited hash into an earlier acceptance database. Preserve the original database as
comparison evidence. Rehearse the actual populated baseline as well as the complete fresh journal.

Verify real ordinary/scoped/group/foreign/revoked actors, two employments, current relationship
changes, immutable versions and membership, stale and duplicate acknowledgements, safe downloads,
notice lifecycle/search/filtering, explicit greeting send and cancellation, opt-outs, six languages,
mobile/keyboard operation, independent failures and bounded timings. Inspect actual rendered screens
and logs before the final gate. The complete Home requirement matrix remains open wherever these
outcomes have not been demonstrated.
