/** Current-user AI workspace read model. No cache, provider call or background/effect dispatch. */
import { desc, eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { assistantExchange } from '../db/schema';
import { assertAiPrincipalTx } from './ai-principal';
import { mayUseAssistant, type AssistantAccess } from './assistant-grant';
import { resolveEntitlementsTx } from './entitlements';
import { toolsFor } from './assistant-tools';
import { workspaceTasksFor } from '../lib/ai/workspace-tasks';

export async function loadAiWorkspace(ctx: SessionContext) {
  const captured = { ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) };
  if (!captured.userId) return { access: { allowed: false, reason: 'no_user' } as AssistantAccess, taskIds: [], history: [] };
  const userId = captured.userId;
  return withTenant(captured, async tx => {
    await assertAiPrincipalTx(tx, captured);
    const entitlements = await resolveEntitlementsTx(tx, captured.tenantId);
    const fresh = { ...captured, entitlements };
    const access = await mayUseAssistant(fresh, tx);
    if (!access.allowed) return { access, taskIds: [], history: [] };
    const taskIds = workspaceTasksFor(toolsFor(fresh).map(tool => tool.spec.name));
    // RELEASE BLOCKER: personal custody is not replay of historical source/field permissions.
    // Historical-answer disclosure receipts/current canonical reauthorization remain required.
    // HR visibility is broader than personal conversation custody. Keep the explicit actual-user
    // predicate even when RLS could let an administrator read other users' exchange rows.
    const history = await tx.select({
      id: assistantExchange.id, question: assistantExchange.question, answer: assistantExchange.answer,
      stop: assistantExchange.stop, hitTurnCap: assistantExchange.hitTurnCap,
      toolCalls: assistantExchange.toolCalls, askedAt: assistantExchange.askedAt,
    }).from(assistantExchange).where(eq(assistantExchange.appUserId, userId))
      .orderBy(desc(assistantExchange.askedAt), desc(assistantExchange.id)).limit(10);
    return { access, taskIds, history };
  });
}
