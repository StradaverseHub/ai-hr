# Resignation runtime verifier

Migration 5881 (the byte-identical final allocation of draft 9991) intentionally fails closed until the release operator provisions its verifier. Follow repository environment policy and the staging queue/lease; this file grants no production deployment authority.

The application derives a dedicated `aihr-resignation-runtime-v1` HMAC key from the existing protected `AUTH_SESSION_KEY`. It does not reuse the organisation admission key, decrypt credentials, or give the application database role owner access. Native SQL authorizes each current actor and command; exact derived JSON is accepted only with a short-lived proof bound to that actor, tenant and database transaction. Private aggregate reads use separately signed scopes.

The canonical `deploy/deploy.sh` now runs this fixed prerequisite after migrations and online follow-ups, before CI build activation or an ordinary service restart. Non-CI `--migrate-only` also completes provisioning before its existing early exit; CI still refuses combining its installation with `--migrate-only`. A failed prerequisite stops the deployment without activating or restarting the new web build. No optional hook or skip flag is provided.

The deploy process reuses its already protected owner environment and installed Node/`tsx` dependencies. Its web service must continue to exclude `MIGRATION_DATABASE_URL`; provisioning does not grant owner access to the app.

For an explicitly reviewed manual maintenance window after applying the migration, use the confirmed installation's protected operator environment containing `AUTH_SESSION_KEY`, `AUTH_PUBLIC_ORIGIN` and `MIGRATION_DATABASE_URL`, and its accepted checkout/runtime:

```sh
node --env-file=/absolute/path/to/protected-operator.env --import tsx scripts/provision-resignation-runtime.ts
```

Use no shell tracing or environment dumps. Never pass secret values on the command line. The helper admits the actual connected schema owner (same session/current role and verifier relation owner, with canonical owner admission and RLS/FORCE RLS intact), and prints only a success/refusal message. It uses one connection with a fixed 10-second connection deadline, transaction-local 10-second lock and 60-second statement limits set before the verifier lock, and bounded connection shutdown. Missing configuration/table/owner authority or lock contention refuses the step; no timeout waiver or automatic retry changes the key. Repeating it with the same key is idempotent; a differing key is refused and requires a separately reviewed rotation. Keep owner credentials outside the web service.

Capture candidate/migration identities and the provisioning exit status in the release receipt. Verify a real authorized command, unauthorized native app-role mutations, case privacy and the missing-verifier failure. A missing verifier is an installation configuration failure, never permission to fall back to an unsigned writer or reader. Key rotation must update the server key and dedicated verifier atomically with the installation's existing authentication rotation procedure.

New-request cutover is independent of workflow readiness. For a Lifecycle-enabled subject company, the old unsigned resignation INSERT is refused even when no submitted workflow is configured; the managed form records the case and its repair state. Existing request rows retain their existing decision path. Managed subject/company history or a previously live submitted-decision definition keeps cutover closed after configuration is paused. Inactive companies without managed/history cutover retain the legacy writer.

During migration/new-server overlap, an old writer therefore fails closed until the proof-enabled server and verifier are ready. Do not route the request through an unsigned fallback: that would restore termination at acceptance. Applying this migration changes no existing request status, last working day or employment fact.
