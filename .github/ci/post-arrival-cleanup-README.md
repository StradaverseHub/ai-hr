# Single-install post-arrival cleanup completion

This operator-only tool is limited to the already active installation selected in
`post-arrival-cleanup-policy.mjs`. It is not an installation grant, a release witness,
a source-transfer operation or staging acceptance. The original installation grant
and cleanup authority remain byte-for-byte unchanged, including their expired dates.

Execution requires a **new explicit human cleanup-only approval after source review,
successful hosted controls and review of the exact packaged tool digest**. No such
approval is supplied by the diagnostic workflow or this document. Do not execute the
tool, create an approval on a human's behalf, or invoke the Python cleanup engine
directly while approval is absent.

## Exact operation

The selected source is `f2ca511f4ded441399fd30437bb75553bb92efbb`, running build
`7N7c7Fk5tpJmI7C-5QGwf`, installation `777914fb-0a46-4252-8449-6d145be6522d`,
original build record `11dc0078-124c-4168-ade0-14cab716eecb`, retained queue batch
`34ff2c4d-7c25-481a-b078-68a07a139d2c`, epoch 7. The approved action removes only
that installation's owned **retained previous `next` and consumed `packet` trees**.
The active `/opt/ai-hr/.next` is fenced and never selected for deletion. Original
grant, pre-expiry cleanup authority, audit records, intent and result are retained.

The operator tool lives in a fresh private directory outside application source.
All tool members and canonical source bytes are hash-bound. The same staging lease,
shared queue operation guard and exclusive per-install file lock remain held through:

1. Complete historical identity, original authority, source, environment, compiled
   byte inventory, service/restart/health and ordered 581-row ledger checks.
2. A private one-use preparation challenge, emitted **after** the slow checks.
3. A newly observed, fully empty canonical rsync dry-run using the unchanged source
   transfer filter. The commit binds the challenge, exact approval/tool/installation
   hashes and observation time. Both preparation and checksum have strict deadlines;
   the checksum remains limited to 60 seconds immediately before removal, including
   after durable writes and nonce consumption.
4. Exact source, build, PID/boot, environment, ledger, owned-directory and lease
   fences, then the unchanged descriptor-relative owned cleanup engine.
5. Complete runtime/compiled-byte/ledger audit again and a full post-cleanup empty
   canonical checksum. Only then may the lease phase become `arrived`.

A disposable local snapshot avoids attributing unrelated Git-checkout timestamps to
staging content drift. It contains only pinned public canonical source members from
the clean installed Git commit. A read-only remote rsync may reconcile metadata in
that private snapshot; exact bytes, types, modes and the finite inventory must match
Git before and after. The original checkout, staging source, environment, runtime,
credentials and excluded paths are not modified or copied into the snapshot.

## Reviewed procedure

Before asking for execution approval, retain the frozen controller SHA, successful
hosted controller run, API artifact digest, verified closed tool inventory/digest,
independent review and current read-only lease/runtime/resource reconciliation.
The approval request must identify the exact operation above and explicitly say
the old installation grant has expired. It does not authorize the separate composer
successor, protected refs, source transfer, restart, activation, publication or production.

After the human approves, an operator records the actual approval evidence privately.
The private 0600 approval JSON has exactly `format`, `kind`, `selection`, `controller`,
`toolSha256`, `approvedAt`, `expiresAt` and `humanEvidenceSha256`. `kind` is
`EXPLICIT_SINGLE_POST_EXPIRY_OWNED_CLEANUP`; selection is exactly the exported literal;
the reviewed controller and API-authenticated package digest are exact. Its maximum
validity is 30 minutes. Dates represent this new cleanup approval, never a rewrite
of the old grant. No diagnostic artifact supplies this execution authority.

Use the established Node/tsx operator tooling and private staging SSH configuration.
Run the packaged `post-arrival-cleanup-operator.mjs` with the clean installed-source
checkout, real private approval file and a fresh private evidence directory. The
lease stays in `AIHR_STAGING_LEASE_FILE`; never print its contents or credentials.
The operator validates the original lease, normal rsync capability and source freeze,
then transfers only the reviewed tool and approval to a new private operator directory.
It never transfers candidate application source or a build packet to staging.

Any timeout, missing response, changed state, stale proof, consumed nonce or failed
audit stops completion. Close the private input channel without killing a remote
operation; retain the lease and reconcile actual process/lock/intent/result/resource
state before proposing a retry. Do not renew grants, edit observations, delete locks
blindly, reinstall, manually remove trees or release the lease to work around refusal.

Successful cleanup is still **not human staging acceptance or lease handback**.
Retain read-only changed-journey results and honest open UI findings. Decide capture
or publication separately under existing authority. A corrective release and protected
branch alignment require their own genuine exact-source evidence and authority.
