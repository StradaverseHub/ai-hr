'use server';
import {revalidatePath} from 'next/cache';
import {redirect,unstable_rethrow} from 'next/navigation';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {publicErrorMessage} from '@/lib/public-error';
import {approveContractSharedPosting,editContractSharedPosting,confirmContractSharedPay,readContractSharedPosting} from '@/packs/contracts/service';
const QUEUE='/lifecycle/contracts/postings';
const text=(form:FormData,key:string)=>String(form.get(key)??'').trim();
async function refresh(employmentId:string,caseId:string){revalidatePath(QUEUE);revalidatePath('/lifecycle/contracts');revalidatePath('/lifecycle/contracts/'+caseId);revalidatePath('/admin/personnel/'+employmentId);revalidatePath('/tasks');revalidatePath('/');}
export async function approveContractPostingAction(form:FormData){
 const session=await requireScopedLifecycleModule(),id=text(form,'postingId');
 let recorded=false;
 try{
  const result=await approveContractSharedPosting(session,{id,revision:Number(text(form,'revision'))});
  recorded=result.postingStatus==='approved';
  const posting=await readContractSharedPosting(session,id);
  if(posting)await refresh(result.employmentId,posting.caseId);
 }catch(error){unstable_rethrow(error);redirect(QUEUE+'?error='+encodeURIComponent(publicErrorMessage(error)));}
 redirect(QUEUE+'?status=all&saved='+(recorded?'approved':'queued')+'&postingId='+encodeURIComponent(id)+'#posting-'+encodeURIComponent(id));
}
export async function confirmContractPayrollAction(form:FormData){
 const session=await requireScopedLifecycleModule(),id=text(form,'postingId');
 try{
  const posting=await readContractSharedPosting(session,id);
  if(!posting)throw new Error('Personnel posting unavailable.');
  await confirmContractSharedPay(session,{caseId:posting.caseId,expectedRevision:Number(text(form,'caseRevision')),confirmed:text(form,'confirmed')==='on'});
  await refresh(posting.employmentId,posting.caseId);
 }catch(error){unstable_rethrow(error);redirect(QUEUE+'?status=approved&error='+encodeURIComponent(publicErrorMessage(error)));}
 redirect(QUEUE+'?status=approved&saved=pay&postingId='+encodeURIComponent(id)+'#posting-'+encodeURIComponent(id));
}
/** Same posting command on the Personnel Movement editor; it never sends a general movement payload. */
export async function saveContractPostingAction(_previous:string|null,form:FormData):Promise<string|null>{
 const session=await requireScopedLifecycleModule(),id=text(form,'postingId');
 let outcome:'edited'|'queued'|'approved'='edited';
 try{
  const posting=await readContractSharedPosting(session,id);
  if(!posting||posting.employmentId!==text(form,'employmentId'))throw new Error('Personnel posting unavailable.');
  const values:Record<string,unknown>={effectiveDate:text(form,'effectiveDate'),previousEndDate:text(form,'previousEndDate'),remarks:text(form,'remarks')||null};
  if(posting.eventType==='contractRenewal'){values.endDate=text(form,'endDate');values.contractNumber=text(form,'contractNumber');}
  const input={id,revision:Number(text(form,'revision')),values};
  if(text(form,'intent')==='approve'){const result=await approveContractSharedPosting(session,input);outcome=result.postingStatus==='approved'?'approved':'queued';}
  else if(text(form,'intent')==='edit')await editContractSharedPosting(session,{...input,eventType:posting.eventType});
  else throw new Error('Choose how to save this posting.');
  await refresh(posting.employmentId,posting.caseId);
 }catch(error){unstable_rethrow(error);return publicErrorMessage(error);}
 redirect(QUEUE+'?status='+(outcome==='edited'?'pending':'all')+'&saved='+outcome+'&postingId='+encodeURIComponent(id)+'#posting-'+encodeURIComponent(id));
}
