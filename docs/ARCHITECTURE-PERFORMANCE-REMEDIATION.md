# Architecture and performance remediation

Current status,17November: the first batch was accepted on staging at9bdfb4596; AP-033 is closed and AP-038 was resolved externally. Sixty observations remain open. Own Leave/Payroll selection paging is development-qualified and held before its next staging release. Query batches3–9 are development-qualified with retained affected-area evidence; batch9 private-count SQL remains an unallocated proposal. Accepted Movement is preserved by current main/alpha2a4132204. Recruitment is the next release by owner order; migration5787 remains unchanged and unapplied, awaiting allocation above Recruitment's actual accepted watermark and fresh claim checks. The5780 proposal was never confirmed. Final source integration, exact approved binding, authenticated release gates and staging acceptance remain separate requirements. No new finding is closed. Earlier prepared/held snapshots below are historical.

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
| AP-001 | P1 | Personnel Movement New and Edit | Batch8 development-qualified: native destination choices; staging/native-plan/mixed-load acceptance pending |
| AP-002 | P1 | Personnel profile and Movement manager choices | Batch9 development-qualified: native25-row Workforce search/count, selected hydration and all five consumers; actual RR/RO/no-exclusive carrier and native/DOM/whole compiler/Linux build proved; staging/native cost and mixed-load acceptance pending |
| AP-003 | P1 | New Lifecycle Requisition | Open; implementation pending |
| AP-004 | P2 | Probation Tracker | Open; implementation pending |
| AP-005 | P1 | Generate Letters all-company request queue | Batch4 development-qualified: global SQL page/count and request-template correlation; staging pending |
| AP-006 | P1 | AI Centre Payroll Audit loop | Batch3 implemented: atomic native access-event chunks; development-qualified; staging pending |
| AP-007 | P1 | Approvals leave queue | Batch3 implemented: native date-packet and per-manager queue batches; development-qualified; staging pending |
| AP-008 | P1 | Personnel employee draft editor | Batch5 development-qualified: native Criteria/reference metadata reuse; staging pending |
| AP-009 | P1 | Personnel Import entry screen | Batch5 development-qualified: native catalogue reuse; staging pending |
| AP-010 | P2 | Personnel Profile Changes | Open; implementation pending |
| AP-011 | P1 | Attendance Offline Clocking settings | Batch9 development-qualified unallocated proposal: private grouped context count, one context scan across70 companies, native roles/null/storage/owner/hostile-membership proofs; allocation, prerequisite admission, full prefix gate and staging acceptance pending |
| AP-012 | P2 | Attendance Company Policy Settings | Open; implementation pending |
| AP-013 | P2 | Attendance Schedule Clock Policy editor | Open; implementation pending |
| AP-014 | P2 | Attendance Work Schedule and Overtime Rates | Open; implementation pending |
| AP-015 | P1 | Payroll Process wizard and Individual Transactions | Batch3 implemented: scoped cycle catalogue batch; development-qualified, staging pending |
| AP-016 | P1 | Payroll Settings full readiness report | Open; implementation pending |
| AP-017 | P1 | Contract Management Intake Settings and Workflows | Open; implementation pending |
| AP-018 | P1 | Loans listing | Open; implementation pending |
| AP-019 | P2 | Claims Configuration and employee claim choices | Open; implementation pending |
| AP-020 | P2 | Leave Approval Workflow and readout | Batch7 development-qualified: native policy catalogue batch; staging pending |
| AP-021 | P2 | Rewards shared policy history | Open; implementation pending |
| AP-022 | P1 | EA PCB2II and CP22 batch PDF generation | Open; implementation pending |
| AP-023 | P1 | Shift Card Pay Item Fixed Transaction and standalone Cost Allocation imports | Open; implementation pending |
| AP-024 | P1 | Income Tax Recalculation Confirm and Continue | Open; implementation pending |
| AP-025 | P2 | Statutory Adjustment Save and Revert | Open; implementation pending |
| AP-026 | P1 | Shared employee selection and selected-subject guards | Batches10–12 readers development checked; Batch13 Unicode native correctness passes but cost is NOT QUALIFIED (full streams,50k spill and4.23s company body). Scope filtering/SQL matching, other runtimes, table/ranked/metadata/report readers and staging acceptance stay open |
| AP-027 | P2 | Leave Inquiry and balance detail hydration | Open; implementation pending |
| AP-028 | P1 | Approvals Bulk Approve and Reject | Open; implementation pending |
| AP-029 | P1 | Onboarding and Offboarding V9 workspace | Open; implementation pending |
| AP-030 | P1 | Security Center Users directory | Open; implementation pending |
| AP-031 | P2 | Probation Tracker CSV export | Open; implementation pending |
| AP-032 | P2 | Attendance Overtime Pattern detail and version history | Open; implementation pending |
| AP-033 | P1 | AI Centre Find Reviews metadata lists | Closed: seven legacy metadata list owners qualified and accepted on staging in the first batch; Own Leave AP-062 remains separate |
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
| AP-045 | P1 | Payroll run row-menu Close Reset Remove and Reprocess screens | Partial installed header/count projection; batch2 selection paging development-qualified, staging pending; history costs remain open |
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
| AP-058 | P1 | Import History Bank Statutory and Cost Allocation Revert controls | Partial installed shared preview; rendered preview fixture pending; durable reversals/per-item inspection remain open |
| AP-059 | P1 | Employee Leave Balances and Employee Leave Records exports | Open; implementation pending |
| AP-060 | P1 | My Team weekly/monthly grid and its export | Open; implementation pending |
| AP-061 | P2 | My Team single-item review and decision commands | Open; implementation pending |

