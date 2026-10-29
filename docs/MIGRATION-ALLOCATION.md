# Coordinated migration reservations

This record owns **unapplied reservations**, not the deployed database. Refresh canonical branch
journals and the actual staging watermark before journal integration or application. Preserve every
applied SQL/hash and exact journal prefix. Reservations do not authorize deployment or skipping the
owning release gate.

## AI architecture review WP6–WP14 reservations — 29 October 2026

Reserved for the AI architecture review packages (handoff `docs/reviews/ai-architecture-handoff-2026-10.md`).
Only a package that truly needs a migration uses its number.

| Package | Migration file | Journal `when` | Final journal idx |
| --- | ---: | ---: | ---: |
| WP6 | 0692 | 1793330000018 | 682 |
| WP7 | 0693 | 1793330000019 | 683 |
| WP14 | 0694 | 1793330000020 | 684 |
| WP11 | 0695 | 1793330000021 | 685 |
| WP12 | 0696 | 1793330000022 | 686 |
| WP13 | 0697 | 1793330000023 | 687 |
| WP9 store 1 | 0698 | 1793330000024 | 688 |

These follow Board 0688–0690 (idx 678–680, `when` 1793330000014–16) and Bank 0691 (idx 681, `when`
1793330000017), which are unapplied reservations owned by others. The final idx values assume those land
first. The live staging ledger watermark was **not** freshly queried for this reservation (last verified:
563 rows through 0687); it must be re-read, together with canonical branch journals, before integration or
application. These reservations grant no deployment.

## Owner-approved combined board allocation — 29 October 2026

### Successor work in progress after the installed expanded release

The approved-board implementation session read staging at source/build
968354c00a71df7baccd499eb60757a3307ed61e with 562 applied rows and maximum sequence
1793330000012. Reachable AI commit dcea0fa560092c0940cf7872d5b4685093abac35 already
reserves 0687_assistant_question_budget at index677/sequence1793330000013. Preserve
that competing claim; it is not part of this session's current main/alpha baseline.

The first combined development run exposed that the typed payroll provenance column needs the
complete executable schema in every worker, rather than a draft applied only by selected tests.
A fresh ref/worktree-claim check found only the two identical AI 0687 claims, and staging remained
at 562 rows / sequence1793330000012. The candidate therefore carries that exact reserved predecessor
from dcea0fa56 (SQL SHA256 ade48bffee0a5d6ebf72cdd61de36323f3650b81c805cd186701c5d8105e86c4)
and its matching schema declaration, then appends the board successors below. This includes the
schema prerequisite; the independent AI application delivery keeps its own owner and evidence.

| Owner | Index | Sequence | Filename | Purpose |
| --- | ---: | ---: | --- | --- |
| Existing AI prerequisite | 677 | 1793330000013 | 0687_assistant_question_budget | Preserve the already claimed predecessor unchanged |
| Approved transaction import | 678 | 1793330000014 | 0688_payroll_txn_import_attempts | Durable import outcomes, transaction ownership and safe batch revert |
| Approved Rewards domain | 679 | 1793330000015 | 0689_rewards_unit_governance | Private unit inputs, independent confirmation and Senior plan decisions |
| Approved Rewards configuration | 680 | 1793330000016 | 0690_rewards_policy_pair_membership | Enforce authoritative company/business-unit membership |

The original 562-entry prefix is unchanged; this candidate has 566 entries. Board SQL remains
unapplied and under review. The journaled SQL is the sole executable source; obsolete draft copies
and fixture-side schema installation have been removed.
Freeze and record final SQL hashes after repairs, rehearse the ordinary populated upgrade, and
recheck the actual installed prefix before application. No database or deployment acceptance is
implied by this source allocation.

Final source SQL hashes for the review candidate (not an application receipt):

| Migration | SHA256 |
| --- | --- |
| 0687_assistant_question_budget | ade48bffee0a5d6ebf72cdd61de36323f3650b81c805cd186701c5d8105e86c4 |
| 0688_payroll_txn_import_attempts | d8cd57bbd6e0f73deab48353a527782750a5e5f040e945bb4020eace58b8348c |
| 0689_rewards_unit_governance | b9ee4db5644da405b58f83303d8096c9a186b4808b5e943859759785536c68c3 |
| 0690_rewards_policy_pair_membership | 9489f45cbf7ade53d2729d577d8da9045966f02954126fb72e14bc3fc7d4fd44 |

