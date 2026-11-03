# ADR-0172: Subject-owned, content-bound document signing

Status: Candidate implementation decision, 3 November 2026. Hosted verification, integration and installation remain separate.

Probation needs configurable signing with immutable review content, separate private rater drafts and an independent approving person. The existing Onboarding/Offboarding case model has different ownership and completion rules. We add a shared signing service with a fixed subject adapter instead of representing a probation review as a synthetic onboarding case or broadening the legacy case enums.

The subject owner authorizes each operation and supplies the current content fingerprint, revision, employment, company and permitted route. Database functions lock the source before the signing document and recheck these facts on every mutation. The application role has scoped reads; writes pass through those functions. New subjects require an explicit adapter, grants and negative-path evidence.

A signature records the authenticated user, their person identity and the represented assignment. Independent approval compares people, because multiple user identities can belong to one person. Content revisions retain earlier actions without counting them toward new content. Confirmed acknowledgement refusal is an explicit audited contribution with no forged signature. The signing owner records reference-only domain events while the subject retains private document history. Shared workflow presentation does not transfer authority over employment or pay effects.

The new modules read canonical PBP rules and People Ops group membership from the existing Lifecycle configuration. Module-specific assignments narrow that authority and opt users into the new module; they do not create a second source for PBP or GBS authority. The private readers have no application or public execution grants. Conflicting highest-priority PBP mappings hold the new module until corrected. The existing Onboarding/Offboarding resolver and configuration remain unchanged.

A release decision and its frozen PDF are durable before canonical employee filing and employment effects. The existing privileged maintenance connection owns that filing step. Completion requires the actual employee-document receipt and the source-bound movement or handoff receipt. A failed worker leaves the accepted decision pending for retry; neither a fabricated administrator session nor a broader Personnel permission substitutes for those receipts. User-facing state distinguishes accepted intent from completed filing and effects.
