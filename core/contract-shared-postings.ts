/** Contract proposes; canonical Personnel postings and Movement apply. Payroll remains a separate human action. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import type {SqlExecutor} from '../db/sql-executor';
import {withScopedLifecycleTenant} from './module-gate';
import {pgSqlState} from '../lib/db-error';
import {ContractManagementError} from '../lib/contract-management-model';
import {normalisePostingValues,type PersonnelPostingValues} from '../lib/personnel-posting';
import {applyApprovedContractPostingMovementTx} from './movement';

export type ContractSharedPosting={
 id:string;number:number;label:string;companyId:string;companyName:string;employmentId:string;employeeName:string;employeeCode:string;
 caseId:string;caseNumber:string;eventType:'contractRenewal'|'contractConversion';proposed:PersonnelPostingValues;edited:PersonnelPostingValues|null;current:PersonnelPostingValues;
 status:'pending'|'approved';revision:number;approverGroupName:string|null;createdAt:string;editedAt:string|null;approvedAt:string|null;movementAppliedAt:string|null;
 canApprove:boolean;canEdit:boolean;caseRevision:number;canConfirmPay:boolean;payChanges:boolean;sourceCurrent?:boolean;
};
export type ContractSharedPostingPage={rows:ContractSharedPosting[];total:number;offset:number;limit:number};
export type ContractSharedPostingSummary={postingId:string;label:string;eventType:'contractRenewal'|'contractConversion';status:'pending'|'approved';approverGroupName:string|null;approvedByName:string|null;approvedAt:string|null;movementAppliedAt:string|null;effectiveDate:string;payConfirmedByName:string|null;payConfirmedAt:string|null;caseRevision:number;canConfirmPay:boolean};
function failed(error:unknown):never{
 const state=pgSqlState(error);
 if(state==='42501')throw new ContractManagementError('forbidden','Only the Contract posting approver group can perform this action.');
 if(state==='40001')throw new ContractManagementError('conflict','This posting or Personnel record changed. Reload before continuing.');
 if(state==='22023'||state==='23514')throw new ContractManagementError('invalid','Check the dates and contract number. The posting must match the released agreement.');
 throw error;
}
async function guarded<T>(work:()=>Promise<T>):Promise<T>{try{return await work();}catch(error){return failed(error);}}
export async function listContractSharedPostings(ctx:SessionContext,raw:{status?:'pending'|'approved'|'all';companyId?:string;offset?:number;limit?:number}={}):Promise<ContractSharedPostingPage>{
 const input=z.object({status:z.enum(['pending','approved','all']).default('pending'),companyId:z.uuid().optional(),offset:z.number().int().min(0).max(100000).default(0),limit:z.number().int().min(1).max(100).default(50)}).parse(raw);
 return guarded(()=>withScopedLifecycleTenant(ctx,async tx=>{
  const[row]=await tx.execute<{page:{rows:ContractSharedPosting[];total:number}}>(sql`select app.contract_shared_postings_page(${input.status},${input.companyId??null}::uuid,${input.offset},${input.limit}) as page`);
  return {...row.page,offset:input.offset,limit:input.limit};
 }));
}
export function readContractSharedPosting(ctx:SessionContext,id:string):Promise<ContractSharedPosting|null>{
 z.uuid().parse(id);
 return guarded(()=>withScopedLifecycleTenant(ctx,tx=>readContractSharedPostingTx(tx,id)));
}
export async function readContractSharedPostingTx(tx:SqlExecutor,id:string):Promise<ContractSharedPosting|null>{const[row]=await tx.execute<{posting:ContractSharedPosting|null}>(sql`select app.contract_shared_posting_read(${id}::uuid) as posting`);return row?.posting??null;}
export function readContractSharedPostingSummary(ctx:SessionContext,caseId:string):Promise<ContractSharedPostingSummary|null>{
 z.uuid().parse(caseId);
 return guarded(()=>withScopedLifecycleTenant(ctx,async tx=>{
  const[row]=await tx.execute<{summary:ContractSharedPostingSummary|null}>(sql`select app.contract_shared_posting_case_summary(${caseId}::uuid) as summary`);return row?.summary??null;
 }));
}
/** Protected execution only: the native owner reads the frozen step and accepted decision; no terms are accepted. */
export async function activateContractSharedPosting(tx:SqlExecutor,input:{caseId:string;runId:string;stepId:string}):Promise<{id?:string;number?:number;existing?:boolean;skipped?:boolean;reason?:string}>{
 const[row]=await tx.execute<{result:{id?:string;number?:number;existing?:boolean;skipped?:boolean;reason?:string}}>(sql`select app.contract_shared_create_posting(${input.caseId}::uuid,${input.runId}::uuid,${input.stepId}) as result`);return row.result;
}
export async function approveContractSharedPostingTx(tx:Tx,ctx:SessionContext,input:{id:string;revision:number;values?:Record<string,unknown>}){
 const[row]=await tx.execute<{result:{duplicate:boolean;id:string;number:number;employmentId:string;eventType:'contractRenewal'|'contractConversion';values:PersonnelPostingValues;movementId?:string}}>(sql`select app.contract_shared_posting_approve(${input.id}::uuid,${input.revision},${input.values?JSON.stringify(input.values):null}::jsonb) as result`);
 if(row.result.duplicate){if(!row.result.movementId)throw new ContractManagementError('conflict','The approved posting has no recorded Personnel movement.');return {...row.result,movementId:row.result.movementId,alreadyApproved:true as const};}
 const movement=await applyApprovedContractPostingMovementTx(tx,ctx,input.id);
 const[event]=await tx.execute<{id:string}>(sql`select id from domain_event where tenant_id=${ctx.tenantId}::uuid and subject_employment_id=${row.result.employmentId}::uuid and payload->'movement'->>'groupId'=${movement.groupId} order by sequence limit 1`);
 if(!event)throw new ContractManagementError('conflict','The approved posting has no recorded Personnel movement.');
 return {...row.result,movementId:event.id,alreadyApproved:false as const,movement};
}
export function approveContractSharedPosting(ctx:SessionContext,raw:{id:string;revision:number;values?:Record<string,unknown>}){
 const input=z.object({id:z.uuid(),revision:z.number().int().positive(),values:z.record(z.string(),z.unknown()).optional()}).strict().parse(raw);
 return guarded(async()=>{const {approvePersonnelPosting}=await import('./personnel-posting');return approvePersonnelPosting(ctx,input);});
}
export function editContractSharedPosting(ctx:SessionContext,raw:{id:string;revision:number;eventType:'contractRenewal'|'contractConversion';values:Record<string,unknown>}){
 const input=z.object({id:z.uuid(),revision:z.number().int().positive(),eventType:z.enum(['contractRenewal','contractConversion']),values:z.record(z.string(),z.unknown())}).strict().parse(raw);
 const checked=normalisePostingValues(input.eventType,input.values,'contract_staff');
 if(!checked.ok)throw new ContractManagementError('invalid','Enter valid dates and a whole contract number.');
 return guarded(()=>withScopedLifecycleTenant(ctx,async tx=>{
  const[row]=await tx.execute<{revision:number}>(sql`select app.personnel_posting_edit(${input.id}::uuid,${input.revision},${JSON.stringify(checked.values)}::jsonb) as revision`);return row;
 }));
}
export function confirmContractSharedPay(ctx:SessionContext,raw:{caseId:string;expectedRevision:number;confirmed:boolean}):Promise<{caseId:string;revision:number;stage:string;confirmed:true}>{
 const input=z.object({caseId:z.uuid(),expectedRevision:z.number().int().positive(),confirmed:z.literal(true)}).strict().parse(raw);
 return guarded(()=>withScopedLifecycleTenant(ctx,async tx=>{
  const[row]=await tx.execute<{result:{caseId:string;revision:number;stage:string;confirmed:true}}>(sql`select app.contract_shared_confirm_pay(${input.caseId}::uuid,${input.expectedRevision},${input.confirmed}) as result`);return row.result;
 }));
}
/** Metadata only. The task owner uses the same current posting-group scope as the queue. */
export async function pendingContractPostingTasks(ctx:SessionContext,scopeIds:string[]|undefined):Promise<import('../lib/assigned-work').PackTaskItem[]>{
 if(scopeIds!==undefined)z.array(z.uuid()).max(1000).parse(scopeIds);
 if(scopeIds?.length===0)return [];
 return guarded(()=>withScopedLifecycleTenant(ctx,async tx=>{
  const ids=scopeIds?'{'+scopeIds.join(',')+'}':null;
  const rows=await tx.execute<{id:string;kind:'contractPosting'|'contractPay';subject_name:string|null;created_at:Date|string;link_path:string}>(sql`select * from app.contract_shared_posting_tasks(${ids}::uuid[])`);
  return rows.map(row=>({id:row.id,kind:row.kind,subjectName:row.subject_name,createdAt:new Date(row.created_at).toISOString(),linkPath:row.link_path}));
 }));
}
