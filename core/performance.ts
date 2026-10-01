/**
 * Performance & talent — Phase A (ADR-0013). The first config-driven, statute-free module.
 *
 * Backbone: a review cycle (draft → open → calibration → closed) snapshots a set of employees at
 * open, each getting one review that walks self_review → manager_review → submitted → acknowledged.
 * The reason it lives in *this* product is the pay seam: a finalized review carries a merit/bonus
 * recommendation that an admin ENACTS through the existing, tested comp/payroll engines — the
 * performance module never writes pay itself.
 *
 * Correctness here is workflow + state, not numbers: there is no "right" rating. So this file
 * guards transitions and the comp linkage; it does not compute statutory figures.
 *
 * Reuse: assertCanDecide (manager-or-admin, no self-review), can_see_employment RLS, the domain
 * event log, setCompensation (effective-dated merit) and setPayrollInput (bonus as additional-
 * remuneration MTD).
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { type SessionContext, type Tx } from '../db/client';
// ADR-0077 D3 SERVICE GATE (r292). `withTenant` here is `withPerformanceTenant` — all 49 exported entry
// points refuse a tenant without the Performance module. `currentAdminManager` takes a `tx` and is
// therefore NOT gated, deliberately: core/employment-review.ts (employment spine) calls it and must
// keep working. See core/module-gate.ts.
import { withPerformanceTenant as withTenant } from './module-gate';
import { actorOf, appendEvent } from '../db/events';
import {
  assignment,
  calibrationEntry,
  calibrationSession,
  compensation,
  employment,
  department,
  payrollBatch,
  payrollInput,
  peerFeedback,
  peerFeedbackRequest,
  performanceAttachment,
  performanceCheckin,
  performanceGoal,
  performanceReview,
  person,
  reportingLine,
  reviewCycle,
  reviewGoal,
} from '../db/schema';
import type { EmploymentStatus } from './employment-status';
import { employmentStatusSql } from './employment-status-sql';
import { setCompensation } from './comp';
import { setPayrollInput } from './payroll';
import { assertCanDecide } from './approvals';
import { generateDraft, redactPII } from '../lib/ai';
import { resolveActiveAiConfig } from './ai-config';

import { todayInKualaLumpur } from '../lib/hr-date';

export class PerfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PerfError';
  }
}

/** Seed scale if a cycle is created without one. Tenant-configurable per cycle thereafter. */
export const DEFAULT_RATING_SCALE: RatingScale = [
  { value: 1, label: 'Below' },
  { value: 2, label: 'Meets' },
  { value: 3, label: 'Strong' },
  { value: 4, label: 'Exceeds' },
  { value: 5, label: 'Outstanding' },
];

export type RatingScale = { value: number; label: string }[];
export type MeritBudget = { kind: 'percent' | 'amount'; value: number } | null;

// ───────────────────────────── Eligibility rules engine ─────────────────────────────

/**
 * The Status predicate's vocabulary. R81 (9cbf5e0d): this WAS a private mirror of the stored
 * `assignment_status` enum ('active' | 'on_leave' | 'probation' | 'offboarding' | 'terminated'). That enum
 * and its column are gone, and three of those five values were retired outright, so the predicate now reads
 * the ONE derived Employee Status — the same buckets Personnel, the dashboard, leave and analytics show.
 *
 * BEHAVIOUR CHANGE, DELIBERATE AND REPORTED: a cycle whose stored rules named a status used to be matched
 * against a hand-set column that nobody was allowed to keep current — test/performance-eligibility.test.ts
 * already documented the hazard (an employee with `terminatedOn` null but a stale stored 'terminated'). It
 * now matches against the employee's real, dated status. Migration 0331 remaps stored rules; the reported
 * backfill (scripts/report-employee-status-retirement.ts) prints every cycle it touches.
 */
export type AssignmentStatus = EmploymentStatus;
/** assignment.employmentType values used by the Employment-Type predicate — mirrors employmentTypeEnum. */
export type EmploymentTypeValue = 'full_time' | 'part_time' | 'contract' | 'intern';

/**
 * Configurable eligibility criteria for who a review cycle snapshots at open (Performance eligibility
 * slice). All fields optional and AND-combined — an absent/empty predicate always passes. Structured so
 * Business-Unit / Department / Position / Grade can be added later without a shape change (deferred).
 *
 * Stored as JSONB directly on review_cycle.eligibility_rules (same pattern as leave_type.eligibility).
 */
export type EligibilityRules = {
  /** Cycle-scope companies (company.id). Empty/absent = every company the cycle already covers. */
  companyIds?: string[];
  /** Derived Employee Status whitelist. Empty/absent = any status. */
  statuses?: AssignmentStatus[];
  /** assignment.employmentType whitelist — how HR excludes interns. Empty/absent = any type. */
  employmentTypes?: EmploymentTypeValue[];
  /** Minimum months of service (today − hiredOn, whole months) required. Absent = no minimum. */
  minServiceMonths?: number;
  /** Only include employees hired on/before this ISO date. Null/absent = no cutoff. */
  hiredBefore?: string | null;
};

/** The candidate row `evaluateEligibility` reads. `status`/`employmentType`/`companyId` are null when the
 *  employee has NO current assignment row (left-join gap) — see the null-handling decision below. */
export type EligibilityCandidate = {
  hiredOn: string; // ISO date; employment.hiredOn is authoritative and never null
  status: AssignmentStatus | null;
  employmentType: EmploymentTypeValue | null;
  companyId: string | null;
};

/** Whole months between two ISO dates (hiredOn → asOf), never negative. Used by the minServiceMonths
 *  predicate. Day-of-month aware so "6 months" means the calendar anniversary, not 6×30 days. */
export function serviceMonths(hiredOn: string, asOf: string): number {
  const h = new Date(hiredOn + 'T00:00:00Z');
  const a = new Date(asOf + 'T00:00:00Z');
  let months = (a.getUTCFullYear() - h.getUTCFullYear()) * 12 + (a.getUTCMonth() - h.getUTCMonth());
  if (a.getUTCDate() < h.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/**
 * Pure, DB-free eligibility predicate — mirrors the maternityAllowanceEligibility pattern in core/leave.ts.
 * AND-combines every configured predicate; an empty/absent rule always passes that predicate. Returns the
 * decision plus the reasons it failed (for previews / debugging).
 *
 * NULL-HANDLING (explicit, panel-flagged — confirm-before-build item #3, shipping the excluded default):
 *   An employee with NO current assignment row arrives here with employmentType = null (companyId comes
 *   from `employment` and is never null; since R81 `status` is DERIVED from `employment` too, so it is
 *   never null either — an assignment-less employee now gets a real status instead of being excluded by
 *   a rule they were never actually judged against). Any configured predicate whose value IS null FAILS
 *   (excluded by default) —
 *   we do NOT silently pass a null through the new stricter predicate set. If NONE of those three
 *   predicates is configured, a null-assignment employee still passes (only hiredOn-based predicates
 *   apply), matching "no filter can't exclude what it doesn't check."
 *
 * CONCURRENT EMPLOYMENT (documented decision — confirm-before-build item #2): this evaluates ONE
 * employment row. A person holding two eligible employments gets two independent performance_review rows
 * (one per role), matching today's two-field-filter behaviour. See the concurrent-employment fixture in
 * test/performance-eligibility.test.ts, which pins this as intentional, not a bug.
 */
export function evaluateEligibility(
  emp: EligibilityCandidate,
  rules: EligibilityRules | null | undefined,
  asOf: string,
): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const r = rules ?? {};

  if (r.statuses && r.statuses.length > 0) {
    if (emp.status == null || !r.statuses.includes(emp.status)) reasons.push('status');
  }
  if (r.employmentTypes && r.employmentTypes.length > 0) {
    if (emp.employmentType == null || !r.employmentTypes.includes(emp.employmentType)) reasons.push('employmentType');
  }
  if (r.companyIds && r.companyIds.length > 0) {
    if (emp.companyId == null || !r.companyIds.includes(emp.companyId)) reasons.push('companyId');
  }
  if (r.minServiceMonths != null && r.minServiceMonths > 0) {
    if (serviceMonths(emp.hiredOn, asOf) < r.minServiceMonths) reasons.push('minServiceMonths');
  }
  if (r.hiredBefore) {
    if (emp.hiredOn > r.hiredBefore) reasons.push('hiredBefore');
  }

  return { eligible: reasons.length === 0, reasons };
}

/** Strip a raw eligibility-rules input down to the persisted/summarisable shape — drops empty arrays and
 *  null/absent fields so both the stored JSONB and the event payload stay minimal and PII-free (ids/enums
 *  only). Returns null when nothing meaningful is configured. */
export function normalizeEligibilityRules(rules: EligibilityRules | null | undefined): EligibilityRules | null {
  if (!rules) return null;
  const out: EligibilityRules = {};
  if (rules.companyIds && rules.companyIds.length > 0) out.companyIds = [...rules.companyIds];
  if (rules.statuses && rules.statuses.length > 0) out.statuses = [...rules.statuses];
  if (rules.employmentTypes && rules.employmentTypes.length > 0) out.employmentTypes = [...rules.employmentTypes];
  if (rules.minServiceMonths != null && rules.minServiceMonths > 0) out.minServiceMonths = rules.minServiceMonths;
  if (rules.hiredBefore) out.hiredBefore = rules.hiredBefore;
  return Object.keys(out).length > 0 ? out : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => round2(n).toFixed(2);
const isAdminCtx = (ctx: SessionContext) =>
  (ctx.roles ?? []).some((r) => r === 'hr_admin' || r === 'super_admin');

/**
 * Company-scoped perf-comp gate (ADR-0049). True if the session is an admin OR a performance_comp
 * partner whose grant covers `companyId` — resolved against `ctx.grants` (which carries companyId),
 * NOT `ctx.roles` (which drops it). A null companyId (group-wide cycle) requires a group-wide grant.
 * This is the SERVICE-LAYER gate; the DB RLS (0099) is authoritative for subtree-descendant scope.
 * Gating on `ctx.roles` here would let a Company-A partner act on a Company-B cycle (the cross-company
 * bug this slice guards against).
 */
const canAdminPerfCtx = (ctx: SessionContext, companyId: string | null) => {
  if (isAdminCtx(ctx)) return true;
  return (ctx.grants ?? []).some(
    (g) =>
      g.role === 'performance_comp_partner' &&
      (g.companyId == null || (companyId != null && g.companyId === companyId)),
  );
};

/** Coarse "perf-comp partner somewhere" gate (any grant). Used for cycle-grained calibration, which
 *  has no per-row company_id — matching the coarse `is_admin()` the calibration RLS uses (0099). */
const isAdminOrPerfCompCtx = (ctx: SessionContext) =>
  isAdminCtx(ctx) || (ctx.grants ?? []).some((g) => g.role === 'performance_comp_partner');

function assertRatingInScale(scale: RatingScale, value: number, label: string) {
  if (!scale.some((s) => s.value === value)) {
    throw new PerfError(`${label} ${value} is not a value in this cycle's rating scale`);
  }
}

// ───────────────────────────── Cycle lifecycle (admin) ─────────────────────────────

export async function createCycle(
  ctx: SessionContext,
  p: {
    companyId?: string | null;
    name: string;
    periodStart: string;
    periodEnd: string;
    ratingScale?: RatingScale;
    meritBudget?: MeritBudget;
    eligibilityRules?: EligibilityRules | null;
    stages?: CycleStage[];
  },
) {
  // Admin or a perf-comp partner scoped to the cycle's company (group-wide cycles need a group grant).
  if (!canAdminPerfCtx(ctx, p.companyId ?? null)) {
    throw new PerfError('Only an admin or performance & comp partner can create a review cycle');
  }
  if (!p.name?.trim()) throw new PerfError('A cycle name is required');
  if (p.periodEnd < p.periodStart) throw new PerfError('Cycle period end is before its start');
  const scale = p.ratingScale ?? DEFAULT_RATING_SCALE;
  if (!Array.isArray(scale) || scale.length < 2) throw new PerfError('A rating scale needs at least two points');
  const eligibilityRules = normalizeEligibilityRules(p.eligibilityRules);
  // Cross-company guard (2c): eligibilityRules.companyIds is a SECOND, independent filter beside
  // cycle.companyId. Without this, a partner scoped to Company A could set companyIds=[CompanyB] on a
  // group-wide cycle and spawn reviews for staff outside their grant. Every id must be inside the
  // caller's authorized subtree — the same check canAdminPerfCtx already applies to cycle.companyId.
  if (eligibilityRules?.companyIds) {
    for (const cid of eligibilityRules.companyIds) {
      if (!canAdminPerfCtx(ctx, cid)) {
        throw new PerfError('An eligibility rule references a company outside your authorized scope');
      }
    }
  }
  // HR elects which lifecycle stages run; default = all three. Normalize + reject empty / unknown.
  const stages = cycleStages(p.stages);
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(reviewCycle)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId ?? null,
        name: p.name.trim(),
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        status: 'draft',
        ratingScale: scale,
        meritBudget: p.meritBudget ?? null,
        eligibilityRules,
        stages,
      })
      .returning({ id: reviewCycle.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'review-cycle',
      aggregateId: row.id,
      eventType: 'review-cycle.created',
      actor: actorOf(ctx),
      // Rules summary is ids/enums only (no PII), so it is safe to carry in the audit event.
      payload: { name: p.name.trim(), companyId: p.companyId ?? null, periodStart: p.periodStart, periodEnd: p.periodEnd, eligibilityRules },
    });
    return { cycleId: row.id };
  });
}

/**
 * The shared candidate query both openCycle and previewEligibleCount run, so preview and the actual
 * snapshot can never drift. Returns one row per employment (the SUBJECT), joined to its CURRENT
 * assignment via a DISTINCT ON (employmentId) latest-row-wins tiebreak.
 *
 * DUPLICATE-ASSIGNMENT GUARD: assignment has no DB constraint guaranteeing at most one "current" row per
 * employment (only a non-unique index). A plain LEFT JOIN would fan a stray duplicate "current" row out
 * into two candidate rows for one employee — silently spawning two performance_review rows in one cycle,
 * violating the one-review-per-employee-per-cycle assumption downstream (calibration / comp linkage). The
 * DISTINCT ON picks exactly one current assignment (latest validFrom, then latest recordedAt) so a
 * duplicate can never fan out the candidate set. Employees with NO current assignment still appear once,
 * with null status/employmentType (evaluateEligibility's null-handling then decides inclusion).
 *
 * RLS already limits the rows to employments the caller administers. employment.terminatedOn stays the
 * authoritative "terminated" signal (2b) — filtered here in the WHERE — while the derived Employee Status
 * is an ADDITIONAL predicate applied by evaluateEligibility, never a replacement.
 */
