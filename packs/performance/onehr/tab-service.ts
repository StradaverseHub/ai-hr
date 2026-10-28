/**
 * D-P1-32 PT-X1: the ONE server context builder for the Performance & Talent tab gates, and the per-tab
 * "may open" check the tab route pages use to refuse a crafted URL for a hidden tab.
 *
 * The facts are the same workspace projection the tab routes resolve (performanceWorkspaceTx), read once in
 * one transaction, plus one existence read: whether the viewer holds a released 360 report of their own.
 * The gates themselves are pure (tab-model.ts).
 */
import { eq, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../../db/client';
import { onehrReview, reviewCycle } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { isModuleEnabled } from '../../../core/entitlements';
import { performanceWorkspaceTx } from './service';
import { performanceTabState, type PerformanceAreaFacts, type PerformanceTabState } from './tab-model';

const noFacts: PerformanceAreaFacts = { performanceOn: false, items: [], ownFeedbackReport: false };

/** The viewer's own review with a released 360 report, in any cycle past draft (history included). */
async function ownFeedbackReportTx(tx: Tx) {
  const [row] = await tx.select({ id: onehrReview.reviewId }).from(onehrReview)
    .innerJoin(reviewCycle, eq(reviewCycle.id, onehrReview.cycleId))
    .where(sql`${reviewCycle.status}<>'draft' and exists(select 1 from employment e where e.id=${onehrReview.employmentId} and app.is_self_person(e.person_id)) and (app.onehr_result_card(${onehrReview.reviewId})->>'feedbackReleasedAt') is not null`)
    .limit(1);
  return !!row;
}

/**
 * The tab gates' facts for the signed-in viewer. With `cycleId`, the worklist is narrowed to that cycle (a
 * cycle the viewer holds nothing in leaves only the Dashboard tab). The 360 report fact is cycle-independent.
 */
export async function getPerformanceAreaFacts(ctx: SessionContext, opts: { cycleId?: string } = {}): Promise<PerformanceAreaFacts> {
  if (!ctx.userId || !isModuleEnabled(ctx, 'performance')) return noFacts;
  return withPerformanceTenant(ctx, async tx => {
    const all = await performanceWorkspaceTx(tx, ctx);
    const items = (opts.cycleId ? all.filter(item => item.cycleId === opts.cycleId) : all)
      .map(({ kind, cycleId, view, module, stage, axis, locked }) => ({ kind, cycleId, view, module, stage, axis, locked }));
    return { performanceOn: true, items, ownFeedbackReport: await ownFeedbackReportTx(tx) };
  });
}

/**
 * May the viewer open this tab's route? `mayOpen` is true only for an 'open' tab: a hidden tab, a disabled
 * (locked) Career Plan tab and an unknown id are all refused. The page calls notFound() when it is false, and
 * may reuse `facts` to draw its strip without a second read.
 */
export async function performanceTabAccess(ctx: SessionContext, tabId: string, opts: { cycleId?: string } = {}): Promise<{ state: PerformanceTabState; mayOpen: boolean; facts: PerformanceAreaFacts }> {
  const facts = await getPerformanceAreaFacts(ctx, opts);
  const state = performanceTabState(facts, tabId);
  return { state, mayOpen: state === 'open', facts };
}
