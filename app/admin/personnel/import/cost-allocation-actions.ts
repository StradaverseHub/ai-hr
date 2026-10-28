'use server';
import {WorkforceAccessError} from '@/core/workforce-access';
import {CostAllocationError} from '@/lib/employment-cost-allocation';
import {getSession} from '@/lib/session';
import {requireAdmin} from '@/lib/authz';
import {revalidatePath} from 'next/cache';
import {costAllocationReferences,costAllocationWorkbookReferences,confirmCostAllocationUpload} from '@/core/cost-allocation-import';
import {ImportHistoryError} from '@/core/import-history';
export async function allocationImportReferencesAction(companyId:string){return costAllocationReferences(await getSession(),companyId);}
/** Codes for every company the actor may maintain; used by both the allocation and the Everything template. */
export async function allocationWorkbookReferencesAction(){try{return{ok:true as const,references:await costAllocationWorkbookReferences(await getSession())};}catch(e){return{ok:false as const,error:e instanceof WorkforceAccessError||e instanceof CostAllocationError&&e.code==='scope'?'scope' as const:'invalid' as const};}}
export async function confirmAllocationImportAction(attemptId:string,previewHash:string){
 const ctx=await requireAdmin();
 try{
  const result=await confirmCostAllocationUpload(ctx,{attemptId,previewHash});
  revalidatePath('/admin/personnel','layout');revalidatePath('/admin/personnel/import/history');
  return{ok:true as const,result};
 }catch(error){
  if(!(error instanceof ImportHistoryError||error instanceof CostAllocationError))console.error('[cost allocation import confirm]',error);
  return{ok:false as const,error:error instanceof ImportHistoryError||error instanceof CostAllocationError?error.message:null};
 }
}
