# ADR-0022 — Performance Phase B: the continuous talent layer (goals, check-ins, 360, calibration, AI draft)

Status: **Accepted** (building) · Date: 2026-06-17 · Builds on [ADR-0013](0013-performance-talent-management.md)

## Context

ADR-0013 shipped Phase A — a cycle-anchored appraisal engine whose moat is the audited path from a
rating to MY-compliant pay (`enactCompAction` → `setCompensation` + `setPayrollInput`). It deliberately
deferred the commodity talent features to Phases B–D and recorded them so they would not be silently
dropped: goals/OKRs + 1:1 check-ins (B), 360 + competencies + calibration (C), succession/LMS (D).

The owner has now asked to build the whole continuation — goals, calibration **and** analytics, 360 peer
feedback, and AI-assisted drafting — and chose the **continuous + cycle-linkable** cadence: the talent
layer must be usable *between* cycles (teams that reject the annual ritual) while still snapping onto a
review cycle when one runs. This ADR collapses the old Phase B + Phase C + the ADR-0007 AI hook into one
sequenced **Phase B program** and records the decisions the four capabilities force.

## Decision

Build the deferred features as **ordered vertical slices**, continuous-first, reusing the Phase A
substrate. Each slice is independently shippable; the program merges to main at the end.

### Non-negotiables carried from Phase A (do not relax)

1. **Pay stays admin-enacted and advisory-in, never auto-enacted.** Goals, 360, and AI drafts *inform*
   a recommendation; the canonical, audited act is still an admin pressing enact. No "all goals achieved
   → automatic raise" path is ever wired. (The map flagged this as the primary anti-pattern.)
2. **Per-row RLS via `app.can_see_employment(employment_id)`** on every new employment-scoped table,
   exactly as leave/attendance/claims. Catalog/config tables are member-read / admin-write.
3. **Every state-changing service method appends a `DomainEvent`** with `subjectEmploymentId` for
   RLS-scoped audit; event payloads omit sensitive figures (ratings, amounts, free-text feedback) — the
   sensitive data lives on the RLS-scoped row, the event records that a transition happened.
4. **Config-driven, statute-free.** No country pack. Tests target state machines and linkage, not golden
   numbers.
5. **i18n is part of done.** Every new string lands in `en.json` + all 6 locales; `test/i18n-coverage.test.ts`
   (ADR follow-up) gates it.

### The four capabilities + the policy decisions they force

**1. Goals & OKRs (continuous + cycle-linkable).** `performance_goal` is owned by an employment, with a
**nullable** `cycle_id` — a goal can exist standalone at any time and optionally bind to a cycle. Both the
employee and their administrative manager can see and update a goal (co-ownership); progress is a 0–100
percent plus a lifecycle status (`active | achieved | missed | dropped`). Goals link into a review via a
`review_goal` join so the manager can reference what was actually worked on. **Goals never compute a
rating or a raise** — they are reference signal only (principle 1).

**2. Manager 1:1 check-ins.** `performance_checkin` — a lightweight recurring touchpoint between a manager
and a report, with a scheduled date, completion, shared notes, and optional linked goals. Continuous by
nature (no cycle required). Serves the "distribute the manager load across the year instead of one annual
cram" need the map raised.

**3. 360 / peer feedback.** `peer_feedback_request` + `peer_feedback`. **Anonymity policy (default,
owner-confirmable):** feedback is *attributed to HR/manager for accountability* but **shown to the subject
without attribution** by default; a peer may opt to be named. Requests are admin/manager-initiated (no
self-solicited praise farming); a peer sees only their own request, never who else was asked. Retaliation
guard: the subject never sees feedback until the cycle is released, and never sees the requester list.

**4. Calibration sessions + analytics.** `calibration_session` + `calibration_entry`. **Consensus model
(default, owner-confirmable): advisory, not silent-override.** A session surfaces the rating distribution
for a group; participants propose adjustments; an admin **commits** an agreed `overall_rating` which writes
the review row with a `performance-review.calibrated` event — votes never mutate a rating without an explicit
committed decision. Analytics is a **read-only** layer over existing rows: rating distribution over
time, merit-spend vs budget, and a manager-bias / rating-leniency view. No new write surface.

