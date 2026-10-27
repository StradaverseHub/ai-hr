/** Source-owned persistent spend roots; metadata contains no question, prompt, HR rows or secrets.
 * Root identity limits money only. It grants no source/tool/field access; actual admission callbacks
 * still re-read canonical source and current authority. Native retries never mint another root. */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import type {ResolvedAiConfig} from '../lib/ai/types';
import {AiGatewayError} from '../lib/ai/types';
import {assertAiPrincipalTx} from './ai-principal';
import {assertModuleEnabled,resolveEntitlementsTx} from './entitlements';
import {assertMayUseAssistant} from './assistant-grant';
import {bindStrictAiSpendRoot} from './ai-governance';
import type {ReadinessGapId} from './record-readiness';
export type AiSpendTaskSource=Readonly<{kind:'assistant_question'}|{kind:'claim_request';sourceId:string}|{kind:'payroll_batch';sourceId:string}|{kind:'readiness_template';gap:ReadinessGapId;audience:'employee'|'hr'}>;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const gaps=['no_compensation','no_bank_account','no_identity','no_tax_number','no_epf_number','no_socso_number'];
export async function bindAiSpendTaskTx(tx:Tx,supplied:SessionContext,configuration:ResolvedAiConfig,source:AiSpendTaskSource):Promise<ResolvedAiConfig>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))},p={...source};
 const exact=(keys:string[])=>Object.keys(p).sort().join(',')===keys.sort().join(',');let feature:string,module:string,nativeId:string|null,operation:string;
 if(p.kind==='assistant_question'&&exact(['kind'])){feature='hr_assistant';module='assistant';nativeId=null;operation='question';}
 else if(p.kind==='claim_request'&&exact(['kind','sourceId'])&&UUID.test(p.sourceId)){feature='claims_triage';module='claims';nativeId=p.sourceId;operation='triage';}
 else if(p.kind==='payroll_batch'&&exact(['kind','sourceId'])&&UUID.test(p.sourceId)){feature='payroll_hypotheses';module='payroll';nativeId=p.sourceId;operation='hypotheses';}
 else if(p.kind==='readiness_template'&&exact(['kind','gap','audience'])&&gaps.includes(p.gap)&&['employee','hr'].includes(p.audience)){feature='readiness_reminders';module='notifications';nativeId=ctx.tenantId;operation=p.gap+':'+p.audience;}
 else throw new AiGatewayError('The AI task identity could not be confirmed.');
 await assertAiPrincipalTx(tx,ctx);const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId),entitlementsExempt:undefined,entitlementsError:undefined};assertModuleEnabled(fresh,module);
 if(p.kind==='assistant_question')await assertMayUseAssistant(fresh,tx);
 const[row]=await tx.execute<{root_id:string}>(sql`select app.ai_spend_task_issue(${feature},${p.kind},${nativeId}::uuid,${operation}) as root_id`);
 if(!row||!UUID.test(row.root_id))throw new AiGatewayError('The AI task identity could not be confirmed.');
 return bindStrictAiSpendRoot(configuration,{rootTaskId:row.root_id,kind:'agent'});
}
