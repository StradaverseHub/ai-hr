/**
 * Performance work awaiting the viewer, projected into the shared task list (WP-A1).
 *
 * Before this file the bell, the Home "nothing needs you" line and the dashboard tile never saw
 * performance work at all, while /performance said "Reviews awaiting you: 9" to the same manager.
 * This is a PROJECTION of the owners that already decide the work, never a second workflow store:
 *
 *   performanceReview  `managerPendingReviews` (core/performance.ts) — the exact queue /performance
 *                      counts, called, not re-derived. Count parity is pinned by test.
 *   assessmentWork     OneHR scorecard/competency work (pm/tm) that `reviewWorkspaceParts` — the shared
 *                      derivation behind /performance/workspace and the reminder recipients — marks
 *                      'open' for this actor on someone else's assessment. A review already counted as
 *                      a performanceReview is not counted twice.
 *   careerPlan         A shared IDP awaiting this actor as its assigned reviewer: the same derivation's
 *                      idp part ('shared' → open for the manager/moderator), i.e. the
 *                      app.assessment_plan_reviewer relationship. Plan rows are read under plan RLS.
 *
 * Calibration sessions are deliberately not a source here yet; a calibration source is added to
 * `sources` in pendingPerformanceTasks.
 *
 * The viewer's OWN assessment (self view) is not a task in this list: the list answers "who is waiting
 * on me", and the employee's own journey lives on My Performance.
 *
 * Payload: id, kind, subject name, owner timestamp and link. No band, rating, score, plan body or remark.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { SessionContext } from '../../../db/client';
import { employment, onehrCycle, onehrPlan, onehrReview, performanceReview, reviewCycle } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { managerPendingReviews } from '../../../core/performance';
import type { PackTaskItem } from '../../../lib/assigned-work';
import { competencySchema, kpiSchema, policySchema } from './model';
import { reviewWorkspaceParts } from './workspace-model';

type Sourced = PackTaskItem & { companyId: string; reviewId: string };

const reviewHref = (reviewId: string) => `/performance/review/${reviewId}`;
const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();

/** The kernel review queue /performance shows as "Reviews awaiting you". */
async function managerReviewTasks(ctx: SessionContext): Promise<Sourced[]> {
  return (await managerPendingReviews(ctx)).map((r) => ({
    id: r.reviewId, kind: 'performanceReview' as const, subjectName: r.employee, createdAt: iso(r.createdAt),
    linkPath: reviewHref(r.reviewId), companyId: r.companyId, reviewId: r.reviewId,
  }));
}

