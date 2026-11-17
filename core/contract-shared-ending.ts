/** Contract endings retain their signed evidence and hand off to the canonical Offboarding owner.
 * Personnel termination remains a separate human action until clearance owns that posting. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import type {SqlExecutor} from '../db/sql-executor';
import {withScopedLifecycleTenant} from './module-gate';
import {publicContractFlow} from './contract-shared-read';
import {pgSqlState} from '../lib/db-error';
import {ContractManagementError} from '../lib/contract-management-model';
import type {ContractFlow} from '../lib/contract-case-flow';
import type {AutomationStepContext} from '../lib/automation/runtime';

const declineSchema=z.object({caseId:z.uuid(),revision:z.number().int().positive(),reason:z.string().trim().min(1).max(200),notes:z.string().trim().max(5000).default('')}).strict();
export type ContractSharedEndingActions={canRecordDecline:boolean;offboardingId:string|null;lastDay:string;terminationMode:'manual';clearance:'pending'};
export async function readContractSharedEndingActions(ctx:SessionContext,caseId:string):Promise<ContractSharedEndingActions>{
 z.uuid().parse(caseId);
 return withScopedLifecycleTenant(ctx,async tx=>{
  const [row]=await tx.execute<{actions:ContractSharedEndingActions}>(sql`select app.contract_shared_ending_actions(${caseId}::uuid) as actions`);return row.actions;
 });
}
export async function recordContractSharedDecline(ctx:SessionContext,raw:z.input<typeof declineSchema>):Promise<{flow:ContractFlow;eventId:string;jobId:string}>{
 const input=declineSchema.parse(raw);
 try{return await withScopedLifecycleTenant(ctx,async tx=>{
  const [row]=await tx.execute<{result:{flow:ContractFlow;eventId:string;jobId:string}}>(sql`select app.contract_shared_record_decline(${input.caseId}::uuid,${input.revision},${input.reason},${input.notes}) as result`);
  return {...row.result,flow:publicContractFlow(row.result.flow)};
 });}catch(error){
  const code=pgSqlState(error);
  if(code==='42501')throw new ContractManagementError('forbidden','You cannot record a decline for this Contract case.');
  if(code==='40001')throw new ContractManagementError('conflict','The employee signature or Contract case changed. Reload before recording a decline.');
  if(code==='22023')throw new ContractManagementError('invalid','Choose an available Personnel termination reason and check the decline notes.');
  throw error;
 }
}

type HandoffIntent={employmentId:string;type:'Contract end'|'Retirement';noticeDate:string;lastDay:string;reason:string;letterId:string;signingDocumentId:string;letterHash:string;offboardingCaseId:string|null};
/** Called only in the sealed kernel owner transaction. SQL independently verifies its exact pinned step. */
export async function activateContractSharedOffboarding(tx:SqlExecutor,ctx:SessionContext,step:AutomationStepContext){
 if(ctx.userId)throw new ContractManagementError('forbidden','Contract handoff requires the protected workflow owner.');
 const caseId=z.uuid().parse(step.run.subjectId);
 const {v9CreateOffboardingTx,v9LockSharedContractOffboardingTx}=await import('../packs/lifecycle/service');
 await v9LockSharedContractOffboardingTx(tx,ctx,{caseId,runId:step.run.id,stepId:step.step.id});
 const [row]=await tx.execute<{intent:HandoffIntent}>(sql`select app.contract_shared_offboarding_intent(${caseId}::uuid,${step.run.id}::uuid,${step.step.id}) as intent`);
 if(row.intent.offboardingCaseId)return {status:'done' as const,message:'Already handed to Offboarding; Personnel termination remains manual.'};
 const offboardingId=await v9CreateOffboardingTx(tx,ctx,{employmentId:row.intent.employmentId,type:row.intent.type,noticeDate:row.intent.noticeDate,lastDay:row.intent.lastDay},{kind:'shared-contract',caseId,runId:step.run.id,stepId:step.step.id});
 await tx.execute(sql`select app.contract_shared_complete_offboarding(${caseId}::uuid,${step.run.id}::uuid,${step.step.id},${offboardingId}::uuid)`);
 return {status:'done' as const,message:'Handed to Offboarding. People Ops records termination in Personnel Management; clearance is pending.'};
}
