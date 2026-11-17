/** A new human-approved posting is applied atomically by one fixed protected Personnel owner. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import type {BulkJobHandler} from './bulk-job-worker';
import type {BulkJobRow} from './bulk-job';
import {approveContractSharedPostingTx,readContractSharedPostingApprovalJob,readContractSharedPosting} from './contract-shared-postings';
import {withContractPostingHistorySourceTx} from './contract-posting-history-source';
import {OrganisationProjectionLineageError} from './organisation-projection-lineage';

const inputSchema=z.object({postingId:z.uuid()}).strict();
export type ContractPostingAppliedResult={postingId:string;groupId:string;scheduled:boolean;applied:boolean};
type Begin={completed:true;postingId:string;employmentId:string;groupId:string;scheduled:boolean;applied:boolean}
 |{completed:false;postingId:string;employmentId:string;revision:number;values:Record<string,unknown>};

export const CONTRACT_POSTING_APPLICATION_FAILURE='The Contract posting could not be applied. Personnel and Payroll remain unchanged; review the agreement, current access and Employment History before retrying.';

export const contractPostingApplyJobHandler:BulkJobHandler<never>={
 kind:'contract_posting_apply',mode:'atomic',finalizeOwner:true,
 async prepare(ctx,job){
  inputSchema.parse(job.input);
  const status=await readContractSharedPostingApprovalJob(ctx,job.id);
  if(status.postingStatus!=='pending')return {refused:CONTRACT_POSTING_APPLICATION_FAILURE};
  return {steps:[],plan:{postingId:status.postingId},counters:{},phase:'apply'};
 },
 async applyStepTx(){throw Error('Contract posting applications have one fixed atomic owner unit.');},
 async finalize(){throw Error('Contract posting applications require the fixed kernel entrypoint.');},
 quietNotice:()=>true,
 async describeFailure(_job,error){return {error:error instanceof OrganisationProjectionLineageError?error.message:CONTRACT_POSTING_APPLICATION_FAILURE};},
 async afterTerminal(ctx,job){
  if(!ctx||job.state!=='completed')return;
  const input=inputSchema.parse(job.input),posting=await readContractSharedPosting(ctx,input.postingId);
  if(!posting||posting.status!=='approved')return;
  // The synchronous Personnel owner used this same best-effort, ordinary-authority follow-up.
  // It runs only after the atomic posting committed and never lends this job's private source.
  const {reprojectEntitlementForEmployment}=await import('../packs/leave/service');
  await reprojectEntitlementForEmployment(ctx,{employmentId:posting.employmentId,trigger:'movement_recorded',changeEffectiveOn:posting.current.effectiveDate});
 },
};

/** Kernel-only constant implementation. Native admission, source and lease are independently checked. */
export async function applyContractPostingJobTx(tx:Tx,ctx:SessionContext,job:Pick<BulkJobRow,'id'|'kind'|'input'>):Promise<ContractPostingAppliedResult>{
 if(job.kind!=='contract_posting_apply')throw Error('The fixed Contract posting kind is required.');
 const input=inputSchema.parse(job.input);
 const[begun]=await tx.execute<{result:Begin}>(sql`select app.contract_posting_job_begin(${job.id}::uuid) as result`);
 const source=begun?.result;
 if(!source||source.postingId!==input.postingId)throw Error('The actual Contract application source changed.');
 if(source.completed)return {postingId:source.postingId,groupId:source.groupId,scheduled:source.scheduled,applied:source.applied};
 return withContractPostingHistorySourceTx(tx,{jobId:job.id,employmentId:source.employmentId},async()=>{
  const approved=await approveContractSharedPostingTx(tx,ctx,{id:source.postingId,revision:source.revision,values:source.values});
  if(approved.alreadyApproved||!('movement' in approved))throw Error('The pending application did not produce its protected Personnel movement.');
  const result=approved.movement;
  const[finished]=await tx.execute<{result:ContractPostingAppliedResult}>(sql`select app.contract_posting_job_finish(${job.id}::uuid,${result.groupId}::uuid,${result.scheduled}) as result`);
  if(!finished?.result||finished.result.postingId!==input.postingId)throw Error('The native Contract application completion receipt is unavailable.');
  const receipt=finished.result;
  return {postingId:receipt.postingId,groupId:receipt.groupId,scheduled:receipt.scheduled,applied:receipt.applied};
 });
}
