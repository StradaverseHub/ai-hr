# Upgrade rehearsal design review

Reviewed 26 October 2026 MYT against the supplied `Upgrade Rehearsal Design.html` (SHA-256 `00832e16e01f5aae594fc537e1408a2c89f40c73e9c6b77bc9ff23759b8bad63`) and repository `main` at `1a45bbe0ee2dc68fd4ac62a0c362b6d189b7ef7c`. This is an assessment, not approval to install a blocking release phase or run against the host. No rehearsal, backup, restore, migration or deployment was started for this review.

## Recommendation

Keep the proposal's core: rehearse the exact migration/catalog/backfill sequence against a populated, controlled copy and verify both preserved business facts and application-role access. It addresses upgrade correctness, which fresh-fixture tests and a schema-only shadow cannot establish. It does not replace database integration tests, authenticated journeys, the compiler, build verification or deployment arrival. It is not an optimization for the ten-minute target: its own uncalibrated estimate adds eight to fifteen minutes to each release.

Review and calibrate separately after AI dev 2's current release. Use deterministic impact analysis to determine when new populated-data evidence is necessary; include that work in the complete release measurement whenever required. A previous rehearsal is reusable only if an independent verifier proves its exact database/schema/data dependencies, candidate release steps and environment remain applicable. A changed migration, catalog writer, backfill, unknown dependency or business invariant invalidates that reuse. A fixed nightly cadence is not proof for a changed release.

## What helps

- One shared migration/catalog/backfill implementation prevents rehearsal and actual deploy from drifting. Preserve all existing ordering, modes, environment guards, exit behavior and release evidence contracts during extraction.
- A consistent dump plus manifest and an actual checked restore supplies stronger evidence than an untested backup file.
- Compare existing rows, money, entitlements, constraints and authorization behavior before and after applying the candidate. Record intended changes explicitly and test the comparator with adversarial fixtures.
- Bind the verdict to the candidate, release-step digest, declarations, restored baseline ledger and dump/manifest digest. Keep rehearsal, tests, build, restart and arrival as separate claims.

## Required corrections

| Gap | Required change |
| --- | --- |
| Historical baseline | The document uses main `573c01ff3` and 489 migrations. Board 3 subsequently verified staging source `f20275f` with 495 entries; branch integration is `1a45bbe`. Refresh actual host facts before calibration. The existing host is staging; future main/live remains disabled. Future verified integrations must preserve the owner's current main/alpha alignment rule. |
| Extra eight to fifteen minutes on every release | Measure actual dump/restore/fact cost before making it mandatory. Use justified impact-based applicability and authenticated reuse, preserving full coverage for changed or unknown upgrade effects. Do not hide required rehearsal time outside the ten-minute measurement. |
| Same-cluster scratch is treated as isolation | Rewriting URLs and blanking credentials does not prevent a candidate script or privileged SQL from reaching another database, a local service or inherited credentials. Use an owned constrained execution environment with explicit database and outbound access boundaries. A separate cluster/process needs measured resource limits; it must not compete with the active service/build. Keep sensitive copies within the approved data boundary. |
| Scratch selected/deleted by name | A name containing `rehearsal` is insufficient ownership proof. Bind a unique run identifier, database identity and durable ownership marker. Refuse unknown databases; serialize runs; preserve failure evidence. Delete only the run's proven owned scratch. |
| Comparison excludes declared columns | A declaration must specify eligible row keys/predicate, precondition, exact intended relation/result and invariant checks. Excluding a whole money column can hide unrelated corrupted payslips. `may_grow` must preserve existing rows and constrain new rows, not merely allow a count increase. A new money column also needs correctness assertions; column intersection alone ignores it. |
| `must_change` on every execution | A correct idempotent backfill may have no eligible rows or may already be applied. Prove eligible-before rows are transformed as specified, ineligible rows remain unchanged, and a second application is safe. A mandatory arbitrary difference creates false failures. |
| All app-role counts must equal administrator counts | Real users can intentionally see a subset by company, role, delegation or employment. Define expected access per real context, plus denied cross-scope/no-context cases. Global catalogs and tenant-scoped tables need distinct expectations. Policy counts alone do not prove equivalent policy definitions, grants or ownership. |
| Historical NOT VALID constraints block every release | Report inherited violations separately from new or worsened violations; explicitly decide remediation and blocking policy. Do not silently validate or repair the live constraint. A rolled-back trial validation is useful evidence, but locking/timeouts and baseline exceptions must be controlled. |
| Snapshot-to-live drift accepted | State what concurrent writes are safe and enforce preconditions immediately before live application. Use the same code and ledger, plus a controlled write window or validated concurrent-writer compatibility for destructive/rewriting changes. The snapshot is not proof of later rows. |
| Backup implies rollback | The dump is one recovery point. Define tested recovery, access control, retention, encryption/off-host durability and treatment of writes since the snapshot. Restoring it alone loses later writes. Identity data and all other migration-owned schemas/databases need explicit coverage. |
| Old build assumed untouched after `built` | Current deployment builds in the active source tree before migration. A rehearsal failure after build is not proof that old `.next` bytes remain unchanged or every route still works. Require an independently built release directory/artifact and atomic activation before making that guarantee. HTTP 401 proves the root gate responds, not authenticated application readiness. |
| Emergency skip yields an ordinary green release | A bypass must remain an explicit exceptional, scoped and audited result. It cannot satisfy a required rehearsal claim or the normal complete-release performance goal. |

Blanking mail/identity/storage credentials is useful defense in depth, but not the execution boundary. PostgreSQL itself warns that restoring a dump executes code selected by the source's privileged owners: [pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html). Default database CONNECT privileges also require deliberate isolation: [privileges](https://www.postgresql.org/docs/16/ddl-priv.html).

## Safe sequence

1. Reconcile the current release baseline and inventory all actual release steps and dependencies, including identity and non-public schemas.
2. Implement and exercise a pure comparator and narrowly scoped declarations using synthetic adversarial fixtures, without touching the active release.
3. Prove owned execution, sensitive-data boundaries, cleanup and recoverability. Calibrate an unchanged candidate under a separately coordinated host resource window.
4. Compare the complete release path and resource cost. Define a versioned policy for when rehearsal is mandatory and what evidence can be reused.
5. Integrate the shared apply step and release evidence only after the above passes; retain existing tests, build and authenticated arrival requirements.

AI dev 2's current release is not changed by this review. The proposal's historical host/backup/constraint observations have not been re-read live here and must not be presented as current facts.
