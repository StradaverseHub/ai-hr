# ADR-0043 — In-product feedback → AI-plan → review → build loop

Status: Accepted · 2026-06-24 · Owner request (new strategic module)

## Context

Today product feedback lives outside the app (a consultant spreadsheet). We want it **in** the product:
any user logs feedback (a bug, an enhancement to an existing function, or a brand-new function),
describes the expected behaviour / expected function, and attaches supporting documents + images. Then an
**AI agent** periodically reads new feedback and writes a **detailed implementation plan** tied to that
item; the **person who raised it** reviews the plan, can **push back** (contest it, so the agent re-plans),
and on **approval** an agent **builds** it. This is the in-product realisation of the project's "autonomous
improvement loop" ambition.

Two existing facts make this tractable:
- **The AI gateway already exists** (ADR-0023): `lib/ai` `generateDraft(cfg, {system, prompt, maxTokens})`
  over `@anthropic-ai/sdk` (default `claude-opus-4-8`, adaptive thinking), per-tenant encrypted keys via
  `resolveActiveAiConfig`, and `redactPII()`. The performance module already drives it with an `agent`
  actor. The planning agent reuses this verbatim — no new AI plumbing.
- **The substrate already supports an `agent` actor** (`actor_type` enum includes `'agent'`), so every
  plan write/build step audits cleanly into the domain-event log.

## Decision

A `feedback_request` on the same request → review rails as claims/resignation, with a status machine the
**AI planning agent** and (later) the **build agent** advance, and a reporter-only review gate.

### Data model
- **`feedback_request`** — `reporter_employment_id` (denormalised for RLS) + `reporter_user_id` (the
  review gate), `category` (`issue` | `enhancement` | `new_function`), `title`, `description`,
  `expected_behavior`, `expected_function`, `status`, `plan` (markdown, agent-written), `plan_revision`
  (int), `contest_reason` (latest push-back), `build_ref` (PR/branch link, F4), decided/timestamps.
- **`feedback_attachment`** — bytea content + mime + size, denormalised `employment_id` for RLS; mirrors
  `claim_attachment`. Supporting docs + images.
- **Status machine:** `open` → *(agent plans)* → `planned` → reporter **approves** → `approved` →
  *(build agent)* → `building` → `done`; or reporter **contests** (`planned` → `contested`, reason
  stored) → *(agent re-plans, plan_revision++)* → `planned`. Terminal: `rejected` / `cancelled`.
- **RLS** mirrors claims: `can_see_employment(reporter_employment_id)` for read (reporter + their
  manager-chain + admin); the **review authority is the reporter** (`reporter_user_id =
  app.current_user_id()`), asserted in the service (admins triage/build but do **not** approve on the
  reporter's behalf — the spec is "the person who raised it reviews").

### Services (`core/feedback.ts`)
- `submitFeedback(ctx, {category, title, description, expectedBehavior?, expectedFunction?})` — the
  reporter raises it (status `open`); event `feedback.submitted` (user actor).
- `addFeedbackAttachment` / `getFeedbackAttachment` — bytea store + RLS-scoped serve (claims pattern).
- `generateFeedbackPlan(ctx, {feedbackId})` (FB-3) — loads the item, `redactPII()`s the free text, calls
  `generateDraft` **outside the tx** with a planning system-prompt (and, on a re-plan, the prior plan +
  the `contest_reason` so the agent answers the push-back), then stores `plan`, bumps `plan_revision`,
  sets status `planned`; event `feedback.plan.drafted` (**agent** actor, model/provider in payload, no
  PII). Idempotent-friendly (only plans `open`/`contested`).
- `approveFeedbackPlan(ctx, {feedbackId})` — **reporter-only**; `planned` → `approved`; event (user).
- `contestFeedbackPlan(ctx, {feedbackId, reason})` — **reporter-only**; `planned` → `contested` + reason;
  event (user). The next planning run re-plans it.
- `listFeedback` / `getFeedback` — RLS-scoped read; `startBuild`/`completeBuild` (F4, agent/admin).

### The planning loop (FB-3)
A cron, exactly like `scripts/accrue-earned.ts`: `scripts/feedback-plan.ts` (`pnpm feedback:plan`), every
few hours, enumerates tenants and calls `generateFeedbackPlan` for each `open` + `contested` item under a
SYSTEM context. An admin "Generate plan now" button calls the same service for low-latency demos. Gated by
the tenant having an AI config (no key ⇒ skipped, logged).

### The build agent (FB-4) — design only; **human-gated**, never auto-deploys
On `approved`, building is done by an **out-of-app agent** (a Claude Code / CI job with repo access), NOT
the Next.js server. It reads the approved `plan`, implements it in an **isolated git worktree/branch**,
runs `tsc` + the test suite, and opens a **pull request for human review**. The app only **tracks** the
outcome (`building` → `done`, with `build_ref` = the PR link) via a small authenticated callback or the
same cron. **The application never modifies its own running code and never auto-merges or auto-deploys** —
a human (the owner) reviews, merges, and deploys. The agent's repo-access + sandbox + the
trigger/callback contract are a **separate, explicitly-signed-off phase** (the deepest, highest-risk part;
do not build it until the safety model is agreed).

## Phasing
- **FB-1** — schema + migration + RLS + service (capture + review/contest substrate, no AI) + tests.
- **FB-2** — `/feedback` UI (log form w/ attachments, list, detail w/ plan + approve/contest), serve
  route, nav, i18n ×6, browser-verify.
- **FB-3** — `generateFeedbackPlan` (reuse `lib/ai`) + the `feedback:plan` cron + an admin "plan now".
- **FB-4** — the build agent (gated; needs the owner's sign-off on repo-access + the PR-only safety model).

## Consequences
- The improvement loop becomes a first-class, audited product surface (every step is a domain event with
  a user/agent actor), and reuses the existing AI gateway + attachment + request-review patterns.
- The reporter — not an admin — owns the plan review, matching the request ("the person who raised the
  feedback should review the plan, and fight back").
- Safety is explicit: plans are inert text; building is out-of-app, isolated, and produces a
  human-reviewed PR. The app is never self-modifying. The autonomous-build phase is gated behind a
  separate agreement.
- Out of scope (later): voting/dedup of feedback, public roadmap view, linking a built PR's merge back to
  auto-close the item, multi-step build agents with their own test-fix loops.
