# Architecture and performance remediation

Scope: the completed 16 November 2026 assessment, revalidated per fix against current main. This is the consolidated disposition ledger; an implementation is not a verified improvement until its native and staging evidence is recorded. Production is outside this task.

Initial integration base: `59f06b08db014e01cd553a827c62ccf864d33f78`. Preserve the original audit IDs and verification requirements. No finding is closed by source inspection alone.

## Delivery order

1. Read-lock contention: AP-033, AP-058 (preview), then AP-061 subject locking qualification.
2. SQL projections and paging: AP-045, AP-001–AP-021, AP-026–AP-030, AP-036–AP-040, AP-049–AP-053, AP-056, AP-060.
3. Durable bulk work and atomic publication: AP-022–AP-025, AP-028, AP-031, AP-034–AP-035, AP-043–AP-048, AP-054–AP-059.
4. Remaining ordering, history and coverage gaps: all remaining open findings, including AP-041 and AP-042. Dependencies and measured contention determine ordering within each wave.

## Batch 1: Cost Allocation preview and Payroll confirmation projections

- AP-058 partial: a distinct preview lock joins shared Access and the existing workforce barrier. Confirm retains its original exclusive locks, fingerprint comparison, all-or-nothing compensation and audit. Remaining synchronous Cost Allocation/Bank reversals and per-item inspection work remain open.
- AP-045 partial: Close, Reset and Remove use the effective-history header and exact SQL joined count, preserving RLS, module gating and the history barrier. Reprocess selection still needs its own paged contract.
- Proof authored: shared-reader overlap, writer lock retention, previous-reader equivalence across every native role and group/company scopes, 70-company / 1,000-employment shapes, history-writer wait and count freshness, payload reduction. Hosted and staging results are pending.
- AP-033 is confirmed in the installed staging definition (owner ai_hr_owner). Staging watermark read: 881 migrations, maximum 1793330005466. Direct and staging-proxied production watermark reads timed out; append-only SQL admission remains pending a fresh production ledger check. No migration or production change is included in batch 1.

## Consolidated dispositions

