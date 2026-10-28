
'use server';
import {revalidatePath} from 'next/cache';
import {requireAdmin} from '@/lib/authz';
import {confirmPayrollHistoryUpload,previewPayrollHistoryRevert,revertPayrollHistoryUpload,PayrollHistoryRevisionError} from '@/packs/payroll/service';

export async function confirmHistoryUploadAction(input:{attemptId:string;previewHash:string;confirmReplacement:boolean;skipReplacements?:boolean;selectedRecordKeys?:string[];acknowledgeWarnings?:boolean}){
 const ctx=await requireAdmin();
 try{
  const result=await confirmPayrollHistoryUpload(ctx,input);
  revalidatePath('/payroll');revalidatePath('/payroll/history-import');
  return {ok:true as const,result};
 }catch(error){
  if(!(error instanceof PayrollHistoryRevisionError))console.error('[history import confirmation]',error);
  return {ok:false as const,error:error instanceof PayrollHistoryRevisionError?error.message:null};
 }
}
export async function previewHistoryRevertAction(id:string){
 const ctx=await requireAdmin();try{return {ok:true as const,result:await previewPayrollHistoryRevert(ctx,id)};}catch(error){if(!(error instanceof PayrollHistoryRevisionError))console.error('[history revert eligibility]',error);return {ok:false as const,error:error instanceof PayrollHistoryRevisionError?error.message:null};}
}
export async function revertHistoryUploadAction(id:string,previewHash:string){
 const ctx=await requireAdmin();
 try{
  const result=await revertPayrollHistoryUpload(ctx,id,previewHash);
  revalidatePath('/payroll');revalidatePath('/payroll/history-import');revalidatePath('/payroll/history-import/logs');revalidatePath('/payroll/history-import/logs/'+id);
  return {ok:true as const,result};
 }catch(error){
  if(!(error instanceof PayrollHistoryRevisionError))console.error('[history import revert]',error);
  return {ok:false as const,error:error instanceof PayrollHistoryRevisionError?error.message:null};
 }
}
