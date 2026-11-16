/** Shaped case workspace; all slices share one authorized native read. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {contractSharedContextTx} from './contract-shared-read';
import {terminationReasonCatalogueTx} from './termination-reason-catalog';
import {lockAccessConfigurationReadTx} from './access-configuration-lock';
export type ContractCaseWorkspace={
 approvals:{id:string;decisionRevision:number;createdAt:string;status:'pending'|'approved'|'rejected'|'cancelled';workflowName:string;stepId:string}[];
 letters:{id:string;decisionRevision:number;name:string;state:'routing'|'released'|'withdrawn';generatedOn:string;releasedAt:string|null;templateVersion:number;valuesFixed:boolean;returned:boolean}[];
 runs:{id:string;name:string;revision:number;trigger:string;status:'running'|'waiting'|'done'|'skipped'|'failed';cursor:number;waitingFor:string|null;startedAt:string;updatedAt:string;steps:{id:string;type:string;name:string}[];log:{at:string;kind:string;stepId:string|null;type:string|null}[]}[];
};
export function contractSharedWorkspace(ctx:SessionContext,caseId:string){
 z.uuid().parse(caseId);
 return withScopedLifecycleTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  const view=await contractSharedContextTx(tx,caseId);
  const [row]=await tx.execute<{workspace:ContractCaseWorkspace}>(sql`select app.contract_shared_workspace(${caseId}::uuid) as workspace`);
  const reasons=view.permissions.includes('decide')||view.permissions.includes('decline')?(await terminationReasonCatalogueTx(tx,ctx.tenantId)).filter(r=>r.active).map(({code,label,category})=>({code,label,category})):[];
  const activity=await tx.execute<{revision:number;at:string;actorName:string|null;stage:string;decisionRevision:number|null}>(sql`select (entry->>'revision')::integer as revision,entry->>'at' as at,entry->>'actorName' as "actorName",entry->'flow'->>'stage' as stage,(entry->'flow'->'decision'->>'revision')::integer as "decisionRevision" from app.contract_shared_history(${caseId}::uuid,2147483647) entry`);
  return {view,...row.workspace,reasons,activity:[...activity]};
 });
}
export type ContractConfigurationChoices={accessAdmin:boolean;companies:{id:string;name:string}[];scopes:{id:string;name:string;parentId:string|null}[];people:{id:string;name:string}[];groups:{id:string;name:string}[]};
export function contractSharedConfigurationChoices(ctx:SessionContext){return withScopedLifecycleTenant(ctx,async tx=>{await lockAccessConfigurationReadTx(tx,ctx.tenantId);const [row]=await tx.execute<{choices:ContractConfigurationChoices}>(sql`select app.contract_shared_configuration_choices() as choices`);return row.choices;});}
export function contractSharedAccessPeople(ctx:SessionContext,search:string){z.string().max(100).parse(search);return withScopedLifecycleTenant(ctx,async tx=>{await lockAccessConfigurationReadTx(tx,ctx.tenantId);const [row]=await tx.execute<{people:{id:string;name:string}[]}>(sql`select app.contract_shared_access_people(${search}) as people`);return row.people;});}
export type ContractSharedLetterCapabilities={canBindEmployee:boolean;pendingRole:'employee'|'company'|null};
export function contractSharedLetterActions(ctx:SessionContext,letterId:string){z.uuid().parse(letterId);return withScopedLifecycleTenant(ctx,async tx=>{await lockAccessConfigurationReadTx(tx,ctx.tenantId);const [row]=await tx.execute<{actions:ContractSharedLetterCapabilities}>(sql`select app.contract_shared_letter_actions(${letterId}::uuid) as actions`);return row.actions;});}
export type ContractWaitingMetadata={caseId:string;waitingOn:string;waitingFor:string};
export function contractSharedWaiting(ctx:SessionContext,caseIds:string[]){const ids=z.array(z.uuid()).max(100).parse(caseIds);if(!ids.length)return Promise.resolve([] as ContractWaitingMetadata[]);return withScopedLifecycleTenant(ctx,async tx=>{await lockAccessConfigurationReadTx(tx,ctx.tenantId);const [row]=await tx.execute<{waiting:ContractWaitingMetadata[]}>(sql`select app.contract_shared_tracker_waiting(${`{${ids.join(',')}}`}::uuid[]) as waiting`);return row.waiting;});}