async function eligibilityCandidates(
  tx: Tx,
  tenantId: string,
  cycleCompanyId: string | null,
  /** R81: the date the Employee Status is derived AS OF — the same `asOf` evaluateEligibility uses, so the
   *  status predicate and the service/hire-date predicates all judge the employee on one single day. The
   *  stored column this replaced had no as-of at all; it was simply whatever was last typed. */
  asOf: string,
): Promise<Array<{ employmentId: string } & EligibilityCandidate>> {
  // DISTINCT ON (employment_id) with a latest-row-wins ORDER BY collapses any duplicate "current"
  // assignment rows to one. LEFT JOIN keeps employments with no current assignment (null status/type).
  const rows = await tx
    .select({
      employmentId: employment.id,
      hiredOn: employment.hiredOn,
      companyId: employment.companyId,
      status: sql<AssignmentStatus | null>`${employmentStatusSql(asOf)}`,
      employmentType: sql<EmploymentTypeValue | null>`${assignment.employmentType}`,
    })
    .from(employment)
    .leftJoin(
      assignment,
      and(
        eq(assignment.employmentId, employment.id),
        isNull(assignment.validTo),
        isNull(assignment.supersededAt),
      ),
    )
    .where(
      and(
        eq(employment.tenantId, tenantId),
        isNull(employment.terminatedOn),
        cycleCompanyId ? eq(employment.companyId, cycleCompanyId) : undefined,
      ),
    )
    .orderBy(
      employment.id,
      sql`${assignment.validFrom} desc nulls last`,
      sql`${assignment.recordedAt} desc nulls last`,
    )
    // DISTINCT ON employment.id, keeping the first row per the ORDER BY (latest current assignment wins).
    .then((all) => {
      const seen = new Set<string>();
      const out: typeof all = [];
      for (const r of all) {
        if (seen.has(r.employmentId)) continue;
        seen.add(r.employmentId);
        out.push(r);
      }
      return out;
    });
  return rows;
}

/** Open a draft cycle: snapshot eligible employees in scope into one review each, with the
 *  administrative-line manager as reviewer. Eligibility is the configured eligibilityRules, run through
 *  the pure evaluateEligibility. Idempotent via the draft guard. */
export async function openCycle(ctx: SessionContext, p: { cycleId: string }) {
  return withTenant(ctx, async (tx) => {
    const cycle = await loadCycle(tx, p.cycleId);
    if (!canAdminPerfCtx(ctx, cycle.companyId)) {
      throw new PerfError('Only an admin or performance & comp partner can open a review cycle');
    }
    if (cycle.status !== 'draft') throw new PerfError(`Cycle is already ${cycle.status}; only a draft can be opened`);

    const rules = (cycle.eligibilityRules ?? null) as EligibilityRules | null;
    const asOf = todayInKualaLumpur();
    const candidates = await eligibilityCandidates(tx, ctx.tenantId, cycle.companyId, asOf);
    const members = candidates.filter((c) => evaluateEligibility(c, rules, asOf).eligible);

    let spawned = 0;
    for (const e of members) {
      const reviewerEmploymentId = await currentAdminManager(tx, ctx.tenantId, e.employmentId);
      await tx.insert(performanceReview).values({
        tenantId: ctx.tenantId,
        cycleId: cycle.id,
        employmentId: e.employmentId,
        reviewerEmploymentId,
        status: 'self_review',
      });
      spawned++;
    }

    await tx.update(reviewCycle).set({ status: 'open' }).where(eq(reviewCycle.id, cycle.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'review-cycle',
      aggregateId: cycle.id,
      eventType: 'review-cycle.opened',
      actor: actorOf(ctx),
      payload: { reviewsSpawned: spawned },
    });
    return { reviewsSpawned: spawned };
  });
}

/**
 * Point-in-time preview of how many employees a rule set would snapshot — the "Preview eligible
 * employees" button. Runs the EXACT same candidate query + evaluateEligibility openCycle uses (via the
 * shared eligibilityCandidates), so the number can only differ from the real open by real-world data
 * changes between preview and submit (a hire/transfer) — expected, covered by the UI's "as of now" label,
 * not special-cased here. Read-only: no DomainEvent (nothing changes state).
 */
export async function previewEligibleCount(
  ctx: SessionContext,
  p: { companyId?: string | null; eligibilityRules?: EligibilityRules | null },
): Promise<{ count: number }> {
  // Same authorization as createCycle: only an admin / scoped partner may preview a company's roster.
  if (!canAdminPerfCtx(ctx, p.companyId ?? null)) {
    throw new PerfError('Only an admin or performance & comp partner can preview cycle eligibility');
  }
  const rules = normalizeEligibilityRules(p.eligibilityRules);
  // Cross-company guard (2c) applied here too, so a preview cannot probe headcount outside the caller's
  // grant by naming another company in companyIds.
  if (rules?.companyIds) {
    for (const cid of rules.companyIds) {
      if (!canAdminPerfCtx(ctx, cid)) {
        throw new PerfError('An eligibility rule references a company outside your authorized scope');
      }
    }
  }
  return withTenant(ctx, async (tx) => {
    const asOf = todayInKualaLumpur();
    const candidates = await eligibilityCandidates(tx, ctx.tenantId, p.companyId ?? null, asOf);
    const count = candidates.filter((c) => evaluateEligibility(c, rules, asOf).eligible).length;
    return { count };
  });
}

export async function moveCycleToCalibration(ctx: SessionContext, p: { cycleId: string }) {
  return transitionCycle(ctx, p.cycleId, ['open'], 'calibration', 'review-cycle.calibration-started');
}

/** Release ratings to employees (the gate): manager rating + overall become employee-visible. */
export async function releaseCycle(ctx: SessionContext, p: { cycleId: string }) {
  return withTenant(ctx, async (tx) => {
    const cycle = await loadCycle(tx, p.cycleId);
    if (!canAdminPerfCtx(ctx, cycle.companyId)) {
      throw new PerfError('Only an admin or performance & comp partner can release a cycle');
    }
    if (cycle.status !== 'calibration' && cycle.status !== 'open') {
      throw new PerfError(`Cannot release a ${cycle.status} cycle`);
    }
    if (cycle.releasedAt) throw new PerfError('Cycle ratings are already released');
    await tx.update(reviewCycle).set({ releasedAt: sql`now()` }).where(eq(reviewCycle.id, cycle.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'review-cycle',
      aggregateId: cycle.id,
      eventType: 'review-cycle.released',
      actor: actorOf(ctx),
    });
    return { ok: true };
  });
}

export async function closeCycle(ctx: SessionContext, p: { cycleId: string }) {
  return transitionCycle(ctx, p.cycleId, ['open', 'calibration'], 'closed', 'review-cycle.closed');
}

async function transitionCycle(
  ctx: SessionContext,
  cycleId: string,
  from: ('draft' | 'open' | 'calibration' | 'closed')[],
  to: 'open' | 'calibration' | 'closed',
  eventType: string,
) {
  return withTenant(ctx, async (tx) => {
    const cycle = await loadCycle(tx, cycleId);
    if (!canAdminPerfCtx(ctx, cycle.companyId)) {
      throw new PerfError('Only an admin or performance & comp partner can change a cycle status');
    }
    if (!from.includes(cycle.status)) {
      throw new PerfError(`Cannot move a ${cycle.status} cycle to ${to}`);
    }
    await tx.update(reviewCycle).set({ status: to }).where(eq(reviewCycle.id, cycle.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'review-cycle',
      aggregateId: cycle.id,
      eventType,
      actor: actorOf(ctx),
    });
    return { status: to };
  });
}

// ───────────────────────────── Review transitions ─────────────────────────────

/** Employee submits their self-assessment. Self (or an admin) only — not the manager. */
export async function submitSelfReview(
  ctx: SessionContext,
  p: { reviewId: string; selfRating: number; selfComments?: string; goalsSummary?: string },
) {
  return withTenant(ctx, async (tx) => {
    const { review, cycle, subjectPersonId } = await loadReview(tx, p.reviewId);
    const isSelf = ctx.personId != null && ctx.personId === subjectPersonId;
    if (!isSelf && !isAdminCtx(ctx)) throw new PerfError('Only the employee can submit their own self-review');
    if (cycle.status !== 'open') throw new PerfError(`The cycle is ${cycle.status}; reviews can only be edited while it is open`);
    if (review.status !== 'self_review') throw new PerfError(`Self-review is not open (status: ${review.status})`);
    assertRatingInScale(cycle.ratingScale as RatingScale, p.selfRating, 'Self rating');

    await tx
      .update(performanceReview)
      .set({
        selfRating: p.selfRating,
        selfComments: p.selfComments ?? null,
        goalsSummary: p.goalsSummary ?? null,
        status: 'manager_review',
      })
      .where(eq(performanceReview.id, review.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'performance-review',
      aggregateId: review.id,
      eventType: 'performance-review.self-submitted',
      actor: actorOf(ctx),
      subjectEmploymentId: review.employmentId,
      // No rating in the payload: domain_event RLS is tenant-wide, so a scalar here would leak the
      // rating to peers. The value lives on the RLS-scoped performance_review row.
      payload: { cycleId: review.cycleId },
    });
    return { status: 'manager_review' as const };
  });
}

/** Manager finalizes the review (rating + overall, optional merit/bonus recommendation). The
 *  administrative manager or an admin — never the subject (assertCanDecide bans self). Allowed
 *  from manager_review, or self_review when the employee never self-assessed (no stall). */
export async function submitManagerReview(
  ctx: SessionContext,
  p: {
    reviewId: string;
    managerRating: number;
    overallRating: number;
    managerComments?: string;
    recommendedMeritPct?: number | null;
    recommendedBonus?: number | null;
  },
) {
  return withTenant(ctx, async (tx) => {
    const { review, cycle } = await loadReview(tx, p.reviewId);
    if (cycle.status !== 'open') throw new PerfError(`The cycle is ${cycle.status}; reviews can only be edited while it is open`);
    if (review.status !== 'manager_review' && review.status !== 'self_review') {
      throw new PerfError(`Manager review is not open (status: ${review.status})`);
    }
    // A perf-comp partner scoped to the cycle's company owns the review surface (ADR-0049), so it may
    // finalize a manager review like an admin — but never its own (no self-decide). When the actor is
    // such a partner (and not a plain admin), authorize here; otherwise fall back to the standard
    // admin-or-manager gate (assertCanDecide also handles the no-self rule for admins/managers).
    const isPartnerForCycle = !isAdminCtx(ctx) && canAdminPerfCtx(ctx, cycle.companyId);
    if (isPartnerForCycle) {
      const [subj] = await tx
        .select({ personId: employment.personId })
        .from(employment)
        .where(eq(employment.id, review.employmentId))
        .limit(1);
      if (ctx.personId != null && subj?.personId === ctx.personId) {
        throw new PerfError('You cannot decide your own performance review');
      }
    } else {
      await assertCanDecide(tx, ctx, review.employmentId, 'performance review');
    }
    const scale = cycle.ratingScale as RatingScale;
    assertRatingInScale(scale, p.managerRating, 'Manager rating');
    assertRatingInScale(scale, p.overallRating, 'Overall rating');
    const merit = p.recommendedMeritPct != null && p.recommendedMeritPct > 0 ? p.recommendedMeritPct : null;
    const bonus = p.recommendedBonus != null && p.recommendedBonus > 0 ? p.recommendedBonus : null;

    await tx
      .update(performanceReview)
      .set({
        managerRating: p.managerRating,
        managerComments: p.managerComments ?? null,
        overallRating: p.overallRating,
        recommendedMeritPct: merit != null ? money(merit) : null,
        recommendedBonus: bonus != null ? money(bonus) : null,
        compActionStatus: merit != null || bonus != null ? 'recommended' : 'none',
        status: 'submitted',
        submittedAt: sql`now()`,
      })
      .where(eq(performanceReview.id, review.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'performance-review',
      aggregateId: review.id,
      eventType: 'performance-review.manager-submitted',
      actor: actorOf(ctx),
      subjectEmploymentId: review.employmentId,
      // Ratings/amounts are omitted from event payloads — domain_event RLS is tenant-wide, so any
      // scalar here would leak to peers. The figures live on the RLS-scoped performance_review row.
      payload: { cycleId: review.cycleId },
    });
    if (merit != null || bonus != null) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'performance-review',
        aggregateId: review.id,
        eventType: 'performance-review.comp-recommended',
        actor: actorOf(ctx),
        subjectEmploymentId: review.employmentId,
        payload: { cycleId: review.cycleId },
      });
    }
    return { status: 'submitted' as const };
  });
}

/** Employee acknowledges their (released) review. Self only; only after the cycle is released. */
export async function acknowledgeReview(ctx: SessionContext, p: { reviewId: string }) {
  return withTenant(ctx, async (tx) => {
    const { review, cycle, subjectPersonId } = await loadReview(tx, p.reviewId);
    const isSelf = ctx.personId != null && ctx.personId === subjectPersonId;
    if (!isSelf) throw new PerfError('Only the employee can acknowledge their own review');
    if (!cycle.releasedAt) throw new PerfError('This review has not been released yet');
    if (review.status !== 'submitted') throw new PerfError(`Cannot acknowledge a ${review.status} review`);
    await tx
      .update(performanceReview)
      .set({ status: 'acknowledged', acknowledgedAt: sql`now()` })
      .where(eq(performanceReview.id, review.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'performance-review',
      aggregateId: review.id,
      eventType: 'performance-review.acknowledged',
      actor: actorOf(ctx),
      subjectEmploymentId: review.employmentId,
    });
    return { status: 'acknowledged' as const };
  });
}

/** Admin re-points a review at a new reviewer (e.g. the manager changed mid-cycle). */
export async function reassignReviewer(
  ctx: SessionContext,
  p: { reviewId: string; reviewerEmploymentId: string | null },
) {
  return withTenant(ctx, async (tx) => {
    const { review, cycle, subjectPersonId } = await loadReview(tx, p.reviewId);
    if (!canAdminPerfCtx(ctx, cycle.companyId)) {
      throw new PerfError('Only an admin or performance & comp partner can reassign a reviewer');
    }
    if (cycle.status === 'closed') throw new PerfError('Cannot reassign on a closed cycle');
    if (review.status === 'submitted' || review.status === 'acknowledged') {
      throw new PerfError('Cannot reassign the reviewer on a finalized review');
    }
    if (p.reviewerEmploymentId) {
      const [cand] = await tx
        .select({ personId: employment.personId, terminatedOn: employment.terminatedOn })
        .from(employment)
        .where(eq(employment.id, p.reviewerEmploymentId))
        .limit(1);
      if (!cand) throw new PerfError('Reviewer employment not found');
      if (cand.terminatedOn) throw new PerfError('Cannot assign a terminated employee as reviewer');
      // The reviewer must never be the subject — that's the self-review ban via the side door.
      if (cand.personId === subjectPersonId) throw new PerfError('An employee cannot review themselves');
    }
    await tx
      .update(performanceReview)
      .set({ reviewerEmploymentId: p.reviewerEmploymentId })
      .where(eq(performanceReview.id, review.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'performance-review',
      aggregateId: review.id,
      eventType: 'performance-review.reviewer-reassigned',
      actor: actorOf(ctx),
      subjectEmploymentId: review.employmentId,
      payload: { reviewerEmploymentId: p.reviewerEmploymentId },
    });
    return { ok: true };
  });
}

// ───────────────────────────── Lifecycle stages (ADR-0022 extension) ─────────────────────────────
//
// The cycle runs up to three FIXED stages — goal-setting, mid-year (MYR), year-end (YER). This is
// column-widening, not a stage table: YER reuses the canonical self/manager/overall columns (so
// calibration, comp, release, acknowledge, distribution and AI stay untouched); MYR + goal-setting
// get their own column sets on performance_review. HR elects which stages run at initiation
// (review_cycle.stages JSONB; null ⇒ all three).

