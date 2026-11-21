'use server';
import {revalidatePath} from 'next/cache';
import {requireAdmin} from '@/lib/authz';
import {requestPayrollHistoryConfirm,previewPayrollHistoryRevert,requestPayrollHistoryRevert,PayrollHistoryRevisionError} from '@/packs/payroll/service';

/** Confirm starts the background job (core/payroll-history-job.ts) after the same checks; the screen follows the job.
 * An attempt that was already committed reports its result, as before. */
export async function confirmHistoryUploadAction(input:{attemptId:string;previewHash:string;confirmReplacement:boolean;skipReplacements?:boolean;selectedRecordKeys?:string[];acknowledgeWarnings?:boolean}){
 const ctx=await requireAdmin();
 try{
  const started=await requestPayrollHistoryConfirm(ctx,input);
  if('alreadyCommitted' in started){revalidatePath('/payroll');revalidatePath('/payroll/history-import');return {ok:true as const,result:started.result as {skippedReplacements?:number}};}
  return {ok:true as const,jobId:started.jobId};
 }catch(error){
  if(!(error instanceof PayrollHistoryRevisionError))console.error('[history import confirmation]',error);
  return {ok:false as const,error:error instanceof PayrollHistoryRevisionError?error.message:null};
 }
}
export async function previewHistoryRevertAction(id:string){
 const ctx=await requireAdmin();try{return {ok:true as const,result:await previewPayrollHistoryRevert(ctx,id)};}catch(error){if(!(error instanceof PayrollHistoryRevisionError))console.error('[history revert eligibility]',error);return {ok:false as const,error:error instanceof PayrollHistoryRevisionError?error.message:null};}
}
/** Revert starts the background job after the attempt's checks; the log screen follows it and refreshes when done. */
export async function revertHistoryUploadAction(id:string,previewHash:string){
 const ctx=await requireAdmin();
 try{
  const started=await requestPayrollHistoryRevert(ctx,id,previewHash);
  return {ok:true as const,jobId:started.jobId};
 }catch(error){
  if(!(error instanceof PayrollHistoryRevisionError))console.error('[history import revert]',error);
  return {ok:false as const,error:error instanceof PayrollHistoryRevisionError?error.message:null};
 }
}
