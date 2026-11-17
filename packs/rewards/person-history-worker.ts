import type {BulkJobHandler} from '../../core/bulk-job-worker';
import {isTransientBulkJobError} from '../../core/bulk-job-worker';
import {lockAccessConfigurationReadTx} from '../../core/access-configuration-lock';
import {publicErrorMessage} from '../../lib/public-error';
import {applyRewardPersonHistoryImportRowTx,previewRewardPersonHistoryImport,REWARD_HISTORY_IMPORT_KIND,rewardHistoryImportAuthorityTx} from './person-history-upload';

/** A durable checkpoint per person/year. A cancellation keeps completed, audited rows and reports them.
 * Each chunk rechecks the creator's authority; the worker never adopts its queue owner's HR authority. */
export const rewardPersonHistoryJobHandler:BulkJobHandler={
 kind:REWARD_HISTORY_IMPORT_KIND,mode:'per-step',chunkBudgetMs:100,maxStepsPerChunk:16,
 isTransient:isTransientBulkJobError,phaseOf:()=>'history',stepRef:step=>String(step.payload.value.employeeCode).slice(0,200),
 async prepare(ctx,job){
  const input=job.input as {companyId:string;token:string};
  try{
   const preview=await previewRewardPersonHistoryImport(ctx,{companyId:input.companyId,csv:Buffer.from(job.source_content??Buffer.alloc(0)).toString('utf8'),name:job.source_name});
   if(preview.token!==input.token||preview.problems.length||!preview.rows.length)return{refused:'Reward history changed. Preview the file again.'};
   return{steps:preview.rows.map(row=>({kind:'history',rowNum:row.line,payload:row})),counters:{total:preview.rows.length}};
  }catch(error){if(isTransientBulkJobError(error))throw error;return{refused:publicErrorMessage(error)};}
 },
 async beginChunkTx(tx,ctx,job){await lockAccessConfigurationReadTx(tx,ctx.tenantId);await rewardHistoryImportAuthorityTx(tx,(job.input as {companyId:string}).companyId);},
 async applyStepTx(tx,ctx,job,step){
  await applyRewardPersonHistoryImportRowTx(tx,ctx,(job.input as {companyId:string}).companyId,job.id,step.payload);
  return{counters:{imported:1}};
 },
 async finalize(_ctx,job){return{result:{imported:job.counters.imported??0,total:job.steps_total,failed:job.errors.length}};},
};
