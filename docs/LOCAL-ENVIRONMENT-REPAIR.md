# Bounded local environment repair, version 1

This isolated controller implements the owner's October 25 instruction in Board 3: “Wait, if 12-16 passed, we only need to rerun gate 11 for deployment right? Dont need to rerun 11-16”, followed by “Okay proceed”. The separate temporary smart-stop and restoration of the idle shared cluster was also explicitly approved there. The approval does not authorize resetting or deleting that cluster.

This is a single, same-source acceptance policy, not generic cross-commit reuse. It applies only to candidate `f20275ffa150ecc41b745f625f085308ea283379`, tree `1b38bb08fddbcefb682240e42871db9d1869ad48`, deployed staging baseline `c98bfed60f6330b57f5a67d959ce6e3757df3b53`, original local attempt 080 and the reviewed private attempt 081 scripts. A different candidate, baseline, wrapper or repair needs another reviewed policy. Existing Home/CSS phase-reuse policy is unchanged.

## Required evidence

The file collector independently classifies every tracked Node/DOM test using the frozen candidate's classifier. All 1,944 files must partition into 963 no-DB files and 981 database files with the original modulo-16 membership. It binds raw archive bytes, the exact original wrapper, the original forced-full impact fingerprint and terminal process commands/exits.

The complete original attempt must naturally finish all 16 database batches and no-DB work. Its sole failure must be the original Reports endpoint assertion in batch 11 on port 5439: one failed file and one failed case, with 774 cases counted in that batch. Batches 1–10 and 12–16 must pass. Interrupted, missing, skipped or additional failed work refuses acceptance. The impact plan's selected `run` list is not full coverage: forcing the full tier leaves that list unchanged. Full coverage is reconstructed from source and the separate complete controller inventory/logs.

The original whole TypeScript check, production Next build, 55 focused repair checks and all three browser engines remain separate claims tied to their exact process commands/exits and raw logs. Each engine must retain its original 16 files, 250 passed cases and one expected failure. These claims are never described as newly executed checks.

Fresh verification must run the unmodified `gate-chunked.sh` with `CHUNKS=16`, `CHUNK_FROM=11`, `CHUNK_TO=11` and two workers. Its 61 files and all 774 original cases must pass naturally. The range is explicitly a slice. Actual app/owner queries after that batch must prove canonical loopback port 5433, a nonprivileged app role, matching database/OID, owned private PostgreSQL 16 data, and JIT on. The private worker heap is bounded at 4 GiB; assertions, timeouts and candidate source are unchanged.

The original full receipt remains byte-for-byte FAIL before, after and at release. The foreign cluster's exact system identity, database OIDs/owners and roles must be preserved and restored after stopping the owned cluster. A failed cleanup or missing restoration blocks acceptance. Fresh work stays inside the original eight-hour resource window; evidence older than this one-day release window refuses.

The first repair admission inherited `AIHR_LOCK_DIR=devdb-locks` and `AIHR_TEST_SLOTS=1` from the outer database wrapper. The direct slice runner then mistook that one database lease for a test lease and waited before any rebuild or tests. This interrupted attempt is preserved in `local-verification-081-lock-environment-attempt`; its raw wrapper, failed result, waiting output, original failed receipt and successful shared-cluster restoration are separately bound by the collector and operator. It confers no passing coverage. The corrected wrapper removes those two inherited settings, as the existing `gate.sh` already does, and is pinned by its new digest. A private fixture executes only the actual wrappers' validated environment-pop loop and the actual gate helper: the old environment sees one lease, the corrected environment sees both test leases. No gate, application test or database is executed by that fixture.

## Operator boundary

`scripts/local-environment-repair.mjs` validates supplied protocol data. It alone cannot authenticate files or authorize deployment. `scripts/local-environment-repair-evidence.mjs` reads regular nonsymlink files, hashes all required raw artifacts, verifies clean company-repository source and controller, reconstructs coverage and checks those bytes against the bounded policy.

`scripts/local-environment-repair-operator.mjs` uses the actual frozen candidate's release helpers and System Testing preparation. It reads the existing private `aihr-staging` SSH alias with `ssh -G`, binds its effective hostname/user/port before importing those helpers, checks that the official rsync route matches, and uses `deploymentRsyncArgs` unchanged. Keep the private SSH configuration outside the uploaded candidate. No infrastructure address or credentials belong in this controller.

The operator verifies the deployed baseline and alpha, rechecks the complete evidence after preparing the testing identity, then checks bound source/artifact bytes before announcement, transfer and launch. After announcement it requires the expected pending candidate over the original built baseline; it must not demand an old `ok` status or silently accept an unrelated deployment. Announcement, source transfer and testing-record publication failures prevent launch. The actual detached deployment follower consumes binary SSH replies and refuses failed, stale or wrong-source results.

The adapter never writes `.gate-receipt.json`, dispatches Actions, changes main/live settings, advances alpha, restarts the service or writes board status. The release owner still completes restart, health, migration-ledger verification, zero-diff source/build arrival, alpha reconciliation and truthful board completion after a successful remote build. It records separate `local-environment-repair` evidence; the original full attempt remains failed in history.

Invoke from the authoritative main worktree with the frozen candidate's installed tsx loader:

```text
node --import <candidate>/node_modules/tsx/dist/loader.mjs \
  <controller>/scripts/local-environment-repair-operator.mjs \
  verify <candidate> <original080-directory> <fresh081-directory> <private-ssh-config>
```

The `deploy` mode performs the reviewed staging build path after the same independent checks. The release owner controls its invocation. Verify mode performs read-only server/GitHub reads and writes only a private local evidence record.

## Validation and the performance goal

Built-in Node tests cover missing coverage, wrong identities, altered failure history, command changes, partial counts, skipped cases, wrong ports/roles/JIT, changed wrappers, receipt relabelling, resource-window expiry and failed restoration. File-reader tests refuse path traversal and symlinks. Flow tests import the actual candidate's command builders and detached follower, replacing only transport with fixtures; they perform no network, database or real deployment.

These checks validate this bounded controller, not application behavior or a successful release. Live original/fresh evidence and independent parent review are still required. This policy does not meet the under-ten-minute goal by itself: elapsed time still includes the original failed attempt, repair, setup, all required checks and deployment. The broader optimization review branch remains isolated until the current release is finished.