/** OneHR assessments where this actor (never the subject) has an open pm/tm or idp part. */
async function assessmentTasks(ctx: SessionContext): Promise<Sourced[]> {
  const personId = ctx.personId;
  if (!personId) return [];
  return withPerformanceTenant(ctx, async (tx) => {
    const mine = (await tx.select({ id: employment.id }).from(employment).where(eq(employment.personId, personId))).map((e) => e.id);
    if (!mine.length) return [];
    const ids = sql`array[${sql.join(mine.map((id) => sql`${id}`), sql`,`)}]::text[]`;
    // The reviewer/approver pre-filter is a NECESSARY condition of app.onehr_manager (the reviewer is one
    // of my employments) or app.onehr_moderator (an approval step names one of them); the SECURITY
    // DEFINER functions after it stay the authority. It keeps an administrator, who can read every
    // assessment, from evaluating those functions on every row on every page render.
    const rows = await tx
      .select({
        reviewId: onehrReview.reviewId, employmentId: onehrReview.employmentId, companyId: onehrReview.companyId,
        kpis: onehrReview.kpis, competencies: onehrReview.competencies, competencyStatus: onehrReview.competencyStatus,
        resultsSubmittedAt: onehrReview.resultsSubmittedAt, managerPerformance: onehrReview.managerPerformance,
        createdAt: performanceReview.createdAt, periodEnd: reviewCycle.periodEnd, policy: onehrCycle.policy,
        header: sql<{ name: string; ownEmploymentIds: string[] } | null>`app.onehr_review_header(${onehrReview.reviewId})`,
        manager: sql<boolean>`app.onehr_manager(${onehrReview.reviewId})`,
      })
      .from(onehrReview)
      .innerJoin(performanceReview, eq(performanceReview.id, onehrReview.reviewId))
      .innerJoin(reviewCycle, eq(reviewCycle.id, onehrReview.cycleId))
      .innerJoin(onehrCycle, eq(onehrCycle.cycleId, onehrReview.cycleId))
      .where(and(
        inArray(reviewCycle.status, ['open', 'calibration']),
        sql`(${performanceReview.reviewerEmploymentId}::text = any(${ids}) or exists(select 1 from jsonb_array_elements(${onehrReview.kpis}) k where k->>'moderatorEmploymentId' = any(${ids}) or exists(select 1 from jsonb_array_elements(coalesce(k->'approvalChain','[]'::jsonb)) step where step->>'employmentId' = any(${ids}))))`,
        sql`not exists(select 1 from employment e where e.id=${onehrReview.employmentId} and app.is_self_person(e.person_id))`,
        sql`app.assessment_review_participates(${onehrReview.reviewId})`,
        sql`(app.onehr_manager(${onehrReview.reviewId}) or app.onehr_moderator(${onehrReview.reviewId}))`,
      ))
      .orderBy(desc(reviewCycle.periodEnd), asc(onehrReview.reviewId));
    // This runs from the root layout: a row the canonical schemas reject yields no task rather than a
    // 500 on every route. Its own screen still reports the defect.
    const parsed = rows.flatMap((row) => {
      const policy = policySchema.safeParse(row.policy), kpis = kpiSchema.array().safeParse(row.kpis), competencies = competencySchema.array().safeParse(row.competencies);
      return policy.success && kpis.success && competencies.success ? [{ row, policy: policy.data, kpis: kpis.data, competencies: competencies.data }] : [];
    });
    if (!parsed.length) return [];
    // Plan year follows the workspace: a year-end cycle plans the following year.
    const planYear = (periodEnd: string) => Number(periodEnd.slice(0, 4)) + 1;
    const planned = parsed.filter(({ policy }) => policy.modules.idp && policy.kind === 'year_end');
    const plans = planned.length
      ? await tx.select({ id: onehrPlan.id, employmentId: onehrPlan.employmentId, planYear: onehrPlan.planYear, status: onehrPlan.status, createdAt: onehrPlan.createdAt })
        .from(onehrPlan)
        .where(and(
          inArray(onehrPlan.employmentId, [...new Set(planned.map(({ row }) => row.employmentId))]),
          inArray(onehrPlan.planYear, [...new Set(planned.map(({ row }) => planYear(row.periodEnd)))]),
        ))
      : [];
    const out: Sourced[] = [];
    for (const { row, policy, kpis, competencies } of parsed) {
      const plan = policy.modules.idp && policy.kind === 'year_end'
        ? plans.find((p) => p.employmentId === row.employmentId && p.planYear === planYear(row.periodEnd)) : undefined;
      const parts = reviewWorkspaceParts(policy, {
        kpis, competenciesAssigned: competencies.length > 0, competencyStatus: row.competencyStatus,
        resultsSubmitted: !!row.resultsSubmittedAt, managerPerformance: row.managerPerformance, planStatus: plan?.status ?? null,
      }, { self: false, manager: row.manager, employmentIds: row.header?.ownEmploymentIds ?? mine });
      const subjectName = row.header?.name ?? null;
      if (parts.some((p) => p.state === 'open' && (p.module === 'pm' || p.module === 'tm'))) {
        out.push({ id: row.reviewId, kind: 'assessmentWork', subjectName, createdAt: iso(row.createdAt), linkPath: reviewHref(row.reviewId), companyId: row.companyId, reviewId: row.reviewId });
      }
      if (plan && parts.some((p) => p.state === 'open' && p.module === 'idp')) {
        out.push({ id: plan.id, kind: 'careerPlan', subjectName, createdAt: iso(plan.createdAt), linkPath: reviewHref(row.reviewId), companyId: row.companyId, reviewId: row.reviewId });
      }
    }
    return out;
  });
}

/** The performance pack's task provider (core/approvals-inbox.ts PACK_TASK_SOURCES). */
export async function pendingPerformanceTasks(ctx: SessionContext, scopeIds: string[] | undefined): Promise<PackTaskItem[]> {
  const sources: Array<(ctx: SessionContext) => Promise<Sourced[]>> = [managerReviewTasks, assessmentTasks];
  const all = (await Promise.all(sources.map((source) => source(ctx)))).flat();
  // One assessment, one task: a review already in the "Reviews awaiting you" queue is not repeated as
  // assessment work. A career plan is a separate decision on its own record and stays.
  const reviewed = new Set(all.filter((t) => t.kind === 'performanceReview').map((t) => t.reviewId));
  const scope = scopeIds ? new Set(scopeIds) : null;
  const seen = new Set<string>();
  return all
    .filter((t) => !(t.kind === 'assessmentWork' && reviewed.has(t.reviewId)))
    .filter((t) => !scope || scope.has(t.companyId))
    .filter((t) => { const key = `${t.kind}:${t.id}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .map(({ id, kind, subjectName, createdAt, linkPath }) => ({ id, kind, subjectName, createdAt, linkPath }));
}
