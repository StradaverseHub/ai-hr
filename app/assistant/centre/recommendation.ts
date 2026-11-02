import { z } from 'zod';
import type { SessionContext } from '@/db/client';
import { recommendLeaveDecision, type RecommendationCheckName, type RecommendationUnavailable, type RecommendationVerdict } from '@/core/recommenders/leave-decision';
import { ruleVersionLabel, type RuleVersionLabel } from '@/lib/ai-centre/rule-version';

/** What the Inbox shows for one leave request: the verdict and the failed rules, each with the rule's
 * version label where its owner publishes one. Never the internal version reference, never a reject
 * verdict (the recommender has none). */
export type LeaveRecommendationView =
  | Readonly<{ kind: 'recommendation'; verdict: RecommendationVerdict; failedRules: readonly Readonly<{ check: RecommendationCheckName; blocking: boolean; version: RuleVersionLabel | null }>[] }>
  | Readonly<{ kind: 'unavailable'; reason: RecommendationUnavailable | 'failed' }>;

/** Runs only when the approver explicitly opens the recommendation on a leave card (the Inbox link carries
 * `?recommend=<id>`), the recommender's declared trigger ("an approver opens a leave request assigned to
 * them"). A server-side read during that render, not a server action: the service checks the caller is the
 * assigned approver and the request is pending, records the run, and refuses otherwise; this adds no
 * authority of its own. */
export async function readLeaveRecommendation(session: SessionContext, leaveRequestId: string): Promise<LeaveRecommendationView> {
  const id = z.guid().safeParse(leaveRequestId);
  if (!id.success) return { kind: 'unavailable', reason: 'not_assigned' };
  try {
    const result = await recommendLeaveDecision(session, { leaveRequestId: id.data });
    if (result.kind === 'unavailable') return { kind: 'unavailable', reason: result.reason };
    const { verdict, failedRules } = result.recommendation;
    return { kind: 'recommendation', verdict, failedRules: failedRules.map(rule => ({ check: rule.check, blocking: rule.blocking, version: ruleVersionLabel(rule.ruleVersion) })) };
  } catch {
    return { kind: 'unavailable', reason: 'failed' };
  }
}
