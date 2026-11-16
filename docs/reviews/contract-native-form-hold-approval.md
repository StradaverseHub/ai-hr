# Native Contract Form signing hold — approval required

Status: unapplied review artifact. No migration, registration, database function or grant was changed.

Automatic approval review rejected registering a native guard because it would alter Contract signing authorization and Form behavior, which remain held pending separate approval. The rejected command did not execute any file writes.

The application currently blocks unsupported Form outcomes in decision preflight, generation and its letter action entry point. The portal displays an explicit hold. This does not claim that every direct canonical signing call has a native Form hold.

The proposed additional restriction would wrap the existing private `app.contract_shared_signing_access(text,uuid,text)` predicate. For a Contract document whose immutable definition contains a `field` or `fields` block, non-read operations would return false until the approved Form response/receipt owner exists. Other documents and decision approvals would delegate unchanged to the existing predicate. No new actor, operation, writer, storage target or grant would be admitted.

Approval is required for that exact persistent signing-authorization change. It does not authorize implementation of the separate Form response owner, a merge, migration installation or release. The separate response-owner design remains in the ending worker’s `docs/reviews/shared-form-response-owner-proposal.md`.

If approved, verification must prove direct generic signing cannot bypass the hold, ordinary Letter/Acknowledgement signing and atomic review retries remain unchanged, and the held Form can still be read only through its existing subject authorization. Applied migration bytes remain immutable; implementation must use a freshly allocated forward slot.