export type StageKind = 'goal_setting' | 'mid_year' | 'year_end';
export type CycleStage = { kind: StageKind; label: string; opensOn?: string | null; dueOn?: string | null };
export const ALL_STAGE_KINDS: StageKind[] = ['goal_setting', 'mid_year', 'year_end'];
const DEFAULT_STAGE_LABEL: Record<StageKind, string> = {
  goal_setting: 'Goal-setting',
  mid_year: 'Mid-year review',
  year_end: 'Year-end review',
};
const DEFAULT_STAGES: CycleStage[] = ALL_STAGE_KINDS.map((kind) => ({ kind, label: DEFAULT_STAGE_LABEL[kind] }));

/** The configured stages for a cycle (null/absent ⇒ all three). */
export function cycleStages(stages: unknown): CycleStage[] {
  if (!Array.isArray(stages) || stages.length === 0) return DEFAULT_STAGES;
  const out: CycleStage[] = [];
  for (const s of stages as CycleStage[]) {
    if (s && ALL_STAGE_KINDS.includes(s.kind)) {
      out.push({ kind: s.kind, label: s.label || DEFAULT_STAGE_LABEL[s.kind], opensOn: s.opensOn ?? null, dueOn: s.dueOn ?? null });
    }
  }
  return out.length > 0 ? out : DEFAULT_STAGES;
}
const cycleHasStage = (stages: unknown, kind: StageKind) => cycleStages(stages).some((s) => s.kind === kind);

/** The subject's personId for a review — for the explicit subject-ban (applies even to super_admin). */
async function reviewSubjectPersonId(tx: Tx, reviewId: string): Promise<{ personId: string | null; employmentId: string }> {
  const { review, subjectPersonId } = await loadReview(tx, reviewId);
  return { personId: subjectPersonId, employmentId: review.employmentId };
}

/** Employee submits their per-stage self-assessment (mid_year or year_end). Self-or-admin only.
 *  year_end writes through the canonical self columns + marches status exactly as submitSelfReview;
 *  mid_year writes its own MYR columns and leaves status untouched. Each function writes ONLY its
 *  own column set (the RLS-vs-service boundary: RLS is FOR ALL, the service scopes the columns). */
export async function submitStageSelf(
  ctx: SessionContext,
  p: { reviewId: string; stage: 'mid_year' | 'year_end'; selfRating: number; selfComments?: string; goalsSummary?: string },
) {
  return withTenant(ctx, async (tx) => {
    const { review, cycle, subjectPersonId } = await loadReview(tx, p.reviewId);
    const isSelf = ctx.personId != null && ctx.personId === subjectPersonId;
    if (!isSelf && !isAdminCtx(ctx)) throw new PerfError('Only the employee can submit their own self-review');
    if (cycle.status !== 'open') throw new PerfError(`The cycle is ${cycle.status}; reviews can only be edited while it is open`);
    if (!cycleHasStage(cycle.stages, p.stage)) throw new PerfError(`This cycle does not run the ${p.stage} stage`);
    assertRatingInScale(cycle.ratingScale as RatingScale, p.selfRating, 'Self rating');

    if (p.stage === 'year_end') {
      if (review.status !== 'self_review') throw new PerfError(`Self-review is not open (status: ${review.status})`);
      await tx
        .update(performanceReview)
        .set({ selfRating: p.selfRating, selfComments: p.selfComments ?? null, goalsSummary: p.goalsSummary ?? null, status: 'manager_review' })
        .where(eq(performanceReview.id, review.id));
    } else {
      // mid_year — its own columns; status (the YER machine) is untouched.
      await tx
        .update(performanceReview)
        .set({ midSelfRating: p.selfRating, midSelfComments: p.selfComments ?? null, midSelfSubmittedAt: sql`now()` })
        .where(eq(performanceReview.id, review.id));
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'performance-review',
      aggregateId: review.id,
      eventType: 'performance-review.stage-self-submitted',
      actor: actorOf(ctx),
      subjectEmploymentId: review.employmentId,
      payload: { cycleId: review.cycleId, stage: p.stage }, // no rating (tenant-wide event log)
    });
    return { stage: p.stage };
  });
}

/** Manager finalizes a per-stage evaluation (mid_year or year_end). Reviewer-or-admin, never self
 *  (assertCanDecide + an explicit subject-ban that ALSO applies to super_admin). year_end delegates
 *  to the canonical manager columns, marches status to submitted, and stamps preliminaryScore +
 *  forwarded-to-hr; mid_year writes only its MYR columns. */
export async function submitStageManager(
  ctx: SessionContext,
  p: { reviewId: string; stage: 'mid_year' | 'year_end'; managerRating: number; managerComments?: string; overallRating?: number },
) {
  return withTenant(ctx, async (tx) => {
    const { review, cycle, subjectPersonId } = await loadReview(tx, p.reviewId);
    if (cycle.status !== 'open') throw new PerfError(`The cycle is ${cycle.status}; reviews can only be edited while it is open`);
    if (!cycleHasStage(cycle.stages, p.stage)) throw new PerfError(`This cycle does not run the ${p.stage} stage`);
    await assertCanDecide(tx, ctx, review.employmentId, 'performance review');
    // Explicit subject-ban — applies even to super_admin (assertCanDecide lets super_admin self-decide).
    if (ctx.personId != null && ctx.personId === subjectPersonId) throw new PerfError('You cannot finalize your own review');
    const scale = cycle.ratingScale as RatingScale;
    assertRatingInScale(scale, p.managerRating, 'Manager rating');

    if (p.stage === 'year_end') {
      if (review.status !== 'manager_review' && review.status !== 'self_review') {
        throw new PerfError(`Manager review is not open (status: ${review.status})`);
      }
      const overall = p.overallRating ?? p.managerRating;
      assertRatingInScale(scale, overall, 'Overall rating');
      await tx
        .update(performanceReview)
        .set({
          managerRating: p.managerRating,
          managerComments: p.managerComments ?? null,
          overallRating: overall,
          // Forward the preliminary (manager-submitted) figure to HR for closure.
          preliminaryScore: money(overall),
          status: 'submitted',
          submittedAt: sql`now()`,
        })
        .where(eq(performanceReview.id, review.id));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'performance-review',
        aggregateId: review.id,
        eventType: 'performance-review.manager-submitted',
        actor: actorOf(ctx),
        subjectEmploymentId: review.employmentId,
        payload: { cycleId: review.cycleId, stage: p.stage },
      });
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'performance-review',
        aggregateId: review.id,
        eventType: 'performance-review.forwarded-to-hr',
        actor: actorOf(ctx),
        subjectEmploymentId: review.employmentId,
        payload: { cycleId: review.cycleId },
      });
      return { stage: p.stage, status: 'submitted' as const };
    }

    // mid_year — its own columns only; the YER status machine is untouched.
    await tx
      .update(performanceReview)
      .set({ midManagerRating: p.managerRating, midManagerComments: p.managerComments ?? null, midManagerSubmittedAt: sql`now()` })
      .where(eq(performanceReview.id, review.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'performance-review',
      aggregateId: review.id,
      eventType: 'performance-review.stage-manager-submitted',
      actor: actorOf(ctx),
      subjectEmploymentId: review.employmentId,
      payload: { cycleId: review.cycleId, stage: p.stage },
    });
    return { stage: p.stage };
  });
}

// ───────────────────────────── Goal-setting + lock (G2) ─────────────────────────────

/** Move the subject's cycle-bound goals from draft → proposed. Cycle-bound only (cycleId == the
 *  review's cycle) — a continuous goal (null cycleId) is never swept in. Throws if there are none. */
export async function proposeGoals(ctx: SessionContext, p: { reviewId: string }): Promise<{ proposed: number }> {
  return withTenant(ctx, async (tx) => {
    const { review } = await loadReview(tx, p.reviewId);
    const goals = await tx
      .select({ id: performanceGoal.id, status: performanceGoal.approvalStatus })
      .from(performanceGoal)
      .where(and(eq(performanceGoal.employmentId, review.employmentId), eq(performanceGoal.cycleId, review.cycleId)));
    if (goals.length === 0) throw new PerfError('Propose at least one goal for this cycle');
    let proposed = 0;
    for (const g of goals) {
      if (g.status !== 'draft') continue;
      await tx.update(performanceGoal).set({ approvalStatus: 'proposed', updatedAt: sql`now()` }).where(eq(performanceGoal.id, g.id));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'performance-goal',
        aggregateId: g.id,
        eventType: 'performance-goal.proposed',
        actor: actorOf(ctx),
        subjectEmploymentId: review.employmentId,
        payload: { cycleId: review.cycleId },
      });
      proposed += 1;
    }
    return { proposed };
  });
}

/** Manager/admin approves a proposed goal. Never the subject (explicit subject-ban + assertCanDecide). */
export async function approveGoal(ctx: SessionContext, p: { goalId: string }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const g = await loadGoal(tx, p.goalId);
    await assertCanDecide(tx, ctx, g.employmentId, 'goal approval');
    const [subj] = await tx.select({ personId: employment.personId }).from(employment).where(eq(employment.id, g.employmentId)).limit(1);
    if (ctx.personId != null && subj?.personId === ctx.personId) throw new PerfError('You cannot approve your own goal');
    if (g.approvalStatus !== 'proposed') throw new PerfError(`Only a proposed goal can be approved (it is ${g.approvalStatus})`);
    await tx
      .update(performanceGoal)
      .set({ approvalStatus: 'approved', approvedByUserId: ctx.userId ?? null, approvedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(performanceGoal.id, g.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'performance-goal',
      aggregateId: g.id,
      eventType: 'performance-goal.approved',
      actor: actorOf(ctx),
      subjectEmploymentId: g.employmentId,
    });
  });
}

/** Lock the goal-setting stage on a review: every cycle-bound goal must be approved first. After
 *  this, approved cycle-bound goals are immutable (see updateGoal/updateGoalProgress guards). */
export async function lockGoalSetting(ctx: SessionContext, p: { reviewId: string }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const { review, subjectPersonId } = await loadReview(tx, p.reviewId);
    await assertCanDecide(tx, ctx, review.employmentId, 'goal-setting lock');
    if (ctx.personId != null && ctx.personId === subjectPersonId) throw new PerfError('You cannot lock your own goal-setting');
    if (review.goalStageStatus === 'locked') throw new PerfError('Goal-setting is already locked');
    const unapproved = await tx
      .select({ id: performanceGoal.id })
      .from(performanceGoal)
      .where(
        and(
          eq(performanceGoal.employmentId, review.employmentId),
          eq(performanceGoal.cycleId, review.cycleId),
          sql`${performanceGoal.approvalStatus} <> 'approved'`,
        ),
      );
    if (unapproved.length > 0) throw new PerfError('Every cycle goal must be approved before locking goal-setting');
    await tx
      .update(performanceReview)
      .set({ goalStageStatus: 'locked', goalStageLockedAt: sql`now()` })
      .where(eq(performanceReview.id, review.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'performance-review',
      aggregateId: review.id,
      eventType: 'performance-review.goal-stage.locked',
      actor: actorOf(ctx),
      subjectEmploymentId: review.employmentId,
      payload: { cycleId: review.cycleId },
    });
  });
}

/** True if this cycle-bound goal is frozen by a locked goal-setting stage (its review is locked). */
async function goalIsStageLocked(tx: Tx, goal: { cycleId: string | null; employmentId: string }): Promise<boolean> {
  if (!goal.cycleId) return false; // continuous goals are never stage-locked
  const [rev] = await tx
    .select({ status: performanceReview.goalStageStatus })
    .from(performanceReview)
    .where(and(eq(performanceReview.cycleId, goal.cycleId), eq(performanceReview.employmentId, goal.employmentId)))
    .limit(1);
  return rev?.status === 'locked';
}

// ───────────────────────────── Final closure + ABC (G4) ─────────────────────────────

/** HR finalizes a review: lock the row, record finalScore (defaults to overallRating) + an ABC class
 *  + closedAt. Does NOT change status (the acknowledge path requires status === 'submitted').
 *  Asserts the cycle is released first, so closure is post-release and the notification can't leak the
 *  class before the subject is allowed to see ratings. */
export async function closeReview(
  ctx: SessionContext,
  p: { reviewId: string; finalScore?: number; abcClass: 'A' | 'B' | 'C' },
): Promise<{ finalScore: number; abcClass: 'A' | 'B' | 'C' }> {
  if (!['A', 'B', 'C'].includes(p.abcClass)) throw new PerfError('ABC class must be A, B, or C');
  return withTenant(ctx, async (tx) => {
    // Lock the row first (the enactCompAction pattern) so concurrent closes / a racing calibration
    // write can't interleave on a stale preliminary value.
    await tx.select({ id: performanceReview.id }).from(performanceReview).where(eq(performanceReview.id, p.reviewId)).for('update');
    const { review, cycle } = await loadReview(tx, p.reviewId);
    if (!canAdminPerfCtx(ctx, cycle.companyId)) {
      throw new PerfError('Only an admin or performance & comp partner can close a review');
    }
    if (!cycleHasStage(cycle.stages, 'year_end')) throw new PerfError('This cycle has no year-end stage to close');
    if (!cycle.releasedAt) throw new PerfError('Release the cycle before closing reviews');
    if (review.status !== 'submitted' && review.status !== 'acknowledged') {
      throw new PerfError('A review can only be closed once it is finalized');
    }
    if (review.closedAt) throw new PerfError('This review is already closed');
    const scale = cycle.ratingScale as RatingScale;
    const finalScore = p.finalScore ?? review.overallRating ?? undefined;
    if (finalScore == null) throw new PerfError('No overall rating to default the final score from');
    if (finalScore < scale[0].value || finalScore > scale[scale.length - 1].value) {
      throw new PerfError('Final score is outside the cycle rating scale');
    }
    await tx
      .update(performanceReview)
      .set({ finalScore: money(finalScore), abcClass: p.abcClass, closedAt: sql`now()` })
      .where(eq(performanceReview.id, review.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'performance-review',
      aggregateId: review.id,
      eventType: 'performance-review.closed',
      actor: actorOf(ctx),
      subjectEmploymentId: review.employmentId,
      payload: { cycleId: review.cycleId }, // no score/class (tenant-wide event log; notification is release-safe)
    });
    return { finalScore: round2(finalScore), abcClass: p.abcClass };
  });
}

// ───────────────────────────── Attachments (G5) ─────────────────────────────

/** Attach a file to a review for a stage (subject-scoped: employment_id denormalized from the
 *  review's subject, so RLS admits the subject + manager + admin, not peers). */
export async function addPerformanceAttachment(
  ctx: SessionContext,
  p: { reviewId: string; stageKind: StageKind | null; fileName: string; mimeType: string; content: Buffer },
): Promise<{ id: string }> {
  if (p.content.byteLength === 0) throw new PerfError('Empty file');
  if (p.content.byteLength > 10 * 1024 * 1024) throw new PerfError('File exceeds 10 MB');
  if (p.stageKind != null && !ALL_STAGE_KINDS.includes(p.stageKind)) throw new PerfError('Unknown stage');
  return withTenant(ctx, async (tx) => {
    const { review } = await loadReview(tx, p.reviewId);
    const [row] = await tx
      .insert(performanceAttachment)
      .values({
        tenantId: ctx.tenantId,
        reviewId: review.id,
        employmentId: review.employmentId,
        stageKind: p.stageKind,
        content: p.content,
        fileName: p.fileName,
        mimeType: p.mimeType,
        sizeBytes: p.content.byteLength,
        uploadedByUserId: ctx.userId ?? null,
      })
      .returning({ id: performanceAttachment.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'performance-review',
      aggregateId: review.id,
      eventType: 'performance-attachment.added',
      actor: actorOf(ctx),
      subjectEmploymentId: review.employmentId,
      payload: { stageKind: p.stageKind, fileName: p.fileName, sizeBytes: p.content.byteLength },
    });
    return { id: row.id };
  });
}

