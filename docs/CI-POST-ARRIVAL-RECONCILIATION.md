# Post-arrival reconciliation after installation-grant expiry

This is a distinct, reviewed cleanup-only recovery protocol, `aihr-post-arrival-reconciliation/v1`.
It does not extend or replace an installation grant. The normal installer and normal cleanup retain
their original expiry checks. It must never transfer application source, migrate, activate a build,
restart a service, publish a package, or mark reporter acceptance.

Use it only when the original detached deployment has completed successfully and the exact original
CI build is active and healthy, but final arrival/owned-cleanup verification stopped because the
original 30-minute grant expired. Retain the staging lease, original failure, immutable grant and all
installation records. An incomplete/failed detached deployment, different build, prior uncertain
cleanup, changed private configuration or changed migration ledger refuses this route.

## Review and qualification

Create an isolated controller from the original trusted CI controller. The closed changeset permits
only the reconciliation policy, executable inventory validator, server, operator, tests, this guide, its workflow test step and the
read-only `auditSelectedRuntime` extraction and its immediate pre-helper inventory callback in the existing installer. Review the exact controller
commit independently and run the workflow's controller-only diagnostic on standard GitHub-hosted
runners. Both unchanged CI integrity checks and `Post-arrival reconciliation refusal checks` must
actually succeed. Controller diagnostics do not replace the original application qualification.

The operator imports the original clean trusted controller's `verifyCi` and `revalidateCi` functions.
These independently authenticate the complete original successful run, jobs, artifacts and bytes,
reconstruct coverage and bind the unchanged candidate to the original baseline and build. The
reconciliation controller records its own separate reviewed commit and hosted diagnostic identity.

## Execution

Keep all arguments, credentials and evidence private. Preserve the original candidate checkout,
trusted controller checkout and original grant/initialization records. Set the existing private
`AIHR_SSH_CONFIG` and retained `AIHR_STAGING_LEASE_FILE`. Set
`AIHR_RECONCILIATION_REVIEWED_CONTROLLER` to the independently reviewed recovery-controller commit.
An operator wrapper imports `reconcilePostArrival` from
`.github/ci/post-arrival-reconciliation-operator.mjs` and passes:

```js
await reconcilePostArrival({
  candidatePath: '/absolute/unchanged/candidate',
  trustedControllerPath: '/absolute/clean/original-controller',
  runId: ORIGINAL_SUCCESSFUL_FULL_RUN_ID,
  diagnosticsRunId: SUCCESSFUL_RECONCILIATION_CONTROLLER_DIAGNOSTIC,
  originalGrantPath: '/private/original/installation-grant.json',
  initializationPath: '/private/original/installation-initialized.json',
});
```

The original trusted verifier may reuse already downloaded archives through `AIHR_CI_PREFETCH_DIR`;
API provenance and archive digests remain mandatory. Use the candidate's installed `tsx` loader as
for the normal authenticated operator. No local tests, application build or compiler are required.

The operator sends a digest-checked private controller bundle into a new directory under the original
owned installation, using a fresh attempt UUID so an interrupted read-only setup/inspection can be retried without deleting prior evidence. The fixed authority file, READY and consumed-nonce guards still refuse uncertain mutation retries. It does not modify canonical `/opt/ai-hr` source. A read-only full installed-byte,
runtime, service, private-environment and ordered-migration audit precedes cleanup authority.

The separate authority lives for at most 60 minutes and never beyond the original CI run's 24-hour
limit. It binds the original grant digest, source, build, installation, current staging lease,
active inode/PID/start/boot identity, environment, full ledger, reviewed recovery controller and fresh
independent CI/source checks. The original `authorization.json` bytes and timestamps remain unchanged. The reviewed controller executable inventory is part of this authority. Trusted inline standard-library validation runs before importing uploaded code; exact file bytes, paths, ownership, modes and metadata are rechecked before audits and helper invocation/removal. Unexpected files and symlinks refuse. Authority publication uses the existing owned, fsync-backed durable record writer.

The server retains original audit bytes, snapshots complete source/compiled metadata and runtime
fences, performs a full preparation audit, then sends READY on the same connection. The operator
reauthenticates original CI and computes an actual zero-line checksum after READY. A bounded nonce
COMMIT must match that challenge; the server rechecks metadata and live fences, durably consumes the
nonce and authorizes only descriptor-safe removal of the original installation's retained `next`
and `packet` trees. The active `.next` tree and audit records are preserved. A second full audit, exact post-cleanup PID/start/inode/lease/environment/ledger and executable/source/compiled metadata fences, and
final source checksum are required before the result claims arrival and owned cleanup.

On timeout, disconnect, drift, expiry or uncertainty, retain the lease and all records and reconcile
the actual state before further work. The receiver refuses a second automatic attempt after an
existing READY, consumed nonce or cleanup authority. Do not delete those records to make retry pass.
Do not change clocks, original grant dates, application source or normal expiry defaults.

## Handback

The result retains the original full-CI identity and adds a distinct reconciliation record. It is
not a replacement original CI result, human acceptance or completed release handback. Continue the
required rendered journeys, board milestones, branch alignment and queue handback under the same
lease. A later repaired application candidate needs its own validated source/build evidence and
normal authorized installation; this cleanup-only route cannot install it.
