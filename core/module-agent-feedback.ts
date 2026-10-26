/** Explicit own-user feedback custody. This is an opinion, never independent evaluation truth.
 * No free text, answer, prompt, HR facts, provider call or cross-user learning corpus is stored.
 */
import { isGroupAdmin } from '../lib/authz-model';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { assertAiPrincipalTx } from './ai-principal';
import { assertMayUseAssistant } from './assistant-grant';
import { resolveEntitlementsTx } from './entitlements';
import { AiGatewayError } from '../lib/ai/types';
export const AGENT_FEEDBACK_OUTCOMES = ['helpful', 'needs_correction', 'incorrect'] as const;
export type AgentFeedbackOutcome = typeof AGENT_FEEDBACK_OUTCOMES[number];
const failure = () => new AiGatewayError('Assistant feedback could not be saved.');
export async function recordOwnAgentFeedback(ctx: SessionContext, value: {
  exchangeId: string; outcome: AgentFeedbackOutcome; consented: true;
}): Promise<void> {
  const captured = { ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) };
  const input = { exchangeId: value.exchangeId, outcome: value.outcome, consented: value.consented };
  if (!/^[a-f0-9-]{36}$/i.test(input.exchangeId) || !AGENT_FEEDBACK_OUTCOMES.includes(input.outcome) || input.consented !== true ||
    Object.keys(value).some(key => !['exchangeId','outcome','consented'].includes(key))) throw failure();
  try {
    await withTenant(captured, async tx => {
      await assertAiPrincipalTx(tx, captured);
      const fresh = { ...captured, entitlements: await resolveEntitlementsTx(tx, captured.tenantId) };
      await assertMayUseAssistant(fresh, tx);
      // UserId in the predicate is essential: HR history visibility does not grant feedback custody.
      const rows = await tx.execute<{ id: string }>(sql`select id from public.assistant_exchange
        where id=${input.exchangeId}::uuid and tenant_id=${captured.tenantId}::uuid
        and app_user_id=${captured.userId}::uuid`);
      if (rows.length !== 1) throw failure();
      await tx.execute(sql`delete from public.ai_agent_feedback where tenant_id=${captured.tenantId}::uuid
        and user_id=${captured.userId}::uuid and expires_at<=now()`);
      await tx.execute(sql`insert into public.ai_agent_feedback(tenant_id,user_id,exchange_id,outcome,consented)
        values(${captured.tenantId}::uuid,${captured.userId}::uuid,${input.exchangeId}::uuid,${input.outcome},true)
        on conflict(tenant_id,user_id,exchange_id) do update set outcome=excluded.outcome,consented=true`);
    });
  } catch { throw failure(); }
}
/** Erasure is always available to the current authenticated owner, including after grant revocation. */
export async function eraseOwnAgentFeedback(ctx: SessionContext): Promise<void> {
  const captured = { ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) };
  try { await withTenant(captured, async tx => {
    await assertAiPrincipalTx(tx, captured);
    await tx.execute(sql`delete from public.ai_agent_feedback where tenant_id=${captured.tenantId}::uuid
      and user_id=${captured.userId}::uuid`);
  }); } catch { throw failure(); }
}

/** Bounded tenant maintenance under the actual current group administrator; never impersonates users. */
export async function purgeExpiredAgentFeedback(ctx:SessionContext,limit=100):Promise<{removed:number}>{
 const current={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw failure();
 try{return await withTenant(current,async tx=>{
  await assertAiPrincipalTx(tx,current);if(!isGroupAdmin(current))throw failure();
  const [role]=await tx.execute<{allowed:boolean}>(sql`select app.is_group_admin() as allowed`);
  if(role?.allowed!==true)throw failure();
  const [row]=await tx.execute<{removed:number}>(sql`select app.purge_expired_agent_feedback(${limit}) as removed`);
  if(!Number.isSafeInteger(row?.removed)||row.removed<0||row.removed>limit)throw failure();
  return {removed:row.removed};
 });}catch{throw failure();}
}
