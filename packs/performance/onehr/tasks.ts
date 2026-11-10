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
 *   calibration        A calibration session naming this actor as a reviewer, whose tier window is open
 *                      and which still has people awaiting the tier's decision: `pendingCalibrationTasks`
 *                      (calibration-list.ts), the Calibration page's own gates. Administering a cycle is
 *                      not a calibration task. A group-wide session (no company) survives any company
 *                      selection, as it does on the Calibration page.
 *
 * The viewer's OWN assessment (self view) is not a task in this list: the list answers "who is waiting
 * on me", and the employee's own journey lives on My Performance.
 *
 * Payload: id, kind, subject name, owner timestamp and link. No band, rating, score, plan body or remark.
 */
import { and, asc, desc, eq, getTableName, inArray, sql, type SQL } from 'drizzle-orm';
import { decodeJsonColumns, jsonColumnsSql } from '../../../db/json-row';
import {settleReadGroup} from '../../../lib/settle-read-group';
import { withTenant, type SessionContext } from '../../../db/client';
import { employment, onehrCycle, onehrPlan, onehrReview, reviewCycle } from '../../../db/schema';
import { assertModuleGate, withPerformanceTenant } from '../../../core/module-gate';
import { aiCentreActivity } from '../../../lib/ai/centre-activity';
import { ownerCardSectionReads } from '../../../core/home-owner-reads';
import { managerPendingReviews, managerPendingReviewsBundleSql, managerPendingReviewsFromBundle } from '../../../core/performance';
import type { PackTaskItem } from '../../../lib/assigned-work';
import { competencySchema, kpiSchema, policySchema } from './model';
import { reviewWorkspaceParts } from './workspace-model';
import { pendingCalibrationTasks, pendingCalibrationTasksBundleSql, pendingCalibrationTasksFromBundle } from './calibration-list';

/** companyId null: a group-wide calibration session. reviewId: the assessment, for review-scoped kinds only. */
type Sourced = PackTaskItem & { companyId: string | null; reviewId?: string };

const reviewHref = (reviewId: string) => `/performance/review/${reviewId}`;
const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();

