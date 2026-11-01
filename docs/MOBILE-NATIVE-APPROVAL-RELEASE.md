# Native mobile approval server candidate

The running staging API at e1585ac advertises the older task capability and does not contain the request, review or pack workspace endpoints. A newer installed mobile binary therefore still displays web links for those tasks. Installing another binary alone cannot enable the missing server routes.

This approval-only candidate is based on e1585ac and extracts the matching server implementation from mobile review source f2e3600e9. It excludes the background-asset migration, branding, mobile UI and Firebase setup. No new migration is required. Older clients retain their existing capability response; the combined mobile build requests `native=expanded`.

The expanded contract covers leave, leave cancellation, attendance, claims, replacement leave, profile change, resignation, manager review, HR review, notice acknowledgement, performance review, assessment work, career plan, calibration and rewards review. Each workspace reads authoritative facts and supporting documents, exposes only the canonical actions, and submits through the existing service owner with explicit confirmation and receipt replay. Notice acknowledgement and specialist workflows retain their own action semantics.

Authorization still requires the current assigned actor and applicable company/module scope. The client cannot grant native capability or authority. Server-side document membership, self-decision refusal, changed-state rejection, required reasons, senior-pay redaction and transactional receipts remain enforced.

This file records preparation, not deployment or acceptance. Hosted source verification, the authenticated release gate, shared staging lease, exact-source arrival and installed synthetic-account review must complete before claiming these approval types work on staging. Production and store submission require their existing separate authority.
