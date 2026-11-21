import { pendingTaskSummary, type InboxModulesWithRecruitment } from '../core/approvals-inbox';
import type { SessionContext } from '../db/client';
import {settleReadGroup} from './settle-read-group';
import { countPendingClaimTasks } from '../packs/claims/service';

/** The shell presents the exact Claims badge. Its Claims tab fetches the rows on demand. */
export async function readShellTaskSummary(
  session: SessionContext,
  scopeIds: string[] | undefined,
  modules: InboxModulesWithRecruitment,
) {
  const [summary, claimTotal] = await settleReadGroup([
    ()=>pendingTaskSummary(session, scopeIds, { ...modules, claims: false }, { deferClaimPreview: true }),
    ()=>modules.claims ? countPendingClaimTasks(session, scopeIds) : 0,
  ]);
  return {
    ...summary,
    claimTotal,
    total: summary.total + claimTotal,
    approvalCount: summary.approvalCount + claimTotal,
  };
}
