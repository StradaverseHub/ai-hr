# Contract tracker, virtual periods and mapped starting configuration

The Contract tracker starts from Personnel employment records, rather than requiring a legacy case to exist. It
retains the latest case for converted or ended employees, including an unfinished manual pay confirmation. A current
fixed-term period has one row; an older pay task remains linked when the new period starts. Historical cases remain
on their original identities and routes.

List authority is resolved as sets: actual HR company hierarchy, canonical People Ops/PBP authority with its legacy
opt-in, current administrative reporting lines and effective named Contract roles. The reader takes the shared Access
lock, filters and counts in SQL, and never reads each case through a per-row privileged subject function. Current
Payroll values are absent from tracker rows.

A View-only user can read a shaped virtual period without creating a case, event, task or job. See current pay is a
separate native permission. Opening a real case requires both View and Submit decisions, the current Personnel period
hash, a verified contract number and valid dates. The command locks the employment, preserves existing legacy WIP,
creates a real `fixed_term` carrier and admits the `caseOpened` event through the existing human kernel. Concurrent
opening returns the same case. The native yearly case-reference counter remains separate from Personnel's contract
ordinal; case references never infer or backfill a historical contract number.

Upcoming and Decision needed follow the reviewed prototype's earliest matching live before-end workflow date. The
projection uses the catalogue's available condition facts and Monday–Friday offsets, with an equivalence matrix
against the shared date owner. It does not assume a thirty-day reminder. A paused latest workflow does not schedule
a reminder. Rejected decisions can still need a new decision; expired dates and stalled in-progress cases are separate
attention metadata. Execution remains exclusively in the shared automation runtime.

Starting configuration is an explicit mapped action. The installer requires actual company settings authority plus
Contract workflow/template permissions, populated native groups and existing BP/CEO routings. It creates the handoff's
five documents, four currently used emails and twelve workflows as sealed units of the existing human-admitted
`contract_setup` job. Its recorded creator is the actual signed-in requester. Repeating installation never overwrites
an existing definition or consultant edit, and never applies Personnel or Payroll effects. Ordinary users cannot
admit it. Canonical groups alone do not initialize the Contract/V9 projection; missing native initialization produces
an explicit instruction for an authorized On/Off Boarding administrator, without borrowing that administrator's role.

Morning system admission is a separate, unimplemented security-boundary proposal. Automatic approval review rejected
the nullable-creator/kernel-owner extension under the general build authorization. The review artifact is
[the system-job proposal](../proposals/2026-11-17-contract-system-kernel.md); no fallback outside the kernel is implied.

Focused hosted evidence is separate from release evidence. The native tracker scope and 70-company/1,000-employment
checks passed at `317d0559568e207c8cdff5f55623b1b640636a57` in Actions `43941814613`. Retained-case/manual-pay projection
and human starting setup checks passed at `3b185122e6c1538afe6d485c5b1bae35d9af0dbe` in `43945029878`. The View-only
virtual-period/source-pay checks passed at `95b6c65513609679ce290aea4179d18e1a182109` in `43945981765`; its whole typecheck
was still running when this record was written. Subsequent scheduling/reference changes require their own exact
candidate evidence. No migration installation, merge or release is asserted by this decision record.
