# Repository and deployment environments

Owner decision: 25 October 2026 (Asia/Kuala_Lumpur). This document owns the repository and branch-to-environment policy. Read it before changing Git remotes, CI/CD, release targets or branch roles.

## Current branch integration instruction

Owner override: 25 October 2026, after the verified Board 3 staging release. The owner instructed: “Can merge to main also, make alpha and main the same commit. For now, merge to this two branch, until i tell you to stop in the future”.

Until the owner revokes this instruction, integrate each verified release into both `alpha` and `main`, keeping both published branch heads at the same commit. Preserve existing history through normal merges and fast-forward pushes; do not force-reset either branch or include unrelated uncommitted work. This supersedes the earlier instruction to withhold Board 3 and later releases from `main` and the table's separate promotion timing. The existing host remains staging; the separate live installation remains unprovisioned. Branch alignment does not authorize an additional deployment or enable deployment automation.

## Repository

The sole canonical repository is **https://github.com/StradaverseHub/ai-hr** (public, GitHub organization `StradaverseHub`, repository ID `1333414856`). The earlier `zenlam/ai-hr` and personal-account `stradaverse-hub/ai-hr` locations are historical; use the organization URL for every new clone, push, pull request and CI integration.

```sh
git remote set-url origin https://github.com/StradaverseHub/ai-hr.git
```

## Public-repository Actions capacity

On 26 October 2026 the owner made this repository public; authenticated GitHub metadata confirmed `visibility=PUBLIC` and `isPrivate=false`. [Standard GitHub-hosted Actions are free for public repositories](https://docs.github.com/en/billing/concepts/product-billing/github-actions), so the earlier private included-minute hold is superseded for these runs. Use standard runners only: larger runners remain separately billed, and artifact/cache storage has separate allowances. No paid capacity or billing-setting change is authorized by this visibility change.

[Standard public Ubuntu runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) provide four CPUs and 16 GB RAM. Record actual execution resources and timings; results from the earlier private runners do not prove current performance. The existing complete-coverage, release-coordination and staging/main deployment rules remain in force.

## Branch and environment roles

| Branch | Environment | Target |
|---|---|---|
| `alpha` | Staging / internal acceptance | The existing server, previously called production: `ubuntu@203.142.6.241:8288`, application `/opt/ai-hr`, service `aihr`, application listener `127.0.0.1:3000`. |
| `main` | New production / live | Reserved for the separate live installation that the owner will set up. Its host, URL, database, credentials and deployment integration are not established by this decision. |
| `codex/*` and other work branches | Isolated development | Target `alpha` for staging integration; promote a verified release to `main` for the future live environment. |

Keep `main` as the repository default branch. Reserving it for production does not mean deleting its history, emptying the branch or resetting existing work. Staging acceptance and live promotion remain distinct actions.

The name `.env.production`, Next.js production build mode, an old runbook saying "production", and a healthy running service do not identify the new live environment. The existing host is now designated **staging** by the owner. Preserve its existing database and data while changing this designation.

## Transition and release coordination

**Owner deployment rule — 26 October 2026.** Deploy verified changes to staging first and verify
staging acceptance. Production deployment requires a subsequent explicit request from the owner.
A staging deployment, successful checks, branch alignment, tag or package publication does not
authorize production deployment. After staging verification, stop and report the result.

- `alpha` starts from the existing host's verified deployed application commit **`c98bfed60f6330b57f5a67d959ce6e3757df3b53`**, not from an unshipped development candidate. Read-only server evidence on 25 October 2026 showed `ref=built_ref` at that commit, build ID `dhL_pFtVUIgHtI832fI05` and `stale_build=0`. This is the initial baseline, not a permanent claim about the current deployment. Documentation commits may advance `alpha` without deploying application code.
- Board 3 owns the in-flight verification, server release and Mac resource window. Coordinate its eventual deployment to the existing host as a **staging / alpha** release. Its owner will reconcile the alpha ref and local WIP before integrating the verified candidate; the former automatic merge-to-main step is superseded by this branch decision.
- Branch creation/publication and this document do not restart services, move data, provision the new live host, configure GitHub environments or enable deployment workflows. No runtime or infrastructure cutover is implied by a Git push.
- Until release tooling has explicit environment selection, inspect its real target and coordinate with the release owner. Historical commands in `CLAUDE.md` and `deploy/DEPLOY.md` describe the existing host; their old main-to-production assumptions are superseded here. Never interpret a `main` release as permission to deploy to that host.
- Before enabling automated deployment, bind `alpha` explicitly to staging and `main` explicitly to the new live environment. Configure separate hosts, databases, credentials/secrets and GitHub environment approvals as appropriate to each installation. Preserve the existing gate, migration, backup, arrival and health verification requirements.

## Evidence for future builders

Treat this file as the durable owner decision, and query live state for implementation facts:

```sh
git remote -v
git ls-remote --symref origin HEAD refs/heads/alpha refs/heads/main
```

For the existing server, its `deploy/deploy-state.sh status`, active service and verified source/build arrival determine what is actually running. A branch head or a Markdown note alone is not deployment proof. The new live environment remains pending until its installation and successful deployment are independently verified.

## GitHub Actions rollout

Read [Alpha/staging Actions](ALPHA-STAGING-ACTIONS.md) for exact-commit CI dispatch, coverage and the explicit staging deployment hold during Board 3. Main deployment remains disabled.