/** Read an attachment's bytes for download (RLS scopes visibility to the subject + manager + admin). */
export async function getPerformanceAttachment(
  ctx: SessionContext,
  attachmentId: string,
): Promise<{ content: Buffer; fileName: string; mimeType: string } | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ content: performanceAttachment.content, fileName: performanceAttachment.fileName, mimeType: performanceAttachment.mimeType })
      .from(performanceAttachment)
      .where(eq(performanceAttachment.id, attachmentId))
      .limit(1);
    return row ? { content: row.content, fileName: row.fileName, mimeType: row.mimeType } : null;
  });
}

export type AttachmentMeta = { id: string; stageKind: StageKind | null; fileName: string; sizeBytes: number; createdAt: string };

async function listAttachmentsForReviewTx(tx: Tx, reviewId: string): Promise<AttachmentMeta[]> {
  const rows = await tx
    .select({
      id: performanceAttachment.id,
      stageKind: performanceAttachment.stageKind,
      fileName: performanceAttachment.fileName,
      sizeBytes: performanceAttachment.sizeBytes,
      createdAt: performanceAttachment.createdAt,
    })
    .from(performanceAttachment)
    .where(eq(performanceAttachment.reviewId, reviewId))
    .orderBy(desc(performanceAttachment.createdAt));
  return rows.map((r) => ({
    id: r.id,
    stageKind: (r.stageKind as StageKind | null) ?? null,
    fileName: r.fileName,
    sizeBytes: r.sizeBytes,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Attachment metadata for a review (no bytes), grouped by stageKind. RLS scopes to the viewer. */
export function listAttachmentsForReview(ctx: SessionContext, reviewId: string): Promise<AttachmentMeta[]> {
  return withTenant(ctx, (tx) => listAttachmentsForReviewTx(tx, reviewId));
}

// ───────────────────────────── Pay seam (admin enacts) ─────────────────────────────

/** Enact a finalized recommendation through the existing pay engines. Performance never writes
 *  pay directly: merit → effective-dated setCompensation; bonus → payroll input on a draft batch
 *  (taxed as additional remuneration). Records the resulting ids on the review for the audit trail. */
export async function enactCompAction(
  ctx: SessionContext,
  p: { reviewId: string; meritEffectiveFrom?: string; bonusBatchId?: string },
) {
  return withTenant(ctx, async (tx) => {
    // Lock the review row first so two concurrent enacts can't both read 'recommended'.
    await tx.select({ id: performanceReview.id }).from(performanceReview).where(eq(performanceReview.id, p.reviewId)).for('update');
    const { review } = await loadReview(tx, p.reviewId);
    if (review.compActionStatus !== 'recommended') {
      throw new PerfError(`No recommendation to enact (comp action: ${review.compActionStatus})`);
    }
    if (review.status !== 'submitted' && review.status !== 'acknowledged') {
      throw new PerfError('A recommendation can only be enacted on a finalized review');
    }
    // No pay actions for someone who has left.
    const [emp] = await tx
      .select({
        companyId: employment.companyId,
        terminatedOn: employment.terminatedOn,
        // r374 — named in the no-basic refusal below, so the message identifies WHO cannot be given a
        // merit percentage. The code rather than the name: it is on this row already, it is what HR
        // searches by, and ADR-0030 keeps pay-adjacent messages off person detail.
        employeeCode: employment.employeeCode,
      })
      .from(employment)
      .where(eq(employment.id, review.employmentId))
      .limit(1);
    if (!emp) throw new PerfError('Employee not found');
    if (emp.terminatedOn) throw new PerfError('Cannot enact pay for a terminated employee');

    // ADR-0049 boundary. Merit → compensation is the perf-comp partner's territory; a bonus enact
    // writes payroll_input, which is the payroll function. So: enacting requires perf-comp access for
    // the merit path, AND additionally payroll access (admin OR payroll partner) when a bonus is being
    // enacted. A perf-comp partner records the recommendation on the review but cannot push bonus-to-pay.
    if (!canAdminPerfCtx(ctx, emp.companyId)) {
      throw new PerfError('Only an admin or performance & comp partner can enact a pay recommendation');
    }
    if (review.recommendedBonus != null) {
      const canEnactBonus =
        isAdminCtx(ctx) ||
        (ctx.grants ?? []).some(
          (g) => g.role === 'payroll_partner' && (g.companyId == null || g.companyId === emp.companyId),
        );
      if (!canEnactBonus) {
        throw new PerfError('Enacting a bonus requires payroll access (admin or payroll partner)');
      }
    }

    let enactedCompensationId: string | null = null;
    let enactedBatchId: string | null = null;

    if (review.recommendedMeritPct != null) {
      if (!p.meritEffectiveFrom) throw new PerfError('A merit increase needs an effective-from date');
      const [cur] = await tx
        .select({ basicSalary: compensation.basicSalary, validFrom: compensation.validFrom })
        .from(compensation)
        .where(
          and(
            eq(compensation.employmentId, review.employmentId),
            isNull(compensation.validTo),
            isNull(compensation.supersededAt),
          ),
        )
        .limit(1);
      if (!cur) throw new PerfError('Employee has no current compensation to increase');
      // r374 (item 7dbaf677) — A MERIT PERCENTAGE ON A ZERO BASIC IS REFUSED HERE, NAMING THE EMPLOYEE.
      //
      // Two reasons, and the second is why it is a refusal rather than a fix. First, the arithmetic is
      // meaningless: `0 × (1 + pct/100)` is 0, so the enact would record a raise that raises nothing.
      // Second, the write below passes NO remarks (deliberately — see the ADR-0078 note), and since r369
      // `setCompensation` refuses a non-positive basic with no remark. So without this, an enact from a
      // screen that has no Remarks field at all would surface `SalaryRemarkRequiredError`: a sentence
      // about director's fees, on the performance screen, telling an appraiser to write a salary remark
      // they cannot write. r374 made the zero basic reachable from both HR forms, so this stopped being
      // hypothetical.
      //
      // A DIRECTOR PAID QUARTERLY FEES IS NOT GIVEN A PERCENTAGE RAISE; their fee is changed. The right
      // place to record that is the Basic Salary screen, which the message names.
      if (!(Number(cur.basicSalary) > 0)) {
        throw new PerfError(
          `Employee ${emp.employeeCode ?? review.employmentId} has no monthly basic salary, so a merit ` +
            'percentage cannot be applied to it. Record the new amount on their Basic Salary record instead.',
        );
      }
      // Effective date must be after the current record starts, else the temporal range inverts.
      if (p.meritEffectiveFrom <= cur.validFrom) {
        throw new PerfError(`The effective date must be after the current pay started (${cur.validFrom})`);
      }
      const pct = Number(review.recommendedMeritPct);
      const newBasic = round2(Number(cur.basicSalary) * (1 + pct / 100));
      // Pass tx so the raise commits/rolls back atomically with the rest of the enact.
      // ADR-0078 — the merit % applies to the MONTHLY-EQUIVALENT basicSalary only. payMode / paymentTerm /
      // rateAmount are deliberately omitted: setCompensation CARRIES them FORWARD unchanged, so a merit
      // enact never silently scales a daily/hourly employee's rate_amount (re-rating is an explicit admin
      // action on the Basic Salary screen, not a side effect of a percentage raise).
      // r78c — the raise now carries a movement tag. It emitted `compensation.set` UNTAGGED, which the
      // Employment History projected as a generic "Salary Adjustment" with no movement behind it; an
      // enacted merit increase IS an Increment, and the tag both names it correctly and gives the leg a
      // groupId, so a future companion leg (a grade bump enacted with the raise) collapses into the same
      // row instead of opening a second one.
      const res = await setCompensation(
        ctx,
        {
          employmentId: review.employmentId,
          basicSalary: newBasic,
          effectiveFrom: p.meritEffectiveFrom,
          movement: { type: 'increment', groupId: randomUUID() },
        },
        tx,
      );
      enactedCompensationId = res.compensationId;
    }

    if (review.recommendedBonus != null) {
      if (!p.bonusBatchId) throw new PerfError('A bonus needs a target draft payroll batch');
      // The batch must belong to the employee's company, or generatePayslips would never pick it up.
      const [batch] = await tx
        .select({ companyId: payrollBatch.companyId, status: payrollBatch.status })
        .from(payrollBatch)
        .where(eq(payrollBatch.id, p.bonusBatchId))
        .limit(1);
      if (!batch) throw new PerfError('Payroll batch not found');
      if (batch.companyId !== emp.companyId) {
        throw new PerfError("The chosen batch belongs to a different company than the employee");
      }
      // Preserve any overtime / TP1 / zakat already keyed for this employee on the batch, plus the
      // OT rate-bucket decomposition (ot_breakdown) so enacting a bonus does not wipe a manual split.
      const [existing] = await tx
        .select({
          overtimeAmount: payrollInput.overtimeAmount,
          tp1Deduction: payrollInput.tp1Deduction,
          zakat: payrollInput.zakat,
          otBreakdown: payrollInput.otBreakdown,
        })
        .from(payrollInput)
        .where(and(eq(payrollInput.batchId, p.bonusBatchId), eq(payrollInput.employmentId, review.employmentId)))
        .limit(1);
      await setPayrollInput(
        ctx,
        {
          batchId: p.bonusBatchId,
          employmentId: review.employmentId,
          overtimeAmount: existing ? Number(existing.overtimeAmount) : 0,
          bonusAmount: Number(review.recommendedBonus),
          tp1Deduction: existing ? Number(existing.tp1Deduction) : 0,
          zakat: existing ? Number(existing.zakat) : 0,
          otBreakdown: existing?.otBreakdown ?? undefined,
          // Fix-5 (M#17): enacting a bonus carries the existing OT forward unchanged — preserve its
          // provenance rather than re-stamping it 'manual'.
          otSource: 'preserve',
        },
        tx,
      );
      enactedBatchId = p.bonusBatchId;
    }

    await tx
      .update(performanceReview)
      .set({ compActionStatus: 'enacted', enactedCompensationId, enactedBatchId, enactedAt: sql`now()` })
      .where(eq(performanceReview.id, review.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'performance-review',
      aggregateId: review.id,
      eventType: 'performance-review.comp-enacted',
      actor: actorOf(ctx),
      subjectEmploymentId: review.employmentId,
      // Ids only — the merit %/bonus amounts live on the RLS-scoped review row, not in the
      // tenant-wide event log.
      payload: { employmentId: review.employmentId, enactedCompensationId, enactedBatchId },
    });
    return { enactedCompensationId, enactedBatchId };
  });
}

export async function declineCompAction(ctx: SessionContext, p: { reviewId: string }) {
  return withTenant(ctx, async (tx) => {
    const { review, cycle } = await loadReview(tx, p.reviewId);
    if (!canAdminPerfCtx(ctx, cycle.companyId)) {
      throw new PerfError('Only an admin or performance & comp partner can decline a recommendation');
    }
    if (review.compActionStatus !== 'recommended') throw new PerfError('No pending recommendation to decline');
    await tx
      .update(performanceReview)
      .set({ compActionStatus: 'declined' })
      .where(eq(performanceReview.id, review.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'performance-review',
      aggregateId: review.id,
      eventType: 'performance-review.comp-declined',
      actor: actorOf(ctx),
      subjectEmploymentId: review.employmentId,
    });
    return { ok: true };
  });
}

// ───────────────────────────── internals ─────────────────────────────

async function loadCycle(tx: Tx, cycleId: string) {
  const [cycle] = await tx.select().from(reviewCycle).where(eq(reviewCycle.id, cycleId)).limit(1);
  if (!cycle) throw new PerfError('Review cycle not found (or not visible)');
  return cycle;
}

async function loadReview(tx: Tx, reviewId: string) {
  const [row] = await tx
    .select({ review: performanceReview, cycle: reviewCycle, subjectPersonId: employment.personId })
    .from(performanceReview)
    .innerJoin(reviewCycle, eq(reviewCycle.id, performanceReview.cycleId))
    .innerJoin(employment, eq(employment.id, performanceReview.employmentId))
    .where(eq(performanceReview.id, reviewId))
    .limit(1);
  if (!row) throw new PerfError('Performance review not found (or not visible)');
  return row;
}

// ───────────────────────────── reads (UI) ─────────────────────────────

export type CycleSummary = {
  id: string;
  name: string;
  companyId: string | null;
  periodStart: string;
  periodEnd: string;
  status: 'draft' | 'open' | 'calibration' | 'closed';
  releasedAt: Date | null;
  total: number;
  submitted: number; // manager-finalized or beyond
  acknowledged: number;
  pendingComp: number; // recommendations awaiting enactment
};

/** Cycles for the management view, each with progress counts. RLS scopes to the tenant. */
export function listCycles(ctx: SessionContext): Promise<CycleSummary[]> {
  return withTenant(ctx, async (tx) => {
    const cycles = await tx.select().from(reviewCycle).orderBy(desc(reviewCycle.periodStart));
    if (cycles.length === 0) return [];
    const counts = await tx
      .select({
        cycleId: performanceReview.cycleId,
        total: sql<number>`count(*)::int`,
        submitted: sql<number>`count(*) filter (where ${performanceReview.status} in ('submitted','acknowledged'))::int`,
        acknowledged: sql<number>`count(*) filter (where ${performanceReview.status} = 'acknowledged')::int`,
        pendingComp: sql<number>`count(*) filter (where ${performanceReview.compActionStatus} = 'recommended')::int`,
      })
      .from(performanceReview)
      .where(
        inArray(
          performanceReview.cycleId,
          cycles.map((c) => c.id),
        ),
      )
      .groupBy(performanceReview.cycleId);
    const byId = new Map(counts.map((c) => [c.cycleId, c]));
    return cycles.map((c) => {
      const k = byId.get(c.id);
      return {
        id: c.id,
        name: c.name,
        companyId: c.companyId,
        periodStart: c.periodStart,
        periodEnd: c.periodEnd,
        status: c.status,
        releasedAt: c.releasedAt,
        total: k?.total ?? 0,
        submitted: k?.submitted ?? 0,
        acknowledged: k?.acknowledged ?? 0,
        pendingComp: k?.pendingComp ?? 0,
      };
    });
  });
}

export type RosterRow = {
  reviewId: string;
  employee: string;
  employeeCode: string | null;
  reviewer: string | null;
  status: 'not_started' | 'self_review' | 'manager_review' | 'submitted' | 'acknowledged';
  selfRating: number | null;
  managerRating: number | null;
  overallRating: number | null;
  recommendedMeritPct: number | null;
  recommendedBonus: number | null;
  compActionStatus: 'none' | 'recommended' | 'enacted' | 'declined';
  currentBasic: number | null;
};

/** Full cycle detail for the admin: the roster, the rating distribution, and the merit-budget
 *  rollup (a soft cap — recommendations may exceed it; calibration trims). */
export function cycleDetail(ctx: SessionContext, cycleId: string) {
  return withTenant(ctx, async (tx) => {
    const [cycle] = await tx.select().from(reviewCycle).where(eq(reviewCycle.id, cycleId)).limit(1);
    if (!cycle) return null;
    const rows = await tx
      .select({
        reviewId: performanceReview.id,
        employee: person.fullName,
        employeeCode: employment.employeeCode,
        reviewerEmploymentId: performanceReview.reviewerEmploymentId,
        status: performanceReview.status,
        selfRating: performanceReview.selfRating,
        managerRating: performanceReview.managerRating,
        overallRating: performanceReview.overallRating,
        recommendedMeritPct: performanceReview.recommendedMeritPct,
        recommendedBonus: performanceReview.recommendedBonus,
        compActionStatus: performanceReview.compActionStatus,
        currentBasic: compensation.basicSalary,
      })
      .from(performanceReview)
      .innerJoin(employment, eq(employment.id, performanceReview.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(
        compensation,
        and(
          eq(compensation.employmentId, performanceReview.employmentId),
          isNull(compensation.validTo),
          isNull(compensation.supersededAt),
        ),
      )
      .where(eq(performanceReview.cycleId, cycleId))
      .orderBy(person.fullName);

    const reviewerNames = await namesForEmployments(
      tx,
      rows.map((r) => r.reviewerEmploymentId).filter((x): x is string => x != null),
    );

    const roster: RosterRow[] = rows.map((r) => ({
      reviewId: r.reviewId,
      employee: r.employee,
      employeeCode: r.employeeCode,
      reviewer: r.reviewerEmploymentId ? reviewerNames.get(r.reviewerEmploymentId) ?? null : null,
      status: r.status,
      selfRating: r.selfRating,
      managerRating: r.managerRating,
      overallRating: r.overallRating,
      recommendedMeritPct: r.recommendedMeritPct != null ? Number(r.recommendedMeritPct) : null,
      recommendedBonus: r.recommendedBonus != null ? Number(r.recommendedBonus) : null,
      compActionStatus: r.compActionStatus,
      currentBasic: r.currentBasic != null ? Number(r.currentBasic) : null,
    }));

    // Rating distribution over finalized reviews (the calibration view).
    const scale = cycle.ratingScale as RatingScale;
    const distribution = scale.map((s) => ({
      value: s.value,
      label: s.label,
      count: roster.filter((r) => r.overallRating === s.value).length,
    }));

    // Merit budget rollup. Pool: percent → % of in-scope payroll; amount → flat. Consumed: the RM
    // monthly increase implied by recommended/enacted merit %. Bonus shown alongside (not capped).
    //
    // Subtlety: once a merit is ENACTED, currentBasic is the already-raised salary, so a naive
    // currentBasic*pct would over-state the cost and inflate the pool as raises land. We recover the
    // PRE-raise basis for enacted-merit rows (newBasic / (1 + pct/100)) so both the pool denominator
    // and the consumed figure stay stable across enactment.
    const basisBasic = (r: RosterRow): number => {
      if (r.currentBasic == null) return 0;
      if (r.compActionStatus === 'enacted' && r.recommendedMeritPct != null) {
        return r.currentBasic / (1 + r.recommendedMeritPct / 100);
      }
      return r.currentBasic;
    };
    const totalBasic = roster.reduce((s, r) => s + basisBasic(r), 0);
    const meritConsumed = round2(
      roster.reduce(
        (s, r) =>
          r.recommendedMeritPct != null && (r.compActionStatus === 'recommended' || r.compActionStatus === 'enacted')
            ? s + basisBasic(r) * (r.recommendedMeritPct / 100)
            : s,
        0,
      ),
    );
    const bonusTotal = round2(
      roster.reduce(
        (s, r) =>
          r.recommendedBonus != null && (r.compActionStatus === 'recommended' || r.compActionStatus === 'enacted')
            ? s + r.recommendedBonus
            : s,
        0,
      ),
    );
    const mb = cycle.meritBudget as MeritBudget;
    const meritPool = mb == null ? null : mb.kind === 'percent' ? round2((mb.value / 100) * totalBasic) : round2(mb.value);
    const budget =
      meritPool == null
        ? { pool: null, consumed: meritConsumed, remaining: null, over: false, bonusTotal }
        : {
            pool: meritPool,
            consumed: meritConsumed,
            remaining: round2(meritPool - meritConsumed),
            over: meritConsumed > meritPool,
            bonusTotal,
          };

    return { cycle, roster, distribution, budget };
  });
}

export type ReviewView = {
  id: string;
  cycleId: string;
  cycleName: string;
  cycleStatus: string;
  periodStart: string;
  periodEnd: string;
  released: boolean;
  ratingScale: RatingScale;
  employee: string;
  employeeCode: string | null;
  reviewer: string | null;
  status: RosterRow['status'];
  selfRating: number | null;
  selfComments: string | null;
  goalsSummary: string | null;
  managerRating: number | null;
  managerComments: string | null;
  overallRating: number | null;
  // Mid-year stage (release-gated for the subject like the year-end manager side).
  midSelfRating: number | null;
  midSelfComments: string | null;
  midManagerRating: number | null;
  midManagerComments: string | null;
  // Goal-setting stage + closure (release-gated for the subject).
  goalStageStatus: 'pending' | 'locked';
  finalScore: number | null;
  abcClass: 'A' | 'B' | 'C' | null;
  closed: boolean;
  stages: CycleStage[];
  attachments: AttachmentMeta[];
  // comp fields — populated only for manager/admin viewers (never the subject)
  recommendedMeritPct: number | null;
  recommendedBonus: number | null;
  compActionStatus: RosterRow['compActionStatus'];
  // role + capability flags for the viewer
  isSubject: boolean;
  canManage: boolean; // reviewer or admin
  canSelfSubmit: boolean;
  canManagerSubmit: boolean;
  canAcknowledge: boolean;
};

/** One review, shaped for the viewer. The subject never sees the manager's draft (until release)
 *  nor the comp recommendation (ever); manager/admin see everything. RLS already gates row access. */
export function reviewForViewer(ctx: SessionContext, reviewId: string): Promise<ReviewView | null> {
  return withTenant(ctx, async (tx) => {
    const [r] = await tx
      .select({
        review: performanceReview,
        cycle: reviewCycle,
        employee: person.fullName,
        employeeCode: employment.employeeCode,
        subjectPersonId: employment.personId,
      })
      .from(performanceReview)
      .innerJoin(reviewCycle, eq(reviewCycle.id, performanceReview.cycleId))
      .innerJoin(employment, eq(employment.id, performanceReview.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(performanceReview.id, reviewId))
      .limit(1);
    if (!r) return null;

    // Resolve the reviewer's name + person (separate query — avoids a self-join on employment).
    let reviewerName: string | null = null;
    let reviewerPersonId: string | null = null;
    if (r.review.reviewerEmploymentId) {
      const [rv] = await tx
        .select({ name: person.fullName, personId: employment.personId })
        .from(employment)
        .innerJoin(person, eq(person.id, employment.personId))
        .where(eq(employment.id, r.review.reviewerEmploymentId))
        .limit(1);
      reviewerName = rv?.name ?? null;
      reviewerPersonId = rv?.personId ?? null;
    }

    const admin = isAdminCtx(ctx);
    const isSubject = ctx.personId != null && ctx.personId === r.subjectPersonId;
    const isReviewer = ctx.personId != null && ctx.personId === reviewerPersonId;
    const canManage = admin || isReviewer;
    const released = r.cycle.releasedAt != null;
    const rv = r.review;
    // The subject only sees the manager side after release, and never the comp recommendation.
    const showManager = canManage || released;
    const showComp = canManage; // comp recommendation is management-only

    const attachments = await listAttachmentsForReviewTx(tx, rv.id);

    return {
      id: rv.id,
      cycleId: rv.cycleId,
      cycleName: r.cycle.name,
      cycleStatus: r.cycle.status,
      periodStart: r.cycle.periodStart,
      periodEnd: r.cycle.periodEnd,
      released,
      ratingScale: r.cycle.ratingScale as RatingScale,
      employee: r.employee,
      employeeCode: r.employeeCode,
      reviewer: reviewerName,
      status: rv.status,
      selfRating: rv.selfRating,
      selfComments: rv.selfComments,
      goalsSummary: rv.goalsSummary,
      managerRating: showManager ? rv.managerRating : null,
      managerComments: showManager ? rv.managerComments : null,
      overallRating: showManager ? rv.overallRating : null,
      midSelfRating: rv.midSelfRating,
      midSelfComments: rv.midSelfComments,
      midManagerRating: showManager ? rv.midManagerRating : null,
      midManagerComments: showManager ? rv.midManagerComments : null,
      goalStageStatus: rv.goalStageStatus,
      finalScore: showManager && rv.finalScore != null ? Number(rv.finalScore) : null,
      abcClass: showManager ? (rv.abcClass as 'A' | 'B' | 'C' | null) : null,
      closed: rv.closedAt != null,
      stages: cycleStages(r.cycle.stages),
      attachments,
      recommendedMeritPct: showComp && rv.recommendedMeritPct != null ? Number(rv.recommendedMeritPct) : null,
      recommendedBonus: showComp && rv.recommendedBonus != null ? Number(rv.recommendedBonus) : null,
      compActionStatus: showComp ? rv.compActionStatus : 'none',
      isSubject,
      canManage,
      canSelfSubmit: isSubject && rv.status === 'self_review',
      canManagerSubmit: canManage && (rv.status === 'manager_review' || rv.status === 'self_review'),
      canAcknowledge: isSubject && released && rv.status === 'submitted',
    };
  });
}

/** The signed-in employee's own reviews (for /me). Released-gated like reviewForViewer. */
export function myReviews(ctx: SessionContext) {
  return withTenant(ctx, async (tx) => {
    if (!ctx.personId) return [];
    return tx
      .select({
        reviewId: performanceReview.id,
        cycleName: reviewCycle.name,
        status: performanceReview.status,
        released: sql<boolean>`${reviewCycle.releasedAt} is not null`,
        overallRating: sql<number | null>`case when ${reviewCycle.releasedAt} is not null then ${performanceReview.overallRating} end`,
        finalScore: sql<string | null>`case when ${reviewCycle.releasedAt} is not null then ${performanceReview.finalScore} end`,
        abcClass: sql<'A' | 'B' | 'C' | null>`case when ${reviewCycle.releasedAt} is not null then ${performanceReview.abcClass} end`,
        periodEnd: reviewCycle.periodEnd,
      })
      .from(performanceReview)
      .innerJoin(reviewCycle, eq(reviewCycle.id, performanceReview.cycleId))
      .innerJoin(employment, eq(employment.id, performanceReview.employmentId))
      .where(eq(employment.personId, ctx.personId))
      .orderBy(desc(reviewCycle.periodEnd));
  });
}

/** Reviews awaiting the signed-in manager's action (manager_review, they are the reviewer). */
export function managerPendingReviews(ctx: SessionContext) {
  return withTenant(ctx, async (tx) => {
    if (!ctx.personId) return [];
    // The viewer's own employment ids (a person may hold concurrent employments / be a reviewer).
    const mine = await tx
      .select({ id: employment.id })
      .from(employment)
      .where(eq(employment.personId, ctx.personId));
    const myEmploymentIds = mine.map((m) => m.id);
    if (myEmploymentIds.length === 0) return [];
    // Surface both 'manager_review' (employee self-submitted, your turn) and 'self_review' (employee
    // hasn't self-assessed — you can still finalize; the service allows it, so it must be findable).
    // Only on OPEN cycles (calibration/closed are frozen).
    return tx
      .select({
        reviewId: performanceReview.id,
        employee: person.fullName,
        employeeCode: employment.employeeCode,
        cycleName: reviewCycle.name,
        status: performanceReview.status,
      })
      .from(performanceReview)
      .innerJoin(reviewCycle, eq(reviewCycle.id, performanceReview.cycleId))
      .innerJoin(employment, eq(employment.id, performanceReview.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          inArray(performanceReview.reviewerEmploymentId, myEmploymentIds),
          inArray(performanceReview.status, ['manager_review', 'self_review']),
          eq(reviewCycle.status, 'open'),
        ),
      )
      .orderBy(reviewCycle.name, person.fullName);
  });
}

/** Map a set of employment ids → person full name (one query). */
async function namesForEmployments(tx: Tx, employmentIds: string[]): Promise<Map<string, string>> {
  if (employmentIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: employment.id, name: person.fullName })
    .from(employment)
    .innerJoin(person, eq(person.id, employment.personId))
    .where(inArray(employment.id, [...new Set(employmentIds)]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Map a set of employment ids → employee_code (one query). Nullable per employment. */
async function codesForEmployments(tx: Tx, employmentIds: string[]): Promise<Map<string, string | null>> {
  if (employmentIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: employment.id, code: employment.employeeCode })
    .from(employment)
    .where(inArray(employment.id, [...new Set(employmentIds)]));
  return new Map(rows.map((r) => [r.id, r.code]));
}

/** The current administrative-line manager's employment id, or null (top of org).
 *  Exported (0110) so the employment-review service reuses the SAME reporting-line query — no duplication. */
export async function currentAdminManager(tx: Tx, tenantId: string, subjectEmploymentId: string): Promise<string | null> {
  const [mgr] = await tx
    .select({ id: reportingLine.managerEmploymentId })
    .from(reportingLine)
    .where(
      and(
        eq(reportingLine.tenantId, tenantId),
        eq(reportingLine.subordinateEmploymentId, subjectEmploymentId),
        eq(reportingLine.lineType, 'administrative'),
        lte(reportingLine.validFrom, sql`current_date`),
        or(isNull(reportingLine.validTo), sql`${reportingLine.validTo} > current_date`),
        isNull(reportingLine.supersededAt),
      ),
    )
    .limit(1);
  return mgr?.id ?? null;
}

// ─────────────────────────── Goals / OKRs (ADR-0022, Phase B) ───────────────────────────
//
// Continuous + cycle-linkable: a goal is owned by an employment and may bind to a cycle (cycle_id)
// or live standalone (null). RLS (can_see_employment) scopes who can read/write — the subject, their
// admin-line manager, and admins co-own. Goals are REFERENCE SIGNAL ONLY: nothing here computes a
// rating or pay (ADR-0022 principle 1). Lifecycle is a status (active → achieved/missed/dropped)
// plus a 0–100 progress.

export type GoalStatus = 'active' | 'achieved' | 'missed' | 'dropped';
export type GoalRow = {
  id: string;
  employmentId: string;
  cycleId: string | null;
  cycleName: string | null;
  title: string;
  description: string | null;
  metric: string | null;
  target: string | null;
  weight: number | null;
  progress: number;
  status: GoalStatus;
  dueOn: string | null;
  createdAt: string;
  updatedAt: string;
};

const clampProgress = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

const goalSelect = () => ({
  id: performanceGoal.id,
  employmentId: performanceGoal.employmentId,
  cycleId: performanceGoal.cycleId,
  cycleName: reviewCycle.name,
  title: performanceGoal.title,
  description: performanceGoal.description,
  metric: performanceGoal.metric,
  target: performanceGoal.target,
  weight: performanceGoal.weight,
  progress: performanceGoal.progress,
  status: performanceGoal.status,
  dueOn: performanceGoal.dueOn,
  createdAt: performanceGoal.createdAt,
  updatedAt: performanceGoal.updatedAt,
});
type RawGoal = {
  id: string; employmentId: string; cycleId: string | null; cycleName: string | null;
  title: string; description: string | null; metric: string | null; target: string | null;
  weight: string | null; progress: number; status: GoalStatus; dueOn: string | null;
  createdAt: Date; updatedAt: Date;
};
const toGoalRow = (r: RawGoal): GoalRow => ({
  id: r.id, employmentId: r.employmentId, cycleId: r.cycleId, cycleName: r.cycleName,
  title: r.title, description: r.description, metric: r.metric, target: r.target,
  weight: r.weight == null ? null : Number(r.weight),
  progress: r.progress, status: r.status, dueOn: r.dueOn,
  createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
});

/** Create a goal for an employment (continuous, optionally bound to a cycle). RLS WITH CHECK ensures
 *  only the subject / their manager / an admin can — a peer cannot create a goal for someone else. */
export async function createGoal(
  ctx: SessionContext,
  p: {
    employmentId: string;
    cycleId?: string | null;
    title: string;
    description?: string;
    metric?: string;
    target?: string;
    weight?: number | null;
    dueOn?: string | null;
  },
): Promise<{ id: string }> {
  const title = p.title.trim();
  if (!title) throw new PerfError('A goal needs a title');
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(performanceGoal)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        cycleId: p.cycleId ?? null,
        title,
        description: p.description?.trim() || null,
        metric: p.metric?.trim() || null,
        target: p.target?.trim() || null,
        weight: p.weight != null ? money(p.weight) : null,
        dueOn: p.dueOn || null,
        createdByUserId: ctx.userId ?? null,
      })
      .returning({ id: performanceGoal.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'performance-goal',
      aggregateId: row.id,
      eventType: 'performance-goal.created',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { cycleId: p.cycleId ?? null },
    });
    return { id: row.id };
  });
}

async function loadGoal(tx: Tx, goalId: string) {
  const [g] = await tx.select().from(performanceGoal).where(eq(performanceGoal.id, goalId)).limit(1);
  if (!g) throw new PerfError('Goal not found'); // RLS-invisible goals read as not-found
  return g;
}

/** Edit a goal's descriptive fields (not its progress/status — that's updateGoalProgress). */
export async function updateGoal(
  ctx: SessionContext,
  p: { goalId: string; title?: string; description?: string; metric?: string; target?: string; weight?: number | null; dueOn?: string | null },
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const g = await loadGoal(tx, p.goalId);
    const title = p.title?.trim();
    if (p.title != null && !title) throw new PerfError('A goal needs a title');
    // Once goal-setting is locked, an approved cycle-bound goal is immutable.
    if (await goalIsStageLocked(tx, g)) throw new PerfError('This goal is locked — goal-setting has been finalized');
    await tx
      .update(performanceGoal)
      .set({
        title: title ?? g.title,
        description: p.description !== undefined ? (p.description?.trim() || null) : g.description,
        metric: p.metric !== undefined ? (p.metric?.trim() || null) : g.metric,
        target: p.target !== undefined ? (p.target?.trim() || null) : g.target,
        weight: p.weight !== undefined ? (p.weight != null ? money(p.weight) : null) : g.weight,
        dueOn: p.dueOn !== undefined ? (p.dueOn || null) : g.dueOn,
        updatedAt: sql`now()`,
      })
      .where(eq(performanceGoal.id, g.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'performance-goal',
      aggregateId: g.id,
      eventType: 'performance-goal.updated',
      actor: actorOf(ctx),
      subjectEmploymentId: g.employmentId,
    });
  });
}

/** Track progress (0–100) and/or move the lifecycle (active → achieved/missed/dropped). */
export async function updateGoalProgress(
  ctx: SessionContext,
  p: { goalId: string; progress?: number; status?: GoalStatus },
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const g = await loadGoal(tx, p.goalId);
    if (await goalIsStageLocked(tx, g)) throw new PerfError('This goal is locked — goal-setting has been finalized');
    const progress = p.progress != null ? clampProgress(p.progress) : g.progress;
    const status = p.status ?? g.status;
    await tx
      .update(performanceGoal)
      .set({ progress, status, updatedAt: sql`now()` })
      .where(eq(performanceGoal.id, g.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'performance-goal',
      aggregateId: g.id,
      eventType: 'performance-goal.progressed',
      actor: actorOf(ctx),
      subjectEmploymentId: g.employmentId,
      payload: { status }, // progress value omitted (tenant-wide event log)
    });
  });
}

