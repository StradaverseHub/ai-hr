# Employee Change Requests: field policy and approval

Approved cf588903 uses the existing **System Settings → Employee Change Requests** policy store.
A group administrator saves the policy; scoped HR can review it without changing tenant-wide rights.
Employees and managers cannot configure it.

The screen follows the eleven Personnel tabs and shared field names. Applicable fields offer
**Editable** or **View Only**. Protected information is not offered as an employee input. Salary,
assignments, statutory determinations, operational settings, photo/files and other specialist workflows
retain their canonical owners; a field policy cannot turn them into generic employee writes.

View Only keeps an authorized own value visible while preventing edits. Both the server mutation and
approval recheck the current policy under the same transaction lock. Closing a requested field rejects
waiting requests with the configured reason, without applying a master change or deleting their history.
The policy save and withdrawal happen in one transaction.

Compatibility matters. Legacy `all` is the previous request set, not permission for newly added fields.
Old arrays govern REQUESTS only: legacy `[]` means no requests, retaining the previous finite direct
phone/personal-email and current-primary emergency-contact course. A newly saved complete policy is
`{version:2,fields:[...]}` in the same setting. Its empty list denies all edits, including those direct
rights; explicit View Only closes them. New fields remain View Only until enabled. Primary-only
compatibility is limited to five old fields on the exact current primary record, never another record,
a new record, priority or new fields. A changed/ambiguous primary refuses rather than retargeting a save.

Approval remains **single-level**: either any authorized scoped HR administrator or only a group
administrator. A manager is not a configurable approver for these master record changes. The existing
master record/RLS owners do not grant managers this write authority. Nobody may approve their own
request, including an administrator. The setting can narrow authority; it cannot widen data visibility.

The Personnel profile-change queue shows current and requested values separately, with the exact register record's
current name where applicable. Approval rechecks the original record ID, current values, active choices,
field policy and canonical owner validations. A missing/archived or stale record must be reviewed and
resubmitted; it is never replaced with another primary/highest record. Rejection requires a reason.

Implementation verification is pending: source inventory and parser checks do not prove runtime
permissions, transactions, concurrency, actual UI, locale rendering or release readiness.

## Three-state employee disclosure and named HR routing

The next policy generation uses the same `ess.profile_change_fields` owner:
`{version:3,fields:{<descriptorId>:"editable"|"viewOnly"|"hide"},primaryOnly:[<descriptorId>]}`.
The complete matrix must contain exactly one supported permission for each employee-visible descriptor.
Specialist fields can be hidden or viewed, never promoted to an ordinary employee edit. Checkbox drafts
may be incomplete, but Save refuses them. Select-all affects only supported permissions. The separate
finite `primaryOnly` list carries old emergency-contact rights through an unchanged save; selecting a
new permission deliberately closes that compatibility right for the row.

Hide removes values before the own-profile client boundary: scalar values, register fields, CAS
baselines, choices, repeated summary facts, name-part and derived age/service aliases, comparison records and own
request lines. Private decision text is withheld when an original request has hidden lines. Legacy
address reconciliation is withheld when the canonical permanent address is hidden. Initial workspace,
facts and own history use one policy snapshot; independently invoked actions read the current policy.
Administrator Personnel projections and separately issued documents keep their existing owners.

`ess.profile_photo_edit` is an independent boolean, initially false. The own-photo course permits upload
or replacement for the authenticated person's selected eligible employment. It validates actual PNG/JPEG
magic bytes and a maximum of 2 MB, then composes the existing person-photo owner and audit event in one
transaction. A narrow own INSERT/UPDATE policy does not grant deletion, arbitrary person edits or
attendance photograph authority. Hiding the profile photo also closes its own-profile display/course.

Named routes are stored as a bounded revisioned value under `ess.profile_change_routing`. Rules reuse
the canonical effective-date organisation criteria, with optional direct employment selection as an
additional restriction. The picker uses the same organisation vocabulary; no Employee Group master is
invented. The coverage preview reports unmatched, overlapping and ineligible assignments. A named
principal must be one active login linked to a stable active employment, already holding HR authority
covering the subject's company hierarchy. Existing group-only profile approval restrictions still apply.
Designation creates no role grant and self-approval remains forbidden.

Enabling named routing requires named resolution for each new approval request. There is no fallback
to any administrator for missing, overlapping or unauthorized routes. Enabling is one-way through this
course; subsequent changes edit the rules and explicitly reassign outstanding requests. Each request
freezes its rule, configuration revision, principal, employment and organisation-context fingerprint.
Decision rechecks current criteria, identity, active status, authority and context. A changed route or
placement requires explicit group-administrator reassignment with a reason. That reason and the old/new
identities remain in private request history; public events contain routing metadata without proposal
values or the private reason. An immediate edit and approval request in the same submission roll back
together if route resolution fails.

The queue belongs at `/admin/personnel/profile-changes`. Queue rows, details, counts and decisions share
the assigned-route authorization; broad Personnel access is not an alternate approval route. The group
administrator's reassignment picker exposes identities and status only, not another assignee's proposal.
Legacy category/hash links and posted actions resolve to the new queue. Ordinary requester links still
lead to the read-only directory. Employee decision notifications remain unchanged; assigned pending
work uses the existing task owner and links to the new queue. Privacy erasure retains a scoped,
write-only redaction course for proposals, reasons and private route history without adding approval
or proposal-read authority.

These source contracts require runtime verification, including RLS, concurrency, transaction rollback,
image behavior, saved settings, browser payloads, all locales, mobile/keyboard behavior, migrations and
release checks. Source preparation alone does not establish those outcomes.
