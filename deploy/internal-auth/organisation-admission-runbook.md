# Organisation account admission verifier: staging provisioning

Owner: staging release operator. Run once after migration `2128_organisation_account_admission`
arrives, before accepting the reviewed Company organisation workflow with internal accounts.
Last updated: 4 November 2026. This procedure records no completed installation or acceptance.

Follow the [repository environment policy](../../docs/REPOSITORY-AND-ENVIRONMENTS.md),
[shared staging lease](../../docs/STAGING-RELEASE-QUEUE.md),
[release handoff](../../docs/PRODUCTION-RELEASE-HANDOFF.md) and
[private operator access](../OPERATOR-ACCESS.md). The release controller retains the staging
lease through this step and its acceptance evidence. This runbook grants no production authority.

## Purpose and prerequisites

The server derives a purpose-specific HMAC verifier from its existing `AUTH_SESSION_KEY`.
Only that derived key enters the owner-private `app.organisation_admission_verifier` table;
it cannot decrypt Auth credentials. The application DB role cannot read or change the key.
The database uses it to validate short-lived account availability proofs for reviewed Company
organisation operations. Missing provisioning fails closed for internal accounts.

Before running the helper, establish all of the following:

- The verified staging candidate contains `scripts/provision-organisation-admission.ts` and migration
  `2128`; the migration ledger contains the exact accepted migration bytes. Follow the release
  procedure for candidate/build identity and migration hashes, rather than inferring them from a filename.
- The operator is on the confirmed staging host (`aihr-staging`), in its accepted `/opt/ai-hr`
  checkout. Check `deploy/deploy-state.sh status` and the independent arrival/health evidence.
- An existing protected operator env file supplies the **same** `AUTH_SESSION_KEY`,
  `AUTH_PUBLIC_ORIGIN` and optional `AUTH_DEFAULT_ORGANIZATION` as the staging web service,
  plus `MIGRATION_DATABASE_URL` for that installation's schema owner. The app continues to use
  `ai_hr_app`; never place owner credentials in the web service merely to perform this step.
- Use the installed supported Node.js 22.13+ or 24 LTS runtime and the accepted checkout's dependencies.
  The operator can read the protected env file without widening its ownership or mode-0600 permissions.

Resolve the actual env file and Node paths through private installation configuration. Keep credentials,
origins, database URLs and keys out of public source, shell history, chat, screenshots and CI artifacts.
Do not print or copy the env file into the release evidence. A filename such as `.env.production`
does not identify a deployment target.

## Provision on the confirmed staging host

Set these two path variables to the verified private env file and installed Node executable. The
example paths below are placeholders, not instructions to create a new key or configuration file.

```sh
cd /opt/ai-hr
AIHR_DEPLOY_ENV=/absolute/path/to/existing-private-staging-operator.env
AIHR_NODE=/absolute/path/to/installed/node

test -r "$AIHR_DEPLOY_ENV"
test -x "$AIHR_NODE"
env -u AUTH_SESSION_KEY -u AUTH_PUBLIC_ORIGIN -u AUTH_DEFAULT_ORGANIZATION -u MIGRATION_DATABASE_URL \
  "$AIHR_NODE" --env-file="$AIHR_DEPLOY_ENV" --import tsx scripts/provision-organisation-admission.ts
```

Removing those inherited environment variables for this one command ensures Node reads the intended
file rather than preferring an operator shell's stale values. Use no shell tracing, environment dump
or command-line secret assignments.

Expected result: exit status zero and `Organisation admission verifier provisioned.`
The helper uses one owner transaction and an exclusive verifier-table lock. It inserts the derived
key only when absent. A matching existing key is an idempotent success; a different existing key is
refused. Run the same command a second time to verify that the installed key matches without replacement.
Record only the candidate/build identity, migration evidence reference, target designation, command
exit status and finite success message in protected release evidence.

This helper changes no master Auth key, credential, user/person binding, grant, Company mapping,
employee tag or accepted payroll/review snapshot. It does not prepare, approve, publish or re-tag an
organisation run. Deploying and provisioning this verifier do not activate the first reviewed mapping.

## Verify the workflow

Complete the release's hosted native account tests, including
`test/organisation-admission-proof.test.ts`, `test/organisation-admission.test.ts`,
`test/company-organisation.test.ts` and `test/company-referrers.test.ts` against the exact candidate.
Hosted test results and installed staging behavior are separate evidence.

On staging, verify the authorized internal user's Company organisation configuration/read journey and
its scoped refusals. Any prepared/approved/published staging fixture must be within the release's
explicit authorized fixture scope and use the real independent checker path. Preserve existing
business data; this technical setup is not permission for a live employee re-tag or initial mapping.
Record the actual observed journey and account state without passwords, OTPs, recovery codes,
credential ciphertext, proof payloads or signing material. Verify service health after acceptance.

## Failure handling and recovery

| Result | Operator action |
| --- | --- |
| Missing relation/function | Stop acceptance; verify exact migration ledger and installed candidate. Apply only the reviewed release's missing migrations through its normal controller. |
| Generic provisioning refusal | Verify the target, owner DB access, private env ownership and canonical Auth configuration without printing values. Do not substitute runtime DB credentials. |
| Existing verifier differs | Stop. Check whether the command targeted the wrong database or used a different existing Auth key. Preserve both stores. Key rotation needs a separately reviewed procedure; deleting/replacing the verifier is not recovery. |
| Provisioning succeeds but internal workflow refuses | Check current account availability, password/MFA requirements, identity/person binding, scoped grants, server/DB clocks and exact build arrival using protected diagnostics. Do not weaken admission or enable a legacy fallback. |
| Host or database unavailable | Keep acceptance incomplete; coordinate recovery with the current staging release operator and repository owner under the same lease. |

A failed transaction leaves the previous verifier unchanged. A successful insertion needs no routine
rollback: it does not activate a workflow or change HR facts, and is inert for source that does not
use it. Preserve it during an application rollback. Do not delete private verifier/provenance tables,
rotate `AUTH_SESSION_KEY`, edit applied SQL bytes or rewrite credentials to make acceptance pass.
Record any application rollback through the existing release controller, retaining the original failure.
