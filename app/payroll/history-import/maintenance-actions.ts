'use server';
import {revalidatePath} from 'next/cache';
import {requireAdmin} from '@/lib/authz';
import {previewPayrollHistoryMaintenance,requestPayrollHistoryConfirm,PayrollHistoryRevisionError} from '@/packs/payroll/service';
import type {PayrollHistoryMaintenanceRequest} from '@/lib/payroll-history-maintenance';
export async function previewHistoryMaintenanceAction(input:PayrollHistoryMaintenanceRequest){
 const ctx=await requireAdmin();
 try{return{ok:true as const,result:await previewPayrollHistoryMaintenance(ctx,input)};}catch(error){if(!(error instanceof PayrollHistoryRevisionError))console.error('[history maintenance preview]',error);return{ok:false as const,error:error instanceof PayrollHistoryRevisionError?error.message:null};}
}
export async function confirmHistoryMaintenanceAction(input:{attemptId:string;previewHash:string}){
 const ctx=await requireAdmin();
 try{const result=await requestPayrollHistoryConfirm(ctx,{...input,confirmReplacement:true});if('alreadyCommitted'in result){revalidatePath('/payroll/history-import');return{ok:true as const,completed:true as const};}return{ok:true as const,jobId:result.jobId};}
 catch(error){if(!(error instanceof PayrollHistoryRevisionError))console.error('[history maintenance confirmation]',error);return{ok:false as const,error:error instanceof PayrollHistoryRevisionError?error.message:null};}
}
