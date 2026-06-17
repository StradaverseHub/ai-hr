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
  calibrationEntry,
  calibrationSession,
  compensation,
  employment,
  payrollBatch,
  payrollInput,
  peerFeedback,
  peerFeedbackRequest,
  performanceCheckin,
  performanceGoal,
  performanceReview,
  person,
  reportingLine,
  reviewCycle,
  reviewGoal,
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
  if (!isAdminCtx(ctx)) throw new PerfError('Only an admin can reassign a reviewer');
  return withTenant(ctx, async (tx) => {
    const { review, cycle, subjectPersonId } = await loadReview(tx, p.reviewId);
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
      .select({ companyId: employment.companyId, terminatedOn: employment.terminatedOn })
      .from(employment)
      .where(eq(employment.id, review.employmentId))
      .limit(1);
    if (!emp) throw new PerfError('Employee not found');
    if (emp.terminatedOn) throw new PerfError('Cannot enact pay for a terminated employee');

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
      // Effective date must be after the current record starts, else the temporal range inverts.
      if (p.meritEffectiveFrom <= cur.validFrom) {
        throw new PerfError(`The effective date must be after the current pay started (${cur.validFrom})`);
      }
      const pct = Number(review.recommendedMeritPct);
      const newBasic = round2(Number(cur.basicSalary) * (1 + pct / 100));
      // Pass tx so the raise commits/rolls back atomically with the rest of the enact.
      const res = await setCompensation(
        ctx,
        { employmentId: review.employmentId, basicSalary: newBasic, effectiveFrom: p.meritEffectiveFrom },
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
      await setPayrollInput(
        ctx,
        {
          batchId: p.bonusBatchId,
          employmentId: review.employmentId,
          overtimeAmount: existing ? Number(existing.overtimeAmount) : 0,
          bonusAmount: Number(review.recommendedBonus),
          tp1Deduction: existing ? Number(existing.tp1Deduction) : 0,
          zakat: existing ? Number(existing.zakat) : 0,
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
    // Surface both 'manager_review' (employee self-submitted, your turn) and 'self_review' (employee
    // hasn't self-assessed — you can still finalize; the service allows it, so it must be findable).
    // Only on OPEN cycles (calibration/closed are frozen).
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
  if (!isAdminCtx(ctx)) throw new PerfError('Only an admin can run calibration');
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
  if (!isAdminCtx(ctx)) throw new PerfError('Only an admin can run calibration');
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
  if (!isAdminCtx(ctx)) throw new PerfError('Only an admin can run calibration');
  return withTenant(ctx, async (tx) => {
    const [sess] = await tx.select().from(calibrationSession).where(eq(calibrationSession.id, p.sessionId)).limit(1);
    if (!sess) throw new PerfError('Session not found');
    if (sess.status !== 'open') throw new PerfError('This calibration is already committed');
    const entries = await tx
      .select({ id: calibrationEntry.id, reviewId: calibrationEntry.reviewId, proposed: calibrationEntry.proposedRating })
      .from(calibrationEntry)
      .where(eq(calibrationEntry.sessionId, p.sessionId));
    let applied = 0;
    for (const e of entries) {
      if (e.proposed == null) continue;
      const [rev] = await tx.select({ employmentId: performanceReview.employmentId }).from(performanceReview).where(eq(performanceReview.id, e.reviewId)).limit(1);
      if (!rev) continue;
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

    const calRows: CalibrationRow[] = rows
      .map((r) => ({
        reviewId: r.reviewId,
        employee: names.get(r.employmentId) ?? '—',
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

    return {
      sessionId: sess?.id ?? null,
      status: sess?.status ?? 'none',
      ratingScale: scale,
      rows: calRows,
      distribution,
      reviewerLeniency,
    };
  });
}