/** Link a goal onto a review so the manager can reference what was worked on. The goal and review
 *  must belong to the same subject. RLS scopes visibility; this is reversible reference, not a decision. */
export async function linkGoalToReview(ctx: SessionContext, p: { reviewId: string; goalId: string }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const { review } = await loadReview(tx, p.reviewId);
    const goal = await loadGoal(tx, p.goalId);
    if (goal.employmentId !== review.employmentId) {
      throw new PerfError('That goal belongs to a different employee');
    }
    const [existing] = await tx
      .select({ id: reviewGoal.id })
      .from(reviewGoal)
      .where(and(eq(reviewGoal.reviewId, p.reviewId), eq(reviewGoal.goalId, p.goalId)))
      .limit(1);
    if (existing) return; // idempotent
    await tx.insert(reviewGoal).values({ tenantId: ctx.tenantId, reviewId: p.reviewId, goalId: p.goalId });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'performance-review',
      aggregateId: p.reviewId,
      eventType: 'performance-review.goal-linked',
      actor: actorOf(ctx),
      subjectEmploymentId: review.employmentId,
      payload: { goalId: p.goalId },
    });
  });
}

export async function unlinkGoalFromReview(ctx: SessionContext, p: { reviewId: string; goalId: string }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const { review } = await loadReview(tx, p.reviewId);
    await tx.delete(reviewGoal).where(and(eq(reviewGoal.reviewId, p.reviewId), eq(reviewGoal.goalId, p.goalId)));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'performance-review',
      aggregateId: p.reviewId,
      eventType: 'performance-review.goal-unlinked',
      actor: actorOf(ctx),
      subjectEmploymentId: review.employmentId,
      payload: { goalId: p.goalId },
    });
  });
}

