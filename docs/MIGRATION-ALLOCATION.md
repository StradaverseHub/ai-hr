# Coordinated migration reservations

This record owns **unapplied reservations**, not the deployed database. Refresh canonical branch
journals and the actual staging watermark before journal integration or application. Preserve every
applied SQL/hash and exact journal prefix. Reservations do not authorize deployment or skipping the
owning release gate.

## Current filename reservations; final journal positions deferred

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
