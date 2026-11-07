# Read Roster payroll protection once per employment and complete date set

Source review found that Duty Roster called the same native Payroll protection
reader once for every employee/date cell. That native owner locks and reads the
same relevant payroll batches, policies and coverage for an employment on every
call. The existing owner already accepts a complete date array and applies its
canonical attendance cutoff owner to every date. No new financial implementation
or database model is required for this particular repeated-read cost.

Validate all original dates and pass each employment's sorted unique complete
set to that existing owner once. It retains each existing Attendance then OT-source
day row lock in date order, then obtains the same native Payroll batch locks and
returns the union of covered batches. Duty's closed-period refusal and processed
recalculation remain in the original all-or-none transaction; no confirmation,
subject population, audit contents or SQL batching limit changes. Returned batch
iteration follows the native batch order, instead of first-covered-date encounter
order; this changes no membership or financial/audit fact. No lock is removed and
no larger command capacity is claimed.

Hosted qualification must observe actual native SQL on all three real 1460-cell
assign/rest/copy modes: four employments should issue four protection reads, rather
than 1460. Existing row/value/summary/manual-audit, repeat update, late-chunk actual
SQL refusal and full rollback controls remain. A native two-period populated
Payroll fixture independently compares old per-date union against the existing
complete-date owner, verifies exact processed marks/events and a late closed-period
refusal with unchanged persisted rows, batch flags and audits. Existing native
scope, Duty and dependency interleaving cases remain required.

The former capacity note incorrectly grouped overtime-day protection with advisory
keys. The canonical day helper locks existing Attendance/OT rows and explicitly
acquires no advisory lock or row creation. Subject/configuration advisory locks,
existing row locks and time/memory are separate resource dimensions. Whole-command
admission still needs measured installation envelopes and participating-writer
coordination. Neither this source change nor 1000-row statements establishes it.

Status: source prepared, independent review and hosted checks pending. Production held.