// ── Goal reads (RLS scopes each to the viewer) ──

/** Goals for one employment, newest first (manager viewing a report; admin; self). */
export function listGoalsForEmployment(ctx: SessionContext, employmentId: string): Promise<GoalRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select(goalSelect())
      .from(performanceGoal)
      .leftJoin(reviewCycle, eq(reviewCycle.id, performanceGoal.cycleId))
      .where(eq(performanceGoal.employmentId, employmentId))
      .orderBy(desc(performanceGoal.createdAt));
    return rows.map(toGoalRow);
  });
}

/** The signed-in person's own goals across their employment(s) — the /me surface. */
export function myGoals(ctx: SessionContext): Promise<GoalRow[]> {
  return withTenant(ctx, async (tx) => {
    if (!ctx.personId) return [];
    const mine = await tx.select({ id: employment.id }).from(employment).where(eq(employment.personId, ctx.personId));
    const ids = mine.map((m) => m.id);
    if (ids.length === 0) return [];
    const rows = await tx
      .select(goalSelect())
      .from(performanceGoal)
      .leftJoin(reviewCycle, eq(reviewCycle.id, performanceGoal.cycleId))
      .where(inArray(performanceGoal.employmentId, ids))
      .orderBy(desc(performanceGoal.createdAt));
    return rows.map(toGoalRow);
  });
}

/** Goals linked onto a review (shown on the review page). */
export function goalsForReview(ctx: SessionContext, reviewId: string): Promise<GoalRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select(goalSelect())
      .from(reviewGoal)
      .innerJoin(performanceGoal, eq(performanceGoal.id, reviewGoal.goalId))
      .leftJoin(reviewCycle, eq(reviewCycle.id, performanceGoal.cycleId))
      .where(eq(reviewGoal.reviewId, reviewId))
      .orderBy(desc(performanceGoal.createdAt));
    return rows.map(toGoalRow);
  });
}

/** For the review page: the goals already linked + the subject's other goals available to link. */
export function reviewGoals(ctx: SessionContext, reviewId: string): Promise<{ linked: GoalRow[]; linkable: GoalRow[] }> {
  return withTenant(ctx, async (tx) => {
    const [r] = await tx
      .select({ employmentId: performanceReview.employmentId })
      .from(performanceReview)
      .where(eq(performanceReview.id, reviewId))
      .limit(1);
    if (!r) return { linked: [], linkable: [] };
    const linkedRows = await tx
      .select(goalSelect())
      .from(reviewGoal)
      .innerJoin(performanceGoal, eq(performanceGoal.id, reviewGoal.goalId))
      .leftJoin(reviewCycle, eq(reviewCycle.id, performanceGoal.cycleId))
      .where(eq(reviewGoal.reviewId, reviewId))
      .orderBy(desc(performanceGoal.createdAt));
    const allRows = await tx
      .select(goalSelect())
      .from(performanceGoal)
      .leftJoin(reviewCycle, eq(reviewCycle.id, performanceGoal.cycleId))
      .where(eq(performanceGoal.employmentId, r.employmentId))
      .orderBy(desc(performanceGoal.createdAt));
    const linkedIds = new Set(linkedRows.map((g) => g.id));
    return {
      linked: linkedRows.map(toGoalRow),
      linkable: allRows.filter((g) => !linkedIds.has(g.id)).map(toGoalRow),
    };
  });
}

// ─────────────────────── Manager 1:1 check-ins (ADR-0022, slice 2) ───────────────────────
//
// A continuous touchpoint between a manager and a report — no cycle required. The manager (or admin)
// schedules and completes; the subject reads their own. RLS scopes to can_see_employment(subject);
// the service bans self-scheduling (assertCanDecide) so a check-in is always manager↔report.

export type CheckinStatus = 'scheduled' | 'completed' | 'cancelled';
export type CheckinRow = {
  id: string;
  subjectEmploymentId: string;
  subject: string;
  manager: string | null;
  scheduledOn: string;
  status: CheckinStatus;
  notes: string | null;
  completedAt: string | null;
};

/** Schedule a 1:1 with a report. Manager-or-admin only (assertCanDecide bans self). The manager is
 *  resolved to the subject's current administrative manager. */
export async function scheduleCheckIn(
  ctx: SessionContext,
  p: { subjectEmploymentId: string; scheduledOn: string; notes?: string },
): Promise<{ id: string }> {
  if (!p.scheduledOn) throw new PerfError('A check-in needs a date');
  return withTenant(ctx, async (tx) => {
    await assertCanDecide(tx, ctx, p.subjectEmploymentId, 'check-in');
    const managerEmploymentId = await currentAdminManager(tx, ctx.tenantId, p.subjectEmploymentId);
    const [row] = await tx
      .insert(performanceCheckin)
      .values({
        tenantId: ctx.tenantId,
        subjectEmploymentId: p.subjectEmploymentId,
        managerEmploymentId,
        scheduledOn: p.scheduledOn,
        notes: p.notes?.trim() || null,
        createdByUserId: ctx.userId ?? null,
      })
      .returning({ id: performanceCheckin.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'performance-checkin',
      aggregateId: row.id,
      eventType: 'performance-checkin.scheduled',
      actor: actorOf(ctx),
      subjectEmploymentId: p.subjectEmploymentId,
      payload: { scheduledOn: p.scheduledOn },
    });
    return { id: row.id };
  });
}

async function loadCheckin(tx: Tx, checkinId: string) {
  const [c] = await tx.select().from(performanceCheckin).where(eq(performanceCheckin.id, checkinId)).limit(1);
  if (!c) throw new PerfError('Check-in not found');
  return c;
}

/** Mark a scheduled check-in completed, capturing the shared notes. Manager-or-admin. */
export async function completeCheckIn(ctx: SessionContext, p: { checkinId: string; notes?: string }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const c = await loadCheckin(tx, p.checkinId);
    if (c.status !== 'scheduled') throw new PerfError(`This check-in is ${c.status}`);
    await assertCanDecide(tx, ctx, c.subjectEmploymentId, 'check-in');
    await tx
      .update(performanceCheckin)
      .set({ status: 'completed', completedAt: new Date(), notes: p.notes?.trim() ?? c.notes })
      .where(eq(performanceCheckin.id, c.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'performance-checkin',
      aggregateId: c.id,
      eventType: 'performance-checkin.completed',
      actor: actorOf(ctx),
      subjectEmploymentId: c.subjectEmploymentId,
    });
  });
}

/** Cancel a scheduled check-in. Manager-or-admin. */
export async function cancelCheckIn(ctx: SessionContext, p: { checkinId: string }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const c = await loadCheckin(tx, p.checkinId);
    if (c.status !== 'scheduled') throw new PerfError(`This check-in is ${c.status}`);
    await assertCanDecide(tx, ctx, c.subjectEmploymentId, 'check-in');
    await tx.update(performanceCheckin).set({ status: 'cancelled' }).where(eq(performanceCheckin.id, c.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'performance-checkin',
      aggregateId: c.id,
      eventType: 'performance-checkin.cancelled',
      actor: actorOf(ctx),
      subjectEmploymentId: c.subjectEmploymentId,
    });
  });
}

const checkinSelect = () => ({
  id: performanceCheckin.id,
  subjectEmploymentId: performanceCheckin.subjectEmploymentId,
  managerEmploymentId: performanceCheckin.managerEmploymentId,
  scheduledOn: performanceCheckin.scheduledOn,
  status: performanceCheckin.status,
  notes: performanceCheckin.notes,
  completedAt: performanceCheckin.completedAt,
});
type RawCheckin = {
  id: string; subjectEmploymentId: string; managerEmploymentId: string | null; scheduledOn: string;
  status: CheckinStatus; notes: string | null; completedAt: Date | null;
};
const toCheckinRow = (r: RawCheckin, names: Map<string, string>): CheckinRow => ({
  id: r.id,
  subjectEmploymentId: r.subjectEmploymentId,
  subject: names.get(r.subjectEmploymentId) ?? '—',
  manager: r.managerEmploymentId ? (names.get(r.managerEmploymentId) ?? null) : null,
  scheduledOn: r.scheduledOn,
  status: r.status,
  notes: r.notes,
  completedAt: r.completedAt ? r.completedAt.toISOString() : null,
});

async function hydrateCheckins(tx: Tx, rows: RawCheckin[]): Promise<CheckinRow[]> {
  const ids = rows.flatMap((r) => [r.subjectEmploymentId, r.managerEmploymentId].filter(Boolean) as string[]);
  const names = await namesForEmployments(tx, ids);
  return rows.map((r) => toCheckinRow(r, names));
}

/** The signed-in person's own check-ins (as the subject) — the /me surface. */
export function myCheckIns(ctx: SessionContext): Promise<CheckinRow[]> {
  return withTenant(ctx, async (tx) => {
    if (!ctx.personId) return [];
    const mine = await tx.select({ id: employment.id }).from(employment).where(eq(employment.personId, ctx.personId));
    const ids = mine.map((m) => m.id);
    if (ids.length === 0) return [];
    const rows = await tx
      .select(checkinSelect())
      .from(performanceCheckin)
      .where(inArray(performanceCheckin.subjectEmploymentId, ids))
      .orderBy(desc(performanceCheckin.scheduledOn));
    return hydrateCheckins(tx, rows as RawCheckin[]);
  });
}

