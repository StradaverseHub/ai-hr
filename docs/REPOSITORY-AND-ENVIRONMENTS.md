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
| main | Source for the separate production installation; see the [25–26 October commissioning record](PRODUCTION-DEPLOYMENT-RECORD.md). Branch alignment does not deploy that installation. |
| Work branches | Isolated candidates based on a verified current integration ref. |

Deploy verified changes to staging first. Verify exact source/build arrival, migration ledger, restart/health and acceptance. **Production requires a subsequent explicit owner request.** A test result, tag, package or aligned branch is not deployment authorization. `.env.production` and Next production mode do not identify the live environment.

Preserve staging data and private target configuration. Read [operator access](../deploy/OPERATOR-ACCESS.md) before remote commands. Inspect release tooling's real target and coordinate with the current release owner. Determine installed source and build using `deploy/deploy-state.sh status` and independent arrival/service checks; an old commit or board-owner name in a note is not live evidence.

## Verification recovery — owner decision, 30 October 2026

After a complete frozen gate has run, **rerun only failed areas and checks invalidated by a repair**. Retain valid successful evidence; do not start a new complete gate merely because one job failed. The owner reaffirmed this in the Board chat: “We should not run a fresh gate, we should only run the areas where it fails.” This recovery decision supersedes older blanket fresh-whole-run instructions for that situation. Let all already-planned chunks finish before repairing or retrying.

A broader run needs a concrete coverage/identity invalidation or an explicit new owner decision, not a default retry rule. Preserve original failures, successful job/artifact identities, exact source/controller/baseline, runtime, complete coverage and independent final verification. Never relabel a failed workflow, manufacture a PASS, or silently treat focused development evidence as deployment authority.

The existing CI resume assessors are scheduling-only; the current operator verifier does not yet adopt focused recovery as a release witness. Record that tooling gap and implement/review authenticated recovery rather than wasting another full run or bypassing verification. See [CI recovery policy](CI-STAGING-VERIFICATION-POLICY.md#owner-recovery-decision--30-october-2026) and [ADR-0114](adr/0114-impact-aware-release-and-learning.md#owner-clarification--30-october-2026).

## Public-repository Actions capacity

Owner direction reaffirmed 30 October 2026: GitHub Actions has removed the Mac as the shared verification bottleneck. Run builder/focused checks, application tests, whole-repository type checks and release verification on GitHub-hosted runners. Use `.github/workflows/alpha-focused-checks.yml` for development checks on frozen owned branches; release evidence must satisfy the authenticated CI policy. Include this execution route in builder briefs. Local slots are a temporary fallback while the Actions controller is broken; resume hosted verification when it is repaired, stopping only the local verification processes owned by that session. Local admission rules still apply during that fallback. This direction is not a claim that the end-to-end release performance goal has been met.

Use standard public-repository GitHub-hosted runners only. The owner forbids paid larger runners and spending-limit increases. Inspect actual current runner resources, workflow, repository visibility and capacity before making performance/cost claims. [Actions procedure](ALPHA-STAGING-ACTIONS.md) and [CI policy](CI-STAGING-VERIFICATION-POLICY.md) own candidate dispatch and authenticated evidence. Inspect actual enable switches; this document grants no authority to enable automatic CD.

## Shared staging queue — owner decision, 30 October 2026

Use the [shared staging queue and lease](STAGING-RELEASE-QUEUE.md) across AI and operator sessions. One controller owns installation, acceptance and required capture; prepare and verify aggregate candidates outside the staging window. Start with up to three ordinary migration-free members, isolate higher-risk changes, and preserve every existing release safeguard. Commissioning and actual pilot evidence are separate from source implementation; legacy clients must adopt the guarded protocol.

## Private production package distribution

Production packages, checksums, manifests and release notes belong only in private `StradaverseHub/ai-hr-releases`. Source tags identify the accepted commit and are mirrored unchanged. Follow [production packages](PRODUCTION-PACKAGES.md) only after explicit staging acceptance. Publication does not deploy or authorize database resets. Keep SSH configuration, installation secrets and private assets outside public source/artifacts.
