/** Current-user AI workspace read model. No shared cache, provider call or background/effect dispatch. */
import { desc, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { assistantExchange } from '../db/schema';
import { assertAiPrincipalTx } from './ai-principal';
import { mayUseAssistant, type AssistantAccess } from './assistant-grant';
import { resolveEntitlementsTx } from './entitlements';
import { toolsFor } from './assistant-tools';
import { workspaceTasksFor } from '../lib/ai/workspace-tasks';
import { withAssistantReadTx } from './assistant-read-session';
import { agentReviewWorkspaceTx } from './module-agent-releases';
import { assistantHistoryReplay } from './assistant-disclosure-read';

export async function loadAiWorkspace(ctx: SessionContext) {
  const captured = { ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) };
  if (!captured.userId) return { access: { allowed: false, reason: 'no_user' } as AssistantAccess, taskIds: [], history: [] };
  const userId = captured.userId;
  return withTenant(captured, async tx => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await assertAiPrincipalTx(tx, captured);
    const entitlements = await resolveEntitlementsTx(tx, captured.tenantId);
    const fresh = { ...captured, entitlements };
    const access = await mayUseAssistant(fresh, tx);
    if (!access.allowed) return { access, taskIds: [], history: [] };
    const taskIds = workspaceTasksFor(toolsFor(fresh).map(tool => tool.spec.name));
    // HR visibility is broader than personal conversation custody. Keep the explicit actual-user
    // predicate even when RLS could let an administrator read other users' exchange rows.
    const rows = await tx.select({
      id: assistantExchange.id, question: assistantExchange.question, answer: assistantExchange.answer,
      stop: assistantExchange.stop, hitTurnCap: assistantExchange.hitTurnCap,
      toolCalls: assistantExchange.toolCalls, askedAt: assistantExchange.askedAt,
      disclosureReceipt: assistantExchange.disclosureReceipt,
    }).from(assistantExchange).where(eq(assistantExchange.appUserId, userId))
      .orderBy(desc(assistantExchange.askedAt), desc(assistantExchange.id)).limit(10);
    const history = await withAssistantReadTx(fresh, tx, async session => {
      const replay = assistantHistoryReplay(fresh, session);
      const history = [];
      for (const row of rows) {
        const allowed = row.answer ? await replay({ tenantId: captured.tenantId, userId,
          exchangeId: row.id, question: row.question, answer: row.answer }, row.disclosureReceipt) : false;
        // Explicit projection: sealed custody evidence and stored tool inputs never enter page props.
        history.push({ id: row.id, question: row.question, answer: allowed ? row.answer : null,
          answerVisibility: row.answer ? (allowed ? 'current' as const : 'unavailable' as const) : 'none' as const,
          stop: row.stop, hitTurnCap: row.hitTurnCap, askedAt: row.askedAt,
          toolCalls: row.toolCalls.map(call => ({ name: call.name })) });
      }
      return history;
    });
    const agentReview=await agentReviewWorkspaceTx(tx,fresh);
    return { access, taskIds, history,agentReview };
  });
}
