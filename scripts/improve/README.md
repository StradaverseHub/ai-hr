# Operator-side improvement loop — runbook

The loop runs **here** (this repo + SSH + DB), never inside the deployed app. See
[ADR-0044](../../docs/adr/0044-improvement-loop.md) (plan half) and
[ADR-0045](../../docs/adr/0045-scheduled-build-release-agent.md) (build/release half).

```
deployed app:  capture feedback + reporter review ONLY
operator loop: pull → refine → push   |   pull-approved → build → preview → [HUMAN] release → deployed
```

## Config

Follow [Operator access](../../deploy/OPERATOR-ACCESS.md). The default SSH destination is the private
`aihr-staging` alias; OpenSSH supplies its actual address, username, port and key. Optional
`IMPROVE_SSH_HOST`, `IMPROVE_SSH_PORT`, `IMPROVE_SSH_USER` and `IMPROVE_REMOTE_DIR` overrides remain
available. The default remote application directory is /opt/ai-hr. Database credentials remain on
the server; only SQL and results travel over SSH.

## Phase A — plan (proven)

```bash
pnpm improve:pull                      # → JSON array of open/contested feedback from the server DB
```
For each item, refine a plan with the adversarial panel, then push it back:
```
Workflow({ scriptPath: 'scripts/improve/feedback-refine.workflow.js',       args: <one item> })
Workflow({ scriptPath: 'scripts/improve/feedback-refine-batch.workflow.js', args: <pull array> })   # whole backlog
# extract result.plan → { id, tenantId, reporterEmploymentId, plan, model }:
echo '<payload>' | pnpm improve:push-plan      # UPDATE → planned + feedback.plan.drafted (agent event)
```
The reporter reviews on `/feedback` and `approve`s (or `contest`s → re-plan).

## Phase B — build (scheduled, ADR-0045)

Run by the cron, or by hand. **Builds nothing on the server; releases nothing.**
```bash
pnpm improve:pull-approved             # → JSON array of approved feedback (plan attached)
```
```
Workflow({ scriptPath: 'scripts/improve/build-approved.workflow.js', args: <approved array> })
# → [{ id, testsPass, patch, diffstat, summary, blockers }]  — one worktree build per item, gated on tsc+vitest
```
For each **green** item, log the build transitions on the server and stage it for preview:
```bash
echo '{"id","tenantId","reporterEmploymentId"}'            | pnpm improve:build-start    # → building
echo '{"id","tenantId","reporterEmploymentId","buildRef"}' | pnpm improve:build-complete # → done
# apply the patch to a fresh preview worktree, then:
preview_start(<worktree>)               # show the change in the browser
```
Then **notify a human** — Phase B stops here. Red builds are reported (status stays `approved`), never shipped.

## Phase C — release (HUMAN-GATED, never scheduled)

A human reviews the preview + the diff, then:
```bash
echo '{"id","tenantId","reporterEmploymentId","worktree","branch","buildRef"}' | pnpm improve:release
```
`release` = final gate (a `.gate-receipt.json` covering HEAD — it never runs vitest itself, ADR-0094 — then `tsc`) → rsync worktree → server → `deploy.sh` →
`markDeployed` (status → `deployed` + `feedback.deployed` event). Then, manually:
`sudo systemctl restart aihr` on the server, and `git checkout main && git merge --no-ff build/fb-<id>` here.

## The schedule (24/7 watch + notify)

`watch-approved.sh` is a **read-only** `launchd` job (hourly) that polls `improve:pull-approved` and posts
a macOS notification when anything is approved. It runs no agent and bypasses no permission gate — it does
**not** build or release. On the notification, open a Claude session and run Phase B → preview → Phase C
interactively (permission-gated).

```bash
cp scripts/improve/com.aihr.improve-build.plist ~/Library/LaunchAgents/
launchctl load   ~/Library/LaunchAgents/com.aihr.improve-build.plist   # enable
launchctl start  com.aihr.improve-build                                 # run once now
launchctl unload ~/Library/LaunchAgents/com.aihr.improve-build.plist   # disable
```
Logs: `.improve/watch.log` (+ `.improve/launchd.{out,err}.log`). SSH key must be usable non-interactively
(BatchMode) for the poll to reach the server.

> A fully autonomous headless build on the timer (`claude -p --permission-mode bypassPermissions`) was
> considered and deliberately **not** enabled: an unattended agent with gates off is an explicit opt-in, not
> a default (see ADR-0045).

## Environment-specific feedback release milestones

The feedback list and Kanban show review/build status and three explicit release milestones.
The existing `deployed` enum remains compatible with review/refute actions. A nullable `release`
record on that same RLS-protected feedback row owns the environment claim; an append-only
`feedback.release.recorded` event preserves each milestone. Historical `deployed` items display
**Deployment unverified** until an operator checks their environment. No historical item is
inferred to be in production, and `done` means built, not ready for production.

After independently verifying the target, use `pnpm improve:record-release` with JSON on stdin:

```json
{
  "id": "FEEDBACK_UUID",
  "tenantId": "TENANT_UUID",
  "reporterEmploymentId": null,
  "stage": "staging",
  "sourceSha": "FULL_LOWERCASE_40_CHARACTER_SHA",
  "buildId": "EXACT_INSTALLED_BUILD_ID",
  "buildRef": "REVIEWED_PR_OR_COMMIT_REFERENCE",
  "evidence": "NON_SECRET_RELEASE_RECORD_REFERENCE"
}
```

Use the actual reporter employment UUID when present. `null` is only for an existing user-only
report. Select the private connection to the database that owns this board; a milestone about a
production target is still recorded in that board database. Do not copy credentials, private
hostnames, package assets or acceptance transcripts into `evidence`. It is a non-secret pointer
readable to people authorized to read the item.

Record `staging` only after exact source/build arrival, migrations and health checks. Then record
`production_ready` only after explicit human staging acceptance **and** verification of the matching
published private production package. Finally record `production` only after separately authorized
production installation and independent arrival/health/acceptance checks. See
[release handoff](../../docs/PRODUCTION-RELEASE-HANDOFF.md). This command records the operator's
attestation; it does not inspect targets, grant acceptance, publish a package or perform deployment.

The latter two transitions require the preceding milestone for the identical source, build and
feedback cycle. Recording a new staging build replaces current progress; audit events retain history.
Replanning, reopening or changing the build cannot carry old production evidence into the new cycle.
Legacy `mark-deployed` clears current release evidence and therefore returns to **Deployment unverified**.
No release controls or drag-to-deploy actions are exposed to reporters.
