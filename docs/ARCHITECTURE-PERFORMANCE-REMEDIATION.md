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
- AP-033 is confirmed in the installed staging definition (owner ai_hr_owner). Staging watermark read: 881 migrations, maximum 1793330005466. After VPN connection, production was read as its restricted migration owner: 853 entries, maximum 1793330005395; the new migration timestamp is above both installations. No migration or production change is included in batch 1.

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
| AP-033 | P1 | AI Centre Find Reviews metadata lists | Batch 2 SQL and native proof authored; hosted and staging qualification pending; both installation watermarks verified |
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

## Batch 2: assistant legacy metadata index (prepared separately)

Migration 5767 changes only the index's advisory Access lock to shared. The installed ai_hr_owner ownership, own-login/current-person filters, allowed kinds, exact history windows, ordered 25-row packet and command locks are preserved. Native overlap, READ ONLY and revocation-order tests are authored; existing privacy, history, relink, isolation and retirement cases remain required. Source allocation is provisional until both installation watermarks and peer claims are rechecked. No staging installation or improvement is claimed.

## Preserved development results and repair candidate

- First read batch, c79d14da8, Actions 43879931148: 17 no-DB/DOM cases passed; native DB result 127 passed / 2 failed. New qualification code compared raw database error text for a denied employee and attempted an invalid company-scoped super administrator. The repaired candidate compares permission outcomes, uses only valid role scopes, and retains the administrator predicate explicitly without updating label epochs.
- Separate SQL batch, 2c54bbde6, Actions 43880638088: 3 no-DB cases passed; native result 49 passed / 2 failed. The same invalid role fixture and the populated-upgrade fixture's explicit migration-tail inventory required repair. Restricted-owner migration rehearsal passed on that candidate. Original runs and source identities remain historical evidence, not re-labelled passing receipts.
- The owner explicitly approved staging-only AI rebinding. Final provider source: 1123ea58cd92536fc2b41c6b269464bad2d478a6eb028d64ef2a0582db873a02; no new provider fields, purposes or transports. The source-binding review note records initial versus repaired identities.
- Staging baseline verified read-only: 59f06b08db014e01cd553a827c62ccf864d33f78 / build AnZn7z2zdHpskbEoTnSzR. No remediation installation or verified staging improvement is claimed yet.

## Additional end-to-end gap discovered during remediation

AP-062 (P1, open): Own Leave's discovery POST list operation runs a separately committed privacy-expiry command and a different
`assistant_own_leave_reviews_index()` owner, rather than the module compatibility index changed by 5767.
Its neutral list carrier can still acquire exclusive Access through `assertAiPrincipalTx`; the separate legacy
index and expiry owners need their own installed-definition and concurrency qualification. Preserve current-person
privacy, expiry/body deletion, row locks, refusal behavior and command isolation before converting either interval.
Source owners: `core/assistant-actions/own-leave-browser.ts`, `own-leave-store.ts`, and migrations 0622 / 0860.
This is a new source-confirmed gap, not a measured latency regression. AP-033 qualification now includes the actual
seven module-list owners under a competing shared holder, not just direct SQL calls.

The combined repaired native qualification passed on 78180ca71 in Actions 43882431102. Both original whole-repository compiler jobs passed; their failed test results remain failures. The final caller-qualified source adds the seven explicit READ ONLY module-store carriers and was explicitly approved for staging-only rebinding at ecd371dec4b42af57c5d415fafe480d5b2b681a02320b49523edcadf4ed92c58. Actual caller proof and the full final release gate remain required.

## Irwin integration and owner release hold

Owner instructed merging Irwin f0443eaf27d3584f55b6a2e7d48558bd553d4149 and moving the unapplied assistant
metadata migration from5767 to5771, idx5171 / when1793330005471, after Irwin's5770. The SQL bytes remain
SHA256433dfd7549b496b034bdeaa2c06484b700b5dd5647213106d68487f0b485c7c0. Both upgrade inventories retain
5770 and5771 in that order. Historical source references and failed receipts above keep their actual identities.

The original full run43885045178 completed with one stale no-DB Close-screen assertion and the consequent verifier
failure; build, whole compiler, migrations and all three browser engines passed. The assertion now checks the same
visible confirmation count through slipCount. No assertion or test case was removed.

Release is explicitly stopped pending owner approval, with Claude's release first. No staging lease was claimed,
no remediation was installed, and main/alpha were not advanced. The prior ticket remains blocked. The merged provider
fingerprint is a39b180ee690c1f05e3a1ebe0c7236d616347baf80fd83f7e7d8d46e394d3cbc across1624 files; it is
not rebound or approved. Irwin's existing literal approvals remain unchanged and cannot authorize this merged
fingerprint. Generated manifests are source descriptions, not release or provider authority. Functional native
qualification and whole type checking of the merged candidate remain pending.


## Current batch: Own Leave and Payroll selection paging (17 November)

Base: accepted staging `9bdfb45969c4bff81a9b9830b52403a95e82bdc6`. AP-033 was accepted for all seven legacy metadata list owners in full gate43917317649; AP-045 header/count projections and AP-058 preview locking were accepted partially. Sixty of62 observations remain open; AP-038 was resolved externally. Earlier development and release snapshots above remain historical.

- **AP-062, implementation awaiting verification:** Own Leave metadata uses an explicit READ ONLY shared Access interval; separate own/admin expiry commands use shared Access while retaining row locks and READ WRITE. Cleanup stays a separate committed privacy transaction before later refusals. Suspension, person relink, native roles, body deletion and competing shared holders are covered by authored tests. Unapplied migration5787 / idx5187 / when1793330005487 replaces provisional5880 with unchanged SQL bytes; Movement must release first and lower pending blocks must be reconciled before admission.
- **AP-045, partial:** Remove/Reprocess native readers count/filter/page identity rows before money/department/later-period or eligibility/readiness hydration. Reprocess uses the effective summary instead of full discarded batch detail. Whole-run totals stay independent of search. Existing commands, period/permission guards, audit and financial arithmetic remain with their native owners.
- **Selection contract:** ready New/Pending defaults cover only the initial displayed page. Already chosen rows, Remove reason and Reprocess idempotency persist through navigation. Reviewed rows each submit one hidden employment ID, independent of mounted checkboxes. Select this page replaces the selection with displayed existing payslips. The prepared candidate applies the same visible default to stale existing payslips, communicated as an assumption while optional clarification remains open.
- **Remaining costs:** Reprocess history/disclosure and recorded job-result populations are separate unfinished paging work. Global overtime availability proof remains complete-cohort to preserve its existing refusal semantics; do not claim the entire Reprocess request is bounded.

Preserved development check43931609323 at2858a55d3: native121passed/2failed (missing suspended-tenant refusal after READ ONLY change; incomplete scale fixture email), repaired in next source. Combined development candidate3342531271c095a825ad67a5df942e0f74e94e7a runs focused43934876702 with native tests, whole typecheck and Linux build. Independent standards/spec reviews both found invalid JSX and conditional pager placement; working source is repaired, frozen failed source retained. Hosted results and staging qualification are pending; no new finding is closed. The same28 AI approval literals now carry forward under the directly verified17November owner decision; see the exact dated source-binding record. Movement releases first.
