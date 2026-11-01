/** Scheduled and interactive promotion maintenance share this dependency-light owner.
 * No provider evaluation, UI pack registry, or interactive action adapter is imported here. */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { AiGatewayError } from '../lib/ai/types';
import { promotionOutcomeKinds, outcomeWindow, earlierWindow, outcomeRegressed, type OutcomeCountRow } from '../lib/ai/promotion-outcome-regression';
import { agentReleaseIntervalTx } from './agent-release-interval';
const fail = (): never => { throw new AiGatewayError('Agent review could not be confirmed.'); };
const uuid = (value: string) => /^[a-f0-9-]{36}$/i.test(value);
const capture = (ctx: SessionContext) => ({ ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) });

/** WP11: one maintenance owner for the administrator command and the scheduled agent principal.
 * Retires (a) expired promotions, (b) exhausted typed/specialist permits and (c) LIVE promotions whose
 * measured action outcomes regressed (lib/ai/promotion-outcome-regression.ts, PR #34 counts). Every
 * retirement takes the owner's exclusive release interval and skips a busy owner rather than waiting.
 * Deterministic and model-free; it returns counts only. */
export type MaintenanceActor=Readonly<{kind:'user';userId:string}|{kind:'agent';principalId:string}>;
export type ModuleAgentMaintenance=Readonly<{retired:number;outcomeRegressed:number}>;
const dueRetirement=sql`(p.expires_at<=now() or (p.used_jobs>=p.max_jobs and exists(select 1 from public.ai_agent_candidate c where c.id=p.candidate_id and c.tenant_id=p.tenant_id and c.kind in('typed_route_priority_v1','canonical_specialist_v1'))))`;
async function retirePromotionTx(tx:Tx,ctx:SessionContext,actor:MaintenanceActor,promotionId:string,reason:'expired'|'exhausted'|'outcome_regression'){
 const actorColumns=actor.kind==='user'?sql`${actor.userId}::uuid,null`:sql`null,${actor.principalId}::uuid`;
 const inserted=await tx.execute<{id:string}>(sql`insert into public.ai_agent_rollback(tenant_id,promotion_id,actor_user_id,actor_agent_principal_id,reason)
  values(${ctx.tenantId}::uuid,${promotionId}::uuid,${actorColumns},${reason}) on conflict(promotion_id) do nothing returning id`);
 return inserted.length;
}
export async function maintainPromotionsTx(tx:Tx,ctx:SessionContext,actor:MaintenanceActor,limit:number):Promise<ModuleAgentMaintenance>{
 const rows=await tx.execute<{id:string;owner_user_id:string}>(sql`select p.id,p.owner_user_id from public.ai_agent_promotion p
  where p.tenant_id=${ctx.tenantId}::uuid and ${dueRetirement}
  and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id and r.tenant_id=p.tenant_id)
  order by p.owner_user_id,p.created_at,p.id limit ${limit}`);
 let retired=0,regressed=0;
 for(const row of rows){if(!await agentReleaseIntervalTx(tx,ctx,row.owner_user_id,true,false))continue;
  const [fresh]=await tx.execute<{id:string;reason:'expired'|'exhausted'}>(sql`select p.id,case when p.expires_at<=now() then 'expired' else 'exhausted' end as reason from public.ai_agent_promotion p
   where p.id=${row.id}::uuid and p.tenant_id=${ctx.tenantId}::uuid and p.owner_user_id=${row.owner_user_id}::uuid and ${dueRetirement}
   and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id and r.tenant_id=p.tenant_id)`);
  if(!fresh)continue;retired+=await retirePromotionTx(tx,ctx,actor,fresh.id,fresh.reason);
 }
 const live=await tx.execute<{id:string;owner_user_id:string;module_code:string;created_at:string}>(sql`select p.id,p.owner_user_id,p.module_code,p.created_at::text from public.ai_agent_promotion p
  where p.tenant_id=${ctx.tenantId}::uuid and p.expires_at>now() and p.created_at<now()
  and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id and r.tenant_id=p.tenant_id)
  order by p.created_at,p.id limit ${limit}`);
 for(const row of live){const kinds=promotionOutcomeKinds(row.module_code);if(!kinds.length)continue;
  const during=await tx.execute<OutcomeCountRow>(sql`select action_kind,completed,discarded,expired,refused,reversed from app.assistant_action_outcome_summary(${row.created_at}::timestamptz)`);
  const wide=await tx.execute<OutcomeCountRow>(sql`select action_kind,completed,discarded,expired,refused,reversed from app.assistant_action_outcome_summary(${row.created_at}::timestamptz-(now()-${row.created_at}::timestamptz))`);
  const measured=outcomeWindow(Array.from(during),kinds),before=earlierWindow(outcomeWindow(Array.from(wide),kinds),measured);
  if(!outcomeRegressed(before,measured))continue;
  if(!await agentReleaseIntervalTx(tx,ctx,row.owner_user_id,true,false))continue;
  const [still]=await tx.execute<{id:string}>(sql`select p.id from public.ai_agent_promotion p where p.id=${row.id}::uuid and p.tenant_id=${ctx.tenantId}::uuid and p.expires_at>now()
   and not exists(select 1 from public.ai_agent_rollback r where r.promotion_id=p.id and r.tenant_id=p.tenant_id)`);
  if(!still)continue;const n=await retirePromotionTx(tx,ctx,actor,still.id,'outcome_regression');retired+=n;regressed+=n;
 }
 return Object.freeze({retired,outcomeRegressed:regressed});
}
/** Scheduled sweep (scripts/review-sweep.ts): the tenant's named agent principal (0672), no login, no
 * grant and no model spend (owner decision 2). The database confirms the principal before any read. */
export async function maintainModuleAgentReleasesAsScheduledAgent(ctx:SessionContext,limit=100):Promise<ModuleAgentMaintenance>{
 const current=capture(ctx),principalId=ctx.agent?.principalId;
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||current.userId||typeof principalId!=='string'||!uuid(principalId))return fail();
 return withTenant(current,async tx=>{
  const [row]=await tx.execute<{principal:string|null}>(sql`select app.current_agent_principal()::text as principal`);
  if(!row?.principal||row.principal!==principalId)return fail();
  return maintainPromotionsTx(tx,current,{kind:'agent',principalId},limit);
 });
}