Refresh canonical refs, competing reservations and the actual ledger before journal append.
Do not skip the occupied 0687 predecessor, rewrite applied SQL or infer deployment authority.

The owner subsequently expanded the same release to include Assistant file import and durable Bank & Statutory import. Both source owners agreed, and the owner explicitly approved this revised order while the central coordinator remained unavailable:

| Index | Sequence | Migration | Exact SQL SHA256 |
| ---: | ---: | --- | --- |
| 675 | 1793330000011 | 0685_bank_import_jobs | 62ee5d8d7dedf892be25463edd4f47a6e729c03cc68c7024cdde4956c2d86021 |
| 676 | 1793330000012 | 0686_ai_provider_custody_owner_rls | 571fe5c0865f1419cf500d3ce90f82fea8b80145dec8a48e0c75a0aa3d31555d |

These entries follow the unchanged 560-entry board source prefix below. Staging subsequently received the code-only Mobile release `d35bcb00ca2209a3eaccad92177ce69d50667bbc`, also published on main and alpha. Its 554 applied rows through 0678 / sequence1793330000004 were independently compared in full and remain unchanged. The expanded candidate must preserve that entire applied journal and every applied SQL byte, rehearse the populated upgrade, and verify all 562 ordered rows after one installation. No artificial intermediate 560-row installation is required. The old unapplied Bank 0678 draft was renamed without changing its SQL bytes and its obsolete journal position was removed before integration. Earlier CI witnesses against the FA baseline retain their original identities; the new release witness must bind the actual D35 baseline.

AI Enhancement relinquished its unwritten 0686 reservation. Its question-budget work is outside this release; any later 0687 / index677 / sequence1793330000013 allocation remains conditional on the expanded release's actual 562-row handoff and a fresh competing-claim check. It must not be inserted implicitly into this release. The provider correction preserves FORCE RLS and existing direct-table revocations; it adds only tenant- and fresh-human-bound access for the physical custody-table owner.

The owner explicitly approved combining both board batches into one ten-item staging release,
and approved the exact successor allocations below after both source owners agreed. The central
register was freshly fetched at `439587ea07912ef2254bf9774b16b792d643b300`; no later claim
was recorded, and reachable migration history contained no 0682–0684 filenames. Both the register
coordinator and prerequisite release owner were notified of this combined allocation.

Fresh canonical main/alpha and verified staging are
`57b3c9fd232618c4ac62eed60fd92388c6606119`, with the exact 554-entry applied prefix through
0678 / idx668 / sequence1793330000004. Every prior journal entry and SQL byte is preserved.
The existing register allocations for 0679–0681 remain unchanged. The three original-five drafts
are renamed without modifying their SQL bodies; their obsolete filenames/positions below cannot
be used as an executable alternative.

| Index | Sequence | Migration | Exact SQL SHA256 |
| ---: | ---: | --- | --- |
| 669 | 1793330000005 | 0679_email_templates_r2 | 07cb3af8566b1c9be162f88e5b16d912471cb1eb9ec2582ef7f9224620cdb622 |
| 670 | 1793330000006 | 0680_rewards_exclusions_history | 8497edb87cbc4d4929700f3a8ba8abe3519cd2ce13c50f5f16a522a56093c344 |
| 671 | 1793330000007 | 0681_rewards_approval_participation | 2600e08cde3498f3ce5f2c1fbd4fb1418ab22b7e87db3852768a1b932baa9cdc |
| 672 | 1793330000008 | 0682_epf_manual_percentage | afe1902eef73ba0489c5690155c069a9eec1a0fb2758dcc94cb3451f03a6ea36 |
| 673 | 1793330000009 | 0683_profile_field_approvals | 3bbc6af156e7440477c182b5a8cda9d64700d31cc91f584d2f63a9537ca81f97 |
| 674 | 1793330000010 | 0684_ocbc_bank_payment_exports | f59a9a34b95b66c929ebe0385d048927eab791835f78e98c696930d4472eaeb6 |

The unapplied 0679 body now includes a bounded, read-only recipient-locale accessor for Group HR reminder previews. It returns no template, identity, address or preference-enabled state, grants no table access, and changes no stored records. Its source hash above supersedes the earlier b259d07e4964830eb6781a5efdeaf0c64bc5278a6efefb7883fd8e93bc38ddfe draft after the full-gate renderer/locale defect was diagnosed. The original failed candidate and historical allocation notes retain that older hash. Filenames, indices and sequences are unchanged; no applied migration was modified.

