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

Both approval queues show current and requested values separately, with the exact register record's
current name where applicable. Approval rechecks the original record ID, current values, active choices,
field policy and canonical owner validations. A missing/archived or stale record must be reviewed and
resubmitted; it is never replaced with another primary/highest record. Rejection requires a reason.

Implementation verification is pending: source inventory and parser checks do not prove runtime
permissions, transactions, concurrency, actual UI, locale rendering or release readiness.
