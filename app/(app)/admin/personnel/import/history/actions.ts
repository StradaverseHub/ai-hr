'use server';
import {revalidatePath} from 'next/cache';
import {requireAdmin} from '@/lib/authz';
import {ImportHistoryError} from '@/core/import-history';
import {previewImportRevertForAttempt,revertImportForAttempt} from '@/core/import-history-handlers';
/** Read-only eligibility review for any import kind with a registered revert handler. */
export async function previewImportRevertAction(attemptId:string){
 const ctx=await requireAdmin();
 try{return{ok:true as const,result:await previewImportRevertForAttempt(ctx,attemptId)};}
 catch(error){if(!(error instanceof ImportHistoryError))console.error('[import revert preview]',error);return{ok:false as const,error:error instanceof ImportHistoryError?error.message:null,blockers:error instanceof ImportHistoryError?error.blockers:[]};}
}
export async function revertImportAction(attemptId:string,previewHash:string,reason:string){
 const ctx=await requireAdmin();
 try{
  const result=await revertImportForAttempt(ctx,attemptId,{previewHash,reason});
  revalidatePath('/admin/personnel','layout');revalidatePath('/admin/personnel/import/history');revalidatePath('/admin/personnel/import/history/'+attemptId);
  return{ok:true as const,result};
 }catch(error){
  if(!(error instanceof ImportHistoryError))console.error('[import revert]',error);
  return{ok:false as const,error:error instanceof ImportHistoryError?error.message:null,blockers:error instanceof ImportHistoryError?error.blockers:[]};
 }
}
