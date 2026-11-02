# ADR-0172: Subject-owned, content-bound document signing

Status: Candidate implementation decision, 3 November 2026. Hosted verification, integration and installation remain separate.

Probation needs configurable signing with immutable review content, separate private rater drafts and an independent approving person. The existing Onboarding/Offboarding case model has different ownership and completion rules. We add a shared signing service with a fixed subject adapter instead of representing a probation review as a synthetic onboarding case or broadening the legacy case enums.

The subject owner authorizes each operation and supplies the current content fingerprint, revision, employment, company and permitted route. Database functions lock the source before the signing document and recheck these facts on every mutation. The application role has scoped reads; writes pass through those functions. New subjects require an explicit adapter, grants and negative-path evidence.

A signature records both the authenticated user and the represented person. Independent approval compares people, because multiple user identities can belong to one person. Content revisions retain earlier actions without counting them toward new content. Confirmed acknowledgement refusal is an explicit audited contribution with no forged signature. The signing owner records reference-only domain events while the subject retains private document history. Shared workflow presentation does not transfer authority over employment or pay effects.
