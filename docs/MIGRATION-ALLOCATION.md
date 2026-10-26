# Coordinated migration reservations

This record owns **unapplied reservations**, not the deployed database. Refresh canonical branch
journals and the actual staging watermark before journal integration or application. Preserve every
applied SQL/hash and exact journal prefix. Reservations do not authorize deployment or skipping the
owning release gate.

## Current coordinated replacement allocation

Agreed on 27 October 2026 (Asia/Kuala_Lumpur) in the existing CI/efficiency coordination chat by the
coordinator and AI dev 2. Human PR12 advanced `alpha` to
`43945e5b96b6fcf212718aa9427020ae9a1b582c`, whose499-entry journal preserves the original498 entries
through frozen `0612_standalone_user_enrollment` and adds `0620_onehr_panel_manager_anonymity`,
index613, timestamp1793023949843. The independently observed `main`67be journal remains498 entries.
The coordinator observed staging still at frozen2127 with498 entries at allocation; that is historical
observation, not proof of the future watermark or evidence human0620 is already applied.

AI dev 2's previous unapplied0613–0620 reservations are **surrendered**. The eight replacements below
retain their dependency order and follow human0620. Do not rename, alter, discard or replace the human
migration. Keep historical disposable overlays and their test evidence immutable at their true source
commits/numbers; their old numbering is not a deployable current allocation.

| Index | Tag | Timestamp | Dependency purpose |
|---|---|---|---|
|614|0621_ai_action_controls|1793023949844|Action controls|
|615|0622_own_leave_review_store|1793023949845|Review custody|
|616|0623_openrouter_provider_options|1793023949846|Provider options|
|617|0624_assistant_disclosure|1793023949847|Disclosure|
|618|0625_provider_readiness|1793023949848|Provider readiness|
|619|0626_module_agent_feedback|1793023949849|Module feedback|
|620|0627_module_agent_improvement|1793023949850|Module improvement|
|621|0628_employee_import_ai_evaluation|1793023949851|Employee Master preparation/evaluation metadata|

All eight remain drafts outside the parent journal and unapplied. Only allocation/header comments
changed during this resequencing; SQL statements are unchanged. Future journal integration requires
the owning release authorization and verified prerequisite integration. If any actual watermark or
competing reservation advances, stop and coordinate again rather than apply a lower timestamp or
quietly reuse a number.

Routine coordination owner: CI/efficiency `01a16cee-9004-72c2-aaf0-932d4d0a1582`; AI dev 2
`01a16f03-759a-7630-ab49-3fe0c7d69699`. Historical allocation evidence remains in that chat and the
unchanged prior development branches. The completed40356954143 checks retain exact frozen7b2a
source numbering and results; no old candidate was rewritten or interrupted.
