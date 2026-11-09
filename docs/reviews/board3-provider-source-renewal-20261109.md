# Board 3 provider source renewal review

The requested decision is to renew the same 29 already approved provider data contracts from `d225b958ee491f82a63f58280dc5d89aa87643c7775d82e9c95de6d5088abb82` to `a72ed7576ba5f1cd7b1a4bb75172a6f92c061d0c6b6c1ccb5b67a4bb48275971`. Only the existing `sourceDigest` values are eligible for renewal. Preserve the two pending contracts, `structured_canonical_records_v1` and `attendance_trend_analysis_v1`, and every contract ID, status, reviewer, evidence reference and review timestamp. The approval registry at this review point retains Payroll’s approved binding.

Board 3 integrates the five approved changes with the verified Payroll staging baseline `5aa20706fb7219e28bd077307d7d892996640e1a`. Attendance submissions must resolve a human approval route before writing. Missed clock-outs prepare a review card, and historical automatic actions can no longer authorize new automatic corrections. Workflow administration applies the saved company scope, history rules and warnings. Company setup reads available bank formats and gives new Malaysian companies the 1% HRDF default. Personnel adds scoped filters and column sorting, with editable criteria kept in the protected, expiring search record. The existing Personnel group and name ordering remains the default for its existing callers. Action feedback and the Payroll merge use the existing browser controls and form owners.

The provider generator’s source closure grows from 1,484 to 1,487 files. These changes add no provider purpose, disclosure field, registered agent effect or provider call. The new warning-page action serves the saved workflow UI. Archive is a human-confirmed configuration action. The missed-clock-out capability now ends at Prepare. The existing provider transforms, review rules, gateway and transport remain the disclosure boundary.

The three added dependencies are listed below.

- `lib/attendance-workflow-submission.ts`
- `lib/employee-columns.ts`
- `lib/personnel-list-controls.ts`

The existing closure members whose bytes changed are listed below.

- `core/admin.ts`
- `core/agent-registry/workers.ts`
- `core/attendance-application-history.ts`
- `core/attendance-workflow.ts`
- `core/loops/autonomy-cards.ts`
- `core/loops/autonomy-views.ts`
- `core/loops/autonomy.ts`
- `core/loops/levels.ts`
- `core/personnel-private-search.ts`
- `core/read.ts`
- `db/schema.ts`
- `lib/ai/agent-capability-inventory.ts`
- `lib/attendance-workflow-config.ts`
- `lib/attendance-workflow.ts`
- `lib/my-banks.ts`
- `localization/country-pack.ts`
- `localization/my/company-statutory.ts`
- `localization/my/index.ts`
- `messages/en.json`
- `messages/ms.json`
- `messages/ta.json`
- `messages/th.json`
- `messages/vi.json`
- `messages/zh.json`

The merge preserves Payroll’s 718 applied SQL payloads and journal entries and appends Board 3’s three previously reviewed SQL payloads at their reserved higher timestamps. Board 3’s focused development evidence remains bound to its original source. The merged release candidate requires the standard authenticated hosted release checks against the Payroll baseline.

The registry requires actual human approval of the exact source binding before renewal. The renewal itself does not activate a pending contract or renew a stored promotion or evaluation. [Provider review rule](../../lib/ai/provider-data-reviews.ts)

## Owner approval

The repository owner answered **“Yes approve”** at 2026-11-09T05:21:16+00:00 to the exact 29-contract renewal request for review commit `100861f700f05c6cf45c12388b8618b0043a2df2`. The registry changes only the 29 existing source digests. Reversing those substitutions reproduces the Payroll registry byte for byte, including both pending contracts and all existing metadata.