| ID | Priority | Screen or concern | State |
|---|---|---|---|
| AP-001 | P1 | Personnel Movement New and Edit | Open; implementation pending |
| AP-002 | P1 | Personnel profile and Movement manager choices | Open; implementation pending |
| AP-003 | P1 | New Lifecycle Requisition | Open; implementation pending |
| AP-004 | P2 | Probation Tracker | Open; implementation pending |
| AP-005 | P1 | Generate Letters all-company request queue | Open; implementation pending |
| AP-006 | P1 | AI Centre Payroll Audit loop | Open; implementation pending |
| AP-007 | P1 | Approvals leave queue | Open; implementation pending |
| AP-008 | P1 | Personnel employee draft editor | Open; implementation pending |
| AP-009 | P1 | Personnel Import entry screen | Open; implementation pending |
| AP-010 | P2 | Personnel Profile Changes | Open; implementation pending |
| AP-011 | P1 | Attendance Offline Clocking settings | Open; implementation pending |
| AP-012 | P2 | Attendance Company Policy Settings | Open; implementation pending |
| AP-013 | P2 | Attendance Schedule Clock Policy editor | Open; implementation pending |
| AP-014 | P2 | Attendance Work Schedule and Overtime Rates | Open; implementation pending |
| AP-015 | P1 | Payroll Process wizard and Individual Transactions | Open; implementation pending |
| AP-016 | P1 | Payroll Settings full readiness report | Open; implementation pending |
| AP-017 | P1 | Contract Management Intake Settings and Workflows | Open; implementation pending |
| AP-018 | P1 | Loans listing | Open; implementation pending |
| AP-019 | P2 | Claims Configuration and employee claim choices | Open; implementation pending |
| AP-020 | P2 | Leave Approval Workflow and readout | Open; implementation pending |
| AP-021 | P2 | Rewards shared policy history | Open; implementation pending |
| AP-022 | P1 | EA PCB2II and CP22 batch PDF generation | Open; implementation pending |
| AP-023 | P1 | Shift Card Pay Item Fixed Transaction and standalone Cost Allocation imports | Open; implementation pending |
| AP-024 | P1 | Income Tax Recalculation Confirm and Continue | Open; implementation pending |
| AP-025 | P2 | Statutory Adjustment Save and Revert | Open; implementation pending |
| AP-026 | P1 | Shared employee selection and selected-subject guards | Open; implementation pending |
| AP-027 | P2 | Leave Inquiry and balance detail hydration | Open; implementation pending |
| AP-028 | P1 | Approvals Bulk Approve and Reject | Open; implementation pending |
| AP-029 | P1 | Onboarding and Offboarding V9 workspace | Open; implementation pending |
| AP-030 | P1 | Security Center Users directory | Open; implementation pending |
| AP-031 | P2 | Probation Tracker CSV export | Open; implementation pending |
| AP-032 | P2 | Attendance Overtime Pattern detail and version history | Open; implementation pending |
| AP-033 | P1 | AI Centre Find Reviews metadata lists | Installed exclusive read lock confirmed; migration admission pending fresh production watermark |
| AP-034 | P1 | System Labels Grades and Profile Options grid saves | Open; implementation pending |
| AP-035 | P2 | Grades and Profile Options partial grid saves | Open; implementation pending |
| AP-036 | P2 | Attendance Individual Day historical formula results | Open; implementation pending |
| AP-037 | P1 | Native mobile Tasks Claims and Payslips lists | Open; implementation pending |
| AP-038 | P1 | Staging bulk worker release compatibility | Resolved externally in audit; verify worker arrival on each release |
| AP-039 | P1 | Probation Intake workspace | Open; implementation pending |
| AP-040 | P1 | Employee Master report builder Preview and Export | Open; implementation pending |
| AP-041 | P1 | Whole-system architecture and performance acceptance coverage | Open; implementation pending |
| AP-042 | P2 | HR Analytics carry-forward table paging | Open; implementation pending |
| AP-043 | P1 | HR Analytics and legacy Custom Report export controls | Open; implementation pending |
| AP-044 | P1 | Data Privacy and Audit Integrity screen | Open; implementation pending |
| AP-045 | P1 | Payroll run row-menu Close Reset Remove and Reprocess screens | Batch 1 partially implemented; hosted and staging verification pending; remainder open |
| AP-046 | P1 | Performance cycle Open control | Open; implementation pending |
| AP-047 | P1 | Performance administrative Generate Build Fill and Import controls | Open; implementation pending |
| AP-048 | P1 | Performance Results Release and Revoke bulk controls | Open; implementation pending |
| AP-049 | P1 | Performance Home Workspace and Calibration lists | Open; implementation pending |
| AP-050 | P2 | Performance full Calibration detail and locked Talent Box roster | Open; implementation pending |
| AP-051 | P1 | AI Centre Performance analysis source | Open; implementation pending |
| AP-052 | P1 | Rewards Analytics filters and downloads | Open; implementation pending |
| AP-053 | P1 | Rewards Approvals Board and All Reviews | Open; implementation pending |
| AP-054 | P1 | Shared Rewards Configuration Create Reviews control | Open; implementation pending |
| AP-055 | P1 | Rewards Post to Payroll control | Open; implementation pending |
| AP-056 | P1 | Rewards Data Centre Refresh Sources Preview and Confirm | Open; implementation pending |
| AP-057 | P1 | Rewards Uploaded Awards Save and Replace controls | Open; implementation pending |
| AP-058 | P1 | Import History Bank Statutory and Cost Allocation Revert controls | Batch 1 partially implemented; hosted and staging verification pending; remainder open |
| AP-059 | P1 | Employee Leave Balances and Employee Leave Records exports | Open; implementation pending |
| AP-060 | P1 | My Team weekly/monthly grid and its export | Open; implementation pending |
| AP-061 | P2 | My Team single-item review and decision commands | Open; implementation pending |

## Completion evidence required

For each batch retain exact source/controller/base identities, hosted test and compiler results, migration ownership/watermarks where applicable, and staging source/build/worker arrival. Compare authorization, ordered rows and counts before measuring query work, transferred data and latency under mixed load. Render the affected controls and verify failure, revocation and stale-review paths with authorized fixtures. Keep failed results and partial coverage visible; 60 open assessment findings are not 60 measured latency regressions.
