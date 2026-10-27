/** Allocation controls. Price certificates and verified receipt authority are NOT user-editable. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {assertAiPrincipalTx} from './ai-principal';
import {isGroupAdmin} from '../lib/authz-model';
import {isAiFeature} from '../lib/ai/features';
import {usdToNanos} from '../lib/ai/spend-allocation';
import {AiGatewayError} from '../lib/ai/types';
export type AiSpendStatus=Readonly<{currency:'USD';unit:'nano_usd';semantics:'application_inference_allocation';certifiedLiveRoutes:0;reviewedCarrierRecords:number|null;liveCapability:'not_verified_here';budgets:readonly {scopeKey:string;monthlyNanos:string;rootNanos:string}[];heldNanos:string;confirmedNanos:string|null;breached:boolean}>;
export async function aiSpendStatusTx(tx:Tx,ctx:SessionContext):Promise<AiSpendStatus|null>{
 await assertAiPrincipalTx(tx,ctx);if(!isGroupAdmin(ctx))return null;
 const[row]=await tx.execute<{status:AiSpendStatus}>(sql`select app.ai_spend_status() as status`);if(!row)throw new AiGatewayError('AI spend allocation unavailable.');const count=row.status.reviewedCarrierRecords;return{...row.status,reviewedCarrierRecords:typeof count==='number'&&Number.isSafeInteger(count)&&count>=0?count:null,liveCapability:'not_verified_here'};
}
export async function setAiSpendBudget(supplied:SessionContext,input:{kind:'tenant'|'company'|'user'|'feature';subjectId?:string|null;featureId?:string|null;monthlyUsd:string;rootUsd:string}){
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))},p={...input};
 if(!isGroupAdmin(ctx)||!['tenant','company','user','feature'].includes(p.kind)||p.kind==='feature'&&!isAiFeature(p.featureId??''))throw new AiGatewayError('AI spend administration unavailable.');
 const monthly=usdToNanos(p.monthlyUsd).toString(),root=usdToNanos(p.rootUsd).toString();
 return withTenant(ctx,async tx=>{await assertAiPrincipalTx(tx,ctx);
  await tx.execute(sql`select app.ai_spend_budget_save(${p.kind},${p.subjectId??null}::uuid,${p.featureId??null},${monthly}::bigint,${root}::bigint)`);
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'ai-control',aggregateId:ctx.tenantId,eventType:'ai-control.spend-allocation-changed',actor:actorOf(ctx),payload:{kind:p.kind,subjectId:p.subjectId??null,featureId:p.featureId??null,monthlyNanos:monthly,rootNanos:root,currency:'USD'}});
 });
}