**5. AI-assisted review drafting.** Draft-only, human-in-the-loop, through the governed AI gateway
(ADR-0007) with PII redaction. Given signals already in the system (goal progress, attendance/OT, prior
reviews) it proposes manager-review prose the manager **edits before submitting**. Never autonomous; the
submit is always the human's. Sequenced last because it is thin until goals exist to draft from.

## Data model (new tables — all `tenant_id` + RLS)

- **`performance_goal`** — `id, tenant_id, employment_id, cycle_id?` (null = continuous), `title,
  description?, metric?, target?, weight? (numeric), progress (int 0–100, default 0), status
  (`active|achieved|missed|dropped`, default active), `due_on?, created_by_user_id?, created_at, updated_at`.
  RLS: `can_see_employment(employment_id)` for read; write by subject or admin-line manager or admin.
- **`review_goal`** — join: `id, tenant_id, review_id, goal_id`. Unique `(review_id, goal_id)`.
- **`performance_checkin`** — `id, tenant_id, manager_employment_id, subject_employment_id, scheduled_on,
  completed_at?, notes?, status (scheduled|completed|cancelled), created_at`.
- **`peer_feedback_request`** — `id, tenant_id, review_id, subject_employment_id, peer_employment_id,
  status (pending|submitted|declined), requested_by_user_id, created_at`.
- **`peer_feedback`** — `id, tenant_id, request_id, strengths?, improvements?, named (bool default false),
  created_at`.
- **`calibration_session`** — `id, tenant_id, cycle_id, name, status (open|committed), created_at`.
- **`calibration_entry`** — `id, tenant_id, session_id, review_id, proposed_rating?, committed_rating?,
  note?`.

New review status edge: `calibrated` is recorded via event + the `overall_rating` write, not a new enum
value (keeps the Phase A state machine intact). New comp/cycle enums only where a real new lifecycle exists
(goal status, checkin status, feedback request status).

## Slice plan

1. **Goals & OKRs** — schema + RLS; service (`createGoal/updateGoal/updateGoalProgress/archiveGoal`,
   `linkGoalToReview/unlink`); reads (`listGoalsForEmployment`, `listGoalsForCycle`, `myGoals`); UI on
   `/me` (my goals) + the review page (link goals) + a manager view on the report's detail; events; tests;
   i18n×6.
2. **1:1 check-ins** — schema + RLS; service; manager + employee UI; events; tests; i18n×6.
3. **360 peer feedback** — schema + RLS (anonymity-aware reads); request/submit service; UI to solicit
   (manager) + respond (peer) + aggregated view on the review; events; tests; i18n×6.
4. **Calibration + analytics** — calibration session schema + service + admin UI on the cycle page;
   read-only analytics dashboards; events; tests; i18n×6.
5. **AI-assisted drafting** — gateway call + redaction; "draft with AI" affordance on the manager review,
   editable; events; tests; i18n×6.

Verify each slice (`tsc` → `pnpm test` → browser) and commit; `--no-ff` merge `feat/perf-phase-b` → main at
program end.

## Consequences

- Performance grows from a once-a-year appraisal into a continuous talent surface, while the pay moat and
  its admin-enacted discipline are untouched.
- Five new employment-scoped tables widen the RLS + event surface; the discipline (principles 2–3) keeps
  them consistent with the rest of the platform and visible to audit / the future self-improvement loop.
- Scope is large; sequencing as shippable slices means the program delivers value continuously and can be
  paused after any slice without leaving a half-built feature.

## Owner decisions still open (sensible defaults applied; confirm or override)

- **360 anonymity** — default: subject-anonymized, peer-opt-in-to-name, HR-attributed. (Could be fully
  anonymous, or fully attributed.)
- **Calibration consensus** — default: advisory, admin commits. (Could be binding-on-vote, or
  discussion-only with no rating write.)
- **AI drafting** — default: draft-only, manager edits, gateway + redaction. (Non-negotiable that it is
  never autonomous; model tier / which signals to feed are tunable.)