| AP-062 | P1 | Own Leave assistant review discovery | Batch2 development-qualified shared metadata/expiry intervals; migration5787 and staging acceptance pending |

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

Preserved development check43931609323 at2858a55d3: native121passed/2failed (missing suspended-tenant refusal after READ ONLY change; incomplete scale fixture email), repaired in next source. Combined development candidate3342531271c095a825ad67a5df942e0f74e94e7a runs focused43934876702 with native tests, whole typecheck and Linux build. Independent standards/spec reviews both found invalid JSX and conditional pager placement; working source is repaired, frozen failed source retained. Development qualification is now complete: repaired run43935883124 passed368selected cases, whole typecheck and Linux build; final application source6350cacc0 passed105affected cases, whole typecheck and Linux build in43937314461. Allocation/binding source38339d5f5 passed114affected cases in43939945809. Original failures remain preserved. The final release gate awaits Movement’s accepted baseline; staging qualification is pending and no new finding is closed. The same28 AI approval literals now carry forward under the directly verified17November owner decision; see the exact dated source-binding record. Movement releases first.


## Remaining work: batched request concerns

The owner asked to continue building the remaining gaps before release. The next owned source continues from prepared05bac05a6 and preserves main/alpha47d956a77's owner-confirmed statutory wording through a normal merge. Shared integration refs and staging remain untouched; Movement releases first. No migration is required by this batch.

AP-006 now writes exactly one access event per required company through the existing append-only/hash-chain owner in bounded INSERT chunks within one transaction. Any required-event failure rolls back the complete new batch and prevents the view from returning. A native qualification found a related existing failure: granted auditors may INSERT an unsubjected access event but may not SELECT it via RETURNING. Single and batch audit owners now use preallocated event UUIDs, retaining native write policy and keeping those event rows unreadable to the auditor; no read permission is granted. Read-only/no-login exceptions and agent refusal remain explicit.

AP-007 reads the displayed Leave-date packets once, preserving ordinary empty packets versus per-date controls, native RLS and date order. The manager queue union retains the legacy200-per-manager bound and input-manager/time ordering. AP-026's six Attendance/Fixed Transaction action guards now query exact legacy membership instead of reading names, emails and organization columns for every employee. Empty-scope and canonical-string semantics are retained; all commands still adjudicate through their native services. Directory pickers remain a separate open part ofAP-026.