These six entries are an unapplied source allocation. The combined candidate requires a fresh
complete GitHub Actions witness, populated ordinary-journal upgrade proof, a current private
restore point and independently verified staging arrival. No production deployment or human
staging acceptance is implied. Recheck source, full applied ledger and competing claims before
integration/application; reconcile an intervening append rather than overwriting any position.

## Definitive coordinated source allocation — 27 October 2026

The CI/efficiency coordinator reconciled the Board, AI and Mobile reservations and issued the
following ordered **unapplied source allocation**. This supersedes the deferred positions below.
The canonical `alpha@9541b1686d7941f89e564723271e48bf85a21a89` prefix retains all501 entries through
index615/timestamp1793025815551. Allocation manifest SHA256:
`703407b13d5170c9aafdd16b97528ec3dd32389caa85a71a44b65fa4c17523f0`.

| Owner | Index | Timestamp | Filename tag |
|---|---:|---:|---|
|Board|616|1793025815552|0602_payroll_history_revisions|
|Board|617|1793025815553|0603_letter_lifecycle|
|AI|618|1793025815554|0621_ai_action_controls|
|AI|619|1793025815555|0629_lifecycle_acknowledgement_source|
|AI|620|1793025815556|0630_testing_execution_source|
|AI|621|1793025815557|0631_payroll_close_source|
|AI|622|1793025815558|0632_statutory_source_ownership|
|AI|623|1793025815559|0622_own_leave_review_store|
|AI|624|1793025815560|0623_openrouter_provider_options|
|AI|625|1793025815561|0624_assistant_disclosure|
|AI|626|1793025815562|0625_provider_readiness|
|AI|627|1793025815563|0626_module_agent_feedback|
|AI|628|1793025815564|0627_module_agent_improvement|
|AI|629|1793025815565|0628_employee_import_ai_evaluation|
|Mobile|630|1793039596595|0613_request_abuse_budgets|
|Mobile|631|1793047796775|0633_geofence_reported_uncertainty|
|Mobile|632|1793054626620|0634_mobile_integrity_challenges|
|Mobile|633|1793055753390|0635_mobile_integrity_keys|

This AI source integrates the two preceding Board SQL files from
`b1103131ba3e54181cdcbacda85b47e5639f88fe`, then its twelve exact frozen `96c2c9cc9` draft bodies.
All fourteen SQL files match the coordinator's source SHA256 values. Original drafts and historical
candidates remain unchanged; header comments describing their original draft status remain part of
those exact bytes. The journal, rather than the filename number or historical header, owns execution.
The resulting AI journal has515 entries. Mobile rows are reserved successors, not applied here.

Lifecycle, Testing and Payroll source functions precede shared review custody; OpenRouter options
precede provider readiness. Any later release must include all earlier allocated prerequisites;
shipping a later timestamp while omitting earlier allocated rows would silently skip migrations.
An intervening canonical append requires reconciliation, never overwriting an occupied row.

This is source integration only. No database was migrated, no gate/build/deployment receipt was
issued, and neither alpha/main advancement nor a staging operation follows from allocation.
The coordinator observed498 staging ledger rows with two historical source/hash differences;
preserve the actual ledger and resolve installer acceptance through its owner rather than editing
historical SQL or claiming the deployed prefix is hash-exact. Actual shadow, populated-upgrade,
native security/concurrency and application experience checks remain required.

## Historical filename reservations; journal positions were deferred

The coordinator confirmed on 27 October 2026 (Asia/Kuala_Lumpur) that AI dev2 retains only the eight
filename tags0621–0628 below. Journal indices and timestamps will be allocated centrally from the
actual canonical journal at the release source freeze. They are not fixed while human changes
continue advancing `alpha`.

Human PR12 introduced `0620_onehr_panel_manager_anonymity`, index613,
timestamp1793023949843. Human PR13 then advanced published `alpha` to
`491b0a2a79e04775dd46271ff8531f53175c21dd`, preserving that prefix and appending
`0610_performance_partner_role`, index614, timestamp1793025815550, and
`0611_performance_partner_access`, index615, timestamp1793025815551. The coordinator inspected 501
published journal entries while main67be and observed live2127 remained 498. These are historical
observations, not proof of the future deployed watermark. Preserve all human SQL filenames, bytes,
hashes and append order even when filename numbers differ from journal indices.