/** The kernel review queue /performance shows as "Reviews awaiting you". */
async function managerReviewTasks(ctx: SessionContext): Promise<Sourced[]> {
  // D-P1-22: the queue itself drops a review whose stored reviewer's unit is out and adds the one-level-up reviews.
  return managerReviewSources(await managerPendingReviews(ctx));
}
function managerReviewSources(reviews: Awaited<ReturnType<typeof managerPendingReviews>>): Sourced[] {
  return reviews.map((r) => ({
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
    // Read exactly as /performance/workspace reads (onehr_review, cycle and config only): the kernel
    // performance_review row is NOT joined, because its RLS hides it from a matrix approver who still
    // owes work on the assessment. The approval-step test on the KPI JSON is a cheap NECESSARY condition
    // of app.onehr_moderator; together with app.onehr_effective_reviewer (the competency and Career Plan reviewer,
    // which is app.onehr_manager unless the stored reviewer's unit is out: D-P1-22) it decides which rows
    // ever reach the expensive moderator function. The SECURITY DEFINER functions remain the authority.
    const rows = await tx
      .select({
        reviewId: onehrReview.reviewId, employmentId: onehrReview.employmentId, companyId: onehrReview.companyId,
        kpis: onehrReview.kpis, competencies: onehrReview.competencies, competencyStatus: onehrReview.competencyStatus,
        resultsSubmittedAt: onehrReview.resultsSubmittedAt, managerPerformance: onehrReview.managerPerformance,
        createdAt: onehrReview.createdAt, periodEnd: reviewCycle.periodEnd, policy: onehrCycle.policy,
        header: sql<{ name: string; ownEmploymentIds: string[] } | null>`app.onehr_review_header(${onehrReview.reviewId})`,
        manager: sql<boolean>`app.onehr_effective_reviewer(${onehrReview.reviewId})`,
      })
      .from(onehrReview)
      .innerJoin(reviewCycle, eq(reviewCycle.id, onehrReview.cycleId))
      .innerJoin(onehrCycle, eq(onehrCycle.cycleId, onehrReview.cycleId))
      .where(assessmentTaskWhere(ids))
      .orderBy(desc(reviewCycle.periodEnd), asc(onehrReview.reviewId));
    const parsed = parseAssessmentRows(rows);
    if (!parsed.length) return [];
    const planned = parsed.filter(({ policy }) => policy.modules.idp && policy.kind === 'year_end');
    const plans = planned.length
      ? await tx.select(assessmentPlanFields)
        .from(onehrPlan)
        .where(and(
          inArray(onehrPlan.employmentId, [...new Set(planned.map(({ row }) => row.employmentId))]),
          inArray(onehrPlan.planYear, [...new Set(planned.map(({ row }) => planYear(row.periodEnd)))]),
        ))
      : [];
    return assessmentSources(parsed, plans, mine);
  });
}

type AssessmentRow = {
  reviewId: string; employmentId: string; companyId: string; kpis: unknown; competencies: unknown; competencyStatus: (typeof onehrReview.$inferSelect)['competencyStatus'];
  resultsSubmittedAt: Date | null; managerPerformance: (typeof onehrReview.$inferSelect)['managerPerformance']; createdAt: Date; periodEnd: string; policy: unknown;
  header: { name: string; ownEmploymentIds: string[] } | null; manager: boolean;
};
const assessmentPlanFields = { id: onehrPlan.id, employmentId: onehrPlan.employmentId, planYear: onehrPlan.planYear, status: onehrPlan.status, createdAt: onehrPlan.createdAt };
type AssessmentPlan = { id: string; employmentId: string; planYear: number; status: string; createdAt: Date };
// Plan year follows the workspace: a year-end cycle plans the following year.
const planYear = (periodEnd: string) => Number(periodEnd.slice(0, 4)) + 1;
/** This runs from the root layout: a row the canonical schemas reject yields no task rather than a 500 on every route.
 * Its own screen still reports the defect. */
function parseAssessmentRows(rows: readonly AssessmentRow[]) {
  return rows.flatMap((row) => {
    const policy = policySchema.safeParse(row.policy), kpis = kpiSchema.array().safeParse(row.kpis), competencies = competencySchema.array().safeParse(row.competencies);
    return policy.success && kpis.success && competencies.success ? [{ row, policy: policy.data, kpis: kpis.data, competencies: competencies.data }] : [];
  });
}
/** assessmentTasks' tasks from its parsed rows and the plans it read for them (a plan is unique per employment and year). */
function assessmentSources(parsed: ReturnType<typeof parseAssessmentRows>, plans: readonly AssessmentPlan[], mine: string[]): Sourced[] {
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
}

function assessmentTaskWhere(ids: SQL) {
  return and(
    inArray(reviewCycle.status, ['open', 'calibration']),
    sql`not exists(select 1 from employment e where e.id=${onehrReview.employmentId} and app.is_self_person(e.person_id))`,
    sql`(app.onehr_effective_reviewer(${onehrReview.reviewId}) or (exists(select 1 from jsonb_array_elements(${onehrReview.kpis}) k where k->>'moderatorEmploymentId' = any(${ids}) or exists(select 1 from jsonb_array_elements(coalesce(k->'approvalChain','[]'::jsonb)) step where step->>'employmentId' = any(${ids}))) and app.onehr_moderator(${onehrReview.reviewId})))`,
    sql`app.assessment_review_participates(${onehrReview.reviewId})`,
  );
}

/** The performance pack's task provider (core/approvals-inbox.ts PACK_TASK_SOURCES). */
export async function pendingPerformanceTasks(ctx: SessionContext, scopeIds: string[] | undefined): Promise<PackTaskItem[]> {
  const sources: Array<(ctx: SessionContext) => Promise<Sourced[]>> = [managerReviewTasks, assessmentTasks, (c) => pendingCalibrationTasks(c)];
  return combinePerformanceTasks((await settleReadGroup(sources.map((source) => ()=>source(ctx)))).flat(), scopeIds);
}

const assessmentReviewColumns = [onehrReview.reviewId, onehrReview.employmentId, onehrReview.companyId, onehrReview.kpis, onehrReview.competencies,
  onehrReview.competencyStatus, onehrReview.resultsSubmittedAt, onehrReview.managerPerformance, onehrReview.createdAt];
/** The pack's three task sources in the one-statement Home task read (core/account-task-bundle.ts): the review queue's own
 * rows; assessmentTasks' own employments, rows (the same columns, predicates and order) and the plans of those rows'
 * employments; and pendingCalibrationTasks' session rows with their work. The owners' TypeScript runs on them
 * (pendingPerformanceTasksFromBundle). */
export function pendingPerformanceTasksBundleSql(ctx: SessionContext, own?: SQL) {
  const personId = ctx.personId;
  // assessmentTasks' own employments: the statement's one read of them when it passes `own` (core/approvals.ts
  // callerOwnEmploymentIdsSql, the same rows under the same policy), otherwise the owner's own read.
  const mine = own ? sql`array(select unnest(${own})::text)` : sql`array(select mine.id::text from public.employment mine where mine.person_id=${personId}::uuid)`;
  const none = own ? sql`cardinality(${own})=0` : sql`not exists(select 1 from public.employment mine where mine.person_id=${personId}::uuid)`;
  const empty = sql`jsonb_build_object('mine','[]'::jsonb,'rows','[]'::jsonb,'plans','[]'::jsonb)`;
  const assessment = personId ? sql`case when ${none} then ${empty} else
    (with assessment_row as materialized (select jsonb_build_object('review',${jsonColumnsSql(getTableName(onehrReview), assessmentReviewColumns)},
       'cycle',${jsonColumnsSql(getTableName(reviewCycle), [reviewCycle.periodEnd])},'config',${jsonColumnsSql(getTableName(onehrCycle), [onehrCycle.policy])},
       'header',app.onehr_review_header(${onehrReview.reviewId}),'manager',app.onehr_effective_reviewer(${onehrReview.reviewId})) as assessment_json,
       ${onehrReview.employmentId} as employment_id,${reviewCycle.periodEnd} as period_end,${onehrReview.reviewId} as review_id
      from ${onehrReview} inner join ${reviewCycle} on ${eq(reviewCycle.id, onehrReview.cycleId)} inner join ${onehrCycle} on ${eq(onehrCycle.cycleId, onehrReview.cycleId)}
      where ${assessmentTaskWhere(mine)})
     select jsonb_build_object('mine',to_jsonb(${mine}),
      'rows',coalesce((select jsonb_agg(assessment_row.assessment_json order by assessment_row.period_end desc,assessment_row.review_id) from assessment_row),'[]'::jsonb),
      'plans',coalesce((select jsonb_agg(${jsonColumnsSql(getTableName(onehrPlan), Object.values(assessmentPlanFields))}) from ${onehrPlan}
        where ${onehrPlan.employmentId} in (select assessment_row.employment_id from assessment_row)),'[]'::jsonb))) end` : empty;
  return sql`jsonb_build_object('reviews',${managerPendingReviewsBundleSql(ctx)},'assessment',${assessment},'calibration',${pendingCalibrationTasksBundleSql(ctx)})`;
}
export function pendingPerformanceTasksFromBundle(value: unknown, scopeIds: string[] | undefined, ctx: SessionContext): PackTaskItem[] | null {
  const section = value as { reviews: unknown; assessment: { mine: string[]; rows: { review: Record<string, unknown>; cycle: Record<string, unknown>; config: Record<string, unknown>;
    header: AssessmentRow['header']; manager: boolean }[]; plans: Record<string, unknown>[] }; calibration: unknown };
  const rows = section.assessment.rows.map((row) => ({ ...decodeJsonColumns(assessmentReviewColumns, row.review), ...decodeJsonColumns([reviewCycle.periodEnd], row.cycle),
    ...decodeJsonColumns([onehrCycle.policy], row.config), header: row.header, manager: row.manager }) as AssessmentRow);
  const plans = section.assessment.plans.map((plan) => decodeJsonColumns(Object.values(assessmentPlanFields), plan) as AssessmentPlan);
  const assessment = assessmentSources(parseAssessmentRows(rows), plans, section.assessment.mine);
  return combinePerformanceTasks([...managerReviewSources(managerPendingReviewsFromBundle(section.reviews)), ...assessment,
    ...pendingCalibrationTasksFromBundle(ctx, section.calibration)], scopeIds);
}

/** pendingPerformanceTasks in ONE statement where its own section of the account task statement answers it exactly
 * (docs/adr/2026-11-10-home-request-read-scope.md decision 13, Home's assigned-performance check): the review queue's
 * own rows, and whether any assessment or calibration candidate exists, combined by the owner's own projection. Null
 * where the owner reads itself: a candidate that needs the owner's schema parsing and window checks, a module gate that
 * would refuse, an AI Centre activity (the owner asserts its generation), or a statement that fails. */
export async function pendingPerformanceTasksFromStatement(ctx: SessionContext, scopeIds: string[] | undefined): Promise<PackTaskItem[] | null> {
  if (ownerCardSectionReads() || aiCentreActivity(ctx.tenantId)) return null;
  try { assertModuleGate(ctx, 'performance'); } catch { return null; }
  try {
    const [row] = await withTenant(ctx, (tx) => tx.execute<{ performance: unknown }>(sql`select ${pendingPerformanceTasksBundleSql(ctx)} as performance`), { readOnlySnapshot: true });
    return pendingPerformanceTasksFromBundle(row?.performance, scopeIds);
  } catch { return null; }
}

function combinePerformanceTasks(all: Sourced[], scopeIds: string[] | undefined): PackTaskItem[] {
  // One assessment, one task: a review already in the "Reviews awaiting you" queue is not repeated as
  // assessment work. A career plan is a separate decision on its own record and stays.
  const reviewed = new Set(all.filter((t) => t.kind === 'performanceReview').map((t) => t.reviewId));
  const scope = scopeIds ? new Set(scopeIds) : null;
  const seen = new Set<string>();
  return all
    .filter((t) => !(t.kind === 'assessmentWork' && t.reviewId && reviewed.has(t.reviewId)))
    .filter((t) => !scope || t.companyId === null || scope.has(t.companyId))
    .filter((t) => { const key = `${t.kind}:${t.id}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .map(({ id, kind, subjectName, createdAt, linkPath }) => ({ id, kind, subjectName, createdAt, linkPath }));
}
