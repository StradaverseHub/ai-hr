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

## Verification and rollout

The unshipped Home migration is `0577`; do not alter an applied migration or consume another
session's reserved numbers. A changed migration requires a new named fictional database/receipt,
not replaying an edited hash into an earlier acceptance database. Preserve the original database as
comparison evidence. Rehearse the actual populated baseline as well as the complete fresh journal.

Verify real ordinary/scoped/group/foreign/revoked actors, two employments, current relationship
changes, immutable versions and membership, stale and duplicate acknowledgements, safe downloads,
notice lifecycle/search/filtering, explicit greeting send and cancellation, opt-outs, six languages,
mobile/keyboard operation, independent failures and bounded timings. Inspect actual rendered screens
and logs before the final gate. The complete Home requirement matrix remains open wherever these
outcomes have not been demonstrated.