The provisional AI indices614–621 and timestamps1793023949844–1793023949851 recorded in commit
622c6ebb8 are **superseded and must not be used**. Earlier AI0613–0620 reservations remain surrendered.
At the observation above the earliest possible next index was616 and timestamp1793025815552;
**neither is allocated or guaranteed**. Recheck all competing owners and actual journal state at freeze.

| Reserved filename tag | Dependency purpose | Journal index / timestamp |
|---|---|---|
|0621_ai_action_controls|Action controls|Deferred|
|0622_own_leave_review_store|Shared review custody|Deferred|
|0623_openrouter_provider_options|Provider options|Deferred|
|0624_assistant_disclosure|Disclosure|Deferred|
|0625_provider_readiness|Provider readiness|Deferred|
|0626_module_agent_feedback|Module feedback|Deferred|
|0627_module_agent_improvement|Module improvement|Deferred|
|0628_employee_import_ai_evaluation|Employee Master preparation/evaluation metadata|Deferred|

All eight remain drafts outside the parent journal and unapplied. The journal-position deferral only
changes allocation/header comments, not SQL statements. Future development overlays and release
integration must include the actual verified human prerequisites, including0620,0610 and0611, in their
true append order. No application or release permission follows from a filename reservation.

Preserve prior disposable overlays and test evidence at their true commits and original numbering;
do not rewrite a frozen candidate, interrupt its checks or retroactively relabel passes. Retain valid
coverage and execute only failed, changed-input or genuinely unrun checks under the authorised process.

Routine coordinator: CI/efficiency `01a16cee-9004-72c2-aaf0-932d4d0a1582`; AI dev2
`01a16f03-759a-7630-ab49-3fe0c7d69699`. Allocation decisions remain in that coordinating chat. Before
any future journal append, obtain the final coordinated index/timestamp set from the actual source
freeze and preserve the exact applied prefix. No human migration or deployed record is changed here.


## Board approved items — isolated CI prerequisites, 29 October 2026

The owner's current handoff requires all new migration sequences above `1793330000000`.
Canonical main, alpha and verified staging were `46049dead200d6f436d10f5984c06634502a6286`,
with all 553 applied entries matching the exact source prefix. Shared register commit
`439587ea0` on `claude/migration-inventory-20261027` supersedes the still-unapplied allocations
in `3060942cb` and `8167a9d85` after both source owners agreed the probe release should precede
the database-dependent Board release.

| Index | Sequence | Migration | Exact SQL SHA256 |
| ---: | ---: | --- | --- |
| 668 | 1793330000004 | 0678_ai_connection_probe_ledger | e96851f0b09ba117f9cec03852b9c270da456c36b69a5199a588f483e1a9772a |
| 669 | 1793330000005 | 0679_email_templates_r2 | b259d07e4964830eb6781a5efdeaf0c64bc5278a6efefb7883fd8e93bc38ddfe |
| 670 | 1793330000006 | 0680_rewards_exclusions_history | 8497edb87cbc4d4929700f3a8ba8abe3519cd2ce13c50f5f16a522a56093c344 |
| 671 | 1793330000007 | 0681_rewards_approval_participation | 2600e08cde3498f3ce5f2c1fbd4fb1418ab22b7e87db3852768a1b932baa9cdc |

The probe owner expressly permits only its exact public SQL from
`7bcbe939c4423884d9209a4c098128754835d2b7:db/migrations/0678_ai_connection_probe_ledger.sql`
as an isolated disposable-CI journal prerequisite. This does not integrate its unmerged application
changes or grant this task authority to apply or deploy its migration. Its owner releases that
source separately after the UI handoff. The final Board whole-gate candidate must merge the actual
canonical/applied handoff and verify the real source again; earlier targeted evidence remains
attributed to its own exact CI source.

All four SQL bodies preserve their frozen hashes. Original draft comments are historical
provenance; journal metadata owns execution order. No applied SQL or journal prefix is changed.
Temporary duplicate Board draft installers are removed, and their original native assertions stay
in the ordinary suites. Unique legacy-email conversion assertions use an ordinary Drizzle prefix,
fictional populated baseline and full-journal upgrade.

