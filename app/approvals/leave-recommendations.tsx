import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Sparkles } from 'lucide-react';
import type { SessionContext } from '@/db/client';
import { workerRunGate } from '@/core/agent-registry/controls';
import { RECOMMENDER_WORKER } from '@/core/recommenders/leave-decision';
import { pendingLeaveTaskMetadata } from '@/packs/leave/service';
import { readLeaveRecommendation, type LeaveRecommendationView } from '@/app/assistant/centre/recommendation';
import { RecommendationPanel } from '@/components/ai-centre/leave-recommendation';
import { assignedApprovalHref } from '@/lib/assigned-approval-focus';
import { cn } from '@/lib/utils';

/** AI v2 W6, "AI where the work is": the approver recommendation on /approvals and on the single leave request
 * review page (/approvals?task=leave&requestId=…), beside the decision it advises on.
 *
 *  - Runs only while the approver_recommendation worker may run (workerRunGate, the same gate the recommender
 *    re-checks before it records). Switched off or stopped: nothing is read and nothing is shown.
 *  - Runs only for the leave requests assigned to this approver now, by the owner that fills the approvals
 *    inbox (pendingLeaveTaskMetadata, the check recommendLeaveDecision itself makes). A row the viewer can see
 *    but does not decide (an administrator reading another approver's queue) gets no recommendation.
 *  - Opening the page is the worker's declared trigger ("an approver opens a leave request assigned to them").
 *    Each run writes, or reuses today's, outcome record through the recommender; nothing here writes.
 *  - At most RECOMMEND_ON_OPEN rows run per page open, in the page's order, a few at a time, so a long queue
 *    cannot make the inbox slow. A row past the cap offers its own review page, where it runs alone.
 * The approver decides exactly as before; the verdict is never "reject" and never decides anything. */
export const RECOMMEND_ON_OPEN = 25;
const AT_ONCE = 4;

export type ApprovalRecommendations = Readonly<{
  /** The worker may run and the viewer is the assigned approver of at least one listed row. */
  active: boolean;
  views: ReadonlyMap<string, LeaveRecommendationView>;
  /** Assigned rows past the cap, which offer their own review page instead. */
  deferred: ReadonlySet<string>;
}>;
const NONE: ApprovalRecommendations = Object.freeze({ active: false, views: new Map<string, LeaveRecommendationView>(), deferred: new Set<string>() });

export async function readApprovalRecommendations(session: SessionContext, leaveRequestIds: readonly string[]): Promise<ApprovalRecommendations> {
  if (leaveRequestIds.length === 0) return NONE;
  try {
    const gate = await workerRunGate(session, RECOMMENDER_WORKER);
    if (!gate.run) return NONE;
    const assigned = new Set((await pendingLeaveTaskMetadata(session)).map(item => item.id));
    const mine = leaveRequestIds.filter(id => assigned.has(id));
    if (mine.length === 0) return NONE;
    const now = mine.slice(0, RECOMMEND_ON_OPEN);
    const views = new Map<string, LeaveRecommendationView>();
    for (let i = 0; i < now.length; i += AT_ONCE) {
      const batch = now.slice(i, i + AT_ONCE);
      const read = await Promise.all(batch.map(id => readLeaveRecommendation(session, id)));
      batch.forEach((id, index) => {
        const view = read[index];
        // A recommendation, or a read that failed. A refusal (switched off or stopped in between, no longer
        // assigned or pending) shows nothing: the row is decided as before.
        if (view.kind === 'recommendation' || view.reason === 'failed') views.set(id, view);
      });
    }
    return Object.freeze({ active: true, views, deferred: new Set(mine.slice(RECOMMEND_ON_OPEN)) });
  } catch {
    // The inbox never fails because the recommendation could not be prepared.
    return NONE;
  }
}

/** Leave rows that pass every check: recommend_approve, nothing less. */
export function passingIds(recommendations: ApprovalRecommendations): ReadonlySet<string> {
  return new Set([...recommendations.views].filter(([, view]) => view.kind === 'recommendation' && view.verdict === 'recommend_approve').map(([id]) => id));
}

/** The full-width row under a leave request: its recommendation, or for a row past the cap, its review page. */
export async function LeaveRecommendationRow({ leaveRequestId, recommendations, columns }: { leaveRequestId: string; recommendations: ApprovalRecommendations; columns: number }) {
  const view = recommendations.views.get(leaveRequestId);
  const deferred = recommendations.deferred.has(leaveRequestId);
  if (!view && !deferred) return null;
  const t = await getTranslations('aiCentre');
  const prepared = { summary: t('card.howPrepared'), rows: [
    [t('card.authority'), t('card.approvalAuthority')], [t('card.read'), t('recommendation.prepared.read')],
    [t('card.model'), t('recommendation.prepared.model')], [t('card.decision'), t('card.notYet')],
    [t('recommendation.prepared.recordLabel'), t('recommendation.prepared.record')],
  ] as const };
  return (
    <tr data-recommendation-row={leaveRequestId} className="bg-muted/20">
      <td colSpan={columns} className="px-4 pb-3 pt-0">
        {view ? <RecommendationPanel view={view} detail decideHere inset={false} prepared={prepared} />
          : <Link href={assignedApprovalHref({ kind: 'leave', id: leaveRequestId })} prefetch={false} data-recommendation-loader
            className="inline-flex min-h-9 items-center gap-1.5 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11">
            <Sparkles aria-hidden className="size-3.5" />{t('recommendation.openOne')}
          </Link>}
      </td>
    </tr>
  );
}

/** "Passes every check": shows only the leave requests whose recommendation passed every check, so the approver
 * can select them (the section's select-all) and decide them through the existing bulk path, which confirms
 * first and decides each request through decideLeave. Selecting nothing is the default; nothing is approved
 * automatically. Offered only with several leave requests and at least one that passes. */
export async function PassingFilter({ href, active, count, total }: { href: { all: string; passing: string }; active: boolean; count: number; total: number }) {
  if (total < 2 || (count === 0 && !active)) return null;
  const t = await getTranslations('aiCentre.recommendation.filter');
  const pill = (on: boolean) => cn('inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11',
    on ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent');
  return (
    <div data-recommendation-filter className="border-b border-border px-4 py-2">
      <nav aria-label={t('label')} className="flex flex-wrap items-center gap-2">
        <Link href={href.all} aria-current={active ? undefined : 'page'} className={pill(!active)}>{t('all')}</Link>
        <Link href={href.passing} aria-current={active ? 'page' : undefined} data-filter-passing className={pill(active)}>
          <Sparkles aria-hidden className="mr-1 size-3.5" />{t('passing', { count })}
        </Link>
      </nav>
      {active && <p className="mt-1.5 text-xs text-muted-foreground">{t('help')}</p>}
    </div>
  );
}
