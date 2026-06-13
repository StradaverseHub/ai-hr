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
import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  assignment,
  compensation,
  employment,
  payrollInput,
  performanceReview,
  person,
  reportingLine,
  reviewCycle,
} from '../db/schema';
import { setCompensation } from './comp';
import { setPayrollInput } from './payroll';
import { assertCanDecide } from './approvals';

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

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => round2(n).toFixed(2);
const isAdminCtx = (ctx: SessionContext) =>
  (ctx.roles ?? []).some((r) => r === 'hr_admin' || r === 'super_admin');

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
    excludeProbation?: boolean;
    hiredBefore?: string | null;
  },
) {
  if (!isAdminCtx(ctx)) throw new PerfError('Only an admin can create a review cycle');
  if (!p.name?.trim()) throw new PerfError('A cycle name is required');
  if (p.periodEnd < p.periodStart) throw new PerfError('Cycle period end is before its start');
  const scale = p.ratingScale ?? DEFAULT_RATING_SCALE;
  if (!Array.isArray(scale) || scale.length < 2) throw new PerfError('A rating scale needs at least two points');
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
        excludeProbation: p.excludeProbation ?? true,
        hiredBefore: p.hiredBefore ?? null,
      })
      .returning({ id: reviewCycle.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'review-cycle',
      aggregateId: row.id,
      eventType: 'review-cycle.created',
      actor: actorOf(ctx),
      payload: { name: p.name.trim(), companyId: p.companyId ?? null, periodStart: p.periodStart, periodEnd: p.periodEnd },
    });
    return { cycleId: row.id };
  });
}

/** Open a draft cycle: snapshot active employees in scope (minus probation / late hires) into one
 *  review each, with the administrative-line manager as reviewer. Idempotent via the draft guard. */
export async function openCycle(ctx: SessionContext, p: { cycleId: string }) {
  if (!isAdminCtx(ctx)) throw new PerfError('Only an admin can open a review cycle');
  return withTenant(ctx, async (tx) => {
    const cycle = await loadCycle(tx, p.cycleId);
    if (cycle.status !== 'draft') throw new PerfError(`Cycle is already ${cycle.status}; only a draft can be opened`);

    // Snapshot membership. RLS already limits this to employees the opener administers.
    const emps = await tx
      .select({ employmentId: employment.id, hiredOn: employment.hiredOn, status: assignment.status })
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
          eq(employment.tenantId, ctx.tenantId),
          isNull(employment.terminatedOn),
          cycle.companyId ? eq(employment.companyId, cycle.companyId) : undefined,
        ),
      );

    const members = emps.filter((e) => {
      if (cycle.excludeProbation && e.status === 'probation') return false;
      if (cycle.hiredBefore && e.hiredOn > cycle.hiredBefore) return false;
      return true;
    });

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

export async function moveCycleToCalibration(ctx: SessionContext, p: { cycleId: string }) {
  return transitionCycle(ctx, p.cycleId, ['open'], 'calibration', 'review-cycle.calibration-started');
}

/** Release ratings to employees (the gate): manager rating + overall become employee-visible. */
export async function releaseCycle(ctx: SessionContext, p: { cycleId: string }) {
  if (!isAdminCtx(ctx)) throw new PerfError('Only an admin can release a cycle');
  return withTenant(ctx, async (tx) => {
    const cycle = await loadCycle(tx, p.cycleId);
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
  if (!isAdminCtx(ctx)) throw new PerfError('Only an admin can change a cycle status');
  return withTenant(ctx, async (tx) => {
    const cycle = await loadCycle(tx, cycleId);
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
      payload: { cycleId: review.cycleId, selfRating: p.selfRating },
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
    if (review.status !== 'manager_review' && review.status !== 'self_review') {
      throw new PerfError(`Manager review is not open (status: ${review.status})`);
    }
    await assertCanDecide(tx, ctx, review.employmentId, 'performance review');
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
      payload: { cycleId: review.cycleId, overallRating: p.overallRating },
    });
    if (merit != null || bonus != null) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'performance-review',
        aggregateId: review.id,
        eventType: 'performance-review.comp-recommended',
        actor: actorOf(ctx),
        payload: { meritPct: merit, bonus },
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
    });
    return { status: 'acknowledged' as const };
  });
}

/** Admin re-points a review at a new reviewer (e.g. the manager changed mid-cycle). */
export async function reassignReviewer(
  ctx: SessionContext,
  p: { reviewId: string; reviewerEmploymentId: string | null },
) {
  if (!isAdminCtx(ctx)) throw new PerfError('Only an admin can reassign a reviewer');
  return withTenant(ctx, async (tx) => {
    const { review } = await loadReview(tx, p.reviewId);
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
      payload: { reviewerEmploymentId: p.reviewerEmploymentId },
    });
    return { ok: true };
  });
}

