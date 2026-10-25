# Alpha/staging GitHub Actions

Repository and branch policy: [Repository and environments](REPOSITORY-AND-ENVIRONMENTS.md).

## Current rollout

`alpha-staging-ci` runs on GitHub-hosted Ubuntu runners. The workflow/controller is published on default `main`; it checks out the requested candidate separately, at an exact SHA, without modifying that candidate's tracked files. This allows the Board 3 pilot to run while `alpha` remains pinned to its verified deployed release. CI on `main` does **not** deploy main.

Staging environment branch policy permits only `alpha`. `STAGING_DEPLOY_ENABLED=false`, `PRODUCTION_DEPLOY_ENABLED=false`, and `STAGING_RELEASE_OWNER=board3-pending-verified-release`. This workflow has **no SSH/deployment credentials, deployment job or production target**. Its deployment-hold job verifies both switches remain disabled. Creating an environment is not activating deployment.

Board 3 retains its current release route and resource ownership. It must finish its verified release and cleanup before staging CD is enabled. Provisioning scoped deployment credentials, integrating the verified CI receipt with the release controller, and enabling a staging deployment workflow are the remaining cutover steps; they require the coordinated handoff. Main deployment stays disabled until the separate live installation is ready.

## Run the first pilot

After the release owner freezes and publishes a clean same-repository pilot branch:

```sh
gh workflow run alpha-staging.yml --repo StradaverseHub/ai-hr --ref main \
  -f candidate_ref=codex/board3-ci-pilot-20261025 \
  -f expected_sha=THE_EXACT_40_CHARACTER_CANDIDATE_COMMIT
```

The resolver refuses a moved branch, a different repository and invalid refs. `STAGING_DEPLOYED_SHA` must be the verified deployed staging baseline, used for append-only journal and unchanged applied-SQL checks. It is a migration baseline, not a test receipt.

Ready same-repository PRs targeting `alpha` and pushes to `alpha` are also declared triggers. **Those triggers become effective on alpha after its release owner integrates the workflow/helper files into that branch.** Publishing only the controller on main does not install workflows on alpha. During the coordinated freeze use the manual exact-commit dispatch above. Fork PRs and draft PRs do not run this workflow.

## What CI checks

- Whole-repository type check on Node 22 and production build on Node 20/Linux.
- Journal prefix and applied SQL bytes against the staging migration baseline.
- The candidate's existing deterministic DB classifier partitions every tracked Node/DOM test file across four no-DB and four DB jobs. No-DB jobs receive closed-port database URLs. DB jobs use separate 1 GiB PostgreSQL 16 containers on disposable runner disks and rebuild between batches of at most 64 files. They never contact the Mac or staging database.
- Existing browser suites run in Chromium, Firefox and WebKit. Runner-generated ignored config selects the actual engine while preserving candidate source.
- A final verifier refuses absent, duplicate, foreign-commit, skipped, failed or zero-test evidence, and checks every expected file and assertion count. Artifacts identify both candidate and controller commits. Matrix jobs do not stop the other jobs on failure.

`gate-evidence` is a **CI-only receipt**. It is not an unsigned local full-gate receipt and does not automatically satisfy the current official release policy. The pilot's actual execution, coverage, failures and Linux behavior must be reconciled by the release owner before CI can replace its release gate. Never manufacture a local PASS from this artifact or combine partial runs into a full PASS.

Node/DOM unit artifacts are retained for 14 days; the final CI receipt for 30 days. Staging secrets are absent from every verification job. Read actual workflow conclusions and artifact totals; a workflow being installed or dispatched is not a passing pilot.
