# Shared email file ownership

Shared templates retain immutable native email asset receipts in `lc_v9_email_asset`. The module, template ID and saved revision must match the actual source. Case-specific files additionally retain their actual Contract case, file slot and Personnel period revision. Changing a template never rewrites queued mail or uploaded bytes.

Contract email runs use the held bulk-job event and the pinned workflow step. Probation attachment-bearing email uses a short-lived runtime custody proof in addition to its existing case and run permissions. The deterministic executor resolves To and CC, including the template's default CC, then signs the exact native JSONB digest of the subject, body, rich source, template revision, case and run-step key. The proof also carries the admitted recipients, actual tenant/user/person, transaction ID and a deadline of at most one minute. A cold database caller with case access cannot use a template reference as permission to disclose its files. Native queue batching may remove unreachable people or split the admitted recipients; it cannot add a destination.

The queue freezes actual uploaded receipts before its payload becomes immutable. Native materialization rechecks the recipient-person and subject-person bindings and resolves bytes through the existing delivery ID, one-attempt lease token and installation origin. Filesystem paths and remote file URLs are never accepted. Ordinary word-only Probation email retains its existing behavior.

## Verifier provisioning

After migration `5842_probation_shared_email_asset_proof` is installed on an explicitly approved target, the installation operator runs `scripts/provision-automation-email-assets.ts` using that target's protected owner database connection and protected authentication environment. The source follows the existing organisation/resignation verifier procedure: only a purpose-derived HMAC key enters the owner-private verifier table. The script neither rotates an existing key nor grants the application role access to it. A mismatch refuses provisioning and needs a separately reviewed rotation procedure. Do not print or copy the authentication key into source, logs or artifacts.

No provisioning command is run by this implementation task. Without a provisioned verifier, attachment-bearing Probation steps stop with a specific setup message. They do not silently email without the selected files.

## Verification

`test/probation-email-asset-proof-db.test.ts` uses fictional people and a purpose-derived test key. It checks cold case-only calls, recipient/body/template/revision tampering, transaction replay, actual immutable byte retrieval and changed person bindings. It never invokes SMTP. The existing shared email delivery tests cover ordinary delivery intent and receipt behavior separately. The actual private SMTP attachment adapter is a distinct review proposal in `docs/reviews/contract-email-attachment-delivery.patch`; code completion and approval of that adapter do not authorize a real email during development.