/** Check-ins the signed-in manager runs (they are the manager) + their direct reports for scheduling. */
export function managerCheckIns(ctx: SessionContext): Promise<{ checkins: CheckinRow[]; reports: { employmentId: string; name: string }[] }> {
  return withTenant(ctx, async (tx) => {
    if (!ctx.personId) return { checkins: [], reports: [] };
    const mine = await tx.select({ id: employment.id }).from(employment).where(eq(employment.personId, ctx.personId));
    const myIds = mine.map((m) => m.id);
    if (myIds.length === 0) return { checkins: [], reports: [] };
    const rows = await tx
      .select(checkinSelect())
      .from(performanceCheckin)
      .where(inArray(performanceCheckin.managerEmploymentId, myIds))
      .orderBy(desc(performanceCheckin.scheduledOn));
    const checkins = await hydrateCheckins(tx, rows as RawCheckin[]);
    // The manager's current direct admin-line reports (the schedule picker).
    const reportRows = await tx
      .select({ employmentId: reportingLine.subordinateEmploymentId, name: person.fullName })
      .from(reportingLine)
      .innerJoin(employment, eq(employment.id, reportingLine.subordinateEmploymentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          inArray(reportingLine.managerEmploymentId, myIds),
          eq(reportingLine.lineType, 'administrative'),
          lte(reportingLine.validFrom, sql`current_date`),
          or(isNull(reportingLine.validTo), sql`${reportingLine.validTo} > current_date`),
          isNull(reportingLine.supersededAt),
        ),
      )
      .orderBy(person.fullName);
    return { checkins, reports: reportRows };
  });
}

// ─────────────────────── 360 peer feedback (ADR-0022, slice 3) ───────────────────────
//
// A manager/admin invites peers to give feedback on a subject for a review; each peer responds to their
// OWN request. Anonymity (ADR-0022 default): the subject sees feedback content without authorship and
// never the requester list — enforced by RLS (peer_feedback carries no author; the identity is on the
// request, which the subject's RLS denies). The manager sees attributed feedback for accountability.

/** Invite peers to give 360 feedback on a review's subject. Manager/admin only (assertCanDecide). */
export async function requestPeerFeedback(
  ctx: SessionContext,
  p: { reviewId: string; peerEmploymentIds: string[] },
): Promise<{ created: number }> {
  return withTenant(ctx, async (tx) => {
    const { review, cycle } = await loadReview(tx, p.reviewId);
    await assertCanDecide(tx, ctx, review.employmentId, 'peer feedback');
    const existing = await tx
      .select({ peer: peerFeedbackRequest.peerEmploymentId })
      .from(peerFeedbackRequest)
      .where(eq(peerFeedbackRequest.reviewId, p.reviewId));
    const already = new Set(existing.map((e) => e.peer));
    // Names resolved by the inviting manager (who can see the subject + the picked peers) and denormalized
    // onto the request — a 360 crosses RLS name-visibility, so they can't be re-resolved by peer/manager later.
    const names = await namesForEmployments(tx, [review.employmentId, ...p.peerEmploymentIds]);
    const subjectName = names.get(review.employmentId) ?? '—';
    let created = 0;
    for (const peerEmploymentId of [...new Set(p.peerEmploymentIds)]) {
      if (peerEmploymentId === review.employmentId) continue; // never the subject themselves
      if (already.has(peerEmploymentId)) continue; // idempotent per (review, peer)
      const [row] = await tx
        .insert(peerFeedbackRequest)
        .values({
          tenantId: ctx.tenantId,
          reviewId: p.reviewId,
          subjectEmploymentId: review.employmentId,
          peerEmploymentId,
          subjectName,
          peerName: names.get(peerEmploymentId) ?? '—',
          cycleName: cycle.name,
          requestedByUserId: ctx.userId ?? null,
        })
        .returning({ id: peerFeedbackRequest.id });
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'peer-feedback-request',
        aggregateId: row.id,
        eventType: 'peer-feedback-request.created',
        actor: actorOf(ctx),
        subjectEmploymentId: review.employmentId,
        payload: { reviewId: p.reviewId },
      });
      created += 1;
    }
    return { created };
  });
}

/** The peer submits their feedback for one of their own pending requests. RLS guarantees the writer is
 *  the peer; the service guards the pending state + carries the denormalized subject for RLS. */
export async function submitPeerFeedback(
  ctx: SessionContext,
  p: { requestId: string; strengths?: string; improvements?: string; named?: boolean },
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [rq] = await tx.select().from(peerFeedbackRequest).where(eq(peerFeedbackRequest.id, p.requestId)).limit(1);
    if (!rq) throw new PerfError('Feedback request not found'); // RLS-invisible → not found
    if (rq.status !== 'pending') throw new PerfError(`This request is already ${rq.status}`);
    await tx.insert(peerFeedback).values({
      tenantId: ctx.tenantId,
      requestId: rq.id,
      subjectEmploymentId: rq.subjectEmploymentId,
      strengths: p.strengths?.trim() || null,
      improvements: p.improvements?.trim() || null,
      named: p.named ?? false,
    });
    await tx.update(peerFeedbackRequest).set({ status: 'submitted' }).where(eq(peerFeedbackRequest.id, rq.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'peer-feedback-request',
      aggregateId: rq.id,
      eventType: 'peer-feedback-request.submitted',
      actor: actorOf(ctx),
      subjectEmploymentId: rq.subjectEmploymentId,
    });
  });
}

/** The peer declines a request. */
export async function declinePeerFeedback(ctx: SessionContext, p: { requestId: string }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const [rq] = await tx.select().from(peerFeedbackRequest).where(eq(peerFeedbackRequest.id, p.requestId)).limit(1);
    if (!rq) throw new PerfError('Feedback request not found');
    if (rq.status !== 'pending') throw new PerfError(`This request is already ${rq.status}`);
    await tx.update(peerFeedbackRequest).set({ status: 'declined' }).where(eq(peerFeedbackRequest.id, rq.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'peer-feedback-request',
      aggregateId: rq.id,
      eventType: 'peer-feedback-request.declined',
      actor: actorOf(ctx),
      subjectEmploymentId: rq.subjectEmploymentId,
    });
  });
}

export type FeedbackRequestRow = { requestId: string; subject: string; cycleName: string };

/** The signed-in peer's pending feedback requests — "give 360 feedback". */
export function myFeedbackRequests(ctx: SessionContext): Promise<FeedbackRequestRow[]> {
  return withTenant(ctx, async (tx) => {
    if (!ctx.personId) return [];
    const mine = await tx.select({ id: employment.id }).from(employment).where(eq(employment.personId, ctx.personId));
    const ids = mine.map((m) => m.id);
    if (ids.length === 0) return [];
    // Names are denormalized on the request — the peer can't re-resolve the subject's name via RLS.
    const rows = await tx
      .select({
        requestId: peerFeedbackRequest.id,
        subject: peerFeedbackRequest.subjectName,
        cycleName: peerFeedbackRequest.cycleName,
      })
      .from(peerFeedbackRequest)
      .where(and(inArray(peerFeedbackRequest.peerEmploymentId, ids), eq(peerFeedbackRequest.status, 'pending')))
      .orderBy(desc(peerFeedbackRequest.createdAt));
    return rows.map((r) => ({ requestId: r.requestId, subject: r.subject, cycleName: r.cycleName ?? '' }));
  });
}

export type FeedbackRow = {
  id: string;
  strengths: string | null;
  improvements: string | null;
  // Attributed peer name — present for the manager/admin view, null (anonymous) for the subject.
  peer: string | null;
};

/** Viewer flags for a review, at the tx level (canManage / isSubject / released). Returns null if the
 *  review is not visible to the caller. */
async function reviewViewerFlags(
  tx: Tx,
  ctx: SessionContext,
  reviewId: string,
): Promise<{ canManage: boolean; isSubject: boolean; released: boolean } | null> {
  let loaded: Awaited<ReturnType<typeof loadReview>>;
  try {
    loaded = await loadReview(tx, reviewId);
  } catch {
    return null;
  }
  const { review, cycle, subjectPersonId } = loaded;
  let reviewerPersonId: string | null = null;
  if (review.reviewerEmploymentId) {
    const [rv] = await tx
      .select({ personId: employment.personId })
      .from(employment)
      .where(eq(employment.id, review.reviewerEmploymentId))
      .limit(1);
    reviewerPersonId = rv?.personId ?? null;
  }
  const admin = isAdminCtx(ctx);
  const isSubject = ctx.personId != null && ctx.personId === subjectPersonId;
  const isReviewer = ctx.personId != null && ctx.personId === reviewerPersonId;
  return { canManage: admin || isReviewer, isSubject, released: cycle.releasedAt != null };
}

/** 360 feedback gathered on a review. Shaped for the viewer: the manager/admin sees attributed feedback;
 *  the subject sees it anonymized AND only after the cycle is released. Also reports the pending count
 *  for the manager. */
export function peerFeedbackForReview(
  ctx: SessionContext,
  reviewId: string,
): Promise<{ feedback: FeedbackRow[]; pending: number; canManage: boolean; invitable: { employmentId: string; name: string }[] }> {
  return withTenant(ctx, async (tx) => {
    const view = await reviewViewerFlags(tx, ctx, reviewId);
    if (!view) return { feedback: [], pending: 0, canManage: false, invitable: [] };
    const { canManage, isSubject, released } = view;
    // The subject sees nothing until release (and never attribution).
    if (isSubject && !canManage && !released) return { feedback: [], pending: 0, canManage: false, invitable: [] };

    const rows = await tx
      .select({
        id: peerFeedback.id,
        strengths: peerFeedback.strengths,
        improvements: peerFeedback.improvements,
        named: peerFeedback.named,
        requestId: peerFeedback.requestId,
      })
      .from(peerFeedback)
      .innerJoin(performanceReview, eq(performanceReview.id, reviewId))
      .where(eq(peerFeedback.subjectEmploymentId, performanceReview.employmentId))
      .orderBy(desc(peerFeedback.createdAt));

    let feedback: FeedbackRow[];
    if (canManage) {
      // Manager/admin: attribute via the denormalized peer_name on the request (they have RLS access).
      const reqIds = rows.map((r) => r.requestId);
      const peers =
        reqIds.length > 0
          ? await tx
              .select({ requestId: peerFeedbackRequest.id, name: peerFeedbackRequest.peerName })
              .from(peerFeedbackRequest)
              .where(inArray(peerFeedbackRequest.id, reqIds))
          : [];
      const peerByReq = new Map(peers.map((x) => [x.requestId, x.name]));
      feedback = rows.map((r) => ({ id: r.id, strengths: r.strengths, improvements: r.improvements, peer: peerByReq.get(r.requestId) ?? null }));
    } else {
      // Subject (released): anonymized — never the author.
      feedback = rows.map((r) => ({ id: r.id, strengths: r.strengths, improvements: r.improvements, peer: null }));
    }

    let pending = 0;
    let invitable: { employmentId: string; name: string }[] = [];
    if (canManage) {
      const reqs = await tx
        .select({ peer: peerFeedbackRequest.peerEmploymentId, status: peerFeedbackRequest.status })
        .from(peerFeedbackRequest)
        .where(eq(peerFeedbackRequest.reviewId, reviewId));
      pending = reqs.filter((r) => r.status === 'pending').length;
      // Invitable peers = the subject's teammates (the reviewer's other admin-line reports), minus
      // the subject and anyone already invited.
      const [rev] = await tx
        .select({ reviewer: performanceReview.reviewerEmploymentId, subject: performanceReview.employmentId })
        .from(performanceReview)
        .where(eq(performanceReview.id, reviewId))
        .limit(1);
      const invited = new Set(reqs.map((r) => r.peer));
      if (rev?.reviewer) {
        const teammates = await tx
          .select({ employmentId: reportingLine.subordinateEmploymentId, name: person.fullName })
          .from(reportingLine)
          .innerJoin(employment, eq(employment.id, reportingLine.subordinateEmploymentId))
          .innerJoin(person, eq(person.id, employment.personId))
          .where(
            and(
              eq(reportingLine.managerEmploymentId, rev.reviewer),
              eq(reportingLine.lineType, 'administrative'),
              lte(reportingLine.validFrom, sql`current_date`),
              or(isNull(reportingLine.validTo), sql`${reportingLine.validTo} > current_date`),
              isNull(reportingLine.supersededAt),
            ),
          )
          .orderBy(person.fullName);
        invitable = teammates.filter((tm) => tm.employmentId !== rev.subject && !invited.has(tm.employmentId));
      }
    }
    return { feedback, pending, canManage, invitable };
  });
}

// ─────────────────────── Calibration + analytics (ADR-0022, slice 4) ───────────────────────
//
// Advisory calibration: an admin opens a session over a cycle (in 'calibration' status), proposes
// adjusted overall ratings across the cohort against the live distribution, then COMMITS — only the
// commit writes performance_review.overall_rating (+ a 'performance-review.calibrated' event). A proposal
// never silently mutates a rating. Admin-only (RLS). The view also carries light analytics: the rating
// distribution and per-reviewer leniency (average overall).

/** Open (or reuse the open) calibration session for a cycle in 'calibration' status. Admin only. */
export async function openCalibrationSession(ctx: SessionContext, p: { cycleId: string }): Promise<{ sessionId: string }> {
  if (!isAdminOrPerfCompCtx(ctx)) throw new PerfError('Only an admin or performance & comp partner can run calibration');
  return withTenant(ctx, async (tx) => {
    const [cycle] = await tx.select().from(reviewCycle).where(eq(reviewCycle.id, p.cycleId)).limit(1);
    if (!cycle) throw new PerfError('Cycle not found');
    if (cycle.status !== 'calibration') throw new PerfError(`Calibration runs while the cycle is in calibration (it is ${cycle.status})`);
    const [open] = await tx
      .select({ id: calibrationSession.id })
      .from(calibrationSession)
      .where(and(eq(calibrationSession.cycleId, p.cycleId), eq(calibrationSession.status, 'open')))
      .limit(1);
    if (open) return { sessionId: open.id };
    const [row] = await tx
      .insert(calibrationSession)
      .values({ tenantId: ctx.tenantId, cycleId: p.cycleId })
      .returning({ id: calibrationSession.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'calibration-session',
      aggregateId: row.id,
      eventType: 'calibration-session.opened',
      actor: actorOf(ctx),
      payload: { cycleId: p.cycleId },
    });
    return { sessionId: row.id };
  });
}

/** Propose an adjusted overall rating for one review in the session (a draft — no event, no rating write). */
export async function proposeCalibration(
  ctx: SessionContext,
  p: { sessionId: string; reviewId: string; proposedRating: number | null; note?: string },
): Promise<void> {
  if (!isAdminOrPerfCompCtx(ctx)) throw new PerfError('Only an admin or performance & comp partner can run calibration');
  await withTenant(ctx, async (tx) => {
    const [sess] = await tx.select().from(calibrationSession).where(eq(calibrationSession.id, p.sessionId)).limit(1);
    if (!sess) throw new PerfError('Session not found');
    if (sess.status !== 'open') throw new PerfError('This calibration is already committed');
    if (p.proposedRating != null) {
      const [cycle] = await tx.select({ scale: reviewCycle.ratingScale }).from(reviewCycle).where(eq(reviewCycle.id, sess.cycleId)).limit(1);
      assertRatingInScale(cycle.scale as RatingScale, p.proposedRating, 'Proposed rating');
    }
    // Draft upsert (no DomainEvent — calibration scratchpad; the COMMIT is the audited act).
    const [existing] = await tx
      .select({ id: calibrationEntry.id })
      .from(calibrationEntry)
      .where(and(eq(calibrationEntry.sessionId, p.sessionId), eq(calibrationEntry.reviewId, p.reviewId)))
      .limit(1);
    if (existing) {
      await tx.update(calibrationEntry).set({ proposedRating: p.proposedRating, note: p.note?.trim() || null }).where(eq(calibrationEntry.id, existing.id));
    } else {
      await tx.insert(calibrationEntry).values({ tenantId: ctx.tenantId, sessionId: p.sessionId, reviewId: p.reviewId, proposedRating: p.proposedRating, note: p.note?.trim() || null });
    }
  });
}

