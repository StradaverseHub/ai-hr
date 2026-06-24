# ADR-0044 — Operator-side improvement loop (feedback → multi-agent plan → build → gated release)

Status: Accepted · 2026-06-24 · Owner request · Supersedes the in-app planner of ADR-0043 (FB-3)

## Context

ADR-0043 shipped feedback **capture + review** in the app and a single-shot **in-app** planning agent
(FB-3). The owner wants the intelligence to live **outside** the deployed app, in the operator
environment (this repo + SSH + DB access), where it can do far more than one model call: pull feedback
from the server, draft a plan, **spawn multiple subagents to adversarially refine it**, push the refined
plan back for the reporter to review, and — once approved — **build and release** the change and mark the
item `deployed`.

This is strictly better on two axes:
- **Capability** — multi-agent refinement + real repo context + the test suite beat a single in-app call.
- **Safety** — the app never writes its own code. The autonomous build happens in the operator's
  environment under a human's session, isolated in a git worktree, gated by `tsc` + tests, and the
  **release is human-confirmed** (deploying to the live demo is outward-facing).

## Decision

The deployed app stays **capture + review only**. The **in-app planner is disabled** (gated
`FEEDBACK_AI_PLANNING_ENABLED`, default off; IL-1). A loop run **here** does the rest:

```
SERVER (deployed app)                         OPERATOR LOOP (here)
feedback_request                              scripts/improve (ssh + psql)
  open / contested  ──── pull ──────────────→  draft plan
                                                  ↓  Workflow: spawn N subagents to REFUTE the plan
                                                  ↓  synthesize → refined plan
  plan, status=planned  ←── push ─────────────  (feedback.plan.drafted, agent actor)
  (reporter approves)   ──── pull approved ───→  build in an ISOLATED git worktree
                                                  ↓  tsc + vitest must pass → PR
                                                  ↓  RELEASE  ← HUMAN-CONFIRMED (deploy.sh)
  status=deployed       ←── mark deployed ─────  (feedback.deployed, agent actor)
```

### Components
- **IL-1 (done)** — disable the in-app planner (`generateFeedbackPlan` throws unless
  `FEEDBACK_AI_PLANNING_ENABLED=true`; the admin "generate now" button hides). Add the `deployed`
  feedback status (migration 0094) + `markFeedbackDeployed`.
- **IL-2 — plumbing** (`scripts/improve/`): pull (open/contested) feedback from the **server** DB, push a
  plan back (UPDATE + a `feedback.plan.drafted` `domain_event`, preserving the substrate), pull
  `approved` items, and `markDeployed`. All via `ssh` + `psql` running **on the server** with its own
  `.env.production` — credentials never leave the box (the same pattern used to verify migrations).
- **IL-3 — the planning workflow** (`.claude/workflows/feedback-refine.js`): for one feedback item,
  `draft → parallel adversarial critics (correctness / scope-creep / missing-edge-cases / simpler-way) →
  synthesize a refined plan`. This is the "spawn multiple subagents to fight back" step; it runs as a
  Workflow (the owner explicitly asked for multi-agent orchestration).
- **IL-4 — build + gated release**: for each `approved` item, an operator session implements the plan in
  a fresh worktree, runs `tsc` + tests, opens a PR. **Release (`deploy.sh`) is a separate, human-confirmed
  step** — never auto-fired. On release, `markDeployed` closes the item.

### Safety invariants (non-negotiable)
1. The deployed app never modifies or deploys itself — it only stores feedback + the plan, and shows
   status. All code-writing happens in the operator environment.
2. Build is autonomous up to a **PR**; tests must pass before the PR exists. **Release is human-gated.**
3. Every loop write to the server (plan, deployed) appends a `domain_event` with an `agent` actor — the
   audit substrate stays whole across the boundary.
4. Plans are PII-redacted before any model call (reuse `redactPII`).

### Bootstrapping dependency
The loop pulls from `feedback_request` on the **server** — so the feedback module (migrations 0093/0094)
must be **deployed** before the loop has anything to pull. Deploying it is the enabling step.

## Consequences
- The app is a clean capture/review surface; the heavy, evolving intelligence lives in the repo where it
  can use multi-agent orchestration + the real test suite, and improves without redeploying the app.
- The autonomous-build risk is contained: isolated worktree, test-gated, PR-shaped, human-confirmed
  release. The app is never self-modifying.
- Out of scope (later): a fully headless scheduler for the loop (today an operator triggers each run); a
  build agent that runs its own fix-the-tests sub-loop; auto-closing the item from the merged PR webhook.