This records isolated source/CI preparation only. No migration application, staging acceptance or
production deployment is claimed. Recheck canonical, the actual ledger and competing allocations
before final integration. The unmerged named-approver 0669 retains no stale executable position.
## WP4 probe ledger reservation — 29 October 2026

Owner: `codex/ai-review-wp4-gateway-20261029`. Claim **0678_ai_connection_probe_ledger**;
0677 remains reserved for the HR-admin action owner. Refetched matching alpha/main at `b5758c54c`;
alpha journal ends at index 654 / `when` 1793190000000. Read-only staging watermark query returned
540 rows / max(created_at) 1793190000000. Active worktree journals were inspected; largest observed
unmerged `when` is 1793280000000 (agent principal). This branch appends index 655 with
`when` **1793300000000**, above all those observations. Reconcile append indices/order against any
intervening merged migrations before integration; never deploy a higher watermark while omitting
allocated predecessors. This reservation authorizes no migration application or deployment.

## WP4 probe ledger integration allocation — 29 October 2026

The coordinated source register at `439587ea07912ef2254bf9774b16b792d643b300` supersedes
the provisional WP4 journal position above. `0678_ai_connection_probe_ledger` appends at
**idx668 / when1793330000004**, followed by the reserved Board entries0679–0681 at
idx669–671 / when1793330000005–7. The old WP4 idx655/when1793300000000 and later
idx671 proposal are superseded; they are not additional migrations.

Fresh canonical main/alpha at `2c15395691c584b6c82904bb15c732e3686b984b` retain the
553-entry prefix through idx667/when1793330000000. The full ordered live prefix was
independently checked before this append. Every existing journal entry and applied SQL byte
is preserved. The0678 SQL SHA256 remains
`e96851f0b09ba117f9cec03852b9c270da456c36b69a5199a588f483e1a9772a`.
This source allocation does not itself establish migration application or release acceptance.
## Historical original-five candidate — superseded 29 October 2026

The old filenames and three positions below were never applied and are superseded by the owner-approved combined allocation at the top of this file.

The approved-board candidate preserves the exact `main`/`alpha` journal prefix at
`46049dead200d6f436d10f5984c06634502a6286`. Both refs were freshly fetched before this append;
the staging ledger still contained553 rows with maximum timestamp1793330000000.
These three successor entries are source allocations, not a deployment record:

| Owner | Index | Timestamp | Filename tag |
| --- | ---: | ---: | --- |
| Approved board: EPF |668|1793330000001|0678_epf_manual_percentage|
| Approved board: profile approvals |669|1793330000002|0679_profile_field_approvals|
| Approved board: OCBC files |670|1793330000003|0680_ocbc_bank_payment_exports|

The candidate must rehearse these together against the preserved prefix. Refresh refs and the target
ledger again before any installation; reconcile an intervening append rather than overwriting it.

## Owner-approved WP5 Assistant quota allocation — 29 October 2026

Claim `0687_assistant_question_budget`, **idx677 / when1793330000013**. The owner approved this
conditional successor in AI Enhancement, after the expanded release's actual562-row handoff.
Fresh main/alpha `968354c00a71df7baccd499eb60757a3307ed61e` match healthy staging source/build.
The complete ordered live ledger was independently compared using the repository's historical-byte
identity verifier: all562 entries match, max1793330000012, tail0686. Both audited historical applied
versions remain unchanged. Fresh published register439587e and reachable worktree journals had no
competing0687 or when>=1793330000013. Board and the migration coordinator were notified before SQL.

The existing562-entry journal prefix and all applied SQL bytes are preserved. The appended SQL SHA256
is `ade48bffee0a5d6ebf72cdd61de36323f3650b81c805cd186701c5d8105e86c4`. This reserves source only; it authorizes no staging migration
without the exact-candidate gate, populated upgrade proof, restore readiness and exclusive handoff.


### AI review allocation status — provisional until integration freeze

The AI review numbers and timestamps above are historical provisional reservations, not allocation authority or evidence of installation. In-flight Board/FEEDBACK migrations supersede those slots. All AI review SQL remains unapplied in this work: final names, journal indices and `when` values must be assigned together above the freshly verified live ledger at integration freeze. Additional AI follow-up drafts currently use provisional0700 automatic follow-ups,0701 template switch references and0702 delegated Leave receipts; these also require final allocation. No protected branch movement, migration application or deployment is authorized by this table.
