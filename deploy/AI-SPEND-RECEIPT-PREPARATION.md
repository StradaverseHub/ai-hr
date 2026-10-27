# Staging receipt verifier preparation

This is **source preparation, not an executed provisioning record**. The standalone tool has not yet
passed its authored tests, actual filesystem/owner-role integration, crash-recovery exercise or staging
check. Its SQL prerequisite remains subject to the coordinated migration allocation and final gate.

Follow [Repository and environments](../docs/REPOSITORY-AND-ENVIRONMENTS.md) and
[Operator access](OPERATOR-ACCESS.md). The existing installation is staging; production/live is disabled
in this tool. This tool does not create a provider key, enable a route, certify an inference ceiling,
activate an account, grant a role, restart a service or authorize production HR disclosure. A signing
key and a matching verifier establish receipt authenticity, not provider capability or safe pricing.

## Future admitted sequence

1. Complete the combined candidate gate, migration allocation and schema checks. Coordinate the
   staging release window and hold the normal complete-set resource admission. Preserve existing
   fixtures, processes, environment and backups. The tool neither creates leases nor validates them;
   its required release-window reference is an explicit operator acknowledgement, not an admission
   capability. Do not run it while another owner holds the resources.
2. On the actual staging installation, use the approved private target identity. The owner connection
   must be the actual database **and** verifier-table owner. The migrated private verifier table must
   exist with RLS, primary key, the 32-byte secret constraint and no application secret/table grants;
   the receipt reconciler and supported `public.hmac`/`public.digest` must exist. Missing prerequisites
   refuse; the tool never installs an extension, migration, table or grants.
3. Through the secret manager, expose the owner DSN only as `AI_SPEND_OWNER_DATABASE_URL` to this
   standalone process. Never pass it on the command line, echo it, enable shell tracing, include it in
   evidence or load it into the application environment. The tool owns and closes one dedicated
   connection; it never imports the application's singleton database pools.
4. Pre-create a private recovery directory owned by the invoking operator with mode 0700. It must be
   outside the application directory and every Git worktree. The existing application environment
   must be a single-link regular file owned by the same operator with no group/world permissions.
   Symlink paths refuse. Do not broaden permissions to make a refusal disappear.
5. First run the default read-only check, using actual private absolute paths:

   ```sh
   node --import tsx scripts/operator/ai-spend-receipt.ts \
     --environment staging --env-file /PRIVATE/STAGING/ENVIRONMENT \
     --recovery-directory /PRIVATE/OUTSIDE-APPLICATION/RECEIPT-RECOVERY
   ```

   It returns only `ready` or `needs_provisioning`, whether writes occurred, the staging label and
   `routeActivated:false`. Existing environment and database key must agree exactly and be active;
   partial/mismatched pairs or an env-less installation with active verifier keys refuse.
6. Before applying, obtain the independently verified expected database identity from the existing
   private staging release-window evidence. Its SHA256 is over the compact UTF-8 JSON array
   `[current_database(), current_user, inet_server_addr()::text-or-null, inet_server_port()-or-null]`
   with that exact order and no extra whitespace/newline (the port is a number or null). The release
   operator must establish these facts through the independently approved staging connection and
   installation identity, not infer the expected value from the DSN supplied to this tool. This is
   a target-mismatch fence, not a cryptographic host attestation or admission capability. Keep the
   digest and underlying metadata in private release evidence; the tool never prints them.

   Only in the approved admitted window, add `--apply --environment staging`,
   `--expected-database-identity` followed by that independently verified 64-character lowercase
   SHA256, and `--release-window-evidence` followed by the existing private evidence-file reference. This does not run the release or restart.
   A fresh installation generates a cryptographic 32-byte key and a random key ID, durably writes
   mode-0600 recovery material, inserts only that new verifier in an owner transaction, then uses
   a same-directory mode-0600 temporary file, fsync and atomic rename to append the two environment
   entries. Other environment bytes and all previous verifier keys remain unchanged. No automatic
   key rotation, retirement or deletion occurs. A matching existing pair is a no-op.
7. Re-run the read-only check. Preserve its bounded result privately with the release evidence. Let
   the authorized release owner separately perform the normal restart and source/build/health
   arrival checks. Before activating any strict-spend carrier, its source guard must independently
   verify the runtime signer and database verifier agree. A successful operator check alone does
   not claim that an already running service has loaded the new environment.

## Recovery and refusal

`ai-spend-receipt.pending.json` is mode 0600 and deliberately retained. It contains the original full
private environment, replacement environment, exact hashes, actual and independently expected private database identity hashes and new
key. Treat it as a secret backup. Never commit it or attach it to public logs. Keep it under the
installation's existing secret backup/retention policy; this tool does not copy or delete backups.

If the process dies, first verify that the original process and database work have terminated. An
existing `ai-spend-receipt.lock` is never automatically declared stale or removed. The release operator
may remove only this owned lock after independently establishing its owner is gone and recording that
recovery decision. Do not disturb another process or its lease. A residual same-directory
`ENVIRONMENT.receipt-pending` is also never overwritten: privately compare it to the recorded
replacement, then remove only that owned temporary file after the same verification. Preserve the
recovery record throughout.

Then use the same paths and owner target with `--apply --recover --environment staging` and the
approved release-window evidence reference. Recovery also requires `--expected-database-identity` from the independently verified private
release evidence. It must agree with both the actual connection identity and the expected identity
saved before the first mutation; changing the expectation cannot transplant recovery to another
database. The initial comparison occurs before even creating a process lock or recovery file.
Recovery requires exact database identity, original
hashes and matching key material. It resolves a failed/uncertain DB commit by reading the actual
key: insert the recorded key only if absent and no active verifier exists, or reuse the exact
already committed key. It writes the environment only if it still matches the original bytes.
A fully completed matching DB/environment pair returns `ready` without mutation, including after an
uncertain post-rename fsync. Changed environment, wrong database, mismatched/disabled/retired key or
tampered recovery state refuses; reconcile those privately with the release owner instead of forcing
an overwrite or minting another key. The tool never logs raw database errors, DSNs, hashes or keys.

No actual provisioning, environment mutation, restart, provider request or activation was performed
while authoring this tool. Actual integration and interrupted-phase recovery proof remain required.
