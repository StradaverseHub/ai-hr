# Repository and environments

This file owns branch/environment policy. Owner decisions recorded 25–26 October 2026 remain in force until explicitly changed; query Git, CI and the target installation for current state.

## Repository and integration

Canonical source: [StradaverseHub/ai-hr](https://github.com/StradaverseHub/ai-hr). `main` is the default branch.

The owner instructed verified releases to be integrated into **both main and alpha at the same commit**, preserving history through normal merges and fast-forwards. This overrides older separate promotion timing. Do not force-reset branches or include unrelated WIP. Inspect/fetch both refs and their divergence before integration; do not treat either cached ref as automatically current.

```sh
git remote -v
git worktree list
git fetch origin main alpha
git rev-list --left-right --count HEAD...origin/main
git rev-list --left-right --count HEAD...origin/alpha
```

Worktree paths are local state discovered through Git. A folder name or an old Markdown pointer does not identify its branch or freshness.

## Environments and authority

| Branch | Role |
| --- | --- |
| alpha | Existing staging/internal-acceptance installation; private SSH alias aihr-staging, application /opt/ai-hr, service aihr. |
| main | Source for the separately provisioned future live installation; branch alignment does not create that installation. |
| Work branches | Isolated candidates based on a verified current integration ref. |

Deploy verified changes to staging first. Verify exact source/build arrival, migration ledger, restart/health and acceptance. **Production requires a subsequent explicit owner request.** A test result, tag, package or aligned branch is not deployment authorization. `.env.production` and Next production mode do not identify the live environment.

Preserve staging data and private target configuration. Read [operator access](../deploy/OPERATOR-ACCESS.md) before remote commands. Inspect release tooling's real target and coordinate with the current release owner. Determine installed source and build using `deploy/deploy-state.sh status` and independent arrival/service checks; an old commit or board-owner name in a note is not live evidence.

## Public-repository Actions capacity

Use standard public-repository GitHub-hosted runners only. The owner forbids paid larger runners and spending-limit increases. Inspect actual current runner resources, workflow, repository visibility and capacity before making performance/cost claims. [Actions procedure](ALPHA-STAGING-ACTIONS.md) and [CI policy](CI-STAGING-VERIFICATION-POLICY.md) own candidate dispatch and authenticated evidence. Inspect actual enable switches; this document grants no authority to enable automatic CD.

## Private production package distribution

Production packages, checksums, manifests and release notes belong only in private `StradaverseHub/ai-hr-releases`. Source tags identify the accepted commit and are mirrored unchanged. Follow [production packages](PRODUCTION-PACKAGES.md) only after explicit staging acceptance. Publication does not deploy or authorize database resets. Keep SSH configuration, installation secrets and private assets outside public source/artifacts.
