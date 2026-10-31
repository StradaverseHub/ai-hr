# Lifecycle draft discard absence context

This isolated followup starts at verified33619bc31af98274b3513c4d42dffe0b30f89fe4. Coordinator allocated0746_onboarding_draft_discard_absence_context.sql, idx725/version7/when1793330000083/breakpoints:true, UNAPPLIED PROVISIONAL DEVELOPMENT ONLY. Initial automatic approval review rejected the privileged write before execution; the human then explicitly approved this exact SECURITY DEFINER helper, app execution grant and complete hidden-case absence projection. No installation or release authority follows.

## Contract and authority

onboardingDraftDiscardContextTx(ctx,tx,{draftId,companyId},{tryOnly:true}) returns only {noLinkedCase:true}; every unavailable path throws and the caller must abort its whole transaction. Personnel calls after Access and before draft/counter/review locks. Ordinary activation/save/discard APIs and onboarding synchronization remain unchanged. Personnel owns its discard effect, counter, completion witness and deferred cleanup; this helper performs none of them.

The SQL owner checks READ COMMITTED/write transaction, active actual USER, current database principal/roles, and actual nullable PERSON equality. It preserves the native admin-role gate, then BOTH0510 author-or-company visibility and0579 draft read/edit permission. An unlinked HR USER is valid. A native HR author course is preserved independently of company administrator scope. Missing, foreign, unassigned, stale or explicitly denied drafts refuse before any case projection. Only draft ID is selected; no draft body or case facts return.

## Lock and visibility interval

The helper rejoins Access with a try lock for safe direct app-role calls, then takes try-only audit-chain and onboarding locks with exactly the canonical keys/order. Any false or NOWAIT contention aborts. It holds a global SHARE lock on lc_onboarding_case, then locks the authorized assigned-company draft NOWAIT. A separate VOLATILE PL/pgSQL statement checks ANY same-tenant linked case, regardless of status, company visibility, module enablement or configuration revision. This fresh post-fence snapshot must not be replaced by a STABLE function or pre-fence CTE snapshot.

The SHARE fence also blocks raw app INSERT/UPDATE link phantoms that do not take the native advisory keys; source_draft_id has no FK/writer trigger. Coordinator explicitly accepted cross-tenant case DML contention for this short fail-fast interval. Locks last through COMMIT; there is no throughput or wall-clock promise. The fixed-search-path SECURITY DEFINER function returns only true or generic unavailable, revokes PUBLIC EXECUTE, grants only ai_hr_app EXECUTE, and adds no case SELECT privilege.

## Focused verification

Hosted tests must prove nullable and linked native HR positives, author versus company semantics, explicit view/edit denials, stale role/person/archive and foreign/SYSTEM refusals, moduleOFF/config0 hidden linked case denial, current locks and release on success/failure/rollback, actual raw app INSERT/UPDATE fencing, and a writer COMMIT after the outer statement starts but before the helper fence. The latter uses an observed test-only advisory gate, not a production hook, and validates that the volatile absence read sees the newly committed hidden case. Existing native onboarding DB and pack tests provide affected API regressions. Exact frozen SHA, selected tests, whole compiler and actual outcomes are recorded in the exclusive phase file. No local app checks or DB execution.
