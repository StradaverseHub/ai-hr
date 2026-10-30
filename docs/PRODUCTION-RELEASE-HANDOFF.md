# Production release handoff for Claude and operators

Owner: repository/release owner. Use for release planning, staging acceptance, production package publication or live installation. Reviewed against source on 28 October 2026; this document records the procedure, not a new deployment or acceptance.

## Start here

Read this checkout's `CLAUDE.md` and [repository/environment policy](REPOSITORY-AND-ENVIRONMENTS.md). That policy owns authority; [production packages](PRODUCTION-PACKAGES.md) owns publication; [operator access](../deploy/OPERATOR-ACCESS.md) owns private connections. For the actual two-VM installation performed on 25–26 October, read the [production deployment record](PRODUCTION-DEPLOYMENT-RECORD.md). Resolve disagreements through those owners and current code before acting.

The implemented flow is:

```text
frozen candidate → verified gate → staging arrival/restart/migrations
→ human staging acceptance of SHA + build ID
→ private production packages
→ separately requested production installation → live acceptance
```

`scripts/releases/approve_staging.py` already implements acceptance-to-package publication. Reuse it. It captures the existing Linux x64 staging build rather than rebuilding on the Mac. It does not install production. A `prod-*` tag or published package therefore proves neither a live installation nor a successful customer login.

## 1. Establish the candidate and target

From the checkout discovered through `git worktree list`:

```sh
pwd
git rev-parse --show-toplevel
git branch --show-current
git status --short
git worktree list
git fetch origin main alpha
git rev-list --left-right --count HEAD...origin/main
git rev-list --left-right --count HEAD...origin/alpha
```

Preserve WIP and use an owned worktree for integration. Record the full candidate SHA, controller SHA where applicable, actual target and scope authorized by the owner. Verified releases are integrated into main and alpha at the same commit through normal merges/fast-forwards; inspect current divergence and coordinate with the active release owner. Publication separately checks that the accepted SHA remains in both published histories even when heads subsequently advance.

The existing `aihr-staging` alias, `/opt/ai-hr` and `aihr` service identify staging. Production needs its own verified installation/access details. `.env.production`, a Next production build and a main-branch checkout do not identify the live target.

**Complete when:** source/base, target, release ownership and authorized scope are explicit. If asked only for a plan or handoff, produce that artifact without invoking deployment or acceptance commands.

## 2. Verify and accept staging

Use [impact-aware release policy](adr/0114-impact-aware-release-and-learning.md), [CI verification](CI-STAGING-VERIFICATION-POLICY.md) and the actual candidate/controller tooling. Current CI adoption/witness status must be verified; a prepared controller or diagnostic run supplies no release authority. For local gates, follow `CLAUDE.md` and [resource admission](LOCAL-RESOURCE-LOCKS.md). Keep original failed evidence and apply the validated repair/reuse rules.

Use the authorized staging route described in those documents. After deployment, query status with the same private SSH configuration used by the release tool:

```sh
ssh -F /ABSOLUTE/PRIVATE/ssh_config aihr-staging \
  'cd /opt/ai-hr && deploy/deploy-state.sh status'
```

Verify `state=ok`, matching accepted source/built refs and build IDs, `stale_build=0`, active service, restart after the build, loopback health, canonical source arrival, and the complete ordered migration hashes/watermark. Perform the changed rendered journeys and relevant permission/failure checks. A successful build or HTTP 200 alone is insufficient. Preserve staging data; separately verify any required one-shot data script.

**Complete when:** the release owner accepts the exact full SHA and running build ID, with original gate/arrival/walkthrough evidence retained privately. A rebuild of the same SHA creates a different acceptance target. For a CI-installed build, the original validated witness, installation grant and launch record are under the release controller's ignored `scratchpad/validated-ci-<run>-<uuid>/` directory written by `operator-release.mjs`; use those originals as acceptance evidence. Keep the acceptance/capture window exclusive using the [shared staging lease](STAGING-RELEASE-QUEUE.md) once commissioned. Retain the same private lease credential through package capture and explicit handback; never release it when the deployment watcher disconnects.

## 3. Publish the accepted build using the existing publisher

Run from a trusted controller checkout containing the reviewed publisher and exact accepted commit. It needs Python 3.9+ with timezone data, Git, OpenSSH and locally authenticated `gh`; application dependencies and a local database are unnecessary. The selected GitHub account needs contents write access to the source and private release repositories. Select an already authenticated account per process with `--github-account`; keep shared login state intact.

Read-only preflight (replace all uppercase placeholders with verified values):

```sh
python3 scripts/releases/approve_staging.py \
  --check \
  --github-account ACCOUNT_WITH_ACCESS \
  --ref FULL_ACCEPTED_40_CHARACTER_SHA \
  --build-id EXACT_ACCEPTED_BUILD_ID \
  --ssh-config /ABSOLUTE/PRIVATE/ssh_config \
  --staging-alias aihr-staging
```

After explicit human staging acceptance, publish the same source/build:

```sh
python3 scripts/releases/approve_staging.py \
  --accept-staging \
  --github-account ACCOUNT_WITH_ACCESS \
  --ref FULL_ACCEPTED_40_CHARACTER_SHA \
  --build-id EXACT_ACCEPTED_BUILD_ID \
  --ssh-config /ABSOLUTE/PRIVATE/ssh_config \
  --staging-alias aihr-staging \
  --approval-evidence /ABSOLUTE/PRIVATE/original-acceptance-evidence.json \
  --output-root /ABSOLUTE/PRIVATE/durable-production-releases
```

`--accept-staging` records approval and writes GitHub tags/releases; use it only within that authorization. Include `--owner-exception` only for an explicitly approved exception and retain its actual scope. The evidence file's existence/hash is not an independent verification of the application gate.

The publisher checks source/build/service/dependency identity, captures Linux runtime bytes, audits archive contents, reserves `prod-YYYY-MM-DD.N` in Asia/Kuala_Lumpur, mirrors the identical annotated source tag, uploads to a private draft and verifies asset sizes/digests before publication. The five-asset contract and all refusal rules remain in [PRODUCTION-PACKAGES.md](PRODUCTION-PACKAGES.md).

**Complete when:** publication is confirmed in private `StradaverseHub/ai-hr-releases`, the immutable source/tag/build identities and complete verified asset inventory are recorded, and the private local checkpoint is retained. Report this as **package published; production deployment not performed**. Assets and release notes stay out of the public source repository.

## 4. Install production only for the separately authorized live release

First verify the target's private SSH alias/origin, service identity, installed SHA/build, Node compatibility, authentication provider, migration ledger and backup/restore readiness. The [production deployment record](PRODUCTION-DEPLOYMENT-RECORD.md) documents a separate live installation commissioned on 25–26 October; verify its current runtime state before selecting an update baseline.

Prepare a target-specific maintenance, installation, rollback and acceptance plan from the exact package manifest. [DEPLOY.md](../deploy/DEPLOY.md) describes legacy demo operations; [CUSTOMER.md](../deploy/CUSTOMER.md) contains older Keycloak commissioning steps. Resolve authentication through `CLAUDE.md`, [ADR-0117](adr/0117-embedded-hr-authentication.md) and the [embedded-auth guide](../deploy/internal-auth/README.md): the owner-selected direction is `AUTH_PROVIDER=internal`. Inspect the actual candidate preflight/tooling for compatibility before executing an older installer. A guide's existence does not prove its Linux installation path passed acceptance.

The package contract extracts both source and Linux runtime archives into the same application release directory; provide compatible Node and private target configuration separately. It supplies no tested universal atomic installer. Review whether the chosen deployment command rebuilds, migrates or restarts before using it. Preserve the customer database and stable encryption/session keys; use customer-safe operations and apply pending migrations with the designated migration identity. Demo seeding and reseeding are outside this update procedure.

Retain the actual prior release and matching database/key/configuration backups. Code rollback uses that retained compatible release, not an assumed previous main commit. Schema rollback requires the reviewed restore path or an approved forward repair; migrations have no general down-migration path.

**Complete when:** the authorized live target independently proves source/build arrival, migration integrity, restart/health and real login/MFA plus changed workflows, including denied access. Record owner acceptance and remaining limitations. Keep package publication, staging acceptance and live acceptance as separate claims.

## Recovery and handback

| Observation | Next action |
| --- | --- |
| Private release repository cannot be resolved | Check the selected account's existing access and repository identity; use the private destination required by package policy. |
| Staging SHA matches but build ID changed | Inspect the new build and obtain acceptance for it before publication. |
| Staging was redeployed to another SHA after acceptance | The earlier acceptance can no longer be packaged. Accept the build now running, or coordinate a redeploy of the accepted candidate and accept that new build. |
| Default `gh` account gets 404 for the private release repository | Pass `--github-account` for an already authenticated account with access; do not switch the shared login. |
| Publisher refuses `Absolute archive link` | Inspect the link on staging. CI-installed builds (`.github/ci/build-bundle.py`) link Next's `sharp`/`fontkit` aliases under `.next/node_modules` to absolute paths. Do not edit the accepted staging build; repair the publisher or installer through the gate, then rerun with the same acceptance if the build is unchanged. |
| Deploy is running or connection drops | Reconnect to deployment state/logs; establish whether the existing detached operation finished before starting another. |
| Deploy is failed, stale or incomplete | Preserve logs, diagnose and repair; establish a complete compatible build before restart. |
| Publisher interrupted | Resume with identical SHA, build ID, evidence, approval kind and output root. Preserve the checkpoint and prepared bytes. |
| Existing asset differs or checkpoint is lost | Inspect the private draft/tag and recover deliberately under package policy; preserve published assets/tags. |

Hand back: authorized scope; target; candidate/controller SHA; gate evidence and exceptions; staging source/build/migration/acceptance evidence; private tag/release URL and manifest; checkpoint location; production installed/accepted or not performed; remaining blockers. Keep credentials and private evidence contents out of public commits.

For a documentation-only handoff, check relative links, command flags against the actual CLI, and `git diff --check`. Publisher regression tests are documented in [PRODUCTION-PACKAGES.md](PRODUCTION-PACKAGES.md); running them does not perform a release.
