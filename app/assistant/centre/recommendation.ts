import { z } from 'zod';
import type { SessionContext } from '@/db/client';
import { recommendLeaveDecision, recordRecommendationDecision, type RecommendationCheckName, type RecommendationResult, type RecommendationUnavailable, type RecommendationVerdict } from '@/core/recommenders/leave-decision';
import { ruleVersionLabel, type RuleVersionLabel } from '@/lib/ai-centre/rule-version';

/** What the Inbox shows for one leave request: the verdict and the failed rules, each with the rule's
 * version label where its owner publishes one. Never the internal version reference, never a reject
 * verdict (the recommender has none). */
export type LeaveRecommendationView =
  | Readonly<{ kind: 'recommendation'; verdict: RecommendationVerdict; failedRules: readonly Readonly<{ check: RecommendationCheckName; blocking: boolean; version: RuleVersionLabel | null }>[];
      /** AI v2 W6: every check with its result and version, for the approval pages that show all four. */
      checks?: readonly RecommendationCheckView[];
      /** The outcome record this run wrote (or reused today), so the approver's decision can be appended to it. */
      recordId?: string | null }>
  | Readonly<{ kind: 'unavailable'; reason: RecommendationUnavailable | 'failed' }>;

/** The version a check ran under, as the screen may show it: a leave rule's own version, or the
 * recommender's version where its own rule decides (own overlap, team coverage). */
export type CheckVersionLabel = RuleVersionLabel | Readonly<{ kind: 'recommender'; version: number }>;
export type RecommendationCheckView = Readonly<{ check: RecommendationCheckName; result: RecommendationResult; blocking: boolean; version: CheckVersionLabel | null }>;

const RECOMMENDER_PATTERN = /^leave_decision_recommender:v(\d{1,6})$/;
function checkVersionLabel(reference: string | null): CheckVersionLabel | null {
  const rule = ruleVersionLabel(reference);
  if (rule) return rule;
  const match = typeof reference === 'string' ? RECOMMENDER_PATTERN.exec(reference) : null;
  const version = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(version) && version >= 1 ? { kind: 'recommender', version } : null;
}

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
    const { verdict, failedRules, checks, recordId } = result.recommendation;
    return { kind: 'recommendation', verdict, failedRules: failedRules.map(rule => ({ check: rule.check, blocking: rule.blocking, version: ruleVersionLabel(rule.ruleVersion) })),
      checks: checks.map(check => ({ check: check.check, result: check.result, blocking: check.blocking, version: checkVersionLabel(check.ruleVersion) })), recordId };
  } catch {
    return { kind: 'unavailable', reason: 'failed' };
  }
}

/** After the approver decided a leave request on /approvals: appends whether they followed the recommendation
 * to its outcome record (core/recommenders/leave-decision.ts recordRecommendationDecision). The service reads
 * the verdict and the native decision event itself and refuses anything else, so a posted record id adds no
 * authority. Best effort: the decision is already committed, and a follow-up that cannot be written must
 * never turn it into a failed action. */
export async function followLeaveRecommendation(session: SessionContext, recordId: unknown, decision: 'approved' | 'rejected'): Promise<void> {
  const id = z.guid().safeParse(recordId);
  if (!id.success) return;
  try { await recordRecommendationDecision(session, { recordId: id.data, decision }); } catch { /* the decision stands */ }
  // AI v2 Phase 2 P2-6: a decision against the recommendation is a learning signal (core/learning/signals.ts), recorded only
  // when the recommender's own follow-up says the approver disagreed. Best effort, like the follow-up.
  if (decision === 'rejected') {
    try {
      const [{ recordRecommendationSignal }, { getLocale }] = await Promise.all([import('@/core/learning/signals'), import('next-intl/server')]);
      await recordRecommendationSignal(session, { recordId: id.data, locale: await getLocale().catch(() => 'en') });
    } catch { /* the decision stands */ }
  }
}