// ───────────────────────────── Pay seam (admin enacts) ─────────────────────────────

/** Enact a finalized recommendation through the existing pay engines. Performance never writes
 *  pay directly: merit → effective-dated setCompensation; bonus → payroll input on a draft batch
 *  (taxed as additional remuneration). Records the resulting ids on the review for the audit trail. */
export async function enactCompAction(
  ctx: SessionContext,
  p: { reviewId: string; meritEffectiveFrom?: string; bonusBatchId?: string },
) {
  if (!isAdminCtx(ctx)) throw new PerfError('Only an admin can enact a pay recommendation');
  return withTenant(ctx, async (tx) => {
    const { review } = await loadReview(tx, p.reviewId);
    if (review.compActionStatus !== 'recommended') {
      throw new PerfError(`No recommendation to enact (comp action: ${review.compActionStatus})`);
    }
    if (review.status !== 'submitted' && review.status !== 'acknowledged') {
      throw new PerfError('A recommendation can only be enacted on a finalized review');
    }

    let enactedCompensationId: string | null = null;
    let enactedBatchId: string | null = null;

    if (review.recommendedMeritPct != null) {
      if (!p.meritEffectiveFrom) throw new PerfError('A merit increase needs an effective-from date');
      const [cur] = await tx
        .select({ basicSalary: compensation.basicSalary })
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
      const pct = Number(review.recommendedMeritPct);
      const newBasic = round2(Number(cur.basicSalary) * (1 + pct / 100));
      const res = await setCompensation(ctx, {
        employmentId: review.employmentId,
        basicSalary: newBasic,
        effectiveFrom: p.meritEffectiveFrom,
      });
      enactedCompensationId = res.compensationId;
    }

    if (review.recommendedBonus != null) {
      if (!p.bonusBatchId) throw new PerfError('A bonus needs a target draft payroll batch');
      // Preserve any overtime / TP1 / zakat already keyed for this employee on the batch.
      const [existing] = await tx
        .select({
          overtimeAmount: payrollInput.overtimeAmount,
          tp1Deduction: payrollInput.tp1Deduction,
          zakat: payrollInput.zakat,
        })
        .from(payrollInput)
        .where(and(eq(payrollInput.batchId, p.bonusBatchId), eq(payrollInput.employmentId, review.employmentId)))
        .limit(1);
      await setPayrollInput(ctx, {
        batchId: p.bonusBatchId,
        employmentId: review.employmentId,
        overtimeAmount: existing ? Number(existing.overtimeAmount) : 0,
        bonusAmount: Number(review.recommendedBonus),
        tp1Deduction: existing ? Number(existing.tp1Deduction) : 0,
        zakat: existing ? Number(existing.zakat) : 0,
      });
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
      payload: {
        employmentId: review.employmentId,
        meritPct: review.recommendedMeritPct != null ? Number(review.recommendedMeritPct) : null,
        bonus: review.recommendedBonus != null ? Number(review.recommendedBonus) : null,
        enactedCompensationId,
        enactedBatchId,
      },
    });
    return { enactedCompensationId, enactedBatchId };
  });
}

export async function declineCompAction(ctx: SessionContext, p: { reviewId: string }) {
  if (!isAdminCtx(ctx)) throw new PerfError('Only an admin can decline a recommendation');
  return withTenant(ctx, async (tx) => {
    const { review } = await loadReview(tx, p.reviewId);
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
    const totalBasic = roster.reduce((s, r) => s + (r.currentBasic ?? 0), 0);
    const meritConsumed = round2(
      roster.reduce(
        (s, r) =>
          r.recommendedMeritPct != null && (r.compActionStatus === 'recommended' || r.compActionStatus === 'enacted')
            ? s + (r.currentBasic ?? 0) * (r.recommendedMeritPct / 100)
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
  reviewer: string | null;
  status: RosterRow['status'];
  selfRating: number | null;
  selfComments: string | null;
  goalsSummary: string | null;
  managerRating: number | null;
  managerComments: string | null;
  overallRating: number | null;
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
      reviewer: reviewerName,
      status: rv.status,
      selfRating: rv.selfRating,
      selfComments: rv.selfComments,
      goalsSummary: rv.goalsSummary,
      managerRating: showManager ? rv.managerRating : null,
      managerComments: showManager ? rv.managerComments : null,
      overallRating: showManager ? rv.overallRating : null,
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
    return tx
      .select({
        reviewId: performanceReview.id,
        employee: person.fullName,
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
          eq(performanceReview.status, 'manager_review'),
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

/** The current administrative-line manager's employment id, or null (top of org). */
async function currentAdminManager(tx: Tx, tenantId: string, subjectEmploymentId: string): Promise<string | null> {
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
