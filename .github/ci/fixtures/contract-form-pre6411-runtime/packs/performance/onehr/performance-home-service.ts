/**
 * D-P1-32 PT-X3: the reads behind /performance/home. Each card's facts come from the owner that already decides
 * them (see performance-home-model.ts); this file only gathers them under the viewer's own session (RLS as
 * ai_hr_app) and hands them to the pure composition. No band is read here except through the own-person
 * projections, which return a band only once it is released to the viewer (or, for the line manager's approved
 * band, only under the DQ-1 switch in home-cards.ts).
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../../db/client';
import { employment, onehrCycle, onehrPanel, onehrReview, reviewCycle } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { isModuleEnabled } from '../../../core/entitlements';
import { deriveHomeBlock, getPerformanceHomeBlock, leaderRailSteps, stripProgress } from './home-cards';
import { getLeaderStatus } from './leader-status-service';
import { getAssessmentPersonalRecord } from './personal-record-service';
import { getOnehrReview } from './service';
import { getPerformanceAreaFactsAndItems } from './tab-service';
import { checkInsDoor } from './check-ins-door';
import { performanceTabState } from './tab-model';
import {
  homeNext, homeSlot, notInReason, pastJourney, toolDoors,
  type HomePlan, type HomeRail, type HomeResults, type NotInReason, type PerformanceHomeView, type RecordLeaderStatus,
} from './performance-home-model';

type OwnReview = { id: string; cycleId: string; cycleName: string; status: string; periodEnd: string; employmentId: string; openedOn: string | null; participates: boolean };

/** The viewer's own OneHR reviews past draft, newest first, with their participation (false for a non-participant). */
function ownReviewsTx(tx: Tx): Promise<OwnReview[]> {
  return tx.select({
    id: onehrReview.reviewId, cycleId: reviewCycle.id, cycleName: reviewCycle.name, status: sql<string>`${reviewCycle.status}::text`,
    periodEnd: reviewCycle.periodEnd, employmentId: onehrReview.employmentId, openedOn: onehrCycle.participationOpenedOn,
    participates: sql<boolean>`coalesce(app.assessment_review_participates(${onehrReview.reviewId}), false)`,
  }).from(onehrReview).innerJoin(reviewCycle, eq(reviewCycle.id, onehrReview.cycleId)).innerJoin(onehrCycle, eq(onehrCycle.cycleId, onehrReview.cycleId))
    .where(and(sql`${reviewCycle.status}<>'draft'`, sql`exists(select 1 from employment e where e.id=${onehrReview.employmentId} and app.is_self_person(e.person_id))`))
    .orderBy(desc(reviewCycle.periodEnd), asc(onehrReview.reviewId));
}

/**
 * Why the viewer is outside their own review in the cycle. The unit rule (D-P1-22) is readable by the person only
 * as the stored reviewer of a colleague's review (app.onehr_reviewer_unit_out answers for the stored reviewer's own
 * login); otherwise the source's date reasons over the viewer's own employment and the cycle's opening date.
 */
async function notInReasonTx(tx: Tx, cycleId: string, employmentId: string | null): Promise<NotInReason> {
  const [unit] = await tx.execute<{ out: boolean | null }>(sql`select bool_or(app.onehr_reviewer_unit_out(r.id)) as out from performance_review r
    where r.cycle_id=${cycleId}::uuid and r.reviewer_employment_id is not null and app.onehr_own_employment(r.reviewer_employment_id)`);
  const [cycle] = await tx.select({ openedOn: onehrCycle.participationOpenedOn }).from(onehrCycle).where(eq(onehrCycle.cycleId, cycleId));
  const [own] = await tx.select({ hiredOn: employment.hiredOn, confirmationDate: employment.confirmationDate }).from(employment)
    .where(and(employmentId ? eq(employment.id, employmentId) : isNull(employment.terminatedOn), sql`app.is_self_person(${employment.personId})`))
    .orderBy(desc(employment.hiredOn)).limit(1);
  return notInReason({ unitOut: !!unit?.out, hiredOn: own?.hiredOn ?? null, confirmationDate: own?.confirmationDate ?? null, openedOn: cycle?.openedOn ?? null });
}

/** The own 360 panels the viewer submitted in a cycle (the past journey's 360 step). */
async function submittedPanelsTx(tx: Tx, cycleId: string): Promise<number> {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(onehrPanel).where(and(isNull(onehrPanel.archivedAt), sql`${onehrPanel.submittedAt} is not null`,
    sql`app.onehr_feedback_card(${onehrPanel.requestId})->>'cycleId' = ${cycleId}`,
    sql`exists(select 1 from employment e where e.id=${onehrPanel.peerEmploymentId} and app.is_self_person(e.person_id))`));
  return row?.n ?? 0;
}

/** The personal record drawer on /me/performance (it re-checks ownership and release). No record id: its default. */
const recordHref = (anchorId: string, recordId?: string, tab?: string) =>
  `/me/performance?${new URLSearchParams({ recordFor: anchorId, ...(recordId ? { record: recordId } : {}), ...(tab ? { recordTab: tab } : {}) })}`;

/**
 * The viewer's Performance home. `scopeIds` is the company scope the bell passes, so the next-step counts are the
 * bell's counts (getPerformanceHomeBlock). Every card that has nothing to show is absent, never a guessed state.
 */