/** Commit the session: write each proposed overall rating onto its review (+ event), close the session. */
export async function commitCalibration(ctx: SessionContext, p: { sessionId: string }): Promise<{ applied: number }> {
  if (!isAdminOrPerfCompCtx(ctx)) throw new PerfError('Only an admin or performance & comp partner can run calibration');
  return withTenant(ctx, async (tx) => {
    const [sess] = await tx.select().from(calibrationSession).where(eq(calibrationSession.id, p.sessionId)).limit(1);
    if (!sess) throw new PerfError('Session not found');
    if (sess.status !== 'open') throw new PerfError('This calibration is already committed');
    const entries = await tx
      .select({ id: calibrationEntry.id, reviewId: calibrationEntry.reviewId, proposed: calibrationEntry.proposedRating, note: calibrationEntry.note })
      .from(calibrationEntry)
      .where(eq(calibrationEntry.sessionId, p.sessionId));
    let applied = 0;
    for (const e of entries) {
      if (e.proposed == null) continue; // null = clear / no proposal; no justification required
      const [rev] = await tx
        .select({ employmentId: performanceReview.employmentId, priorOverall: performanceReview.overallRating })
        .from(performanceReview)
        .where(eq(performanceReview.id, e.reviewId))
        .limit(1);
      if (!rev) continue;
      // A genuine ADJUSTMENT (the proposal differs from the manager-submitted baseline) requires a
      // justification. A no-op (proposed === prior) or a first-value (prior is null — nothing to
      // adjust) does not. The 'performance-review.calibrated' event is the audit log; before/after =
      // committedRating vs this event-time prior.
      const isAdjustment = rev.priorOverall != null && e.proposed !== rev.priorOverall;
      if (isAdjustment && !(e.note && e.note.trim())) {
        throw new PerfError('Justification required to adjust a rating');
      }
      await tx.update(performanceReview).set({ overallRating: e.proposed }).where(eq(performanceReview.id, e.reviewId));
      await tx.update(calibrationEntry).set({ committedRating: e.proposed }).where(eq(calibrationEntry.id, e.id));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'performance-review',
        aggregateId: e.reviewId,
        eventType: 'performance-review.calibrated',
        actor: actorOf(ctx),
        subjectEmploymentId: rev.employmentId,
        payload: { sessionId: p.sessionId },
      });
      applied += 1;
    }
    await tx.update(calibrationSession).set({ status: 'committed', committedAt: new Date() }).where(eq(calibrationSession.id, p.sessionId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'calibration-session',
      aggregateId: p.sessionId,
      eventType: 'calibration-session.committed',
      actor: actorOf(ctx),
      payload: { applied },
    });
    return { applied };
  });
}

export type CalibrationRow = {
  reviewId: string;
  employee: string;
  employeeCode: string | null;
  reviewer: string | null;
  overallRating: number | null;
  proposedRating: number | null;
};
export type CalibrationView = {
  sessionId: string | null;
  status: 'open' | 'committed' | 'none';
  ratingScale: RatingScale;
  rows: CalibrationRow[];
  distribution: { value: number; label: string; count: number }[];
  reviewerLeniency: { reviewer: string; avg: number; count: number }[];
  // Calibration governance (G3): the same cohort grouped by the subject's current department.
  byDepartment: { department: string; avg: number; count: number }[];
};

/** The calibration cockpit for a cycle (admin): roster + open-session proposals + distribution + per-
 *  reviewer leniency. Returns rows ordered by employee. */
export function calibrationView(ctx: SessionContext, cycleId: string): Promise<CalibrationView> {
  return withTenant(ctx, async (tx) => {
    const [cycle] = await tx.select().from(reviewCycle).where(eq(reviewCycle.id, cycleId)).limit(1);
    const scale = (cycle?.ratingScale ?? DEFAULT_RATING_SCALE) as RatingScale;
    const [sess] = await tx
      .select({ id: calibrationSession.id, status: calibrationSession.status })
      .from(calibrationSession)
      .where(eq(calibrationSession.cycleId, cycleId))
      .orderBy(desc(calibrationSession.createdAt))
      .limit(1);
    const proposals = sess
      ? await tx.select({ reviewId: calibrationEntry.reviewId, proposed: calibrationEntry.proposedRating }).from(calibrationEntry).where(eq(calibrationEntry.sessionId, sess.id))
      : [];
    const proposedByReview = new Map(proposals.map((p) => [p.reviewId, p.proposed]));

    const rows = await tx
      .select({
        reviewId: performanceReview.id,
        employmentId: performanceReview.employmentId,
        reviewerEmploymentId: performanceReview.reviewerEmploymentId,
        overallRating: performanceReview.overallRating,
      })
      .from(performanceReview)
      .where(eq(performanceReview.cycleId, cycleId));
    const names = await namesForEmployments(
      tx,
      rows.flatMap((r) => [r.employmentId, r.reviewerEmploymentId].filter(Boolean) as string[]),
    );
    const codes = await codesForEmployments(
      tx,
      rows.map((r) => r.employmentId),
    );

    const calRows: CalibrationRow[] = rows
      .map((r) => ({
        reviewId: r.reviewId,
        employee: names.get(r.employmentId) ?? '—',
        employeeCode: codes.get(r.employmentId) ?? null,
        reviewer: r.reviewerEmploymentId ? (names.get(r.reviewerEmploymentId) ?? null) : null,
        overallRating: r.overallRating,
        proposedRating: proposedByReview.get(r.reviewId) ?? null,
      }))
      .sort((a, b) => a.employee.localeCompare(b.employee));

    // Distribution over the EFFECTIVE rating (proposed if present, else committed overall).
    const effective = (r: CalibrationRow) => r.proposedRating ?? r.overallRating;
    const distribution = scale.map((s) => ({ value: s.value, label: s.label, count: calRows.filter((r) => effective(r) === s.value).length }));

    // Per-reviewer leniency: average effective overall.
    const byReviewer = new Map<string, number[]>();
    for (const r of calRows) {
      const v = effective(r);
      if (r.reviewer == null || v == null) continue;
      const arr = byReviewer.get(r.reviewer) ?? [];
      arr.push(v);
      byReviewer.set(r.reviewer, arr);
    }
    const reviewerLeniency = [...byReviewer.entries()]
      .map(([rv, vals]) => ({ reviewer: rv, avg: round2(vals.reduce((a, b) => a + b, 0) / vals.length), count: vals.length }))
      .sort((a, b) => b.avg - a.avg);

    // By-department grouping (G3): resolve each subject's CURRENT department. Runs in the admin tx
    // where the roster is already RLS-scoped, so subjects outside the admin's subtree are invisible
    // here exactly as in the rest of the calibration — the grouping reflects the same row set.
    const deptRows = await tx
      .select({ employmentId: assignment.employmentId, departmentName: department.name })
      .from(assignment)
      .innerJoin(department, eq(department.id, assignment.departmentId))
      .where(
        and(
          inArray(assignment.employmentId, [...new Set(rows.map((r) => r.employmentId))]),
          isNull(assignment.validTo),
          isNull(assignment.supersededAt),
        ),
      );
    const deptByEmployment = new Map(deptRows.map((d) => [d.employmentId, d.departmentName]));
    // One bucket per subject in the calibration roster. `count` is roster membership (so the totals
    // sum to the roster count); `avg` is taken over the subjects that have an effective rating.
    const byDept = new Map<string, { ratings: number[]; subjects: number }>();
    for (const r of rows) {
      const v = proposedByReview.get(r.reviewId) ?? r.overallRating;
      const dept = deptByEmployment.get(r.employmentId) ?? '—';
      const bucket = byDept.get(dept) ?? { ratings: [], subjects: 0 };
      bucket.subjects += 1;
      if (v != null) bucket.ratings.push(v);
      byDept.set(dept, bucket);
    }
    const byDepartment = [...byDept.entries()]
      .map(([dept, b]) => ({
        department: dept,
        avg: b.ratings.length ? round2(b.ratings.reduce((a, c) => a + c, 0) / b.ratings.length) : 0,
        count: b.subjects,
      }))
      .sort((a, b) => a.department.localeCompare(b.department));

    return {
      sessionId: sess?.id ?? null,
      status: sess?.status ?? 'none',
      ratingScale: scale,
      rows: calRows,
      distribution,
      reviewerLeniency,
      byDepartment,
    };
  });
}

// ─────────────────── AI-assisted review drafting (ADR-0022 slice 5, ADR-0007) ───────────────────
//
// Draft-only, human-in-the-loop. A manager asks for a STARTING draft; we gather the signals already
// on the review (the employee's self-assessment, linked goals, prior overall ratings, anonymized 360
// feedback), redact direct identifiers, and ask the governed gateway (lib/ai) for prose. We never
// write a rating, a comment, or pay — the text lands in the manager's editable textarea and only a
// human `submitManagerReview` changes state. The single write here is an audit event noting that a
// draft was generated. Graceful degradation: with no API key the feature is OFF (PerfError), so the
// build and tests never need a live key — gate the UI on `isAiConfigured()`.

export type DraftSignals = { hasSelf: boolean; goals: number; priorRatings: number; peerNotes: number };

export async function draftManagerReview(
  ctx: SessionContext,
  p: { reviewId: string },
): Promise<{ draft: string; signals: DraftSignals }> {
  // 1) Authorize, resolve the tenant's AI config, and gather signals in a short read transaction. NO
  //    provider call inside the tx (decryption is CPU only; the multi-second network call is outside).
  const gathered = await withTenant(ctx, async (tx) => {
    const { review, cycle } = await loadReview(tx, p.reviewId);
    if (cycle.status !== 'open') {
      throw new PerfError(`The cycle is ${cycle.status}; a draft can only be prepared while it is open`);
    }
    if (review.status !== 'manager_review' && review.status !== 'self_review') {
      throw new PerfError(`Manager review is not open (status: ${review.status})`);
    }
    // Same gate as submitManagerReview: reviewer-or-admin, never self.
    await assertCanDecide(tx, ctx, review.employmentId, 'AI review draft');

    const scale = cycle.ratingScale as RatingScale;

    const goals = await tx
      .select({
        title: performanceGoal.title,
        description: performanceGoal.description,
        progress: performanceGoal.progress,
        status: performanceGoal.status,
        weight: performanceGoal.weight,
      })
      .from(reviewGoal)
      .innerJoin(performanceGoal, eq(performanceGoal.id, reviewGoal.goalId))
      .where(eq(reviewGoal.reviewId, review.id));

    const prior = await tx
      .select({ overall: performanceReview.overallRating })
      .from(performanceReview)
      .innerJoin(reviewCycle, eq(reviewCycle.id, performanceReview.cycleId))
      .where(
        and(
          eq(performanceReview.employmentId, review.employmentId),
          sql`${performanceReview.id} <> ${review.id}`,
          sql`${performanceReview.overallRating} is not null`,
        ),
      )
      .orderBy(desc(reviewCycle.periodEnd))
      .limit(5);

    // 360 notes carry no author column and we read no peer identity → inherently anonymous.
    const peers = await tx
      .select({ strengths: peerFeedback.strengths, improvements: peerFeedback.improvements })
      .from(peerFeedback)
      .where(eq(peerFeedback.subjectEmploymentId, review.employmentId));

    // The tenant's active AI provider/model + decrypted key (or platform env fallback). Fail closed
    // when an active config is present but undecryptable — never fall through to a shared env key.
    const aiCfg = await resolveActiveAiConfig(tx, ctx);
    if (!aiCfg) throw new PerfError('AI drafting is not configured for this tenant.');

    return { review, cycle, scale, goals, prior, peers, aiCfg };
  });

  // 2) Build a redacted prompt — the employee is referred to generically; peer notes are anonymous.
  const { review, cycle, scale, goals, prior, peers, aiCfg } = gathered;
  const lines: string[] = [
    `Review cycle: ${redactPII(cycle.name)} (${cycle.periodStart} to ${cycle.periodEnd}).`,
    `Rating scale: ${scale.map((s) => `${s.value}=${s.label}`).join(', ')}.`,
  ];
  if (review.selfRating != null) lines.push(`Employee self-rating: ${review.selfRating}.`);
  if (review.selfComments) lines.push(`Employee self-assessment: ${redactPII(review.selfComments)}`);
  if (review.goalsSummary) lines.push(`Goals the employee referenced: ${redactPII(review.goalsSummary)}`);
  if (goals.length) {
    lines.push('Linked goals (title — progress — status):');
    for (const g of goals) {
      const weight = g.weight != null ? ` (weight ${Number(g.weight)})` : '';
      const desc = g.description ? `: ${redactPII(g.description)}` : '';
      lines.push(`- ${redactPII(g.title)} — ${g.progress}% — ${g.status}${weight}${desc}`);
    }
  }
  if (prior.length) lines.push(`Prior overall ratings (most recent first): ${prior.map((x) => x.overall).join(', ')}.`);
  const peerNotes = peers.filter((n) => n.strengths || n.improvements);
  if (peerNotes.length) {
    lines.push('Anonymous peer (360) feedback:');
    for (const n of peerNotes) {
      if (n.strengths) lines.push(`- Strength: ${redactPII(n.strengths)}`);
      if (n.improvements) lines.push(`- To improve: ${redactPII(n.improvements)}`);
    }
  }
  if (lines.length <= 2) {
    lines.push(
      '(No self-assessment, goals, prior ratings, or peer feedback are available yet — write a brief, neutral starting draft the manager can expand.)',
    );
  }

  const system = [
    'You are assisting a manager writing a performance review for one of their direct reports at a Malaysian company.',
    'Write a balanced, specific, professional manager-review narrative in British English.',
    'Ground every statement in the signals provided. Do not invent achievements, numbers, or incidents.',
    'Cover overall contribution, strengths evidenced by the goals and feedback, and concrete areas to develop.',
    'Refer to the person as "the employee" — you are not given their name.',
    'This is a DRAFT for the manager to edit: do not state a final rating or any pay decision.',
    'Output only the review prose — no preamble, headings, bullet labels, or meta-commentary.',
  ].join(' ');

  // 3) Call the gateway OUTSIDE any DB transaction, against the resolved provider/model.
  const draft = await generateDraft(aiCfg, {
    system,
    prompt: `Draft a manager-review narrative from these signals:\n\n${lines.join('\n')}`,
    maxTokens: 1536,
  });

  // 4) Audit that a draft was generated (AGENT actor, PII-free payload). No state was changed.
  await withTenant(ctx, async (tx) => {
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'performance-review',
      aggregateId: review.id,
      eventType: 'performance-review.ai-draft-generated',
      // AGENT actor with no id — actor_id is a uuid column; provider/model are recorded in the payload.
      actor: { type: 'agent' },
      subjectEmploymentId: review.employmentId,
      payload: { cycleId: review.cycleId, provider: aiCfg.provider, model: aiCfg.model },
    });
  });

  return {
    draft,
    signals: { hasSelf: review.selfRating != null, goals: goals.length, priorRatings: prior.length, peerNotes: peerNotes.length },
  };
}
