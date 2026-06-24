# ADR-0045 — Scheduled build → preview → gated-release agent (IL-4)

**Status:** Accepted · 2026-06-24
**Extends:** [ADR-0044](0044-improvement-loop.md) (operator-side improvement loop)
**Supersedes the deferred:** FB-4 (in-app autonomous build agent)

## Context

ADR-0044 built the first half of the operator-side improvement loop and it is now proven on real data:
`improve:pull` → multi-agent refine (`feedback-refine[-batch].workflow.js`) → `improve:push-plan`. Reporters
review the plan on the deployed app and `approve` it. The remaining half is the user's explicit request:

> "Create the pull all the way to build and release as a scheduled agent. Once run it will pull, build here
> and show in preview before releasing the code to the ssh server. Then go into the feedback and change the
> status to deployed."

So IL-4 is a **scheduled agent** that, on each run: pulls the feedback reporters have **approved**, builds each
change **here** (the operator environment, with the repo + tests + preview), and presents it in the **browser
preview** for a human to inspect — **before** anything is released to the server.

## The hard constraint: release stays human-gated

Autonomous code-writing on a timer is a real escalation. The safety envelope keeps it bounded:

1. **The deployed app never builds or deploys itself.** All build/release work happens here, under the
   operator's session and account. (Unchanged from ADR-0044.)
2. **Build is isolated.** Each approved item is implemented in its own `git worktree` off `main`, never on
   `main` and never touching the server. A failed or abandoned build leaves `main` untouched.
3. **Tests are the autonomous gate.** A build is only ever offered for review if `npx tsc --noEmit` **and**
   `pnpm vitest run` pass in its worktree. No green, no preview.
4. **Preview is the human gate.** The scheduled run stops at "built + green + preview running" and **notifies**
   a human. It does **not** release. A human opens the preview, reads the diff, and explicitly approves.
5. **Release is a separate, explicitly human-invoked step** (`improve:release`): rsync the worktree → server,
   `deploy.sh` (whose service-restart already needs the user's sudo), then `improve:mark-deployed` →
   status `deployed`. Never fired by the schedule.
6. **Substrate stays whole.** `build.started` / `build.completed` (agent actor, ADR-0043 transitions) are
   appended on the server as the item moves; `feedback.deployed` on release.
7. **PII-redacted** plans only (the plan text was already redacted at draft time).

So the *schedule* automates discovery + build + verification + preview. The *human* still owns the
irreversible, outward-facing release. "Show in preview before releasing" is exactly this gate.

## Shape

```
  ┌─── scheduled, read-only (launchd, every 4h) ───┐
  │  watch-approved.sh: improve:pull-approved       │
  │  if any approved → macOS notification            │   no agent, no gates-off, no build, no release
  └──────────────────────┬──────────────────────────┘
                         │  "N items approved — open Claude to build"
        ── human opens a Claude session (everything below is permission-gated) ──
                         │
  build:   Workflow(build-approved) → per item: worktree + implement + tsc+vitest gate
           mark build.started/completed on the server → patch + summary
  review:  preview_start(worktree) → inspect the change in the browser + read the diff
  gate:    human approves  ─────────────────────────────────────────────┐
                                                                         ▼
  release: improve:release  →  rsync worktree → server → deploy.sh → improve:mark-deployed
                                                          (status → deployed)
```

## Components

- **`scripts/improve/build-approved.workflow.js`** (IL-4 build phase) — given the approved items (from
  `improve:pull-approved`), runs one **build agent per item** (`agent({isolation:'worktree'})`) that
  implements that item's plan, then runs `tsc` + `vitest`, returning `{ id, branch, status, testsPass,
  diffstat, summary }`. Items that fail the gate come back `status:'failed'` and are **not** offered.
- **`scripts/improve/build.ts` + `improve:build`** — the operator entry point the cron calls. Pulls approved,
  invokes the build workflow, marks `build.started`/`build.completed` on the server, writes a review manifest
  (`/tmp/improve-builds.json`: worktree path + branch + diff per item), and prints a preview-ready summary.
- **`scripts/improve/release.ts` + `improve:release <id>`** — the **human-gated** release: validates the
  worktree is green, rsyncs it → server, runs `deploy.sh`, and calls `markDeployed`. Refuses without an
  explicit item id; never run by the schedule.
- **The schedule** — `scripts/improve/watch-approved.sh`, a **read-only** `launchd` job (every 4h) that
  polls `improve:pull-approved` and posts a macOS notification when anything is approved. It runs **no agent**
  and bypasses **no permission gate** — it neither builds nor releases. The operator sees the notification,
  opens a Claude session, and runs the build phase (then previews, then releases) **interactively**, where
  every code-writing and outward action is permission-gated normally.

  > **Why not a headless autonomous build on the timer?** That was the original design (a `launchd` job
  > running `claude -p --permission-mode bypassPermissions`), but standing up an unattended agent with all
  > approval gates off is a security escalation the operator must opt into explicitly, not a default. The
  > watch-and-notify trigger keeps the 24/7 awareness without the gates-off agent; the build still happens,
  > just in a supervised session. The headless wrapper can be reintroduced behind an explicit opt-in if
  > always-on autonomy is later wanted.

## Why a worktree per item (not edit-in-place)

Parallel isolation: several approved items can build concurrently without colliding, and `main` is never
dirtied by an in-flight or failed build. The worktree is the unit the human previews and the unit
`improve:release` ships — a clean 1:1 from "what I reviewed" to "what shipped."

## Consequences

- The operator can leave the loop scheduled; it surfaces *built, green, preview-ready* changes on its own,
  but cannot ship anything without a human looking at the preview and approving.
- Build quality is bounded by the plan quality (already adversarially refined) **and** the test suite. Weak
  test coverage on a touched area is the main residual risk — the build agent is instructed to add tests per
  its plan, and the human preview is the backstop.
- If a build can't go green, it is reported as failed and left for a human to take over in its worktree;
  the loop never ships red code.
