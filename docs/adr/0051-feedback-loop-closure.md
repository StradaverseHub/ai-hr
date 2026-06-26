# ADR-0051 — Feedback module v2: close the loop (post-deploy refute) + bulk review + dashboard

**Status:** Accepted · **Date:** 2026-06-26 · **Supersedes:** none (extends ADR-0043 feedback module, ADR-0044/0045 improvement loop)

## Context

The feedback loop (ADR-0043/0044/0045) ran one direction only: capture → plan → approve → build → **deployed (terminal)**. In practice a reporter often finds the *deployed* result still falls short — the spec was thin, or the build missed the intent — but had no way to say so without filing a fresh, disconnected item. Two operational frictions also surfaced while running the loop at scale: reviewers approve items one-by-one (tedious for a 18-item queue), and seeing the queue meant querying the database directly.

## Decision

1. **Post-deploy refute closes the loop.** A `deployed` item can be refuted by the **reporter or an admin** (`refuteDeployment(reason)`): it transitions **`deployed → contested`**, stores the reason in `contest_reason`, increments a new `reopened_count`, and appends a distinct **`feedback.deployment.refuted`** domain event.
   - **Why reuse `contested` rather than a new status:** the refiner already pulls `open`/`contested` and re-plans `contested` items *with* `contest_reason` as context. Routing a refute through `contested` makes it re-enter the existing loop with zero new plumbing in the refiner/pull path. A fresh `reopened` status would have meant touching the enum, `listPlannableFeedback`, the SSH pull, and the refiner — surface for no behavioural gain. `reopened_count > 0` is what distinguishes "refuted after deploy" from "contested before build" in the UI and audit.
   - `reopened_count` is a **quality signal**: a feature sent back repeatedly is one the spec or build keeps missing.

2. **Bulk review** (`bulkReview(ids, action)`) applies approve / contest / cancel to a selection by **reusing the per-item services**, so each item keeps its own authz, status guard, and event. A single-item failure (wrong status, not the reporter) is reported in `failed`, never aborts the batch.

3. **In-app dashboard** (`feedbackStatusCounts`) — status counts rendered as filter chips at the top of the list, so the queue is visible without a DB query.

## Consequences

- Migration `0104` adds `feedback_request.reopened_count` (additive, default 0, backfill-safe).
- The substrate stays whole: refute appends its own event; bulk inherits per-item events.
- A refuted item re-enters planning automatically — no operator step beyond the next `improve:pull`.
- Out of scope: auto-classifying *why* something was refuted, and an explicit "accept/close" positive counterpart to refute (deployed remains the success terminal; refute is the only exit).
