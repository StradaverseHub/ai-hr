/** Shaped case workspace; all slices share one authorized native read. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {contractSharedContextTx} from './contract-shared-read';
import {terminationReasonCatalogueTx} from './termination-reason-catalog';
import {lockAccessConfigurationReadTx} from './access-configuration-lock';
import {ContractManagementError} from '../lib/contract-management-model';
import type {ContractSharedPostingSummary} from './contract-shared-postings';
import type {ContractSharedEndingActions} from './contract-shared-ending';
import {pgSqlState} from '../lib/db-error';
export type ContractFallbackPage={rows:{ordinal:number;at:string;runId:string;stepId:string;workflowName:string|null;stepNumber:number|null;stepName:string|null;details:{intended:string;reason:string;groupCurrentName:string|null}[]}[];total:number;hasMore:boolean;nextBefore:number|null};
export type ContractCaseWorkspace={
 fallbackPage?:ContractFallbackPage;
 configuredFallbackGroup?:string|null;
 approvals:{id:string;decisionRevision:number;createdAt:string;status:'pending'|'approved'|'rejected'|'cancelled';workflowName:string;stepId:string}[];
 letters:{id:string;decisionRevision:number;name:string;state:'routing'|'released'|'withdrawn';generatedOn:string;releasedAt:string|null;templateVersion:number;valuesFixed:boolean;returned:boolean}[];
 runs:{id:string;name:string;revision:number;trigger:string;status:'running'|'waiting'|'done'|'skipped'|'failed';cursor:number;waitingFor:string|null;startedAt:string;updatedAt:string;steps:{id:string;type:string;name:string}[];log:{at:string;kind:string;stepId:string|null;type:string|null;message?:string|null;fallbackCount?:number}[]}[];
};
export type ContractPeriodHistoryPage={total:number;rows:{id:string;caseNumber:string;startOn:string;endOn:string;contractNumber:number|null;stage:string|null;legacyState:string;shared:boolean;current:boolean}[]};
async function periodsTx(tx:Tx,caseId:string,offset:number){const [row]=await tx.execute<{page:ContractPeriodHistoryPage}>(sql`select app.contract_shared_period_history(${caseId}::uuid,50,${offset}) as page`);return row.page;}
export function contractSharedPeriods(ctx:SessionContext,caseId:string,offset=0){z.uuid().parse(caseId);z.number().int().min(0).max(100000).parse(offset);return withScopedLifecycleTenant(ctx,async tx=>{await lockAccessConfigurationReadTx(tx,ctx.tenantId);return periodsTx(tx,caseId,offset);});}
export function contractSharedWorkspace(ctx:SessionContext,caseId:string){
 z.uuid().parse(caseId);
 return withScopedLifecycleTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  const view=await contractSharedContextTx(tx,caseId);
  const [capabilities]=await tx.execute<{legacyReadable:boolean;canOpenPersonnel:boolean}>(sql`select app.contract_case_access(${caseId}::uuid) as "legacyReadable",app.access_workforce_employment(${view.employmentId}::uuid,'workforce.view') as "canOpenPersonnel"`);
  const [row]=await tx.execute<{workspace:ContractCaseWorkspace}>(sql`select app.contract_shared_workspace(${caseId}::uuid) as workspace`);
  const reasons=view.permissions.includes('decide')||view.permissions.includes('decline')?(await terminationReasonCatalogueTx(tx,ctx.tenantId)).filter(r=>r.active).map(({code,label,category})=>({code,label,category})):[];
  const activity=await tx.execute<{revision:number;at:string;actorName:string|null;actorType:'system'|'user';stage:string;decisionRevision:number|null}>(sql`select (entry->>'revision')::integer as revision,entry->>'at' as at,entry->>'actorName' as "actorName",case when entry->>'actorId' is null then 'system' else 'user' end as "actorType",entry->'flow'->>'stage' as stage,(entry->'flow'->'decision'->>'revision')::integer as "decisionRevision" from app.contract_shared_history(${caseId}::uuid,2147483647) entry`);
  const postingSummary=view.flow?(await tx.execute<{summary:ContractSharedPostingSummary|null}>(sql`select app.contract_shared_posting_case_summary(${caseId}::uuid) as summary`))[0].summary:null;
  const ending=view.flow?(await tx.execute<{actions:ContractSharedEndingActions}>(sql`select app.contract_shared_ending_actions(${caseId}::uuid) as actions`))[0].actions:null;
  const attention=await tx.execute<{caseId:string;stalledDays:number|null;attention:boolean;flags:string[]}>(sql`select * from app.contract_shared_case_attention(ARRAY[${caseId}::uuid])`);
  const [pending]=await tx.execute<{waiting:ContractWaitingMetadata[]}>(sql`select app.contract_shared_tracker_waiting(ARRAY[${caseId}::uuid]) as waiting`);
  return {view,...row.workspace,attention:attention.at(0)??null,ending,postingSummary,reasons,activity:[...activity],waiting:pending.waiting.at(0)??null,periods:await periodsTx(tx,caseId,0),legacyReadable:capabilities.legacyReadable,canOpenPersonnel:capabilities.canOpenPersonnel};
 });
}
export type ContractConfigurationChoices={accessAdmin:boolean;companies:{id:string;name:string}[];scopes:{id:string;name:string;parentId:string|null}[];people:{id:string;name:string}[];groups:{id:string;name:string}[]};
export function contractSharedConfigurationChoices(ctx:SessionContext){return withScopedLifecycleTenant(ctx,async tx=>{await lockAccessConfigurationReadTx(tx,ctx.tenantId);const [row]=await tx.execute<{choices:ContractConfigurationChoices}>(sql`select app.contract_shared_configuration_choices() as choices`);return row.choices;});}
export function contractSharedAccessPeople(ctx:SessionContext,search:string){z.string().max(100).parse(search);return withScopedLifecycleTenant(ctx,async tx=>{await lockAccessConfigurationReadTx(tx,ctx.tenantId);const [row]=await tx.execute<{people:{id:string;name:string}[]}>(sql`select app.contract_shared_access_people(${search}) as people`);return row.people;});}
export type ContractSharedLetterCapabilities={canBindEmployee:boolean;pendingRole:'employee'|'company'|null};
export function contractSharedLetterActions(ctx:SessionContext,letterId:string){z.uuid().parse(letterId);return withScopedLifecycleTenant(ctx,async tx=>{await lockAccessConfigurationReadTx(tx,ctx.tenantId);const [row]=await tx.execute<{actions:ContractSharedLetterCapabilities}>(sql`select app.contract_shared_letter_actions(${letterId}::uuid) as actions`);return row.actions;}).catch(error=>{if(pgSqlState(error)==='42501')throw new ContractManagementError('forbidden','This Contract letter is unavailable.');throw error;});}
export type ContractWaitingMetadata={caseId:string;waitingOn:string;waitingFor:string};
export function contractSharedWaiting(ctx:SessionContext,caseIds:string[]){const ids=z.array(z.uuid()).max(100).parse(caseIds);if(!ids.length)return Promise.resolve([] as ContractWaitingMetadata[]);return withScopedLifecycleTenant(ctx,async tx=>{await lockAccessConfigurationReadTx(tx,ctx.tenantId);const [row]=await tx.execute<{waiting:ContractWaitingMetadata[]}>(sql`select app.contract_shared_tracker_waiting(${`{${ids.join(',')}}`}::uuid[]) as waiting`);return row.waiting;});}

export function contractSharedFallbacks(ctx:SessionContext,caseId:string,before=2147483647):Promise<ContractFallbackPage>{
 z.uuid().parse(caseId);z.number().int().min(1).max(2147483647).parse(before);
 return withScopedLifecycleTenant(ctx,async tx=>{await lockAccessConfigurationReadTx(tx,ctx.tenantId);const [row]=await tx.execute<{page:ContractFallbackPage}>(sql`select app.contract_shared_fallback_page(${caseId}::uuid,${before},50) as page`);return row.page;}).catch(error=>{if(pgSqlState(error)==='42501')throw new ContractManagementError('forbidden','This Contract fallback history is unavailable.');throw error;});
}
