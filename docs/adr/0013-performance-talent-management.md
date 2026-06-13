# ADR-0013 — Performance & talent management: a cycle-anchored module that closes the loop into pay

Status: **Accepted** (Phase A building) · Date: 2026-06-10 · Decisions logged 2026-06-13

## Decision log (Phase A, accepted 2026-06-13)

Owner-confirmed choices for the first build (the philosophy-dependent ones flagged below as the
primary risk):

- **Rating scale (seed default):** 5-point, labelled — `[{1,"Below"},{2,"Meets"},{3,"Strong"},
  {4,"Exceeds"},{5,"Outstanding"}]`. Tenant-configurable per cycle (`review_cycle.rating_scale`).
- **Review flow:** self → manager. Employee submits a self-review first; the manager then rates
  and finalizes. Single overall rating (no competency sub-scores — those are Phase C).
- **Cycle membership:** snapshot of active employees in the cycle's company scope at open, minus
  configurable exclusions: `exclude_probation` (default on) and an optional `hired_before` cutoff.
- **Reviewer:** the administrative-line manager (`reporting_line`) resolved at spawn; none (top of
  org) → admin-reviewed. Dotted/functional lines do not rate in Phase A (that's 360, Phase C).
- **Release gate:** the manager's rating + overall are hidden from the employee until HR releases
  the cycle (`review_cycle.released_at`), typically at/after calibration. Self-review is always the
  employee's own; the manager's draft is never employee-visible.
- **Calibration (Phase A):** a freeze + distribution view, not 9-box / forced ranking (Phase C).
- **Pay seam:** the merit/bonus recommendation is captured on the review (free-form, linked record
  on the row) and **enacted by an admin** via the existing `setCompensation` (effective-dated
  merit) / payroll `bonusAmount` (additional-remuneration MTD) — performance never writes pay.
- **Merit budget (the "additional one"):** the cycle carries an optional merit pool
  (`review_cycle.merit_budget` — `{kind:'percent'|'amount', value}`). Recommendations are tracked
  against the remaining pool with a **soft** over-budget warning (managers may over-recommend;
  calibration trims). Bonus totals shown alongside, not hard-capped in Phase A.

---

## Original proposal

Status: **Proposed** (design only — not yet built) · Date: 2026-06-10

## Context

The system covers the regulated core of an HRMS: org/identity, leave, attendance/time, payroll,
and statutory compliance. Performance & talent management — goals, appraisals, ratings, feedback,
calibration, succession — is a recognised HRMS pillar and is entirely absent.

It is, however, **unlike every module built so far**, and that shapes the decision:

1. **It is the first unregulated module.** Leave, OT, EPF/SOCSO/EIS/PCB, the EA form — each has a
   legal anchor with a *correct, sourceable, testable* answer (see [ADR-0008](0008-localization-packs.md),
   the statutory pack). Performance has no statutory floor. There is no "correct" rating scale.
   The discipline that earned trust in the regulated core (sourced figures, exact arithmetic,
   golden tests) does not transfer; correctness here is about **workflow and state**, not numbers.

2. **It is philosophy-dependent.** Annual rating vs. continuous; OKRs vs. competencies vs. MBOs;
   360 vs. top-down; forced ranking vs. not. Companies hold strong, conflicting views. A generic
   build is either too rigid (nobody's process fits) or a glorified form builder. This is the
   module's primary design risk.

3. **It is commoditized.** Lattice, 15Five, Culture Amp, Workday all do this well. A generic
   module competes on their turf and loses.

The strategic question is therefore real: does this product expand to a full talent suite, or stay
the best Malaysia payroll/compliance system and leave talent to integrations? This ADR takes a
middle position: build **only the slice that the rest of the system makes uniquely ours**, and
defer the commoditized remainder.

## Decision

### 1. Build the part that closes the loop into pay; defer the rest

The one thing a standalone performance tool *cannot* do is move money correctly. We can:

> review → **rating** → merit-increase / bonus **recommendation** → enacted through the existing
> compensation history ([ADR-0001](0001-bitemporal-effective-dating.md), effective-dated
> `setCompensation`) and the **additional-remuneration MTD** payroll engine (already built),
> taxed correctly under MY rules.

That seam is the justification for performance management living in *this* product at all. It is
the spine of the first build; OKRs, 360, competencies, 9-box, succession and LMS are explicitly
later phases (or never).

### 2. Shape: cycle-anchored backbone, continuous goals as an optional layer

Periodic vs. continuous is a false dichotomy here. The **review cycle** is the backbone because it
is the only clean trigger for a pay action (you tie merit/bonus to a cycle *outcome*, not to a
never-ending stream). Continuous **goals / check-ins** hang off the same employment graph and may
optionally roll into a cycle. This keeps the pay seam clean without forcing an annual-only ritual.

### 3. Not localized — tenant configuration, not a country pack

Unlike payroll/leave/statutory, performance has no localization pack and no code-level floor.
Rating scales, cycle cadence, and weightings are **tenant configuration in the DB** — the same
pattern as `leave_policy` / `attendance_policy` (company config), not the statutory-minimum-in-code
pattern. This is the first module that is *entirely* config-driven. We test the state machine and
the comp integration, not "the right rating."

### 4. Reuse the substrate, don't reinvent it

- **Authz**: the reviewer is the subject's **administrative manager** (`reporting_line`,
  `lineType = 'administrative'`) or an admin — reuse the shared `assertCanDecide` guard
  (`core/approvals.ts`): no reviewing your own appraisal as the deciding manager.
- **RLS**: per-row via `app.can_see_employment(employment_id)`, exactly as leave / attendance /
  profile-change tables.
- **Events**: every state transition appends a `DomainEvent` ([ADR-0006](0006-event-and-audit-substrate.md))
  — `cycle.opened`, `review.self-submitted`, `review.manager-submitted`, `review.finalized`,
  `review.acknowledged`, `comp-action.recommended`, etc.
- **Pay action**: performance never writes pay directly. It *recommends*; an admin enacts via the
  existing `setCompensation` / payroll-input services — the same request→enact split as ESS bank
  changes ([ADR-0012](0012-employee-self-service.md)), so the tested tax engine stays the single
  writer of money and the action is audited.

### 5. AI-native hook (later, human-in-the-loop)

Per [ADR-0007](0007-ai-native-architecture.md), drafting a manager review from signals already in
the system (goal progress, attendance/OT patterns, peer notes) is a natural assist and a real
differentiator. It is a *draft*, never an autonomous rating; deferred to a later phase.

## Proposed data model (Phase A)

- **`review_cycle`** — `id, tenant_id, company_id?` (null = group-wide), `name`
  (e.g. "2026 Annual"), `period_start, period_end`, `status`
  (`draft | open | calibration | closed`), `rating_scale` (jsonb — configurable, e.g.
  `[{value, label}]`), `created_at`. Status governs what is editable.
- **`performance_review`** — one per employee per cycle. `id, tenant_id, cycle_id, employment_id`
  (subject), `reviewer_employment_id` (the administrative manager), `status`
  (`not_started | self_review | manager_review | submitted | acknowledged`),
  `self_rating?, self_comments?, manager_rating?, manager_comments?, overall_rating?`,
  `submitted_at?, acknowledged_at?, created_at`. Unique on `(cycle_id, employment_id)`.
- **`performance_goal`** (Phase B, optional/continuous) — `id, tenant_id, employment_id, cycle_id?`,
  `title, description?, metric?, target?, weight?, progress?, status`
  (`active | achieved | missed | dropped`), `due_on?, created_at`.

Deferred to later phases (named so they are not silently dropped): `peer_feedback` (360),
`competency` + `review_competency`, `calibration_session` / 9-box, `succession_plan`, learning/LMS.

## Phasing

- **Phase A** — review cycles + appraisals (self + manager, configurable rating) + the
  comp/bonus recommendation seam into compensation/payroll. This is the slice that earns its place.
- **Phase B** — goals / OKRs + manager 1:1 check-ins (the continuous layer).
- **Phase C** — 360 peer feedback + competency framework + calibration / 9-box.
- **Phase D** — succession planning, development plans, LMS — or never; revisit against strategy.

## Consequences

- Performance becomes the first module whose value is **integration**, not data entry: its moat is
  the correct, audited path from a rating to MY-compliant pay. Stripped of that, it is a worse
  Lattice.
- It introduces a config-driven, statute-free correctness model. Tests target the cycle/review
  **state machine** and the comp-action linkage — not numeric golden values.
- The philosophy-lock-in risk is mitigated by a **configurable rating scale** and **optional**
  goals rather than a hard-coded methodology; if a tenant wants pure continuous, Phase B alone
  serves them without the cycle ritual.
- Deferring Phases C–D is a deliberate scope cut, recorded here so "performance management" is
  never reported as fully covered when only the pay-integrated spine exists.

## Alternatives rejected

- **Build the full classic suite now** (ratings + competencies + 360 + 9-box + succession):
  largest build, most culture-variable, competes head-on with mature incumbents, and most of it
  has no link to our payroll moat. Rejected as scope sprawl.
- **Continuous-only (no cycle)**: cleaner UX for some cultures, but it strands the pay seam (no
  natural trigger for merit/bonus) — the one thing that makes this ours. Rejected as the *primary*
  shape; retained as the optional Phase B layer.
- **A generic "form builder"** for arbitrary review templates: maximally flexible, minimally
  opinionated, and indistinguishable from a survey tool. Rejected — flexibility is not a strategy.
