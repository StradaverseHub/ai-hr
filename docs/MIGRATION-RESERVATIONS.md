# Central migration reservations

Allocate filename numbers here before parallel SQL work. The machine-readable [registry](migrations/reservations.json) records reservations and the reconciled source inventory. This is allocation metadata, not the executable Drizzle journal. Repository migration rules remain in `CLAUDE.md` §6.

## Mobile reservation

**0647_mobile_offline_attendance** is reserved for Mobile, as one logical migration. No SQL file or journal entry was created by this reservation. Its final Drizzle `idx` and `when` are **integration-bound**, not allocated now. Mobile may prepare its draft against this filename; journal/apply/deploy require the normal integration and release process. Keep the separate unjournaled **0636_mobile_android_key_custody** reservation and SQL bytes unchanged.

## AI reservation (28 October 2026)

The owner designated the AI delivery session as migration allocator for the AI logical groups. It reserves the filename block **0648–0658** for AI, above every recorded hold. A scan of all Git refs and working trees on 28 October found no filename at or above 0648. AI keeps its recorded **0642**; an unrecorded cross-session message saying AI had released 0642 is not adopted. 0643–0645 were later released by the REA P1 owner and are free for a recorded claim. REA reports a staging release in progress (504 → 506 rows, watermark1793120000000); re-read the ledger before journaling.

Final `idx`/`when` values are assigned at journaling: unique append positions after every applied or approved predecessor, with `when` strictly above the live watermark and every pending predecessor. A read-only staging ledger check on 28 October found 504 applied rows, last idx618 (`0641`), watermark1793109999999, source ref `fffabc90922c3d43b2570dc29a33ce8b70b69aca`. Unused numbers in the block are released here once the AI group count is final. AI journal entries append after alpha's idx620 (`0646`) with `when` strictly above1793120000000.

### AI filename map (final, 10 logical migrations)

| File | Content | Ordering dependency |
| --- | --- | --- |
| `0642_module_specialist_diagnostic_playbook` | N1 playbook | needs pending 0627 |
| `0648_ai_concurrency_controls` | N2 concurrency | needs pending 0621 |
| `0649_ai_provider_accounting_summary` | N3 accounting summary | needs pending 0625 |
| `0650_ai_native_outcomes` | N4 native outcomes: associations, target-custody, workspace, candidate-signals as ONE migration (NOT NULL column without default) | — |
| `0651_ai_spend_controls` | N5 spend: allocation, receipt-reconciliation, native-tasks, reviewed-carriers, reviewed-metered-carriers as ONE migration | after 0648 |
| `0652_performance_provider_source_custody` | N6 | — |
| `0653_claims_provider_source_custody` | N7 | — |
| `0654_ai_optional_usd_policy` | N8 | after 0651 |
| `0655_assistant_conversation_candidates` | N9 | after 0642 |
| `0656_assistant_transcript_retention` | N10 | after 0655 |

Journal order: alpha's 506 entries; the 12 pending AI entries (0621, 0629–0632, 0622–0628) moved forward to idx621–632; then the ten files above at idx633–642. Every `when` is strictly increasing above max(live watermark, 1793120000000), assigned after re-reading the ledger.

## Existing allocations and ordering

