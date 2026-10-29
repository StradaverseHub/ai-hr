/** Read-only WP3 projection. The process assessment owns counts; the capability inventory owns entries. */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { isGroupAdmin } from '../lib/authz-model';
import { resolveEntitlementsTx } from './entitlements';
import { assertAiPrincipalTx } from './ai-principal';
import { assessProcessesTx, type AssessmentWindow } from './process-assessment';
import { agentBacklogByTier } from '../lib/ai/agent-capability-inventory';
import { BACKLOG_RANKING_VERSION, rankAgentBacklog } from '../lib/ai/agent-backlog-ranking';

export class AgentBuildListAccessError extends Error {}

export async function agentBuildList(ctx: SessionContext, window: AssessmentWindow = 90) {
  ctx = {...ctx, roles:ctx.roles?.slice(), grants:ctx.grants?.map(g=>({...g}))};
  if (!ctx.userId || !isGroupAdmin(ctx)) throw new AgentBuildListAccessError('Only group HR administrators may view the build list.');
  return withTenant(ctx, async tx => {
    await assertAiPrincipalTx(tx, ctx);
    const [scope] = await tx.execute<{allowed:boolean}>(sql`select app.is_group_admin() as allowed`);
    if (scope?.allowed !== true) throw new AgentBuildListAccessError('Current build-list access could not be confirmed.');
    const current = {...ctx, entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};
    const assessment = await assessProcessesTx(tx, current, window);
    const entries = rankAgentBacklog(assessment.processes);
    return {version:BACKLOG_RANKING_VERSION,assessmentVersion:assessment.version,window,from:assessment.from,
      totals:agentBacklogByTier(),entries,assessment};
  });
}
