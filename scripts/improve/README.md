# Operator-side improvement loop — runbook

The loop runs **here** (this repo + SSH + DB), never inside the deployed app. See
[ADR-0044](../../docs/adr/0044-improvement-loop.md) (plan half) and
[ADR-0045](../../docs/adr/0045-scheduled-build-release-agent.md) (build/release half).

```
deployed app:  capture feedback + reporter review ONLY
operator loop: pull → refine → push   |   pull-approved → build → preview → [HUMAN] release → deployed
```

## Config (env, defaults match the gated demo)

`IMPROVE_SSH_HOST` (10.20.30.20) · `IMPROVE_SSH_PORT` (8288) · `IMPROVE_SSH_USER` (ubuntu) ·
`IMPROVE_REMOTE_DIR` (/opt/ai-hr). psql runs **on the server** sourcing its own `.env.production`, so DB
credentials never leave the box — only SQL goes up, JSON/rows come back, over key-based SSH.

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
`release` = final gate (`tsc` + `vitest` in the worktree) → rsync worktree → server → `deploy.sh` →
`markDeployed` (status → `deployed` + `feedback.deployed` event). Then, manually:
`sudo systemctl restart aihr` on the server, and `git checkout main && git merge --no-ff build/fb-<id>` here.

## The schedule (24/7 watch + notify)

`watch-approved.sh` is a **read-only** `launchd` job (every 4h) that polls `improve:pull-approved` and posts
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