| Slot | Owner / scope | Allocation status |
| --- | --- | --- |
| 0636 | Mobile Android key custody | Held, unjournaled; old provisional idx634 is not a final allocation |
| 0641 | Reports email delivery history | Applied on staging (idx618 / when1793109999999, observed 28 October) |
| 0640 | REA P1 wave 1 reviewer scope (PR #19) | Journaled on alpha idx619 / when1793110000000; not yet applied on staging |
| 0642 | AI specialist diagnostic playbook | Reserved draft; idx/when deferred |
| 0643–0645 | Free | Released by the REA P1 owner on 28 October; never written, branched or journaled. Record a claim here before use |
| 0646 | REA P1 wave 2 Reward Calendar (PR #23) | Journaled on alpha idx620 / when1793120000000; not yet applied on staging |
| 0647 | Mobile offline attendance | Reserved filename; idx/when deferred |
| 0648–0656 | AI delivery | Mapped filenames (see below); idx/when assigned at journaling |
| 0657 | AI delivery | `0657_ai_integration_repairs`, reserved 28 October for integration SQL repairs; idx643 intended |
| 0658 | Free | Released by AI on 28 October |

The explicit owner exception permits only the still-unapplied0640 journal position to follow0641. It does not authorize P1 runtime deployment. Preserve both SQL files and all applied history. Filename order does not determine journal order.

## Reconciliation findings

The read-only staging observation on 27 October2026 at15:12UTC found503 applied rows, watermark1793025815553, source/built ref `d52563c666d39074217ed42191866add4a2793a0`. Refresh actual state before integration; these are historical observations, not a live release status.

Current AI source contains12 pending journal entries (0621/0629–0632/0622–0628); Mobile carries those plus four (0613 request-abuse budgets and0633–0635). They retain the exact applied503-entry prefix, but their provisional positions collide with Reports/P1 and their old timestamps precede0641. Appending these stale timestamps after shipping0641 would silently skip them. Integration must reconcile the complete pending union and forward metadata for unapplied entries, without rewriting applied entries or re-sorting history.

The old `codex/ai-development-sql-20261027-6f32` journal diverges from the applied prefix. Its0613–0620 files are historical/unreconciled, not deployable replacements or byte-proven aliases. The P1 IDP source journal also diverges. Preserve these facts rather than treating every branch journal as authoritative. Exact SQL hashes and observed metadata are in the JSON inventory.

AI dev2 also has14 new draft SQL fragments in seven logical groups: the reserved0642 plus six unallocated groups listed in the registry. Copies of the existing12 pending migrations are not new allocations. No further AI numbers are allocated here. Native-outcome and spend fragments retain their own dependency order; consolidate only after SQL review.

The inventory covered227 working trees and all reachable Git history for0640+ migration/draft filenames. Highest observed occupied filename was0646; owners of current Mobile, AI, Reports and Board work were consulted. This establishes0647 as this coordination's new reservation; it does not prove that undocumented historical holds never existed. Report a conflicting reservation to the central integrator before journaling.

## Integration requirements

1. Refresh actual ledger, canonical source and all owners' pending work; preserve SQL hashes and the applied prefix.
2. Retain approved0641-before0640 order and reconcile other unapplied entries as a union. Resolve legacy divergence explicitly.
3. Assign unique append positions and strictly increasing timestamps above the actual applied watermark and every predecessor. The known pending maximum1793120000000 is only a lower bound if all known predecessors ship first.
4. Review actual schema dependencies before scheduling Mobile0647. A filename reservation alone proves no prerequisite is deployed.
5. Use the normal migration rehearsal, coverage and release process. This document authorizes none of those operations.

This reconciliation changes documentation only. Optimization remains paused; no journal, SQL, database, service or deployment was changed.

## 28 October 2026 — AI release applied; 0661 reserved

- Applied on staging by the AI release `b30c562e4`: 0621, 0629–0632, 0622–0628 (idx 621–632), 0642 (idx 633), 0648–0656 (idx 634–642) and 0657 (idx 643); when 1793130000001…023. Ledger 506 → 529, watermark 1793130000023.
- Next: Board items' `0660_payroll_history_adopt_ordinary` (when 1793140000000, expected idx 644).
- Reserved: `0661_ai_openai_compatible_provider`, when 1793150000000, for the AI known-gaps session (OpenAI-compatible provider by base URL). It is pending owner approval of the DB change. Journal it only after 0660 is applied, at the next free idx (expected 645). If any later when is applied first, re-allocate rather than journal below the watermark.
- 0659 has no recorded claim; do not use it without one.
- Update (later, 28 October): 0661 is renamed `0661_ai_gateway_provider`, a general AI gateway type with public https only; the owner approval was relayed by the AI GAPS session. Reserved `0662_ai_group_allowance`, when 1793160000000, expected idx 646, journaled after 0660 and 0661.

## 28 October 2026 — REA P1 wave 3 claim 0663–0667

AI DEV confirmed it allocates for the AI groups only and that 0663 onward is unclaimed above every hold (0643–0645 and 0658 are recorded free; 0659 has no record). REA P1 wave 3 claims five ordered logical migrations:

| File | Content | when |
| --- | --- | --- |
| `0663_onehr_leader_seats` | WP-B2 seat registry, HOD assignment, session anchor, `onehr_calibration_access` | 1793170000000 |
| `0664_onehr_hod_department_view` | WP-C HOD projection | 1793170000001 |
| `0665_onehr_two_step_release` | WP-E leader release columns (merge held for CF-08) | 1793170000002 |
| `0666_reward_payroll_posting` | WP-H2 payroll-seat posting arm | 1793170000003 |
| `0667_onehr_unit_exclusion` | D-P1-22 X1+X2; restates `onehr_calibration_access` after 0663 | 1793170000004 |

idx is assigned at journaling, after staging's idx 644 (0660) and the AI 0661/0662 entries. Re-read the live ledger before journaling; if a later `when` lands first, re-allocate rather than journal below the watermark.
- Update (later, 28 October): **0666 released** (free, never written or journaled). WP-H2 needs no migration: under APR-022 the reward design source has no payroll actor, so no posting arm is added. 0663–0665 and 0667 stay claimed; 0667 keeps `when` 1793170000004.
- Update (REA P1 wave 3, later 28 October): **0666 re-claimed** as `0666_onehr_leader_status` (WP-A3, when 1793170000005), stacked on WP-E. Branch journals after Board items' 0668 (idx 647): 0663 idx 648, 0664 idx 649, 0665 idx 650 (held), 0667 idx 651, 0666 idx 652 (held). **0665 and 0666 are held for CF-08 client confirmation and will land after 0667**: re-allocate their `when` values above the live watermark at integration, or they would be silently skipped.

## 28 October 2026 — 0669 reserved for named leave approver visibility

- `0669_leave_named_approver_read`, when 1793180000000. Owner decision relayed by the AI GAPS session: an employee named as a leave approval step's fixed approver (`specific_employee`) may read the requests they are or were asked to approve, and nothing else about that employee. One migration: SELECT-only RLS arms plus a name-only definer read. idx is assigned at journaling, after 0668 (idx 647) and whatever REA P1 wave 3 entries land first. If a later `when` is applied first, re-time it above the live watermark rather than journal below it.
