/** Typed Contract commands. The database independently checks the actor, preview proof, period and revision. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {contractSharedContextTx} from './contract-shared-read';
import {validateContractFlowDecision,type ContractFlow,type ContractFlowDecisionDraft} from '../lib/contract-case-flow';
import {ContractManagementError} from '../lib/contract-management-model';
import {pgSqlState} from '../lib/db-error';
import {assertTerminationReasonOfferedTx} from './termination-reason-catalog';
import type {ContractDecisionPlan,ContractProposedDecision} from '../lib/contract-decision-preview';

const decisionDraft=z.object({kind:z.enum(['renew','convert','end']),startOn:z.iso.date().optional(),endOn:z.iso.date().optional(),months:z.number().int().min(3).max(120).optional(),payChanges:z.boolean(),basicSalary:z.string().max(20).optional(),reason:z.string().trim().max(5000),endReason:z.string().trim().max(200).optional()}).strict();
export const contractProposedDecisionSchema=z.object({kind:z.enum(['renew','convert','end']),startOn:z.iso.date().nullable(),endOn:z.iso.date().nullable(),months:z.number().int().min(3).max(120).nullable(),payChanges:z.boolean(),salaryCents:z.string().regex(/^(0|[1-9]\d{0,11})$/).nullable(),reason:z.string().trim().max(5000),endReason:z.string().trim().max(200).nullable()}).strict();
export type PublicContractDecisionPlan=Omit<ContractDecisionPlan,'approvalAssignments'|'letterAssignments'>;
export type ContractDecisionPreview={id:string;caseId:string;caseRevision:number;decision:ContractProposedDecision;plan:PublicContractDecisionPlan|null;jobId:string};

async function command<T>(work:()=>Promise<T>):Promise<T>{
 try{return await work();}catch(error){
  const state=pgSqlState(error);
  if(state==='42501')throw new ContractManagementError('forbidden','This Contract action is unavailable.');
  if(state==='40001')throw new ContractManagementError('conflict','This case, preview or setup changed. Reload and review a fresh preview.');
  if(['22023','22007','22008','22P02','23514'].includes(state??''))throw new ContractManagementError('invalid','Check the decision, dates, pay and workflow setup before continuing.');
  throw error;
 }
}
export function adoptContractSharedCase(ctx:SessionContext,caseId:string):Promise<ContractFlow>{
 z.uuid().parse(caseId);
 return command(()=>withScopedLifecycleTenant(ctx,async tx=>{
  const [row]=await tx.execute<{flow:ContractFlow}>(sql`select app.contract_shared_adopt(${caseId}::uuid) as flow`);
  return row.flow;
 }));
}
export function previewContractSharedDecision(ctx:SessionContext,raw:{caseId:string;revision:number;draft:ContractFlowDecisionDraft}):Promise<{previewId:string;jobId:string}>{
 const input=z.object({caseId:z.uuid(),revision:z.number().int().positive(),draft:decisionDraft}).strict().parse(raw);
 return command(()=>withScopedLifecycleTenant(ctx,async tx=>{
  const view=await contractSharedContextTx(tx,input.caseId);
  if(!view.flow||!view.sourceCurrent||view.flow.revision!==input.revision)throw new ContractManagementError('conflict','Reload the current shared Contract case before previewing.');
  if(!view.permissions.includes('decide'))throw new ContractManagementError('forbidden','This Contract action is unavailable.');
  const decision=validateContractFlowDecision(view.flow,input.draft);
  if(decision.kind==='end')await assertTerminationReasonOfferedTx(tx,ctx.tenantId,decision.endReason!);
  const [row]=await tx.execute<{result:{previewId:string;jobId:string}}>(sql`select app.contract_shared_preview_start(${input.caseId}::uuid,${input.revision},${JSON.stringify(decision)}::jsonb) as result`);
  return row.result;
 }));
}
export function readContractSharedDecisionPreview(ctx:SessionContext,id:string):Promise<ContractDecisionPreview>{
 z.uuid().parse(id);
 return command(()=>withScopedLifecycleTenant(ctx,async tx=>{
  const [row]=await tx.execute<{preview:ContractDecisionPreview}>(sql`select app.contract_shared_preview_read(${id}::uuid) as preview`);
  return row.preview;
 }));
}
export function submitContractSharedDecision(ctx:SessionContext,raw:{caseId:string;revision:number;previewId:string}):Promise<{flow:ContractFlow;eventId:string;jobId:string}>{
 const input=z.object({caseId:z.uuid(),revision:z.number().int().positive(),previewId:z.uuid()}).strict().parse(raw);
 return command(()=>withScopedLifecycleTenant(ctx,async tx=>{
  const [saved]=await tx.execute<{preview:ContractDecisionPreview}>(sql`select app.contract_shared_preview_read(${input.previewId}::uuid) as preview`);
  if(saved.preview.caseId!==input.caseId||saved.preview.caseRevision!==input.revision)throw new ContractManagementError('conflict','Review a preview for this case and revision.');
  const decision=contractProposedDecisionSchema.parse(saved.preview.decision);
  // The native command checks offered reasons for a new decision, after recognizing an already accepted retry.
  const [row]=await tx.execute<{result:{flow:ContractFlow;eventId:string;jobId:string}}>(sql`select app.contract_shared_decision_submit(${input.caseId}::uuid,${input.revision},${JSON.stringify(decision)}::jsonb,${input.previewId}::uuid) as result`);
  return row.result;
 }));
}
export function contractSharedHistory(ctx:SessionContext,caseId:string,before=2147483647){
 z.uuid().parse(caseId);z.number().int().positive().parse(before);
 return command(()=>withScopedLifecycleTenant(ctx,async tx=>{
  const rows=await tx.execute<{entry:{revision:number;at:string;actorId:string|null;actorPersonId:string|null;actorName:string|null;flow:ContractFlow}}>(sql`select value as entry from app.contract_shared_history(${caseId}::uuid,${before}) value`);
  return rows.map(row=>row.entry);
 }));
}
