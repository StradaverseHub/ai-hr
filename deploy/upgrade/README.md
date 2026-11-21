# Staging index upgrades

Use the shared staging lease and existing ingress bridge for a small additive
index upgrade. The staged candidate and the predecessor use the expanded
database together. Changes outside the admitted index class use the existing
upgrade and verification procedure.

## Exact evidence

1. The candidate adds one non-unique B-tree index on ordinary built-in typed
   columns in a restricted-owner table. Its migration journal has one appended
   entry. The complete old journal and SQL hashes must match the installation.
2. The exact commit runs a GitHub production build and the populated PostgreSQL
   rehearsal in parallel. The build-only run authenticates bytes. The separate
   rehearsal exercises the exact SQL against 50,000 fictional rows using the
   restricted owner. It tests lock contention, injected transaction rollback,
   deterministic result parity, read permissions and safe retry.
3. The operator verifies the original build and rehearsal identities. Warm the
   candidate and prepare both build copies before joining the existing queue.
   The operator invokes the cutover release script with
   `AIHR_STAGING_INDEX_QUALIFICATION_RUN` set to the exact successful rehearsal.
   Existing prepared releases retain their order.

## Install and hand back

Commission the controller from an isolated reviewed checkout with
`install-staging.py`, pinning the installed coordinator versions and the observed
canonical staging source and build. Commissioning upgrades the controller and
preserves the queue database and fencing epoch.

Use the [shared-staging operator flow](../cutover/README.md#shared-staging)
for preparation, activation, promotion and handback. In the installing phase
the engine checks the actual ledger under a lock. It takes the table lock
without waiting, applies the index and appends the Drizzle record in one
transaction under the restricted owner. A small table limit and a statement
timeout bound write contention.

After commit, the previous release proves its route against the expanded schema.
The controller then switches ingress, verifies the warm candidate, applies the
authenticated source delta and build to the canonical installation, and checks
the full ledger again before returning traffic. The signed-in Scheduled Actions
journey and signed-out redirect accompany the final lease receipt.

An interrupted or refused transaction leaves the baseline. Once the transaction
commits, routing back is the application rollback and the compatible index
remains. Never erase ledger entries or restore an old database over live stage
data. If the canonical source and committed ledger differ, keep the lease and
resume the exact staged upgrade. Record commit, CI proof, warmup, claim, database
commit, observed ingress, signed-in verification and handback.

## Reuse the application build for a schema-only index

A release with one rehearsed, compatible index can retain the exact authenticated
canonical build already serving staging. The submission client requires a clean
candidate, an exact successful GitHub rehearsal, and an unchanged Git tree except
for the new migration, appended journal and reviewed proof files. Application,
configuration and dependency edits require a new build. This path transfers the
verified source changes only and skips the second application runtime.

`commission-schema-only.py` installs a staging user timer alongside the existing
queue. `submit-schema-only.mjs` prepares a private packet through the existing SSH
operator identity. The timer picks up only that authorized packet when it is first
in the shared queue and no other release holds the lease. It persists the private
credential before committing its claim. A resume can verify the same completed
migration and reconcile partial source updates. The previous runtime serves
throughout. The arrival receipt records its original source and retained build ID.

After signed-in acceptance, pass a reason on standard input to `schema-only.py
finish <ticket>` on the staging host. The existing lease returns only after the
canonical source, exact unchanged build and ledger are verified. Production
package qualification stays separate.