export async function getPerformanceHome(ctx: SessionContext, scopeIds: string[] | undefined, now = new Date()): Promise<PerformanceHomeView> {
  const [block, area] = await Promise.all([getPerformanceHomeBlock(ctx, scopeIds, now), getPerformanceAreaFactsAndItems(ctx)]);
  const { facts, items } = area;
  const view: PerformanceHomeView = {
    mode: 'record', facts, rail: null, next: null, slot: null, past: null, results: null, led: null, plan: null, talentBox: null,
    history: { rows: [], fullHref: null }, tools: toolDoors(facts), checkIns: null,
  };
  if (!ctx.userId || !facts.performanceOn || !isModuleEnabled(ctx, 'performance')) return view;

  // DQ-11: the door to /performance for a viewer with check-ins or reviews waiting there. A failed read leaves no door.
  const [own, checkIns] = await Promise.all([
    withPerformanceTenant(ctx, ownReviewsTx),
    checkInsDoor(ctx).catch((error: unknown) => { console.error('[performance-home] check-ins door unavailable', error); return null; }),
  ]);
  view.checkIns = checkIns;
  const openOwn = own.find((r) => r.status === 'open' || r.status === 'calibration') ?? null;
  // The running cycle: the own participating review's (the block), else the newest cycle the viewer holds work in,
  // else the cycle of an own review they are not taking part in.
  let cycle: { id: string; name: string; closesOn: string | null } | null = block ? { id: block.cycle.id, name: block.cycle.name, closesOn: block.cycle.closesOn }
    : items[0] ? { id: items[0].cycleId, name: items[0].cycle, closesOn: items[0].periodEnd }
    : openOwn ? { id: openOwn.cycleId, name: openOwn.cycleName, closesOn: openOwn.periodEnd } : null;
  const leader = await getLeaderStatus(ctx, cycle?.id);
  if (!cycle && leader?.mode === 'running') {
    const leaderCycleId = leader.cycleId;
    const [row] = await withPerformanceTenant(ctx, (tx) => tx.select({ name: reviewCycle.name, periodEnd: reviewCycle.periodEnd }).from(reviewCycle).where(eq(reviewCycle.id, leaderCycleId)));
    cycle = { id: leaderCycleId, name: row?.name ?? '', closesOn: row?.periodEnd ?? null };
  }

  // History and the own record: the personal record, released results only (personal-record-service.ts).
  const record = own[0] ? await getAssessmentPersonalRecord(ctx, own[0].id) : null;
  const past = record ? record.history.filter((r) => !r.current) : [];
  view.history = {
    rows: past.slice(0, 2).map((r) => ({ id: r.id, name: r.name, performance: r.performance, potential: r.potential, talent: r.talent })),
    fullHref: own[0] && record && (record.currentId || past[0]) ? recordHref(own[0].id, record.currentId ? 'current' : past[0]!.id) : null,
  };

  if (cycle) {
    const cycleId = cycle.id;
    const inCycle = items.filter((i) => i.cycleId === cycleId);
    const steps = block ? block.steps : leaderRailSteps(inCycle);
    const rail: HomeRail = { cycleId, cycleName: cycle.name, closesOn: cycle.closesOn, steps, ...(block ? { done: block.done, total: block.total } : stripProgress(steps)) };
    let notIn: { cycleName: string; reason: NotInReason } | null = null;
    if (!block && !(leader?.mode === 'running')) {
      const mine = own.find((r) => r.cycleId === cycleId && !r.participates) ?? null;
      const takingPart = own.some((r) => r.cycleId === cycleId && r.participates);
      if (!takingPart) notIn = { cycleName: cycle.name, reason: await withPerformanceTenant(ctx, (tx) => notInReasonTx(tx, cycleId, mine?.employmentId ?? null)) };
    }
    return { ...view, mode: 'running', rail, next: homeNext(block, items, cycleId), slot: homeSlot({ block, leader, notIn, items, cycleId }) };
  }

  // Between cycles.
  const last = past[0] ?? null;
  const lastOwn = last ? own.find((r) => r.id === last.id) ?? null : null;
  if (last) {
    const href = recordHref(last.id, last.id);
    const results: HomeResults = { id: last.id, name: last.name, performance: last.performance, potential: last.potential, talent: last.talent, recordHref: href, reportHref: last.report ? recordHref(last.id, last.id, 'feedback') : null };
    view.results = results;
  }
  if (lastOwn) {
    // The last cycle's journey: the WP-A2 strip's own steps over that closed review (no task, team or lead input).
    const journey = await (async () => {
      const review = await getOnehrReview(ctx, lastOwn.id);
      if (!review) return null;
      const feedbackSubmitted = await withPerformanceTenant(ctx, (tx) => submittedPanelsTx(tx, lastOwn.cycleId));
      return deriveHomeBlock({
        own: { reviewId: lastOwn.id, cycleId: lastOwn.cycleId, cycleName: lastOwn.cycleName, periodEnd: lastOwn.periodEnd },
        review, tasks: [], feedbackOpen: [], feedbackSubmitted, team: [], sessions: [], inCycle: new Set<string>(), now,
      }).steps;
    })().catch((error: unknown) => {
      console.error('[performance-home] past journey unavailable', error);
      return null;
    });
    if (journey?.length) view.past = { cycleName: lastOwn.cycleName, steps: pastJourney(journey) };
  }
  view.led = leader?.mode === 'record' ? (leader as RecordLeaderStatus) : null;
  const plan = record?.selectedPlan ?? null;
  if (plan && own[0]) {
    const planView: HomePlan = {
      year: plan.planYear, status: plan.status === 'closed' ? 'closed' : plan.status === 'shared' ? 'shared' : 'draft',
      goals: plan.goals.slice(0, 3).map((g) => ({ id: g.id, area: g.area, status: g.status })),
      href: performanceTabState(facts, 'plan.my') === 'open' ? '/performance/plan' : recordHref(own[0].id, record?.currentId ? 'current' : past[0]?.id, 'plans'),
    };
    view.plan = planView;
  }
  return view;
}