AP-015 reads the already scoped Payroll Cycle catalogues once, preserving active/archive rules, company order and narrowed resumed-draft scope. Run-type gates, saved defaults, labels and financial behavior remain unchanged. Group-scale fixtures cover70 companies/1,000employments, every native role, exact ordered rows, actual transaction/statement traces, concurrent event writes, rollback across chunk boundaries and committed privacy change while a read waits for Access.

Original development run43995516324 at51923f859 has120unit/source cases passed and1failed (the old source test required the per-request loader),82native cases passed and1failed (auditor RETURNING path). Both are preserved; the source assertion and native event identity owner are repaired in working source. Independent review identified missing concurrency/hidden-person tests and pending ledger states; those are now authored/updated. Compiler/build results and repaired hosted qualification remain pending. No new finding is closed before staged acceptance.


Batch3 development qualification completed at `edffc689e73d35badfe1bc484aa65e0c7d333a53`: [43998539528](https://github.com/StradaverseHub/ai-hr/actions/runs/43998539528) passed92selected cases, whole-repository typecheck and Linux build. Preserved run43997209374 also exposed an Individual import consumer still treating the new cycle Map as an array, plus an invalid native reporting-line fixture enum; both are repaired. Earlier failures remain part of the evidence. These are development results, not release or staging acceptance.

## Batch4: Generate Letters request queue

AP-005 replaces per-company request transactions and in-memory flatten/sort with one globally ordered native SQL page/count. Permission admission covers every requested company; a denied company refuses the whole packet. Native request-subject and published-template disclosure remains after the selected page identities. Standard25/50/100/200/All choices use the shared2000-row ceiling with an explicit continuation message. Decline retains page context, request identity, private reason, employee message and native version check. The original single-company reader and every command owner remain unchanged.

Qualification is in progress:70 companies/1000 employments/3000requests, native template approval/requestable lifecycle, every role/group and company scope, ordered legacy equivalence, exact totals, bounded All/out-of-range pages, shared read-only transaction, rendered controls and decline redirects. No migration, integration-ref change or staging release is included. All60open observations retain their original IDs and acceptance requirements.


## Batch5: Personnel label fanout

AP-008 reuses already authorized active catalogue Criteria to construct the draft wizard's exact company CSV stamps through the shared label-scope predicate. AP-009 derives company-specific workbook choices from the existing authorized catalogue rows, loading Business Units once. This removes four company-by-company readers from each request without redefining label availability, archive rules, code/label formatting, company defaulting or import validation. Global and explicitly assigned availability remain independent of creation company. Existing complete catalogue payloads are still required by these forms; no pagination or payload-size improvement is claimed. Native70-company/1000-employment qualification and hosted checks are pending. No migration or staging change.

Independent Batch5 spec review found a lost archived-BU cascade relationship. One bounded native read now loads Criteria only for departments' referenced BU identities, including archived or picker-scope-omitted roots; these roots are not added to selectable options. The qualification creates an active department, archives its linked BU through the native owner, and asserts the legacy Criteria and actual cascade-filter result. Original frozen qualification remains preserved.


## Batch6: Offline Clocking settings

AP-011 replaces210company-level reader transactions with one group read under shared Access and READ ONLY. Policy defaults/validation share the existing decoder; settings-edit authority, correction authority and the actor-private context-count definer remain separate native owners. Missing storage/function yields null counts; an installed empty population yields zero. Context counts deliberately retain the existing per-company definer in one SQL packet because direct context-table reads would disclose the wrong population. No new definer or migration is added; its internal plan/latency still needs qualification, so one transaction alone is not a measured speed claim. Deployment eligibility and empty scope behavior stay with the page's existing owners. Native70-company/1000-employment, every-role/group/company, real signed held claim/context, and optional-storage absence coverage is authored; hosted and staging verification remain pending.

Batch4's first repaired native run44005754693 exposed a pre-existing shared lookup defect: the single-table staff projection left its outer template ID unqualified inside a correlated SQL subquery. PostgreSQL could bind it to the inner template row, returning an unrelated published version and breaking Prepare letter. The shared projection now explicitly qualifies the request's template ID. Every returned version is independently checked against its canonically created template/version pair, in addition to reader equivalence. Native template RLS and command validation remain unchanged. The original failing evidence is retained.

Preserved Batch5 run44004359509 passed195selected cases and Linux build; whole typecheck found generic inference errors in the new multi-catalogue test. Explicit union-row generic arguments repair the fixture without changing application behavior. The archived-BU source repair and combined qualification remain separate evidence from that original run.


## Batch7: Leave escalation settings

AP-020 loads escalation policy metadata once for the company choices already authorized by Leave Approval Workflow and its readout. The singleton reader and group reader share the existing default/target-role decoder; unconfigured, unknown and RLS-invisible companies retain the same defaults. Input company order and native UUID aliases remain supported. The new reader is idempotent, READ ONLY and uses shared Access. Policy writers, approval matching, escalation timing and the nightly sweep remain unchanged. Native70-company/1000-employment, every-role/group/company and actual readout qualification is authored; hosted and staging evidence is pending. No migration or staging change.


## Batch8: Movement destination organization choices

AP-001's destination fanout remains present in freshly fetched accepted Movement source2a4132204; acceptance of that feature is not evidence that this older performance gap was removed. The owned repair replaces the69additional destination transactions at70 companies with one native catalogue read. Shared/Global/explicit Criteria and each company's native visibility remain authoritative, locations retain their own company/admin owner, and display-label disambiguation happens after per-company narrowing. The current-company form reuses its original scoped options. Commands, destination authorization and the separate full Workforce manager-picker gapAP-002 remain unchanged. Native70-company/1000-employment, every-role/group/company, invisible/unknown/foreign scopes and duplicate-caption fixtures are authored; hosted qualification and later integration with accepted Movement remain pending. No migration or staging change.


Combined application source1b74b8ca9 passed Linux build in44006495617. Native Letters/Personnel fixtures passed onfaf2c4a8e in44007073271 after complete native archive commands repaired the fixtures; the same final source passed whole typecheck in44007752994. Offline group/role/absence and malformed-decoder cases passed in the combined run. Application bytes were unchanged by these later test/doc repairs. Original failed workflows remain failed, with their valid compiler/build portions retained separately. Batch7 source055d3581c passed93selected cases, whole typecheck and Linux build in44008297446. These are development witnesses, not a release gate or staging acceptance.


Batch8 source01a2eca7911d2f5f8420e3c4ae990d5c23113c69 passed48selected cases, whole typecheck and Linux build in44011411911. Independent review caught an invalid tenant-wide location-code fixture; distinct native codes preserve the real constraint. Original dispatch44011181356 remains failed for a nonexistent selected test path, with its successful compiler/build evidence retained independently. The native helper oracle uses70transactions before and1after; the page reuses its current-company read and changes69additional destination transactions to1. Staging/native-plan/mixed-load acceptance and integration with the actual accepted release baseline remain pending. No new finding is closed.


## Batch 9: full Workforce pickers and private offline counts

Development qualification is complete at `05dfb1f879caa49ee54c07cf28035b664ce2b6a1`. AP-002 and AP-011 remain open until installation and acceptance. The private-count SQL remains deliberately outside the migration journal; this is not a release-ready candidate. Main/alpha were refreshed at06:00UTC on17November and both remain `2a4132204`. The owned chain preserves qualified batch8 source `e53fbe8ed` (its base divergence was31/31); final baseline integration is still required. Recruitment remains next by owner order. No staging, production, shared release ref, queue or lease changed.

AP-002 uses the exact thin native `access_workforce_picker_facts` authority. Self and all non-NULL terminations remain excluded; undefined company scope means all native-visible companies and an explicit empty scope means none. Destination scope narrows the native call before projection. SQL counts and orders the complete cohort, returns25 rows and hydrates at most8 selected facts independently of the search/page. The new native search is a case-insensitive literal substring over the displayed code/name label or UUID; raw input travels in a bounded same-origin POST body. Full formatted-label, Unicode and literal wildcard cases are covered. The native owner still examines thin cohort facts to count; this is not a claim that database work becomes constant or that staging latency improved.

Direct Superior retains its already-disclosed relationship; Delegation remains nonempty. Movement resets temporary manager choices on every scope change and restores the saved after-manager, including roundtrips without an intermediate choice. Explicit clears and submitted IDs are tested. Correct Hire retains changed-fields-only submission and review labels; Rehire retains its original default/destination behavior. No application consumer calls the full Workforce picker anymore. Generic employment pickers remain AP-026 under their separate authorization owner.

AP-011's proposed `mobile_offline_open_context_counts(uuid[])` groups private contexts once behind a narrow NOLOGIN/NOINHERIT/NOBYPASSRLS role. It receives only necessary columns and tenant RLS; the function first checks each company's existing settings authority. Application callers receive EXECUTE, no new raw grants or role membership. Permitted empty is0, denied/unknown isNULL, and absent grouped storage is unavailable even while the original singleton exists. Original actor-private policies and singleton SQL remain unchanged. The prerequisite refuses unsafe attributes and memberships in either direction; cleanup removes temporary owner membership and schema CREATE. The exact reader is at `db/proposals/mobile-offline-group-count/reader.sql`, with matching DBA prerequisite/cleanup under `deploy/runner-control/`.

| Development check | Exact source | Evidence and outcome |
|---|---|---|
| Final native/API7 cases and whole compiler | `05dfb1f87` | [44028289846](https://github.com/StradaverseHub/ai-hr/actions/runs/44028289846), PASS |
| Final form/DOM22 cases | `26c091ee9` | [44024879415](https://github.com/StradaverseHub/ai-hr/actions/runs/44024879415), selected job PASS; older fixture compiler failure retained |
| Unchanged mobile-offline and Movement native8 cases | `81bc472e5` | [44024317934](https://github.com/StradaverseHub/ai-hr/actions/runs/44024317934), native part PASS; other failed parts retained |
| Linux production build | `93c5b04b2` | [44026397384](https://github.com/StradaverseHub/ai-hr/actions/runs/44026397384), build job PASS; older strict-fixture failure retained |

The37 unique selected cases cover70 companies/1000 employments, the exact998 eligible Workforce choices, ordered traversal, bounded transport, selected hydration, every native role/group/company scope, foreign/unknown denial, storage transition, private count NULL/0 behavior, closed/expired contexts, populated restricted-owner application and hostile membership refusal. The actual picker carrier is REPEATABLE READ/READ ONLY with no exclusive Access lock. Native body EXPLAIN proves one context-table scan; this establishes scan shape, not a latency or dense-device-load acceptance result. Fresh independent spec and standards reviews of the final frozen range found no material violation. Static manifests and whitespace checks pass.

Application bytes at93c5b04b2 and05dfb1f87 are identical: their committed differences are the DBA prerequisite and test files. Retained native/form files and their runtime owners were independently checked for relevant unchanged bytes. No failed workflow is relabelled PASS. Original failures are preserved: nullable pending values atde8d1e98b/db00fdb16, a wrong new saved-manager oracle atdb00fdb16/81bc472e5, real temporary-manager resurrection ateb4cfaeef, strict optional-user-ID fixture typing through93c5b04b2, and a test-only native-oracle variable collision at391a91b0c. Each repair has its affected evidence; final whole compiler and native/API run are green.

Before release: after Recruitment acceptance, verify both installation watermarks and peer claims, allocate only never-applied SQL, wire reviewed DBA prerequisites/schema admission, and rehearse the final ordered populated prefix as the restricted owner. Integrate the accepted baseline and agreed scoped batch, obtain the exact integrated AI source binding through the coordinator, and run the authenticated full release gate. Both descriptive manifests are current; the approval registry remains unchanged/fail-closed. Stop for direct human staging-release approval. Actual arrival, native definitions, rendered consumers, private counts and mixed load must be accepted before closing either finding. No full release gate, staging improvement or production action is claimed here.


## Batch 10: remaining shared employee panels

Development qualification is complete at `57140e73e84732d6e626ba58e5fde74e01d105e9` on `codex/performance-shared-pickers-20261117`, based on the qualified batch9 checkpoint `ed7965fc7`. The135 distinct selected cases across18 files, whole-repository compiler and Linux production build passed. This is development evidence; current-baseline integration, the full authenticated release gate and staging acceptance remain pending. This batch bounds the remaining EmployeeScopePanel consumers: Payroll Fixed Transactions, TP1, TP3, Zakat, Individual Payslip, Loans and Attendance Application History. Personnel draft manager selection also uses a bounded native reader. Each page returns25 choices and resolves the selected subject separately; deep selection is independent of page/search/status. New private POST readers forward cancellation to their owned read-only transaction. No migration is added.

Native owners remain distinct. Loans ignores the active-company cookie and retains its RLS-only population. Zakat's main selection remains NULL-termination only, while its independent history employee filter includes all native-visible employment statuses through a bounded field. Payroll includes ended and future-ended employment. Attendance uses today's effective Assignment and assignment/department Business Unit fallback, and explicit empty scope means none. Draft managers retain employment/person RLS without Company/Assignment joins or Workforce grants, active-only population, and exact ECMAScript displayed-label/UUID search through a bounded identity cursor.

AP-026 remains partial/open. Bulk selectors (Card Assignment, EA/PCB2II, Leave Generate/Adjustments, Individual Transactions, Attendance Recompute and Notice Board audience Criteria) require complete Select All and reviewed/submitted identity semantics. Purpose-specific ranked EmployeeSearchField consumers (Leave approvers/preview, statutory person-ID signatories and OneHR Leaders) retain separate owners and need their own qualification. AP-018 Loans list fanout is also still open; bounding its picker does not repair that reader. At the batch10 checkpoint, secondary Attendance day, Fixed detail, TP1 New/detail/PDF, TP3 PDF and Zakat election-editor buttons still had legacy full-list selected-subject reads; batch11 below qualifies their exact native replacements. User provisioning/profile routing and full-population report/export/reference readers remain separately inventoried; required output populations must not be clipped by navigation paging. All60 open observations retain their acceptance requirements.

Original failed run [44037448004](https://github.com/StradaverseHub/ai-hr/actions/runs/44037448004) is retained: it caught stale Zakat full-array references and a TP1 fixture lacking its real person/role binding. Its native shared-population cases and unaffected DOM/API cases passed. Separate native regression run [44037458466](https://github.com/StradaverseHub/ai-hr/actions/runs/44037458466) passed, including50,000 employees, exact Unicode search, native isolation/scope and cancellation. Broad repair run [44041732618](https://github.com/StradaverseHub/ai-hr/actions/runs/44041732618) passed its58 cases, whole compiler and build at `29378c5d9`. Final label-compatibility run [44043342006](https://github.com/StradaverseHub/ai-hr/actions/runs/44043342006) passed48 affected cases, whole compiler and build at `57140e73e`, preserving Zakat history name/code/company disambiguation. The final135-case inventory retains38 unaffected original cases,38 generic native regression cases and11 unaffected broad-repair cases alongside those48 final cases; no selected case was skipped. Both independent Spec and Standards reviews found no material issue in the final source. Main/alpha integration, full release gate and staging acceptance remain pending; staging is held for explicit owner approval.


## Batch 11: detail/PDF employee lookups

Development qualification is complete at `c930180e994c046ed6c88e940a3c0b9c78f5af2b` on `codex/performance-detail-lookups-20261117`, continuing the isolated qualified batch10 checkpoint `49c8dde40`. Fresh refs at base choice were main `5413154db` and alpha `fc092e1ad`; the owned chain was48/32 ahead/behind main and48/122 against alpha. This preserves the unreleased performance chain rather than changing either integration ref. Integration with the accepted baseline and its exact-source release gate remain pending.

AP-026 now replaces full-directory `.find`/`.some` reads on12 additional consumers: Attendance Individual day, Fixed Transaction detail, TP1 New/month detail/PDF, TP3 PDF, Zakat election editor, PCB slip data, Transaction View history/grid/individual exports and Zakat history export. Display/document paths reuse the existing exact minimal `employeePickerSubject`; membership-only CSV guards reuse `employeeListContains`. Internal IDs, employment/person/company RLS, current Assignment joins, canonical string equality, legacy empty-company-scope semantics and PCB's explicit-empty refusal remain unchanged. Zakat's editor still refuses every non-NULL termination, including future departures. Pages preserve their bare404/no-record behavior; PDF routes preserve HTTP404 with the bare `Not found` body. Existing declaration reads, calculations, commands, audit writes and complete export populations remain with their native owners. No schema or migration change is added.

| Development proof | Exact source | Outcome |
|---|---|---|
| Final native detail/PDF2 cases and whole compiler | `c930180e9` | [44050689415](https://github.com/StradaverseHub/ai-hr/actions/runs/44050689415), PASS |
| Unchanged export transport3 cases | `548d3598f` | [44049841466](https://github.com/StradaverseHub/ai-hr/actions/runs/44049841466), export part PASS; original PDF refusal-oracle failure retained |
| Unaffected regression237 cases and production build | `ace1b9395` | [44047233477](https://github.com/StradaverseHub/ai-hr/actions/runs/44047233477), relevant parts PASS; original new-fixture/compiler failures retained |

The242 distinct selected cases cover13 files with no selected test skipped. Native checks use70 companies/1000 employments, every native role and group/company/empty scopes, exact legacy membership/header equality, foreign/unknown/malformed/case-variant IDs, active/ended/future-ended subjects and an actual RR/READ ONLY/no-exclusive header carrier. Real TP1/TP3 requests produce six parseable PDFs with the independently expected employee filenames; denied requests retain their existing status/body. Export checks preserve current/all filters, complete output reads, header-only grids and the existing SpreadsheetML `.xls` format. Financial, form, Fixed Transaction and PCB slip regressions remain green. Subsequent changes after the successful build affect only the two new test files, preserving application build identity. Original failures came from missing fixture departments, an incomplete registry mock and incorrect Excel/PDF refusal test expectations; their raw evidence is retained. Independent Spec and Standards reviews found no material issue in the final source.

AP-026 remains partial/open for complete bulk selection, ranked or person-specific pickers, saved routing/status metadata and remaining full-population readers. A fresh literal-call inventory still finds17 application `listEmployees` calls in those families; it is not a claim that every complete report/reference population is a defect. No observation is newly closed:60 remain open. This batch has not changed staging, production, main/alpha or any queue/lease. Staging release remains held for explicit owner approval; native plan/latency, mixed-load and rendered installation acceptance are still pending.


## Batch12 — bulk employee selectors (development checked; isolated release hold)

See [scope, review and evidence](reviews/performance-bulk-selectors-20261118.md). The tested application source is `db6e51019d499f7c4af28e4d689b43f27f2be626`, based on the prior qualified query chain. This batch adds no migration and remains outside the combined staging release.

Leave Generate, Leave Adjustments and Notice individual audiences browse25 native labels, while Select All/Clear All resolve the complete matching identity set across pages. Server-side paste resolution retains the established exact/folded collision refusal, unknown tokens, inactive/future-ended subjects and native dated eligibility. Reopened notices separate all known selected IDs from25 hydrated labels. The shared native catalogue predicate preserves archived-company and empty-company behavior for browsing, preview resolution and command reference lookup. Request generations and cancellation reject replaced/A→B→A/closed reads. Pure search neither spends unchanged Leave engine previews nor implicitly submits the enclosing form on Enter; IME composition and actual selections remain native.

EA/PCB2II keep their canonical report-year cohort/order and preview/download limits, enriching only those IDs with required labels and complete lifecycle inputs. Their full report generation and correction fanout remain separate open costs. Card Assignment is an editable-table gap; Attendance Recompute and Individual Transactions are single-employment control gaps, not bulk-checkbox populations.

312 distinct selected cases across20 files pass with no selected case skipped, using valid retained successes and scoped recovery. Native checks include70 companies/1000 employments, every native role/group/company scope, exact old/new identification and selection, code collisions/Unicode whitespace, archived/empty catalogues,1,000 known IDs with25 labels, private request refusal and actual RR/READ ONLY/no-exclusive carriers. The25-row payload is below1/50 of the legacy full-directory payload in that fixture. Rendered checks cover complete selections, stale/cancelled reads, retry, all three consumers, unchanged preview/submitted fields and Enter/IME behavior. Final whole compiler and Linux production build pass in [44297759393](https://github.com/StradaverseHub/ai-hr/actions/runs/44297759393); earlier scoped source evidence remains separately bound.

Independent Spec review is clear. Standards review retains one scale qualification: non-ASCII searches and unqualified runtime configurations still use the established exact minimal-cursor compatibility path. Its native plan/maximum representative cost remains open; this is not a universally SQL-bounded-query remediation. The literal application `listEmployees` inventory is12 callers, down from17; ranked/person-ID/provisioning/routing/status, complete reference/report outputs and no-paste command-dictionary optimization retain separate owners.

AP-026 remains partial/open, and no observation is newly closed:60 remain open. No staging/production installation, main/alpha merge, queue/lease operation or AI approval rebinding occurred. The static manifests are regenerated, while future covered-source rebinding requires its recorded owner/release authority. An explicit owner selection/approval, fresh integration and required release qualification precede staging; rendered installation, native plan/latency and mixed-load acceptance remain pending.


## Batch13 — Unicode search cost (qualification complete; development checks passed; isolated release hold)

See [method, measurements and priorities](reviews/performance-unicode-cost-20261118.md). This qualification-only branch changes no application, dependency, migration or policy. All3 native cases pass in[44307001855](https://github.com/StradaverseHub/ai-hr/actions/runs/44307001855) at1k/10k/50k employments across70 companies. Exact counts/labels/order, scopes, complete Select All and actual forbidden/revoked refusal remain correct on the native non-bypass READ ONLY/RR/no-exclusive carrier.

Ordinary Unicode search is **NOT QUALIFIED** in all30 measured query/scope combinations: JavaScript paging/counting still streams every authorized minimal identity. At50k, group searches transfer50,000 identities/~6.28MB internally and the actual cursor writes427 temporary blocks; the company scope returns715 identities but its native body maxima reach4.23s and its plan performs broad filtering/~428k shared-buffer hits. These are hosted development observations, not staging/production acceptance or a demonstrated lock-contention cause. Fast smaller cases do not waive SQL count/page requirements.

AP-026 remains P1/partial/open. Priorities are to prove narrower native scope filtering without weakening RLS, establish exact database Unicode semantics before SQL count/page adoption, then qualify concurrent/runtime/installation behavior. No observation newly closed:60 remain open. Existing report/table/ranked/metadata costs retain their separate owners. All3 assessor cases pass with0 skipped in[44308291219](https://github.com/StradaverseHub/ai-hr/actions/runs/44308291219); whole compiler and the repeated3 assessor cases pass on type-only recovery source261a9400d in[44311475917](https://github.com/StradaverseHub/ai-hr/actions/runs/44311475917). Six distinct new cases pass,0 skipped, retaining native evidence under its original2fb source and original failures separately. Both reviews and unchanged static manifests pass. Prior production build is retained for unchanged application bytes. This batch remains outside the combined staging release until explicit owner approval.
