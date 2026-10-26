# Coordinated migration reservations

This record owns the coordinated **unapplied reservations**, not live database state. Before journalling or applying anything, refresh both canonical branch journals and staging's actual watermark. This review-branch record is not permission to publish, deploy, reorder applied entries or reuse another owner's allocation. Changes require coordination with the listed owners.

Agreed on 26 October 2026 (Asia/Kuala_Lumpur) by the Standalone users owner and AI dev 2; coordinated in Assess GitHub Actions efficiency. The canonical main/alpha snapshot was Operator commit `ab665101b8c3a108ddffb02f10381305422e118e`, ending at index608 /0601. Actual staging arrival is separately owned by Operator and must be confirmed before promotion.

## Release dependencies

1. Operator owns `0601_operator_customer_workspace`, index608, timestamp1792941214168. Its current release window remains held until verified arrival and handback.
2. Standalone users retains frozen `0612_standalone_user_enrollment`, index612, timestamp1792997586564. Its owner confirmed Operator must ship first.
3. AI dev 2 surrendered all earlier **unjournalled**0602–0604 reservations and confirmed the seven reservations below after0612. All seven remain source-only drafts, unjournalled and unapplied at allocation. Development may continue privately; deployment must preserve the dependency order.

## AI dev 2 reservations

| Index | Tag | Timestamp | Dependency purpose |
|---|---|---|---|
|613|0613_ai_action_controls|1792997586565|Action controls|
|614|0614_own_leave_review_store|1792997586566|Review custody|
|615|0615_openrouter_provider_options|1792997586567|Provider options|
|616|0616_assistant_disclosure|1792997586568|Disclosure|
|617|0617_provider_readiness|1792997586569|Provider readiness|
|618|0618_module_agent_feedback|1792997586570|Module feedback|
|619|0619_module_agent_improvement|1792997586571|Module improvement|

Each timestamp is strictly greater than the frozen0612 timestamp. This does not prove it exceeds a future staging watermark: if another migration advances beyond a reserved timestamp before application, stop and reconcile the unshipped reservation centrally. Do not quietly apply a lower timestamp, overwrite a recorded hash, or amend an applied SQL file. Preserve exact old journal prefixes and all other active reservations.

Owner confirmations are retained in the coordinating chat: Standalone users `01a176f3-edf1-7f03-a2e1-509cda4c6cd6`, AI dev 2 `01a16f03-759a-7630-ab49-3fe0c7d69699`; Operator release owner `01a17395-0003-7023-a41e-576b2ecb0d20`. This allocation edits no SQL, journal, database, migration watermark or release branch. Once integrated into a canonical branch, read its current revision and continue checking actual journals/runtime before further allocation.
